import { effectiveFidelityScheduleAmounts } from './schedule-report-controls';
import { verifyManagedStorageReadiness, type ManagedStorageReadiness } from "./managed-storage-readiness";
import { ALLOCATION_OVERLAY_FILE, verifyAllocationOverlay } from "./allocation-overlay";
import { FINANCIAL_METADATA_PROVENANCE_FILE, verifyFinancialMetadata } from "./financial-metadata";
import { OBSERVATION_PROVENANCE_FILE, verifyObservationBoundary } from "./observation-boundary";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { canonicalJson, hashRecord, sha256 } from "../export/hash";
import { auditRestrictedExportArchive, type RestrictedExportArchiveAuditReport } from "../export/archive-audit";
import type { CollectionCheckpoint, CollectionCoverage, DocumentBinaryDescriptor, ExportCheckpoint, ExportEnvelope, RedactedExportManifest } from "../export/types";
import type { IsoMonth, RentManagerRawRecord, RentOpsDocument, RentOpsSnapshot, RentOpsSourceRecord, RentOpsSubsidyContract, RentOpsSubsidyPayment, RentOpsSubsidyTenant } from "../../../shared/rent-ops-contracts";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import { effectiveScheduleIntervals, ledgerBalanceSign } from "../domain/invariants";
import { projectFinancialSchedules, type FinancialScheduleProjection } from "../domain/financial-projection";
import { assertMigrationArtifactIntegrity, buildRentManagerMigrationArtifact, type MigrationArtifactReport } from "./migration-artifact";
import { approvedArchiveEnvelopeSha256, PersistenceImporter, type PersistenceImporterOptions, type PersistenceImportSummary, type RestrictedDocumentTransferOrphanEvidence, type RestrictedVerifiedDocumentTransfer, type VerifiedSupplementReceiptBinding } from "./persistence-importer";
import { createRestrictedImportObservationFromChunks, RESTRICTED_PARITY_STREAM_LIMITS, type RestrictedParityChunkRow, type RestrictedParitySourceChunk } from "./restricted-parity";
import { auditPersistedRestrictedParity, createRestrictedParityPersistenceWriter, type RestrictedParityPersistenceInput } from "./restricted-parity-persistence";
import { createRestrictedSourcePayloadWriter, restrictedSourceBinaryId, restrictedSourcePayloadBindings } from "./restricted-source-payloads";
import type { DatabaseAuditExpected, DatabaseAuditExpectedFinancialReport, DatabaseAuditExpectedFinancialReportProperty, DatabaseAuditExpectedProperty, DatabaseAuditRestrictedBinaryDescriptor, DatabaseAuditRestrictedVersion } from "./database-audit";
import type { VerifiedDocumentArchiveInput } from "../services/service";
import type { PrivateObjectStorePrivilegeProbe } from "../storage/types";
import { probePrivateObjectStorePrivileges } from "../storage/object-store";
import { RENT_OPS_REQUIRED_TABLES, RENT_OPS_SCHEMA_VERSION, rentOpsMigrationChecksumForVersion } from "../persistence";

/** Keep physical page receipts unchanged while feeding bounded, ordered
 * records to the parity scanner. RM page sizes need not equal stream sizes. */
export function partitionRestrictedSourceRows(collectionName: string, path: string, rows: readonly RestrictedParityChunkRow[]): RestrictedParitySourceChunk[] {
  const chunks: RestrictedParitySourceChunk[] = [];
  for (let offset = 0; offset < Math.max(rows.length, 1); offset += RESTRICTED_PARITY_STREAM_LIMITS.maxChunkRows) {
    chunks.push({ collectionName, path, present: true, rows: rows.slice(offset, offset + RESTRICTED_PARITY_STREAM_LIMITS.maxChunkRows) });
  }
  return chunks;
}

export interface RestrictedMigrationArchive {
  envelope: ExportEnvelope;
  manifest: RedactedExportManifest;
  auditReceipt: RestrictedArchiveAuditReceipt;
  parity: RestrictedMigrationArchiveParitySource;
  /** Verified bytes are retained only for the apply transfer seam. */
  verifiedBinaries: readonly RestrictedVerifiedArchiveBinary[];
  independentAudit: RestrictedExportArchiveAuditReport;
  /**
   * Aggregate-only trust root for a derivative supplement.  A missing receipt
   * is intentionally different from an approved/empty receipt: callers must
   * keep the supplement in the blocked path until this value is present.
   */
  verifiedSupplementReceipt?: VerifiedSupplementReceiptBinding;
}

/**
 * The only supplement evidence allowed across the archive -> artifact
 * boundary.  It contains digests and a hash of the external verifier's
 * receipt, never source rows, operator references, or receipt contents.
 */
export type { VerifiedSupplementReceiptBinding };

/** Alias used by supplement-facing callers that do not need the runner name. */
export type RestrictedSupplementVerifiedReceipt = VerifiedSupplementReceiptBinding;

/** Aggregate-only tuple supplied to the independent approval store. */
export type VerifiedSupplementReceiptVerificationInput = Omit<
  VerifiedSupplementReceiptBinding,
  "version" | "externalVerificationIdHash" | "provenanceSha256"
> & { readonly provenanceSha256?: string };

export interface VerifiedSupplementReceiptVerification {
  readonly verified: true;
  /** SHA-256 of the opaque external receipt identifier. */
  readonly externalVerificationIdHash?: string;
  /** Compatibility seam for stores that return the opaque identifier itself. */
  readonly receiptId?: string;
}

export type VerifiedSupplementReceiptVerifier = (
  input: VerifiedSupplementReceiptVerificationInput,
) => Promise<VerifiedSupplementReceiptVerification> | VerifiedSupplementReceiptVerification;

export interface RestrictedVerifiedArchiveBinary {
  readonly sourceId: string;
  readonly sourceCollection: string;
  readonly archivePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
}

/** Independent, redacted evidence that the archive files were read from the
 * same no-follow descriptors that were checked and hashed. */
export interface RestrictedArchiveAuditReceipt {
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

export interface RestrictedMigrationArchiveParitySource {
  readonly sourceChunks: readonly RestrictedParitySourceChunk[];
  /** Digest of the exact page descriptors and bytes read through no-follow descriptors. */
  readonly pageFileSetSha256: string;
  readonly pageFileCount: number;
  readonly sourceControls: {
    readonly schemaVersion: string;
    readonly registryHash: string;
    readonly checkpointSha256: string;
    readonly coverageSha256: string;
    readonly controlSha256: string;
  };
}

export interface RestrictedMigrationRunResult {
  report: MigrationArtifactReport;
  summary?: PersistenceImportSummary;
  /** Digest of the exact archive receipt bound to this run's independent audit. */
  archiveAuditBindingSha256?: string;
  /** Redacted postcommit proof; production orchestration must gate on this. */
  postcommitAudit?: RestrictedMigrationPostcommitAudit;
  /**
   * In-memory-only expected controls for the independent database audit.  This
   * is deliberately not part of the formatted CLI output; it binds the audit
   * to the approved artifact instead of allowing a production runner to pass a
   * parity-only or self-attested result.
   */
  databaseAuditContext?: RestrictedMigrationDatabaseAuditContext;
}

export interface RestrictedMigrationDatabaseAuditContext {
  readonly asOfDate: string;
  readonly expected: RestrictedMigrationDatabaseAuditExpected;
  /** Digest of the no-follow archive receipt used to build `expected`. */
  readonly archiveReceiptSha256: string;
  /** The approved artifact binding that produced the expected controls. */
  readonly artifactBindingSha256: string;
  /** Immutable runtime schema chain the target must expose before promotion. */
  readonly migration: RestrictedMigrationSchemaBinding;
  /** Expected target identity supplied by the operator gate. */
  readonly expectedTargetFingerprint?: string;
}

/**
 * The production audit hand-off must carry the independent v8 scheduled
 * income controls.  Keeping this required here prevents a runner caller from
 * accidentally supplying only the legacy count/total controls.
 */
export type RestrictedMigrationDatabaseAuditExpected = Omit<DatabaseAuditExpected, "financialReport"> & {
  readonly financialReport: {
    readonly portfolio: NonNullable<DatabaseAuditExpectedFinancialReport["portfolio"]>;
    readonly perProperty: readonly DatabaseAuditExpectedFinancialReportProperty[];
  };
};

export interface RestrictedMigrationSchemaBinding {
  readonly version: number;
  readonly requiredTables: number;
  readonly checksum: string;
  readonly migrationChecksums: Readonly<Record<number, string>>;
  readonly migrationChainSha256: string;
}

export interface RestrictedMigrationPostcommitAudit {
  readonly passed: boolean;
  readonly blockingReasons: readonly string[];
}

export class RestrictedMigrationArchiveError extends Error {
  readonly reasons: string[];

  constructor(reasons: readonly string[]) {
    const safe = Array.from(new Set(reasons.map((reason) => reason.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160))));
    super(`Rent Manager migration archive is blocked: ${safe.join("; ")}`);
    this.name = "RestrictedMigrationArchiveError";
    this.reasons = safe;
  }
}

async function assertRestrictedPath(path: string, kind: "directory" | "file"): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new RestrictedMigrationArchiveError(["restricted_archive_symlink_rejected"]);
    if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) throw new RestrictedMigrationArchiveError(["restricted_archive_type_invalid"]);
    if ((stats.mode & 0o077) !== 0) throw new RestrictedMigrationArchiveError(["restricted_archive_permissions_invalid"]);
  } catch (error) {
    if (error instanceof RestrictedMigrationArchiveError) throw error;
    throw new RestrictedMigrationArchiveError(["restricted_archive_entry_unreadable"]);
  }
}

const SHA256 = /^[a-f0-9]{64}$/i;

function safeBinaryRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_path_invalid"]);
  const normalized = value.replace(/\\/g, "/");
  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_path_invalid"]);
  const parts = normalized.split("/");
  if (parts.length < 2 || parts[0] !== "binaries" || parts.some((part) => !part || part === "." || part === "..")) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_path_invalid"]);
  return parts.join("/");
}

async function assertRestrictedPathChain(root: string, candidate: string): Promise<void> {
  const pathRelative = relative(root, candidate);
  if (!pathRelative || pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_path_invalid"]);
  const parts = pathRelative.split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index]);
    await assertRestrictedPath(cursor, index === parts.length - 1 ? "file" : "directory");
  }
}

function assertContainedRestrictedPath(root: string, candidate: string): void {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const relativePath = relative(rootResolved, candidateResolved);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RestrictedMigrationArchiveError(["restricted_archive_path_invalid"]);
  }
}

/**
 * Opens and hashes one archive file through one descriptor.  The lstat/path
 * walk is only an early diagnostic; O_NOFOLLOW plus fstat is the authority,
 * so a leaf swap cannot turn the later read into a symlink or unrelated hard
 * link.  When an initial lstat identity is supplied, the opened descriptor
 * must also be that exact device/inode. No path or OS error is returned.
 */
