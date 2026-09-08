import type {
  Cents,
  ImportMappingException,
  ImportEntityType,
  RentManagerImportInput,
  RentManagerImportResult,
  RentOpsActivityEvent,
  RentOpsApplicationAnswerOccurrence,
  RentOpsApplicationHistoryActivity,
  RentOpsApplicationHistoryBlocker,
  RentOpsApplicationHistoryDocument,
  RentOpsApplicationHistorySnapshot,
  RentOpsApplicationInterest,
  RentOpsApplicationHouseholdMember,
  RentOpsApplicationParticipant,
  RentOpsApplicationRecord,
  RentOpsApplicationRequirement,
  RentOpsApplicationRequirementOccurrence,
  RentOpsApplicationTemplateDefinition,
  RentOpsApplicationTemplateFieldDefinition,
  RentOpsApplicationTemplateSectionDefinition,
  RentOpsHistoricalApplication,
  RentOpsProspect,
  RentOpsDocument,
  RentOpsDocumentObjectBinding,
  RentOpsHouseholdMembership,
  RentOpsImportRun,
  RentOpsLeaseTerm,
  RentOpsLedgerTransaction,
  RentOpsPaymentAllocation,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsSourceRecord,
  RentOpsSubsidyContract,
  RentOpsSubsidyTenant,
  RentOpsSubsidyPayment,
  RentOpsTenancy,
  RentOpsUnit,
  RentManagerRawRecord,
  RentManagerFinancialSemanticCrosswalk,
  RentOpsChargeDefinition,
  IsoDate,
} from "../../../shared/rent-ops-contracts";
import { isoDateSchema } from "../../../shared/rent-ops-contracts";
import { canonicalJson, sha256 } from "../export/hash";
import { approvedSupplementEvidenceValid, normalizeRentManagerExport } from "../export/normalizer";
import type { ExportEnvelope } from "../export/types";
import { mapRentManagerExport, moneyControlCounts, reconcileRentManagerImport, type RentOpsTargetIdFactory } from "./rm-mapper";
import type { RentManagerTargetIdentityOptions } from "../../../shared/rent-ops-contracts";
import { inspectDatabaseTarget as inspectDatabaseTargetReadOnly } from "./database-audit";
import { assertValidSnapshot, ledgerBalanceSign, validateSnapshot } from "../domain/invariants";
import { assertValidApplicationHistory } from "../domain/application-history";
import { projectApplicationHistoryForImport } from "../application-history/projection";
import { RENT_OPS_MIGRATION_REQUIRED_TABLES, RENT_OPS_SCHEMA_VERSION } from "../persistence";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import { restrictedSourcePayloadBlockingReasons } from "./restricted-source-payloads";
import type { RestrictedParityPersistenceInput } from "./restricted-parity-persistence";
import type { VerifiedDocumentArchiveInput } from "../services/service";

export const APPLY_RENT_OPS_STAGING_PHRASE = "APPLY_RENT_OPS_STAGING_ONCE";
export const APPLY_RENT_OPS_PRODUCTION_PHRASE = "APPLY_RENT_OPS_PRODUCTION_ONCE";
export const KNOWN_LIVE_PRIMARY_FINGERPRINT = "a4a44f11352d8b2f";
export const RENT_OPS_IMPORT_SYSTEM = "rent_manager";
export const RENT_OPS_MIGRATION_VERSION = RENT_OPS_SCHEMA_VERSION;
export const APPROVED_RM_NORMALIZER_ARTIFACT = "approved-rm-normalizer/v1";

const REDACTED_FINGERPRINT_RE = /^[a-f0-9]{16}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
// The affirmative gate is process-wide so a nonce cannot be replayed by a
// second importer instance in the same operator process.
const consumedGateNonces = new Set<string>();

export interface BackupAttestation {
  verified: true;
  attestationId?: string;
  reference?: string;
  targetFingerprint: string;
  verifiedAt: string;
}

export interface AffirmativeApplyGate {
  phrase: typeof APPLY_RENT_OPS_STAGING_PHRASE | typeof APPLY_RENT_OPS_PRODUCTION_PHRASE;
  nonce: string;
}

export interface ImportControlTotals {
  counts?: Partial<Record<string, number>>;
  totalsCents?: Record<string, number>;
  /** Known/unknown/invalid source-money state is bound independently of totals. */
  unknownCounts?: Record<string, number>;
  invalidMoneyCounts?: Record<string, number>;
  balancesCents?: Record<string, number>;
  netLedgerCents?: number;
  netLedgerBalanceCents?: number;
  hap?: { agencyObligationCents: number; tenantObligationCents: number };
}

export interface DatabaseTargetInspection {
  redactedFingerprint: string;
  migrationVersion: number;
  migrationChecksum: string;
  requiredTables: number;
  migrationChecksums?: Readonly<Record<number, string>>;
  migrationChainValid?: boolean;
}

export interface RentManagerExportEnvelope {
  version?: string;
  payload?: RentManagerImportInput & Record<string, unknown>;
  input?: RentManagerImportInput;
  sourceManifestHash?: string;
  archiveEnvelopeSha256?: string;
  artifactObservationOn?: IsoDate;
  manifest?: { archiveEnvelopeSha256?: string; manifestSha256?: string; artifactObservationOn?: IsoDate };
  controls?: ImportControlTotals;
  controlTotals?: ImportControlTotals;
}

/**
 * Redacted, descriptor-verified proof that a derivative supplement was
 * approved by the external trust root.  The receipt contains digests only;
 * answer values and the external receipt identifier never cross this seam.
 */
export interface VerifiedSupplementReceiptBinding {
  version: "rm-restricted-supplement-verification-receipt/v1";
  sourceRunId: string;
  parentEnvelopeSha256: string;
  parentManifestSha256: string;
  derivativeEnvelopeSha256: string;
  derivativeManifestSha256: string;
  supplementSha256: string;
  attestationSha256: string;
  rowSetSha256: string;
  externalVerificationIdHash: string;
  provenanceSha256: string;
}

export interface ApprovedImportProvenance {
  archiveEnvelopeSha256: string;
  manifestSha256: string;
  normalizedRowsSha256: string;
  controlsSha256: string;
  mappedRowsSha256: string;
  restrictedRowsSha256: string;
  artifactBindingSha256: string;
  normalizerVersion: string;
  normalizationReportSha256: string;
  sourceRunId: string;
  registryHash: string;
  artifactObservationOn: IsoDate;
  targetIdentity?: RentManagerTargetIdentityOptions;
  /** Exact redacted external-verification receipt bound at archive read time. */
  verifiedSupplementReceiptSha256?: string;
}

/**
 * Adapter output for the eventual root-owned normalizer. The normalized result
 * is the only object eligible for normal-table persistence; the original input
 * is carried solely so the restricted writer can archive canonical RM JSON in
 * its separate role-limited surface.
 */
export interface ApprovedPersistenceImportArtifact {
  artifactType: typeof APPROVED_RM_NORMALIZER_ARTIFACT;
  normalizedResult: RentManagerImportResult;
  restrictedSourceInput: RentManagerExportEnvelope;
  controls: ImportControlTotals;
  provenance: ApprovedImportProvenance;
}

export interface ApprovedImportBinding {
  archiveEnvelopeSha256: string;
  manifestSha256: string;
  normalizedRowsSha256: string;
  controlsSha256: string;
  mappedRowsSha256: string;
  restrictedRowsSha256: string;
  normalizerVersion: string;
  normalizationReportSha256: string;
  sourceRunId: string;
  registryHash: string;
  artifactObservationOn: IsoDate;
  targetIdentity?: RentManagerTargetIdentityOptions;
  verifiedSupplementReceiptSha256?: string;
}

function canonicalExportEnvelope(value: RentManagerExportEnvelope | ExportEnvelope): ExportEnvelope {
  const record = value as unknown as Record<string, unknown>;
  return {
    version: "rm-export/v2",
    runId: String(record.runId ?? ""),
    source: record.source as ExportEnvelope["source"],
    createdAt: String(record.createdAt ?? ""),
    ...(typeof record.artifactObservationOn === "string" ? { artifactObservationOn: record.artifactObservationOn as ExportEnvelope["artifactObservationOn"] } : {}),
    payload: (record.payload ?? record.input ?? {}) as ExportEnvelope["payload"],
    documentBinaries: Array.isArray(record.documentBinaries)
      ? record.documentBinaries as ExportEnvelope["documentBinaries"]
      : [],
    ...(record.supplementEvidence && typeof record.supplementEvidence === "object" && !Array.isArray(record.supplementEvidence)
      ? { supplementEvidence: record.supplementEvidence as ExportEnvelope["supplementEvidence"] }
      : {}),
  };
}

/** Digest of the exact envelope bytes represented by a restricted artifact. */
export function approvedArchiveEnvelopeSha256(value: RentManagerExportEnvelope | ExportEnvelope): string {
  return sha256(canonicalJson(canonicalExportEnvelope(value)));
}

export function verifiedSupplementReceiptSha256(value: VerifiedSupplementReceiptBinding): string {
  return sha256(canonicalJson(value));
}

/**
 * Validate the receipt only against the exact derivative envelope crossing
 * the importer boundary.  The archive reader is responsible for establishing
 * the external trust root and the parent archive binding with same-descriptor
 * reads; this boundary rejects receipt/envelope swaps and self-attested rows.
 */
export function verifiedSupplementReceiptReasons(
  envelope: RentManagerExportEnvelope | ExportEnvelope,
  receipt: VerifiedSupplementReceiptBinding | undefined,
  expectedManifestSha256?: string,
): string[] {
  const record = envelope as unknown as Record<string, unknown>;
  const evidence = isRecord(record.supplementEvidence) ? record.supplementEvidence : undefined;
  const payload = isRecord(record.payload) ? record.payload : isRecord(record.input) ? record.input : {};
  const answerRowsPresent = Array.isArray(payload.applicationAnswerRecords) && payload.applicationAnswerRecords.length > 0;
  const receiptRequired = Boolean(evidence) || answerRowsPresent;
  if (!receipt) return receiptRequired ? ["verified_supplement_receipt_missing"] : [];
  const reasons: string[] = [];
  const digestFields: Array<keyof VerifiedSupplementReceiptBinding> = [
    "parentEnvelopeSha256",
    "parentManifestSha256",
    "derivativeEnvelopeSha256",
    "derivativeManifestSha256",
    "supplementSha256",
    "attestationSha256",
    "rowSetSha256",
    "externalVerificationIdHash",
    "provenanceSha256",
  ];
  if (receipt.version !== "rm-restricted-supplement-verification-receipt/v1") reasons.push("verified_supplement_receipt_version_invalid");
  if (!receipt.sourceRunId || receipt.sourceRunId !== String(record.runId ?? "")) reasons.push("verified_supplement_receipt_run_mismatch");
  for (const field of digestFields) {
    if (!SHA256_RE.test(String(receipt[field] ?? ""))) reasons.push(`verified_supplement_receipt_${safeKey(field)}_invalid`);
  }
  let envelopeSha256: string | undefined;
  try { envelopeSha256 = approvedArchiveEnvelopeSha256(envelope); } catch { /* reported below */ }
  if (!envelopeSha256 || receipt.derivativeEnvelopeSha256 !== envelopeSha256) reasons.push("verified_supplement_receipt_envelope_mismatch");
  const manifestSha256 = expectedManifestSha256
    ?? (isRecord(record.manifest) && typeof record.manifest.manifestSha256 === "string" ? record.manifest.manifestSha256 : undefined);
  if (!manifestSha256 || receipt.derivativeManifestSha256 !== manifestSha256) reasons.push("verified_supplement_receipt_manifest_mismatch");
  if (!evidence) {
    reasons.push("verified_supplement_evidence_missing");
  } else {
    if (String(evidence.sourceRunId ?? "") !== receipt.sourceRunId) reasons.push("verified_supplement_evidence_run_mismatch");
    if (String(evidence.supplementSha256 ?? "") !== receipt.supplementSha256) reasons.push("verified_supplement_evidence_digest_mismatch");
    if (String(evidence.attestationSha256 ?? "") !== receipt.attestationSha256) reasons.push("verified_supplement_attestation_digest_mismatch");
    if (String(evidence.rowSetSha256 ?? "") !== receipt.rowSetSha256) reasons.push("verified_supplement_row_set_digest_mismatch");
  }
  return Array.from(new Set(reasons)).sort();
}

/** Digest of the exact normalized source collections, never exposed in reports. */
export function approvedNormalizedRowsSha256(value: RentManagerImportInput): string {
  return sha256(canonicalJson(value));
}

/** Digest of the exact operator control totals/counts bound to an approval. */
export function approvedControlsSha256(value: ImportControlTotals): string {
  return sha256(canonicalJson(value));
}

function controlMoneyCents(record: RentManagerRawRecord, ...keys: string[]): number {
  const key = keys.find((candidate) => record[candidate] !== undefined && record[candidate] !== null && record[candidate] !== "");
  if (!key) return 0;
  const normalized = String(record[key]).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return 0;
  const [whole, fraction = ""] = normalized.split(".");
  const centsInput = key.toLowerCase().includes("cents");
  if ((centsInput && fraction.length > 0) || (!centsInput && fraction.length > 2)) return 0;
  const amount = centsInput ? Number(whole) : Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function controlMoneyTotal(records: readonly RentManagerRawRecord[] | undefined, ...keys: string[]): number {
  return (records ?? []).reduce((total, record) => total + controlMoneyCents(record, ...keys), 0);
}

/** Recomputes approval controls from the exact normalized source, not from the caller-supplied controls object. */
function controlsForApprovedSource(input: RentManagerImportInput): ImportControlTotals {
  const money = moneyControlCounts(input);
  return {
    counts: {
      property: input.properties?.length ?? 0,
      unit: input.units?.length ?? 0,
      person: (input.tenants?.length ?? 0) + (input.contacts?.length ?? 0),
      tenancy: input.leases?.length ?? 0,
      lease_term: input.leaseTerms?.length ?? 0,
      charge_definition: input.chargeTypes?.length ?? 0,
      recurring_schedule: input.recurringSchedules?.length ?? 0,
      ledger_transaction: (input.charges?.length ?? 0) + (input.payments?.length ?? 0) + (input.credits?.length ?? 0),
      payment_allocation: input.allocations?.length ?? 0,
      deposit: input.deposits?.length ?? 0,
      subsidy: (input.subsidies?.length ?? 0) + (input.hap?.length ?? 0),
      subsidy_tenant: input.subsidyTenants?.length ?? 0,
      subsidy_payment: input.subsidyPayments?.length ?? 0,
      application: input.applications?.length ?? 0,
      document: input.documents?.length ?? 0,
      activity: input.activities?.length ?? 0,
    },
    totalsCents: {
      charges: money.knownTotals.charges ?? controlMoneyTotal(input.charges, "amountCents", "amount"),
      payments: money.knownTotals.payments ?? controlMoneyTotal(input.payments, "amountCents", "amount"),
      credits: money.knownTotals.credits ?? controlMoneyTotal(input.credits, "amountCents", "amount"),
      allocations: money.knownTotals.allocations ?? controlMoneyTotal(input.allocations, "amountCents", "amount"),
      deposits: money.knownTotals.deposits ?? controlMoneyTotal(input.deposits, "amountHeldCents", "amount", "balance"),
    },
    hap: {
      agencyObligationCents: money.knownTotals.hapAgencyObligationCents ?? controlMoneyTotal(input.subsidies, "agencyObligationCents", "agencyAmountCents", "agencyAmount"),
      tenantObligationCents: money.knownTotals.hapTenantObligationCents ?? controlMoneyTotal(input.subsidies, "tenantObligationCents", "tenantAmountCents", "tenantAmount"),
    },
    unknownCounts: money.unknownCounts,
    invalidMoneyCounts: money.invalidCounts,
  };
}

/**
 * Digest of mapped business rows and their source/error ledger. Including the
 * import run makes a changed mode, run timestamp, or exception set fail closed.
 */
export function approvedMappedRowsSha256(value: RentManagerImportResult): string {
  return sha256(canonicalJson({
    snapshot: value.snapshot,
    sourceRecords: value.sourceRecords,
    importRun: value.importRun,
    exceptions: value.exceptions,
  }));
}

/**
 * Digest of the restricted raw rows and binary descriptors only. Wrapper
 * metadata is deliberately excluded so this binds the exact rows the
 * restricted writer will receive without putting their values in a report.
 */
export function approvedRestrictedRowsSha256(value: RentManagerExportEnvelope): string {
  const record = value as unknown as Record<string, unknown>;
  const payload = (record.payload ?? record.input ?? {}) as Record<string, unknown>;
  const collections = Object.entries(payload)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, rows]) => ({ name, rows }));
  const documentBinaries = Array.isArray(record.documentBinaries)
    ? record.documentBinaries
    : [];
  return sha256(canonicalJson({ collections, documentBinaries }));
}

