import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema } from "../../shared/accounting";
import { currencyCodeSchema, isoTimestampSchema } from "../../shared/company";
import type { QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { normalizeQboTransaction, type QboCurrencyContext } from "../integrations/quickbooks/normalize";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import type { QuickBooksCapabilityEvidence, QuickBooksCapabilityStore } from "./capabilities";
import type { QboAccountingMirrorStore } from "./mirror-store";
import { PostgresQboCheckpointStore, runQboCatchUp, type QboCatchUpResult, type QboSyncCheckpoint } from "./sync";

const PAGE_SIZE = 500;
const TRANSACTION_ENTITY_TYPES = ["Purchase", "Bill", "BillPayment", "Deposit", "JournalEntry"] as const;
const REQUIRED_STREAMS = ["accounts", "transactions.purchase", "transactions.bill", "transactions.billpayment", "transactions.deposit", "transactions.journalentry"] as const;

export interface QboBootstrapProbeResult {
  readonly scope: QuickBooksConnectionScope;
  readonly providerRealmId: string;
  readonly providerCompanyId: string;
  readonly providerCompanyName: string | null;
  readonly homeCurrency: string | null;
  readonly capability: QuickBooksCapabilityEvidence;
}

export interface QboProviderStreamResult {
  readonly stream: string;
  readonly result: QboCatchUpResult;
  /** Objects or lines rejected by this run only. */
  readonly unsupportedCount: number;
  /** Durable unresolved exceptions for the stream after this run, including earlier runs. */
  readonly openExceptionCount: number;
  /** Mirrored objects that a full replay no longer returned (possible provider deletions). */
  readonly missingFromReplayCount: number;
  readonly mode: "initial" | "incremental" | "full_replay";
  readonly coverageStatus: "complete" | "partial";
}

export interface QboProviderSyncResult {
  readonly status: "complete" | "partial";
  readonly streams: readonly QboProviderStreamResult[];
}

export interface QboProviderSync {
  /** Performs a read-only CompanyInfo call and records live read evidence. */
  bootstrapRead(): Promise<QboBootstrapProbeResult>;
  /** Mirrors the bounded QBO source subset and Account identity revisions. */
  catchUp(options?: { readonly maxPages?: number; readonly fullReplay?: boolean }): Promise<QboProviderSyncResult>;
}

function scopeOf(scope: QuickBooksConnectionScope) {
  return financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
}

function text(value: unknown, field: string, max = 255): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new AccountingError("accounting_unavailable", `QBO provider returned an invalid ${field}`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max = 255): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field, max);
}