async function readRestrictedFileFromDescriptor(
  root: string,
  candidate: string,
  code: string,
  expectedIdentity?: { readonly dev: number; readonly ino: number },
): Promise<{ bytes: Uint8Array; sha256: string }> {
  assertContainedRestrictedPath(root, candidate);
  await assertRestrictedPathChain(root, candidate);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (
      !before.isFile()
      || (before.mode & 0o077) !== 0
      || before.nlink !== 1
      || (expectedIdentity !== undefined && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino))
    ) throw new RestrictedMigrationArchiveError([code]);
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (
      !after.isFile()
      || (after.mode & 0o077) !== 0
      || after.nlink !== 1
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) throw new RestrictedMigrationArchiveError([code]);
    return { bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof RestrictedMigrationArchiveError) throw error;
    throw new RestrictedMigrationArchiveError([code]);
  } finally {
    try { await handle?.close(); } catch { /* redacted close failure */ }
  }
}

function binaryDescriptorKey(descriptor: DocumentBinaryDescriptor): string {
  return [descriptor.sourceId, descriptor.archivePath ?? "", descriptor.sha256 ?? "", String(descriptor.sizeBytes ?? ""), descriptor.contentType ?? ""].join("\u0000");
}

/**
 * Verifies every binary promised by the restricted envelope before an import
 * artifact can be approved.  Paths, bytes, and source identifiers never
 * appear in the returned value or in errors.
 */
export async function verifyRestrictedArchiveBinaries(rootInput: string, envelope: ExportEnvelope): Promise<{ verifiedCount: number; descriptorDigestSha256: string; verifiedBinaries: readonly RestrictedVerifiedArchiveBinary[] }> {
  const root = resolve(rootInput);
  const candidates = [
    ...envelope.documentBinaries,
    ...(Array.isArray(envelope.payload.documentBinaries) ? envelope.payload.documentBinaries : []),
  ];
  const bySource = new Map<string, DocumentBinaryDescriptor>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") throw new RestrictedMigrationArchiveError(["restricted_archive_binary_descriptor_invalid"]);
    if (candidate.binaryAvailable !== true) continue;
    const sourceId = typeof candidate.sourceId === "string" ? candidate.sourceId.trim() : "";
    const archivePath = safeBinaryRelativePath(candidate.archivePath);
    const checksum = typeof candidate.sha256 === "string" ? candidate.sha256.toLowerCase() : "";
    const sizeBytes = candidate.sizeBytes;
    if (!sourceId || !SHA256.test(checksum) || !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_descriptor_invalid"]);
    const descriptor: DocumentBinaryDescriptor = { ...candidate, sourceId, archivePath, sha256: checksum, sizeBytes };
    const prior = bySource.get(sourceId);
    if (prior && binaryDescriptorKey(prior) !== binaryDescriptorKey(descriptor)) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_version_conflict"]);
    bySource.set(sourceId, descriptor);
  }

  let verifiedCount = 0;
  const descriptorDigests: string[] = [];
  const verifiedBinaries: RestrictedVerifiedArchiveBinary[] = [];
  for (const descriptor of Array.from(bySource.values()).sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
    const archivePath = safeBinaryRelativePath(descriptor.archivePath);
    const candidatePath = resolve(root, ...archivePath.split("/"));
    await assertRestrictedPathChain(root, candidatePath);
    const file = await readRestrictedFileFromDescriptor(root, candidatePath, "restricted_archive_binary_unreadable");
    const bytes = file.bytes;
    if (bytes.byteLength !== descriptor.sizeBytes) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_size_mismatch"]);
    if (file.sha256 !== descriptor.sha256) throw new RestrictedMigrationArchiveError(["restricted_archive_binary_checksum_mismatch"]);
    verifiedCount += 1;
    verifiedBinaries.push({
      sourceId: descriptor.sourceId,
      sourceCollection: typeof (descriptor as unknown as Record<string, unknown>).sourceCollection === "string"
        ? String((descriptor as unknown as Record<string, unknown>).sourceCollection)
        : "documentBinaries",
      archivePath,
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
      ...(descriptor.contentType ? { contentType: descriptor.contentType } : {}),
      bytes,
    });
    descriptorDigests.push(canonicalJson({ sourceIdDigest: sha256(descriptor.sourceId), archivePathDigest: sha256(archivePath), sha256: descriptor.sha256, sizeBytes: descriptor.sizeBytes, contentType: descriptor.contentType ?? null }));
  }
  return { verifiedCount, descriptorDigestSha256: sha256(descriptorDigests.sort().join("\n")), verifiedBinaries };
}

function parseRestrictedJson<T>(contents: string, code: string): T {
  try { return JSON.parse(contents) as T; }
  catch { throw new RestrictedMigrationArchiveError([code]); }
}

const RESTRICTED_SUPPLEMENT_PROVENANCE_FILE = "restricted-supplement-provenance.json" as const;
const RESTRICTED_SUPPLEMENT_PROVENANCE_VERSION = "rm-restricted-supplement-derivative/v1" as const;
const RESTRICTED_SUPPLEMENT_EVIDENCE_VERSION = "rm-restricted-supplement/v1" as const;
const RESTRICTED_SUPPLEMENT_RECEIPT_VERSION = "rm-restricted-supplement-verification-receipt/v1" as const;
const SUPPLEMENT_PROVENANCE_KEYS = [
  "version",
  "sourceRunId",
  "createdAt",
  "parentEnvelopeSha256",
  "parentManifestSha256",
  "supplementSha256",
  "attestationSha256",
  "rowSetSha256",
  "derivativeEnvelopeSha256",
  "derivativeManifestSha256",
  "approval",
  "externalVerificationIdHash",
  "countsAdded",
  "exceptionsRemoved",
  "removedExceptionHashes",
] as const;
const SUPPLEMENT_APPROVAL_KEYS = [
  "approvalId",
  "approvedAt",
  "operatorReferenceHash",
  "gate",
  "gateNonceHash",
  "gateMetadataSha256",
] as const;

function supplementRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RestrictedMigrationArchiveError([code]);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new RestrictedMigrationArchiveError([code]);
}

function supplementSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new RestrictedMigrationArchiveError([code]);
  return value.toLowerCase();
}

function supplementToken(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000 || /[\u0000\r\n]/.test(value)) {
    throw new RestrictedMigrationArchiveError([code]);
  }
  return value;
}

function supplementTimestamp(value: unknown, code: string): string {
  const text = supplementToken(value, code);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) throw new RestrictedMigrationArchiveError([code]);
  return text;
}

function supplementNonnegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RestrictedMigrationArchiveError([code]);
  return value as number;
}

/**
 * Reads the optional derivative provenance through the same no-follow,
 * descriptor-stat boundary as the required archive files.  ENOENT is the
 * only non-error result: a missing receipt is a blocked/no-approval state at
 * the artifact boundary, not an archive read failure.
 */
async function readOptionalRestrictedSupplementProvenance(
  canonicalRoot: string,
): Promise<{ bytes: Uint8Array; sha256: string } | undefined> {
  const path = resolve(canonicalRoot, RESTRICTED_SUPPLEMENT_PROVENANCE_FILE);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_unreadable"]);
  }
  if (stats.isSymbolicLink()) throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_symlink_rejected"]);
  if (!stats.isFile()) throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_type_invalid"]);
  if ((stats.mode & 0o077) !== 0) throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_permissions_invalid"]);
  if (stats.nlink !== 1) throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_hardlink_rejected"]);
  try {
    return await readRestrictedFileFromDescriptor(canonicalRoot, path, "restricted_supplement_provenance_unreadable", stats);
  } catch (error) {
    if (error instanceof RestrictedMigrationArchiveError) throw error;
    throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_unreadable"]);
  }
}