/** Digest that makes all artifact component digests part of one approval binding. */
export function approvedArtifactBindingSha256(value: ApprovedImportBinding): string {
  return sha256(canonicalJson({
    artifactType: APPROVED_RM_NORMALIZER_ARTIFACT,
    ...value,
  }));
}

export type PersistenceImportInput = RentManagerImportResult | RentManagerImportInput | RentManagerExportEnvelope | ApprovedPersistenceImportArtifact;

/**
 * Root-owned seam for the restricted RM archive. Raw source JSON deliberately
 * never becomes part of RentOpsSnapshot or rent_ops_source_records.raw_metadata.
 * The seam is reserved for a root-owned normalizer adapter. Raw input is kept
 * in memory only; this importer never routes it to a normal snapshot/source
 * table and fails apply closed until that adapter supplies an approved result.
 */
export interface RestrictedSourcePayloadPersistenceContext {
  input: RentManagerImportInput | RentManagerExportEnvelope;
  importRun: RentOpsImportRun;
  sourceRecords: readonly RentOpsSourceRecord[];
  sourceManifestHash?: string;
}

export type RestrictedSourcePayloadWriter = (
  executor: RentOpsQueryExecutor,
  context: RestrictedSourcePayloadPersistenceContext,
) => Promise<void>;

export interface RestrictedParityPersistenceContext {
  input: RestrictedParityPersistenceInput;
  importRun: RentOpsImportRun;
  sourceRecords: readonly RentOpsSourceRecord[];
}

export type RestrictedParityPersistenceWriter = (
  executor: RentOpsQueryExecutor,
  context: RestrictedParityPersistenceContext,
) => Promise<void>;

/**
 * Import-only adapter for the storage service's verified RM binary path.  The
 * executor is the already-open import transaction; a production adapter must
 * bind the returned object in that transaction rather than opening a second
 * connection.  Raw bytes are carried only in memory and never in evidence.
 */
export interface RestrictedVerifiedDocumentTransfer {
  /**
   * The storage adapter writes/verifies the immutable object using its
   * dedicated upload-writer identity, then returns the exact document row and
   * object binding that the importer must persist through `executor`.  Keeping
   * the result explicit prevents the mapper's archive path from being treated
   * as an operational storage key and keeps the DB binding in the import
   * transaction.
   */
  transferVerifiedDocument(input: VerifiedDocumentArchiveInput, executor: RentOpsQueryExecutor): Promise<RestrictedVerifiedDocumentTransferResult>;
}

export interface RestrictedVerifiedDocumentTransferResult {
  readonly document: RentOpsDocument;
  readonly binding: RentOpsDocumentObjectBinding;
}

/** Redacted manual-review evidence when a verified object outlives a failed DB binding. */
export interface RestrictedDocumentTransferOrphanEvidence {
  status: "orphaned";
  reason: "database_binding_failed";
  sourceBinaryIdSha256: string;
  importRunIdSha256: string;
  sourceSystemSha256: string;
  sourceCollectionSha256: string;
  checksumSha256: string;
  sizeBytes: number;
}

/**
 * Structural binding for the independent archive-read receipt.  The runner
 * owns the concrete receipt type; keeping this boundary structural avoids a
 * persistence/import cycle and keeps the importer from reading archive files.
 */
export interface RestrictedArchiveAuditReceiptBinding {
  readonly version: "rm-restricted-archive-receipt/v1";
  readonly sourceRunId: string;
  readonly envelopeSha256: string;
  readonly manifestSha256: string;
  readonly canonicalEnvelopeSha256: string;
  readonly canonicalManifestSha256: string;
  readonly checkpointSha256: string;
  readonly coverageSha256: string;
  readonly pageFileSetSha256: string;
  readonly pageFileCount: number;
  readonly binaryDescriptorDigestSha256: string;
  readonly fileSetSha256: string;
}

export interface PersistenceImporterOptions {
  mode?: "dry_run" | "apply";
  targetClassification?: "staging" | "production" | "unclassified";
  expectedDatabaseFingerprint?: string;
  /**
   * Operator-supplied fingerprints for targets that are forbidden to mutate.
   * Apply requires this policy to be present and non-empty; the known live
   * primary fingerprint below is always denied in addition to this list.
   */
  forbiddenDatabaseFingerprints?: readonly string[];
  /** Compatibility field; it is never used as proof of target identity. */
  actualDatabaseFingerprint?: string;
  backupAttestation?: BackupAttestation;
  expectedMigrationChecksum?: string;
  /** Compatibility field; the applied schema row is authoritative. */
  renderedMigrationChecksum?: string;
  affirmativeGate?: AffirmativeApplyGate;
  controls?: ImportControlTotals;
  /**
   * Root may inject a writer after adding the role-restricted raw-payload table
   * and an approved normalizer adapter. Raw input/envelopes remain blocked by
   * normalization_required until that adapter exists; dry runs never invoke
   * this writer and remain zero-write.
   */
  restrictedSourcePayloadWriter?: RestrictedSourcePayloadWriter;
  /**
   * The parity input is built by the archive boundary from checkpoint-listed
   * page files, never by re-walking the lossy assembled envelope.  The
   * callback runs after mapping so the current import-run binding is known.
   */
  restrictedParityPersistenceInput?: RestrictedParityPersistenceInput | ((context: Omit<RestrictedParityPersistenceContext, "input">) => RestrictedParityPersistenceInput | Promise<RestrictedParityPersistenceInput>);
  restrictedParityPersistenceWriter?: RestrictedParityPersistenceWriter;
  /** Independent no-follow archive receipt required for restricted apply. */
  restrictedArchiveAuditReceipt?: RestrictedArchiveAuditReceiptBinding;
  /** Exact verified RM binaries are transferred only in apply mode. */
  restrictedVerifiedDocumentInputs?: readonly VerifiedDocumentArchiveInput[];
  restrictedVerifiedDocumentTransfer?: RestrictedVerifiedDocumentTransfer;
  restrictedDocumentOrphanSink?: (evidence: RestrictedDocumentTransferOrphanEvidence) => Promise<void> | void;
  /** Unit/integration tests only. Production can never bypass provenance. */
  testOnlyAllowUnprovenancedMappedResult?: boolean;
  now?: Date;
  /** Explicit keyed target identity. Required for v3 production replay. */
  targetIdFactory?: RentOpsTargetIdFactory;
  targetIdentity?: RentManagerTargetIdentityOptions;
  /** Descriptor-verified external supplement receipt supplied by the archive runner. */
  verifiedSupplementReceipt?: VerifiedSupplementReceiptBinding;
  /** Executes only read-only target inspection queries. */
  inspectDatabaseTarget?: (executor: RentOpsQueryExecutor) => Promise<DatabaseTargetInspection>;
}

export interface PersistenceImportCounts {
  properties: number;
  units: number;
  people: number;
  applications: number;
  tenancies: number;
  householdMemberships: number;
  leaseTerms: number;
  chargeDefinitions: number;
  recurringSchedules: number;
  ledgerTransactions: number;
  paymentAllocations: number;
  securityDeposits: number;
  subsidyContracts: number;
  subsidyTenants: number;
  subsidyPayments: number;
  applicationHouseholdMembers: number;
  applicationRequirements: number;
  documents: number;
  activityEvents: number;
  sourceRecords: number;
  importRuns: number;
  /** v9 immutable application-history row counts. */
  prospects?: number;
  applicationHistory?: number;
  applicationInterests?: number;
  applicationParticipants?: number;
  applicationRequirementOccurrences?: number;
  applicationTemplateDefinitions?: number;
  applicationTemplateSections?: number;
  applicationTemplateFields?: number;
  applicationAnswerOccurrences?: number;
  applicationHistoryDocuments?: number;
  applicationHistoryActivities?: number;
  applicationHistoryBlockers?: number;
  applicationHistoryAggregates?: number;
}

export interface PersistenceImportTotals {
  chargesCents: Cents;
  paymentsCents: Cents;
  creditsCents: Cents;
  allocationsCents: Cents;
  depositsCents: Cents;
  hapAgencyObligationCents: Cents;
  hapTenantObligationCents: Cents;
  /** Authoritative raw signed ledger control from ledgerBalanceSign. */
  netLedgerCents: Cents;
  /** Compatibility alias; equal to netLedgerCents for this import snapshot. */
  netLedgerBalanceCents: Cents;
}

export interface PersistenceImportSummary {
  mode: "dry_run" | "apply";
  importRunId: string;
  sourceManifestHash?: string;
  wouldWrite: boolean;
  committed: boolean;
  counts: PersistenceImportCounts;
  totalsCents: PersistenceImportTotals;
  warningCount: number;
  errorCount: number;
  blockedReasons: string[];
}

export class PersistenceImportPreconditionError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    const safeReasons = Array.from(new Set(reasons.map(safeCode)));
    super(`Rent Operations import is blocked: ${safeReasons.join("; ")}`);
    this.name = "PersistenceImportPreconditionError";
    this.reasons = safeReasons;
  }
}

export class PersistenceImportTransactionError extends Error {
  readonly code = "transaction_failed";

  constructor() {
    super("Rent Operations import transaction failed and was rolled back");
    this.name = "PersistenceImportTransactionError";
  }
}

interface PreparedImport {
  result: RentManagerImportResult;
  controls?: ImportControlTotals;
  restrictedSourceInput?: RentManagerImportInput | RentManagerExportEnvelope;
  requiresNormalization?: boolean;
  approvedArtifact?: boolean;
}

interface CollectionDescriptor {
  name: string;
  table: string;
  records: readonly unknown[];
  columns: readonly string[];
  values: (record: unknown) => unknown[];
  appendOnly?: boolean;
  /** Definitions, crosswalk entries, and imported schedules are immutable. */
  immutable?: boolean;
}

function safeCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
  return normalized || "invalid_reason";
}

function safeKey(value: string): string {
  return safeCode(value.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isImportResult(value: unknown): value is RentManagerImportResult {
  if (!isRecord(value)) return false;
  return isRecord(value.snapshot) && Array.isArray(value.sourceRecords) && isRecord(value.importRun) && Array.isArray(value.exceptions);
}

function isApprovedPersistenceImportArtifact(value: unknown): value is ApprovedPersistenceImportArtifact {
  if (!isRecord(value) || value.artifactType !== APPROVED_RM_NORMALIZER_ARTIFACT || !isRecord(value.normalizedResult) || !isRecord(value.restrictedSourceInput) || !isRecord(value.controls) || !isRecord(value.provenance)) return false;
  if (!isImportResult(value.normalizedResult)) return false;
  const provenance = value.provenance as Record<string, unknown>;
  return SHA256_RE.test(String(provenance.archiveEnvelopeSha256 ?? ""))
    && SHA256_RE.test(String(provenance.manifestSha256 ?? ""))
    && SHA256_RE.test(String(provenance.normalizedRowsSha256 ?? ""))
    && SHA256_RE.test(String(provenance.controlsSha256 ?? ""))
    && SHA256_RE.test(String(provenance.mappedRowsSha256 ?? ""))
    && SHA256_RE.test(String(provenance.restrictedRowsSha256 ?? ""))
    && SHA256_RE.test(String(provenance.artifactBindingSha256 ?? ""))
    && SHA256_RE.test(String(provenance.normalizationReportSha256 ?? ""))
    && typeof provenance.normalizerVersion === "string" && provenance.normalizerVersion.length > 0
    && typeof provenance.sourceRunId === "string" && provenance.sourceRunId.length > 0
    && SHA256_RE.test(String(provenance.registryHash ?? ""))
    && (provenance.verifiedSupplementReceiptSha256 === undefined || SHA256_RE.test(String(provenance.verifiedSupplementReceiptSha256)))
    && isoDateSchema.safeParse(provenance.artifactObservationOn).success;
}

function hasApprovedArtifactShape(value: unknown): boolean {
  return isRecord(value) && value.artifactType === APPROVED_RM_NORMALIZER_ARTIFACT;
}

/**
 * Verifies an approved artifact without trusting the caller's report object.
 * The restricted envelope is the source of truth for its own envelope and
 * normalized-row digests; the mapped/control/restricted digests are checked
 * against the exact objects that will cross the persistence boundary.
 */
export function assertApprovedPersistenceImportArtifactIntegrity(
  artifact: ApprovedPersistenceImportArtifact,
  options: Pick<PersistenceImporterOptions, "targetIdFactory" | "targetIdentity" | "verifiedSupplementReceipt"> = {},
): void {
  const reasons: string[] = [];
  const provenance = artifact.provenance;
  try {
    const envelopeHash = approvedArchiveEnvelopeSha256(artifact.restrictedSourceInput);
    const envelopeRecord = artifact.restrictedSourceInput as unknown as Record<string, unknown>;
    const payload = (envelopeRecord.payload ?? envelopeRecord.input ?? {}) as RentManagerImportInput;
    const envelopeObservation = artifact.restrictedSourceInput.artifactObservationOn;
    const manifestObservation = artifact.restrictedSourceInput.manifest?.artifactObservationOn;
    const observation = envelopeObservation ?? manifestObservation;
    if (!observation || !isoDateSchema.safeParse(observation).success || envelopeObservation !== manifestObservation) reasons.push("approved_artifact_observation_boundary_invalid");
    const receiptReasons = verifiedSupplementReceiptReasons(
      artifact.restrictedSourceInput,
      options.verifiedSupplementReceipt,
      provenance.manifestSha256,
    );
    if (receiptReasons.length > 0) reasons.push(...receiptReasons.map((reason) => `approved_artifact_${reason}`));
    const receiptSha256 = options.verifiedSupplementReceipt
      ? verifiedSupplementReceiptSha256(options.verifiedSupplementReceipt)
      : undefined;
    if (provenance.verifiedSupplementReceiptSha256 !== receiptSha256) reasons.push("approved_artifact_supplement_receipt_digest_mismatch");
    const supplementApproved = Boolean(options.verifiedSupplementReceipt)
      && receiptReasons.length === 0
      && approvedSupplementEvidenceValid(payload, envelopeRecord.supplementEvidence, String(envelopeRecord.runId ?? ""));
    const normalizedReplay = normalizeRentManagerExport(payload, {
      sourceRunId: String(envelopeRecord.runId ?? ""),
      approvedSupplementEvidence: supplementApproved,
      ...(observation ? { asOfDate: observation, artifactObservationOn: observation } : {}),
    });
    const normalizedInput = normalizedReplay.input;
    const normalizedRowsHash = approvedNormalizedRowsSha256(normalizedInput);
    const expectedControlsHash = approvedControlsSha256(controlsForApprovedSource(normalizedInput));
    const controlsHash = approvedControlsSha256(artifact.controls);
    const mappedRowsHash = approvedMappedRowsSha256(artifact.normalizedResult);
    const restrictedRowsHash = approvedRestrictedRowsSha256(artifact.restrictedSourceInput);
    const bindingHash = approvedArtifactBindingSha256({
      archiveEnvelopeSha256: envelopeHash,
      manifestSha256: provenance.manifestSha256,
      normalizedRowsSha256: normalizedRowsHash,
      controlsSha256: expectedControlsHash,
      mappedRowsSha256: mappedRowsHash,
      restrictedRowsSha256: restrictedRowsHash,
      normalizerVersion: provenance.normalizerVersion,
      normalizationReportSha256: provenance.normalizationReportSha256,
      sourceRunId: provenance.sourceRunId,
      registryHash: provenance.registryHash,
      artifactObservationOn: provenance.artifactObservationOn,
      targetIdentity: provenance.targetIdentity,
      verifiedSupplementReceiptSha256: receiptSha256,
    });
    if (provenance.archiveEnvelopeSha256 !== envelopeHash) reasons.push("approved_artifact_envelope_digest_mismatch");
    if (provenance.artifactObservationOn !== observation) reasons.push("approved_artifact_observation_boundary_mismatch");
    if (provenance.normalizedRowsSha256 !== normalizedRowsHash) reasons.push("approved_artifact_normalized_rows_digest_mismatch");
    if (provenance.controlsSha256 !== expectedControlsHash || controlsHash !== expectedControlsHash) reasons.push("approved_artifact_controls_digest_mismatch");
    if (provenance.mappedRowsSha256 !== mappedRowsHash) reasons.push("approved_artifact_mapped_rows_digest_mismatch");
    if (provenance.restrictedRowsSha256 !== restrictedRowsHash) reasons.push("approved_artifact_restricted_rows_digest_mismatch");
    if (provenance.artifactBindingSha256 !== bindingHash) reasons.push("approved_artifact_binding_digest_mismatch");
    if (artifact.restrictedSourceInput.version !== "rm-export/v2") reasons.push("approved_artifact_version_invalid");
    if (artifact.restrictedSourceInput.archiveEnvelopeSha256 !== envelopeHash || artifact.restrictedSourceInput.sourceManifestHash !== envelopeHash) reasons.push("approved_artifact_envelope_binding_mismatch");
    const manifest = artifact.restrictedSourceInput.manifest;
    if (manifest?.archiveEnvelopeSha256 !== envelopeHash) reasons.push("approved_artifact_manifest_envelope_mismatch");
    if (manifest?.manifestSha256 !== provenance.manifestSha256) reasons.push("approved_artifact_manifest_digest_mismatch");
    if (manifest?.artifactObservationOn !== observation) reasons.push("approved_artifact_manifest_observation_boundary_mismatch");
    if (String(envelopeRecord.runId ?? "") !== provenance.sourceRunId) reasons.push("approved_artifact_source_run_mismatch");
    if (artifact.normalizedResult.importRun.sourceManifestHash !== envelopeHash) reasons.push("approved_artifact_result_envelope_mismatch");
    if (artifact.normalizedResult.snapshot.modelVersion === 3) {
      if (!options.targetIdFactory) reasons.push("target_id_factory_required");
      if (!options.targetIdentity?.keyId || !options.targetIdentity?.keyVersion) reasons.push("target_id_key_identity_required");
      if (options.targetIdFactory) {
        const replay = mapRentManagerExport(normalizedInput, {
          now: new Date(artifact.normalizedResult.importRun.startedAt),
          mode: artifact.normalizedResult.importRun.mode,
          sourceManifestHash: envelopeHash,
          targetIdFactory: options.targetIdFactory,
          targetIdentity: options.targetIdentity,
          fidelityVersion: 3,
          artifactSha256: (payload as RentManagerImportInput & { artifactSha256?: string }).artifactSha256 ?? envelopeHash,
          artifactObservationOn: observation,
        });
        replay.exceptions.push(...normalizedReplay.exceptions.map((exception): ImportMappingException => {
          const detail = String(exception.detail).replace(/[^A-Za-z0-9_.:-]/g, "_");
          const severity = exception.confidence === "ambiguous"
            ? "error"
            : exception.collection === "hap"
              ? "error"
              : /deposit_property_not_resolved|deposit_tenant_not_resolved/.test(exception.detail)
                || exception.detail === "deposit_unit_id_not_returned_by_rm"
                || (exception.collection === "leases" && exception.detail === "lease_unit_not_returned")
                || (exception.collection === "units" && exception.detail === "market_rent_not_returned")
                || /_inferred(?:_|$)/.test(exception.detail)
                || /primary_contact_phone_not_resolved/.test(exception.detail)
                  ? "warning"
                  : exception.code === "missing_relationship" || exception.code === "incomplete_coverage" ? "error" : "warning";
          return {
            code: `normalization_${String(exception.collection).replace(/[^A-Za-z0-9_.:-]/g, "_")}_${detail}`,
            severity: severity as ImportMappingException["severity"],
            ...(exception.sourceIdHash ? { sourceId: exception.sourceIdHash } : {}),
            message: `Rent Manager normalization ${detail}`,
          };
        }));
        const replayControls = controlsForApprovedSource(normalizedInput);
        const replayReconciliation = reconcileRentManagerImport(replay, normalizedInput, replayControls);
        for (const mismatch of replayReconciliation.mismatches) {
          replay.exceptions.push({ code: `reconciliation_${safeKey(mismatch.code)}_${safeKey(mismatch.metric)}`, severity: mismatch.severity, message: `Rent Manager reconciliation ${safeKey(mismatch.code)} for ${safeKey(mismatch.metric)}`, ...(mismatch.amountCents === undefined ? {} : { amountCents: mismatch.amountCents }) });
        }
        const replayEnvelope = canonicalExportEnvelope(artifact.restrictedSourceInput);
        const history = projectApplicationHistoryForImport({
          ...replayEnvelope.payload,
          documentBinaries: replayEnvelope.documentBinaries,
        }, replay.sourceRecords, {
          artifactSha256: (payload as RentManagerImportInput & { artifactSha256?: string }).artifactSha256 ?? envelopeHash,
          supplementApproved,
          supplementEvidence: supplementApproved && replayEnvelope.supplementEvidence
            ? {
              rowSetSha256: replayEnvelope.supplementEvidence.rowSetSha256,
              attestationSha256: replayEnvelope.supplementEvidence.attestationSha256,
            }
            : undefined,
          targetIdFactory: (entityType, sourceId) => options.targetIdFactory?.(entityType as ImportEntityType, sourceId),
          statusCrosswalk: supplementApproved ? replayEnvelope.payload.applicationHistoryStatusCrosswalk : undefined,
        });
        replay.snapshot.applicationHistory = history.snapshot;
        for (const code of history.blockingCodes) {
          replay.exceptions.push({
            code,
            severity: "error",
            message: `Rent Manager application-history projection ${safeKey(code)}`,
          });
        }
        replay.importRun.exceptionCount = replay.exceptions.length;
        replay.importRun.status = replay.exceptions.some((exception) => exception.severity === "error") ? "failed" : "completed";
        if (approvedMappedRowsSha256(replay) !== mappedRowsHash) reasons.push("approved_artifact_target_identity_mismatch");
      }
    }
  } catch {
    reasons.push("approved_artifact_digest_verification_failed");
  }
  if (reasons.length > 0) throw new PersistenceImportPreconditionError(Array.from(new Set(reasons)));
}

function asEnvelope(value: unknown): RentManagerExportEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.payload) || isRecord(value.input)) return value as RentManagerExportEnvelope;
  return undefined;
}