function providerTimestamp(value: unknown): string | null {
  const raw = optionalText(value, "provider update timestamp", 100);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function maxProviderTimestamp(items: readonly QuickBooksJsonObject[]): string | null {
  let latest: string | null = null;
  for (const item of items) {
    const candidate = providerTimestamp((item.MetaData && typeof item.MetaData === "object" && !Array.isArray(item.MetaData)) ? (item.MetaData as Record<string, unknown>).LastUpdatedTime : undefined);
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

export function overlapWatermark(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Date(parsed.getTime() - 1_000).toISOString();
}

const QBO_QUERY_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * QBO query pagination is offset based. Offsets over a result set ordered by
 * LastUpdatedTime shift when a record is edited mid-sync, which can silently
 * skip a record whose timestamp then falls behind the saved watermark. The
 * cursor therefore restarts each page at the last seen timestamp (keyset) and
 * uses an offset only within a group of identical timestamps.
 */
export interface QboKeysetCursor {
  readonly floor: string | null;
  readonly startPosition: number;
}

export function encodeQboKeysetCursor(cursor: QboKeysetCursor): string {
  return `${cursor.floor ?? ""}|${cursor.startPosition}`;
}

export function decodeQboKeysetCursor(value: string): QboKeysetCursor {
  const match = /^([^|]*)\|(\d{1,9})$/.exec(value);
  if (!match || (match[1] !== "" && !QBO_QUERY_TIMESTAMP.test(match[1]))) throw new AccountingError("accounting_validation", "QBO query cursor is invalid");
  const startPosition = Number(match[2]);
  if (!Number.isSafeInteger(startPosition) || startPosition < 1) throw new AccountingError("accounting_validation", "QBO query cursor is invalid");
  return { floor: match[1] === "" ? null : match[1], startPosition };
}

export function queryFor(entity: string, cursor: QboKeysetCursor): string {
  if (!Number.isSafeInteger(cursor.startPosition) || cursor.startPosition < 1) throw new AccountingError("accounting_validation", "QBO query cursor is invalid");
  // Floor values originate from QBO MetaData.LastUpdatedTime. Keep the
  // grammar narrow before interpolating the value into QBO's query language.
  if (cursor.floor !== null && !QBO_QUERY_TIMESTAMP.test(cursor.floor)) throw new AccountingError("accounting_validation", "QBO query cursor is invalid");
  const where = cursor.floor !== null ? ` WHERE MetaData.LastUpdatedTime >= '${cursor.floor}'` : "";
  return `SELECT * FROM ${entity}${where} ORDERBY MetaData.LastUpdatedTime ASC STARTPOSITION ${cursor.startPosition} MAXRESULTS ${PAGE_SIZE}`;
}

export function nextQboKeysetCursor(current: QboKeysetCursor, items: readonly QuickBooksJsonObject[]): QboKeysetCursor | null {
  if (items.length < PAGE_SIZE) return null;
  const times = items.map(item => providerTimestamp(metadataOf(item)?.LastUpdatedTime));
  const last = times.at(-1);
  if (!last) throw new AccountingError("accounting_unavailable", "QBO query page ended with an object that has no LastUpdatedTime");
  if (current.floor !== null && last === current.floor) {
    // The whole page shares the floor timestamp: continue within the group.
    return { floor: current.floor, startPosition: current.startPosition + items.length };
  }
  const tied = times.filter(time => time === last).length;
  return { floor: last, startPosition: tied + 1 };
}

function metadataOf(item: QuickBooksJsonObject): Record<string, unknown> | null {
  return item.MetaData && typeof item.MetaData === "object" && !Array.isArray(item.MetaData) ? item.MetaData as Record<string, unknown> : null;
}

function currencyContext(preferences: QuickBooksJsonObject | undefined): QboCurrencyContext | null {
  const prefs = preferences?.CurrencyPrefs;
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return null;
  const record = prefs as Record<string, unknown>;
  const home = record.HomeCurrency && typeof record.HomeCurrency === "object" && !Array.isArray(record.HomeCurrency) ? (record.HomeCurrency as Record<string, unknown>).value : undefined;
  if (typeof home !== "string" || !/^[A-Za-z]{3}$/.test(home)) return null;
  const enabled = record.MultiCurrencyEnabled;
  return { homeCurrency: currencyCodeSchema.parse(home.toUpperCase()), multiCurrencyEnabled: typeof enabled === "boolean" ? enabled : null };
}

function accountObject(input: QuickBooksJsonObject): { objectId: string; version: string; providerUpdatedAt: string; providerBody: QuickBooksJsonObject } | null {
  const id = typeof input.Id === "string" && input.Id.trim().length > 0 ? input.Id.trim() : null;
  const version = typeof input.SyncToken === "string" && input.SyncToken.trim().length > 0 ? input.SyncToken.trim() : null;
  const metadata = input.MetaData && typeof input.MetaData === "object" && !Array.isArray(input.MetaData) ? input.MetaData as Record<string, unknown> : null;
  const providerUpdatedAt = providerTimestamp(metadata?.LastUpdatedTime);
  const accountType = typeof input.AccountType === "string" && input.AccountType.trim().length > 0 ? input.AccountType.trim() : null;
  return id && version && providerUpdatedAt && accountType ? { objectId: id, version, providerUpdatedAt, providerBody: input } : null;
}

function companyInfo(result: QuickBooksJsonObject, expectedRealmId: string): { providerRealmId: string; providerCompanyId: string; providerCompanyName: string | null; homeCurrency: string | null; evidenceVersion: string } {
  // CompanyInfo.Id is an Intuit company/entity identifier and is not the
  // OAuth realmId. The authenticated CompanyInfo response is bound to the
  // realm by the request path/token; local legal-entity binding is a separate
  // server-side attestation at OAuth completion.
  const providerCompanyId = text(result.Id, "CompanyInfo.Id identity", 255);
  const metadata = result.MetaData && typeof result.MetaData === "object" && !Array.isArray(result.MetaData) ? result.MetaData as Record<string, unknown> : {};
  const evidenceVersion = text(metadata.LastUpdatedTime ?? providerCompanyId, "CompanyInfo evidence version", 255);
  const homeCurrencyValue = (result.HomeCurrency && typeof result.HomeCurrency === "object" && !Array.isArray(result.HomeCurrency))
    ? (result.HomeCurrency as Record<string, unknown>).value
    : result.HomeCurrency ?? (result.CurrencyRef && typeof result.CurrencyRef === "object" && !Array.isArray(result.CurrencyRef) ? (result.CurrencyRef as Record<string, unknown>).value : undefined);
  const homeCurrency = typeof homeCurrencyValue === "string" && /^[A-Za-z]{3}$/.test(homeCurrencyValue) ? currencyCodeSchema.parse(homeCurrencyValue.toUpperCase()) : null;
  return { providerRealmId: expectedRealmId, providerCompanyId, providerCompanyName: optionalText(result.CompanyName, "CompanyInfo company name", 255), homeCurrency, evidenceVersion };
}

export function createQboProviderSync(options: {
  readonly executor: RentOpsQueryExecutor;
  readonly client: QuickBooksAccountingClient;
  readonly scope: QuickBooksConnectionScope;
  readonly mirror: QboAccountingMirrorStore;
  readonly capabilityStore: QuickBooksCapabilityStore;
  readonly now?: () => Date;
}): QboProviderSync {
  const scope = scopeOf(options.scope);
  const now = options.now ?? (() => new Date());
  const checkpointStore = new PostgresQboCheckpointStore(options.executor, now);
  // undefined = not read yet; null = read, but no usable home currency.
  let verifiedCurrency: QboCurrencyContext | null | undefined;

  /**
   * CompanyInfo does not carry the home currency. Preferences.CurrencyPrefs is
   * the provider's authority for it and for whether multicurrency is on.
   */
  async function loadCurrencyContext(): Promise<QboCurrencyContext | null> {
    if (verifiedCurrency !== undefined) return verifiedCurrency;
    try {
      const response = await options.client.query<QuickBooksJsonObject>("SELECT * FROM Preferences");
      verifiedCurrency = currencyContext(response.entities[0]);
    } catch {
      // Without verified preferences, objects lacking CurrencyRef are
      // rejected by normalization instead of assuming a currency.
      verifiedCurrency = null;
    }
    return verifiedCurrency;
  }

  return {
    async bootstrapRead() {
      const result = await options.client.read<QuickBooksJsonObject>("CompanyInfo", scope.realmId);
      const identity = companyInfo(result.entity, scope.realmId);
      const currency = await loadCurrencyContext();
      const capability: QuickBooksCapabilityEvidence = {
        scope,
        capability: "accounting.read",
        enabled: true,
        evidence: "live_provider_readback",
        evidenceVersion: identity.evidenceVersion,
        verifiedAt: now().toISOString(),
        providerTraceId: result.intuitTid ?? null,
      };
      await options.capabilityStore.record(capability);
      await options.mirror.ingestSourceObject({
        scope,
        objectType: "CompanyInfo",
        objectId: identity.providerCompanyId,
        version: identity.evidenceVersion,
        providerUpdatedAt: providerTimestamp((result.entity.MetaData && typeof result.entity.MetaData === "object" && !Array.isArray(result.entity.MetaData)) ? (result.entity.MetaData as Record<string, unknown>).LastUpdatedTime : undefined),
        providerBody: result.entity,
        receivedAt: now().toISOString(),
      });
      return { scope, providerRealmId: identity.providerRealmId, providerCompanyId: identity.providerCompanyId, providerCompanyName: identity.providerCompanyName, homeCurrency: currency?.homeCurrency ?? identity.homeCurrency, capability };
    },

    async catchUp(input = {}) {
      await options.capabilityStore.load(scope, "accounting.read").then((evidence) => {
        if (!evidence?.enabled || evidence.evidence !== "live_provider_readback") throw new AccountingError("accounting_capability_disabled", "Run the read-only QuickBooks CompanyInfo probe before mirroring transactions", { capability: "accounting.read" });
      });
      const currency = await loadCurrencyContext();
      const fullReplay = input.fullReplay === true;
      const streams: QboProviderStreamResult[] = [];
      type ApplyOutcome = { readonly objectId: string | null; readonly unsupported: number };
      const syncStream = async (entity: string, stream: string, apply: (mirror: QboAccountingMirrorStore, item: QuickBooksJsonObject, observedAt: string) => Promise<ApplyOutcome>) => {
        const before = await checkpointStore.load(scope, stream);
        const hadWatermark = before?.watermark !== null && before?.watermark !== undefined;
        const mode: QboProviderStreamResult["mode"] = fullReplay ? "full_replay" : hadWatermark ? "incremental" : "initial";
        let unsupportedCount = 0;
        let missingFromReplayCount = 0;
        let openExceptionCount = 0;
        const seen = new Set<string>();
        const result = await runQboCatchUp<QuickBooksJsonObject>({
          executor: options.executor,
          checkpointStore,
          scope,
          stream,
          maxPages: input.maxPages,
          ignoreStoredWatermark: fullReplay,
          fetchPage: async ({ sinceWatermark, cursor }) => {
            const current = cursor === null ? { floor: overlapWatermark(sinceWatermark), startPosition: 1 } : decodeQboKeysetCursor(cursor);
            const response = await options.client.query<QuickBooksJsonObject>(queryFor(entity, current));
            const items = response.entities;
            const next = nextQboKeysetCursor(current, items);
            return { items, nextCursor: next === null ? null : encodeQboKeysetCursor(next), watermark: maxProviderTimestamp(items) };
          },
          applyPage: async (executor, items) => {
            const mirror = options.mirror.forExecutor(executor);
            const observedAt = now().toISOString();
            for (const item of items) {
              const outcome = await apply(mirror, item, observedAt);
              unsupportedCount += outcome.unsupported;
              if (outcome.objectId) seen.add(outcome.objectId);
            }
          },
          finalize: async (executor) => {
            const mirror = options.mirror.forExecutor(executor);
            const observedAt = now().toISOString();
            if (fullReplay) {
              // A full replay sees every live object. Anything mirrored that
              // QBO no longer returns may have been deleted; it stays an
              // explicit exception instead of silently remaining current.
              const objectType = entity;
              for (const objectId of await mirror.listMirroredObjectIds(scope, objectType)) {
                if (seen.has(objectId)) continue;
                missingFromReplayCount += 1;
                await mirror.recordSyncException({ scope, stream, objectType, objectId, version: null, kind: "missing_from_full_replay", reasons: [`QBO no longer returns ${objectType} ${objectId} in a full replay; it may have been deleted in QuickBooks`], observedAt });
              }
            }
            openExceptionCount = (await mirror.listOpenSyncExceptions(scope, stream)).length;
            const summary = await mirror.summarizeStream(scope, stream);
            const reasons = [
              unsupportedCount > 0 ? `${unsupportedCount} provider object or line records in this run were not mirrorable` : null,
              openExceptionCount > 0 ? `${openExceptionCount} QBO object(s) have unresolved mirror exceptions` : null,
              mode === "incremental" ? "Incremental QBO query overlap is applied, but deletion tombstones are not returned by this source; run a full replay to establish complete coverage" : null,
            ].filter((value): value is string => value !== null);
            await mirror.recordCoverage({
              scope,
              stream,
              status: reasons.length ? "partial" : "complete",
              evidence: "live_provider_readback",
              basis: "source_transactions",
              watermark: summary.latestWatermark ? { value: summary.latestWatermark, observedAt: isoTimestampSchema.parse(now().toISOString()) } : null,
              coveredFrom: summary.coveredFrom,
              coveredThrough: summary.coveredThrough,
              observedAt,
              objectCount: summary.objectCount,
              transactionCount: summary.transactionCount,
              lineCount: summary.lineCount,
              reason: reasons.length ? reasons.join("; ").slice(0, 500) : null,
            });
          },
        });
        if (result.status === "failed") {
          // The transaction rolled back; report the durable state that remains.
          try { openExceptionCount = (await options.mirror.listOpenSyncExceptions(scope, stream)).length; } catch { /* keep last known */ }
        }
        const coverageStatus: "complete" | "partial" = unsupportedCount > 0 || openExceptionCount > 0 || mode === "incremental" || result.status === "failed" ? "partial" : "complete";
        streams.push({ stream, result, unsupportedCount, openExceptionCount, missingFromReplayCount, mode, coverageStatus });
        return result;
      };

      for (const entity of TRANSACTION_ENTITY_TYPES) {
        const stream = `transactions.${entity.toLowerCase()}`;
        const result = await syncStream(entity, stream, async (mirror, item, observedAt) => {
          const normalized = normalizeQboTransaction(entity, item, { currency });
          const identity = normalized.value;
          if (!identity || normalized.unsupportedReasons.length > 0) {
            const objectId = identity?.objectId ?? (typeof item.Id === "string" && /^[^\u0000-\u001f\u007f]{1,200}$/.test(item.Id) ? item.Id : null);
            if (objectId === null) throw new AccountingError("accounting_unavailable", `QBO ${entity} object without a usable Id cannot be tracked as an exception`);
            const version = identity?.version ?? (typeof item.SyncToken === "string" && /^[^\u0000-\u001f\u007f]{1,120}$/.test(item.SyncToken) ? item.SyncToken : null);
            if (identity) {
              // Keep the immutable provider revision for audit, but never
              // mirror a partial line list. A newer unsupported revision also
              // retires the previously mirrored lines so stale amounts cannot
              // be used as if they were current.
              await mirror.ingestSourceObject({ scope, objectType: identity.objectType, objectId: identity.objectId, version: identity.version, providerUpdatedAt: identity.providerUpdatedAt, providerBody: identity.providerBody, receivedAt: observedAt });
              await mirror.beginTransactionRevision({ scope, objectType: identity.objectType, objectId: identity.objectId, version: identity.version, lineIds: [] });
            }
            await mirror.recordSyncException({ scope, stream, objectType: entity, objectId, version, kind: "unsupported", reasons: normalized.unsupportedReasons, observedAt });
            return { objectId, unsupported: 1 };
          }
          const value = identity;
          const sourceObject = await mirror.ingestSourceObject({
            scope,
            objectType: value.objectType,
            objectId: value.objectId,
            version: value.version,
            providerUpdatedAt: value.providerUpdatedAt,
            providerBody: value.providerBody,
            receivedAt: observedAt,
          });
          const transaction = await mirror.ingestTransaction({
            sourceObjectId: sourceObject.id,
            scope,
            objectType: value.objectType,
            objectId: value.objectId,
            version: value.version,
            transactionDate: value.transactionDate,
            postingState: value.postingState,
            currency: value.currency,
            watermark: value.providerUpdatedAt,
            updatedAt: value.providerUpdatedAt,
          });
          await mirror.beginTransactionRevision({
            scope,
            objectType: value.objectType,
            objectId: value.objectId,
            version: value.version,
            lineIds: value.lines.map(line => line.lineId),
          });
          for (const line of value.lines) {
            const source = { provider: "qbo" as const, organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId, objectType: value.objectType, objectId: value.objectId, lineId: line.lineId, version: value.version };
            await mirror.ingestTransactionLine({
              transactionId: transaction.id, sourceObjectId: sourceObject.id, source, lineNumber: line.lineNumber,
              transactionType: line.transactionType, direction: line.direction, flow: line.flow, lineRole: line.lineRole,
              amountCents: line.amountCents, currency: line.currency, postingState: line.postingState, postedOn: line.postedOn,
              settlementState: line.settlementState, settledOn: line.settledOn, settledAmountCents: line.settledAmountCents,
              accountObjectId: line.accountObjectId, counterpartyObjectId: line.counterpartyObjectId, description: line.description,
              watermark: value.providerUpdatedAt, updatedAt: value.providerUpdatedAt,
            });
          }
          await mirror.resolveSyncException({ scope, stream, objectType: value.objectType, objectId: value.objectId, version: value.version, observedAt });
          return { objectId: value.objectId, unsupported: 0 };
        });
        if (result.status === "failed") break;
      }
      if (streams.every(stream => stream.result.status === "complete")) {
        await syncStream("Account", "accounts", async (mirror, item, observedAt) => {
          const normalized = accountObject(item);
          const objectId = typeof item.Id === "string" && /^[^\u0000-\u001f\u007f]{1,200}$/.test(item.Id) ? item.Id.trim() : null;
          if (!normalized) {
            if (objectId === null) throw new AccountingError("accounting_unavailable", "QBO Account without a usable Id cannot be tracked as an exception");
            await mirror.recordSyncException({ scope, stream: "accounts", objectType: "Account", objectId, version: typeof item.SyncToken === "string" ? item.SyncToken : null, kind: "unsupported", reasons: ["QBO Account is missing Id, SyncToken, LastUpdatedTime or AccountType"], observedAt });
            return { objectId, unsupported: 1 };
          }
          await mirror.ingestSourceObject({ scope, objectType: "Account", objectId: normalized.objectId, version: normalized.version, providerUpdatedAt: normalized.providerUpdatedAt, providerBody: normalized.providerBody, receivedAt: observedAt });
          await mirror.resolveSyncException({ scope, stream: "accounts", objectType: "Account", objectId: normalized.objectId, version: normalized.version, observedAt });
          return { objectId: normalized.objectId, unsupported: 0 };
        });
      }
      const complete = REQUIRED_STREAMS.every(required => streams.some(stream => stream.stream === required && stream.result.status === "complete" && stream.coverageStatus === "complete"));
      return { status: complete ? "complete" : "partial", streams };
    },
  };
}

export type { QboSyncCheckpoint };