function buildVerifiedSupplementReceipt(
  parsed: unknown,
  provenanceBytes: Uint8Array,
  envelope: ExportEnvelope,
  manifest: RedactedExportManifest,
): VerifiedSupplementReceiptBinding {
  const provenance = supplementRecord(parsed, "restricted_supplement_provenance_invalid");
  assertExactKeys(provenance, SUPPLEMENT_PROVENANCE_KEYS, "restricted_supplement_provenance_unsupported_field");
  if (provenance.version !== RESTRICTED_SUPPLEMENT_PROVENANCE_VERSION) throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_version_invalid"]);

  const sourceRunId = supplementToken(provenance.sourceRunId, "restricted_supplement_source_run_invalid");
  if (sourceRunId !== envelope.runId || manifest.runId !== envelope.runId) throw new RestrictedMigrationArchiveError(["restricted_supplement_source_run_mismatch"]);
  const createdAt = supplementTimestamp(provenance.createdAt, "restricted_supplement_provenance_timestamp_invalid");
  const parentEnvelopeSha256 = supplementSha256(provenance.parentEnvelopeSha256, "restricted_supplement_parent_envelope_hash_invalid");
  const parentManifestSha256 = supplementSha256(provenance.parentManifestSha256, "restricted_supplement_parent_manifest_hash_invalid");
  const supplementSha256Value = supplementSha256(provenance.supplementSha256, "restricted_supplement_hash_invalid");
  const attestationSha256 = supplementSha256(provenance.attestationSha256, "restricted_supplement_attestation_hash_invalid");
  const rowSetSha256 = supplementSha256(provenance.rowSetSha256, "restricted_supplement_row_set_hash_invalid");
  const derivativeEnvelopeSha256 = supplementSha256(provenance.derivativeEnvelopeSha256, "restricted_supplement_derivative_envelope_hash_invalid");
  const derivativeManifestSha256 = supplementSha256(provenance.derivativeManifestSha256, "restricted_supplement_derivative_manifest_hash_invalid");
  const externalVerificationIdHash = supplementSha256(provenance.externalVerificationIdHash, "restricted_supplement_external_receipt_hash_invalid");

  const approval = supplementRecord(provenance.approval, "restricted_supplement_approval_invalid");
  assertExactKeys(approval, SUPPLEMENT_APPROVAL_KEYS, "restricted_supplement_approval_unsupported_field");
  supplementToken(approval.approvalId, "restricted_supplement_approval_id_invalid");
  supplementTimestamp(approval.approvedAt, "restricted_supplement_approval_timestamp_invalid");
  supplementSha256(approval.operatorReferenceHash, "restricted_supplement_operator_hash_invalid");
  supplementToken(approval.gate, "restricted_supplement_gate_invalid");
  if (approval.gateNonceHash !== undefined) supplementSha256(approval.gateNonceHash, "restricted_supplement_gate_nonce_hash_invalid");
  if (approval.gateMetadataSha256 !== undefined) supplementSha256(approval.gateMetadataSha256, "restricted_supplement_gate_metadata_hash_invalid");

  const countsAdded = supplementRecord(provenance.countsAdded, "restricted_supplement_counts_invalid");
  assertExactKeys(countsAdded, ["application_answers", "hap_subsidies", "document_binaries"], "restricted_supplement_counts_invalid");
  for (const key of ["application_answers", "hap_subsidies", "document_binaries"] as const) supplementNonnegativeInteger(countsAdded[key], "restricted_supplement_counts_invalid");
  const exceptionsRemoved = supplementNonnegativeInteger(provenance.exceptionsRemoved, "restricted_supplement_exception_count_invalid");
  if (!Array.isArray(provenance.removedExceptionHashes) || provenance.removedExceptionHashes.length !== exceptionsRemoved || provenance.removedExceptionHashes.some((hash) => typeof hash !== "string" || !SHA256.test(hash))) {
    throw new RestrictedMigrationArchiveError(["restricted_supplement_exception_hashes_invalid"]);
  }
  // Keep this value in the validation path so a provenance file cannot be
  // swapped for a different byte sequence after it was descriptor-read.
  if (sha256(provenanceBytes) !== sha256(Buffer.from(canonicalJson(provenance)))) throw new RestrictedMigrationArchiveError(["restricted_supplement_provenance_canonical_mismatch"]);
  const provenanceSha256 = sha256(canonicalJson(provenance));

  const derivativeEnvelopeActual = sha256(canonicalJson(envelope));
  const derivativeManifestActual = sha256(canonicalJson(manifest));
  if (derivativeEnvelopeSha256 !== derivativeEnvelopeActual) throw new RestrictedMigrationArchiveError(["restricted_supplement_derivative_envelope_mismatch"]);
  if (derivativeManifestSha256 !== derivativeManifestActual) throw new RestrictedMigrationArchiveError(["restricted_supplement_derivative_manifest_mismatch"]);
  if (manifest.archiveEnvelopeSha256 !== derivativeEnvelopeActual) throw new RestrictedMigrationArchiveError(["restricted_supplement_manifest_envelope_mismatch"]);

  const evidence = supplementRecord((envelope as unknown as Record<string, unknown>).supplementEvidence, "restricted_supplement_envelope_evidence_missing");
  assertExactKeys(evidence, ["version", "sourceRunId", "supplementSha256", "attestationSha256", "kinds", "rowHashes", "rowSetSha256"], "restricted_supplement_envelope_evidence_invalid");
  if (evidence.version !== RESTRICTED_SUPPLEMENT_EVIDENCE_VERSION || evidence.sourceRunId !== sourceRunId) throw new RestrictedMigrationArchiveError(["restricted_supplement_envelope_evidence_binding_invalid"]);
  if (supplementSha256(evidence.supplementSha256, "restricted_supplement_envelope_evidence_invalid") !== supplementSha256Value) throw new RestrictedMigrationArchiveError(["restricted_supplement_supplement_hash_mismatch"]);
  if (supplementSha256(evidence.attestationSha256, "restricted_supplement_envelope_evidence_invalid") !== attestationSha256) throw new RestrictedMigrationArchiveError(["restricted_supplement_attestation_hash_mismatch"]);
  if (!Array.isArray(evidence.kinds) || evidence.kinds.some((kind) => typeof kind !== "string" || !kind.trim())) throw new RestrictedMigrationArchiveError(["restricted_supplement_envelope_evidence_invalid"]);
  if (!Array.isArray(evidence.rowHashes) || evidence.rowHashes.some((hash) => typeof hash !== "string" || !SHA256.test(hash))) throw new RestrictedMigrationArchiveError(["restricted_supplement_row_hashes_invalid"]);
  const rowHashes = (evidence.rowHashes as string[]).map((hash) => hash.toLowerCase()).sort();
  const computedRowSetSha256 = sha256(rowHashes.join("\n"));
  if (computedRowSetSha256 !== rowSetSha256 || computedRowSetSha256 !== supplementSha256(evidence.rowSetSha256, "restricted_supplement_envelope_evidence_invalid")) throw new RestrictedMigrationArchiveError(["restricted_supplement_row_set_hash_mismatch"]);

  return {
    version: RESTRICTED_SUPPLEMENT_RECEIPT_VERSION,
    sourceRunId,
    parentEnvelopeSha256,
    parentManifestSha256,
    derivativeEnvelopeSha256,
    derivativeManifestSha256,
    supplementSha256: supplementSha256Value,
    attestationSha256,
    rowSetSha256,
    externalVerificationIdHash,
    provenanceSha256,
  };
}

async function assertExternallyVerifiedSupplementReceipt(
  receipt: VerifiedSupplementReceiptBinding,
  verifier: VerifiedSupplementReceiptVerifier | undefined,
): Promise<void> {
  if (!verifier) throw new RestrictedMigrationArchiveError(["restricted_supplement_external_verifier_missing"]);
  let verification: VerifiedSupplementReceiptVerification;
  try {
    verification = await verifier({
      sourceRunId: receipt.sourceRunId,
      parentEnvelopeSha256: receipt.parentEnvelopeSha256,
      parentManifestSha256: receipt.parentManifestSha256,
      derivativeEnvelopeSha256: receipt.derivativeEnvelopeSha256,
      derivativeManifestSha256: receipt.derivativeManifestSha256,
      supplementSha256: receipt.supplementSha256,
      attestationSha256: receipt.attestationSha256,
      rowSetSha256: receipt.rowSetSha256,
      provenanceSha256: receipt.provenanceSha256,
    });
  } catch {
    throw new RestrictedMigrationArchiveError(["restricted_supplement_external_verification_failed"]);
  }
  if (!verification || verification.verified !== true) throw new RestrictedMigrationArchiveError(["restricted_supplement_external_verification_invalid"]);
  let externalVerificationIdHash: string | undefined;
  if (typeof verification.externalVerificationIdHash === "string" && SHA256.test(verification.externalVerificationIdHash)) {
    externalVerificationIdHash = verification.externalVerificationIdHash.toLowerCase();
  } else if (typeof verification.receiptId === "string" && verification.receiptId.length > 0 && verification.receiptId.length <= 1000 && !/[\u0000\r\n]/.test(verification.receiptId)) {
    externalVerificationIdHash = sha256(verification.receiptId);
  }
  if (!externalVerificationIdHash) throw new RestrictedMigrationArchiveError(["restricted_supplement_external_verification_invalid"]);
  if (externalVerificationIdHash !== receipt.externalVerificationIdHash) throw new RestrictedMigrationArchiveError(["restricted_supplement_external_receipt_mismatch"]);
}

function pageRow(value: unknown, collectionName: string, system: string): {
  system: string;
  sourceCollection: string;
  sourceId: string;
  sourceUpdatedAt?: string;
  canonicalPayload: string;
  checksumSha256: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RestrictedMigrationArchiveError(["restricted_archive_page_row_invalid"]);
  const record = value as Record<string, unknown>;
  const sourceCollection = typeof record.sourceCollection === "string" && record.sourceCollection.trim() ? record.sourceCollection.trim() : collectionName;
  const sourceIdValue = record.sourceId;
  const sourceId = sourceIdValue === undefined || sourceIdValue === null ? "" : String(sourceIdValue).trim();
  if (!sourceId) throw new RestrictedMigrationArchiveError(["restricted_archive_page_row_identity_invalid"]);
  let canonicalPayload: string;
  try { canonicalPayload = canonicalJson(record); }
  catch { throw new RestrictedMigrationArchiveError(["restricted_archive_page_row_invalid"]); }
  const sourceUpdatedAtValue = record.sourceUpdatedAt ?? record.updatedAt ?? record.UpdateDate;
  let sourceUpdatedAt: string | undefined;
  if (sourceUpdatedAtValue !== undefined && sourceUpdatedAtValue !== null && sourceUpdatedAtValue !== "") {
    const parsed = new Date(String(sourceUpdatedAtValue));
    if (!Number.isFinite(parsed.getTime())) throw new RestrictedMigrationArchiveError(["restricted_archive_page_timestamp_invalid"]);
    sourceUpdatedAt = parsed.toISOString();
  }
  return {
    system,
    sourceCollection,
    sourceId,
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    canonicalPayload,
    checksumSha256: sha256(canonicalPayload),
  };
}

async function readRestrictedArchiveParitySource(
  root: string,
  envelope: ExportEnvelope,
  manifest: RedactedExportManifest,
  checkpointFile: { bytes: Uint8Array; sha256: string },
  coverageFile: { bytes: Uint8Array; sha256: string },
): Promise<RestrictedMigrationArchiveParitySource> {
  const checkpoint = parseRestrictedJson<ExportCheckpoint>(Buffer.from(checkpointFile.bytes).toString("utf8"), "export_checkpoint_json_invalid");
  const coverage = parseRestrictedJson<CollectionCoverage[]>(Buffer.from(coverageFile.bytes).toString("utf8"), "export_coverage_json_invalid");
  if (checkpoint.version !== 2 || checkpoint.runId !== envelope.runId || checkpoint.registryHash !== manifest.registryHash || checkpoint.complete !== true) {
    throw new RestrictedMigrationArchiveError(["restricted_archive_checkpoint_binding_invalid"]);
  }
  if (!Array.isArray(coverage) || canonicalJson(coverage) !== canonicalJson(manifest.collections)) {
    throw new RestrictedMigrationArchiveError(["restricted_archive_coverage_manifest_mismatch"]);
  }
  const coverageByName = new Map(coverage.map((entry) => [entry.name, entry]));
  const seenPageFiles = new Set<string>();
  const pageDigests: Array<{ pathSha256: string; sha256: string }> = [];
  const sourceChunks: RestrictedParitySourceChunk[] = [];
  const checkpointCollections = checkpoint.collections ?? {};
  for (const collection of coverage) {
    const state = checkpointCollections[collection.name] as CollectionCheckpoint | undefined;
    const pageFiles = state?.pageFiles ?? [];
    if (!state && collection.status !== "empty") throw new RestrictedMigrationArchiveError(["restricted_archive_checkpoint_collection_missing"]);
    let stateRowIndex = 0;
    if (state && pageFiles.length > 0) {
      if (!Array.isArray(state.hashes) || state.hashes.length !== state.received) throw new RestrictedMigrationArchiveError(["restricted_archive_page_checkpoint_mismatch"]);
      for (const pagePath of pageFiles) {
        if (typeof pagePath !== "string" || !/^pages\/[A-Za-z0-9._-]+\.json$/.test(pagePath) || seenPageFiles.has(pagePath)) {
          throw new RestrictedMigrationArchiveError(["restricted_archive_page_reference_invalid"]);
        }
        seenPageFiles.add(pagePath);
        const pageFile = await readRestrictedFileFromDescriptor(root, resolve(root, pagePath), "restricted_archive_page_unreadable");
        const page = parseRestrictedJson<unknown[]>(Buffer.from(pageFile.bytes).toString("utf8"), "restricted_archive_page_json_invalid");
        if (!Array.isArray(page)) throw new RestrictedMigrationArchiveError(["restricted_archive_page_shape_invalid"]);
        const rows = page.map((value) => pageRow(value, collection.name, envelope.source.system));
        for (const row of rows) {
          let rowHash: string;
          try { rowHash = hashRecord(JSON.parse(row.canonicalPayload)); }
          catch { throw new RestrictedMigrationArchiveError(["restricted_archive_page_row_invalid"]); }
          if (state.hashes[stateRowIndex] !== rowHash) throw new RestrictedMigrationArchiveError(["restricted_archive_page_checkpoint_mismatch"]);
          stateRowIndex += 1;
        }
        sourceChunks.push(...partitionRestrictedSourceRows(collection.name, collection.path, rows));
        pageDigests.push({ pathSha256: sha256(pagePath), sha256: pageFile.sha256 });
      }
      if (stateRowIndex !== state.received || stateRowIndex !== collection.received || stateRowIndex !== state.hashes.length) {
        throw new RestrictedMigrationArchiveError(["restricted_archive_page_checkpoint_mismatch"]);
      }
    } else {
      const present = state?.status === "complete" || collection.status === "empty";
      if (state && (!Array.isArray(state.hashes) || state.received !== 0 || state.hashes.length !== 0)) throw new RestrictedMigrationArchiveError(["restricted_archive_page_checkpoint_mismatch"]);
      sourceChunks.push({ collectionName: collection.name, path: collection.path, present, rows: [] });
    }
    const knownAbsent = collection.status === "not_available" && state?.status === "not_available";
    if (state && collection.status !== "empty" && !knownAbsent && state.status !== "complete") throw new RestrictedMigrationArchiveError(["restricted_archive_collection_incomplete"]);
    if (!coverageByName.has(collection.name)) throw new RestrictedMigrationArchiveError(["restricted_archive_coverage_manifest_mismatch"]);
  }
  if (Object.keys(checkpointCollections).some((name) => !coverageByName.has(name))) throw new RestrictedMigrationArchiveError(["restricted_archive_checkpoint_collection_unknown"]);
  const pageFileSetSha256 = sha256(canonicalJson(pageDigests));
  const schemaVersion = `checkpoint-${checkpoint.version}`;
  const controlSha256 = sha256(canonicalJson({
    sourceRunId: envelope.runId,
    registryHash: manifest.registryHash,
    checkpointSha256: checkpointFile.sha256,
    coverageSha256: coverageFile.sha256,
    schemaVersion,
  }));
  return {
    sourceChunks,
    pageFileSetSha256,
    pageFileCount: pageDigests.length,
    sourceControls: {
      schemaVersion,
      registryHash: manifest.registryHash,
      checkpointSha256: checkpointFile.sha256,
      coverageSha256: coverageFile.sha256,
      controlSha256,
    },
  };
}

