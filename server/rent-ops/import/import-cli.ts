import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  APPLY_RENT_OPS_STAGING_PHRASE,
  PersistenceImporter,
  type PersistenceImportInput,
  type BackupAttestation,
  type PersistenceImportSummary,
  type PersistenceImporterOptions,
  type AffirmativeApplyGate,
  type RestrictedSourcePayloadWriter,
} from "./persistence-importer";
import type { RentOpsQueryExecutor } from "../repositories/postgres";

export interface ImportCliArgs {
  mode: "dry_run" | "apply";
  inputPath?: string;
  importerOptions: PersistenceImporterOptions;
}

export interface ImportCliRuntime {
  loadResult: (inputPath: string) => Promise<PersistenceImportInput> | PersistenceImportInput;
  executor?: RentOpsQueryExecutor;
  importer?: PersistenceImporter;
  /** Root-owned archive writer; forwarded only to the importer transaction. */
  restrictedSourcePayloadWriter?: RestrictedSourcePayloadWriter;
}

const RAW_INPUT_KEYS = new Set([
  "properties", "units", "tenants", "contacts", "phoneNumbers", "households", "leases", "leaseTerms", "leaseRenewals", "recurringSchedules",
  "charges", "payments", "credits", "allocations", "deposits", "subsidies", "applications", "prospects", "applicationTemplates", "applicationAnswerRecords",
  "interestedRentals", "applicationSettings",
  "webUsers", "webUserAccounts", "documents", "documentBinaryDescriptors", "documentBinaries", "activities", "histories", "notes", "communications", "hap",
  "chargeTypes", "paymentTypes", "creditTypes", "lookups", "unitTypeRecords", "leaseTermDefinitions", "chargeTypeRecords", "securityDepositTypeRecords",
]);
const ENVELOPE_KEYS = new Set(["version", "runId", "source", "createdAt", "payload", "input", "documentBinaries", "sourceManifestHash", "archiveEnvelopeSha256", "manifest", "controls", "controlTotals"]);
const RESULT_KEYS = new Set(["snapshot", "sourceRecords", "importRun", "exceptions"]);
const APPROVED_ARTIFACT_KEYS = new Set(["artifactType", "normalizedResult", "restrictedSourceInput", "controls", "provenance"]);
const CREDENTIAL_KEY = /(?:database[_-]?url|connection[_-]?string|password|secret|access[_-]?token|private[_-]?key)/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9:_-]{1,128}$/;
const SAFE_REASON = /^[A-Za-z0-9_.:-]{1,160}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectCredentialFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectCredentialFields);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) throw new Error("import_input_contains_restricted_credential_field");
    rejectCredentialFields(child);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Validates the CLI's deliberately narrow JSON boundary without inspecting
 * credentials or connecting to a database. Raw RM rows are mapped later by
 * the existing mapper; only known envelope/result/input shapes are allowed. */
export function validateImportCliInput(value: unknown): PersistenceImportInput {
  rejectCredentialFields(value);
  if (!isRecord(value)) throw new Error("import_input_invalid");
  if (hasOnlyKeys(value, APPROVED_ARTIFACT_KEYS) && value.artifactType === "approved-rm-normalizer/v1" && isRecord(value.normalizedResult) && isRecord(value.restrictedSourceInput) && isRecord(value.controls) && isRecord(value.provenance)) {
    validateImportCliInput(value.normalizedResult);
    validateImportCliInput(value.restrictedSourceInput);
    return value as unknown as PersistenceImportInput;
  }
  if (hasOnlyKeys(value, RESULT_KEYS) && isRecord(value.snapshot) && Array.isArray(value.sourceRecords) && isRecord(value.importRun) && Array.isArray(value.exceptions)) {
    return value as unknown as PersistenceImportInput;
  }
  if (("payload" in value || "input" in value) && hasOnlyKeys(value, ENVELOPE_KEYS)) {
    const nested = value.payload ?? value.input;
    if (!isRecord(nested)) throw new Error("import_input_invalid");
    validateImportCliInput(nested);
    return value as unknown as PersistenceImportInput;
  }
  if (hasOnlyKeys(value, RAW_INPUT_KEYS) && Object.values(value).every((child) => child === undefined || Array.isArray(child))) {
    return value as unknown as PersistenceImportInput;
  }
  throw new Error("import_input_invalid");
}