function sourceManifestHash(value: RentManagerExportEnvelope): string | undefined {
  const candidate = value.sourceManifestHash ?? value.archiveEnvelopeSha256 ?? value.manifest?.archiveEnvelopeSha256;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Verifies the redacted archive receipt against the exact restricted input
 * that will cross the importer boundary.  This does not inspect archive
 * paths or re-read files; the archive runner already did that through
 * descriptor-bound reads.  It prevents a caller from pairing an otherwise
 * valid mapped artifact with a receipt from another run or manifest.
 */
function restrictedArchiveReceiptReasons(
  input: RentManagerImportInput | RentManagerExportEnvelope,
  receipt: RestrictedArchiveAuditReceiptBinding | undefined,
): string[] {
  if (!receipt) return ["restricted_archive_audit_receipt_missing"];
  const reasons: string[] = [];
  const record = input as unknown as Record<string, unknown>;
  const sourceRunId = typeof record.runId === "string" ? record.runId : "";
  let envelopeHash: string | undefined;
  try { envelopeHash = approvedArchiveEnvelopeSha256(input as RentManagerExportEnvelope); } catch { /* reported below without raw values */ }
  if (receipt.version !== "rm-restricted-archive-receipt/v1") reasons.push("restricted_archive_audit_receipt_version_invalid");
  if (!sourceRunId || receipt.sourceRunId !== sourceRunId) reasons.push("restricted_archive_audit_receipt_run_mismatch");
  if (!envelopeHash || receipt.canonicalEnvelopeSha256 !== envelopeHash) reasons.push("restricted_archive_audit_receipt_envelope_mismatch");
  const expectedManifestHash = isRecord(record.manifest) && typeof record.manifest.manifestSha256 === "string"
    ? record.manifest.manifestSha256
    : undefined;
  if (!expectedManifestHash || !SHA256_RE.test(expectedManifestHash) || receipt.canonicalManifestSha256 !== expectedManifestHash) reasons.push("restricted_archive_audit_receipt_manifest_mismatch");
  for (const [field, value] of Object.entries(receipt)) {
    if (field === "version" || field === "sourceRunId" || field === "pageFileCount") continue;
    if (typeof value !== "string" || !SHA256_RE.test(value)) reasons.push(`restricted_archive_audit_receipt_${safeKey(field)}_invalid`);
  }
  if (!Number.isSafeInteger(receipt.pageFileCount) || receipt.pageFileCount < 0) reasons.push("restricted_archive_audit_receipt_page_count_invalid");
  return Array.from(new Set(reasons));
}

function restrictedDocumentTransferBindingValid(input: VerifiedDocumentArchiveInput): boolean {
  const binding = input.sourceBinaryBinding;
  return typeof binding.bindingId === "string" && binding.bindingId.length > 0
    && typeof binding.importRunId === "string" && binding.importRunId.length > 0
    && typeof binding.sourceSystem === "string" && binding.sourceSystem.length > 0
    && typeof binding.sourceCollection === "string" && binding.sourceCollection.length > 0
    && typeof input.checksumSha256 === "string" && SHA256_RE.test(input.checksumSha256)
    && Number.isSafeInteger(input.sizeBytes) && (input.sizeBytes ?? -1) > 0
    && input.bytes instanceof Uint8Array && input.bytes.byteLength === input.sizeBytes
    && sha256(input.bytes) === input.checksumSha256.toLowerCase();
}

function restrictedDocumentTransferResult(value: unknown): RestrictedVerifiedDocumentTransferResult | undefined {
  if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.binding)) return undefined;
  return { document: value.document as unknown as RentOpsDocument, binding: value.binding as unknown as RentOpsDocumentObjectBinding };
}

function restrictedDocumentTransferResultValid(
  input: VerifiedDocumentArchiveInput,
  result: RestrictedVerifiedDocumentTransferResult,
): boolean {
  const binding = result.binding;
  const document = result.document;
  if (typeof input.checksumSha256 !== "string" || !SHA256_RE.test(input.checksumSha256)) return false;
  const expectedChecksum = input.checksumSha256.toLowerCase();
  const sourceBinding = input.sourceBinaryBinding;
  const referenceKeys = ["propertyId", "unitId", "personId", "tenancyId", "applicationId"] as const;
  return Boolean(document && binding)
    && document.id === input.documentId
    && document.state === "verified"
    && document.availability === "verified"
    && document.storageKeyKnowledge === "source"
    && document.checksumSha256?.toLowerCase() === expectedChecksum
    && document.sizeBytes === input.sizeBytes
    && document.storageKey === `documents/${expectedChecksum}`
    && binding.documentId === input.documentId
    && binding.bindingKind === "import"
    && binding.sourceBinaryId === sourceBinding.bindingId
    && binding.importRunId === sourceBinding.importRunId
    && binding.sourceSystem === sourceBinding.sourceSystem
    && binding.sourceCollection === sourceBinding.sourceCollection
    && binding.checksumSha256.toLowerCase() === expectedChecksum
    && binding.sizeBytes === input.sizeBytes
    && typeof binding.backend === "string" && binding.backend.length > 0
    && /^sha256:[a-f0-9]{64}$/i.test(binding.logicalKey)
    && binding.logicalKey.slice(7).toLowerCase() === expectedChecksum
    && (typeof binding.immutableGeneration === "string" && binding.immutableGeneration.length > 0
      || typeof binding.immutableVersion === "string" && binding.immutableVersion.length > 0)
    && typeof binding.verifiedAt === "string" && Number.isFinite(new Date(binding.verifiedAt).getTime())
    && referenceKeys.every((key) => (document[key] ?? undefined) === (input[key] ?? undefined));
}

function restrictedDocumentTransferOrphanEvidence(input: VerifiedDocumentArchiveInput): RestrictedDocumentTransferOrphanEvidence {
  const binding = input.sourceBinaryBinding;
  return {
    status: "orphaned",
    reason: "database_binding_failed",
    sourceBinaryIdSha256: sha256(String(binding.bindingId ?? "")),
    importRunIdSha256: sha256(String(binding.importRunId ?? "")),
    sourceSystemSha256: sha256(String(binding.sourceSystem ?? "")),
    sourceCollectionSha256: sha256(String(binding.sourceCollection ?? "")),
    checksumSha256: sha256(String(input.checksumSha256 ?? "")),
    sizeBytes: Number.isSafeInteger(input.sizeBytes) && (input.sizeBytes ?? -1) >= 0 ? input.sizeBytes! : 0,
  };
}

function controlsFrom(value: unknown): ImportControlTotals | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.controls ?? value.controlTotals;
  return isRecord(candidate) ? candidate as ImportControlTotals : undefined;
}

/** Maps a result or restricted exporter envelope without persisting raw input. */
export function preparePersistenceImport(input: PersistenceImportInput, options: Pick<PersistenceImporterOptions, "mode" | "now" | "testOnlyAllowUnprovenancedMappedResult" | "targetIdFactory" | "targetIdentity" | "verifiedSupplementReceipt"> = {}): PreparedImport {
  if (hasApprovedArtifactShape(input) && !isApprovedPersistenceImportArtifact(input)) {
    if (options.testOnlyAllowUnprovenancedMappedResult === true && process.env.NODE_ENV !== "production" && isRecord(input)) {
      const normalizedResult = input.normalizedResult;
      const restrictedSourceInput = input.restrictedSourceInput;
      if (isImportResult(normalizedResult) && isRecord(restrictedSourceInput)) {
        return {
          result: normalizedResult,
          controls: isRecord(input.controls) ? input.controls as ImportControlTotals : undefined,
          restrictedSourceInput: restrictedSourceInput as RentManagerExportEnvelope,
          approvedArtifact: false,
        };
      }
    }
    throw new PersistenceImportPreconditionError(["approved_artifact_digest_missing_or_invalid"]);
  }
  if (isApprovedPersistenceImportArtifact(input)) {
    assertApprovedPersistenceImportArtifactIntegrity(input, options);
    return {
      result: input.normalizedResult,
      controls: input.controls,
      restrictedSourceInput: input.restrictedSourceInput,
      approvedArtifact: true,
    };
  }
  if (isImportResult(input)) return {
    result: input,
    controls: controlsFrom(input),
    requiresNormalization: input.importRun.system === RENT_OPS_IMPORT_SYSTEM
      && !(options.testOnlyAllowUnprovenancedMappedResult === true && process.env.NODE_ENV !== "production"),
  };
  const envelope = asEnvelope(input);
  const payload = envelope?.payload ?? envelope?.input ?? input;
  if (!isRecord(payload)) throw new PersistenceImportPreconditionError(["import_input_invalid"]);
  try {
    const result = mapRentManagerExport(payload as RentManagerImportInput, {
      mode: options.mode ?? "dry_run",
      now: options.now,
      sourceManifestHash: envelope ? sourceManifestHash(envelope) : undefined,
      targetIdFactory: options.targetIdFactory,
      targetIdentity: options.targetIdentity,
      fidelityVersion: 3,
    });
    return {
      result,
      controls: envelope ? controlsFrom(envelope) : undefined,
      restrictedSourceInput: envelope ?? payload as RentManagerImportInput,
      requiresNormalization: true,
    };
  } catch {
    throw new PersistenceImportPreconditionError(["mapper_failed"]);
  }
}

function nullable(value: unknown): unknown {
  return value === undefined ? null : value;
}

function jsonValue(value: unknown): unknown {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function sourcePair(source: { system: string; sourceId: string } | undefined): [unknown, unknown] {
  return source ? [source.system, source.sourceId] : [null, null];
}

function sourceMetadata(record: RentOpsSourceRecord): unknown {
  const metadata = record.rawMetadata;
  if (!isRecord(metadata)) return null;
  const safe: Record<string, unknown> = {};
  for (const key of ["sourceId", "entityType", "sourceUpdatedAt", "fieldCount", "recordHash"]) {
    const value = metadata[key];
    if (value !== undefined && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? JSON.stringify(safe) : null;
}

function sum(values: readonly (number | null | undefined)[]): Cents {
  const total = values.reduce<number>((current, value) => current + (typeof value === "number" && Number.isSafeInteger(value) ? value : 0), 0);
  if (!Number.isSafeInteger(total)) throw new PersistenceImportPreconditionError(["money_total_overflow"]);
  return total as Cents;
}

function countsFor(snapshot: RentOpsSnapshot, sourceRecords: readonly RentOpsSourceRecord[]): PersistenceImportCounts {
  const history = snapshot.applicationHistory;
  return {
    properties: snapshot.properties.length,
    units: snapshot.units.length,
    people: snapshot.people.length,
    applications: snapshot.applications.length,
    tenancies: snapshot.tenancies.length,
    householdMemberships: snapshot.householdMemberships.length,
    leaseTerms: snapshot.leaseTerms.length,
    chargeDefinitions: snapshot.chargeDefinitions.length,
    recurringSchedules: snapshot.recurringSchedules.length,
    ledgerTransactions: snapshot.ledgerTransactions.length,
    paymentAllocations: snapshot.paymentAllocations.length,
    securityDeposits: snapshot.securityDeposits.length,
    subsidyContracts: snapshot.subsidyContracts.length,
    subsidyTenants: snapshot.subsidyTenants.length,
    subsidyPayments: snapshot.subsidyPayments.length,
    applicationHouseholdMembers: snapshot.applicationHouseholdMembers.length,
    applicationRequirements: snapshot.applicationRequirements.length,
    documents: snapshot.documents.length,
    activityEvents: snapshot.activityEvents.length,
    sourceRecords: sourceRecords.length,
    importRuns: snapshot.importRuns.length,
    ...(history ? {
      prospects: history.prospects.length,
      applicationHistory: history.applications.length,
      applicationInterests: history.interests.length,
      applicationParticipants: history.participants.length,
      applicationRequirementOccurrences: history.requirements.length,
      applicationTemplateDefinitions: history.templates.length,
      applicationTemplateSections: history.templateSections.length,
      applicationTemplateFields: history.templateFields.length,
      applicationAnswerOccurrences: history.answers.length,
      applicationHistoryDocuments: history.documents.length,
      applicationHistoryActivities: history.activities.length,
      applicationHistoryBlockers: history.blockers.length,
      applicationHistoryAggregates: 1,
    } : {}),
  };
}

function totalsFor(snapshot: RentOpsSnapshot): PersistenceImportTotals {
  const transactionMap = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.id, transaction]));
  const netLedgerCents = sum(snapshot.ledgerTransactions.map((row) => typeof row.amountCents === "number" ? row.amountCents * ledgerBalanceSign(row, transactionMap) : undefined));
  return {
    chargesCents: sum(snapshot.ledgerTransactions.filter((row) => row.kind === "charge").map((row) => row.amountCents)),
    paymentsCents: sum(snapshot.ledgerTransactions.filter((row) => row.kind === "payment").map((row) => row.amountCents)),
    creditsCents: sum(snapshot.ledgerTransactions.filter((row) => row.kind === "credit").map((row) => row.amountCents)),
    allocationsCents: sum(snapshot.paymentAllocations.map((row) => row.amountCents)),
    depositsCents: sum(snapshot.securityDeposits.map((row) => row.sourceBalanceCents ?? row.amountHeldCents)),
    hapAgencyObligationCents: sum(snapshot.subsidyContracts.map((row) => row.agencyObligationCents)),
    hapTenantObligationCents: sum(snapshot.subsidyContracts.map((row) => row.tenantObligationCents)),
    netLedgerCents,
    netLedgerBalanceCents: netLedgerCents,
  };
}