function restrictedRecordText(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

function restrictedDocumentSourceId(record: Record<string, unknown>): string | undefined {
  return restrictedRecordText(record, "sourceId", "id", "ID", "DocumentID");
}

/** Resolve only source names and byte-proven PDF MIME when the archive lacks a MIME label. */
export function restrictedDocumentTransferMetadata(document: Pick<RentOpsDocument, "fileName" | "mimeType">, metadata: Record<string, unknown> | undefined, binary: Pick<RestrictedVerifiedArchiveBinary, "bytes" | "contentType">): { fileName?: string; mimeType?: string } {
  const fileName = (typeof document.fileName === "string" && document.fileName.trim() ? document.fileName.trim() : undefined)
    ?? (metadata ? restrictedRecordText(metadata, "fileName", "name", "FileName", "Name") : undefined);
  const declared = (typeof document.mimeType === "string" && document.mimeType.trim() ? document.mimeType.trim() : undefined)
    ?? binary.contentType
    ?? (metadata ? restrictedRecordText(metadata, "mimeType", "contentType", "ContentType") : undefined);
  const isPdf = Buffer.from(binary.bytes).subarray(0, 5).toString("ascii") === "%PDF-";
  if ((isPdf && declared && declared !== "application/pdf" && declared !== "application/octet-stream")
    || (declared === "application/pdf" && !isPdf)) throw new RestrictedMigrationArchiveError(["restricted_document_mime_bytes_mismatch"]);
  return { fileName, mimeType: declared ?? (isPdf ? "application/pdf" : undefined) };
}

function restrictedDocumentBinaryInputs(
  archive: RestrictedMigrationArchive,
  importRunId: string,
  documents: readonly RentOpsDocument[],
  restrictedSourceInput: unknown,
): VerifiedDocumentArchiveInput[] {
  const documentsBySource = new Map<string, RentOpsDocument[]>();
  for (const document of documents) {
    const sourceId = document.source?.sourceId;
    if (!sourceId) continue;
    const rows = documentsBySource.get(sourceId) ?? [];
    rows.push(document);
    documentsBySource.set(sourceId, rows);
  }
  const envelopeRecord = restrictedSourceInput as Record<string, unknown>;
  const payload = (envelopeRecord.payload && typeof envelopeRecord.payload === "object" ? envelopeRecord.payload : {}) as Record<string, unknown>;
  const documentRows = Array.isArray(payload.documents)
    ? payload.documents.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    : [];
  const documentMetadata = new Map(documentRows.map((row) => [restrictedDocumentSourceId(row), row] as const));
  const inputs: VerifiedDocumentArchiveInput[] = [];
  for (const binary of archive.verifiedBinaries) {
    const matches = documentsBySource.get(binary.sourceId) ?? [];
    if (matches.length !== 1) throw new RestrictedMigrationArchiveError([matches.length === 0 ? "restricted_document_binary_target_missing" : "restricted_document_binary_target_ambiguous"]);
    const document = matches[0]!;
    const metadata = documentMetadata.get(binary.sourceId);
    const { fileName, mimeType } = restrictedDocumentTransferMetadata(document, metadata, binary);
    if (!fileName || !mimeType || !document.id) throw new RestrictedMigrationArchiveError(["restricted_document_metadata_invalid"]);
    const bindingId = restrictedSourceBinaryId("rent_manager", binary.sourceCollection, binary.sourceId, binary.sha256);
    inputs.push({
      documentId: document.id,
      type: document.type,
      fileName,
      mimeType,
      bytes: binary.bytes,
      sizeBytes: binary.sizeBytes,
      checksumSha256: binary.sha256,
      ...(document.propertyId ? { propertyId: document.propertyId } : {}),
      ...(document.unitId ? { unitId: document.unitId } : {}),
      ...(document.personId ? { personId: document.personId } : {}),
      ...(document.tenancyId ? { tenancyId: document.tenancyId } : {}),
      ...(document.applicationId ? { applicationId: document.applicationId } : {}),
      sourceBinaryBinding: {
        bindingId,
        sourceSystem: "rent_manager",
        sourceCollection: binary.sourceCollection,
        sourceIdHash: sha256(binary.sourceId),
        importRunId,
      },
    });
  }
  return inputs;
}

function safeAmount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function sumAmounts<T>(rows: readonly T[], value: (row: T) => unknown): number {
  return rows.reduce((total, row) => total + safeAmount(value(row)), 0);
}

function sourceIdentityKey(system: unknown, sourceId: unknown): string {
  return `${String(system ?? "")}\u0000${String(sourceId ?? "")}`;
}

function distinctSourceCount(rows: readonly RentOpsSourceRecord[]): number {
  return new Set(rows.map((row) => sourceIdentityKey(row.system, row.sourceId))).size;
}

function monthStartFor(asOfDate: string): string {
  return `${asOfDate.slice(0, 7)}-01`;
}

function effectiveHapContracts(snapshot: RentOpsSnapshot, asOfDate: string): RentOpsSubsidyContract[] {
  const monthStart = monthStartFor(asOfDate);
  return snapshot.subsidyContracts.filter((contract) =>
    contract.status !== "pending"
    && !(contract.status === "ended" && !contract.effectiveTo)
    && contract.effectiveFrom <= monthStart
    && (!contract.effectiveTo || contract.effectiveTo >= monthStart),
  );
}

function currentUnitIds(snapshot: RentOpsSnapshot, asOfDate: string, propertyId?: string): Set<string> {
  return new Set(snapshot.tenancies
    .filter((tenancy) => (!propertyId || tenancy.propertyId === propertyId)
      && (tenancy.status === "current" || tenancy.status === "notice")
      && Boolean(tenancy.unitId)
      && Boolean(tenancy.actualMoveInOn && tenancy.actualMoveInOn <= asOfDate)
      && (!tenancy.actualMoveOutOn || tenancy.actualMoveOutOn > asOfDate))
    .map((tenancy) => tenancy.unitId as string));
}

function futureUnitIds(snapshot: RentOpsSnapshot, asOfDate: string, propertyId?: string): Set<string> {
  return new Set(snapshot.tenancies
    .filter((tenancy) => (!propertyId || tenancy.propertyId === propertyId)
      && tenancy.status === "future"
      && Boolean(tenancy.unitId)
      && Boolean(tenancy.plannedMoveInOn && tenancy.plannedMoveInOn > asOfDate))
    .map((tenancy) => tenancy.unitId as string));
}

function hasUnresolvedTenancyForUnit(snapshot: RentOpsSnapshot, unit: RentOpsSnapshot["units"][number]): boolean {
  const validStatuses = new Set(["current", "notice", "future", "past", "cancelled"]);
  return snapshot.tenancies.some((tenancy) => {
    const sameUnit = tenancy.unitId === unit.id;
    const samePropertyWhenUnitUnknown = !tenancy.unitId && (tenancy.propertyId === unit.propertyId || !tenancy.propertyId);
    if (!sameUnit && !samePropertyWhenUnitUnknown) return false;
    return !tenancy.status
      || !validStatuses.has(tenancy.status)
      || !tenancy.unitId
      || tenancy.unitLinkKnowledge === "unknown"
      || tenancy.unitLinkKnowledge === "ambiguous"
      || ((tenancy.status === "current" || tenancy.status === "notice") && !tenancy.actualMoveInOn)
      || (tenancy.status === "future" && !tenancy.plannedMoveInOn);
  });
}

function activeHapReceiptControls(snapshot: RentOpsSnapshot, asOfDate: string, contracts: readonly RentOpsSubsidyContract[]): {
  receiptCount: number;
  knownReceiptCount: number;
  unknownReceiptCount: number;
  receiptCents: number;
} {
  const activeIds = new Set(contracts.map((contract) => contract.id));
  const month = asOfDate.slice(0, 7);
  const payments = snapshot.subsidyPayments.filter((payment) => payment.subsidyContractId && activeIds.has(payment.subsidyContractId));
  const nonterminal = payments.filter((payment) => payment.status !== "pending" && payment.status !== "voided" && payment.status !== "reversed");
  const known = nonterminal.filter((payment) => payment.status === "received"
    && payment.statusKnowledge === "source"
    && payment.amountKnowledge === "known"
    && payment.amountCents !== undefined
    && payment.paymentOnKnowledge === "source"
    && Boolean(payment.paymentOn)
    && (payment.paymentOn as string) <= asOfDate
    && (payment.paymentOn as string).slice(0, 7) === month);
  const unknown = nonterminal.filter((payment) => !payment.status
    || payment.statusKnowledge !== "source"
    || (payment.status === "received" && (payment.amountKnowledge !== "known" || payment.amountCents === undefined || payment.paymentOnKnowledge !== "source" || !payment.paymentOn)));
  return {
    receiptCount: nonterminal.length,
    knownReceiptCount: known.length,
    unknownReceiptCount: unknown.length,
    receiptCents: sumAmounts(known, (payment) => payment.amountCents),
  };
}

export function reportParityForSnapshot(snapshot: RentOpsSnapshot, asOfDate: string): DatabaseAuditExpected["reportParity"] {
  const current = currentUnitIds(snapshot, asOfDate);
  const future = futureUnitIds(snapshot, asOfDate);
  const vacant = snapshot.units.filter((unit) => !current.has(unit.id) && !future.has(unit.id) && !hasUnresolvedTenancyForUnit(snapshot, unit)).length;
  const contracts = effectiveHapContracts(snapshot, asOfDate);
  const receipt = activeHapReceiptControls(snapshot, asOfDate, contracts);
  // Schedule versions are append-only.  A predecessor keeps its original
  // stored open end, so filter through the derived lineage interval rather
  // than the row's raw effectiveTo; otherwise replacement chains double-count
  // and terminal end rows resurrect the predecessor in parity controls.
  const intervals = effectiveScheduleIntervals(snapshot.recurringSchedules);
  const activeSchedules = snapshot.recurringSchedules.filter((schedule) => {
    if (schedule.active === false) return false;
    const interval = intervals.get(schedule);
    return (!interval?.effectiveFrom || interval.effectiveFrom <= asOfDate)
      && (!interval?.effectiveTo || interval.effectiveTo >= asOfDate);
  });
  return {
    rentRollRows: snapshot.units.length,
    currentOccupiedUnits: current.size,
    futurePreleasedUnits: future.size,
    vacantUnits: vacant,
    activeHapContracts: contracts.length,
    hapAgencyCents: sumAmounts(contracts, (contract) => contract.agencyObligationCents),
    hapTenantCents: sumAmounts(contracts, (contract) => contract.tenantObligationCents),
    hapReceiptCount: receipt.receiptCount,
    hapKnownReceiptCount: receipt.knownReceiptCount,
    hapUnknownReceiptCount: receipt.unknownReceiptCount,
    hapReceiptCents: receipt.receiptCents,
    hapExpectedAgencyCents: sumAmounts(contracts, (contract) => contract.agencyObligationCents),
    hapReceivedAgencyCents: receipt.receiptCents,
    hapVarianceCents: receipt.receiptCents - sumAmounts(contracts, (contract) => contract.agencyObligationCents),
    effectiveBaseRentCents: sumAmounts(activeSchedules.filter((schedule) => schedule.category === "base_rent"), (schedule) => schedule.amountCents),
    effectiveRecurringFeesCents: sumAmounts(activeSchedules.filter((schedule) => schedule.category === "recurring_fee"), (schedule) => schedule.amountCents),
  };
}

function perPropertyControls(snapshot: RentOpsSnapshot, asOfDate: string): DatabaseAuditExpectedProperty[] {
  const contracts = effectiveHapContracts(snapshot, asOfDate);
  const transactionById = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.id, transaction]));
  return snapshot.properties.map((property) => {
    const propertyUnits = snapshot.units.filter((unit) => unit.propertyId === property.id);
    const current = currentUnitIds(snapshot, asOfDate, property.id);
    const future = futureUnitIds(snapshot, asOfDate, property.id);
    const ledger = snapshot.ledgerTransactions.filter((transaction) => transaction.propertyId === property.id);
    const allocations = snapshot.paymentAllocations.filter((allocation) => {
      const payment = allocation.paymentTransactionId ? transactionById.get(allocation.paymentTransactionId) : undefined;
      const charge = allocation.chargeTransactionId ? transactionById.get(allocation.chargeTransactionId) : undefined;
      return payment?.propertyId === property.id || charge?.propertyId === property.id;
    });
    const propertyContracts = contracts.filter((contract) => contract.propertyId === property.id);
    return {
      propertyId: property.id,
      unitCount: propertyUnits.length,
      currentOccupiedUnits: current.size,
      futurePreleasedUnits: future.size,
      chargeCount: ledger.filter((transaction) => transaction.kind === "charge").length,
      paymentCount: ledger.filter((transaction) => transaction.kind === "payment").length,
      creditCount: ledger.filter((transaction) => transaction.kind === "credit").length,
      chargesCents: sumAmounts(ledger.filter((transaction) => transaction.kind === "charge"), (transaction) => transaction.amountCents),
      paymentsCents: sumAmounts(ledger.filter((transaction) => transaction.kind === "payment"), (transaction) => transaction.amountCents),
      creditsCents: sumAmounts(ledger.filter((transaction) => transaction.kind === "credit"), (transaction) => transaction.amountCents),
      allocationsCents: sumAmounts(allocations, (allocation) => allocation.amountCents),
      depositsCents: sumAmounts(snapshot.securityDeposits.filter((deposit) => deposit.propertyId === property.id), (deposit) => deposit.sourceBalanceCents ?? deposit.amountHeldCents),
      activeHapContracts: propertyContracts.length,
      hapAgencyCents: sumAmounts(propertyContracts, (contract) => contract.agencyObligationCents),
      hapTenantCents: sumAmounts(propertyContracts, (contract) => contract.tenantObligationCents),
    };
  });
}