function valueAfter(argv: readonly string[], index: number, flag: string): { value: string; nextIndex: number } {
  const argument = argv[index];
  if (argument?.startsWith(`${flag}=`)) {
    const value = argument.slice(flag.length + 1);
    if (!value) throw new Error(`${flag} requires a value`);
    return { value, nextIndex: index };
  }
  if (argument === flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return { value, nextIndex: index + 1 };
  }
  throw new Error(`Unsupported import option ${argument}`);
}

/**
 * Parses only explicit, non-secret operator controls. The default is always
 * dry-run. In particular, no environment variable or connection string can
 * silently turn this command into a write.
 */
export function parseImportCliArgs(argv: readonly string[]): ImportCliArgs {
  let mode: "dry_run" | "apply" = "dry_run";
  let inputPath: string | undefined;
  let targetClassification: PersistenceImporterOptions["targetClassification"];
  let expectedDatabaseFingerprint: string | undefined;
  const forbiddenDatabaseFingerprints: string[] = [];
  let actualDatabaseFingerprint: string | undefined;
  let expectedMigrationChecksum: string | undefined;
  let renderedMigrationChecksum: string | undefined;
  let backupAttestationId: string | undefined;
  let backupTargetFingerprint: string | undefined;
  let backupVerifiedAt: string | undefined;
  let gatePhrase: string | undefined;
  let gateNonce: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") { mode = "apply"; continue; }
    if (argument === "--dry-run" || argument === "--dry_run") { mode = "dry_run"; continue; }
    if (argument === "--help" || argument === "-h") throw new Error("Usage: import-cli --input <mapped-result.json> [--apply] [operator gates]");
    if (argument === "--input" || argument.startsWith("--input=")) { const parsed = valueAfter(argv, index, "--input"); inputPath = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--mode" || argument.startsWith("--mode=")) { const parsed = valueAfter(argv, index, "--mode"); if (parsed.value !== "dry_run" && parsed.value !== "apply") throw new Error("--mode must be dry_run or apply"); mode = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--target-classification" || argument.startsWith("--target-classification=")) { const parsed = valueAfter(argv, index, "--target-classification"); if (parsed.value !== "staging" && parsed.value !== "production" && parsed.value !== "unclassified") throw new Error("--target-classification is invalid"); targetClassification = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--expected-db-fingerprint" || argument.startsWith("--expected-db-fingerprint=")) { const parsed = valueAfter(argv, index, "--expected-db-fingerprint"); expectedDatabaseFingerprint = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--forbidden-db-fingerprint" || argument.startsWith("--forbidden-db-fingerprint=")) { const parsed = valueAfter(argv, index, "--forbidden-db-fingerprint"); forbiddenDatabaseFingerprints.push(parsed.value); index = parsed.nextIndex; continue; }
    if (argument === "--actual-db-fingerprint" || argument.startsWith("--actual-db-fingerprint=")) { const parsed = valueAfter(argv, index, "--actual-db-fingerprint"); actualDatabaseFingerprint = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--migration-checksum" || argument.startsWith("--migration-checksum=")) { const parsed = valueAfter(argv, index, "--migration-checksum"); expectedMigrationChecksum = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--rendered-migration-checksum" || argument.startsWith("--rendered-migration-checksum=")) { const parsed = valueAfter(argv, index, "--rendered-migration-checksum"); renderedMigrationChecksum = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--backup-attestation-id" || argument.startsWith("--backup-attestation-id=")) { const parsed = valueAfter(argv, index, "--backup-attestation-id"); backupAttestationId = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--backup-target-fingerprint" || argument.startsWith("--backup-target-fingerprint=")) { const parsed = valueAfter(argv, index, "--backup-target-fingerprint"); backupTargetFingerprint = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--backup-verified-at" || argument.startsWith("--backup-verified-at=")) { const parsed = valueAfter(argv, index, "--backup-verified-at"); backupVerifiedAt = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--gate-phrase" || argument.startsWith("--gate-phrase=")) { const parsed = valueAfter(argv, index, "--gate-phrase"); gatePhrase = parsed.value; index = parsed.nextIndex; continue; }
    if (argument === "--gate-nonce" || argument.startsWith("--gate-nonce=")) { const parsed = valueAfter(argv, index, "--gate-nonce"); gateNonce = parsed.value; index = parsed.nextIndex; continue; }
    throw new Error("unsupported_import_option");
  }
  const backupAttestation: BackupAttestation | undefined = backupAttestationId && backupTargetFingerprint && backupVerifiedAt
    ? { verified: true, attestationId: backupAttestationId, targetFingerprint: backupTargetFingerprint, verifiedAt: backupVerifiedAt }
    : undefined;
  const affirmativeGate: AffirmativeApplyGate | undefined = gatePhrase !== undefined && gateNonce !== undefined
    ? { phrase: gatePhrase as typeof APPLY_RENT_OPS_STAGING_PHRASE, nonce: gateNonce }
    : undefined;
  return {
    mode,
    inputPath,
    importerOptions: {
      mode,
      targetClassification,
      expectedDatabaseFingerprint,
      forbiddenDatabaseFingerprints: forbiddenDatabaseFingerprints.length > 0 ? forbiddenDatabaseFingerprints : undefined,
      actualDatabaseFingerprint,
      backupAttestation,
      expectedMigrationChecksum,
      renderedMigrationChecksum,
      affirmativeGate,
    },
  };
}

