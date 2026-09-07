import { pathToFileURL } from "node:url";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import {
  APPLY_RENT_OPS_STAGING_PHRASE,
  PersistenceImportPreconditionError,
  PersistenceImportTransactionError,
  type AffirmativeApplyGate,
  type PersistenceImporterOptions,
  type PersistenceImportSummary,
  type RestrictedDocumentTransferOrphanEvidence,
  type RestrictedVerifiedDocumentTransfer,
} from "./persistence-importer";
import {
  RestrictedMigrationArchiveError,
  runRestrictedMigrationArchive,
  type RestrictedMigrationRunResult,
} from "./migration-runner";
import type { PrivateObjectStorePrivilegeProbe } from "../storage/types";
import {
  RestrictedMigrationOrchestrationError,
  runRestrictedMigrationArchiveOrchestration,
  type RestrictedMigrationAuditDecision,
  type RestrictedMigrationOrchestrationStage,
} from "./restricted-orchestration";

const SAFE_IDENTIFIER = /^[A-Za-z0-9:_-]{1,128}$/;
const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,160}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

export interface RestrictedMigrationCliArgs {
  archiveRoot: string;
  mode: "dry_run" | "apply";
  importerOptions: PersistenceImporterOptions;
  secondApplyGate?: AffirmativeApplyGate;
}

export interface RestrictedMigrationCliOutput {
  ok: true;
  status: "dry_run_ready" | "blocked" | "committed" | "ready";
  mode: "dry_run" | "apply";
  report: RedactedMigrationArtifactReport;
  summary?: RedactedPersistenceImportSummary;
}

export interface RestrictedMigrationCliRuntime {
  runArchive?: typeof runRestrictedMigrationArchive;
  /** Apply-only dependency seam. Dry-run never calls this factory. */
  createExecutor?: () => Promise<{ executor: RentOpsQueryExecutor; close: () => Promise<void> }>;
  /** Required apply-only independent DB audit; parity readback is not sufficient. */
  audit?: (context: { stage: RestrictedMigrationOrchestrationStage; result: RestrictedMigrationRunResult; executor: RentOpsQueryExecutor; archiveRoot: string; archiveReceiptSha256?: string }) => Promise<RestrictedMigrationAuditDecision | void>;
  /** Dedicated verified RM binary transfer identity and orphan-review sink. */
  restrictedVerifiedDocumentTransfer?: RestrictedVerifiedDocumentTransfer;
  restrictedDocumentOrphanSink?: (evidence: RestrictedDocumentTransferOrphanEvidence) => Promise<void> | void;
  storagePrivilegeProbe?: PrivateObjectStorePrivilegeProbe;
}

export interface RedactedMigrationArtifactReport {
  archiveEnvelopeSha256: string;
  manifestSha256: string;
  normalizationReportSha256: string;
  normalizedRowsSha256: string;
  controlsSha256: string;
  mappedRowsSha256: string;
  restrictedRowsSha256: string;
  artifactBindingSha256: string;
  normalizerVersion: string;
  sourceRunId: string;
  rawCollectionCounts: Record<string, number>;
  normalizedRecordCounts: Record<string, number>;
  mappedSourceCounts: Record<string, number>;
  normalizationExceptionCount: number;
  mappingWarningCount: number;
  mappingErrorCount: number;
  blockingReasons: string[];
}

export interface RedactedPersistenceImportSummary {
  mode: "dry_run" | "apply";
  importRunId: string;
  sourceManifestHash?: string;
  wouldWrite: boolean;
  committed: boolean;
  counts: Record<string, number>;
  totalsCents: Record<string, number>;
  warningCount: number;
  errorCount: number;
  blockedReasons: string[];
}

function safeReason(value: unknown): string {
  const text = String(value ?? "");
  return SAFE_REASON.test(text) ? text : "redacted_reason";
}

function safeIdentifier(value: unknown): string {
  const text = String(value ?? "");
  return SAFE_IDENTIFIER.test(text) ? text : "redacted_identifier";
}

function safeHash(value: unknown, pattern: RegExp = SHA256): string | undefined {
  const text = String(value ?? "");
  return pattern.test(text) ? text.toLowerCase() : undefined;
}