function migrationSchemaBinding(): RestrictedMigrationSchemaBinding {
  const migrationChecksums: Record<number, string> = {};
  for (let version = 1; version <= RENT_OPS_SCHEMA_VERSION; version += 1) migrationChecksums[version] = rentOpsMigrationChecksumForVersion(version);
  return {
    version: RENT_OPS_SCHEMA_VERSION,
    requiredTables: RENT_OPS_REQUIRED_TABLES.length,
    checksum: migrationChecksums[RENT_OPS_SCHEMA_VERSION]!,
    migrationChecksums,
    migrationChainSha256: sha256(canonicalJson(migrationChecksums)),
  };
}

function restrictedVersionCanonical(row: Pick<DatabaseAuditRestrictedVersion, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): string {
  return [row.system, row.sourceCollection, row.sourceId, row.checksumSha256].map((value) => `${value.length}:${value}`).join("|");
}

function restrictedDescriptorCanonical(row: DatabaseAuditRestrictedBinaryDescriptor): string {
  return [restrictedVersionCanonical(row), String(row.sizeBytes), row.contentType ?? "", row.verificationStatus].map((value) => `${value.length}:${value}`).join("|");
}

function digestSortedStrings(values: readonly string[]): string {
  return sha256(values.slice().sort().join("\n"));
}

function restrictedExpectedControls(
  archive: RestrictedMigrationArchive,
  payloadBindings: readonly { system: string; sourceCollection: string; sourceId: string; checksumSha256: string }[],
): Pick<DatabaseAuditExpected, "restrictedSourcePayloads" | "restrictedSourceBinaries"> {
  const payloadRecords: DatabaseAuditRestrictedVersion[] = payloadBindings.map((binding) => ({
    system: binding.system,
    sourceCollection: binding.sourceCollection,
    sourceId: binding.sourceId,
    checksumSha256: binding.checksumSha256,
  }));
  const binaryRecords: DatabaseAuditRestrictedBinaryDescriptor[] = archive.verifiedBinaries.map((binary) => ({
    system: "rent_manager",
    sourceCollection: binary.sourceCollection,
    sourceId: binary.sourceId,
    checksumSha256: binary.sha256,
    sizeBytes: binary.sizeBytes,
    contentType: binary.contentType ?? null,
    verificationStatus: "verified",
  }));
  const payloadSources = new Set(payloadRecords.map((row) => `${row.system}\u0000${row.sourceCollection}\u0000${row.sourceId}`));
  const binarySources = new Set(binaryRecords.map((row) => `${row.system}\u0000${row.sourceCollection}\u0000${row.sourceId}`));
  return {
    restrictedSourcePayloads: {
      records: payloadRecords,
      rowCount: payloadRecords.length,
      distinctSourceCount: payloadSources.size,
      distinctVersionCount: payloadRecords.length,
      checksumDigestSha256: digestSortedStrings(payloadRecords.map((row) => row.checksumSha256)),
      versionDigestSha256: digestSortedStrings(payloadRecords.map(restrictedVersionCanonical)),
    },
    restrictedSourceBinaries: {
      records: binaryRecords,
      rowCount: binaryRecords.length,
      distinctSourceCount: binarySources.size,
      distinctVersionCount: binaryRecords.length,
      verifiedCount: binaryRecords.length,
      missingCount: 0,
      mismatchCount: 0,
      invalidStatusCount: 0,
      invalidChecksumCount: 0,
      checksumDigestSha256: digestSortedStrings(binaryRecords.map((row) => row.checksumSha256)),
      versionDigestSha256: digestSortedStrings(binaryRecords.map(restrictedVersionCanonical)),
      descriptorDigestSha256: digestSortedStrings(binaryRecords.map(restrictedDescriptorCanonical)),
    },
  };
}

