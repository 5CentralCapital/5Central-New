import { randomUUID } from "node:crypto";
import { z } from "zod";
import { centsFromBigInt, centsSchema, currencyCodeSchema, isoDateSchema, isoTimestampSchema, type IsoDate, type MoneyCents } from "../../shared/company";
import {
  financialBasisSchema,
  financialCoverageStatusSchema,
  financialDirectionSchema,
  financialSourceFlowSchema,
  financialSourceLineRoleSchema,
  financialEvidenceStateSchema,
  financialPostingStateSchema,
  financialSettlementStateSchema,
  financialSourceCoverageSchema,
  financialSourceLineResolutionSchema,
  financialSourceReferenceSchema,
  financialSourceScopeSchema,
  financialSourceScopeKey,
  type FinancialSourceAllocationBalance,
  type FinancialSourceAllocationPort,
  type FinancialSourceAllocationRequest,
  type FinancialSourceCoverage,
  type FinancialProviderPaymentContext,
  type FinancialProviderPaymentContextPort,
  type FinancialProviderCostContext,
  type FinancialProviderPayeeType,
  type FinancialProviderCostContextPort,
  type FinancialSourceLineQuery,
  type FinancialSourceLineResolution,
  type FinancialSourceReadPort,
  type FinancialSourceReference,
  type FinancialSourceScope,
  type FinancialWatermark,
} from "../../shared/accounting";
import type { QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { QUICKBOOKS_CDC_LOOKBACK_DAYS } from "../integrations/quickbooks/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { createAccountingPurposeMappingStore, type AccountingPurposeMappingPort } from "./purpose";

interface SourceObjectInput {
  readonly scope: QuickBooksConnectionScope;
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string;
  readonly providerUpdatedAt?: string | null;
  readonly providerBody: Record<string, unknown>;
  readonly receivedAt?: string;
  readonly deletedAt?: string | null;
}

interface NamedObjectObservationResult {
  /** The immutable first-seen source row for this provider revision. */
  readonly sourceObjectId: string;
  readonly bodyHash: string;
  /** A different body under the same SyncToken changed a material field. */
  readonly conflict: boolean;
}

export interface QboTransactionInput {
  readonly id?: string;
  readonly sourceObjectId: string;
  readonly scope: QuickBooksConnectionScope;
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string;
  readonly transactionDate: string;
  readonly postingState: "posted" | "voided" | "unknown";
  readonly currency: string;
  readonly watermark: string;
  readonly updatedAt: string;
}

export interface QboTransactionLineInput {
  readonly id?: string;
  readonly transactionId: string;
  readonly sourceObjectId: string;
  readonly source: FinancialSourceReference;
  readonly lineNumber: number;
  readonly transactionType: string;
  readonly direction: "debit" | "credit";
  readonly flow: "incoming" | "outgoing" | "unknown";
  readonly lineRole: "receipt" | "expense" | "payable" | "payment_source" | "unknown";
  readonly amountCents: MoneyCents | string;
  readonly currency: string;
  readonly postingState: "posted" | "voided" | "unknown";
  readonly postedOn: string;
  readonly settlementState: "unknown" | "unsettled" | "settled" | "voided";
  readonly settledOn?: string | null;
  readonly settledAmountCents?: MoneyCents | string | null;
  readonly accountObjectId?: string | null;
  readonly counterpartyObjectId?: string | null;
  readonly description?: string | null;
  readonly watermark: string;
  readonly updatedAt: string;
}

export interface QboTransactionRevisionInput {
  readonly scope: QuickBooksConnectionScope;
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string;
  readonly lineIds: readonly string[];
}

export interface QboSourceLineLinkInput {
  readonly source: FinancialSourceReference;
  readonly consumerKind: string;
  readonly consumerId: string;
  readonly relationKind: string;
}

export interface QboCoverageInput {
  readonly scope: QuickBooksConnectionScope;
  readonly stream: string;
  readonly status: "unavailable" | "partial" | "complete";
  readonly evidence: "unverified" | "synthetic" | "live_provider_readback";
  readonly basis: "source_transactions" | "provider_report" | "unknown";
  readonly watermark: FinancialWatermark | null;
  readonly coveredFrom: string | null;
  readonly coveredThrough: string | null;
  readonly observedAt: string;
  readonly objectCount: number;
  readonly transactionCount: number;
  readonly lineCount: number;
  readonly missingIntervals?: readonly { from: string; through: string }[];
  readonly reason?: string | null;
}

export interface QboCoverageSummary {
  readonly objectCount: number;
  readonly transactionCount: number;
  readonly lineCount: number;
  readonly coveredFrom: string | null;
  readonly coveredThrough: string | null;
  readonly latestWatermark: string | null;
}

export type QboProviderMirrorKind = "accounts" | "vendors" | "customers" | "employees";

export interface QboProviderMirror {
  readonly kind: QboProviderMirrorKind;
  readonly objectType: "Account" | "Vendor" | "Customer" | "Employee";
  readonly providerObjectId: string;
  readonly displayName: string;
  readonly accountType: string | null;
  readonly accountSubType: string | null;
  readonly active: boolean;
  readonly version: string;
  readonly providerUpdatedAt: string | null;
}

interface BalanceRow {
  organization_id: unknown;
  legal_entity_id: unknown;
  environment: unknown;
  realm_id: unknown;
  object_type: unknown;
  object_id: unknown;
  line_id: unknown;
  amount_cents: unknown;
  currency: unknown;
  direction: unknown;
  flow: unknown;
  line_role: unknown;
  transaction_type: unknown;
  account_object_id: unknown;
  counterparty_object_id: unknown;
  latest_version: unknown;
  is_current: unknown;
  allocation_blocked: unknown;
  posting_state: unknown;
  posted_on: unknown;
  settlement_state: unknown;
  settled_on: unknown;
  settled_amount_cents: unknown;
  watermark: unknown;
  updated_at: unknown;
}

interface LineRow extends BalanceRow {
  id: unknown;
  transaction_id: unknown;
  source_object_id: unknown;
  line_number: unknown;
  source_version: unknown;
  description: unknown;
  line_transaction_type?: unknown;
  line_direction?: unknown;
  line_flow?: unknown;
  line_line_role?: unknown;
  line_amount_cents?: unknown;
  line_currency?: unknown;
  line_posting_state?: unknown;
  line_posted_on?: unknown;
  line_settlement_state?: unknown;
  line_settled_on?: unknown;
  line_settled_amount_cents?: unknown;
  line_watermark?: unknown;
  line_updated_at?: unknown;
  line_account_object_id?: unknown;
  line_counterparty_object_id?: unknown;
}

interface CoverageRow {
  stream?: unknown;
  status: unknown;
  evidence: unknown;
  basis: unknown;
  watermark: unknown;
  covered_from: unknown;
  covered_through: unknown;
  observed_at: unknown;
  object_count: unknown;
  transaction_count: unknown;
  line_count: unknown;
  reason: unknown;
}

function scopeOf(scope: QuickBooksConnectionScope): FinancialSourceScope {
  return financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
}

function scopeParts(scope: FinancialSourceScope): unknown[] {
  return [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId];
}

function baseParts(source: FinancialSourceReference): unknown[] {
  if (source.lineId === null) throw new AccountingError("accounting_validation", "A source line is required for financial resolution or allocation");
  return [source.organizationId, source.legalEntityId, source.environment, source.realmId, source.objectType, source.objectId, source.lineId];
}

function stringValue(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AccountingError("accounting_unavailable", `Accounting mirror returned an invalid ${field}`);
  return value;
}

function nullableString(value: unknown, field: string, max = 500): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, field, max);
}

function dateValue(value: unknown, field: string): string {
  if (value instanceof Date) return isoDateSchema.parse(value.toISOString().slice(0, 10));
  return isoDateSchema.parse(value);
}

function timestampValue(value: unknown, field: string): string {
  if (value instanceof Date) return isoTimestampSchema.parse(value.toISOString());
  return isoTimestampSchema.parse(value);
}

function centsValue(value: unknown, field: string): MoneyCents {
  if (typeof value === "bigint") return centsFromBigInt(value);
  return centsSchema.parse(typeof value === "number" ? String(value) : value);
}

function integerValue(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new AccountingError("accounting_unavailable", `Accounting mirror returned an invalid ${field}`);
  return number;
}

interface LineCursor {
  readonly scopeKey: string;
  readonly from: string | null;
  readonly through: string | null;
  readonly updatedAt: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly lineId: string;
}

function encodeLineCursor(cursor: LineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLineCursor(value: string, scope: FinancialSourceScope, from: string | undefined, through: string | undefined): LineCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<LineCursor>;
    if (parsed.scopeKey !== financialSourceScopeKey(scope) || (parsed.from ?? null) !== (from ?? null) || (parsed.through ?? null) !== (through ?? null)
      || typeof parsed.updatedAt !== "string" || typeof parsed.objectType !== "string" || typeof parsed.objectId !== "string" || typeof parsed.lineId !== "string") throw new Error("binding");
    isoTimestampSchema.parse(parsed.updatedAt);
    return parsed as LineCursor;
  } catch {
    throw new AccountingError("accounting_validation", "Accounting transaction cursor is invalid or bound to another query");
  }
}

