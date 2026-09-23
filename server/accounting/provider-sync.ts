import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema } from "../../shared/accounting";
import { currencyCodeSchema, isoTimestampSchema } from "../../shared/company";
import { QUICKBOOKS_CDC_LOOKBACK_DAYS, type QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { isQuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { normalizeQboTransaction, type QboCurrencyContext } from "../integrations/quickbooks/normalize";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import type { QuickBooksCapabilityEvidence, QuickBooksCapabilityStore } from "./capabilities";
import { versionCompare, type QboAccountingMirrorStore } from "./mirror-store";
import { PostgresQboCheckpointStore, runQboCatchUp, type QboCatchUpResult, type QboSyncCheckpoint } from "./sync";

const PAGE_SIZE = 500;
const TRANSACTION_ENTITY_TYPES = ["Purchase", "Bill", "BillPayment", "Deposit"] as const;
const REQUIRED_STREAMS = ["accounts", "transactions.purchase", "transactions.bill", "transactions.billpayment", "transactions.deposit"] as const;
/** Entities read by change data capture: the mirrored transactions plus Account identity. */
export const QBO_CDC_ENTITIES = [...TRANSACTION_ENTITY_TYPES, "Account"] as const;
/** Named provider records mirrored for display and mapping. */
export const QBO_NAMED_ENTITIES = ["Vendor", "Customer", "Employee"] as const;
/** Checkpoint stream holding the CDC watermark (watermark) and verified full-replay anchor (cursor). */
export const QBO_CHANGE_STREAM = "changes";
/** Re-read a short overlap on each CDC call; re-applying the same revision is a no-op. */
const CDC_OVERLAP_MS = 5 * 60_000;
/** Fall back to a full replay well before Intuit's 30-day CDC horizon. */
const CDC_SAFE_LOOKBACK_MS = QUICKBOOKS_CDC_LOOKBACK_DAYS * 86_400_000 - 12 * 3_600_000;

export function streamForEntity(entity: string): string | null {
  if ((TRANSACTION_ENTITY_TYPES as readonly string[]).includes(entity)) return `transactions.${entity.toLowerCase()}`;
  if (entity === "Account") return "accounts";
  return null;
}

type ApplyOutcome = { readonly objectId: string | null; readonly unsupported: number; readonly skipped?: "stale_after_deletion" };

/**
 * A live provider observation of an object we tombstoned. An inferred
 * (full-replay) deletion is undone when the same revision reappears; an
 * explicit webhook/CDC deletion is only superseded by a strictly newer
 * revision, so a fetch that raced the deletion cannot resurrect the object.
 */
async function admitLiveObservation(mirror: QboAccountingMirrorStore, scope: QuickBooksConnectionScope, objectType: string, objectId: string, version: string | null, providerUpdatedAt: string | null): Promise<boolean> {
  const state = await mirror.readDeletionState(scope, objectType, objectId);
  if (!state?.deleted) return true;
  if (state.detectedVia === "full_replay") {
    if (version !== null && state.lastKnownVersion !== null && version === state.lastKnownVersion) await mirror.restoreInferredDeletion(scope, objectType, objectId, version);
    return true;
  }
  if (version === null) return false;
  if (state.lastKnownVersion !== null && versionCompare(version, state.lastKnownVersion) <= 0) return false;
  if (state.sourceDeletedAt !== null && providerUpdatedAt !== null && providerUpdatedAt <= state.sourceDeletedAt) return false;
  return true;
}

/** Mirror one provider transaction object; shared by catch-up, CDC and webhook fetches. */
export async function applyQboTransactionObject(input: {
  readonly mirror: QboAccountingMirrorStore;
  readonly scope: QuickBooksConnectionScope;
  readonly entity: string;
  readonly stream: string;
  readonly item: QuickBooksJsonObject;
  readonly observedAt: string;
  readonly currency: QboCurrencyContext | null;
}): Promise<ApplyOutcome> {
  const { mirror, entity, stream, item, observedAt, currency } = input;
  const scope = scopeOf(input.scope);
  const normalized = normalizeQboTransaction(entity, item, { currency });
  const identity = normalized.value;
  const rawId = identity?.objectId ?? (typeof item.Id === "string" && /^[^\u0000-\u001f\u007f]{1,200}$/.test(item.Id) ? item.Id : null);
  const rawVersion = identity?.version ?? (typeof item.SyncToken === "string" && /^[^\u0000-\u001f\u007f]{1,120}$/.test(item.SyncToken) ? item.SyncToken : null);
  if (rawId !== null && !(await admitLiveObservation(mirror, scope, entity, rawId, rawVersion, identity?.providerUpdatedAt ?? providerTimestamp(metadataOf(item)?.LastUpdatedTime)))) {
    return { objectId: rawId, unsupported: 0, skipped: "stale_after_deletion" };
  }
  if (!identity || normalized.unsupportedReasons.length > 0) {
    const objectId = rawId;
    if (objectId === null) throw new AccountingError("accounting_unavailable", `QBO ${entity} object without a usable Id cannot be tracked as an exception`);
    if (identity) {
      // Keep the immutable provider revision for audit, but never
      // mirror a partial line list. A newer unsupported revision also
      // retires the previously mirrored lines so stale amounts cannot
      // be used as if they were current.
      await mirror.ingestSourceObject({ scope, objectType: identity.objectType, objectId: identity.objectId, version: identity.version, providerUpdatedAt: identity.providerUpdatedAt, providerBody: identity.providerBody, receivedAt: observedAt });
      await mirror.beginTransactionRevision({ scope, objectType: identity.objectType, objectId: identity.objectId, version: identity.version, lineIds: [] });
    }
    await mirror.recordSyncException({ scope, stream, objectType: entity, objectId, version: rawVersion, kind: "unsupported", reasons: normalized.unsupportedReasons, observedAt });
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
}

/** Mirror one provider Account revision (identity for payment and cost classification). */
export async function applyQboAccountObject(mirror: QboAccountingMirrorStore, scope: QuickBooksConnectionScope, item: QuickBooksJsonObject, observedAt: string): Promise<ApplyOutcome> {
  const normalized = accountObject(item);
  const objectId = typeof item.Id === "string" && /^[^\u0000-\u001f\u007f]{1,200}$/.test(item.Id) ? item.Id.trim() : null;
  if (!normalized) {
    if (objectId === null) throw new AccountingError("accounting_unavailable", "QBO Account without a usable Id cannot be tracked as an exception");
    await mirror.recordSyncException({ scope, stream: "accounts", objectType: "Account", objectId, version: typeof item.SyncToken === "string" ? item.SyncToken : null, kind: "unsupported", reasons: ["QBO Account is missing Id, SyncToken, LastUpdatedTime or AccountType"], observedAt });
    return { objectId, unsupported: 1 };
  }
  if (!(await admitLiveObservation(mirror, scope, "Account", normalized.objectId, normalized.version, normalized.providerUpdatedAt))) return { objectId: normalized.objectId, unsupported: 0, skipped: "stale_after_deletion" };
  await mirror.ingestSourceObject({ scope, objectType: "Account", objectId: normalized.objectId, version: normalized.version, providerUpdatedAt: normalized.providerUpdatedAt, providerBody: normalized.providerBody, receivedAt: observedAt });
  await mirror.resolveSyncException({ scope, stream: "accounts", objectType: "Account", objectId: normalized.objectId, version: normalized.version, observedAt });
  return { objectId: normalized.objectId, unsupported: 0 };
}

function isDeletedCdcObject(item: QuickBooksJsonObject): boolean {
  return typeof item.status === "string" && item.status.toLowerCase() === "deleted";
}

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

export interface QboChangeSyncResult {
  readonly mode: "cdc" | "full_replay";
  /** Why a full replay was chosen, when it was. */
  readonly reason: "no_checkpoint" | "checkpoint_expired" | "cdc_overflow" | "requested" | null;
  readonly status: "complete" | "partial" | "failed";
  readonly appliedCount: number;
  readonly deletedCount: number;
  readonly unsupportedCount: number;
  /** True when the change chain is anchored to a verified full replay. */
  readonly anchored: boolean;
  readonly watermark: string | null;
  readonly replay?: QboProviderSyncResult;
  readonly error?: unknown;
}

export interface QboObjectApplyResult {
  readonly status: "applied" | "deleted" | "not_found" | "unsupported" | "stale";
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string | null;
}

export interface QboProviderSync {
  /** Performs a read-only CompanyInfo call and records live read evidence. */
  bootstrapRead(): Promise<QboBootstrapProbeResult>;
  /** Mirrors the bounded QBO source subset and Account identity revisions. */
  catchUp(options?: { readonly maxPages?: number; readonly fullReplay?: boolean }): Promise<QboProviderSyncResult>;
  /**
   * Scoped sync used by the worker: change data capture since the stored
   * watermark, or a full replay with delete reconciliation when the
   * watermark is missing, older than the CDC horizon, or CDC overflowed.
   */
  syncChanges(options?: { readonly forceFullReplay?: boolean; readonly maxPages?: number }): Promise<QboChangeSyncResult>;
  /** Fetch and mirror one object named by a webhook, or tombstone it on a delete notice. */
  applyObject(input: { readonly objectType: string; readonly objectId: string; readonly operation: string; readonly occurredAt?: string | null }): Promise<QboObjectApplyResult>;
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

  const sync: QboProviderSync = {
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
      await requireReadCapability();
      const currency = await loadCurrencyContext();
      const fullReplay = input.fullReplay === true;
      const streams: QboProviderStreamResult[] = [];
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
              // QBO no longer returns may have been deleted: it stays an
              // explicit exception for review and is tombstoned, so its lines
              // stop counting and allocations against them are blocked.
              const objectType = entity;
              for (const objectId of await mirror.listMirroredObjectIds(scope, objectType)) {
                if (seen.has(objectId)) continue;
                missingFromReplayCount += 1;
                await mirror.recordSyncException({ scope, stream, objectType, objectId, version: null, kind: "missing_from_full_replay", reasons: [`QBO no longer returns ${objectType} ${objectId} in a full replay; it may have been deleted in QuickBooks`], observedAt });
                await mirror.recordDeletion({ scope, objectType, objectId, detectedVia: "full_replay", observedAt });
              }
            }
            openExceptionCount = (await mirror.listOpenSyncExceptions(scope, stream)).length;
            await recordStreamCoverage(mirror, stream, {
              unsupportedCount, openExceptionCount, observedAt,
              extraReason: mode === "incremental" ? "Incremental QBO query overlap is applied, but deletion tombstones are not returned by this source; run a full replay to establish complete coverage" : null,
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
        const result = await syncStream(entity, stream, (mirror, item, observedAt) => applyQboTransactionObject({ mirror, scope, entity, stream, item, observedAt, currency }));
        if (result.status === "failed") break;
      }
      if (streams.every(stream => stream.result.status === "complete")) {
        await syncStream("Account", "accounts", (mirror, item, observedAt) => applyQboAccountObject(mirror, scope, item, observedAt));
      }
      const complete = REQUIRED_STREAMS.every(required => streams.some(stream => stream.stream === required && stream.result.status === "complete" && stream.coverageStatus === "complete"));
      return { status: complete ? "complete" : "partial", streams };
    },

    async syncChanges(input = {}) {
      await requireReadCapability();
      const startedAt = now();
      const checkpoint = await checkpointStore.load(scope, QBO_CHANGE_STREAM);
      const watermark = checkpoint?.watermark ?? null;
      const age = watermark === null ? Infinity : startedAt.getTime() - Date.parse(watermark);
      const reason: QboChangeSyncResult["reason"] = input.forceFullReplay ? "requested" : watermark === null ? "no_checkpoint" : !(age <= CDC_SAFE_LOOKBACK_MS) ? "checkpoint_expired" : null;
      if (reason !== null) return fullReplay(reason, checkpoint, input.maxPages);

      const currency = await loadCurrencyContext();
      const since = new Date(Math.max(Date.parse(watermark!) - CDC_OVERLAP_MS, startedAt.getTime() - CDC_SAFE_LOOKBACK_MS)).toISOString();
      let response;
      try {
        response = await options.client.cdc([...QBO_CDC_ENTITIES], since);
      } catch (error) {
        return { mode: "cdc", reason: null, status: "failed", appliedCount: 0, deletedCount: 0, unsupportedCount: 0, anchored: checkpoint?.cursor !== null && checkpoint?.cursor !== undefined, watermark, error };
      }
      // A capped response may omit changes inside the window: never advance on it.
      if (response.truncated) return fullReplay("cdc_overflow", checkpoint, input.maxPages);
      const next = response.time ?? new Date(startedAt.getTime() - 60_000).toISOString();
      const anchored = typeof checkpoint?.cursor === "string" && checkpoint.cursor.startsWith("verified:");
      if (!options.executor.transaction) throw new AccountingError("accounting_configuration", "QBO change sync requires transaction support");
      try {
        const counts = await options.executor.transaction(async executor => {
          const mirror = options.mirror.forExecutor(executor);
          const observedAt = now().toISOString();
          const tally = { applied: 0, deleted: 0, unsupported: new Map<string, number>() };
          for (const entity of QBO_CDC_ENTITIES) {
            const stream = streamForEntity(entity)!;
            for (const item of response.entities[entity] ?? []) {
              if (isDeletedCdcObject(item)) {
                const objectId = typeof item.Id === "string" || typeof item.Id === "number" ? String(item.Id) : null;
                if (!objectId) continue;
                const deletedAt = providerTimestamp(metadataOf(item)?.LastUpdatedTime);
                const deletion = await mirror.recordDeletion({ scope, objectType: entity, objectId, sourceDeletedAt: deletedAt, detectedVia: "cdc", observedAt });
                if (deletion.applied) tally.deleted += 1;
                continue;
              }
              const outcome = entity === "Account"
                ? await applyQboAccountObject(mirror, scope, item, observedAt)
                : await applyQboTransactionObject({ mirror, scope, entity, stream, item, observedAt, currency });
              if (outcome.unsupported) tally.unsupported.set(stream, (tally.unsupported.get(stream) ?? 0) + outcome.unsupported);
              else if (!outcome.skipped) tally.applied += 1;
            }
          }
          for (const stream of REQUIRED_STREAMS) {
            const openExceptionCount = (await mirror.listOpenSyncExceptions(scope, stream)).length;
            await recordStreamCoverage(mirror, stream, {
              unsupportedCount: tally.unsupported.get(stream) ?? 0, openExceptionCount, observedAt,
              extraReason: anchored ? null : "Change capture is not yet anchored to a verified full replay",
            });
          }
          await checkpointStore.save(scope, QBO_CHANGE_STREAM, { watermark: next > watermark! ? next : watermark, cursor: checkpoint?.cursor ?? null }, checkpoint?.version ?? null, executor);
          return tally;
        });
        const unsupportedCount = Array.from(counts.unsupported.values()).reduce((sum, value) => sum + value, 0);
        const openExceptions = (await options.mirror.listOpenSyncExceptions(scope)).length;
        return { mode: "cdc", reason: null, status: anchored && unsupportedCount === 0 && openExceptions === 0 ? "complete" : "partial", appliedCount: counts.applied, deletedCount: counts.deleted, unsupportedCount, anchored, watermark: next > watermark! ? next : watermark };
      } catch (error) {
        return { mode: "cdc", reason: null, status: "failed", appliedCount: 0, deletedCount: 0, unsupportedCount: 0, anchored, watermark, error };
      }
    },

    async applyObject(input) {
      await requireReadCapability();
      const objectType = /^[A-Z][A-Za-z0-9_]{0,119}$/.test(input.objectType) ? input.objectType : (() => { throw new AccountingError("accounting_validation", "QBO object type is invalid"); })();
      const objectId = /^[A-Za-z0-9_.:-]{1,160}$/.test(input.objectId) ? input.objectId : (() => { throw new AccountingError("accounting_validation", "QBO object ID is invalid"); })();
      const operation = input.operation.toLowerCase();
      const supported = (QBO_CDC_ENTITIES as readonly string[]).includes(objectType) || (QBO_NAMED_ENTITIES as readonly string[]).includes(objectType);
      if (!supported) return { status: "unsupported", objectType, objectId, version: null };
      if (!options.executor.transaction) throw new AccountingError("accounting_configuration", "QBO object sync requires transaction support");
      if (operation === "deleted" || operation === "delete") {
        const occurredAt = input.occurredAt && Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : null;
        const result = await options.executor.transaction(executor => options.mirror.forExecutor(executor).recordDeletion({ scope, objectType, objectId, sourceDeletedAt: occurredAt, detectedVia: "webhook", observedAt: now().toISOString() }));
        return { status: result.applied ? "deleted" : "stale", objectType, objectId, version: null };
      }
      let entity: QuickBooksJsonObject;
      try {
        entity = (await options.client.read<QuickBooksJsonObject>(objectType, objectId)).entity;
      } catch (error) {
        if (isQuickBooksIntegrationError(error) && (error.status === 404 || error.details.providerCode === "610")) return { status: "not_found", objectType, objectId, version: null };
        throw error;
      }
      const currency = (QBO_NAMED_ENTITIES as readonly string[]).includes(objectType) || objectType === "Account" ? null : await loadCurrencyContext();
      const version = typeof entity.SyncToken === "string" || typeof entity.SyncToken === "number" ? String(entity.SyncToken) : null;
      const outcome = await options.executor.transaction(async executor => {
        const mirror = options.mirror.forExecutor(executor);
        const observedAt = now().toISOString();
        if (objectType === "Account") return applyQboAccountObject(mirror, scope, entity, observedAt);
        if ((QBO_NAMED_ENTITIES as readonly string[]).includes(objectType)) {
          const updated = providerTimestamp(metadataOf(entity)?.LastUpdatedTime);
          if (version === null) throw new AccountingError("accounting_unavailable", `QBO ${objectType} is missing its SyncToken`);
          if (!(await admitLiveObservation(mirror, scope, objectType, objectId, version, updated))) return { objectId, unsupported: 0, skipped: "stale_after_deletion" as const };
          await mirror.ingestSourceObject({ scope, objectType, objectId, version, providerUpdatedAt: updated, providerBody: entity, receivedAt: observedAt });
          return { objectId, unsupported: 0 };
        }
        return applyQboTransactionObject({ mirror, scope, entity: objectType, stream: streamForEntity(objectType)!, item: entity, observedAt, currency });
      });
      return { status: outcome.skipped ? "stale" : outcome.unsupported ? "unsupported" : "applied", objectType, objectId, version };
    },
  };

  async function requireReadCapability(): Promise<void> {
    const evidence = await options.capabilityStore.load(scope, "accounting.read");
    if (!evidence?.enabled || evidence.evidence !== "live_provider_readback") throw new AccountingError("accounting_capability_disabled", "Run the read-only QuickBooks CompanyInfo probe before mirroring transactions", { capability: "accounting.read" });
  }

  async function recordStreamCoverage(mirror: QboAccountingMirrorStore, stream: string, input: { readonly unsupportedCount: number; readonly openExceptionCount: number; readonly observedAt: string; readonly extraReason: string | null }): Promise<void> {
    const summary = await mirror.summarizeStream(scope, stream);
    const reasons = [
      input.unsupportedCount > 0 ? `${input.unsupportedCount} provider object or line records in this run were not mirrorable` : null,
      input.openExceptionCount > 0 ? `${input.openExceptionCount} QBO object(s) have unresolved mirror exceptions` : null,
      input.extraReason,
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
      observedAt: input.observedAt,
      objectCount: summary.objectCount,
      transactionCount: summary.transactionCount,
      lineCount: summary.lineCount,
      reason: reasons.length ? reasons.join("; ").slice(0, 500) : null,
    });
  }

  /**
   * Scoped full replay with delete reconciliation, then re-anchor the change
   * chain at the replay start. The anchor is written only when every stream
   * was fetched and applied; coverage stays partial otherwise.
   */
  async function fullReplay(reason: NonNullable<QboChangeSyncResult["reason"]>, before: QboSyncCheckpoint | null, maxPages?: number): Promise<QboChangeSyncResult> {
    const startedAt = now().toISOString();
    const replay = await sync.catchUp({ fullReplay: true, maxPages });
    const fetched = REQUIRED_STREAMS.every(required => replay.streams.some(stream => stream.stream === required && stream.result.status === "complete"));
    const deletedCount = replay.streams.reduce((sum, stream) => sum + stream.missingFromReplayCount, 0);
    const unsupportedCount = replay.streams.reduce((sum, stream) => sum + stream.unsupportedCount, 0);
    const appliedCount = replay.streams.reduce((sum, stream) => sum + stream.result.itemsApplied, 0) - unsupportedCount;
    if (!fetched) {
      const failure = replay.streams.find(stream => stream.result.status === "failed")?.result.error;
      return { mode: "full_replay", reason, status: "failed", appliedCount: 0, deletedCount: 0, unsupportedCount, anchored: false, watermark: before?.watermark ?? null, replay, error: failure };
    }
    const current = await checkpointStore.load(scope, QBO_CHANGE_STREAM);
    await checkpointStore.save(scope, QBO_CHANGE_STREAM, { watermark: startedAt, cursor: `verified:${startedAt}` }, current?.version ?? null);
    return { mode: "full_replay", reason, status: replay.status, appliedCount: Math.max(0, appliedCount), deletedCount, unsupportedCount, anchored: true, watermark: startedAt, replay };
  }

  return sync;
}

export type { QboSyncCheckpoint };