/** Executes an import through injected I/O. Callers must provide the DB
 * executor explicitly; this module does not discover credentials or connect
 * to a configured database. */
export async function runImportCli(args: ImportCliArgs, runtime: ImportCliRuntime): Promise<PersistenceImportSummary> {
  if (!args.inputPath) throw new Error("--input is required");
  const result = await runtime.loadResult(args.inputPath);
  const importer = runtime.importer ?? new PersistenceImporter();
  const importerOptions = runtime.restrictedSourcePayloadWriter
    ? { ...args.importerOptions, restrictedSourcePayloadWriter: runtime.restrictedSourcePayloadWriter }
    : args.importerOptions;
  return importer.run(result, runtime.executor, importerOptions);
}

/** Safe operator output: counts, integer cents, hashes, and gate diagnostics;
 * no mapped records, names, addresses, contact data, URLs, or secrets. */
export function formatImportSummary(summary: PersistenceImportSummary): string {
  return JSON.stringify({
    mode: summary.mode,
    importRunId: SAFE_IDENTIFIER.test(summary.importRunId) ? summary.importRunId : "redacted_identifier",
    sourceManifestHash: summary.sourceManifestHash && SHA256.test(summary.sourceManifestHash) ? summary.sourceManifestHash : undefined,
    wouldWrite: summary.wouldWrite,
    committed: summary.committed,
    counts: summary.counts,
    totalsCents: summary.totalsCents,
    warningCount: summary.warningCount,
    errorCount: summary.errorCount,
    blockedReasons: summary.blockedReasons.map((reason) => SAFE_REASON.test(reason) ? reason : "redacted_reason"),
  }, null, 2);
}

/**
 * Standalone invocation is intentionally dry-run only unless a root-owned
 * caller injects a transaction-capable executor through runImportCli. The
 * file loader accepts a mapped result JSON envelope, not raw RM credentials.
 */
export async function loadMappedImportResult(inputPath: string): Promise<PersistenceImportInput> {
  const parsed: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
  return validateImportCliInput(parsed);
}

async function main(): Promise<void> {
  const args = parseImportCliArgs(process.argv.slice(2));
  const summary = await runImportCli(args, { loadResult: loadMappedImportResult });
  process.stdout.write(`${formatImportSummary(summary)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error && /^[A-Za-z0-9_.:; -]{1,400}$/.test(error.message) ? error.message : "import_failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