function expectedControlValues(controls: ImportControlTotals | undefined): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(controls?.totalsCents ?? {})) if (typeof value === "number") values[key] = value;
  if (controls?.netLedgerCents !== undefined) values.netLedgerCents = controls.netLedgerCents;
  if (controls?.netLedgerBalanceCents !== undefined) values.netLedgerBalanceCents = controls.netLedgerBalanceCents;
  if (controls?.hap) {
    values.hapAgencyObligationCents = controls.hap.agencyObligationCents;
    values.hapTenantObligationCents = controls.hap.tenantObligationCents;
  }
  return values;
}

function actualControlValues(totals: PersistenceImportTotals): Record<string, number> {
  return {
    charges: totals.chargesCents, chargesCents: totals.chargesCents,
    payments: totals.paymentsCents, paymentsCents: totals.paymentsCents,
    credits: totals.creditsCents, creditsCents: totals.creditsCents,
    allocations: totals.allocationsCents, allocationsCents: totals.allocationsCents,
    deposits: totals.depositsCents, depositsCents: totals.depositsCents,
    hapAgencyObligationCents: totals.hapAgencyObligationCents,
    hapTenantObligationCents: totals.hapTenantObligationCents,
    netLedgerCents: totals.netLedgerCents,
    netLedgerBalanceCents: totals.netLedgerBalanceCents,
    balance: totals.netLedgerCents, balanceCents: totals.netLedgerCents,
  };
}

function moneyStateCounts(snapshot: RentOpsSnapshot, exceptions: readonly ImportMappingException[]): { unknown: Record<string, number>; invalid: Record<string, number> } {
  const unknown: Record<string, number> = {};
  const invalid: Record<string, number> = {};
  const add = (target: Record<string, number>, key: string, count = 1) => { target[key] = (target[key] ?? 0) + count; };
  const exceptionSources = (code: string): Set<string> => new Set(exceptions.filter((item) => item.code === code && item.sourceId).map((item) => item.sourceId as string));
  const classifyRows = (key: string, rows: readonly { amountCents?: number | null; source?: { sourceId?: string } }[], unknownCode: string, invalidCode: string) => {
    const rowSources = new Set(rows.map((row) => row.source?.sourceId).filter((id): id is string => Boolean(id)));
    const unknownSources = new Set(Array.from(exceptionSources(unknownCode)).filter((id) => rowSources.has(id)));
    const invalidSources = new Set(Array.from(exceptionSources(invalidCode)).filter((id) => rowSources.has(id)));
    for (const row of rows) {
      if (invalidSources.has(row.source?.sourceId ?? "")) continue;
      if (unknownSources.has(row.source?.sourceId ?? "")) continue;
      if (typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents)) add(unknown, key);
    }
    add(unknown, key, unknownSources.size);
    add(invalid, key, invalidSources.size);
  };
  classifyRows("charges", snapshot.ledgerTransactions.filter((row) => row.kind === "charge"), "ledger_amount_unknown", "ledger_amount_invalid");
  classifyRows("payments", snapshot.ledgerTransactions.filter((row) => row.kind === "payment"), "ledger_amount_unknown", "ledger_amount_invalid");
  classifyRows("credits", snapshot.ledgerTransactions.filter((row) => row.kind === "credit"), "ledger_amount_unknown", "ledger_amount_invalid");
  classifyRows("allocations", snapshot.paymentAllocations, "allocation_amount_unknown", "allocation_amount_invalid");
  for (const item of exceptions) {
    if (item.entityType === "deposit" && item.code === "amount_missing") add(unknown, "deposits");
    if (item.entityType === "deposit" && (item.code === "amount_invalid" || item.code === "amount_not_positive")) add(invalid, "deposits");
    if (item.entityType !== "subsidy") continue;
    const isMissing = item.code === "amount_missing";
    const isInvalid = item.code === "amount_invalid" || item.code === "amount_not_positive";
    if (!isMissing && !isInvalid) continue;
    const message = item.message.toLowerCase();
    for (const key of ["hapAgencyObligationCents", "hapTenantObligationCents"]) {
      const field = key === "hapAgencyObligationCents" ? "agencyobligationcents" : "tenantobligationcents";
      if (!message.includes(field)) continue;
      add(isMissing ? unknown : invalid, key);
    }
  }
  return { unknown, invalid };
}

function validateControls(snapshot: RentOpsSnapshot, controls: ImportControlTotals | undefined, exceptions: readonly ImportMappingException[] = []): string[] {
  if (!controls) return [];
  const reasons: string[] = [];
  const sourceCounts: Record<string, number> = {};
  for (const source of snapshot.sourceRecords) sourceCounts[source.entityType] = (sourceCounts[source.entityType] ?? 0) + 1;
  for (const [key, expected] of Object.entries(controls.counts ?? {})) {
    if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0 || (sourceCounts[key] ?? 0) !== expected) reasons.push(`control_count_mismatch_${safeKey(key)}`);
  }
  const actual = actualControlValues(totalsFor(snapshot));
  for (const [key, expected] of Object.entries(expectedControlValues(controls))) {
    if (!Number.isSafeInteger(expected) || actual[key] !== expected) reasons.push(`control_total_mismatch_${safeKey(key)}`);
  }
  const moneyStates = moneyStateCounts(snapshot, exceptions);
  for (const [key, expected] of Object.entries(controls.unknownCounts ?? {})) {
    if (!Number.isSafeInteger(expected) || expected < 0 || (moneyStates.unknown[key] ?? 0) !== expected) reasons.push(`control_unknown_money_mismatch_${safeKey(key)}`);
  }
  for (const [key, expected] of Object.entries(controls.invalidMoneyCounts ?? {})) {
    if (!Number.isSafeInteger(expected) || expected < 0 || (moneyStates.invalid[key] ?? 0) !== expected) reasons.push(`control_invalid_money_mismatch_${safeKey(key)}`);
  }
  const propertyBalances = new Map<string, number>();
  const transactionMap = new Map(snapshot.ledgerTransactions.map((row) => [row.id, row]));
  for (const transaction of snapshot.ledgerTransactions) {
    if (!transaction.propertyId || typeof transaction.amountCents !== "number") continue;
    propertyBalances.set(transaction.propertyId, (propertyBalances.get(transaction.propertyId) ?? 0) + transaction.amountCents * ledgerBalanceSign(transaction, transactionMap));
  }
  for (const [key, expected] of Object.entries(controls.balancesCents ?? {})) if (!Number.isSafeInteger(expected) || propertyBalances.get(key) !== expected) reasons.push("control_balance_mismatch");
  return Array.from(new Set(reasons));
}

function targetIds(snapshot: RentOpsSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const records of [snapshot.properties, snapshot.units, snapshot.people, snapshot.tenancies, snapshot.leaseTerms, snapshot.chargeDefinitions, snapshot.recurringSchedules, snapshot.ledgerTransactions, snapshot.paymentAllocations, snapshot.securityDeposits, snapshot.subsidyContracts, snapshot.subsidyTenants, snapshot.subsidyPayments, snapshot.applications, snapshot.documents, snapshot.activityEvents]) for (const record of records) ids.add(record.id);
  if (snapshot.applicationHistory) {
    for (const records of [
      snapshot.applicationHistory.prospects,
      snapshot.applicationHistory.applications,
      snapshot.applicationHistory.interests,
      snapshot.applicationHistory.participants,
      snapshot.applicationHistory.requirements,
      snapshot.applicationHistory.templates,
      snapshot.applicationHistory.templateSections,
      snapshot.applicationHistory.templateFields,
      snapshot.applicationHistory.answers,
      snapshot.applicationHistory.documents,
      snapshot.applicationHistory.activities,
    ]) for (const record of records) ids.add(record.id);
  }
  return ids;
}

function validateSourceRecords(result: RentManagerImportResult): string[] {
  const reasons: string[] = [];
  const ids = targetIds(result.snapshot);
  const seen = new Set<string>();
  const snapshotKeys = new Set(result.snapshot.sourceRecords.map((record) => `${record.system}:${record.entityType}:${record.sourceId}`));
  const resultKeys = new Set<string>();
  for (const source of result.sourceRecords) {
    const key = `${source.system}:${source.entityType}:${source.sourceId}`;
    if (!source.sourceId || seen.has(key)) reasons.push("source_key_duplicate_or_missing");
    seen.add(key); resultKeys.add(key);
    if (!SHA256_RE.test(source.checksum ?? "")) reasons.push("source_checksum_invalid");
    if (!source.targetId || (!ids.has(source.targetId) && !source.targetId.startsWith("rm:exception:"))) reasons.push("source_target_missing");
  }
  if (result.sourceRecords.length !== result.snapshot.sourceRecords.length || resultKeys.size !== snapshotKeys.size || Array.from(resultKeys).some((key) => !snapshotKeys.has(key))) reasons.push("source_records_mismatch");
  return reasons;
}