/** Compare QBO SyncTokens numerically when both are integers, else lexically. */
export function versionCompare(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapResolution(row: LineRow): FinancialSourceLineResolution {
  const scope = financialSourceScopeSchema.parse({
    provider: "qbo",
    organizationId: row.organization_id,
    legalEntityId: row.legal_entity_id,
    environment: row.environment,
    realmId: row.realm_id,
  });
  const source = financialSourceReferenceSchema.parse({
    ...scope,
    objectType: row.object_type,
    objectId: row.object_id,
    lineId: row.line_id,
    version: row.source_version ?? row.latest_version,
  });
  const amount = row.line_amount_cents ?? row.amount_cents;
  const currency = row.line_currency ?? row.currency;
  const direction = row.line_direction ?? row.direction;
  const flow = row.line_flow ?? row.flow ?? "unknown";
  const lineRole = row.line_line_role ?? row.line_role ?? "unknown";
  const postingState = row.line_posting_state ?? row.posting_state;
  const postedOn = row.line_posted_on ?? row.posted_on;
  const settlementState = row.line_settlement_state ?? row.settlement_state;
  const settledOn = row.line_settled_on ?? row.settled_on;
  const settledAmount = row.line_settled_amount_cents ?? row.settled_amount_cents;
  const watermark = row.line_watermark ?? row.watermark;
  const updatedAt = row.line_updated_at ?? row.updated_at;
  const transactionType = row.line_transaction_type ?? row.transaction_type;
  const accountObjectId = row.line_account_object_id ?? row.account_object_id;
  const counterpartyObjectId = row.line_counterparty_object_id ?? row.counterparty_object_id;
  return financialSourceLineResolutionSchema.parse({
    source,
    direction: financialDirectionSchema.parse(direction),
    flow: financialSourceFlowSchema.parse(flow),
    lineRole: financialSourceLineRoleSchema.parse(lineRole),
    amountCents: centsValue(amount, "amount"),
    currency: currencyCodeSchema.parse(currency),
    transactionType: stringValue(transactionType, "transaction type", 120),
    accountObjectId: nullableString(accountObjectId, "account object", 200),
    counterpartyObjectId: nullableString(counterpartyObjectId, "counterparty object", 200),
    description: nullableString(row.description, "description", 500),
    postingState: financialPostingStateSchema.parse(postingState),
    postedOn: dateValue(postedOn, "posted date"),
    settlement: {
      state: financialSettlementStateSchema.parse(settlementState),
      settledOn: settledOn === null || settledOn === undefined ? null : dateValue(settledOn, "settled date"),
      settledAmountCents: settledAmount === null || settledAmount === undefined ? null : centsValue(settledAmount, "settled amount"),
    },
    watermark: { value: stringValue(watermark, "watermark", 255), observedAt: timestampValue(updatedAt, "watermark timestamp") },
  });
}

function mapCoverage(scope: FinancialSourceScope, row: CoverageRow | null, gaps: readonly { from: string; through: string }[] = [], stream = "aggregate"): FinancialSourceCoverage {
  if (!row) {
    return financialSourceCoverageSchema.parse({
      scope, status: "unavailable", evidence: "unverified", basis: "unknown", stream, watermark: null,
      coveredFrom: null, coveredThrough: null, observedAt: new Date(0).toISOString(),
      objectCount: 0, transactionCount: 0, lineCount: 0, missingIntervals: [], reason: "No provider mirror coverage is available",
    });
  }
  const watermark = row.watermark === null || row.watermark === undefined ? null : { value: stringValue(row.watermark, "coverage watermark"), observedAt: timestampValue(row.observed_at, "coverage timestamp") };
  return financialSourceCoverageSchema.parse({
    scope,
    stream,
    status: financialCoverageStatusSchema.parse(row.status),
    evidence: financialEvidenceStateSchema.parse(row.evidence),
    basis: financialBasisSchema.parse(row.basis),
    watermark,
    coveredFrom: row.covered_from === null || row.covered_from === undefined ? null : dateValue(row.covered_from, "coverage start"),
    coveredThrough: row.covered_through === null || row.covered_through === undefined ? null : dateValue(row.covered_through, "coverage end"),
    observedAt: timestampValue(row.observed_at, "coverage observed at"),
    objectCount: Number(row.object_count ?? 0), transactionCount: Number(row.transaction_count ?? 0), lineCount: Number(row.line_count ?? 0),
    missingIntervals: gaps,
    reason: row.reason === null || row.reason === undefined ? null : stringValue(row.reason, "coverage reason", 500),
  });
}

function coverageIsStale(observedAt: string, now: Date): boolean {
  const observed = Date.parse(observedAt);
  return Number.isFinite(observed) && now.getTime() - observed > COVERAGE_STALE_AFTER_MS;
}

function markStaleCoverage(coverage: FinancialSourceCoverage, now: Date): FinancialSourceCoverage {
  if (coverage.status !== "complete" || !coverageIsStale(coverage.observedAt, now)) return coverage;
  return financialSourceCoverageSchema.parse({
    ...coverage,
    status: "partial",
    reason: "QBO provider coverage is stale; a successful sync has not been observed within the CDC lookback window",
  });
}

export type QboSyncExceptionKind = "unsupported" | "missing_from_full_replay";

export interface QboSyncExceptionInput {
  readonly scope: QuickBooksConnectionScope;
  readonly stream: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string | null;
  readonly kind: QboSyncExceptionKind;
  readonly reasons: readonly string[];
  readonly observedAt: string;
}

export interface QboSyncExceptionResolution {
  readonly scope: QuickBooksConnectionScope;
  readonly stream: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string;
  readonly observedAt: string;
}

export interface QboSyncException {
  readonly stream: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string | null;
  readonly kind: QboSyncExceptionKind;
  readonly reasons: readonly string[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

const STREAM_PATTERN = /^[a-z][a-z0-9_.:-]*$/;
const MAX_EXCEPTION_REASON_LENGTH = 300;
const COVERAGE_STALE_AFTER_MS = QUICKBOOKS_CDC_LOOKBACK_DAYS * 86_400_000;

function exceptionReasons(reasons: readonly string[]): string[] {
  const cleaned = Array.from(new Set(reasons.map(reason => String(reason).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_EXCEPTION_REASON_LENGTH)).filter(reason => reason.length > 0))).slice(0, 50);
  if (cleaned.length === 0) throw new AccountingError("accounting_validation", "QBO sync exception needs at least one reason");
  return cleaned;
}

export type QboDeletionDetection = "webhook" | "cdc" | "full_replay";

export interface QboDeletionInput {
  readonly scope: QuickBooksConnectionScope;
  readonly objectType: string;
  readonly objectId: string;
  /** Last provider revision seen before the deletion; defaults to the newest mirrored revision. */
  readonly lastKnownVersion?: string | null;
  /** Provider deletion time when the source states it (webhook/CDC). */
  readonly sourceDeletedAt?: string | null;
  readonly detectedVia: QboDeletionDetection;
  readonly observedAt: string;
}

export interface QboDeletionResult {
  /** False when a newer live revision proves the deletion notice is stale. */
  readonly applied: boolean;
  readonly tombstoneCreated: boolean;
  readonly retiredLineCount: number;
  /** Allocations that now point at a deleted source line and are blocked for review. */
  readonly blockedAllocationCount: number;
  readonly blockedAllocatedCents: MoneyCents;
}

export interface QboDeletionWindow {
  /** Inclusive lower bound on detection time. */
  readonly detectedFrom?: string;
  /** Exclusive upper bound on detection time. */
  readonly detectedBefore?: string;
}

export interface QboDeletionState {
  readonly deleted: boolean;
  readonly detectedVia: QboDeletionDetection;
  readonly lastKnownVersion: string | null;
  readonly sourceDeletedAt: string | null;
  readonly detectedAt: string;
}

export interface QboAccountingMirrorStore extends FinancialSourceReadPort, FinancialSourceAllocationPort, FinancialProviderPaymentContextPort, FinancialProviderCostContextPort {
  readonly purposeMappings: AccountingPurposeMappingPort;
  forExecutor(executor: RentOpsQueryExecutor): QboAccountingMirrorStore;
  ingestSourceObject(input: SourceObjectInput): Promise<{ readonly id: string; readonly bodyHash: string }>;
  /**
   * Ingest a named QBO profile while preserving every distinct body observed
   * for the same provider revision. Financial source rows remain immutable;
   * material same-token drift is returned as a per-object conflict so one
   * profile cannot roll back the whole sync transaction.
   */
  ingestNamedObject(input: SourceObjectInput): Promise<NamedObjectObservationResult>;
  ingestTransaction(input: QboTransactionInput): Promise<{ readonly id: string }>;
  beginTransactionRevision(input: QboTransactionRevisionInput): Promise<void>;
  ingestTransactionLine(input: QboTransactionLineInput): Promise<void>;
  linkSourceLine(input: QboSourceLineLinkInput): Promise<void>;
  summarizeStream(scope: QuickBooksConnectionScope, stream: string): Promise<QboCoverageSummary>;
  recordCoverage(input: QboCoverageInput): Promise<void>;
  /** Durable per-object mirror exception; survives checkpoint advances and later runs. */
  recordSyncException(input: QboSyncExceptionInput): Promise<void>;
  /** Resolve an exception once the same or a newer provider revision mirrors completely. */
  resolveSyncException(input: QboSyncExceptionResolution): Promise<boolean>;
  listOpenSyncExceptions(scope: QuickBooksConnectionScope, stream?: string): Promise<readonly QboSyncException[]>;
  /** Mirrored transaction object IDs for a type, used to detect objects absent from a full replay. */
  listMirroredObjectIds(scope: QuickBooksConnectionScope, objectType: string): Promise<readonly string[]>;
  listProviderMirrors(scope: QuickBooksConnectionScope, kind: QboProviderMirrorKind): Promise<readonly QboProviderMirror[]>;
  /**
   * Record a provider deletion: append the tombstone, mark every mirrored
   * revision deleted, retire the object's lines (not current, voided) and
   * block allocations that consumed them. Idempotent.
   */
  recordDeletion(input: QboDeletionInput): Promise<QboDeletionResult>;
  /** The object's tombstone and whether it is still deleted (no live revision since). */
  readDeletionState(scope: QuickBooksConnectionScope, objectType: string, objectId: string): Promise<QboDeletionState | null>;
  /**
   * Undo an inferred (full-replay) deletion when the provider returns the
   * same revision again. Explicit webhook/CDC deletions are never undone here.
   */
  restoreInferredDeletion(scope: QuickBooksConnectionScope, objectType: string, objectId: string, version: string): Promise<boolean>;
  /**
   * Objects still deleted whose deletion was detected inside the window
   * (all time when the window is open). Health uses a recent window and the
   * close checklist the period, so old reviewed deletions do not linger.
   */
  countActiveTombstones(scope: QuickBooksConnectionScope, window?: QboDeletionWindow): Promise<number>;
}

interface ProviderSourceObjectRow {
  provider_body: unknown;
  provider_updated_at: unknown;
  object_version: unknown;
  received_at?: unknown;
}

/**
 * Fields QuickBooks computes when an object is read, without issuing a new
 * SyncToken: every reference's display name (AccountRef.name is the current
 * full account path, VendorRef.name the current vendor name), an Account's
 * FullyQualifiedName and running balances, and a name-list record's balance.
 * Re-reading an unchanged revision after a rename or a posting returns them
 * changed; they are ignored when checking that a revision is unchanged.
 */
const READ_TIME_TOP_LEVEL_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Account: new Set(["FullyQualifiedName", "CurrentBalance", "CurrentBalanceWithSubAccounts"]),
  Customer: new Set(["FullyQualifiedName", "Balance", "BalanceWithJobs"]),
  Vendor: new Set(["Balance"]),
};

function withoutReadTimeFields(objectType: string, value: unknown, topLevel = true): unknown {
  if (Array.isArray(value)) return value.map(item => withoutReadTimeFields(objectType, item, false));
  if (!value || typeof value !== "object") return value;
  const skip = topLevel ? READ_TIME_TOP_LEVEL_FIELDS[objectType] : undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (skip?.has(key)) continue;
    // Name-list records can be returned with a newer read timestamp while
    // QuickBooks keeps the same SyncToken. The timestamp is retained in each
    // raw observation, but it is not itself a material profile change.
    if (topLevel && (objectType === "Customer" || objectType === "Vendor" || objectType === "Employee") && key === "MetaData" && child && typeof child === "object" && !Array.isArray(child)) {
      const metadata = { ...(child as Record<string, unknown>) };
      delete metadata.LastUpdatedTime;
      result[key] = withoutReadTimeFields(objectType, metadata, false);
      continue;
    }
    if (key.endsWith("Ref") && child && typeof child === "object" && !Array.isArray(child)) {
      const reference = { ...(child as Record<string, unknown>) };
      delete reference.name;
      result[key] = withoutReadTimeFields(objectType, reference, false);
    } else {
      result[key] = withoutReadTimeFields(objectType, child, false);
    }
  }
  return result;
}

function providerReference(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  const id = reference.value ?? reference.Id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function nestedProviderReference(body: unknown, parent: string, key: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[parent];
  return providerReference(value, key);
}

function typedProviderReference(value: unknown, fallbackType?: FinancialProviderPayeeType): { id: string; type: FinancialProviderPayeeType } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Record<string, unknown>;
  const nested = reference.EntityRef ?? reference.Ref;
  if (nested && nested !== value) {
    const nestedResult = typedProviderReference(nested, fallbackType ?? (typeof reference.Type === "string" ? reference.Type as FinancialProviderPayeeType : undefined));
    if (nestedResult) return nestedResult;
  }
  const id = reference.value ?? reference.Id;
  if (typeof id !== "string" || id.trim().length === 0) return null;
  const rawType = reference.Type ?? reference.type ?? fallbackType;
  if (rawType !== "Vendor" && rawType !== "Customer" && rawType !== "Employee") return null;
  return { id: id.trim(), type: rawType };
}

function typedBodyReference(body: unknown, key: string, type?: FinancialProviderPayeeType): { id: string; type: FinancialProviderPayeeType } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return typedProviderReference((body as Record<string, unknown>)[key], type);
}

function typedDepositPayee(body: unknown, lineId: string | null): { id: string; type: FinancialProviderPayeeType } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const rawLines = (body as Record<string, unknown>).Line;
  const lines = Array.isArray(rawLines) ? rawLines : rawLines ? [rawLines] : [];
  for (const rawLine of lines) {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) continue;
    const line = rawLine as Record<string, unknown>;
    if (lineId !== null && String(line.Id ?? "") !== lineId) continue;
    const detail = line.DepositLineDetail;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
    const detailRecord = detail as Record<string, unknown>;
    const entity = typedProviderReference(detailRecord.Entity) ?? typedProviderReference(detailRecord.EntityRef);
    if (entity) return entity;
  }
  return null;
}

class PostgresQboAccountingMirrorStore implements QboAccountingMirrorStore {
  constructor(
    private readonly executor: RentOpsQueryExecutor,
    private readonly bound = false,
    private readonly now: () => Date = () => new Date(),
    readonly purposeMappings: AccountingPurposeMappingPort = createAccountingPurposeMappingStore(executor, now),
  ) {}

  forExecutor(executor: RentOpsQueryExecutor): QboAccountingMirrorStore {
    return new PostgresQboAccountingMirrorStore(executor, true, this.now, this.purposeMappings.forExecutor(executor));
  }

