import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema } from "../../shared/accounting";
import { currencyCodeSchema, isoTimestampSchema } from "../../shared/company";
import type { QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { normalizeQboTransaction } from "../integrations/quickbooks/normalize";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import type { QuickBooksCapabilityEvidence, QuickBooksCapabilityStore } from "./capabilities";
import type { QboAccountingMirrorStore } from "./mirror-store";
import { PostgresQboCheckpointStore, runQboCatchUp, type QboCatchUpResult, type QboSyncCheckpoint } from "./sync";

const PAGE_SIZE = 500;
const TRANSACTION_ENTITY_TYPES = ["Purchase", "Bill", "BillPayment", "Deposit"] as const;
const REQUIRED_STREAMS = ["accounts", "transactions.purchase", "transactions.bill", "transactions.billpayment", "transactions.deposit"] as const;

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
  readonly unsupportedCount: number;
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
  catchUp(options?: { readonly maxPages?: number }): Promise<QboProviderSyncResult>;
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

function overlapWatermark(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Date(parsed.getTime() - 1_000).toISOString();
}

function queryFor(entity: string, startPosition: number, sinceWatermark: string | null): string {
  if (!Number.isSafeInteger(startPosition) || startPosition < 1) throw new AccountingError("accounting_validation", "QBO query cursor is invalid");
  // Checkpoint values originate from QBO MetaData.LastUpdatedTime. Keep the
  // grammar narrow before interpolating the value into QBO's query language.
  const overlap = overlapWatermark(sinceWatermark);
  const where = overlap && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(overlap)
    ? ` WHERE MetaData.LastUpdatedTime >= '${overlap}'`
    : "";
  return `SELECT * FROM ${entity}${where} ORDERBY MetaData.LastUpdatedTime ASC, Id ASC STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
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
  let verifiedHomeCurrency: string | null = null;

  return {
    async bootstrapRead() {
      const result = await options.client.read<QuickBooksJsonObject>("CompanyInfo", scope.realmId);
      const identity = companyInfo(result.entity, scope.realmId);
      verifiedHomeCurrency = identity.homeCurrency;
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
      return { scope, providerRealmId: identity.providerRealmId, providerCompanyId: identity.providerCompanyId, providerCompanyName: identity.providerCompanyName, homeCurrency: identity.homeCurrency, capability };
    },

    async catchUp(input = {}) {
      await options.capabilityStore.load(scope, "accounting.read").then((evidence) => {
        if (!evidence?.enabled || evidence.evidence !== "live_provider_readback") throw new AccountingError("accounting_capability_disabled", "Run the read-only QuickBooks CompanyInfo probe before mirroring transactions", { capability: "accounting.read" });
      });
      const streams: QboProviderStreamResult[] = [];
      const syncStream = async (entity: string, stream: string, apply: (mirror: QboAccountingMirrorStore, item: QuickBooksJsonObject) => Promise<number>) => {
        const before = await checkpointStore.load(scope, stream);
        const incremental = before?.watermark !== null && before?.watermark !== undefined;
        let unsupportedCount = 0;
        const result = await runQboCatchUp<QuickBooksJsonObject>({
          executor: options.executor,
          checkpointStore,
          scope,
          stream,
          maxPages: input.maxPages,
          fetchPage: async ({ sinceWatermark, cursor }) => {
            const startPosition = cursor === null ? 1 : Number(cursor);
            const response = await options.client.query<QuickBooksJsonObject>(queryFor(entity, startPosition, sinceWatermark));
            const items = response.entities;
            const nextCursor = items.length >= PAGE_SIZE ? String(startPosition + items.length) : null;
            return { items, nextCursor, watermark: maxProviderTimestamp(items) };
          },
          applyPage: async (executor, items) => {
            const mirror = options.mirror.forExecutor(executor);
            for (const item of items) unsupportedCount += await apply(mirror, item);
          },
          finalize: async (executor) => {
            const mirror = options.mirror.forExecutor(executor);
            const summary = await mirror.summarizeStream(scope, stream);
            const reasons = [
              unsupportedCount > 0 ? `${unsupportedCount} provider object or line records were not mirrorable` : null,
              incremental ? "Incremental QBO query overlap is applied, but deletion tombstones are not returned by this source; coverage remains partial" : null,
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
              observedAt: now().toISOString(),
              objectCount: summary.objectCount,
              transactionCount: summary.transactionCount,
              lineCount: summary.lineCount,
              reason: reasons.length ? reasons.join("; ") : null,
            });
          },
        });
        const coverageStatus: "complete" | "partial" = unsupportedCount > 0 || incremental || result.status === "failed" ? "partial" : "complete";
        streams.push({ stream, result, unsupportedCount, coverageStatus });
        return result;
      };

      for (const entity of TRANSACTION_ENTITY_TYPES) {
        const stream = `transactions.${entity.toLowerCase()}`;
        const result = await syncStream(entity, stream, async (mirror, item) => {
          const normalized = normalizeQboTransaction(entity, item, { defaultCurrency: verifiedHomeCurrency });
          if (!normalized.value) return 1;
          const unsupported = normalized.unsupportedReasons.length;
          const sourceObject = await mirror.ingestSourceObject({
            scope,
            objectType: normalized.value.objectType,
            objectId: normalized.value.objectId,
            version: normalized.value.version,
            providerUpdatedAt: normalized.value.providerUpdatedAt,
            providerBody: normalized.value.providerBody,
            receivedAt: now().toISOString(),
          });
          const transaction = await mirror.ingestTransaction({
            sourceObjectId: sourceObject.id,
            scope,
            objectType: normalized.value.objectType,
            objectId: normalized.value.objectId,
            version: normalized.value.version,
            transactionDate: normalized.value.transactionDate,
            postingState: normalized.value.postingState,
            currency: normalized.value.currency,
            watermark: normalized.value.providerUpdatedAt,
            updatedAt: normalized.value.providerUpdatedAt,
          });
          await mirror.beginTransactionRevision({
            scope,
            objectType: normalized.value.objectType,
            objectId: normalized.value.objectId,
            version: normalized.value.version,
            lineIds: normalized.value.lines.map(line => line.lineId),
          });
          for (const line of normalized.value.lines) {
            const source = { provider: "qbo" as const, organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment: scope.environment, realmId: scope.realmId, objectType: normalized.value.objectType, objectId: normalized.value.objectId, lineId: line.lineId, version: normalized.value.version };
            await mirror.ingestTransactionLine({
              transactionId: transaction.id, sourceObjectId: sourceObject.id, source, lineNumber: line.lineNumber,
              transactionType: line.transactionType, direction: line.direction, flow: line.flow, lineRole: line.lineRole,
              amountCents: line.amountCents, currency: line.currency, postingState: line.postingState, postedOn: line.postedOn,
              settlementState: line.settlementState, settledOn: line.settledOn, settledAmountCents: line.settledAmountCents,
              accountObjectId: line.accountObjectId, counterpartyObjectId: line.counterpartyObjectId, description: line.description,
              watermark: normalized.value.providerUpdatedAt, updatedAt: normalized.value.providerUpdatedAt,
            });
          }
          return unsupported;
        });
        if (result.status === "failed") break;
      }
      if (streams.every(stream => stream.result.status === "complete")) {
        await syncStream("Account", "accounts", async (mirror, item) => {
          const normalized = accountObject(item);
          if (!normalized) return 1;
          await mirror.ingestSourceObject({ scope, objectType: "Account", objectId: normalized.objectId, version: normalized.version, providerUpdatedAt: normalized.providerUpdatedAt, providerBody: normalized.providerBody, receivedAt: now().toISOString() });
          return 0;
        });
      }
      const complete = REQUIRED_STREAMS.every(required => streams.some(stream => stream.stream === required && stream.result.status === "complete" && stream.coverageStatus === "complete"));
      return { status: complete ? "complete" : "partial", streams };
    },
  };
}

export type { QboSyncCheckpoint };