function expectedFidelityControls(snapshot: RentOpsSnapshot, sourceRecords: readonly RentOpsSourceRecord[], asOfDate: string): Record<string, number> {
  const schedules = snapshot.recurringSchedules;
  const deposits = snapshot.securityDeposits;
  const tenants = snapshot.subsidyTenants;
  const payments = snapshot.subsidyPayments;
  const scheduleSources = sourceRecords.filter((row) => row.entityType === "recurring_schedule");
  const depositSources = sourceRecords.filter((row) => row.entityType === "deposit");
  const contractSources = sourceRecords.filter((row) => row.entityType === "subsidy");
  const tenantSources = sourceRecords.filter((row) => row.entityType === "subsidy_tenant");
  const paymentSources = sourceRecords.filter((row) => row.entityType === "subsidy_payment");
  const effectiveAmounts = effectiveFidelityScheduleAmounts(snapshot, asOfDate);
  const knownTenantDates = tenants.filter((row) => row.effectiveFrom !== undefined && row.effectiveFromKnowledge === "source" && row.effectiveTo !== undefined && row.effectiveToKnowledge === "source");
  const knownPaymentDates = payments.filter((row) => row.paymentOn !== undefined && row.paymentOnKnowledge === "source");
  const childAmountControls = (rows: readonly (RentOpsSubsidyTenant | RentOpsSubsidyPayment)[]) => ({
    known: rows.filter((row) => row.amountKnowledge === "known" && row.amountCents !== undefined).length,
    unknown: rows.filter((row) => row.amountKnowledge !== "known" || row.amountCents === undefined).length,
  });
  const tenantAmounts = childAmountControls(tenants);
  const paymentAmounts = childAmountControls(payments);
  return {
    schedule_row_count: schedules.length,
    schedule_source_row_count: scheduleSources.length,
    schedule_distinct_target_identity_count: distinctSourceCount(schedules.flatMap((row) => row.source ? [{ ...row.source, entityType: "recurring_schedule" as const, id: row.id, importedAt: "", targetId: row.id }] : [])),
    schedule_distinct_source_identity_count: distinctSourceCount(scheduleSources),
    schedule_tenant_count: schedules.filter((row) => row.scopeType === "tenant").length,
    schedule_tenant_amount_cents: sumAmounts(schedules.filter((row) => row.scopeType === "tenant"), (row) => row.amountCents),
    schedule_unit_count: schedules.filter((row) => row.scopeType === "unit").length,
    schedule_unit_amount_cents: sumAmounts(schedules.filter((row) => row.scopeType === "unit"), (row) => row.amountCents),
    schedule_property_count: schedules.filter((row) => row.scopeType === "property").length,
    schedule_property_amount_cents: sumAmounts(schedules.filter((row) => row.scopeType === "property"), (row) => row.amountCents),
    schedule_known_start_count: schedules.filter((row) => row.effectiveFrom !== undefined && row.effectiveFromKnowledge === "source").length,
    schedule_known_start_amount_cents: sumAmounts(schedules.filter((row) => row.effectiveFrom !== undefined && row.effectiveFromKnowledge === "source"), (row) => row.amountCents),
    schedule_unknown_start_count: schedules.filter((row) => row.effectiveFrom === undefined || row.effectiveFromKnowledge === "unknown_open_start").length,
    schedule_unknown_start_amount_cents: sumAmounts(schedules.filter((row) => row.effectiveFrom === undefined || row.effectiveFromKnowledge === "unknown_open_start"), (row) => row.amountCents),
    effective_base_rent_cents_independent: effectiveAmounts.baseRentCents,
    effective_recurring_fees_cents_independent: effectiveAmounts.recurringFeesCents,
    deposit_row_count: deposits.length,
    deposit_source_row_count: depositSources.length,
    deposit_distinct_target_identity_count: distinctSourceCount(deposits.flatMap((row) => row.source ? [{ ...row.source, entityType: "deposit" as const, id: row.id, importedAt: "", targetId: row.id }] : [])),
    deposit_distinct_source_identity_count: distinctSourceCount(depositSources),
    deposit_unknown_unit_count: deposits.filter((row) => row.unitId === undefined).length,
    deposit_unknown_unit_amount_cents: sumAmounts(deposits.filter((row) => row.unitId === undefined), (row) => row.sourceBalanceCents ?? row.amountHeldCents),
    deposit_unknown_receipt_date_count: deposits.filter((row) => row.receivedOn === undefined || row.receivedOnKnowledge === "unknown").length,
    deposit_unknown_receipt_amount_cents: sumAmounts(deposits.filter((row) => row.receivedOn === undefined || row.receivedOnKnowledge === "unknown"), (row) => row.sourceBalanceCents ?? row.amountHeldCents),
    deposit_known_receipt_date_count: deposits.filter((row) => row.receivedOn !== undefined && row.receivedOnKnowledge === "source").length,
    deposit_known_receipt_amount_cents: sumAmounts(deposits.filter((row) => row.receivedOn !== undefined && row.receivedOnKnowledge === "source"), (row) => row.sourceBalanceCents ?? row.amountHeldCents),
    hap_contract_row_count: snapshot.subsidyContracts.length,
    hap_contract_source_row_count: contractSources.length,
    hap_contract_distinct_target_identity_count: distinctSourceCount(snapshot.subsidyContracts.flatMap((row) => row.source ? [{ ...row.source, entityType: "subsidy" as const, id: row.id, importedAt: "", targetId: row.id }] : [])),
    hap_contract_distinct_source_identity_count: distinctSourceCount(contractSources),
    hap_tenant_row_count: tenants.length,
    hap_tenant_source_row_count: tenantSources.length,
    hap_tenant_distinct_target_identity_count: distinctSourceCount(tenants.flatMap((row) => row.source ? [{ ...row.source, entityType: "subsidy_tenant" as const, id: row.id, importedAt: "", targetId: row.id }] : [])),
    hap_tenant_distinct_source_identity_count: distinctSourceCount(tenantSources),
    hap_payment_row_count: payments.length,
    hap_payment_source_row_count: paymentSources.length,
    hap_payment_distinct_target_identity_count: distinctSourceCount(payments.flatMap((row) => row.source ? [{ ...row.source, entityType: "subsidy_payment" as const, id: row.id, importedAt: "", targetId: row.id }] : [])),
    hap_payment_distinct_source_identity_count: distinctSourceCount(paymentSources),
    hap_contract_known_status_count: snapshot.subsidyContracts.filter((row) => row.status !== undefined && row.statusKnowledge === "source").length,
    hap_contract_unknown_status_count: snapshot.subsidyContracts.filter((row) => row.status === undefined || row.statusKnowledge !== "source").length,
    hap_tenant_known_status_count: tenants.filter((row) => row.status !== undefined && row.statusKnowledge === "source").length,
    hap_tenant_unknown_status_count: tenants.filter((row) => row.status === undefined || row.statusKnowledge !== "source").length,
    hap_payment_known_status_count: payments.filter((row) => row.status !== undefined && row.statusKnowledge === "source").length,
    hap_payment_unknown_status_count: payments.filter((row) => row.status === undefined || row.statusKnowledge !== "source").length,
    hap_tenant_known_date_count: knownTenantDates.length,
    hap_tenant_unknown_date_count: tenants.length - knownTenantDates.length,
    hap_payment_known_date_count: knownPaymentDates.length,
    hap_payment_unknown_date_count: payments.length - knownPaymentDates.length,
    hap_payment_direct_link_count: payments.filter((row) => row.paymentTransactionId !== undefined && row.paymentLinkKnowledge === "exact").length,
    hap_payment_unmatched_count: payments.filter((row) => row.paymentTransactionId === undefined || row.paymentLinkKnowledge !== "exact").length,
    hap_subsidy_tenant_known_amount_count: tenantAmounts.known,
    hap_subsidy_tenant_unknown_amount_count: tenantAmounts.unknown,
    hap_subsidy_payment_known_amount_count: paymentAmounts.known,
    hap_subsidy_payment_unknown_amount_count: paymentAmounts.unknown,
  };
}

const FINANCIAL_REPORT_EXPECTED_FIELDS: readonly (keyof NonNullable<DatabaseAuditExpectedFinancialReport["portfolio"]>)[] = [
  "sourceRowCount", "knownCount", "knownCents", "uncertainCount", "uncertainCents", "unassignedCount", "unassignedCents",
  "notApplicableCount", "notApplicableCents", "suppressedCount", "suppressedCents", "endedCount", "endedCents",
  "inactiveCount", "inactiveCents", "futureCount", "futureCents", "unknownAmountCount", "unknownAmountCents",
  "invalidCount", "invalidCents", "propertyOnceCount", "propertyOnceCents", "formerTenancyLeakageCount",
];

type RequiredFinancialReportControl = NonNullable<DatabaseAuditExpectedFinancialReport["portfolio"]>;

/**
 * The SQL audit marks a property-once row only when a resolved property
 * schedule is the sole definition winner.  Projection rows intentionally do
 * not expose that internal marker, so recover the cents from the same
 * resolved row shape while excluding duplicate, unassigned, and invalid
 * rows.  Amount knowledge remains independent: a known amount contributes
 * cents even when another semantic fact makes the row uncertain.
 */
function propertyOnceCents(snapshot: RentOpsSnapshot, projection: FinancialScheduleProjection): number {
  const propertyIds = new Set(snapshot.properties.map((property) => property.id));
  return projection.rows.reduce((total, row) => {
    if (row.scopeType !== "property" || row.propertyId == null || !propertyIds.has(row.propertyId)) return total;
    const exceptionCodes = new Set(row.exceptionCodes ?? []);
    if (
      exceptionCodes.has("property_schedule_duplicate_conflict")
      || exceptionCodes.has("schedule_lineage_invalid")
      || exceptionCodes.has("schedule_property_scope_conflict")
      || exceptionCodes.has("schedule_scope_unknown")
      || exceptionCodes.has("schedule_unassigned")
    ) return total;
    return total + (typeof row.amountCents === "number" ? row.amountCents : 0);
  }, 0);
}

function financialReportControl(snapshot: RentOpsSnapshot, projection: FinancialScheduleProjection): RequiredFinancialReportControl {
  return {
    sourceRowCount: projection.sourceRowCount,
    knownCount: projection.knownRowCount,
    knownCents: projection.knownCents,
    // The SQL audit exposes mutually exclusive semantic buckets.  The
    // projection's broad `uncertain*` totals intentionally include
    // unassigned and invalid rows for UI completeness, so use the explicit
    // emitted-uncertain bucket here and compare the other buckets separately.
    uncertainCount: projection.emittedUncertainRowCount,
    uncertainCents: projection.emittedUncertainCents,
    unassignedCount: projection.unassignedRowCount,
    unassignedCents: projection.unassignedCents,
    notApplicableCount: projection.notApplicableCount,
    notApplicableCents: projection.notApplicableCents,
    suppressedCount: projection.suppressedByPrecedenceCount,
    suppressedCents: projection.suppressedByPrecedenceCents,
    endedCount: projection.endedCount,
    endedCents: projection.endedCents,
    inactiveCount: projection.inactiveCount,
    inactiveCents: projection.inactiveCents,
    futureCount: projection.futureCount,
    futureCents: projection.futureCents,
    // Unknown amount is a diagnostic over source rows, not an additional
    // semantic bucket.  The independent SQL deliberately reports zero cents.
    unknownAmountCount: projection.unknownAmountCount,
    unknownAmountCents: 0,
    invalidCount: projection.invalidLineageCount,
    invalidCents: projection.invalidLineageCents,
    propertyOnceCount: projection.propertyOnceCount,
    propertyOnceCents: propertyOnceCents(snapshot, projection),
    // Former-tenancy leakage is an independent SQL quarantine diagnostic and
    // is not part of the TypeScript projection's semantic buckets.
    formerTenancyLeakageCount: 0,
  };
}

export function buildFinancialReportExpected(snapshot: RentOpsSnapshot, asOfDate: string): RestrictedMigrationDatabaseAuditExpected["financialReport"] {
  const observationMonth = asOfDate.slice(0, 7) as IsoMonth;
  const portfolioProjection = projectFinancialSchedules(snapshot, observationMonth, { observationMonth });
  const perProperty = snapshot.properties.map((property): DatabaseAuditExpectedFinancialReportProperty => {
    const projection = projectFinancialSchedules(snapshot, observationMonth, { observationMonth, propertyId: property.id });
    return { propertyId: property.id, ...financialReportControl(snapshot, projection) };
  });
  return {
    portfolio: financialReportControl(snapshot, portfolioProjection),
    perProperty,
  };
}