  async ingestSourceObject(input: SourceObjectInput): Promise<{ readonly id: string; readonly bodyHash: string }> {
    const scope = scopeOf(input.scope);
    const objectType = /^[A-Z][A-Za-z0-9_]{0,119}$/.test(input.objectType) ? input.objectType : (() => { throw new AccountingError("accounting_validation", "QBO object type is invalid"); })();
    const objectId = stringValue(input.objectId, "object ID", 200);
    const version = stringValue(input.version, "object version", 120);
    if (!input.providerBody || typeof input.providerBody !== "object" || Array.isArray(input.providerBody)) throw new AccountingError("accounting_validation", "QBO provider body must be an object");
    const bodyHash = canonicalJsonSha256(input.providerBody);
    const id = randomUUID();
    const result = await this.executor.query<{ id: string }>(
      `INSERT INTO accounting_qbo_source_objects
        (id, organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, provider_updated_at, body_hash, provider_body, received_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version)
       DO NOTHING RETURNING id`,
      [id, ...scopeParts(scope), objectType, objectId, version, input.providerUpdatedAt ?? null, bodyHash, JSON.stringify(input.providerBody), input.receivedAt ?? this.now().toISOString(), input.deletedAt ?? null],
    );
    if (result.rows[0]) return { id: result.rows[0].id, bodyHash };
    const existing = await this.executor.query<{ id: string; body_hash: string; provider_body: unknown }>(
      `SELECT id, body_hash, provider_body FROM accounting_qbo_source_objects
       WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND object_type = $5 AND object_id = $6 AND object_version = $7`,
      [...scopeParts(scope), objectType, objectId, version],
    );
    const row = existing.rows[0];
    if (!row) throw new AccountingError("accounting_conflict", "QBO source object version changed after it was mirrored");
    if (row.body_hash !== bodyHash) {
      // The first-seen body stays (append-only). Only read-time fields may
      // differ under the same SyncToken; any other difference is a conflict.
      const stored = typeof row.provider_body === "string" ? JSON.parse(row.provider_body) as unknown : row.provider_body;
      if (canonicalJsonSha256(withoutReadTimeFields(objectType, stored)) !== canonicalJsonSha256(withoutReadTimeFields(objectType, input.providerBody))) {
        throw new AccountingError("accounting_conflict", "QBO source object version changed after it was mirrored");
      }
      return { id: row.id, bodyHash: row.body_hash };
    }
    return { id: row.id, bodyHash };
  }

  async ingestNamedObject(input: SourceObjectInput): Promise<NamedObjectObservationResult> {
    const scope = scopeOf(input.scope);
    const objectType = /^(Customer|Vendor|Employee)$/.test(input.objectType) ? input.objectType : (() => { throw new AccountingError("accounting_validation", "QBO named object type is invalid"); })();
    const objectId = stringValue(input.objectId, "object ID", 200);
    const version = stringValue(input.version, "object version", 120);
    if (!input.providerBody || typeof input.providerBody !== "object" || Array.isArray(input.providerBody)) throw new AccountingError("accounting_validation", "QBO provider body must be an object");
    const bodyHash = canonicalJsonSha256(input.providerBody);
    const id = randomUUID();
    const receivedAt = input.receivedAt ?? this.now().toISOString();
    const inserted = await this.executor.query<{ id: string }>(
      `INSERT INTO accounting_qbo_source_objects
        (id, organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, provider_updated_at, body_hash, provider_body, received_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version)
       DO NOTHING RETURNING id`,
      [id, ...scopeParts(scope), objectType, objectId, version, input.providerUpdatedAt ?? null, bodyHash, JSON.stringify(input.providerBody), receivedAt, input.deletedAt ?? null],
    );
    const row = inserted.rows[0]
      ? { id: inserted.rows[0].id, body_hash: bodyHash, provider_body: input.providerBody }
      : (await this.executor.query<{ id: string; body_hash: string; provider_body: unknown }>(
        `SELECT id, body_hash, provider_body FROM accounting_qbo_source_objects
         WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND object_type = $5 AND object_id = $6 AND object_version = $7`,
        [...scopeParts(scope), objectType, objectId, version],
      )).rows[0];
    if (!row) throw new AccountingError("accounting_conflict", "QBO source object version changed after it was mirrored");

    const stored = typeof row.provider_body === "string" ? JSON.parse(row.provider_body) as unknown : row.provider_body;
    const materialConflict = row.body_hash !== bodyHash
      && canonicalJsonSha256(withoutReadTimeFields(objectType, stored)) !== canonicalJsonSha256(withoutReadTimeFields(objectType, input.providerBody));
    // Keep every named profile observation, including a repeated first body.
    // This makes A -> B -> A deterministic and prevents an old observation
    // from remaining selected after the provider returns to A.
    // `observation_order` is a database identity column and is the tie-breaker
    // when several provider observations share the same received timestamp.
    const orderedObservedAt = isoTimestampSchema.parse(receivedAt);
    await this.executor.query(
      `INSERT INTO accounting_qbo_named_observations
        (id, organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version, source_object_id, provider_updated_at, body_hash, provider_body, observed_at, material_conflict)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
      [randomUUID(), ...scopeParts(scope), objectType, objectId, version, row.id, input.providerUpdatedAt ?? null, bodyHash, JSON.stringify(input.providerBody), orderedObservedAt, materialConflict],
    );
    const prior = await this.executor.query<{ has_conflict: boolean | string }>(
      `SELECT EXISTS(
         SELECT 1 FROM accounting_qbo_named_observations
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
            AND object_type=$5 AND object_id=$6 AND object_version=$7 AND material_conflict=true
       ) AS has_conflict`,
      [...scopeParts(scope), objectType, objectId, version],
    );
    const hasPriorConflict = prior.rows[0]?.has_conflict === true || prior.rows[0]?.has_conflict === "true";
    return { sourceObjectId: row.id, bodyHash, conflict: materialConflict || hasPriorConflict };
  }

  async ingestTransaction(input: QboTransactionInput): Promise<{ readonly id: string }> {
    const scope = scopeOf(input.scope);
    const date = isoDateSchema.parse(input.transactionDate);
    const updatedAt = isoTimestampSchema.parse(input.updatedAt);
    const normalizedCurrency = currencyCodeSchema.parse(input.currency);
    const id = input.id ?? randomUUID();
    const result = await this.executor.query<{ id: string }>(
      `INSERT INTO accounting_qbo_transactions
        (id, organization_id, legal_entity_id, environment, realm_id, source_object_id, object_type, object_id, object_version, transaction_date, posting_state, currency, watermark, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, object_version)
       DO NOTHING
       RETURNING id`,
      [id, ...scopeParts(scope), input.sourceObjectId, input.objectType, input.objectId, input.version, date, input.postingState, normalizedCurrency, input.watermark, updatedAt],
    );
    if (result.rows[0]) return { id: result.rows[0].id };
    const existing = await this.executor.query<{ id: string; source_object_id: string; transaction_date: unknown; posting_state: string; currency: string; watermark: string; updated_at: unknown }>(
      `SELECT id, source_object_id, transaction_date, posting_state, currency, watermark, updated_at
         FROM accounting_qbo_transactions
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND object_version=$7`,
      [...scopeParts(scope), input.objectType, input.objectId, input.version],
    );
    const row = existing.rows[0];
    const rowDate = row?.transaction_date instanceof Date ? row.transaction_date.toISOString().slice(0, 10) : row?.transaction_date === undefined ? undefined : String(row.transaction_date).slice(0, 10);
    if (!row || row.source_object_id !== input.sourceObjectId || rowDate !== date || row.posting_state !== input.postingState || row.currency !== normalizedCurrency || row.watermark !== input.watermark) {
      throw new AccountingError("accounting_conflict", "QBO transaction revision changed after it was mirrored");
    }
    return { id: row.id };
  }

  async beginTransactionRevision(input: QboTransactionRevisionInput): Promise<void> {
    const scope = scopeOf(input.scope);
    if (!/^[A-Z][A-Za-z0-9_]{0,119}$/.test(input.objectType) || !input.objectId || !input.version) throw new AccountingError("accounting_validation", "QBO transaction revision identity is invalid");
    const lineIds = Array.from(new Set(input.lineIds));
    if (lineIds.some(value => !/^[^\u0000-\u001f\u007f]{1,200}$/.test(value))) throw new AccountingError("accounting_validation", "QBO transaction line identity is invalid");
    const rows = await this.executor.query<{ line_id: string; latest_version: string; allocation_blocked: boolean }>(
      `SELECT line_id, latest_version, allocation_blocked FROM accounting_qbo_source_line_balances
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 FOR UPDATE`,
      [...scopeParts(scope), input.objectType, input.objectId],
    );
    if (!rows.rows.some(row => versionCompare(input.version, row.latest_version) > 0)) return;
    const allocations = await this.executor.query<{ line_id: string; allocated_cents: unknown }>(
      `SELECT line_id, COALESCE(SUM(amount_cents),0) AS allocated_cents
         FROM accounting_qbo_source_line_allocations
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6
        GROUP BY line_id`,
      [...scopeParts(scope), input.objectType, input.objectId],
    );
    const allocatedByLine = new Map(allocations.rows.map(row => [row.line_id, BigInt(String(row.allocated_cents ?? "0"))]));
    const removedWithAllocation = rows.rows.some(row => !lineIds.includes(row.line_id) && (allocatedByLine.get(row.line_id) ?? BigInt(0)) > BigInt(0));
    await this.executor.query(
      `UPDATE accounting_qbo_source_line_balances
          SET is_current = line_id = ANY($7::varchar[]),
              posting_state = CASE WHEN line_id = ANY($7::varchar[]) THEN posting_state ELSE 'voided' END,
              settlement_state = CASE WHEN line_id = ANY($7::varchar[]) THEN settlement_state ELSE 'voided' END,
              settled_on = CASE WHEN line_id = ANY($7::varchar[]) THEN settled_on ELSE NULL END,
              settled_amount_cents = CASE WHEN line_id = ANY($7::varchar[]) THEN settled_amount_cents ELSE NULL END,
              allocation_blocked = allocation_blocked OR $8,
              updated_at = $9
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6`,
      [...scopeParts(scope), input.objectType, input.objectId, lineIds, removedWithAllocation, this.now().toISOString()],
    );
  }

  async ingestTransactionLine(input: QboTransactionLineInput): Promise<void> {
    const source = financialSourceReferenceSchema.parse(input.source);
    if (source.lineId === null) throw new AccountingError("accounting_validation", "QBO source line ID is required");
    const amount = centsSchema.parse(input.amountCents);
    if (BigInt(amount) < BigInt(0)) throw new AccountingError("accounting_validation", "QBO source line amount cannot be negative");
    const currency = currencyCodeSchema.parse(input.currency);
    const postedOn = isoDateSchema.parse(input.postedOn);
    const updatedAt = isoTimestampSchema.parse(input.updatedAt);
    const settledOn = input.settledOn === undefined || input.settledOn === null ? null : isoDateSchema.parse(input.settledOn);
    const settledAmount = input.settledAmountCents === undefined || input.settledAmountCents === null ? null : centsSchema.parse(input.settledAmountCents);
    const existing = await this.executor.query<{ latest_version: string; allocation_blocked: boolean }>(
      `SELECT latest_version FROM accounting_qbo_source_line_balances
       WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND object_type = $5 AND object_id = $6 AND line_id = $7 FOR UPDATE`,
      baseParts(source),
    );
    const revisionState = await this.executor.query<{ allocation_blocked: boolean }>(
      `SELECT COALESCE(BOOL_OR(allocation_blocked), false) AS allocation_blocked
         FROM accounting_qbo_source_line_balances
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6`,
      baseParts(source).slice(0, 6),
    );
    const allocationBlocked = Boolean(revisionState.rows[0]?.allocation_blocked);
    const current = existing.rows[0]?.latest_version;
    if (!current) {
      await this.executor.query(
        `INSERT INTO accounting_qbo_source_line_balances
          (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, amount_cents, currency, direction, flow, line_role, transaction_type, account_object_id, counterparty_object_id, latest_version, is_current, allocation_blocked, posting_state, posted_on, settlement_state, settled_on, settled_amount_cents, watermark, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [...baseParts(source), amount, currency, input.direction, input.flow, input.lineRole, input.transactionType, input.accountObjectId ?? null, input.counterpartyObjectId ?? null, source.version, true, allocationBlocked, input.postingState, postedOn, input.settlementState, settledOn, settledAmount, input.watermark, updatedAt],
      );
    } else if (versionCompare(source.version, current) > 0) {
      await this.executor.query(
        `UPDATE accounting_qbo_source_line_balances SET amount_cents = $8, currency = $9, direction = $10,
          flow = $11, line_role = $12, transaction_type = $13, account_object_id = $14, counterparty_object_id = $15, latest_version = $16,
          is_current = true, allocation_blocked = allocation_blocked OR $17,
          posting_state = $18, posted_on = $19, settlement_state = $20, settled_on = $21,
          settled_amount_cents = $22, watermark = $23, updated_at = $24
         WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND object_type = $5 AND object_id = $6 AND line_id = $7`,
        [...baseParts(source), amount, currency, input.direction, input.flow, input.lineRole, input.transactionType, input.accountObjectId ?? null, input.counterpartyObjectId ?? null, source.version, allocationBlocked, input.postingState, postedOn, input.settlementState, settledOn, settledAmount, input.watermark, updatedAt],
      );
    }
    const result = await this.executor.query<{ id: string }>(
      `INSERT INTO accounting_qbo_transaction_lines
        (id, organization_id, legal_entity_id, environment, realm_id, transaction_id, source_object_id, object_type, object_id, line_number, source_line_id, source_version, transaction_type, direction, flow, line_role, amount_cents, currency, posting_state, posted_on, settlement_state, settled_on, settled_amount_cents, account_object_id, counterparty_object_id, description, watermark, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, source_line_id, source_version)
       DO NOTHING RETURNING id`,
      [input.id ?? randomUUID(), ...baseParts(source).slice(0, 4), input.transactionId, input.sourceObjectId, source.objectType, source.objectId,  input.lineNumber, source.lineId, source.version, input.transactionType, input.direction, input.flow, input.lineRole, amount, currency, input.postingState, postedOn, input.settlementState, settledOn, settledAmount, input.accountObjectId ?? null, input.counterpartyObjectId ?? null, input.description ?? null, input.watermark, updatedAt],
    );
    if (!result.rows[0]) {
      const existingLine = await this.executor.query<Record<string, unknown>>(
        `SELECT transaction_id, source_object_id, line_number, transaction_type, direction, flow, line_role,
                amount_cents, currency, posting_state, posted_on, settlement_state, settled_on, settled_amount_cents,
                account_object_id, counterparty_object_id, description, watermark
           FROM accounting_qbo_transaction_lines
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
            AND object_type=$5 AND object_id=$6 AND source_line_id=$7 AND source_version=$8`,
        [...baseParts(source), source.version],
      );
      const row = existingLine.rows[0];
      const rowDate = row?.posted_on instanceof Date ? row.posted_on.toISOString().slice(0, 10) : row?.posted_on === undefined ? undefined : String(row.posted_on).slice(0, 10);
      if (!row || String(row.transaction_id) !== input.transactionId || String(row.source_object_id) !== input.sourceObjectId || Number(row.line_number) !== input.lineNumber
        || row.transaction_type !== input.transactionType || row.direction !== input.direction || row.flow !== input.flow || row.line_role !== input.lineRole
        || String(row.amount_cents) !== String(amount) || row.currency !== currency || row.posting_state !== input.postingState || rowDate !== postedOn
        || row.settlement_state !== input.settlementState || (row.settled_on === null ? null : String(row.settled_on).slice(0, 10)) !== settledOn
        || (row.settled_amount_cents === null ? null : String(row.settled_amount_cents)) !== settledAmount || (row.account_object_id ?? null) !== (input.accountObjectId ?? null)
        || (row.counterparty_object_id ?? null) !== (input.counterpartyObjectId ?? null) || (row.description ?? null) !== (input.description ?? null) || row.watermark !== input.watermark) {
        throw new AccountingError("accounting_conflict", "QBO transaction line revision changed after it was mirrored");
      }
    }
  }