function validateOrphans(snapshot: RentOpsSnapshot): string[] {
  const reasons: string[] = [];
  const v3 = snapshot.modelVersion === 3;
  const propertyIds = new Set(snapshot.properties.map((row) => row.id));
  const unitMap = new Map(snapshot.units.map((row) => [row.id, row]));
  const peopleIds = new Set(snapshot.people.map((row) => row.id));
  const tenancyMap = new Map(snapshot.tenancies.map((row) => [row.id, row]));
  const applicationIds = new Set(snapshot.applications.map((row) => row.id));
  const transactionMap = new Map(snapshot.ledgerTransactions.map((row) => [row.id, row]));
  const subsidyContractMap = new Map(snapshot.subsidyContracts.map((row) => [row.id, row]));
  const subsidyTenantMap = new Map(snapshot.subsidyTenants.map((row) => [row.id, row]));
  for (const row of snapshot.units) if (!(v3 && !row.propertyId && (row.propertyLinkKnowledge === "unknown" || row.propertyLinkKnowledge === "ambiguous")) && !propertyIds.has(row.propertyId)) reasons.push("orphan_unit");
  for (const row of snapshot.tenancies) {
    const propertyValid = row.propertyId ? propertyIds.has(row.propertyId) : v3 && row.propertyLinkKnowledge === "unknown";
    const unitValid = row.unitId ? unitMap.has(row.unitId) && (!row.propertyId || unitMap.get(row.unitId)?.propertyId === row.propertyId) : v3 && row.unitLinkKnowledge === "unknown";
    const personValid = row.primaryPersonId ? peopleIds.has(row.primaryPersonId) : v3 && row.primaryPersonLinkKnowledge === "unknown";
    if (!propertyValid || !unitValid || !personValid) reasons.push("orphan_tenancy");
  }
  for (const row of snapshot.householdMemberships) if (!peopleIds.has(row.personId) || (!row.tenancyId && !row.applicationId && !row.accountPersonId) || (row.tenancyId && !tenancyMap.has(row.tenancyId)) || (row.applicationId && !applicationIds.has(row.applicationId)) || (row.accountPersonId && !peopleIds.has(row.accountPersonId))) reasons.push("orphan_household_membership");
  for (const row of snapshot.leaseTerms) if (!(v3 && !row.tenancyId && (row.tenancyLinkKnowledge === "unknown" || row.tenancyLinkKnowledge === "ambiguous")) && !tenancyMap.has(row.tenancyId)) reasons.push("orphan_lease_term");
  for (const row of snapshot.recurringSchedules) if (row.propertyId && (!propertyIds.has(row.propertyId) || row.unitId && unitMap.get(row.unitId)?.propertyId !== row.propertyId) || row.tenancyId && !tenancyMap.has(row.tenancyId)) reasons.push("orphan_recurring_schedule");
  for (const row of snapshot.ledgerTransactions) if (!((v3 && !row.propertyId && (row.propertyLinkKnowledge === "unknown" || row.propertyLinkKnowledge === "ambiguous")) || (row.propertyId && propertyIds.has(row.propertyId))) || (row.unitId && !unitMap.has(row.unitId)) || (!row.unitId && !(v3 && (row.unitLinkKnowledge === "unknown" || row.unitLinkKnowledge === "ambiguous"))) || (row.tenancyId && !tenancyMap.has(row.tenancyId)) || (!row.tenancyId && !(v3 && (row.tenancyLinkKnowledge === "unknown" || row.tenancyLinkKnowledge === "ambiguous"))) || (row.personId && !peopleIds.has(row.personId)) || (!row.personId && !(v3 && (row.personLinkKnowledge === "unknown" || row.personLinkKnowledge === "ambiguous")))) reasons.push("orphan_ledger_transaction");
  for (const row of snapshot.paymentAllocations) if (!((row.paymentTransactionId && transactionMap.has(row.paymentTransactionId)) || (v3 && !row.paymentTransactionId && (row.paymentLinkKnowledge === "unknown" || row.paymentLinkKnowledge === "ambiguous"))) || !((row.chargeTransactionId && transactionMap.has(row.chargeTransactionId)) || (v3 && !row.chargeTransactionId && (row.chargeLinkKnowledge === "unknown" || row.chargeLinkKnowledge === "ambiguous")))) reasons.push("orphan_payment_allocation");
  for (const row of snapshot.securityDeposits) if ((row.propertyId && !propertyIds.has(row.propertyId)) || (!row.propertyId && !(v3 && (row.propertyLinkKnowledge === "unknown" || row.propertyLinkKnowledge === "ambiguous"))) || (row.unitId && (!unitMap.has(row.unitId) || row.propertyId && unitMap.get(row.unitId)?.propertyId !== row.propertyId)) || row.tenancyId && !tenancyMap.has(row.tenancyId) || (row.personId && !peopleIds.has(row.personId)) || (!row.personId && !(v3 && (row.personLinkKnowledge === "unknown" || row.personLinkKnowledge === "ambiguous")))) reasons.push("orphan_security_deposit");
  for (const row of snapshot.subsidyContracts) if (!tenancyMap.has(row.tenancyId) || !unitMap.has(row.unitId)) reasons.push("orphan_subsidy_contract");
  for (const row of snapshot.subsidyTenants) {
    if (row.subsidyContractId && !subsidyContractMap.has(row.subsidyContractId) && !(v3 && [row.subsidyContractLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_tenant_contract");
    if (row.tenancyId && !tenancyMap.has(row.tenancyId) && !(v3 && [row.tenancyLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_tenant_tenancy");
    if (row.personId && !peopleIds.has(row.personId) && !(v3 && [row.personLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_tenant_person");
    if (row.propertyId && !propertyIds.has(row.propertyId) && !(v3 && [row.propertyLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_tenant_property");
    if (row.unitId && (!unitMap.has(row.unitId) || row.propertyId && unitMap.get(row.unitId)?.propertyId !== row.propertyId) && !(v3 && [row.unitLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_tenant_unit");
  }
  for (const row of snapshot.subsidyPayments) {
    if (row.subsidyContractId && !subsidyContractMap.has(row.subsidyContractId) && !(v3 && [row.subsidyContractLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_payment_contract");
    if (row.subsidyTenantId && !subsidyTenantMap.has(row.subsidyTenantId) && !(v3 && [row.subsidyTenantLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_payment_tenant");
    if (row.paymentTransactionId && (!transactionMap.has(row.paymentTransactionId) || transactionMap.get(row.paymentTransactionId)?.kind !== "payment") && !(v3 && [row.paymentLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_payment_ledger_link");
    if (row.tenancyId && !tenancyMap.has(row.tenancyId) && !(v3 && [row.tenancyLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_payment_tenancy");
    if (row.personId && !peopleIds.has(row.personId) && !(v3 && [row.personLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_payment_person");
    if (row.propertyId && !propertyIds.has(row.propertyId) && !(v3 && [row.propertyLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_payment_property");
    if (row.unitId && (!unitMap.has(row.unitId) || row.propertyId && unitMap.get(row.unitId)?.propertyId !== row.propertyId) && !(v3 && [row.unitLinkKnowledge].every((knowledge) => knowledge === "unknown" || knowledge === "ambiguous"))) reasons.push("orphan_subsidy_payment_unit");
  }
  for (const row of snapshot.applicationHouseholdMembers) if (!applicationIds.has(row.applicationId)) reasons.push("orphan_application_household_member");
  for (const row of snapshot.applicationRequirements) if (!applicationIds.has(row.applicationId) || (row.documentId && !snapshot.documents.some((document) => document.id === row.documentId))) reasons.push("orphan_application_requirement");
  for (const row of snapshot.documents) if ((row.propertyId && !propertyIds.has(row.propertyId)) || (row.unitId && !unitMap.has(row.unitId)) || (row.personId && !peopleIds.has(row.personId)) || (row.tenancyId && !tenancyMap.has(row.tenancyId)) || (row.applicationId && !applicationIds.has(row.applicationId))) reasons.push("orphan_document");
  for (const row of snapshot.activityEvents) if ((row.propertyId && !propertyIds.has(row.propertyId)) || (row.unitId && !unitMap.has(row.unitId)) || (row.personId && !peopleIds.has(row.personId)) || (row.tenancyId && !tenancyMap.has(row.tenancyId)) || (row.applicationId && !applicationIds.has(row.applicationId))) reasons.push("orphan_activity");
  const history = snapshot.applicationHistory;
  if (history) {
    const historyProspectIds = new Set(history.prospects.map((row) => row.id));
    const historyApplicationIds = new Set(history.applications.map((row) => row.id));
    const historyDocumentIds = new Set(history.documents.map((row) => row.id));
    const historyTemplateIds = new Set(history.templates.map((row) => row.id));
    const historySectionIds = new Set(history.templateSections.map((row) => row.id));
    const historyFieldIds = new Set(history.templateFields.map((row) => row.id));
    const historyParentKnown = (row: { applicationId?: string | null; prospectId?: string | null }): boolean => (!row.applicationId || historyApplicationIds.has(row.applicationId)) && (!row.prospectId || historyProspectIds.has(row.prospectId));
    for (const row of history.applications) if (row.prospectId && !historyProspectIds.has(row.prospectId)) reasons.push("orphan_history_application_prospect");
    for (const row of history.prospects) if (row.personId && !peopleIds.has(row.personId)) reasons.push("orphan_history_prospect_person");
    for (const row of history.applications) if (row.personId && !peopleIds.has(row.personId)) reasons.push("orphan_history_application_person");
    for (const row of history.interests) {
      if (!historyParentKnown(row)) reasons.push("orphan_history_interest_parent");
      if (row.propertyId && !propertyIds.has(row.propertyId)) reasons.push("orphan_history_interest_property");
      if (row.unitId && !unitMap.has(row.unitId)) reasons.push("orphan_history_interest_unit");
    }
    for (const row of history.participants) {
      if (!historyParentKnown(row)) reasons.push("orphan_history_participant_parent");
      if (row.personId && !peopleIds.has(row.personId)) reasons.push("orphan_history_participant_person");
    }
    for (const row of history.requirements) {
      if (!historyParentKnown(row)) reasons.push("orphan_history_requirement_parent");
      if (row.documentId && !historyDocumentIds.has(row.documentId)) reasons.push("orphan_history_requirement_document");
    }
    for (const row of history.templateSections) if (row.templateId && !historyTemplateIds.has(row.templateId)) reasons.push("orphan_history_template_section_template");
    for (const row of history.templateFields) {
      if (row.templateId && !historyTemplateIds.has(row.templateId)) reasons.push("orphan_history_template_field_template");
      if (row.sectionId && !historySectionIds.has(row.sectionId)) reasons.push("orphan_history_template_field_section");
    }
    for (const row of history.answers) {
      if (!historyParentKnown(row)) reasons.push("orphan_history_answer_parent");
      if (row.fieldId && !historyFieldIds.has(row.fieldId)) reasons.push("orphan_history_answer_field");
    }
    for (const row of history.documents) if (!historyParentKnown(row)) reasons.push("orphan_history_document_parent");
    for (const row of history.activities) if (!historyParentKnown(row)) reasons.push("orphan_history_activity_parent");
    for (const row of history.blockers) if ((row.applicationId && !historyApplicationIds.has(row.applicationId)) || (row.prospectId && !historyProspectIds.has(row.prospectId))) reasons.push("orphan_history_blocker_parent");
  }
  return reasons;
}

function validateOccupancyAndLeases(snapshot: RentOpsSnapshot): string[] {
  const reasons: string[] = [];
  const byUnit = new Map<string, typeof snapshot.tenancies>();
  for (const tenancy of snapshot.tenancies) {
    if (!["current", "notice", "future"].includes(tenancy.status)) continue;
    if (!tenancy.unitId || tenancy.unitLinkKnowledge === "unknown" || tenancy.unitLinkKnowledge === "ambiguous") continue;
    const rows = byUnit.get(tenancy.unitId) ?? []; rows.push(tenancy); byUnit.set(tenancy.unitId, rows);
  }
  for (const rows of Array.from(byUnit.values())) {
    if (rows.filter((row) => row.status === "current" || row.status === "notice").length > 1) reasons.push("duplicate_occupancy_conflict");
    if (rows.filter((row) => row.status === "future").length > 1) reasons.push("duplicate_future_occupancy_conflict");
  }
  if (validateSnapshot(snapshot).some((violation) => violation.code === "overlapping_lease_terms" || violation.code === "overlapping_current_tenancies")) reasons.push("duplicate_lease_conflict");
  return reasons;
}

function validateResult(result: RentManagerImportResult, controls?: ImportControlTotals): string[] {
  const reasons: string[] = [];
  if (result.importRun.status !== "completed") reasons.push("import_run_not_completed");
  try { assertValidSnapshot(result.snapshot); } catch { reasons.push("snapshot_invariant_failed"); }
  if (result.snapshot.applicationHistory) {
    try { assertValidApplicationHistory(result.snapshot.applicationHistory); } catch { reasons.push("application_history_invariant_failed"); }
  }
  for (const exception of result.exceptions.filter((item) => item.severity === "error")) reasons.push(`mapping_${safeCode(exception.code)}`);
  reasons.push(...validateSourceRecords(result), ...validateOrphans(result.snapshot), ...validateOccupancyAndLeases(result.snapshot), ...validateControls(result.snapshot, controls, result.exceptions));
  return Array.from(new Set(reasons));
}

export async function inspectRentOpsDatabase(executor: RentOpsQueryExecutor): Promise<DatabaseTargetInspection> {
  try { return await inspectDatabaseTargetReadOnly(executor); }
  catch { throw new PersistenceImportPreconditionError(["target_inspection_failed"]); }
}

function validFingerprint(value: string): boolean {
  return REDACTED_FINGERPRINT_RE.test(value) && value !== KNOWN_LIVE_PRIMARY_FINGERPRINT;
}

function forbiddenFingerprintPolicyReasons(options: PersistenceImporterOptions, inspection?: DatabaseTargetInspection): string[] {
  const policy = options.forbiddenDatabaseFingerprints;
  if (!policy || policy.length === 0) return ["forbidden_database_fingerprint_policy_missing"];
  if (policy.some((fingerprint) => !REDACTED_FINGERPRINT_RE.test(fingerprint))) return ["forbidden_database_fingerprint_policy_invalid"];
  if (inspection && policy.includes(inspection.redactedFingerprint)) return ["forbidden_database_fingerprint_rejected"];
  return [];
}

function applyGateReasons(options: PersistenceImporterOptions, inspection: DatabaseTargetInspection): string[] {
  const reasons: string[] = [];
  if (options.targetClassification !== "staging" && options.targetClassification !== "production") reasons.push("target_not_classified_staging");
  if (inspection.redactedFingerprint === KNOWN_LIVE_PRIMARY_FINGERPRINT) reasons.push("known_live_primary_rejected");
  reasons.push(...forbiddenFingerprintPolicyReasons(options, inspection));
  if (!options.expectedDatabaseFingerprint || !validFingerprint(options.expectedDatabaseFingerprint)) reasons.push("expected_database_fingerprint_missing_or_invalid");
  else if (options.expectedDatabaseFingerprint !== inspection.redactedFingerprint) reasons.push("database_fingerprint_mismatch");
  const backup = options.backupAttestation;
  if (!backup?.verified || (!backup.attestationId && !backup.reference) || !backup.verifiedAt) reasons.push("verified_backup_attestation_missing");
  else if (backup.targetFingerprint !== inspection.redactedFingerprint) reasons.push("backup_target_fingerprint_mismatch");
  if (!options.expectedMigrationChecksum || !SHA256_RE.test(options.expectedMigrationChecksum)) reasons.push("expected_migration_checksum_missing_or_invalid");
  else if (options.expectedMigrationChecksum !== inspection.migrationChecksum) reasons.push("migration_checksum_mismatch");
  if (!options.renderedMigrationChecksum || !SHA256_RE.test(options.renderedMigrationChecksum)) reasons.push("rendered_migration_checksum_missing_or_invalid");
  else if (options.renderedMigrationChecksum !== options.expectedMigrationChecksum) reasons.push("rendered_migration_checksum_mismatch");
  if (options.actualDatabaseFingerprint && options.actualDatabaseFingerprint !== inspection.redactedFingerprint) reasons.push("actual_database_fingerprint_mismatch");
  if (inspection.migrationChainValid === false) reasons.push("migration_chain_invalid");
  if (inspection.migrationVersion !== RENT_OPS_MIGRATION_VERSION) reasons.push("migration_version_mismatch");
  if (inspection.requiredTables !== RENT_OPS_MIGRATION_REQUIRED_TABLES.length) reasons.push("rent_ops_schema_missing");
  if (options.affirmativeGate?.phrase !== (options.targetClassification === "production" ? APPLY_RENT_OPS_PRODUCTION_PHRASE : APPLY_RENT_OPS_STAGING_PHRASE) || typeof options.affirmativeGate.nonce !== "string" || options.affirmativeGate.nonce.length < 8 || options.affirmativeGate.nonce.length > 200) reasons.push("affirmative_apply_gate_missing");
  return reasons;
}

function missingInspectionGateReasons(options: PersistenceImporterOptions): string[] {
  const reasons: string[] = [];
  if (options.targetClassification !== "staging" && options.targetClassification !== "production") reasons.push("target_not_classified_staging");
  reasons.push(...forbiddenFingerprintPolicyReasons(options));
  if (!options.expectedDatabaseFingerprint || !validFingerprint(options.expectedDatabaseFingerprint)) reasons.push("expected_database_fingerprint_missing_or_invalid");
  const backup = options.backupAttestation;
  if (!backup?.verified || (!backup.attestationId && !backup.reference) || !backup.verifiedAt) reasons.push("verified_backup_attestation_missing");
  if (!options.expectedMigrationChecksum || !SHA256_RE.test(options.expectedMigrationChecksum)) reasons.push("expected_migration_checksum_missing_or_invalid");
  if (!options.renderedMigrationChecksum || !SHA256_RE.test(options.renderedMigrationChecksum)) reasons.push("rendered_migration_checksum_missing_or_invalid");
  else if (options.renderedMigrationChecksum !== options.expectedMigrationChecksum) reasons.push("rendered_migration_checksum_mismatch");
  if (options.actualDatabaseFingerprint && !validFingerprint(options.actualDatabaseFingerprint)) reasons.push("actual_database_fingerprint_missing_or_invalid");
  if (options.affirmativeGate?.phrase !== (options.targetClassification === "production" ? APPLY_RENT_OPS_PRODUCTION_PHRASE : APPLY_RENT_OPS_STAGING_PHRASE) || typeof options.affirmativeGate.nonce !== "string" || options.affirmativeGate.nonce.length < 8 || options.affirmativeGate.nonce.length > 200) reasons.push("affirmative_apply_gate_missing");
  return reasons;
}

function descriptors(snapshot: RentOpsSnapshot, financialSemanticCrosswalk?: RentManagerFinancialSemanticCrosswalk): CollectionDescriptor[] {
  const source = (record: { source?: { system: string; sourceId: string } }): [unknown, unknown] => sourcePair(record.source);
  const collections: CollectionDescriptor[] = [
    { name: "properties", table: "rent_ops_properties", records: snapshot.properties, columns: ["id", "name", "slug", "address_line1", "address_line2", "city", "state", "postal_code", "property_type", "state_status", "operating_contact", "name_knowledge", "address_knowledge", "property_type_knowledge", "state_knowledge", "operating_contact_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsProperty; return [row.id, nullable(row.name), row.slug, nullable(row.address.line1), nullable(row.address.line2), nullable(row.address.city), nullable(row.address.state), nullable(row.address.postalCode), nullable(row.propertyType), nullable(row.state), nullable(row.operatingContact), nullable(row.nameKnowledge), nullable(row.addressKnowledge), nullable(row.propertyTypeKnowledge), nullable(row.stateKnowledge), nullable(row.operatingContactKnowledge), ...source(row)]; } },
    { name: "units", table: "rent_ops_units", records: snapshot.units, columns: ["id", "property_id", "unit_number", "unit_type", "bedrooms", "bathrooms", "square_feet", "market_rent_cents", "default_deposit_cents", "readiness", "listing", "property_link_knowledge", "unit_number_knowledge", "unit_type_knowledge", "readiness_knowledge", "listing_knowledge", "amenities", "access_notes", "source_system", "source_id"], values: (record) => { const row = record as RentOpsUnit; return [row.id, nullable(row.propertyId), nullable(row.unitNumber), nullable(row.unitType), nullable(row.bedrooms), nullable(row.bathrooms), nullable(row.squareFeet), nullable(row.marketRentCents), nullable(row.defaultDepositCents), nullable(row.readiness), nullable(row.listing), nullable(row.propertyLinkKnowledge), nullable(row.unitNumberKnowledge), nullable(row.unitTypeKnowledge), nullable(row.readinessKnowledge), nullable(row.listingKnowledge), jsonValue(row.amenities), nullable(row.accessNotes), ...source(row)]; } },
    { name: "people", table: "rent_ops_people", records: snapshot.people, columns: ["id", "first_name", "last_name", "email", "phone", "phone_methods", "first_name_knowledge", "last_name_knowledge", "email_knowledge", "phone_knowledge", "renter_insurance_expires_on", "archived", "archived_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsPerson; return [row.id, nullable(row.firstName), nullable(row.lastName), nullable(row.email), nullable(row.phone), jsonValue(row.phoneMethods), nullable(row.firstNameKnowledge), nullable(row.lastNameKnowledge), nullable(row.emailKnowledge), nullable(row.phoneKnowledge), nullable(row.renterInsuranceExpiresOn), nullable(row.archived), nullable(row.archivedKnowledge), ...source(row)]; } },
    { name: "applications", table: "rent_ops_applications", records: snapshot.applications, columns: ["id", "source_type", "status", "email", "first_name", "last_name", "phone", "property_id", "unit_id", "submitted_on", "certification_accepted_on", "resume_token_hash", "resume_token_expires_at", "converted_tenancy_id", "rental_history", "employment", "household_summary", "preferences", "voucher", "pets", "vehicles", "emergency_contact", "profile_answers", "source_type_knowledge", "status_knowledge", "email_knowledge", "first_name_knowledge", "last_name_knowledge", "phone_knowledge", "property_link_knowledge", "unit_link_knowledge", "submitted_on_knowledge", "certification_accepted_on_knowledge", "created_at_knowledge", "updated_at_knowledge", "source_system", "source_id", "created_at", "updated_at"], values: (record) => { const row = record as RentOpsApplicationRecord; return [row.id, nullable(row.sourceType), nullable(row.status), nullable(row.email), nullable(row.firstName), nullable(row.lastName), nullable(row.phone), nullable(row.propertyId), nullable(row.unitId), nullable(row.submittedOn), nullable(row.certificationAcceptedOn), nullable(row.resumeTokenHash), nullable(row.resumeTokenExpiresAt), nullable(row.convertedTenancyId), jsonValue(row.rentalHistory), jsonValue(row.employment), jsonValue(row.householdSummary), jsonValue(row.preferences), jsonValue(row.voucher), jsonValue(row.pets), jsonValue(row.vehicles), jsonValue(row.emergencyContact), jsonValue(row.profileAnswers), nullable(row.sourceTypeKnowledge), nullable(row.statusKnowledge), nullable(row.emailKnowledge), nullable(row.firstNameKnowledge), nullable(row.lastNameKnowledge), nullable(row.phoneKnowledge), nullable(row.propertyLinkKnowledge), nullable(row.unitLinkKnowledge), nullable(row.submittedOnKnowledge), nullable(row.certificationAcceptedOnKnowledge), nullable(row.createdAtKnowledge), nullable(row.updatedAtKnowledge), ...source(row), nullable(row.createdAt), nullable(row.updatedAt)]; } },
    { name: "applicationHouseholdMembers", table: "rent_ops_application_household_members", records: snapshot.applicationHouseholdMembers, columns: ["id", "application_id", "first_name", "last_name", "relationship", "email", "phone", "is_minor"], values: (record) => { const row = record as RentOpsApplicationHouseholdMember; return [row.id, row.applicationId, row.firstName, row.lastName, nullable(row.relationship), nullable(row.email), nullable(row.phone), row.isMinor]; } },
    { name: "applicationRequirements", table: "rent_ops_application_requirements", records: snapshot.applicationRequirements, columns: ["id", "application_id", "key", "label", "status", "document_id", "requested_on", "resolved_on"], values: (record) => { const row = record as RentOpsApplicationRequirement; return [row.id, row.applicationId, row.key, row.label, row.status, nullable(row.documentId), row.requestedOn, nullable(row.resolvedOn)]; } },
    { name: "tenancies", table: "rent_ops_tenancies", records: snapshot.tenancies, columns: ["id", "property_id", "unit_id", "primary_person_id", "status", "planned_move_in_on", "actual_move_in_on", "notice_on", "expected_move_out_on", "actual_move_out_on", "application_id", "created_at", "ended_at", "property_link_knowledge", "unit_link_knowledge", "primary_person_link_knowledge", "status_knowledge", "planned_move_in_knowledge", "actual_move_in_knowledge", "notice_knowledge", "expected_move_out_knowledge", "actual_move_out_knowledge", "created_at_knowledge", "ended_at_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsTenancy; return [row.id, nullable(row.propertyId), nullable(row.unitId), nullable(row.primaryPersonId), nullable(row.status), nullable(row.plannedMoveInOn), nullable(row.actualMoveInOn), nullable(row.noticeOn), nullable(row.expectedMoveOutOn), nullable(row.actualMoveOutOn), nullable(row.applicationId), nullable(row.createdAt), nullable(row.endedAt), nullable(row.propertyLinkKnowledge), nullable(row.unitLinkKnowledge), nullable(row.primaryPersonLinkKnowledge), nullable(row.statusKnowledge), nullable(row.plannedMoveInKnowledge), nullable(row.actualMoveInKnowledge), nullable(row.noticeKnowledge), nullable(row.expectedMoveOutKnowledge), nullable(row.actualMoveOutKnowledge), nullable(row.createdAtKnowledge), nullable(row.endedAtKnowledge), ...source(row)]; } },
    { name: "householdMemberships", table: "rent_ops_household_memberships", records: snapshot.householdMemberships, columns: ["id", "tenancy_id", "application_id", "account_person_id", "person_id", "role", "relationship", "is_financially_responsible", "role_knowledge", "relationship_knowledge", "responsibility_knowledge"], values: (record) => { const row = record as RentOpsHouseholdMembership; return [row.id, nullable(row.tenancyId), nullable(row.applicationId), nullable(row.accountPersonId), row.personId, nullable(row.role), nullable(row.relationship), nullable(row.isFinanciallyResponsible), nullable(row.roleKnowledge), nullable(row.relationshipKnowledge), nullable(row.responsibilityKnowledge)]; } },
    { name: "leaseTerms", table: "rent_ops_lease_terms", records: snapshot.leaseTerms, columns: ["id", "tenancy_id", "status", "contract_start_on", "contract_end_on", "month_to_month", "signed_on", "executed_document_id", "renewal_of_id", "created_at", "tenancy_link_knowledge", "status_knowledge", "contract_start_knowledge", "contract_end_knowledge", "signed_on_knowledge", "month_to_month_knowledge", "created_at_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsLeaseTerm; return [row.id, nullable(row.tenancyId), nullable(row.status), nullable(row.contractStartOn), nullable(row.contractEndOn), nullable(row.monthToMonth), nullable(row.signedOn), nullable(row.executedDocumentId), nullable(row.renewalOfId), nullable(row.createdAt), nullable(row.tenancyLinkKnowledge), nullable(row.statusKnowledge), nullable(row.contractStartKnowledge), nullable(row.contractEndKnowledge), nullable(row.signedOnKnowledge), nullable(row.monthToMonthKnowledge), nullable(row.createdAtKnowledge), ...source(row)]; } },
    { name: "chargeDefinitions", table: "rent_ops_charge_definitions", records: snapshot.chargeDefinitions, columns: ["id", "display_name", "display_name_knowledge", "category", "category_knowledge", "active", "active_knowledge", "record_revision", "source_artifact_sha256", "artifact_observation_on", "source_system", "source_id"], values: (record) => { const row = record as RentOpsChargeDefinition; return [row.id, nullable(row.displayName), nullable(row.displayNameKnowledge), nullable(row.category), nullable(row.categoryKnowledge), nullable(row.active), nullable(row.activeKnowledge), nullable(row.recordRevision), nullable(row.sourceArtifactSha256), nullable(row.artifactObservationOn), ...source(row)]; }, immutable: true },
    { name: "recurringSchedules", table: "rent_ops_recurring_charge_schedules", records: snapshot.recurringSchedules, columns: ["id", "scope_type", "scope_id", "scope_type_knowledge", "scope_link_knowledge", "charge_definition_id", "charge_definition_key", "tenancy_id", "person_id", "property_id", "unit_id", "category", "category_knowledge", "description", "description_knowledge", "amount_cents", "amount_knowledge", "effective_from", "effective_from_knowledge", "effective_to", "active", "active_knowledge", "source_confidence", "charge_definition_knowledge", "charge_definition_link_knowledge", "source_artifact_sha256", "artifact_observation_on", "lineage_root_id", "lineage_root_origin", "version_origin", "supersedes_id", "version_action", "record_revision", "source_system", "source_id"], values: (record) => { const row = record as RentOpsRecurringChargeSchedule; return [row.id, nullable(row.scopeType), nullable(row.scopeId), nullable(row.scopeTypeKnowledge), nullable(row.scopeLinkKnowledge), nullable(row.chargeDefinitionId), nullable(row.chargeDefinitionKey), nullable(row.tenancyId), nullable(row.personId), nullable(row.propertyId), nullable(row.unitId), nullable(row.category), nullable(row.categoryKnowledge), nullable(row.description), nullable(row.descriptionKnowledge), nullable(row.amountCents), nullable(row.amountKnowledge), nullable(row.effectiveFrom), nullable(row.effectiveFromKnowledge), nullable(row.effectiveTo), nullable(row.active), nullable(row.activeKnowledge), nullable(row.sourceConfidence), nullable(row.chargeDefinitionKnowledge), nullable(row.chargeDefinitionLinkKnowledge), nullable(row.sourceArtifactSha256), nullable(row.artifactObservationOn), nullable(row.lineageRootId), nullable(row.lineageRootOrigin), nullable(row.versionOrigin), nullable(row.supersedesId), nullable(row.versionAction), nullable(row.recordRevision), ...source(row)]; }, immutable: true },
    { name: "ledgerTransactions", table: "rent_ops_ledger_transactions", records: snapshot.ledgerTransactions, columns: ["id", "property_id", "unit_id", "tenancy_id", "person_id", "kind", "category", "category_knowledge", "status", "amount_cents", "posted_on", "due_on", "payment_method", "payment_method_knowledge", "description", "reversal_of_id", "payer", "payer_knowledge", "adjustment_direction", "property_link_knowledge", "unit_link_knowledge", "tenancy_link_knowledge", "person_link_knowledge", "amount_knowledge", "posted_on_knowledge", "due_on_knowledge", "description_knowledge", "status_knowledge", "allocation_mode", "charge_definition_id", "charge_definition_link_knowledge", "source_artifact_sha256", "artifact_observation_on", "source_system", "source_id", "source_updated_at"], values: (record) => { const row = record as RentOpsLedgerTransaction; return [row.id, nullable(row.propertyId), nullable(row.unitId), nullable(row.tenancyId), nullable(row.personId), nullable(row.kind), nullable(row.category), nullable(row.categoryKnowledge), nullable(row.status), nullable(row.amountCents), nullable(row.postedOn), nullable(row.dueOn), nullable(row.paymentMethod), nullable(row.paymentMethodKnowledge), nullable(row.description), nullable(row.reversalOfId), nullable(row.payer), nullable(row.payerKnowledge), nullable(row.adjustmentDirection), nullable(row.propertyLinkKnowledge), nullable(row.unitLinkKnowledge), nullable(row.tenancyLinkKnowledge), nullable(row.personLinkKnowledge), nullable(row.amountKnowledge), nullable(row.postedOnKnowledge), nullable(row.dueOnKnowledge), nullable(row.descriptionKnowledge), nullable(row.statusKnowledge), nullable(row.allocationMode), nullable(row.chargeDefinitionId), nullable(row.chargeDefinitionLinkKnowledge), nullable(row.sourceArtifactSha256), nullable(row.artifactObservationOn), ...source(row), nullable(row.source?.sourceUpdatedAt)]; }, appendOnly: true },
    { name: "paymentAllocations", table: "rent_ops_payment_allocations", records: snapshot.paymentAllocations, columns: ["id", "payment_transaction_id", "charge_transaction_id", "amount_cents", "allocated_on", "payment_link_knowledge", "charge_link_knowledge", "amount_knowledge", "allocated_on_knowledge", "source_system", "source_id", "kind", "source_artifact_sha256", "artifact_observation_on", "source_updated_at", "credit_transaction_id", "credit_link_knowledge", "source_property_id"], values: (record) => { const row = record as RentOpsPaymentAllocation; return [row.id, nullable(row.paymentTransactionId), nullable(row.chargeTransactionId), nullable(row.amountCents), nullable(row.allocatedOn), nullable(row.paymentLinkKnowledge), nullable(row.chargeLinkKnowledge), nullable(row.amountKnowledge), nullable(row.allocatedOnKnowledge), ...source(row), row.kind ?? "allocation", nullable(row.sourceArtifactSha256), nullable(row.artifactObservationOn), nullable(row.source?.sourceUpdatedAt), nullable(row.creditTransactionId), nullable(row.creditLinkKnowledge), nullable(row.sourcePropertyId)]; }, appendOnly: true },
    { name: "securityDeposits", table: "rent_ops_security_deposits", records: snapshot.securityDeposits, columns: ["id", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge", "tenancy_id", "person_id", "person_link_knowledge", "type", "type_knowledge", "amount_held_cents", "source_balance_cents", "received_on", "received_on_knowledge", "disposition_status", "disposition_status_knowledge", "disposed_on", "disposition_notes", "source_system", "source_id"], values: (record) => { const row = record as RentOpsSecurityDeposit; return [row.id, nullable(row.propertyId), nullable(row.propertyLinkKnowledge), nullable(row.unitId), nullable(row.unitLinkKnowledge), nullable(row.tenancyId), nullable(row.personId), nullable(row.personLinkKnowledge), nullable(row.type), nullable(row.typeKnowledge), row.amountHeldCents, nullable(row.sourceBalanceCents), nullable(row.receivedOn), nullable(row.receivedOnKnowledge), nullable(row.dispositionStatus), nullable(row.dispositionStatusKnowledge), nullable(row.disposedOn), nullable(row.dispositionNotes), ...source(row)]; } },
    { name: "subsidyContracts", table: "rent_ops_subsidy_contracts", records: snapshot.subsidyContracts, columns: ["id", "property_id", "unit_id", "tenancy_id", "agency_name", "contract_number", "effective_from", "effective_to", "agency_obligation_cents", "tenant_obligation_cents", "status", "status_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsSubsidyContract; return [row.id, row.propertyId, row.unitId, row.tenancyId, row.agencyName, nullable(row.contractNumber), row.effectiveFrom, nullable(row.effectiveTo), row.agencyObligationCents, row.tenantObligationCents, nullable(row.status), nullable(row.statusKnowledge), ...source(row)]; } },
    { name: "subsidyTenants", table: "rent_ops_subsidy_tenants", records: snapshot.subsidyTenants, columns: ["id", "subsidy_contract_id", "subsidy_contract_link_knowledge", "tenancy_id", "tenancy_link_knowledge", "person_id", "person_link_knowledge", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge", "effective_from", "effective_from_knowledge", "effective_to", "effective_to_knowledge", "amount_cents", "amount_knowledge", "payer", "payer_knowledge", "status", "status_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsSubsidyTenant; return [row.id, nullable(row.subsidyContractId), nullable(row.subsidyContractLinkKnowledge), nullable(row.tenancyId), nullable(row.tenancyLinkKnowledge), nullable(row.personId), nullable(row.personLinkKnowledge), nullable(row.propertyId), nullable(row.propertyLinkKnowledge), nullable(row.unitId), nullable(row.unitLinkKnowledge), nullable(row.effectiveFrom), nullable(row.effectiveFromKnowledge), nullable(row.effectiveTo), nullable(row.effectiveToKnowledge), nullable(row.amountCents), nullable(row.amountKnowledge), nullable(row.payer), nullable(row.payerKnowledge), nullable(row.status), nullable(row.statusKnowledge), ...source(row)]; } },
    { name: "subsidyPayments", table: "rent_ops_subsidy_payments", records: snapshot.subsidyPayments, columns: ["id", "subsidy_contract_id", "subsidy_contract_link_knowledge", "subsidy_tenant_id", "subsidy_tenant_link_knowledge", "tenancy_id", "tenancy_link_knowledge", "person_id", "person_link_knowledge", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge", "payment_transaction_id", "payment_link_knowledge", "payment_on", "payment_on_knowledge", "amount_cents", "amount_knowledge", "payer", "payer_knowledge", "status", "status_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsSubsidyPayment; return [row.id, nullable(row.subsidyContractId), nullable(row.subsidyContractLinkKnowledge), nullable(row.subsidyTenantId), nullable(row.subsidyTenantLinkKnowledge), nullable(row.tenancyId), nullable(row.tenancyLinkKnowledge), nullable(row.personId), nullable(row.personLinkKnowledge), nullable(row.propertyId), nullable(row.propertyLinkKnowledge), nullable(row.unitId), nullable(row.unitLinkKnowledge), nullable(row.paymentTransactionId), nullable(row.paymentLinkKnowledge), nullable(row.paymentOn), nullable(row.paymentOnKnowledge), nullable(row.amountCents), nullable(row.amountKnowledge), nullable(row.payer), nullable(row.payerKnowledge), nullable(row.status), nullable(row.statusKnowledge), ...source(row)]; } },
    { name: "documents", table: "rent_ops_documents", records: snapshot.documents, columns: ["id", "property_id", "unit_id", "person_id", "tenancy_id", "application_id", "type", "state", "file_name", "mime_type", "size_bytes", "checksum_sha256", "storage_key", "uploaded_at", "verified_at", "availability", "storage_key_knowledge", "metadata_size_bytes", "metadata_checksum_sha256", "source_system", "source_id"], values: (record) => { const row = record as RentOpsDocument; return [row.id, nullable(row.propertyId), nullable(row.unitId), nullable(row.personId), nullable(row.tenancyId), nullable(row.applicationId), nullable(row.type), nullable(row.state), nullable(row.fileName), nullable(row.mimeType), nullable(row.sizeBytes), nullable(row.checksumSha256), nullable(row.storageKey), nullable(row.uploadedAt), nullable(row.verifiedAt), nullable(row.availability), nullable(row.storageKeyKnowledge), nullable(row.metadataSizeBytes), nullable(row.metadataChecksumSha256), ...source(row)]; } },
    { name: "activityEvents", table: "rent_ops_activity_events", records: snapshot.activityEvents, columns: ["id", "property_id", "unit_id", "person_id", "tenancy_id", "application_id", "type", "occurred_at", "actor", "summary", "detail", "occurred_at_knowledge", "actor_knowledge", "summary_knowledge", "type_knowledge", "property_link_knowledge", "unit_link_knowledge", "person_link_knowledge", "tenancy_link_knowledge", "application_link_knowledge", "source_system", "source_id"], values: (record) => { const row = record as RentOpsActivityEvent; return [row.id, nullable(row.propertyId), nullable(row.unitId), nullable(row.personId), nullable(row.tenancyId), nullable(row.applicationId), nullable(row.type), nullable(row.occurredAt), nullable(row.actor), nullable(row.summary), nullable(row.detail), nullable(row.occurredAtKnowledge), nullable(row.actorKnowledge), nullable(row.summaryKnowledge), nullable(row.typeKnowledge), nullable(row.propertyLinkKnowledge), nullable(row.unitLinkKnowledge), nullable(row.personLinkKnowledge), nullable(row.tenancyLinkKnowledge), nullable(row.applicationLinkKnowledge), ...source(row)]; }, appendOnly: true },
  ];
  if (snapshot.applicationHistory) {
    const history = snapshot.applicationHistory;
    const historySource = (record: { source: { system: string; sourceId: string; sourceUpdatedAt?: string } }): [unknown, unknown, unknown] => [record.source.system, record.source.sourceId, nullable(record.source.sourceUpdatedAt)];
    const historyBlockerId = (record: RentOpsApplicationHistoryBlocker): string => `rm-history:blocker:${sha256(`${record.code}\u0000${record.applicationId ?? ""}\u0000${record.prospectId ?? ""}`).slice(0, 40)}`;
    collections.push(
      {
        name: "applicationHistoryProspects",
        table: "rent_ops_prospects",
        records: history.prospects,
        columns: ["id", "source_system", "source_id", "source_updated_at", "person_id", "person_link_knowledge", "contact_id", "contact_link_knowledge", "first_name", "last_name", "email", "phone", "status", "status_knowledge", "created_on", "created_on_knowledge", "updated_on", "updated_on_knowledge", "record_revision"],
        values: (record) => { const row = record as RentOpsProspect; return [row.id, ...historySource(row), nullable(row.personId), nullable(row.personLinkKnowledge), nullable(row.contactId), nullable(row.contactLinkKnowledge), nullable(row.firstName), nullable(row.lastName), nullable(row.email), nullable(row.phone), nullable(row.status), nullable(row.statusKnowledge), nullable(row.createdOn), nullable(row.createdOnKnowledge), nullable(row.updatedOn), nullable(row.updatedOnKnowledge), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryApplications",
        table: "rent_ops_application_history",
        records: history.applications,
        columns: ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "person_id", "person_link_knowledge", "first_name", "last_name", "email", "phone", "status", "status_knowledge", "submitted_on", "submitted_on_knowledge", "created_on", "created_on_knowledge", "updated_on", "updated_on_knowledge", "record_revision"],
        values: (record) => { const row = record as RentOpsHistoricalApplication; return [row.id, ...historySource(row), nullable(row.prospectId), nullable(row.prospectLinkKnowledge), nullable(row.personId), nullable(row.personLinkKnowledge), nullable(row.firstName), nullable(row.lastName), nullable(row.email), nullable(row.phone), nullable(row.status), nullable(row.statusKnowledge), nullable(row.submittedOn), nullable(row.submittedOnKnowledge), nullable(row.createdOn), nullable(row.createdOnKnowledge), nullable(row.updatedOn), nullable(row.updatedOnKnowledge), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryTemplates",
        table: "rent_ops_application_template_definitions",
        records: history.templates,
        columns: ["id", "source_system", "source_id", "source_updated_at", "name", "name_knowledge", "active", "active_knowledge", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationTemplateDefinition; return [row.id, ...historySource(row), nullable(row.name), nullable(row.nameKnowledge), nullable(row.active), nullable(row.activeKnowledge), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryTemplateSections",
        table: "rent_ops_application_template_sections",
        records: history.templateSections,
        columns: ["id", "source_system", "source_id", "source_updated_at", "template_id", "template_link_knowledge", "name", "name_knowledge", "source_order", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationTemplateSectionDefinition; return [row.id, ...historySource(row), nullable(row.templateId), nullable(row.templateLinkKnowledge), nullable(row.name), nullable(row.nameKnowledge), nullable(row.sourceOrder), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryTemplateFields",
        table: "rent_ops_application_template_fields",
        records: history.templateFields,
        columns: ["id", "source_system", "source_id", "source_updated_at", "template_id", "template_link_knowledge", "section_id", "section_link_knowledge", "key", "label", "value_type", "sensitive", "source_order", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationTemplateFieldDefinition; return [row.id, ...historySource(row), nullable(row.templateId), nullable(row.templateLinkKnowledge), nullable(row.sectionId), nullable(row.sectionLinkKnowledge), nullable(row.key), nullable(row.label), nullable(row.valueType), nullable(row.sensitive), nullable(row.sourceOrder), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryInterests",
        table: "rent_ops_application_interests",
        records: history.interests,
        columns: ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge", "source_order", "source_rank", "preference", "preference_knowledge", "interested_on", "interested_on_knowledge", "rent_cents", "rent_knowledge", "bedrooms", "bedrooms_knowledge", "status", "status_knowledge", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationInterest; return [row.id, ...historySource(row), nullable(row.prospectId), nullable(row.prospectLinkKnowledge), nullable(row.applicationId), nullable(row.applicationLinkKnowledge), nullable(row.propertyId), nullable(row.propertyLinkKnowledge), nullable(row.unitId), nullable(row.unitLinkKnowledge), nullable(row.sourceOrder), nullable(row.sourceRank), nullable(row.preference), nullable(row.preferenceKnowledge), nullable(row.interestedOn), nullable(row.interestedOnKnowledge), nullable(row.rentCents), nullable(row.rentKnowledge), nullable(row.bedrooms), nullable(row.bedroomsKnowledge), nullable(row.status), nullable(row.statusKnowledge), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryParticipants",
        table: "rent_ops_application_participants",
        records: history.participants,
        columns: ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "person_id", "person_link_knowledge", "source_order", "role", "role_knowledge", "relationship", "relationship_knowledge", "is_minor", "minor_knowledge", "is_financially_responsible", "financial_responsibility_knowledge", "origin", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationParticipant; return [row.id, ...historySource(row), nullable(row.prospectId), nullable(row.prospectLinkKnowledge), nullable(row.applicationId), nullable(row.applicationLinkKnowledge), nullable(row.personId), nullable(row.personLinkKnowledge), nullable(row.sourceOrder), nullable(row.role), nullable(row.roleKnowledge), nullable(row.relationship), nullable(row.relationshipKnowledge), nullable(row.isMinor), nullable(row.minorKnowledge), nullable(row.isFinanciallyResponsible), nullable(row.financialResponsibilityKnowledge), nullable(row.origin), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryDocuments",
        table: "rent_ops_application_history_documents",
        records: history.documents,
        columns: ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "type", "type_knowledge", "state", "state_knowledge", "file_name", "mime_type", "metadata_size_bytes", "metadata_checksum_sha256", "availability", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationHistoryDocument; return [row.id, ...historySource(row), nullable(row.prospectId), nullable(row.prospectLinkKnowledge), nullable(row.applicationId), nullable(row.applicationLinkKnowledge), nullable(row.type), nullable(row.typeKnowledge), nullable(row.state), nullable(row.stateKnowledge), nullable(row.fileName), nullable(row.mimeType), nullable(row.metadataSizeBytes), nullable(row.metadataChecksumSha256), row.availability, nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryRequirements",
        table: "rent_ops_application_requirement_occurrences",
        records: history.requirements,
        columns: ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "key", "label", "status", "status_knowledge", "requested_on", "requested_on_knowledge", "resolved_on", "resolved_on_knowledge", "document_id", "document_link_knowledge", "origin", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationRequirementOccurrence; return [row.id, ...historySource(row), nullable(row.prospectId), nullable(row.prospectLinkKnowledge), nullable(row.applicationId), nullable(row.applicationLinkKnowledge), nullable(row.key), nullable(row.label), nullable(row.status), nullable(row.statusKnowledge), nullable(row.requestedOn), nullable(row.requestedOnKnowledge), nullable(row.resolvedOn), nullable(row.resolvedOnKnowledge), nullable(row.documentId), nullable(row.documentLinkKnowledge), nullable(row.origin), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryAnswers",
        table: "rent_ops_application_answer_occurrences",
        records: history.answers,
        columns: ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "field_id", "field_link_knowledge", "value_type", "safe_value", "value_knowledge", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationAnswerOccurrence; return [row.id, ...historySource(row), nullable(row.prospectId), nullable(row.prospectLinkKnowledge), nullable(row.applicationId), nullable(row.applicationLinkKnowledge), nullable(row.fieldId), nullable(row.fieldLinkKnowledge), row.valueType, jsonValue(row.value), row.valueKnowledge, nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryActivities",
        table: "rent_ops_application_history_activities",
        records: history.activities,
        columns: ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "type", "occurred_at", "occurred_at_knowledge", "actor", "actor_knowledge", "summary", "summary_knowledge", "record_revision"],
        values: (record) => { const row = record as RentOpsApplicationHistoryActivity; return [row.id, ...historySource(row), nullable(row.prospectId), nullable(row.prospectLinkKnowledge), nullable(row.applicationId), nullable(row.applicationLinkKnowledge), nullable(row.type), nullable(row.occurredAt), nullable(row.occurredAtKnowledge), nullable(row.actor), nullable(row.actorKnowledge), nullable(row.summary), nullable(row.summaryKnowledge), nullable(row.recordRevision)]; },
        immutable: true,
      },
      {
        name: "applicationHistoryBlockers",
        table: "rent_ops_application_history_blockers",
        records: history.blockers,
        columns: ["id", "code", "application_id", "prospect_id", "occurrence_count", "reason"],
        values: (record) => { const row = record as RentOpsApplicationHistoryBlocker; return [historyBlockerId(row), row.code, nullable(row.applicationId), nullable(row.prospectId), row.occurrenceCount, row.reason]; },
        immutable: true,
      },
      {
        name: "applicationHistoryAggregate",
        table: "rent_ops_application_history_aggregates",
        records: [history.unknownRestricted],
        columns: ["id", "restricted_answer_count", "unmapped_answer_count", "missing_answer_applications", "metadata_only_document_count", "unavailable_document_count", "unlinked_activity_count", "unlinked_interest_count", "record_revision"],
        values: (record) => { const value = record as RentOpsApplicationHistorySnapshot["unknownRestricted"]; return ["rent-ops-application-history", value.restrictedAnswerCount, value.unmappedAnswerCount, value.missingAnswerApplications, value.metadataOnlyDocumentCount, value.unavailableDocumentCount, value.unlinkedActivityCount, value.unlinkedInterestCount, 1]; },
        immutable: true,
      },
    );
  }
  if (financialSemanticCrosswalk) {
    collections.push({
      name: "financialSemanticCrosswalk",
      table: "rent_ops_financial_semantic_crosswalks",
      records: financialSemanticCrosswalk.entries,
      columns: ["id", "artifact_sha256", "source_collection", "source_field", "semantic_kind", "normalization", "normalized_value", "target_value"],
      values: (record) => {
        const entry = record as RentManagerFinancialSemanticCrosswalk["entries"][number];
        const id = `rm:financial-crosswalk:${sha256(canonicalJson(entry))}`;
        return [id, entry.artifactSha256, entry.sourceCollection, entry.sourceField, entry.semanticKind, entry.normalization, entry.normalizedValue, entry.targetValue];
      },
      immutable: true,
    });
  }
  return collections;
}

/**
 * Keep every statement well below PostgreSQL's parameter ceiling while still
 * collapsing the live RM import from one statement per row into deterministic
 * bounded batches. The widest normal table has 27 columns, so 100 rows uses
 * only 2,700 bind parameters (well below 65,535).
 */
export const PERSISTENCE_IMPORT_BATCH_SIZE = 100;

function chunks<T>(records: readonly T[], size = PERSISTENCE_IMPORT_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < records.length; index += size) result.push(Array.from(records.slice(index, index + size)));
  return result;
}

function rowPlaceholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => `(${Array.from({ length: columnCount }, (_, columnIndex) => `$${rowIndex * columnCount + columnIndex + 1}`).join(", ")})`).join(", ");
}

function flattenedRows(rows: readonly unknown[][], columnCount: number): unknown[] {
  const values: unknown[] = [];
  for (const row of rows) {
    if (row.length !== columnCount) throw new PersistenceImportPreconditionError(["import_row_shape_invalid"]);
    values.push(...row.map(nullable));
  }
  return values;
}

async function bulkUpsert(
  executor: RentOpsQueryExecutor,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  appendOnly = false,
  conflictColumns: readonly string[] = ["id"],
  updateColumns: readonly string[] = columns.slice(1),
  immutable = false,
): Promise<void> {
  if (rows.length === 0) return;
  const columnList = columns.join(", ");
  // Imported provenance is immutable after insert. The database trigger is
  // the final guard; keeping source columns out of runtime upsert updates
  // prevents an admin save from clearing/rebinding them.
  const immutableProvenance = new Set(["source_system", "source_id"]);
  const safeUpdateColumns = updateColumns.filter((column) => !immutableProvenance.has(column));
  const update = safeUpdateColumns.map((column) => `${column}=EXCLUDED.${column}`).join(", ");
  const conflict = immutable || appendOnly || safeUpdateColumns.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${update}`;
  for (const batch of chunks(rows)) {
    await executor.query(
      `INSERT INTO ${table} (${columnList}) VALUES ${rowPlaceholders(batch.length, columns.length)} ON CONFLICT (${conflictColumns.join(", ")}) ${conflict}`,
      flattenedRows(batch, columns.length),
    );
  }
}

function sameImmutableValue(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return (left === null || left === undefined) && (right === null || right === undefined);
  if (left instanceof Date || right instanceof Date) {
    if (left instanceof Date && right instanceof Date) return left.toISOString() === right.toISOString();
    const date = left instanceof Date ? left : right as Date;
    const other = left instanceof Date ? right : left;
    if (typeof other !== "string") return false;
    const iso = date.toISOString();
    return other === iso || (other.length === 10 && iso.slice(0, 10) === other);
  }
  if (typeof left === "object" || typeof right === "object") {
    const leftJson = typeof left === "string" ? (() => { try { return canonicalJson(JSON.parse(left)); } catch { return left; } })() : canonicalJson(left);
    const rightJson = typeof right === "string" ? (() => { try { return canonicalJson(JSON.parse(right)); } catch { return right; } })() : canonicalJson(right);
    return leftJson === rightJson;
  }
  return Object.is(left, right);
}

async function assertExistingImmutableRows(executor: RentOpsQueryExecutor, descriptor: CollectionDescriptor): Promise<void> {
  if (!descriptor.immutable) return;
  const sourceSystemIndex = descriptor.columns.indexOf("source_system");
  const sourceIdIndex = descriptor.columns.indexOf("source_id");
  for (const record of descriptor.records) {
    const expected = descriptor.values(record);
    const id = expected[0];
    const existing = await executor.query<Record<string, unknown>>(
      `SELECT ${descriptor.columns.join(", ")} FROM ${descriptor.table} WHERE id = $1`,
      [id],
    );
    const row = existing.rows[0];
    if (row) {
      const conflict = descriptor.columns.some((column, index) => !sameImmutableValue(row[column], nullable(expected[index])));
      if (conflict) throw new PersistenceImportPreconditionError([`immutable_${safeCode(descriptor.name)}_conflict`]);
    }
    if (sourceSystemIndex >= 0 && sourceIdIndex >= 0 && expected[sourceSystemIndex] !== null && expected[sourceSystemIndex] !== undefined && expected[sourceIdIndex] !== null && expected[sourceIdIndex] !== undefined) {
      const sourceRows = await executor.query<Record<string, unknown>>(
        `SELECT ${descriptor.columns.join(", ")} FROM ${descriptor.table} WHERE source_system = $1 AND source_id = $2`,
        [expected[sourceSystemIndex], expected[sourceIdIndex]],
      );
      for (const sourceRow of sourceRows.rows) {
        if (!sameImmutableValue(sourceRow.id, id)) throw new PersistenceImportPreconditionError([`immutable_${safeCode(descriptor.name)}_source_conflict`]);
        const conflict = descriptor.columns.some((column, index) => !sameImmutableValue(sourceRow[column], nullable(expected[index])));
        if (conflict) throw new PersistenceImportPreconditionError([`immutable_${safeCode(descriptor.name)}_conflict`]);
      }
    }
  }
}

async function upsertCollection(executor: RentOpsQueryExecutor, descriptor: CollectionDescriptor): Promise<void> {
  const rows = descriptor.records.map((record) => descriptor.values(record));
  await assertExistingImmutableRows(executor, descriptor);
  await bulkUpsert(executor, descriptor.table, descriptor.columns, rows, descriptor.appendOnly, ["id"], descriptor.columns.slice(1), descriptor.immutable === true);
  if (descriptor.immutable) await assertExistingImmutableRows(executor, descriptor);
}

interface PersistedDocumentObjectBindingRow {
  document_id?: unknown;
  binding_kind?: unknown;
  source_binary_id?: unknown;
  import_run_id?: unknown;
  source_system?: unknown;
  source_collection?: unknown;
  backend?: unknown;
  logical_key?: unknown;
  checksum_sha256?: unknown;
  size_bytes?: unknown;
  immutable_generation?: unknown;
  immutable_version?: unknown;
  verified_at?: unknown;
}

function bindingRow(binding: RentOpsDocumentObjectBinding): Record<string, unknown> {
  return {
    document_id: binding.documentId,
    binding_kind: binding.bindingKind,
    source_binary_id: binding.sourceBinaryId ?? null,
    import_run_id: binding.importRunId ?? null,
    source_system: binding.sourceSystem ?? null,
    source_collection: binding.sourceCollection ?? null,
    backend: binding.backend,
    logical_key: binding.logicalKey,
    checksum_sha256: binding.checksumSha256,
    size_bytes: binding.sizeBytes,
    immutable_generation: binding.immutableGeneration ?? null,
    immutable_version: binding.immutableVersion ?? null,
    verified_at: binding.verifiedAt,
  };
}

function sameBindingValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? "");
  return normalize(left) === normalize(right);
}

/**
 * Persist the storage service's exact object binding beside the imported
 * document.  The caller supplies the active import transaction; no second
 * connection or repository transaction is allowed here.  ON CONFLICT is
 * deliberately insert-only and verifies every immutable field on retries.
 */
async function persistTransferredDocumentBinding(executor: RentOpsQueryExecutor, binding: RentOpsDocumentObjectBinding): Promise<void> {
  const expected = bindingRow(binding);
  const columns = ["document_id", "binding_kind", "source_binary_id", "import_run_id", "source_system", "source_collection", "backend", "logical_key", "checksum_sha256", "size_bytes", "immutable_generation", "immutable_version", "verified_at"] as const;
  const values = columns.map((column) => expected[column]);
  const fields = columns as readonly string[];
  let inserted: { rows: PersistedDocumentObjectBindingRow[] };
  try {
    inserted = await executor.query<PersistedDocumentObjectBindingRow>(
      `INSERT INTO rent_ops_document_objects (${columns.join(", ")}) VALUES (${columns.map((_column, index) => `$${index + 1}`).join(", ")}) ON CONFLICT (document_id) DO NOTHING RETURNING ${columns.join(", ")}`,
      values,
    );
  } catch {
    throw new PersistenceImportPreconditionError(["restricted_document_binding_persistence_failed"]);
  }
  const matches = (row: PersistedDocumentObjectBindingRow | undefined): boolean => Boolean(row)
    && fields.every((field) => sameBindingValue(expected[field], (row as Record<string, unknown>)[field]));
  if (inserted.rows.length > 0) {
    if (!matches(inserted.rows[0])) throw new PersistenceImportPreconditionError(["restricted_document_binding_conflict"]);
    return;
  }
  let existing: { rows: PersistedDocumentObjectBindingRow[] };
  try {
    existing = await executor.query<PersistedDocumentObjectBindingRow>(
      `SELECT ${columns.join(", ")} FROM rent_ops_document_objects WHERE document_id = $1`,
      [binding.documentId],
    );
  } catch {
    throw new PersistenceImportPreconditionError(["restricted_document_binding_persistence_failed"]);
  }
  if (existing.rows.length !== 1 || !matches(existing.rows[0])) throw new PersistenceImportPreconditionError(["restricted_document_binding_conflict"]);
}

async function saveSourceRecords(executor: RentOpsQueryExecutor, records: readonly RentOpsSourceRecord[]): Promise<void> {
  const rows = records.map((record) => [record.id, record.system, record.entityType, record.sourceId, nullable(record.sourceUpdatedAt), record.importedAt, nullable(record.checksum), record.targetId, sourceMetadata(record)]);
  await bulkUpsert(
    executor,
    "rent_ops_source_records",
    ["id", "system", "entity_type", "source_id", "source_updated_at", "imported_at", "checksum", "target_id", "raw_metadata"],
    rows,
    false,
    ["system", "entity_type", "source_id"],
    ["source_updated_at", "imported_at", "checksum", "target_id", "raw_metadata"],
  );
}

async function saveImportRuns(executor: RentOpsQueryExecutor, runs: readonly RentOpsImportRun[]): Promise<void> {
  const rows = runs.map((importRun) => [importRun.id, importRun.system, importRun.startedAt, nullable(importRun.completedAt), importRun.mode, nullable(importRun.sourceManifestHash), JSON.stringify(importRun.counts), importRun.exceptionCount, importRun.status]);
  await bulkUpsert(
    executor,
    "rent_ops_import_runs",
    ["id", "system", "started_at", "completed_at", "mode", "source_manifest_hash", "counts", "exception_count", "status"],
    rows,
    false,
    ["id"],
    ["completed_at", "mode", "source_manifest_hash", "counts", "exception_count", "status"],
  );
}

function sourceRecordKey(system: string, entityType: string, sourceId: string): string {
  return `${system}\u0000${entityType}\u0000${sourceId}`;
}

async function assertExistingSourceRecords(executor: RentOpsQueryExecutor, records: readonly RentOpsSourceRecord[]): Promise<void> {
  const appendOnlyTypes = new Set(["ledger_transaction", "payment_allocation", "activity", "subsidy_tenant", "subsidy_payment"]);
  for (const batch of chunks(records)) {
    const sourceValues = batch.flatMap((record) => [record.system, record.entityType, record.sourceId]);
    const sourceTuples = rowPlaceholders(batch.length, 3);
    const existingBySource = await executor.query<{ id?: string; system?: string; entity_type?: string; source_id?: string; target_id?: string; checksum?: string }>(
      `SELECT id, system, entity_type, source_id, target_id, checksum FROM rent_ops_source_records WHERE (system, entity_type, source_id) IN (${sourceTuples})`,
      sourceValues,
    );
    const bySource = new Map(existingBySource.rows.map((row) => [sourceRecordKey(String(row.system ?? ""), String(row.entity_type ?? ""), String(row.source_id ?? "")), row]));
    const existingById = await executor.query<{ id?: string; system?: string; entity_type?: string; source_id?: string }>(
      "SELECT id, system, entity_type, source_id FROM rent_ops_source_records WHERE id = ANY($1::varchar[])",
      [batch.map((record) => record.id)],
    );
    const byId = new Map(existingById.rows.map((row) => [String(row.id ?? ""), row]));
    for (const record of batch) {
      const row = bySource.get(sourceRecordKey(record.system, record.entityType, record.sourceId));
      if (row) {
        if (row.target_id !== record.targetId) throw new PersistenceImportPreconditionError(["source_record_target_conflict"]);
        if (row.checksum !== record.checksum && appendOnlyTypes.has(record.entityType)) throw new PersistenceImportPreconditionError(["append_only_source_record_conflict"]);
      }
      const idRow = byId.get(record.id);
      if (idRow && (idRow.system !== record.system || idRow.entity_type !== record.entityType || idRow.source_id !== record.sourceId)) throw new PersistenceImportPreconditionError(["source_record_id_conflict"]);
    }
  }
}

async function assertExistingImportRuns(executor: RentOpsQueryExecutor, runs: readonly RentOpsImportRun[]): Promise<void> {
  const uniqueRuns = Array.from(new Map(runs.map((run) => [run.id, run])).values());
  for (const batch of chunks(uniqueRuns)) {
    const existing = await executor.query<{ id?: string; system?: string; source_manifest_hash?: string | null }>(
      "SELECT id, system, source_manifest_hash FROM rent_ops_import_runs WHERE id = ANY($1::varchar[])",
      [batch.map((run) => run.id)],
    );
    const byId = new Map(existing.rows.map((row) => [String(row.id ?? ""), row]));
    for (const run of batch) {
      const row = byId.get(run.id);
      if (row && (row.system !== run.system || (row.source_manifest_hash ?? null) !== (run.sourceManifestHash ?? null))) throw new PersistenceImportPreconditionError(["import_run_conflict"]);
    }
  }
}

async function assertSchemaReady(executor: RentOpsQueryExecutor): Promise<void> {
  try {
    const result = await executor.query<{ table_name?: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])", [Array.from(RENT_OPS_MIGRATION_REQUIRED_TABLES)]);
    const found = new Set(result.rows.map((row) => String(row.table_name ?? "")));
    if (RENT_OPS_MIGRATION_REQUIRED_TABLES.some((table) => !found.has(table))) throw new PersistenceImportPreconditionError(["rent_ops_schema_missing"]);
  } catch (error) {
    if (error instanceof PersistenceImportPreconditionError) throw error;
    throw new PersistenceImportPreconditionError(["rent_ops_schema_missing"]);
  }
}

type SnapshotPersistencePhase = "all" | "without_documents" | "documents_only";

async function persistSnapshot(
  executor: RentOpsQueryExecutor,
  prepared: PreparedImport,
  phase: SnapshotPersistencePhase = "all",
  skipDocumentIds: ReadonlySet<string> = new Set(),
  documentOverrides: ReadonlyMap<string, RentOpsDocument> = new Map(),
): Promise<void> {
  await assertSchemaReady(executor);
  if (phase !== "documents_only") {
    await assertExistingSourceRecords(executor, prepared.result.sourceRecords);
    await assertExistingImportRuns(executor, [...prepared.result.snapshot.importRuns, prepared.result.importRun]);
  }
  const selectedDescriptors = descriptors(prepared.result.snapshot, prepared.result.financialSemanticCrosswalk).filter((descriptor) => phase !== "documents_only" && descriptor.name !== "documents");
  for (const descriptor of selectedDescriptors) await upsertCollection(executor, descriptor);
  if (phase === "all" || phase === "documents_only") {
    const documentDescriptor = descriptors(prepared.result.snapshot, prepared.result.financialSemanticCrosswalk).find((descriptor) => descriptor.name === "documents");
    if (documentDescriptor) {
      await upsertCollection(executor, {
        ...documentDescriptor,
        records: documentDescriptor.records
          .map((record) => documentOverrides.get(String((record as { id?: unknown }).id ?? "")) ?? record)
          .filter((record) => !skipDocumentIds.has(String((record as { id?: unknown }).id ?? ""))),
      });
    }
  }
  if (phase !== "documents_only") {
    const runs = new Map<string, RentOpsImportRun>();
    for (const run of [...prepared.result.snapshot.importRuns, prepared.result.importRun]) runs.set(run.id, run);
    await saveSourceRecords(executor, prepared.result.sourceRecords);
    await saveImportRuns(executor, Array.from(runs.values()));
  }
}

export class PersistenceImporter {
  async run(input: PersistenceImportInput, executor: RentOpsQueryExecutor | undefined, options: PersistenceImporterOptions = {}): Promise<PersistenceImportSummary> {
    const mode = options.mode ?? "dry_run";
    let prepared: PreparedImport;
    try { prepared = preparePersistenceImport(input, options); }
    catch (error) { if (error instanceof PersistenceImportPreconditionError) throw error; throw new PersistenceImportPreconditionError(["import_input_invalid"]); }
    const controls = options.controls ?? prepared.controls;
    const result = prepared.result;
    const counts = countsFor(result.snapshot, result.sourceRecords);
    const totalsCents = totalsFor(result.snapshot);
    const warningCount = result.exceptions.filter((exception) => exception.severity === "warning").length;
    const errorCount = result.exceptions.filter((exception) => exception.severity === "error").length;
    const blockedReasons = validateResult(result, controls);
    if (prepared.requiresNormalization) blockedReasons.push("normalization_required");
    let restrictedParityInput: RestrictedParityPersistenceInput | undefined;
    if (prepared.restrictedSourceInput) {
      blockedReasons.push(...restrictedArchiveReceiptReasons(prepared.restrictedSourceInput, options.restrictedArchiveAuditReceipt));
      try {
        blockedReasons.push(...restrictedSourcePayloadBlockingReasons({
          input: prepared.restrictedSourceInput,
          importRun: result.importRun,
          sourceRecords: result.sourceRecords,
          ...(result.importRun.sourceManifestHash ? { sourceManifestHash: result.importRun.sourceManifestHash } : {}),
        }));
      } catch {
        blockedReasons.push("restricted_source_payload_ambiguity_scan_failed");
      }
      if (options.restrictedParityPersistenceInput) {
        const context = { importRun: result.importRun, sourceRecords: result.sourceRecords };
        try {
          restrictedParityInput = typeof options.restrictedParityPersistenceInput === "function"
            ? await options.restrictedParityPersistenceInput(context)
            : options.restrictedParityPersistenceInput;
        } catch {
          blockedReasons.push("restricted_parity_input_invalid");
        }
      }
    }
    if (mode === "dry_run") return { mode, importRunId: result.importRun.id, sourceManifestHash: result.importRun.sourceManifestHash, wouldWrite: false, committed: false, counts, totalsCents, warningCount, errorCount, blockedReasons };
    if (prepared.restrictedSourceInput && !options.restrictedSourcePayloadWriter) blockedReasons.push("restricted_source_payload_persistence_missing");
    if (prepared.restrictedSourceInput && (!options.restrictedParityPersistenceWriter || !restrictedParityInput)) blockedReasons.push("restricted_parity_persistence_missing");
    const restrictedDocumentInputs = options.restrictedVerifiedDocumentInputs ?? [];
    if (restrictedDocumentInputs.length > 0 && !options.restrictedVerifiedDocumentTransfer) blockedReasons.push("restricted_document_transfer_missing");
    if (restrictedDocumentInputs.some((input) => !restrictedDocumentTransferBindingValid(input))) blockedReasons.push("restricted_document_transfer_binding_invalid");
    const transaction = executor?.transaction;
    if (!transaction) blockedReasons.push("transactional_executor_missing");
    let inspection: DatabaseTargetInspection | undefined;
    if (executor?.transaction) {
      try { inspection = options.inspectDatabaseTarget ? await options.inspectDatabaseTarget(executor) : await inspectRentOpsDatabase(executor); }
      catch (error) { if (error instanceof PersistenceImportPreconditionError) blockedReasons.push(...error.reasons); else blockedReasons.push("target_inspection_failed"); }
    }
    if (inspection) blockedReasons.push(...applyGateReasons(options, inspection));
    else blockedReasons.push(...missingInspectionGateReasons(options));
    const nonce = options.affirmativeGate?.nonce;
    if (nonce && consumedGateNonces.has(nonce)) blockedReasons.push("affirmative_apply_gate_already_used");
    const uniqueReasons = Array.from(new Set(blockedReasons.map(safeCode)));
    if (uniqueReasons.length > 0) throw new PersistenceImportPreconditionError(uniqueReasons);
    consumedGateNonces.add(nonce as string);
    try {
      await executor!.transaction!(async (transactionExecutor) => {
        const hasRestrictedDocumentTransfers = restrictedDocumentInputs.length > 0;
        const transferredDocuments = new Map<string, RentOpsDocument>();
        await persistSnapshot(transactionExecutor, prepared, hasRestrictedDocumentTransfers ? "without_documents" : "all");
        if (prepared.restrictedSourceInput && options.restrictedSourcePayloadWriter) {
          await options.restrictedSourcePayloadWriter(transactionExecutor, {
            input: prepared.restrictedSourceInput,
            importRun: result.importRun,
            sourceRecords: result.sourceRecords,
            ...(result.importRun.sourceManifestHash ? { sourceManifestHash: result.importRun.sourceManifestHash } : {}),
          });
        }
        if (hasRestrictedDocumentTransfers && options.restrictedVerifiedDocumentTransfer) {
          for (const input of restrictedDocumentInputs) {
            try {
              const transferred = restrictedDocumentTransferResult(await options.restrictedVerifiedDocumentTransfer.transferVerifiedDocument(input, transactionExecutor));
              if (!transferred || !restrictedDocumentTransferResultValid(input, transferred)) {
                throw new PersistenceImportPreconditionError(["restricted_document_transfer_result_invalid"]);
              }
              transferredDocuments.set(transferred.document.id, transferred.document);
              await persistTransferredDocumentBinding(transactionExecutor, transferred.binding);
            } catch {
              const evidence = restrictedDocumentTransferOrphanEvidence(input);
              try { await options.restrictedDocumentOrphanSink?.(evidence); } catch { /* preserve the stable transfer failure */ }
              throw new PersistenceImportPreconditionError(["restricted_document_transfer_failed"]);
            }
          }
          // The service transfer owns the object binding and writes the
          // verified document row.  Reconcile the approved snapshot document
          // in the same transaction so source provenance remains immutable.
          await persistSnapshot(
            transactionExecutor,
            prepared,
            "documents_only",
            new Set<string>(),
            transferredDocuments,
          );
        }
        if (prepared.restrictedSourceInput && restrictedParityInput && options.restrictedParityPersistenceWriter) {
          await options.restrictedParityPersistenceWriter(transactionExecutor, {
            input: restrictedParityInput,
            importRun: result.importRun,
            sourceRecords: result.sourceRecords,
          });
        }
      }, { readOnly: false });
    }
    catch (error) { if (error instanceof PersistenceImportPreconditionError) throw error; throw new PersistenceImportTransactionError(); }
    return { mode, importRunId: result.importRun.id, sourceManifestHash: result.importRun.sourceManifestHash, wouldWrite: true, committed: true, counts, totalsCents, warningCount, errorCount, blockedReasons: [] };
  }
}

export function summarizeImportExceptions(exceptions: ImportMappingException[]): { warningCount: number; errorCount: number; codes: string[] } {
  return { warningCount: exceptions.filter((exception) => exception.severity === "warning").length, errorCount: exceptions.filter((exception) => exception.severity === "error").length, codes: Array.from(new Set(exceptions.map((exception) => safeCode(exception.code)))) };
}