/**
 * Validate the production hand-off rather than allowing a caller to omit or
 * edit the independent v8 controls.  Recomputing from the approved snapshot
 * makes missing and tampered controls fail closed before an audit executor is
 * opened.
 */
export function assertRequiredFinancialReportControls(
  snapshot: RentOpsSnapshot,
  asOfDate: string,
  expected: DatabaseAuditExpected,
): asserts expected is RestrictedMigrationDatabaseAuditExpected {
  const supplied = expected.financialReport;
  if (!supplied?.portfolio || !supplied.perProperty) throw new RestrictedMigrationArchiveError(["financial_report_expected_controls_missing"]);
  const expectedControls = buildFinancialReportExpected(snapshot, asOfDate);
  const expectedPropertyIds = snapshot.properties.map((property) => property.id).sort();
  const suppliedPropertyIds = supplied.perProperty.map((property) => property.propertyId).sort();
  if (expectedPropertyIds.length !== suppliedPropertyIds.length || expectedPropertyIds.some((id, index) => id !== suppliedPropertyIds[index])) {
    throw new RestrictedMigrationArchiveError(["financial_report_expected_controls_mismatch"]);
  }
  const compareControl = (actual: RequiredFinancialReportControl | undefined, reference: RequiredFinancialReportControl | undefined): boolean => {
    if (!actual || !reference) return false;
    return FINANCIAL_REPORT_EXPECTED_FIELDS.every((field) => actual[field] === reference[field]);
  };
  if (!compareControl(supplied.portfolio, expectedControls.portfolio)) throw new RestrictedMigrationArchiveError(["financial_report_expected_controls_mismatch"]);
  const referenceByProperty = new Map(expectedControls.perProperty.map((property) => [property.propertyId, property]));
  for (const property of supplied.perProperty) {
    const reference = referenceByProperty.get(property.propertyId);
    if (!reference || !compareControl(property, reference)) throw new RestrictedMigrationArchiveError(["financial_report_expected_controls_mismatch"]);
  }
}