  async linkSourceLine(input: QboSourceLineLinkInput): Promise<void> {
    const source = financialSourceReferenceSchema.parse(input.source);
    const base = baseParts(source);
    for (const [value, field, max] of [[input.consumerKind, "consumer kind", 80], [input.consumerId, "consumer ID", 200], [input.relationKind, "relation kind", 80]] as const) {
      if (typeof value !== "string" || value.length < 1 || value.length > max) throw new AccountingError("accounting_validation", `QBO ${field} is invalid`);
    }
    const exists = await this.executor.query(
      `SELECT 1 FROM accounting_qbo_transaction_lines
       WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
         AND object_type=$5 AND object_id=$6 AND source_line_id=$7 AND source_version=$8`,
      [...base, source.version],
    );
    if (exists.rows.length === 0) throw new AccountingError("accounting_not_found", "QBO source line revision is not mirrored");
    await this.executor.query(
      `INSERT INTO accounting_qbo_source_line_links
        (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, source_version, consumer_kind, consumer_id, relation_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, line_id, source_version, consumer_kind, consumer_id)
       DO UPDATE SET relation_kind = EXCLUDED.relation_kind`,
      [...base, source.version, input.consumerKind, input.consumerId, input.relationKind],
    );
  }

  /**
   * Resolve payment facts from the immutable provider body and the mirrored
   * cash Account object. A CustomerRef or an AP account is never accepted as
   * the cash account or payee, and a missing Account mirror fails closed.
   */
  async readPaymentContext(query: FinancialSourceLineQuery): Promise<FinancialProviderPaymentContext | null> {
    const resolution = await this.resolveLine(query);
    if (!resolution || resolution.postingState !== "posted" || resolution.flow === "unknown") return null;
    const source = resolution.source;
    const object = await this.executor.query<ProviderSourceObjectRow>(
      `SELECT provider_body, provider_updated_at, object_version
         FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
          AND object_type=$5 AND object_id=$6 AND object_version=$7`,
      [...scopeParts(source), source.objectType, source.objectId, source.version],
    );
    const body = object.rows[0]?.provider_body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    let cashAccountObjectId: string | null = null;
    let payeeObjectId: string | null = null;
    let payeeObjectType: FinancialProviderPayeeType | null = null;
    let subtype: "Cash" | "Check" | "CreditCard" | "BillPayment" | "Deposit" | null = null;
    if (source.objectType === "Purchase") {
      cashAccountObjectId = providerReference(body, "AccountRef");
      // QBO Purchase.EntityRef is the vendor party even when the provider
      // omits an explicit Type field. Preserve an explicit type when present,
      // while keeping the fallback scoped to Purchase semantics.
      const payee = typedBodyReference(body, "EntityRef", "Vendor") ?? typedBodyReference(body, "VendorRef", "Vendor") ?? typedBodyReference(body, "CustomerRef", "Customer") ?? typedBodyReference(body, "EmployeeRef", "Employee");
      payeeObjectId = payee?.id ?? null;
      payeeObjectType = payee?.type ?? null;
      const value = (body as Record<string, unknown>).PaymentType;
      subtype = value === "Cash" || value === "Check" || value === "CreditCard" ? value : null;
      if (resolution.flow !== "outgoing" || resolution.lineRole !== "expense" || subtype === null) return null;
    } else if (source.objectType === "BillPayment") {
      cashAccountObjectId = nestedProviderReference(body, "CheckPayment", "BankAccountRef")
        ?? nestedProviderReference(body, "CreditCardPayment", "CCAccountRef")
        ?? providerReference(body, "BankAccountRef")
        ?? providerReference(body, "CCAccountRef")
        ?? providerReference(body, "AccountRef");
      const payee = typedBodyReference(body, "VendorRef", "Vendor") ?? typedBodyReference(body, "EntityRef");
      payeeObjectId = payee?.id ?? null;
      payeeObjectType = payee?.type ?? null;
      subtype = "BillPayment";
      if (resolution.flow !== "outgoing" || resolution.lineRole !== "payment_source") return null;
    } else if (source.objectType === "Deposit") {
      cashAccountObjectId = providerReference(body, "DepositToAccountRef") ?? providerReference(body, "AccountRef");
      const payee = typedDepositPayee(body, source.lineId);
      payeeObjectId = payee?.id ?? null;
      payeeObjectType = payee?.type ?? null;
      subtype = "Deposit";
      if (resolution.flow !== "incoming" || resolution.lineRole !== "receipt") return null;
    } else {
      return null;
    }
    if (!cashAccountObjectId || !payeeObjectId || !payeeObjectType || !subtype) return null;
    const account = await this.executor.query<ProviderSourceObjectRow>(
      `SELECT provider_body, provider_updated_at, object_version
         FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
          AND object_type='Account' AND object_id=$5 AND deleted_at IS NULL
        ORDER BY CASE WHEN object_version ~ '^[0-9]+$' THEN 0 ELSE 1 END,
                 CASE WHEN object_version ~ '^[0-9]+$' THEN length(object_version) ELSE 0 END DESC,
                 CASE WHEN object_version ~ '^[0-9]+$' THEN object_version ELSE '' END DESC,
                 provider_updated_at DESC NULLS LAST, received_at DESC LIMIT 1`,
      [...scopeParts(source).slice(0, 4), cashAccountObjectId],
    );
    const accountBody = account.rows[0]?.provider_body;
    if (!accountBody || typeof accountBody !== "object" || Array.isArray(accountBody)) return null;
    const accountType = (accountBody as Record<string, unknown>).AccountType;
    const acceptedAccount = typeof accountType === "string" && ["Bank", "Credit Card", "CashOnHand"].includes(accountType);
    if (!acceptedAccount) return null;
    let lineAccountType: string | null = null;
    let lineAccountSubType: string | null = null;
    if (resolution.accountObjectId) {
      const lineAccount = await this.executor.query<ProviderSourceObjectRow>(
        `SELECT provider_body, provider_updated_at, object_version
           FROM accounting_qbo_source_objects
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
            AND object_type='Account' AND object_id=$5 AND deleted_at IS NULL
          ORDER BY CASE WHEN object_version ~ '^[0-9]+$' THEN 0 ELSE 1 END,
                   CASE WHEN object_version ~ '^[0-9]+$' THEN length(object_version) ELSE 0 END DESC,
                   CASE WHEN object_version ~ '^[0-9]+$' THEN object_version ELSE '' END DESC,
                   provider_updated_at DESC NULLS LAST, received_at DESC LIMIT 1`,
        [...scopeParts(source).slice(0, 4), resolution.accountObjectId],
      );
      const lineBody = lineAccount.rows[0]?.provider_body;
      if (lineBody && typeof lineBody === "object" && !Array.isArray(lineBody)) {
        const record = lineBody as Record<string, unknown>;
        lineAccountType = typeof record.AccountType === "string" ? record.AccountType : null;
        const subtypeValue = record.AccountSubType ?? record.DetailType;
        lineAccountSubType = typeof subtypeValue === "string" ? subtypeValue : null;
      }
    }
    const purposeMapping = resolution.accountObjectId && resolution.postedOn
      ? await this.purposeMappings.readPurposeMapping({ scope: { provider: source.provider, organizationId: source.organizationId, legalEntityId: source.legalEntityId, environment: source.environment, realmId: source.realmId }, providerAccountId: resolution.accountObjectId, postedOn: resolution.postedOn })
      : null;
    const providerUpdatedAt = object.rows[0]?.provider_updated_at;
    const updated = providerUpdatedAt instanceof Date ? providerUpdatedAt.toISOString() : typeof providerUpdatedAt === "string" ? providerUpdatedAt : resolution.watermark.observedAt;
    const parsedUpdated = isoTimestampSchema.safeParse(updated);
    if (!parsedUpdated.success) return null;
    return {
      source,
      cashAccountObjectId,
      payeeObjectId,
      payeeObjectType,
      accountType: lineAccountType,
      accountSubType: lineAccountSubType,
      purpose: purposeMapping?.purpose ?? "unknown",
      purposeEvidence: purposeMapping ? "server_mapping" : "provider_account_unmapped",
      purposeMappedAt: purposeMapping?.reviewedAt ?? null,
      flow: subtype === "Deposit" ? "incoming" : "outgoing",
      amountCents: resolution.amountCents,
      currency: resolution.currency,
      postedOn: resolution.postedOn ?? (() => { throw new AccountingError("accounting_unavailable", "QBO payment is missing its posting date"); })(),
      postingState: resolution.postingState,
      subtype,
      providerUpdatedAt: parsedUpdated.data,
      watermark: resolution.watermark,
    };
  }