function safeCount(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function redactedCounts(value: Record<string, unknown> | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value ?? {})) {
    result[safeReason(key)] = safeCount(count);
  }
  return result;
}

function redactedMoney(value: Record<string, unknown> | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value ?? {})) {
    const number = typeof amount === "bigint" ? Number(amount) : Number(amount ?? 0);
    result[safeReason(key)] = Number.isSafeInteger(number) ? number : 0;
  }
  return result;
}

function redactedReport(report: RestrictedMigrationRunResult["report"]): RedactedMigrationArtifactReport {
  return {
    archiveEnvelopeSha256: safeHash(report.archiveEnvelopeSha256) ?? "redacted_hash",
    manifestSha256: safeHash(report.manifestSha256) ?? "redacted_hash",
    normalizationReportSha256: safeHash(report.normalizationReportSha256) ?? "redacted_hash",
    normalizedRowsSha256: safeHash(report.normalizedRowsSha256) ?? "redacted_hash",
    controlsSha256: safeHash(report.controlsSha256) ?? "redacted_hash",
    mappedRowsSha256: safeHash(report.mappedRowsSha256) ?? "redacted_hash",
    restrictedRowsSha256: safeHash(report.restrictedRowsSha256) ?? "redacted_hash",
    artifactBindingSha256: safeHash(report.artifactBindingSha256) ?? "redacted_hash",
    normalizerVersion: safeReason(report.normalizerVersion),
    sourceRunId: safeIdentifier(report.sourceRunId),
    rawCollectionCounts: redactedCounts(report.rawCollectionCounts),
    normalizedRecordCounts: redactedCounts(report.normalizedRecordCounts),
    mappedSourceCounts: redactedCounts(report.mappedSourceCounts),
    normalizationExceptionCount: safeCount(report.normalizationExceptionCount),
    mappingWarningCount: safeCount(report.mappingWarningCount),
    mappingErrorCount: safeCount(report.mappingErrorCount),
    blockingReasons: report.blockingReasons.map(safeReason),
  };
}

function redactedSummary(summary: PersistenceImportSummary): RedactedPersistenceImportSummary {
  const sourceManifestHash = safeHash(summary.sourceManifestHash);
  return {
    mode: summary.mode,
    importRunId: safeIdentifier(summary.importRunId),
    ...(sourceManifestHash ? { sourceManifestHash } : {}),
    wouldWrite: summary.wouldWrite === true,
    committed: summary.committed === true,
    counts: redactedCounts(summary.counts as unknown as Record<string, unknown>),
    totalsCents: redactedMoney(summary.totalsCents as unknown as Record<string, unknown>),
    warningCount: safeCount(summary.warningCount),
    errorCount: safeCount(summary.errorCount),
    blockedReasons: summary.blockedReasons.map(safeReason),
  };
}

export function formatRestrictedMigrationOutput(result: RestrictedMigrationRunResult): RestrictedMigrationCliOutput {
  const report = redactedReport(result.report);
  const summary = result.summary ? redactedSummary(result.summary) : undefined;
  const blocked = report.blockingReasons.length > 0 || (summary?.blockedReasons.length ?? 0) > 0;
  const status: RestrictedMigrationCliOutput["status"] = result.summary?.committed
    ? "committed"
    : blocked
      ? "blocked"
      : result.summary?.mode === "dry_run"
        ? "dry_run_ready"
        : "ready";
  return {
    ok: true,
    status,
    mode: result.summary?.mode ?? "dry_run",
    report,
    ...(summary ? { summary } : {}),
  };
}