function buildDatabaseAuditExpected(
  archive: RestrictedMigrationArchive,
  candidate: NonNullable<ReturnType<typeof buildRentManagerMigrationArtifact>["artifact"]>,
  parityInput: RestrictedParityPersistenceInput,
  asOfDate: string,
): RestrictedMigrationDatabaseAuditExpected {
  const snapshot = candidate.normalizedResult.snapshot;
  const sourceRecords = candidate.normalizedResult.sourceRecords;
  const transactionMap = new Map(snapshot.ledgerTransactions.map((row) => [row.id, row]));
  const ledgerNet = sumAmounts(snapshot.ledgerTransactions, (row) => typeof row.amountCents === "number" ? row.amountCents * ledgerBalanceSign(row, transactionMap) : 0);
  const childTenantRows = snapshot.subsidyTenants;
  const childPaymentRows = snapshot.subsidyPayments;
  const history = snapshot.applicationHistory;
  const expectedCounts = {
    properties: snapshot.properties.length,
    units: snapshot.units.length,
    people: snapshot.people.length,
    applications: snapshot.applications.length,
    applicationHouseholdMembers: snapshot.applicationHouseholdMembers.length,
    applicationRequirements: snapshot.applicationRequirements.length,
    tenancies: snapshot.tenancies.length,
    householdMemberships: snapshot.householdMemberships.length,
    leaseTerms: snapshot.leaseTerms.length,
    recurringSchedules: snapshot.recurringSchedules.length,
    ledgerTransactions: snapshot.ledgerTransactions.length,
    paymentAllocations: snapshot.paymentAllocations.length,
    securityDeposits: snapshot.securityDeposits.length,
    subsidyContracts: snapshot.subsidyContracts.length,
    subsidyTenants: childTenantRows.length,
    subsidyPayments: childPaymentRows.length,
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
  const expectedTotals = {
    chargesCents: sumAmounts(snapshot.ledgerTransactions.filter((row) => row.kind === "charge"), (row) => row.amountCents),
    paymentsCents: sumAmounts(snapshot.ledgerTransactions.filter((row) => row.kind === "payment"), (row) => row.amountCents),
    creditsCents: sumAmounts(snapshot.ledgerTransactions.filter((row) => row.kind === "credit"), (row) => row.amountCents),
    netLedgerCents: ledgerNet,
    netLedgerBalanceCents: ledgerNet,
    allocationsCents: sumAmounts(snapshot.paymentAllocations, (row) => row.amountCents),
    depositsCents: sumAmounts(snapshot.securityDeposits, (row) => row.sourceBalanceCents ?? row.amountHeldCents),
    hapAgencyObligationCents: sumAmounts(snapshot.subsidyContracts, (row) => row.agencyObligationCents),
    hapTenantObligationCents: sumAmounts(snapshot.subsidyContracts, (row) => row.tenantObligationCents),
    hapSubsidyTenantCents: sumAmounts(childTenantRows.filter((row) => row.amountKnowledge === "known"), (row) => row.amountCents),
    hapSubsidyPaymentCents: sumAmounts(childPaymentRows.filter((row) => row.amountKnowledge === "known"), (row) => row.amountCents),
    hapSubsidyTenantKnownAmountCount: childTenantRows.filter((row) => row.amountKnowledge === "known" && row.amountCents !== undefined).length,
    hapSubsidyTenantUnknownAmountCount: childTenantRows.filter((row) => row.amountKnowledge !== "known" || row.amountCents === undefined).length,
    hapSubsidyPaymentKnownAmountCount: childPaymentRows.filter((row) => row.amountKnowledge === "known" && row.amountCents !== undefined).length,
    hapSubsidyPaymentUnknownAmountCount: childPaymentRows.filter((row) => row.amountKnowledge !== "known" || row.amountCents === undefined).length,
  };
  const expected: RestrictedMigrationDatabaseAuditExpected = {
    counts: expectedCounts,
    totalsCents: expectedTotals,
    sourceRecords,
    ...restrictedExpectedControls(archive, parityInput.payloadBindings ?? []),
    reportParity: reportParityForSnapshot(snapshot, asOfDate),
    perProperty: perPropertyControls(snapshot, asOfDate),
    financialReport: buildFinancialReportExpected(snapshot, asOfDate),
    fidelityControls: expectedFidelityControls(snapshot, sourceRecords, asOfDate),
  };
  assertRequiredFinancialReportControls(snapshot, asOfDate, expected);
  return expected;
}

/** Loads the canonical archive files after path, symlink, and mode checks. */
export async function readRestrictedMigrationArchive(
  rootInput: string,
  options: { supplementReceiptVerifier?: VerifiedSupplementReceiptVerifier } = {},
): Promise<RestrictedMigrationArchive> {
  if (!isAbsolute(rootInput) || rootInput.split(/[\\/]+/).includes("..")) throw new RestrictedMigrationArchiveError(["restricted_archive_path_invalid"]);
  const root = resolve(rootInput);
  if (root === parse(root).root) throw new RestrictedMigrationArchiveError(["restricted_archive_path_invalid"]);
  await assertRestrictedPath(root, "directory");
  const canonicalRoot = await realpath(root);
  const envelopePath = resolve(root, "export-envelope.json");
  const manifestPath = resolve(root, "manifest.json");
  await assertRestrictedPath(envelopePath, "file");
  await assertRestrictedPath(manifestPath, "file");
  const [canonicalEnvelopePath, canonicalManifestPath] = await Promise.all([
    realpath(envelopePath),
    realpath(manifestPath),
  ]);
  if (
    canonicalEnvelopePath !== resolve(canonicalRoot, "export-envelope.json")
    || canonicalManifestPath !== resolve(canonicalRoot, "manifest.json")
  ) throw new RestrictedMigrationArchiveError(["restricted_archive_symlink_rejected"]);
  const [envelopeFile, manifestFile] = await Promise.all([
    readRestrictedFileFromDescriptor(canonicalRoot, resolve(canonicalRoot, "export-envelope.json"), "restricted_archive_envelope_unreadable"),
    readRestrictedFileFromDescriptor(canonicalRoot, resolve(canonicalRoot, "manifest.json"), "restricted_archive_manifest_unreadable"),
  ]);
  const envelopeText = Buffer.from(envelopeFile.bytes).toString("utf8");
  const manifestText = Buffer.from(manifestFile.bytes).toString("utf8");
  const envelope = parseRestrictedJson<ExportEnvelope>(envelopeText, "export_envelope_json_invalid");
  const manifest = parseRestrictedJson<RedactedExportManifest>(manifestText, "export_manifest_json_invalid");
  if (envelope.version !== "rm-export/v2" || manifest.version !== "rm-export-manifest/v2") throw new RestrictedMigrationArchiveError(["restricted_archive_version_invalid"]);
  const provenanceFile = await readOptionalRestrictedSupplementProvenance(canonicalRoot);
  const verifiedSupplementReceipt = provenanceFile
    ? buildVerifiedSupplementReceipt(
      parseRestrictedJson<unknown>(Buffer.from(provenanceFile.bytes).toString("utf8"), "restricted_supplement_provenance_invalid"),
      provenanceFile.bytes,
      envelope,
      manifest,
    )
    : undefined;
  const checkpointPath = resolve(canonicalRoot, "checkpoint.json");
  const coveragePath = resolve(canonicalRoot, "coverage.json");
  await assertRestrictedPath(checkpointPath, "file");
  await assertRestrictedPath(coveragePath, "file");
  const [checkpointFile, coverageFile] = await Promise.all([
    readRestrictedFileFromDescriptor(canonicalRoot, checkpointPath, "restricted_archive_checkpoint_unreadable"),
    readRestrictedFileFromDescriptor(canonicalRoot, coveragePath, "restricted_archive_coverage_unreadable"),
  ]);
  let observationProvenanceSha256: string | undefined;
  let financialProvenanceSha256: string | undefined;
  let observationFile: { bytes: Uint8Array; sha256: string } | undefined;
  try {
    const path = resolve(canonicalRoot, OBSERVATION_PROVENANCE_FILE);
    const stats = await lstat(path);
    observationFile = await readRestrictedFileFromDescriptor(canonicalRoot, path, "observation_boundary_provenance_unreadable", stats);
    observationProvenanceSha256 = observationFile.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RestrictedMigrationArchiveError(["observation_boundary_provenance_invalid"]);
  }
  let overlayParent = { envelope, manifest, checkpointBytes: checkpointFile.bytes };
  let allocationProvenanceSha256: string | undefined;
  try {
    const path = resolve(canonicalRoot, ALLOCATION_OVERLAY_FILE);
    const stats = await lstat(path);
    const file = await readRestrictedFileFromDescriptor(canonicalRoot, path, "allocation_overlay_provenance_unreadable", stats);
    overlayParent = verifyAllocationOverlay(envelope, manifest, checkpointFile.bytes, coverageFile.bytes, parseRestrictedJson<unknown>(Buffer.from(file.bytes).toString("utf8"), "allocation_overlay_provenance_invalid"));
    allocationProvenanceSha256 = file.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RestrictedMigrationArchiveError(["allocation_overlay_provenance_invalid"]);
  }
  let observationParent = { envelope: overlayParent.envelope, manifest: overlayParent.manifest };
  try {
    const path = resolve(canonicalRoot, FINANCIAL_METADATA_PROVENANCE_FILE);
    const stats = await lstat(path);
    const file = await readRestrictedFileFromDescriptor(canonicalRoot, path, "financial_metadata_provenance_unreadable", stats);
    if (!observationFile) throw new Error("financial_metadata_observation_provenance_missing");
    observationParent = verifyFinancialMetadata(overlayParent.envelope, overlayParent.manifest, overlayParent.checkpointBytes, observationFile.bytes, parseRestrictedJson<unknown>(Buffer.from(file.bytes).toString("utf8"), "financial_metadata_provenance_invalid"));
    financialProvenanceSha256 = file.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RestrictedMigrationArchiveError(["financial_metadata_provenance_invalid"]);
  }
  if (observationFile) {
    try { verifyObservationBoundary(observationParent.envelope, observationParent.manifest, overlayParent.checkpointBytes, parseRestrictedJson<unknown>(Buffer.from(observationFile.bytes).toString("utf8"), "observation_boundary_provenance_invalid")); }
    catch { throw new RestrictedMigrationArchiveError(["observation_boundary_provenance_invalid"]); }
  }
  const parity = await readRestrictedArchiveParitySource(canonicalRoot, envelope, manifest, checkpointFile, coverageFile);
  const binaries = await verifyRestrictedArchiveBinaries(canonicalRoot, envelope);
  const independentAudit = await auditRestrictedExportArchive(canonicalRoot);
  if (!independentAudit.passed) {
    throw new RestrictedMigrationArchiveError(["restricted_archive_independent_audit_failed", ...independentAudit.blockingReasons]);
  }
  if (independentAudit.envelopeSha256 !== envelopeFile.sha256) {
    throw new RestrictedMigrationArchiveError(["restricted_archive_independent_audit_envelope_mismatch"]);
  }
  if (verifiedSupplementReceipt) await assertExternallyVerifiedSupplementReceipt(verifiedSupplementReceipt, options.supplementReceiptVerifier);
  const canonicalEnvelopeSha256 = sha256(canonicalJson(envelope));
  const canonicalManifestSha256 = sha256(canonicalJson(manifest));
  const fileSetSha256 = sha256(canonicalJson([
    { kind: "envelope", sha256: envelopeFile.sha256 },
    { kind: "manifest", sha256: manifestFile.sha256 },
    { kind: "checkpoint", sha256: checkpointFile.sha256 },
    { kind: "coverage", sha256: coverageFile.sha256 },
    { kind: "pages", sha256: parity.pageFileSetSha256 },
    { kind: "binaries", sha256: binaries.descriptorDigestSha256 },
    ...(observationProvenanceSha256 ? [{ kind: "observation_provenance", sha256: observationProvenanceSha256 }] : []),
    ...(financialProvenanceSha256 ? [{ kind: "financial_provenance", sha256: financialProvenanceSha256 }] : []),
    ...(allocationProvenanceSha256 ? [{ kind: "allocation_overlay_provenance", sha256: allocationProvenanceSha256 }] : []),
  ]));
  return {
    envelope,
    manifest,
    auditReceipt: {
      version: "rm-restricted-archive-receipt/v1",
      sourceRunId: envelope.runId,
      envelopeSha256: envelopeFile.sha256,
      manifestSha256: manifestFile.sha256,
      canonicalEnvelopeSha256,
      canonicalManifestSha256,
      checkpointSha256: checkpointFile.sha256,
      coverageSha256: coverageFile.sha256,
      pageFileSetSha256: parity.pageFileSetSha256,
      pageFileCount: parity.pageFileCount,
      binaryDescriptorDigestSha256: binaries.descriptorDigestSha256,
      fileSetSha256,
    },
    parity,
    verifiedBinaries: binaries.verifiedBinaries,
    independentAudit,
    ...(verifiedSupplementReceipt ? { verifiedSupplementReceipt } : {}),
  };
}

/**
 * End-to-end restricted archive boundary. Dry-run never calls a database.
 * Apply requires the same explicit staging gates as PersistenceImporter and
 * commits normal facts plus restricted raw payload rows in one transaction.
 */
export async function runRestrictedMigrationArchive(options: {
  archiveRoot: string;
  mode?: "dry_run" | "apply";
  executor?: RentOpsQueryExecutor;
  parityAuditExecutor?: RentOpsQueryExecutor;
  importerOptions?: PersistenceImporterOptions;
  restrictedVerifiedDocumentTransfer?: RestrictedVerifiedDocumentTransfer;
  restrictedDocumentOrphanSink?: (evidence: RestrictedDocumentTransferOrphanEvidence) => Promise<void> | void;
  storagePrivilegeProbe?: PrivateObjectStorePrivilegeProbe;
  managedStorageReadiness?: ManagedStorageReadiness;
  supplementReceiptVerifier?: VerifiedSupplementReceiptVerifier;
  now?: Date;
}): Promise<RestrictedMigrationRunResult> {
  const mode = options.mode ?? "dry_run";
  if (mode === "apply" && !options.executor) throw new RestrictedMigrationArchiveError(["restricted_apply_executor_required"]);
  const archive = await readRestrictedMigrationArchive(options.archiveRoot, { supplementReceiptVerifier: options.supplementReceiptVerifier });
  const archiveReceiptSha256 = sha256(canonicalJson(archive.auditReceipt));
  const candidate = buildRentManagerMigrationArtifact(archive.envelope, archive.manifest, {
    mode,
    now: options.now,
    targetIdFactory: options.importerOptions?.targetIdFactory,
    targetIdentity: options.importerOptions?.targetIdentity,
    fidelityVersion: 3,
    verifiedSupplementReceipt: archive.verifiedSupplementReceipt,
  });
  if (!candidate.artifact) {
    if (mode === "apply") throw new RestrictedMigrationArchiveError(candidate.report.blockingReasons);
    return { report: candidate.report, archiveAuditBindingSha256: archiveReceiptSha256 };
  }
  assertMigrationArtifactIntegrity(candidate, archive.envelope, archive.manifest);
  const importRun = candidate.artifact.normalizedResult.importRun;
  const parityObservation = createRestrictedImportObservationFromChunks({
    sourceEnvelopeSha256: archive.auditReceipt.canonicalEnvelopeSha256,
    sourceRunId: archive.envelope.runId,
    importRunId: importRun.id,
    observedAt: importRun.startedAt,
    sourceManifestSha256: archive.auditReceipt.canonicalManifestSha256,
    sourceChunks: archive.parity.sourceChunks,
  });
  const parityInput: RestrictedParityPersistenceInput = {
    observation: parityObservation,
    sourceManifestSha256: archive.auditReceipt.canonicalManifestSha256,
    sourceControls: archive.parity.sourceControls,
    sourceChunks: archive.parity.sourceChunks,
    payloadBindings: restrictedSourcePayloadBindings({
      input: candidate.artifact.restrictedSourceInput,
      importRun,
      sourceRecords: candidate.artifact.normalizedResult.sourceRecords,
      sourceManifestHash: archive.auditReceipt.canonicalManifestSha256,
    }),
  };
  // The independent audit is bound to the approved source observation
  // boundary.  Import-run clocks describe when this process ran and are not
  // financial truth dates.
  const asOfDate = candidate.artifact.provenance.artifactObservationOn;
  const databaseAuditContext: RestrictedMigrationDatabaseAuditContext = {
    asOfDate,
    expected: buildDatabaseAuditExpected(archive, candidate.artifact, parityInput, asOfDate),
    archiveReceiptSha256,
    artifactBindingSha256: candidate.artifact.provenance.artifactBindingSha256,
    migration: migrationSchemaBinding(),
    ...(options.importerOptions?.expectedDatabaseFingerprint ? { expectedTargetFingerprint: options.importerOptions.expectedDatabaseFingerprint } : {}),
  };
  const parityWriter = createRestrictedParityPersistenceWriter();
  const importer = new PersistenceImporter();
  let restrictedVerifiedDocumentInputs: VerifiedDocumentArchiveInput[] = [];
  if (mode === "apply" && archive.verifiedBinaries.length > 0) {
    if (!options.restrictedVerifiedDocumentTransfer) throw new RestrictedMigrationArchiveError(["restricted_document_transfer_missing"]);
    if (!options.storagePrivilegeProbe && !options.managedStorageReadiness) throw new RestrictedMigrationArchiveError(["restricted_storage_privilege_probe_missing"]);
    try {
      if (options.storagePrivilegeProbe && options.managedStorageReadiness) throw new Error("storage_profile_ambiguous");
      if (options.managedStorageReadiness) await verifyManagedStorageReadiness(options.managedStorageReadiness);
      else await probePrivateObjectStorePrivileges({ ...options.storagePrivilegeProbe!, requireUploadWriter: true });
    } catch {
      throw new RestrictedMigrationArchiveError(["restricted_storage_privilege_probe_failed"]);
    }
    restrictedVerifiedDocumentInputs = restrictedDocumentBinaryInputs(
      archive,
      importRun.id,
      candidate.artifact.normalizedResult.snapshot.documents,
      candidate.artifact.restrictedSourceInput,
    );
  }
  const summary = await importer.run(candidate.artifact, options.executor, {
    ...(options.importerOptions ?? {}),
    mode,
    restrictedSourcePayloadWriter: createRestrictedSourcePayloadWriter(),
    restrictedArchiveAuditReceipt: archive.auditReceipt,
    verifiedSupplementReceipt: archive.verifiedSupplementReceipt,
    restrictedParityPersistenceInput: parityInput,
    restrictedParityPersistenceWriter: async (executor, context) => {
      await parityWriter(executor, context.input);
    },
    ...(restrictedVerifiedDocumentInputs.length > 0 ? {
      restrictedVerifiedDocumentInputs,
      restrictedVerifiedDocumentTransfer: options.restrictedVerifiedDocumentTransfer,
      ...(options.restrictedDocumentOrphanSink ? { restrictedDocumentOrphanSink: options.restrictedDocumentOrphanSink } : {}),
    } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let postcommitAudit: RestrictedMigrationPostcommitAudit | undefined;
  if (mode === "apply") {
    try {
      const parityAudit = await auditPersistedRestrictedParity(options.parityAuditExecutor ?? options.executor!, parityInput);
      postcommitAudit = { passed: parityAudit.passed, blockingReasons: parityAudit.blockingReasons };
    } catch {
      postcommitAudit = { passed: false, blockingReasons: ["restricted_parity_postcommit_readback_failed"] };
    }
  }
  return {
    report: candidate.report,
    summary,
    archiveAuditBindingSha256: archiveReceiptSha256,
    databaseAuditContext,
    ...(postcommitAudit ? { postcommitAudit } : {}),
  };
}