  /** Return provider Account classification for project-cost eligibility. */
  async readCostContext(query: FinancialSourceLineQuery): Promise<FinancialProviderCostContext | null> {
    const resolution = await this.resolveLine(query);
    if (!resolution || resolution.postingState !== "posted" || !resolution.accountObjectId) return null;
    const purposeMapping = resolution.postedOn
      ? await this.purposeMappings.readPurposeMapping({
          scope: {
            provider: resolution.source.provider,
            organizationId: resolution.source.organizationId,
            legalEntityId: resolution.source.legalEntityId,
            environment: resolution.source.environment,
            realmId: resolution.source.realmId,
          },
          providerAccountId: resolution.accountObjectId,
          postedOn: resolution.postedOn,
        })
      : null;
    // A dated purpose mapping proves the exact Account revision used for that
    // period. Read that revision for classification so a later provider
    // revision cannot rewrite historical cost context in place.
    const mappedAccountVersion = purposeMapping?.accountSourceVersion ?? null;
    const account = await this.executor.query<ProviderSourceObjectRow>(
      `SELECT provider_body, provider_updated_at, object_version
         FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
          AND object_type='Account' AND object_id=$5 AND deleted_at IS NULL
          AND ($6::varchar IS NULL OR object_version=$6)
        ORDER BY CASE WHEN object_version ~ '^[0-9]+$' THEN 0 ELSE 1 END,
                 CASE WHEN object_version ~ '^[0-9]+$' THEN length(object_version) ELSE 0 END DESC,
                 CASE WHEN object_version ~ '^[0-9]+$' THEN object_version ELSE '' END DESC,
                 provider_updated_at DESC NULLS LAST, received_at DESC LIMIT 1`,
      [...scopeParts(resolution.source).slice(0, 4), resolution.accountObjectId, mappedAccountVersion],
    );
    const body = account.rows[0]?.provider_body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const accountType = (body as Record<string, unknown>).AccountType;
    const accountSubType = (body as Record<string, unknown>).AccountSubType ?? (body as Record<string, unknown>).DetailType;
    if (typeof accountType !== "string" || accountType.length === 0 || (accountSubType !== null && accountSubType !== undefined && typeof accountSubType !== "string")) return null;
    const classification = purposeMapping?.purpose === "capitalized_cost" ? "capitalized_cost"
      : accountType === "Expense" ? "expense"
      : accountType === "Cost of Goods Sold" ? "cogs"
          : accountType === "Bank" || accountType === "Credit Card" ? "bank"
            : accountType === "Equity" ? "equity"
              : /Liability|Payable|Receivable/.test(accountType) ? "liability"
                : /Income/.test(accountType) ? "income"
                  : /Asset/.test(accountType) ? "other_asset" : "unknown";
    const providerUpdatedAt = account.rows[0]?.provider_updated_at;
    const updated = providerUpdatedAt instanceof Date ? providerUpdatedAt.toISOString() : typeof providerUpdatedAt === "string" ? providerUpdatedAt : resolution.watermark.observedAt;
    const parsedUpdated = isoTimestampSchema.safeParse(updated);
    if (!parsedUpdated.success || !resolution.postedOn) return null;
    return {
      source: resolution.source,
      accountObjectId: resolution.accountObjectId,
      accountType,
      accountSubType: accountSubType === null || accountSubType === undefined ? null : accountSubType,
      classification,
      eligible: classification === "expense" || classification === "cogs" || classification === "capitalized_cost",
      amountCents: resolution.amountCents,
      currency: resolution.currency,
      postedOn: resolution.postedOn,
      postingState: resolution.postingState,
      providerUpdatedAt: parsedUpdated.data,
      watermark: resolution.watermark,
    };
  }