function argumentValue(argv: readonly string[], index: number, flag: string): { value: string; nextIndex: number } {
  const argument = argv[index];
  if (argument?.startsWith(`${flag}=`)) {
    const value = argument.slice(flag.length + 1);
    if (!value) throw new Error(`${flag}_requires_value`);
    return { value, nextIndex: index };
  }
  if (argument === flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag}_requires_value`);
    return { value, nextIndex: index + 1 };
  }
  throw new Error("unsupported_argument");
}

/** Parses only explicit non-secret operator controls. Dry-run is the default. */
export function parseRestrictedMigrationCliArgs(argv: readonly string[]): RestrictedMigrationCliArgs {
  let archiveRoot: string | undefined;
  let mode: "dry_run" | "apply" = "dry_run";
  let targetClassification: PersistenceImporterOptions["targetClassification"];
  let expectedDatabaseFingerprint: string | undefined;
  let actualDatabaseFingerprint: string | undefined;
  let expectedMigrationChecksum: string | undefined;
  let renderedMigrationChecksum: string | undefined;
  let backupAttestationId: string | undefined;
  let backupReference: string | undefined;
  let backupTargetFingerprint: string | undefined;
  let backupVerifiedAt: string | undefined;
  let gatePhrase: string | undefined;
  let gateNonce: string | undefined;
  let secondGateNonce: string | undefined;
  const forbiddenDatabaseFingerprints: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { mode = "apply"; continue; }
    if (argument === "--dry-run" || argument === "--dry_run") { mode = "dry_run"; continue; }
    if (argument === "--help" || argument === "-h") throw new Error("restricted_migration_cli_usage");
    if (argument === "--archive-root" || argument.startsWith("--archive-root=")) { const parsed = argumentValue(argv, index, "--archive-root"); archiveRoot = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--target-classification" || argument.startsWith("--target-classification=")) { const parsed = argumentValue(argv, index, "--target-classification"); if (parsed.value !== "staging" && parsed.value !== "production" && parsed.value !== "unclassified") throw new Error("target_classification_invalid"); targetClassification = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--expected-db-fingerprint" || argument.startsWith("--expected-db-fingerprint=")) { const parsed = argumentValue(argv, index, "--expected-db-fingerprint"); expectedDatabaseFingerprint = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--actual-db-fingerprint" || argument.startsWith("--actual-db-fingerprint=")) { const parsed = argumentValue(argv, index, "--actual-db-fingerprint"); actualDatabaseFingerprint = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--forbidden-db-fingerprint" || argument.startsWith("--forbidden-db-fingerprint=")) { const parsed = argumentValue(argv, index, "--forbidden-db-fingerprint"); forbiddenDatabaseFingerprints.push(parsed.value); index = parsed.nextIndex; continue; }
    if (argument === "--migration-checksum" || argument.startsWith("--migration-checksum=")) { const parsed = argumentValue(argv, index, "--migration-checksum"); expectedMigrationChecksum = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--rendered-migration-checksum" || argument.startsWith("--rendered-migration-checksum=")) { const parsed = argumentValue(argv, index, "--rendered-migration-checksum"); renderedMigrationChecksum = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--backup-attestation-id" || argument.startsWith("--backup-attestation-id=")) { const parsed = argumentValue(argv, index, "--backup-attestation-id"); backupAttestationId = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--backup-reference" || argument.startsWith("--backup-reference=")) { const parsed = argumentValue(argv, index, "--backup-reference"); backupReference = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--backup-target-fingerprint" || argument.startsWith("--backup-target-fingerprint=")) { const parsed = argumentValue(argv, index, "--backup-target-fingerprint"); backupTargetFingerprint = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--backup-verified-at" || argument.startsWith("--backup-verified-at=")) { const parsed = argumentValue(argv, index, "--backup-verified-at"); backupVerifiedAt = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--gate-phrase" || argument.startsWith("--gate-phrase=")) { const parsed = argumentValue(argv, index, "--gate-phrase"); gatePhrase = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--gate-nonce" || argument.startsWith("--gate-nonce=")) { const parsed = argumentValue(argv, index, "--gate-nonce"); gateNonce = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--second-gate-nonce" || argument.startsWith("--second-gate-nonce=")) { const parsed = argumentValue(argv, index, "--second-gate-nonce"); secondGateNonce = parsed.value; index = parsed.nextIndex; continue; }
    throw new Error("unsupported_argument");
  }
  if (!archiveRoot) throw new Error("archive_root_required");
  const backupAttestation = backupTargetFingerprint && backupVerifiedAt && (backupAttestationId || backupReference)
    ? { verified: true as const, ...(backupAttestationId ? { attestationId: backupAttestationId } : {}), ...(backupReference ? { reference: backupReference } : {}), targetFingerprint: backupTargetFingerprint, verifiedAt: backupVerifiedAt }
    : undefined;
  const affirmativeGate: AffirmativeApplyGate | undefined = gatePhrase !== undefined && gateNonce !== undefined
    ? { phrase: gatePhrase as typeof APPLY_RENT_OPS_STAGING_PHRASE, nonce: gateNonce }
    : undefined;
  return {
    archiveRoot,
    mode,
    importerOptions: {
      mode,
      targetClassification,
      expectedDatabaseFingerprint,
      actualDatabaseFingerprint,
      forbiddenDatabaseFingerprints: forbiddenDatabaseFingerprints.length > 0 ? forbiddenDatabaseFingerprints : undefined,
      expectedMigrationChecksum,
      renderedMigrationChecksum,
      backupAttestation,
      affirmativeGate,
    },
    ...(secondGateNonce !== undefined ? { secondApplyGate: { phrase: APPLY_RENT_OPS_STAGING_PHRASE, nonce: secondGateNonce } } : {}),
  };
}

export async function runRestrictedMigrationCli(args: RestrictedMigrationCliArgs, runtime: RestrictedMigrationCliRuntime = {}): Promise<RestrictedMigrationCliOutput> {
  // The injectable runner exists for deterministic unit tests only.  A
  // production apply must use the concrete no-follow archive runner so its
  // independent inventory/credential audit and receipt cannot be replaced by
  // a parity-only or self-attested callback.
  if (process.env.NODE_ENV === "production" && runtime.runArchive) throw new RestrictedMigrationArchiveError(["restricted_archive_runner_override_forbidden"]);
  if (process.env.NODE_ENV === "production" && runtime.audit) throw new RestrictedMigrationArchiveError(["restricted_independent_audit_override_forbidden"]);
  const runArchive = runtime.runArchive ?? runRestrictedMigrationArchive;
  if (args.mode === "dry_run") {
    const result = await runArchive({ archiveRoot: args.archiveRoot, mode: "dry_run", importerOptions: args.importerOptions });
    return formatRestrictedMigrationOutput(result);
  }
  const connection = runtime.createExecutor ? await runtime.createExecutor() : await createProductionExecutor();
  try {
    const execute = runtime.runArchive
      ? async (mode: "dry_run" | "apply", _runNumber: 0 | 1 | 2, context?: { affirmativeGate?: AffirmativeApplyGate }) => {
        const { affirmativeGate: _ignoredGate, ...ungatedOptions } = args.importerOptions;
        return runArchive({
          archiveRoot: args.archiveRoot,
          mode,
          ...(mode === "apply" ? { executor: connection.executor } : {}),
          importerOptions: {
            ...ungatedOptions,
            mode,
            ...(mode === "apply" ? { affirmativeGate: context?.affirmativeGate } : {}),
          },
          ...(runtime.restrictedVerifiedDocumentTransfer ? { restrictedVerifiedDocumentTransfer: runtime.restrictedVerifiedDocumentTransfer } : {}),
          ...(runtime.restrictedDocumentOrphanSink ? { restrictedDocumentOrphanSink: runtime.restrictedDocumentOrphanSink } : {}),
          ...(runtime.storagePrivilegeProbe ? { storagePrivilegeProbe: runtime.storagePrivilegeProbe } : {}),
        });
      }
      : undefined;
    const auditOverride = runtime.audit
      ? async ({ stage, result }: { stage: RestrictedMigrationOrchestrationStage; result: RestrictedMigrationRunResult; targetState?: import("./target-state").RentOpsTargetState }) => {
        if (result.summary?.mode === "apply" && result.postcommitAudit?.passed !== true) {
          return { passed: false, blockingReasons: ["restricted_parity_postcommit_audit_missing_or_failed"] };
        }
        const decision = await runtime.audit!({ stage, result, executor: connection.executor, archiveRoot: args.archiveRoot, archiveReceiptSha256: result.archiveAuditBindingSha256 });
        if (!decision || decision.passed !== true) return decision;
        if (decision.independentDatabaseAudit?.passed !== true) return { passed: false, blockingReasons: ["independent_database_audit_missing"] };
        if (!result.archiveAuditBindingSha256 || decision.independentDatabaseAudit.archiveReceiptSha256 !== result.archiveAuditBindingSha256) return { passed: false, blockingReasons: ["independent_database_audit_receipt_mismatch"] };
        return decision;
      }
      : undefined;
    const orchestration = await runRestrictedMigrationArchiveOrchestration({
      archiveRoot: args.archiveRoot,
      executor: connection.executor,
      importerOptions: args.importerOptions,
      firstApplyGate: args.importerOptions.affirmativeGate,
      secondApplyGate: args.secondApplyGate,
      ...(execute ? { execute } : {}),
      ...(runtime.restrictedVerifiedDocumentTransfer ? { restrictedVerifiedDocumentTransfer: runtime.restrictedVerifiedDocumentTransfer } : {}),
      ...(runtime.restrictedDocumentOrphanSink ? { restrictedDocumentOrphanSink: runtime.restrictedDocumentOrphanSink } : {}),
      ...(runtime.storagePrivilegeProbe ? { storagePrivilegeProbe: runtime.storagePrivilegeProbe } : {}),
      ...(auditOverride ? { audit: auditOverride } : {}),
    });
    return formatRestrictedMigrationOutput(orchestration.secondApply);
  } finally {
    await connection.close();
  }
}

async function createProductionExecutor(): Promise<{ executor: RentOpsQueryExecutor; close: () => Promise<void> }> {
  // Migrations use a dedicated credential. The ordinary application
  // DATABASE_URL is intentionally never read or used as a fallback.
  const databaseUrl = process.env.RENT_OPS_DATABASE_URL;
  if (!databaseUrl) throw new RestrictedMigrationArchiveError(["dedicated_database_url_missing"]);
  // These imports are intentionally apply-only. Dry-run does not load the
  // Neon driver, construct a pool, read either database environment variable,
  // or issue a connection attempt.
  const [{ Pool, neonConfig }, wsModule] = await Promise.all([import("@neondatabase/serverless"), import("ws")]);
  neonConfig.webSocketConstructor = wsModule.default;
  const pool = new Pool({ connectionString: databaseUrl });
  const executor: RentOpsQueryExecutor = {
    async query<T = Record<string, unknown>>(text: string, values?: unknown[]) {
      const result = await pool.query(text, values as never[] | undefined);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(work: (executor: RentOpsQueryExecutor) => Promise<T>, options: { readOnly?: boolean } = {}) {
      const client = await pool.connect();
      const transactionExecutor: RentOpsQueryExecutor = {
        async query<Row = Record<string, unknown>>(text: string, values?: unknown[]) {
          const result = await client.query(text, values as never[] | undefined);
          return { rows: result.rows as Row[] };
        },
      };
      try {
        await client.query(`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ${options.readOnly ? " READ ONLY" : ""}`);
        const result = await work(transactionExecutor);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return { executor, close: async () => { await pool.end(); } };
}

export function formatRestrictedMigrationError(error: unknown): string {
  const reasons = error instanceof RestrictedMigrationArchiveError || error instanceof PersistenceImportPreconditionError || error instanceof RestrictedMigrationOrchestrationError
    ? error.reasons.map(safeReason)
    : error instanceof PersistenceImportTransactionError
      ? ["transaction_failed"]
      : ["restricted_migration_failed"];
  const restore = error instanceof RestrictedMigrationOrchestrationError ? error.restoreRequired : undefined;
  const redactedRestore = restore
    ? {
      status: "restore_required" as const,
      safeReason: safeReason(restore.safeReason),
      preApplyTablesSha256: safeHash(restore.preApplyTablesSha256) ?? "redacted_hash",
      ...(restore.observedTablesSha256 ? { observedTablesSha256: safeHash(restore.observedTablesSha256) ?? "redacted_hash" } : {}),
    }
    : undefined;
  return JSON.stringify({ ok: false, status: redactedRestore ? "restore_required" : "blocked", blockedReasons: reasons, ...(redactedRestore ? { restoreRequired: redactedRestore } : {}) }, null, 2);
}

async function main(): Promise<void> {
  try {
    const args = parseRestrictedMigrationCliArgs(process.argv.slice(2));
    const output = await runRestrictedMigrationCli(args);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${formatRestrictedMigrationError(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) void main();