  async summarizeStream(scopeInput: QuickBooksConnectionScope, streamInput: string): Promise<QboCoverageSummary> {
    const scope = scopeOf(scopeInput);
    const stream = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.:-]*$/).parse(streamInput);
    if (stream === "accounts" || stream === "customers") {
      const result = await this.executor.query<{ object_count: unknown; latest_watermark: unknown }>(
        `SELECT COUNT(DISTINCT object_id) AS object_count, MAX(provider_updated_at) AS latest_watermark
           FROM accounting_qbo_source_objects
          WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND deleted_at IS NULL`,
        [...scopeParts(scope), stream === "accounts" ? "Account" : "Customer"],
      );
      const row = result.rows[0];
      const latest = row?.latest_watermark instanceof Date ? row.latest_watermark.toISOString() : typeof row?.latest_watermark === "string" ? row.latest_watermark : null;
      return { objectCount: Number(row?.object_count ?? 0), transactionCount: 0, lineCount: 0, coveredFrom: null, coveredThrough: null, latestWatermark: latest };
    }
    const receivable = /^receivables\.(invoice|creditmemo|payment|salesreceipt|refundreceipt|journalentry)$/.exec(stream);
    if (receivable) {
      const objectType = ({ invoice: "Invoice", creditmemo: "CreditMemo", payment: "Payment", salesreceipt: "SalesReceipt", refundreceipt: "RefundReceipt", journalentry: "JournalEntry" } as const)[receivable[1] as "invoice"];
      const result = await this.executor.query<{ object_count: unknown; transaction_count: unknown; line_count: unknown; covered_from: unknown; covered_through: unknown; latest_watermark: unknown }>(
        `SELECT COUNT(DISTINCT o.object_id) AS object_count,
                COUNT(DISTINCT d.object_id) FILTER (WHERE d.mirror_state = 'current') AS transaction_count,
                (SELECT COUNT(*) FROM accounting_qbo_receivable_effects e
                   JOIN accounting_qbo_receivable_documents cd ON cd.organization_id=e.organization_id AND cd.legal_entity_id=e.legal_entity_id AND cd.environment=e.environment
                    AND cd.realm_id=e.realm_id AND cd.object_type=e.object_type AND cd.object_id=e.object_id AND cd.object_version=e.object_version AND cd.mirror_state='current'
                  WHERE e.organization_id=$1 AND e.legal_entity_id=$2 AND e.environment=$3 AND e.realm_id=$4 AND e.object_type=$5) AS line_count,
                MIN(d.txn_date) AS covered_from, MAX(d.txn_date) AS covered_through, MAX(o.provider_updated_at) AS latest_watermark
           FROM accounting_qbo_source_objects o
           LEFT JOIN accounting_qbo_receivable_documents d ON d.organization_id=o.organization_id AND d.legal_entity_id=o.legal_entity_id AND d.environment=o.environment
            AND d.realm_id=o.realm_id AND d.object_type=o.object_type AND d.object_id=o.object_id
          WHERE o.organization_id=$1 AND o.legal_entity_id=$2 AND o.environment=$3 AND o.realm_id=$4 AND o.object_type=$5 AND o.deleted_at IS NULL`,
        [...scopeParts(scope), objectType],
      );
      const row = result.rows[0];
      const toDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value.slice(0, 10) : null;
      const latest = row?.latest_watermark instanceof Date ? row.latest_watermark.toISOString() : typeof row?.latest_watermark === "string" ? row.latest_watermark : null;
      return { objectCount: Number(row?.object_count ?? 0), transactionCount: Number(row?.transaction_count ?? 0), lineCount: Number(row?.line_count ?? 0), coveredFrom: toDate(row?.covered_from), coveredThrough: toDate(row?.covered_through), latestWatermark: latest };
    }
    const match = /^transactions\.(purchase|bill|billpayment|deposit|journalentry)$/.exec(stream);
    if (!match) throw new AccountingError("accounting_validation", "QBO coverage stream is unsupported");
    const entity = match[1] === "billpayment" ? "BillPayment" : match[1][0].toUpperCase() + match[1].slice(1);
    const result = await this.executor.query<{ object_count: unknown; transaction_count: unknown; line_count: unknown; covered_from: unknown; covered_through: unknown; latest_watermark: unknown }>(
      `SELECT COUNT(DISTINCT o.object_id) AS object_count, COUNT(DISTINCT t.object_id) AS transaction_count,
              COUNT(DISTINCT (b.object_id || ':' || b.line_id)) AS line_count,
              MIN(b.posted_on) AS covered_from, MAX(b.posted_on) AS covered_through,
              MAX(o.provider_updated_at) AS latest_watermark
         FROM accounting_qbo_source_objects o
         LEFT JOIN accounting_qbo_transactions t ON t.organization_id=o.organization_id AND t.legal_entity_id=o.legal_entity_id AND t.environment=o.environment AND t.realm_id=o.realm_id AND t.object_type=o.object_type AND t.object_id=o.object_id
         LEFT JOIN accounting_qbo_source_line_balances b ON b.organization_id=o.organization_id AND b.legal_entity_id=o.legal_entity_id AND b.environment=o.environment AND b.realm_id=o.realm_id AND b.object_type=o.object_type AND b.object_id=o.object_id
        WHERE o.organization_id=$1 AND o.legal_entity_id=$2 AND o.environment=$3 AND o.realm_id=$4 AND o.object_type=$5 AND o.deleted_at IS NULL`,
      [...scopeParts(scope), entity],
    );
    const row = result.rows[0];
    const toDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value : null;
    const latest = row?.latest_watermark instanceof Date ? row.latest_watermark.toISOString() : typeof row?.latest_watermark === "string" ? row.latest_watermark : null;
    return { objectCount: Number(row?.object_count ?? 0), transactionCount: Number(row?.transaction_count ?? 0), lineCount: Number(row?.line_count ?? 0), coveredFrom: toDate(row?.covered_from), coveredThrough: toDate(row?.covered_through), latestWatermark: latest };
  }

  async listProviderMirrors(scopeInput: QuickBooksConnectionScope, kind: QboProviderMirrorKind): Promise<readonly QboProviderMirror[]> {
    const scope = scopeOf(scopeInput);
    const objectType = ({ accounts: "Account", vendors: "Vendor", customers: "Customer", employees: "Employee" } as const)[kind];
    if (!objectType) throw new AccountingError("accounting_validation", "Provider mirror kind is unsupported");
    const result = await this.executor.query<{
      object_id: unknown;
      object_version: unknown;
      provider_body: unknown;
      provider_updated_at: unknown;
      }>(
      `SELECT DISTINCT ON (o.object_id) o.object_id, o.object_version,
              COALESCE(ob.provider_body, o.provider_body) AS provider_body,
              COALESCE(ob.provider_updated_at, o.provider_updated_at) AS provider_updated_at
         FROM accounting_qbo_source_objects o
         LEFT JOIN LATERAL (
           SELECT provider_body, provider_updated_at
             FROM accounting_qbo_named_observations n
            WHERE n.organization_id=o.organization_id AND n.legal_entity_id=o.legal_entity_id
              AND n.environment=o.environment AND n.realm_id=o.realm_id
              AND n.object_type=o.object_type AND n.object_id=o.object_id AND n.object_version=o.object_version
              AND n.material_conflict=false
            ORDER BY n.observed_at DESC, n.observation_order DESC
            LIMIT 1
         ) ob ON true
        WHERE o.organization_id=$1 AND o.legal_entity_id=$2 AND o.environment=$3 AND o.realm_id=$4
          AND o.object_type=$5 AND o.deleted_at IS NULL
        ORDER BY o.object_id,
                 CASE WHEN o.object_version ~ '^[0-9]+$' THEN 0 ELSE 1 END,
                 CASE WHEN o.object_version ~ '^[0-9]+$' THEN length(o.object_version) ELSE 0 END DESC,
                 CASE WHEN o.object_version ~ '^[0-9]+$' THEN o.object_version ELSE '' END DESC,
                 COALESCE(ob.provider_updated_at, o.provider_updated_at) DESC NULLS LAST, o.received_at DESC`,
      [...scopeParts(scope), objectType],
    );
    return result.rows.map(row => {
      const body = row.provider_body && typeof row.provider_body === "object" && !Array.isArray(row.provider_body) ? row.provider_body as Record<string, unknown> : {};
      const firstLast = [body.GivenName, body.MiddleName, body.FamilyName].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ").trim();
      const displayName = [body.DisplayName, body.CompanyName, body.Name, firstLast].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
      const providerObjectId = stringValue(row.object_id, "provider mirror ID", 200);
      const version = stringValue(row.object_version, "provider mirror version", 120);
      const providerUpdatedAt = row.provider_updated_at === null || row.provider_updated_at === undefined
        ? null
        : timestampValue(row.provider_updated_at, "provider mirror update timestamp");
      return {
        kind,
        objectType,
        providerObjectId,
        displayName: displayName ?? `${objectType} ${providerObjectId}`,
        accountType: objectType === "Account" && typeof body.AccountType === "string" ? body.AccountType : null,
        accountSubType: objectType === "Account"
          ? (() => {
              const value = body.AccountSubType ?? body.DetailType;
              return typeof value === "string" ? value : null;
            })()
          : null,
        active: body.Active !== false,
        version,
        providerUpdatedAt,
      };
    }).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.providerObjectId.localeCompare(right.providerObjectId));
  }

  async recordDeletion(input: QboDeletionInput): Promise<QboDeletionResult> {
    const scope = scopeOf(input.scope);
    if (!/^[A-Z][A-Za-z0-9_]{0,119}$/.test(input.objectType)) throw new AccountingError("accounting_validation", "QBO object type is invalid");
    const objectId = stringValue(input.objectId, "object ID", 200);
    const observedAt = isoTimestampSchema.parse(input.observedAt);
    const sourceDeletedAt = input.sourceDeletedAt ? isoTimestampSchema.parse(new Date(input.sourceDeletedAt).toISOString()) : null;
    const identity = [...scopeParts(scope), input.objectType, objectId];
    const live = await this.executor.query<{ object_version: string; provider_updated_at: unknown }>(
      `SELECT object_version, provider_updated_at FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6
        ORDER BY provider_updated_at DESC NULLS LAST, received_at DESC`,
      identity,
    );
    const newest = live.rows.map(row => String(row.object_version)).sort(versionCompare).at(-1) ?? null;
    const lastKnownVersion = input.lastKnownVersion === undefined || input.lastKnownVersion === null ? newest : stringValue(input.lastKnownVersion, "object version", 120);
    // A deletion notice older than a revision we already mirrored as live is stale.
    const liveRows = await this.executor.query<{ object_version: string; provider_updated_at: unknown }>(
      `SELECT object_version, provider_updated_at FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND deleted_at IS NULL`,
      identity,
    );
    const newerLive = liveRows.rows.some(row => {
      if (input.lastKnownVersion && versionCompare(String(row.object_version), input.lastKnownVersion) > 0) return true;
      const updated = row.provider_updated_at instanceof Date ? row.provider_updated_at.toISOString() : typeof row.provider_updated_at === "string" ? new Date(row.provider_updated_at).toISOString() : null;
      return sourceDeletedAt !== null && updated !== null && updated > sourceDeletedAt;
    });
    if (newerLive) return { applied: false, tombstoneCreated: false, retiredLineCount: 0, blockedAllocationCount: 0, blockedAllocatedCents: centsFromBigInt(BigInt(0)) };
    // Tombstones are append-only. Add a row when there is none, when explicit
    // provider evidence follows an inferred (full-replay) deletion, or when
    // the object was live again (restored or re-created) before this
    // deletion; otherwise the notice repeats the current tombstone.
    const latest = await this.executor.query<{ tombstone_seq: unknown; detected_via: string }>(
      `SELECT tombstone_seq, detected_via FROM accounting_qbo_deletion_tombstones
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6
        ORDER BY tombstone_seq DESC LIMIT 1`,
      identity,
    );
    const current = latest.rows[0];
    const currentSeq = current ? Number(current.tombstone_seq) : 0;
    const supersedesInferred = current !== undefined && current.detected_via === "full_replay" && input.detectedVia !== "full_replay";
    const deletedAgain = current !== undefined && liveRows.rows.length > 0;
    const tombstone = current === undefined || supersedesInferred || deletedAgain
      ? await this.executor.query(
        `INSERT INTO accounting_qbo_deletion_tombstones
          (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, last_known_version, source_deleted_at, detected_via, detected_at, tombstone_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING RETURNING object_id`,
        [...identity, lastKnownVersion, sourceDeletedAt, input.detectedVia, observedAt, currentSeq + 1],
      )
      : { rows: [] };
    await this.executor.query(
      `UPDATE accounting_qbo_source_objects SET deleted_at = $7
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND deleted_at IS NULL`,
      [...identity, sourceDeletedAt ?? observedAt],
    );
    const allocations = await this.executor.query<{ allocation_count: unknown; allocated_cents: unknown }>(
      `SELECT COUNT(*) AS allocation_count, COALESCE(SUM(amount_cents), 0) AS allocated_cents
         FROM accounting_qbo_source_line_allocations
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND amount_cents > 0`,
      identity,
    );
    const retired = await this.executor.query<{ line_id: string }>(
      `UPDATE accounting_qbo_source_line_balances b
          SET is_current = false, posting_state = 'voided', settlement_state = 'voided', settled_on = NULL, settled_amount_cents = NULL,
              allocation_blocked = b.allocation_blocked OR EXISTS (
                SELECT 1 FROM accounting_qbo_source_line_allocations a
                 WHERE a.organization_id=b.organization_id AND a.legal_entity_id=b.legal_entity_id AND a.environment=b.environment
                   AND a.realm_id=b.realm_id AND a.object_type=b.object_type AND a.object_id=b.object_id AND a.line_id=b.line_id AND a.amount_cents > 0),
              updated_at = $7
        WHERE b.organization_id=$1 AND b.legal_entity_id=$2 AND b.environment=$3 AND b.realm_id=$4 AND b.object_type=$5 AND b.object_id=$6
          AND (b.is_current OR b.posting_state <> 'voided')
        RETURNING b.line_id`,
      [...identity, observedAt],
    );
    // A full replay is the provider's complete live-object read. Once the
    // absent object has been tombstoned, its missing-from-replay exception is
    // resolved as a confirmed deletion so the same object cannot keep the
    // stream partial forever. The row remains append-only audit evidence.
    // Explicit webhook/CDC evidence follows the same resolution path.
    await this.executor.query(
      `UPDATE accounting_qbo_sync_exceptions SET resolved_at = $7, resolved_version = $8, last_seen_at = GREATEST(last_seen_at, $7)
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND resolved_at IS NULL`,
      [...identity, observedAt, lastKnownVersion ?? "deleted"],
    );
    return {
      applied: true,
      tombstoneCreated: tombstone.rows.length === 1,
      retiredLineCount: retired.rows.length,
      blockedAllocationCount: Number(allocations.rows[0]?.allocation_count ?? 0),
      blockedAllocatedCents: centsValue(allocations.rows[0]?.allocated_cents ?? "0", "blocked allocation"),
    };
  }

  async readDeletionState(scopeInput: QuickBooksConnectionScope, objectType: string, objectId: string): Promise<QboDeletionState | null> {
    const scope = scopeOf(scopeInput);
    const result = await this.executor.query<{ detected_via: string; last_known_version: string | null; source_deleted_at: unknown; detected_at: unknown; deleted: boolean }>(
      `SELECT t.detected_via, t.last_known_version, t.source_deleted_at, t.detected_at,
              NOT EXISTS (
                SELECT 1 FROM accounting_qbo_source_objects o
                 WHERE o.organization_id=t.organization_id AND o.legal_entity_id=t.legal_entity_id AND o.environment=t.environment
                   AND o.realm_id=t.realm_id AND o.object_type=t.object_type AND o.object_id=t.object_id AND o.deleted_at IS NULL
              ) AS deleted
         FROM accounting_qbo_deletion_tombstones t
        WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.realm_id=$4 AND t.object_type=$5 AND t.object_id=$6
        ORDER BY t.tombstone_seq DESC LIMIT 1`,
      [...scopeParts(scope), objectType, objectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      deleted: row.deleted === true,
      detectedVia: row.detected_via === "webhook" || row.detected_via === "cdc" ? row.detected_via : "full_replay",
      lastKnownVersion: row.last_known_version ?? null,
      sourceDeletedAt: row.source_deleted_at === null || row.source_deleted_at === undefined ? null : timestampValue(row.source_deleted_at, "tombstone deletion time"),
      detectedAt: timestampValue(row.detected_at, "tombstone detection time"),
    };
  }

  async restoreInferredDeletion(scopeInput: QuickBooksConnectionScope, objectType: string, objectId: string, version: string): Promise<boolean> {
    const scope = scopeOf(scopeInput);
    const identity = [...scopeParts(scope), objectType, objectId];
    const state = await this.readDeletionState(scopeInput, objectType, objectId);
    if (!state?.deleted || state.detectedVia !== "full_replay") return false;
    const restored = await this.executor.query(
      `UPDATE accounting_qbo_source_objects SET deleted_at = NULL
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND object_version=$7
        RETURNING id`,
      [...identity, version],
    );
    if (!restored.rows.length) return false;
    await this.executor.query(
      `UPDATE accounting_qbo_source_line_balances b
          SET is_current = true, posting_state = l.posting_state, settlement_state = l.settlement_state,
              settled_on = l.settled_on, settled_amount_cents = l.settled_amount_cents, updated_at = $8
         FROM accounting_qbo_transaction_lines l
        WHERE b.organization_id=$1 AND b.legal_entity_id=$2 AND b.environment=$3 AND b.realm_id=$4 AND b.object_type=$5 AND b.object_id=$6
          AND b.latest_version = $7
          AND l.organization_id=b.organization_id AND l.legal_entity_id=b.legal_entity_id AND l.environment=b.environment AND l.realm_id=b.realm_id
          AND l.object_type=b.object_type AND l.object_id=b.object_id AND l.source_line_id=b.line_id AND l.source_version=b.latest_version`,
      [...identity, version, this.now().toISOString()],
    );
    return true;
  }

  async countActiveTombstones(scopeInput: QuickBooksConnectionScope, window: QboDeletionWindow = {}): Promise<number> {
    const scope = scopeOf(scopeInput);
    const since = window.detectedFrom === undefined ? null : isoTimestampSchema.parse(new Date(window.detectedFrom).toISOString());
    const before = window.detectedBefore === undefined ? null : isoTimestampSchema.parse(new Date(window.detectedBefore).toISOString());
    const result = await this.executor.query<{ count: unknown }>(
      `SELECT COUNT(DISTINCT (t.object_type, t.object_id)) AS count FROM accounting_qbo_deletion_tombstones t
        WHERE t.organization_id=$1 AND t.legal_entity_id=$2 AND t.environment=$3 AND t.realm_id=$4
          AND ($5::timestamptz IS NULL OR t.detected_at >= $5::timestamptz)
          AND ($6::timestamptz IS NULL OR t.detected_at < $6::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM accounting_qbo_source_objects o
             WHERE o.organization_id=t.organization_id AND o.legal_entity_id=t.legal_entity_id AND o.environment=t.environment
               AND o.realm_id=t.realm_id AND o.object_type=t.object_type AND o.object_id=t.object_id AND o.deleted_at IS NULL)`,
      [...scopeParts(scope), since, before],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async recordSyncException(input: QboSyncExceptionInput): Promise<void> {
    const scope = scopeOf(input.scope);
    const stream = z.string().trim().min(1).max(120).regex(STREAM_PATTERN).parse(input.stream);
    if (!/^[A-Z][A-Za-z0-9_]{0,119}$/.test(input.objectType)) throw new AccountingError("accounting_validation", "QBO object type is invalid");
    const objectId = stringValue(input.objectId, "object ID", 200);
    const version = input.version === null ? null : stringValue(input.version, "object version", 120);
    const observedAt = isoTimestampSchema.parse(input.observedAt);
    const reasons = exceptionReasons(input.reasons);
    // An exception is reopened whenever the provider still returns an object
    // that cannot be mirrored, whatever happened to earlier revisions.
    await this.executor.query(
      `INSERT INTO accounting_qbo_sync_exceptions
        (organization_id, legal_entity_id, environment, realm_id, stream, object_type, object_id, object_version, exception_kind, reasons, first_seen_at, last_seen_at, resolved_at, resolved_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11,NULL,NULL)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, stream, object_type, object_id)
       DO UPDATE SET object_version = EXCLUDED.object_version, exception_kind = EXCLUDED.exception_kind, reasons = EXCLUDED.reasons,
         first_seen_at = CASE WHEN accounting_qbo_sync_exceptions.resolved_at IS NULL THEN accounting_qbo_sync_exceptions.first_seen_at ELSE EXCLUDED.first_seen_at END,
         last_seen_at = GREATEST(accounting_qbo_sync_exceptions.last_seen_at, EXCLUDED.last_seen_at),
         resolved_at = NULL, resolved_version = NULL`,
      [...scopeParts(scope), stream, input.objectType, objectId, version, input.kind, JSON.stringify(reasons), observedAt],
    );
  }

  async resolveSyncException(input: QboSyncExceptionResolution): Promise<boolean> {
    const scope = scopeOf(input.scope);
    const stream = z.string().trim().min(1).max(120).regex(STREAM_PATTERN).parse(input.stream);
    const objectId = stringValue(input.objectId, "object ID", 200);
    const version = stringValue(input.version, "object version", 120);
    const observedAt = isoTimestampSchema.parse(input.observedAt);
    const open = await this.executor.query<{ object_version: string | null; exception_kind: string }>(
      `SELECT object_version, exception_kind FROM accounting_qbo_sync_exceptions
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND stream=$5 AND object_type=$6 AND object_id=$7
          AND resolved_at IS NULL FOR UPDATE`,
      [...scopeParts(scope), stream, input.objectType, objectId],
    );
    const row = open.rows[0];
    if (!row) return false;
    // An overlapping re-read of an older revision cannot clear an exception
    // raised by a newer one.
    if (row.exception_kind === "unsupported" && row.object_version !== null && versionCompare(version, row.object_version) < 0) return false;
    await this.executor.query(
      `UPDATE accounting_qbo_sync_exceptions SET resolved_at = $8, resolved_version = $9, last_seen_at = GREATEST(last_seen_at, $8)
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND stream=$5 AND object_type=$6 AND object_id=$7 AND resolved_at IS NULL`,
      [...scopeParts(scope), stream, input.objectType, objectId, observedAt, version],
    );
    return true;
  }

  async listOpenSyncExceptions(scopeInput: QuickBooksConnectionScope, streamInput?: string): Promise<readonly QboSyncException[]> {
    const scope = scopeOf(scopeInput);
    const stream = streamInput === undefined ? null : z.string().trim().min(1).max(120).regex(STREAM_PATTERN).parse(streamInput);
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT stream, object_type, object_id, object_version, exception_kind, reasons, first_seen_at, last_seen_at
         FROM accounting_qbo_sync_exceptions
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND resolved_at IS NULL
          AND ($5::varchar IS NULL OR stream = $5)
        ORDER BY stream, object_type, object_id`,
      [...scopeParts(scope), stream],
    );
    return result.rows.map(row => ({
      stream: String(row.stream),
      objectType: String(row.object_type),
      objectId: String(row.object_id),
      version: row.object_version === null || row.object_version === undefined ? null : String(row.object_version),
      kind: row.exception_kind === "missing_from_full_replay" ? "missing_from_full_replay" as const : "unsupported" as const,
      reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : typeof row.reasons === "string" ? (JSON.parse(row.reasons) as unknown[]).map(String) : [],
      firstSeenAt: timestampValue(row.first_seen_at, "exception first seen"),
      lastSeenAt: timestampValue(row.last_seen_at, "exception last seen"),
    }));
  }

  async listMirroredObjectIds(scopeInput: QuickBooksConnectionScope, objectType: string): Promise<readonly string[]> {
    const scope = scopeOf(scopeInput);
    if (!/^[A-Z][A-Za-z0-9_]{0,119}$/.test(objectType)) throw new AccountingError("accounting_validation", "QBO object type is invalid");
    const result = await this.executor.query<{ object_id: string }>(
      `SELECT DISTINCT object_id FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND deleted_at IS NULL`,
      [...scopeParts(scope), objectType],
    );
    return result.rows.map(row => String(row.object_id));
  }

  private async openExceptionCounts(scope: FinancialSourceScope, stream?: string): Promise<Map<string, number>> {
    const result = await this.executor.query<{ stream: string; open_count: unknown }>(
      `SELECT stream, COUNT(*) AS open_count FROM accounting_qbo_sync_exceptions
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND resolved_at IS NULL
          AND ($5::varchar IS NULL OR stream = $5)
        GROUP BY stream`,
      [...scopeParts(scope), stream ?? null],
    );
    return new Map(result.rows.map(row => [String(row.stream), Number(row.open_count ?? 0)]));
  }

  async recordCoverage(input: QboCoverageInput): Promise<void> {
    const scope = scopeOf(input.scope);
    const stream = z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.:-]*$/).parse(input.stream);
    if (input.evidence === "live_provider_readback" && input.status === "unavailable") throw new AccountingError("accounting_validation", "Unavailable coverage cannot claim live provider evidence");
    const watermark = input.watermark?.value ?? null;
    await this.executor.query(
      `INSERT INTO accounting_qbo_coverage
        (organization_id, legal_entity_id, environment, realm_id, stream, status, evidence, basis, watermark, covered_from, covered_through, observed_at, object_count, transaction_count, line_count, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, stream)
       DO UPDATE SET status=EXCLUDED.status, evidence=EXCLUDED.evidence, basis=EXCLUDED.basis, watermark=EXCLUDED.watermark,
         covered_from=EXCLUDED.covered_from, covered_through=EXCLUDED.covered_through, observed_at=EXCLUDED.observed_at,
         object_count=EXCLUDED.object_count, transaction_count=EXCLUDED.transaction_count, line_count=EXCLUDED.line_count, reason=EXCLUDED.reason`,
      [...scopeParts(scope), stream, input.status, input.evidence, input.basis, watermark, input.coveredFrom, input.coveredThrough, input.observedAt, input.objectCount, input.transactionCount, input.lineCount, input.reason ?? null],
    );
    await this.executor.query(`DELETE FROM accounting_qbo_coverage_gaps WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND stream=$5`, [...scopeParts(scope), stream]);
    for (const gap of input.missingIntervals ?? []) {
      await this.executor.query(`INSERT INTO accounting_qbo_coverage_gaps (organization_id,legal_entity_id,environment,realm_id,stream,gap_from,gap_through) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...scopeParts(scope), stream, isoDateSchema.parse(gap.from), isoDateSchema.parse(gap.through)]);
    }
  }

  async readCoverage(scopeInput: FinancialSourceScope, streamInput?: string): Promise<FinancialSourceCoverage> {
    const scope = financialSourceScopeSchema.parse(scopeInput);
    const stream = streamInput === undefined ? undefined : z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.:-]*$/).parse(streamInput);
    if (stream) {
      const rows = await this.executor.query<CoverageRow>(`SELECT stream,status,evidence,basis,watermark,covered_from,covered_through,observed_at,object_count,transaction_count,line_count,reason FROM accounting_qbo_coverage WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND stream=$5`, [...scopeParts(scope), stream]);
      const gaps = await this.executor.query<{ gap_from: string; gap_through: string }>(`SELECT gap_from,gap_through FROM accounting_qbo_coverage_gaps WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND stream=$5 ORDER BY gap_from`, [...scopeParts(scope), stream]);
      const openCount = (await this.openExceptionCounts(scope, stream)).get(stream) ?? 0;
      const coverage = markStaleCoverage(mapCoverage(scope, rows.rows[0] ?? null, gaps.rows.map((gap) => ({ from: dateValue(gap.gap_from, "gap start"), through: dateValue(gap.gap_through, "gap end") })), stream), this.now());
      if (openCount > 0 && coverage.status === "complete") {
        const openReason = `${openCount} QBO object(s) have unresolved mirror exceptions`;
        // Keep machine-readable replay proofs when the coverage is projected
        // to partial because a per-object hold is still open. Replacing the
        // reason would make a later CDC run mistake a pre-migration global
        // checkpoint for a verified baseline and skip the required replay.
        const reason = coverage.reason ? `${coverage.reason}; ${openReason}` : openReason;
        return financialSourceCoverageSchema.parse({ ...coverage, status: "partial", reason });
      }
      return coverage;
    }
    // The aggregate describes the cash/payables mirror that its existing
    // readers depend on. Receivable and customer streams are read per stream
    // by the receivables read service, so their gaps do not degrade it.
    const isAggregateStream = (name: string) => !name.startsWith("receivables.") && name !== "customers";
    const allRows = await this.executor.query<CoverageRow>(`SELECT stream,status,evidence,basis,watermark,covered_from,covered_through,observed_at,object_count,transaction_count,line_count,reason FROM accounting_qbo_coverage WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 ORDER BY stream`, scopeParts(scope));
    const rows = { rows: allRows.rows.filter(row => isAggregateStream(String(row.stream))) };
    const required = ["accounts", "transactions.purchase", "transactions.bill", "transactions.billpayment", "transactions.deposit", "transactions.journalentry"];
    if (rows.rows.length === 0) return mapCoverage(scope, null, [], "aggregate");
    const byStream = new Map(rows.rows.map(row => [String(row.stream), row]));
    const missing = required.filter(name => !byStream.has(name));
    const openExceptions = Array.from((await this.openExceptionCounts(scope)).entries()).filter(([name]) => isAggregateStream(name)).reduce((sum, [, count]) => sum + count, 0);
    const partial = openExceptions > 0 || rows.rows.some(row => row.status !== "complete" || row.evidence !== "live_provider_readback" || coverageIsStale(timestampValue(row.observed_at, "coverage timestamp"), this.now()));
    const status = missing.length > 0 || partial ? "partial" : "complete";
    const values = rows.rows.map(row => row.watermark === null || row.watermark === undefined ? null : String(row.watermark)).filter((value): value is string => value !== null);
    const observed = rows.rows.map(row => timestampValue(row.observed_at, "coverage timestamp")).sort();
    const coveredFrom = rows.rows.map(row => row.covered_from).filter((value): value is string => value !== null && value !== undefined).map(value => dateValue(value, "coverage start")).sort()[0] ?? null;
    const coveredThroughValues = rows.rows.map(row => row.covered_through).filter((value): value is string => value !== null && value !== undefined).map(value => dateValue(value, "coverage end")).sort();
    const stale = rows.rows.some(row => coverageIsStale(timestampValue(row.observed_at, "coverage timestamp"), this.now()));
    const reason = [...(missing.length ? [`Missing required QBO streams: ${missing.join(", ")}`] : []), ...(openExceptions > 0 ? [`${openExceptions} QBO object(s) have unresolved mirror exceptions`] : []), ...(stale ? ["QBO provider coverage is stale; a successful sync has not been observed within the CDC lookback window"] : []), ...(partial ? ["One or more QBO streams have partial or non-live evidence"] : [])].join("; ") || null;
    return financialSourceCoverageSchema.parse({
      scope, stream: "aggregate", status, evidence: rows.rows.every(row => row.evidence === "live_provider_readback") ? "live_provider_readback" : "unverified", basis: "source_transactions",
      watermark: values.length ? { value: values.sort().at(-1)!, observedAt: observed.at(-1)! } : null,
      coveredFrom, coveredThrough: coveredThroughValues.at(-1) ?? null, observedAt: observed.at(-1)!,
      objectCount: rows.rows.reduce((sum, row) => sum + Number(row.object_count ?? 0), 0), transactionCount: rows.rows.reduce((sum, row) => sum + Number(row.transaction_count ?? 0), 0), lineCount: rows.rows.reduce((sum, row) => sum + Number(row.line_count ?? 0), 0),
      missingIntervals: [], reason,
    });
  }

  async resolveLine(query: FinancialSourceLineQuery): Promise<FinancialSourceLineResolution | null> {
    const scope = financialSourceScopeSchema.parse(query.scope);
    if (!query.objectType || !query.objectId || !query.lineId) throw new AccountingError("accounting_validation", "Exact QBO object and line identity are required");
    const values: unknown[] = [...scopeParts(scope), query.objectType, query.objectId, query.lineId];
    const versionClause = query.version ? " AND l.source_version = $8" : " AND l.source_version = b.latest_version";
    if (query.version) values.push(query.version);
    const result = await this.executor.query<LineRow>(
      `SELECT b.*, l.id, l.transaction_id, l.source_object_id, l.line_number, l.source_version, l.transaction_type AS line_transaction_type,
          l.direction AS line_direction, l.flow AS line_flow, l.line_role AS line_line_role, l.amount_cents AS line_amount_cents,
          l.currency AS line_currency, l.posting_state AS line_posting_state, l.posted_on AS line_posted_on,
          l.settlement_state AS line_settlement_state, l.settled_on AS line_settled_on, l.settled_amount_cents AS line_settled_amount_cents,
          l.watermark AS line_watermark, l.updated_at AS line_updated_at,
          l.account_object_id AS line_account_object_id, l.counterparty_object_id AS line_counterparty_object_id, l.description
       FROM accounting_qbo_source_line_balances b
       JOIN accounting_qbo_transaction_lines l ON l.organization_id=b.organization_id AND l.legal_entity_id=b.legal_entity_id
         AND l.environment=b.environment AND l.realm_id=b.realm_id AND l.object_type=b.object_type AND l.object_id=b.object_id AND l.source_line_id=b.line_id${versionClause}
       WHERE b.organization_id=$1 AND b.legal_entity_id=$2 AND b.environment=$3 AND b.realm_id=$4 AND b.object_type=$5 AND b.object_id=$6 AND b.line_id=$7
         AND b.is_current = true AND b.latest_version = l.source_version`,
      values,
    );
    const row = result.rows[0];
    if (!row) return null;
    const merged = { ...row, transaction_type: row.line_transaction_type, flow: row.line_flow, line_role: row.line_line_role, account_object_id: row.line_account_object_id, counterparty_object_id: row.line_counterparty_object_id };
    return mapResolution(merged);
  }

  async hasPurchaseCredits(scopeInput: FinancialSourceScope, through?: IsoDate | string): Promise<boolean> {
    const scope = financialSourceScopeSchema.parse(scopeInput);
    const values: unknown[] = [...scopeParts(scope)];
    const clauses = [
      "b.organization_id=$1", "b.legal_entity_id=$2", "b.environment=$3", "b.realm_id=$4",
      "b.object_type='Purchase'", "b.transaction_type='Purchase'", "b.is_current=true", "b.posting_state='posted'",
      "b.allocation_blocked=false", "b.line_role IN ('expense','payable')",
      "b.direction='credit'", "b.flow='incoming'",
      `b.amount_cents > COALESCE((
        SELECT SUM(a.amount_cents)
          FROM accounting_qbo_source_line_allocations a
         WHERE a.organization_id=b.organization_id
           AND a.legal_entity_id=b.legal_entity_id
           AND a.environment=b.environment
           AND a.realm_id=b.realm_id
           AND a.object_type=b.object_type
           AND a.object_id=b.object_id
           AND a.line_id=b.line_id
      ), 0)`,
    ];
    if (through !== undefined) {
      const date = isoDateSchema.parse(through);
      values.push(date);
      clauses.push("b.posted_on <= $" + String(values.length));
    }
    // Keep this probe narrow: only candidate Purchase credit lines are read,
    // then each candidate is checked through the same current provider Account
    // classification path used by project actuals. This avoids treating a
    // transfer, blocked/deleted line, or unmapped account as a project-cost
    // refund while still failing closed when a real eligible credit remains.
    const result = await this.executor.query<{
      object_id: unknown;
      line_id: unknown;
      latest_version: unknown;
      amount_cents: unknown;
      currency: unknown;
      posted_on: unknown;
      account_object_id: unknown;
    }>(
      "SELECT b.object_id,b.line_id,b.latest_version,b.amount_cents,b.currency,b.posted_on,b.account_object_id FROM accounting_qbo_source_line_balances b WHERE " + clauses.join(" AND "),
      values,
    );
    for (const row of result.rows) {
      const objectId = stringValue(row.object_id, "Purchase credit object ID", 200);
      const lineId = stringValue(row.line_id, "Purchase credit line ID", 200);
      const latestVersion = stringValue(row.latest_version, "Purchase credit source version", 120);
      const context = await this.readCostContext({ scope, objectType: "Purchase", objectId, lineId });
      if (!context
        || context.source.provider !== scope.provider
        || context.source.organizationId !== scope.organizationId
        || context.source.legalEntityId !== scope.legalEntityId
        || context.source.environment !== scope.environment
        || context.source.realmId !== scope.realmId
        || context.source.objectType !== "Purchase"
        || context.source.objectId !== objectId
        || context.source.lineId !== lineId
        || context.source.version !== latestVersion
        || context.postingState !== "posted"
        || !context.eligible
        || (context.classification !== "expense" && context.classification !== "cogs" && context.classification !== "capitalized_cost")
        || context.amountCents !== centsValue(row.amount_cents, "Purchase credit amount")
        || context.currency !== currencyCodeSchema.parse(row.currency)
        || context.postedOn !== dateValue(row.posted_on, "Purchase credit posted date")
        || context.accountObjectId !== nullableString(row.account_object_id, "Purchase credit account", 200)) continue;
      return true;
    }
    return false;
  }

  async listTransactions(query: { scope: FinancialSourceScope; from?: string; through?: string; limit?: number; cursor?: string }) {
    const scope = financialSourceScopeSchema.parse(query.scope);
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AccountingError("accounting_validation", "Accounting line limit is invalid");
    const values: unknown[] = [...scopeParts(scope)];
    const clauses = ["b.organization_id=$1", "b.legal_entity_id=$2", "b.environment=$3", "b.realm_id=$4", "b.is_current=true", "l.source_version=b.latest_version"];
    if (query.from) { isoDateSchema.parse(query.from); values.push(query.from); clauses.push(`b.posted_on >= $${values.length}`); }
    if (query.through) { isoDateSchema.parse(query.through); values.push(query.through); clauses.push(`b.posted_on <= $${values.length}`); }
    const cursor = query.cursor ? decodeLineCursor(query.cursor, scope, query.from, query.through) : null;
    if (cursor) {
      const timestampPosition = values.length + 1;
      values.push(cursor.updatedAt, cursor.objectType, cursor.objectId, cursor.lineId);
      clauses.push(`(b.updated_at,b.object_type,b.object_id,b.line_id) > ($${timestampPosition},$${timestampPosition + 1},$${timestampPosition + 2},$${timestampPosition + 3})`);
    }
    values.push(limit + 1);
    const rows = await this.executor.query<LineRow>(
      `SELECT b.*, l.id, l.transaction_id, l.source_object_id, l.line_number, l.source_version, l.transaction_type AS line_transaction_type,
          l.direction AS line_direction, l.flow AS line_flow, l.line_role AS line_line_role, l.amount_cents AS line_amount_cents,
          l.currency AS line_currency, l.posting_state AS line_posting_state, l.posted_on AS line_posted_on,
          l.settlement_state AS line_settlement_state, l.settled_on AS line_settled_on, l.settled_amount_cents AS line_settled_amount_cents,
          l.watermark AS line_watermark, l.updated_at AS line_updated_at,
          l.account_object_id AS line_account_object_id, l.counterparty_object_id AS line_counterparty_object_id, l.description
       FROM accounting_qbo_source_line_balances b JOIN accounting_qbo_transaction_lines l
         ON l.organization_id=b.organization_id AND l.legal_entity_id=b.legal_entity_id AND l.environment=b.environment AND l.realm_id=b.realm_id
         AND l.object_type=b.object_type AND l.object_id=b.object_id AND l.source_line_id=b.line_id
       WHERE ${clauses.join(" AND ")} ORDER BY b.updated_at,b.object_type,b.object_id,b.line_id LIMIT $${values.length}`,
      values,
    );
    const visibleRows = rows.rows.slice(0, limit);
    const items = visibleRows.map((row) => mapResolution({ ...row, transaction_type: row.line_transaction_type, flow: row.line_flow, line_role: row.line_line_role, account_object_id: row.line_account_object_id, counterparty_object_id: row.line_counterparty_object_id }));
    const coverage = await this.readCoverage(scope);
    const last = visibleRows.at(-1);
    const nextCursor = rows.rows.length <= limit || !last ? null : encodeLineCursor({
      scopeKey: financialSourceScopeKey(scope), from: query.from ?? null, through: query.through ?? null,
      updatedAt: timestampValue(last.updated_at, "line cursor"), objectType: stringValue(last.object_type, "cursor object type", 120), objectId: stringValue(last.object_id, "cursor object ID", 200), lineId: stringValue(last.line_id, "cursor line ID", 200),
    });
    return { items, nextCursor, coverage };
  }

  private async balanceOn(executor: RentOpsQueryExecutor, source: FinancialSourceReference): Promise<FinancialSourceAllocationBalance> {
    const parsed = financialSourceReferenceSchema.parse(source);
    const result = await executor.query<BalanceRow>(`SELECT * FROM accounting_qbo_source_line_balances WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND line_id=$7`, baseParts(parsed));
    const row = result.rows[0];
    if (!row) throw new AccountingError("accounting_not_found", "QBO source line is not mirrored");
    const allocated = await executor.query<{ allocated_cents: unknown }>(`SELECT COALESCE(SUM(amount_cents),0) AS allocated_cents FROM accounting_qbo_source_line_allocations WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND line_id=$7`, baseParts(parsed));
    const lineAmount = centsValue(row.amount_cents, "line amount");
    const allocatedAmount = centsValue(allocated.rows[0]?.allocated_cents ?? "0", "allocated amount");
    const rawAvailable = BigInt(lineAmount) - BigInt(allocatedAmount);
    const overAllocated = rawAvailable < BigInt(0) ? -rawAvailable : BigInt(0);
    const available = rawAvailable < BigInt(0) ? BigInt(0) : rawAvailable;
    const currentSource = { ...parsed, version: stringValue(row.latest_version, "latest source version", 120) };
    return { source: currentSource, lineAmountCents: lineAmount, allocatedCents: allocatedAmount, availableCents: centsFromBigInt(available), overAllocatedCents: centsFromBigInt(overAllocated), currency: currencyCodeSchema.parse(row.currency) };
  }

  async getBalance(source: FinancialSourceReference): Promise<FinancialSourceAllocationBalance> {
    return this.balanceOn(this.executor, source);
  }

  private async reserveOn(executor: RentOpsQueryExecutor, request: FinancialSourceAllocationRequest, release: boolean): Promise<FinancialSourceAllocationBalance> {
    const source = financialSourceReferenceSchema.parse(request.source);
    const amount = centsSchema.parse(request.amountCents);
    if (BigInt(amount) <= BigInt(0)) throw new AccountingError("accounting_validation", "Allocation amount must be positive");
    const currency = currencyCodeSchema.parse(request.currency);
    for (const [value, field] of [[request.consumerKind, "consumer kind"], [request.consumerId, "consumer ID"]] as const) {
      if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new AccountingError("accounting_validation", `Allocation ${field} is invalid`);
    }
    const base = baseParts(source);
    const line = await executor.query<BalanceRow>(`SELECT * FROM accounting_qbo_source_line_balances WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND line_id=$7 FOR UPDATE`, base);
    if (!line.rows[0]) throw new AccountingError("accounting_not_found", "QBO source line is not mirrored");
    const row = line.rows[0];
    const latestVersion = stringValue(row.latest_version, "latest source version", 120);
    if (!release && (source.version !== latestVersion || row.is_current !== true || row.allocation_blocked === true || row.posting_state !== "posted")) {
      throw new AccountingError("accounting_allocation_exceeded", "QBO source line is no longer eligible for a new allocation");
    }
    if (currencyCodeSchema.parse(row.currency) !== currency) throw new AccountingError("accounting_validation", "Allocation currency does not match the source line");
    const existing = await executor.query<{ amount_cents: unknown }>(`SELECT amount_cents FROM accounting_qbo_source_line_allocations WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND line_id=$7 AND consumer_kind=$8 AND consumer_id=$9 FOR UPDATE`, [...base, request.consumerKind, request.consumerId]);
    const existingAmount = centsValue(existing.rows[0]?.amount_cents ?? "0", "existing allocation");
    const allocated = await executor.query<{ allocated_cents: unknown }>(`SELECT COALESCE(SUM(amount_cents),0) AS allocated_cents FROM accounting_qbo_source_line_allocations WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND line_id=$7`, base);
    const total = release
      ? BigInt(centsValue(allocated.rows[0]?.allocated_cents ?? "0", "allocated amount")) - BigInt(amount)
      : BigInt(centsValue(allocated.rows[0]?.allocated_cents ?? "0", "allocated amount")) - BigInt(existingAmount) + BigInt(amount);
    if (total < BigInt(0) || (!release && total > BigInt(centsValue(row.amount_cents, "line amount")))) throw new AccountingError("accounting_allocation_exceeded", "QBO source line allocation exceeds its available balance");
    if (release) {
      const remaining = BigInt(existingAmount) - BigInt(amount);
      if (remaining < BigInt(0)) throw new AccountingError("accounting_allocation_exceeded", "QBO source line release exceeds the consumer allocation");
      if (remaining === BigInt(0)) await executor.query(`DELETE FROM accounting_qbo_source_line_allocations WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND line_id=$7 AND consumer_kind=$8 AND consumer_id=$9`, [...base, request.consumerKind, request.consumerId]);
      else await executor.query(`UPDATE accounting_qbo_source_line_allocations SET source_version=$10,amount_cents=$11,updated_at=$12 WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type=$5 AND object_id=$6 AND line_id=$7 AND consumer_kind=$8 AND consumer_id=$9`, [...base, request.consumerKind, request.consumerId, latestVersion, remaining.toString(), this.now().toISOString()]);
    } else {
      await executor.query(`INSERT INTO accounting_qbo_source_line_allocations (organization_id,legal_entity_id,environment,realm_id,object_type,object_id,line_id,source_version,consumer_kind,consumer_id,amount_cents,currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (organization_id,legal_entity_id,environment,realm_id,object_type,object_id,line_id,consumer_kind,consumer_id) DO UPDATE SET source_version=EXCLUDED.source_version,amount_cents=EXCLUDED.amount_cents,currency=EXCLUDED.currency,updated_at=now()`, [...base, source.version, request.consumerKind, request.consumerId, amount, currency]);
    }
    return this.balanceOn(executor, source);
  }

  async reserve(request: FinancialSourceAllocationRequest): Promise<FinancialSourceAllocationBalance> {
    if (this.bound) return this.reserveOn(this.executor, request, false);
    if (!this.executor.transaction) throw new AccountingError("accounting_configuration", "QBO allocation reserve requires transaction support");
    return this.executor.transaction((transaction) => new PostgresQboAccountingMirrorStore(transaction, true, this.now).reserveOn(transaction, request, false));
  }

  async release(request: FinancialSourceAllocationRequest): Promise<FinancialSourceAllocationBalance> {
    if (this.bound) return this.reserveOn(this.executor, request, true);
    if (!this.executor.transaction) throw new AccountingError("accounting_configuration", "QBO allocation release requires transaction support");
    return this.executor.transaction((transaction) => new PostgresQboAccountingMirrorStore(transaction, true, this.now).reserveOn(transaction, request, true));
  }
}

export function createQboAccountingMirrorStore(executor: RentOpsQueryExecutor, now?: () => Date): QboAccountingMirrorStore {
  return new PostgresQboAccountingMirrorStore(executor, false, now);
}

export type { SourceObjectInput };
