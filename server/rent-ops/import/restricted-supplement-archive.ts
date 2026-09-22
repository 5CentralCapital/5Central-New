import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep, join } from "node:path";
import { canonicalJson, hashRecord, sha256 } from "../export/hash";
import type { CollectionCheckpoint, CollectionCoverage, DocumentBinaryDescriptor, ExportCheckpoint, ExportEnvelope, RedactedExportManifest } from "../export/types";
import {
  buildRestrictedSupplement,
  RestrictedSupplementIntegrityError,
  type RestrictedSupplementOperatorAttestation,
  type RestrictedSupplementProvenanceReport,
  type RestrictedSupplementRequest,
  type RestrictedSupplementResult,
} from "./restricted-supplement";
import { RestrictedMigrationArchiveError, readRestrictedMigrationArchive, verifyRestrictedArchiveBinaries, type VerifiedSupplementReceiptBinding, type VerifiedSupplementReceiptVerifier } from "./migration-runner";

/** Public archive-boundary name for the aggregate-only trust-root receipt. */
export type { VerifiedSupplementReceiptBinding } from "./migration-runner";

export const RESTRICTED_SUPPLEMENT_DERIVATIVE_VERSION = "rm-restricted-supplement-derivative/v1" as const;
export const RESTRICTED_SUPPLEMENT_PACKAGE_VERSION = "rm-restricted-supplement-package/v1" as const;
export const RESTRICTED_SUPPLEMENT_PROVENANCE_FILE = "restricted-supplement-provenance.json" as const;

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/;
const SAFE_REFERENCE = /^[^\u0000\r\n]{1,1000}$/;
const PRIVATE_BINARY_PATH = /^binaries\/[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/;

export interface RestrictedSupplementApproval {
  approved: true;
  approvalId: string;
  approvedAt: string;
  operatorReference: string;
  gate: string;
  gateNonce?: string;
  gateMetadata?: Record<string, unknown>;
}

export interface RestrictedSupplementPackage extends RestrictedSupplementRequest {
  version: typeof RESTRICTED_SUPPLEMENT_PACKAGE_VERSION;
  approval: RestrictedSupplementApproval;
  parentEnvelopeSha256?: string;
  parentManifestSha256?: string;
}

export interface RestrictedSupplementDerivativeProvenance {
  version: typeof RESTRICTED_SUPPLEMENT_DERIVATIVE_VERSION;
  sourceRunId: string;
  createdAt: string;
  parentEnvelopeSha256: string;
  parentManifestSha256: string;
  supplementSha256: string;
  attestationSha256: string;
  rowSetSha256: string;
  derivativeEnvelopeSha256: string;
  derivativeManifestSha256: string;
  approval: {
    approvalId: string;
    approvedAt: string;
    operatorReferenceHash: string;
    gate: string;
    gateNonceHash?: string;
    gateMetadataSha256?: string;
  };
  externalVerificationIdHash?: string;
  countsAdded: RestrictedSupplementProvenanceReport["countsAdded"];
  exceptionsRemoved: number;
  removedExceptionHashes: string[];
}

export interface RestrictedSupplementDerivativeResult {
  status: "written" | "no_op";
  report: RestrictedSupplementProvenanceReport;
  provenance: RestrictedSupplementDerivativeProvenance;
  provenanceSha256: string;
  derivativeRootHash: string;
}

export interface RestrictedSupplementDerivativeRuntime {
  /** Test seam used to prove a failed/interrupted write never commits a root. */
  beforeCommit?: (temporaryRoot: string) => Promise<void> | void;
  rename?: typeof rename;
}

/**
 * The package can recompute its own hashes, so those hashes are not an
 * authority.  Production wiring must inject a verifier backed by a separate
 * signature/approval store.  The verifier receives only redacted digests and
 * returns a non-secret receipt identifier that is itself persisted hashed.
 */
export interface RestrictedSupplementExternalVerificationInput {
  readonly sourceRunId: string;
  readonly parentEnvelopeSha256: string;
  readonly parentManifestSha256: string;
  readonly supplementSha256: string;
  readonly attestationSha256: string;
  readonly rowSetSha256: string;
  readonly derivativeEnvelopeSha256: string;
  readonly derivativeManifestSha256: string;
}

export interface RestrictedSupplementExternalVerification {
  readonly verified: true;
  readonly receiptId: string;
}

export type RestrictedSupplementExternalVerifier = (
  input: RestrictedSupplementExternalVerificationInput,
) => Promise<RestrictedSupplementExternalVerification> | RestrictedSupplementExternalVerification;

export class RestrictedSupplementDerivativeArchiveError extends Error {
  readonly reasons: string[];

  constructor(reasons: readonly string[]) {
    const safeReasons = Array.from(new Set(reasons.map((reason) => String(reason).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160)))).sort();
    super(`Restricted supplement derivative rejected: ${safeReasons.join(";") || "invalid"}`);
    this.name = "RestrictedSupplementDerivativeArchiveError";
    this.reasons = safeReasons;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeText(value: unknown, reason: string, pattern: RegExp = SAFE_REFERENCE): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || !pattern.test(value.trim())) {
    throw new RestrictedSupplementDerivativeArchiveError([reason]);
  }
  return value.trim();
}

function safeHash(value: unknown, reason: string): string {
  const text = safeText(value, reason, SHA256);
  return text.toLowerCase();
}

function safeTimestamp(value: unknown, reason: string): string {
  const text = safeText(value, reason);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) throw new RestrictedSupplementDerivativeArchiveError([reason]);
  return text;
}

async function verifySupplementExternally(
  result: RestrictedSupplementResult,
  verifier: RestrictedSupplementExternalVerifier | undefined,
): Promise<RestrictedSupplementExternalVerification> {
  if (!verifier) throw new RestrictedSupplementDerivativeArchiveError(["supplement_external_verifier_missing"]);
  const rowSetSha256 = result.report.rowSetSha256;
  if (!rowSetSha256 || !SHA256.test(rowSetSha256)) throw new RestrictedSupplementDerivativeArchiveError(["supplement_row_set_digest_missing"]);
  const input: RestrictedSupplementExternalVerificationInput = {
    sourceRunId: result.report.sourceRunId,
    parentEnvelopeSha256: result.report.originalEnvelopeSha256,
    parentManifestSha256: result.report.originalManifestSha256,
    supplementSha256: result.report.supplementSha256,
    attestationSha256: result.report.attestationSha256,
    rowSetSha256,
    derivativeEnvelopeSha256: result.report.derivativeEnvelopeSha256,
    derivativeManifestSha256: result.report.derivativeManifestSha256,
  };
  let verification: RestrictedSupplementExternalVerification;
  try {
    verification = await verifier(input);
  } catch {
    throw new RestrictedSupplementDerivativeArchiveError(["supplement_external_verification_failed"]);
  }
  if (!verification || verification.verified !== true || typeof verification.receiptId !== "string" || !SAFE_TOKEN.test(verification.receiptId)) {
    throw new RestrictedSupplementDerivativeArchiveError(["supplement_external_verification_invalid"]);
  }
  return verification;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], reason: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new RestrictedSupplementDerivativeArchiveError([reason]);
}

function assertSafeAbsolutePath(value: unknown, reason: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value.split(/[\\/]+/).includes("..")) {
    throw new RestrictedSupplementDerivativeArchiveError([reason]);
  }
  const resolved = resolve(value);
  if (resolved === parse(resolved).root) throw new RestrictedSupplementDerivativeArchiveError([reason]);
  return resolved;
}

function assertContained(root: string, candidate: string, reason: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RestrictedSupplementDerivativeArchiveError([reason]);
  }
}

async function assertNoSymlink(path: string, kind: "directory" | "file", reason: string, restrictive = false): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || (kind === "directory" ? !stats.isDirectory() : !stats.isFile())) throw new RestrictedSupplementDerivativeArchiveError([reason]);
    if (restrictive && (stats.mode & 0o077) !== 0) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_permissions_invalid"]);
  } catch (error) {
    if (error instanceof RestrictedSupplementDerivativeArchiveError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RestrictedSupplementDerivativeArchiveError([reason]);
    throw error;
  }
}

async function assertPathChainNoSymlinks(path: string, reason: string): Promise<void> {
  const resolved = resolve(path);
  const parts = resolved.split(sep).filter(Boolean);
  let cursor = parse(resolved).root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      const stats = await lstat(cursor);
      // macOS exposes the system temporary directory as /tmp -> /private/tmp.
      // It is the only ambient link permitted here; all task-owned path
      // components, including the archive and derivative leaves, remain strict.
      if (stats.isSymbolicLink() && cursor !== "/tmp" && cursor !== "/var") throw new RestrictedSupplementDerivativeArchiveError([reason]);
    } catch (error) {
      if (error instanceof RestrictedSupplementDerivativeArchiveError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new RestrictedSupplementDerivativeArchiveError([reason]);
    }
  }
}

async function ensureDirectory(path: string, mode: number, reason: string): Promise<void> {
  await assertPathChainNoSymlinks(path, reason);
  try {
    await mkdir(path, { recursive: true, mode });
  } catch {
    throw new RestrictedSupplementDerivativeArchiveError([reason]);
  }
  await chmod(path, mode);
  await assertNoSymlink(path, "directory", reason, true);
}

async function writePrivateFile(path: string, contents: string | Uint8Array): Promise<void> {
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    await assertNoSymlink(path, "file", "restricted_derivative_file_invalid", true);
  } catch (error) {
    if (error instanceof RestrictedSupplementDerivativeArchiveError) throw error;
    throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_write_failed"]);
  }
}

/** Reads one private file through the descriptor that was fstat'ed and read.
 * Path checks are only an early diagnostic; O_NOFOLLOW, nlink, and the
 * pre/post descriptor stats are the authority against swaps and hard links. */
async function readPrivateFileFromDescriptor(path: string, reason: string): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o077) !== 0 || before.nlink !== 1) throw new RestrictedSupplementDerivativeArchiveError([reason]);
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (!after.isFile() || (after.mode & 0o077) !== 0 || after.nlink !== 1 || after.size !== before.size) throw new RestrictedSupplementDerivativeArchiveError([reason]);
    return bytes;
  } catch (error) {
    if (error instanceof RestrictedSupplementDerivativeArchiveError) throw error;
    throw new RestrictedSupplementDerivativeArchiveError([reason]);
  } finally {
    try { await handle?.close(); } catch { /* redacted close failure */ }
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") {
      throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_fsync_failed"]);
    }
  }
}

function safeBinaryRelativePath(value: unknown): string {
  if (typeof value !== "string" || !PRIVATE_BINARY_PATH.test(value) || value.includes("..") || value.includes("//") || value.includes("\\")) {
    throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_binary_path_invalid"]);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_binary_path_invalid"]);
  return parts.join("/");
}

async function readBinary(root: string, relativePath: string): Promise<Uint8Array> {
  const safePath = safeBinaryRelativePath(relativePath);
  const candidate = resolve(root, ...safePath.split("/"));
  assertContained(root, candidate, "restricted_derivative_binary_path_invalid");
  const parts = safePath.split("/");
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index]);
    await assertNoSymlink(cursor, index === parts.length - 1 ? "file" : "directory", "restricted_derivative_symlink_rejected", index === parts.length - 1);
  }
  return readPrivateFileFromDescriptor(candidate, "restricted_derivative_binary_unreadable");
}

export function binaryDescriptors(envelope: ExportEnvelope): DocumentBinaryDescriptor[] {
  const descriptors = [...envelope.documentBinaries, ...(Array.isArray(envelope.payload.documentBinaries) ? envelope.payload.documentBinaries : [])];
  const byPath = new Map<string, DocumentBinaryDescriptor>();
  const bySource = new Map<string, DocumentBinaryDescriptor>();
  for (const descriptor of descriptors) {
    if (!descriptor || descriptor.binaryAvailable !== true) continue;
    const path = safeBinaryRelativePath(descriptor.archivePath);
    const sameSource = bySource.get(descriptor.sourceId);
    if (sameSource && canonicalJson(sameSource) !== canonicalJson(descriptor)) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_binary_conflict"]);
    bySource.set(descriptor.sourceId, descriptor);
    const prior = byPath.get(path);
    // Distinct source documents may share identical content-addressed bytes.
    // Preserve every descriptor in the envelope; copy the verified bytes once.
    if (prior && (prior.sha256 !== descriptor.sha256 || prior.sizeBytes !== descriptor.sizeBytes)) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_binary_conflict"]);
    if (!prior) byPath.set(path, descriptor);
  }
  return Array.from(byPath.values()).sort((left, right) => String(left.archivePath).localeCompare(String(right.archivePath)));
}

function validateApproval(value: unknown, attestation: RestrictedSupplementOperatorAttestation): RestrictedSupplementApproval {
  if (!isRecord(value)) throw new RestrictedSupplementDerivativeArchiveError(["supplement_approval_missing"]);
  assertAllowedKeys(value, ["approved", "approvalId", "approvedAt", "operatorReference", "gate", "gateNonce", "gateMetadata"], "supplement_approval_unsupported_field");
  if (value.approved !== true) throw new RestrictedSupplementDerivativeArchiveError(["supplement_approval_required"]);
  const approvalId = safeText(value.approvalId, "supplement_approval_id_invalid", SAFE_TOKEN);
  const approvedAt = safeTimestamp(value.approvedAt, "supplement_approval_timestamp_invalid");
  const operatorReference = safeText(value.operatorReference, "supplement_approval_operator_invalid");
  if (operatorReference !== attestation.operatorReference) throw new RestrictedSupplementDerivativeArchiveError(["supplement_approval_operator_mismatch"]);
  const gate = safeText(value.gate, "supplement_approval_gate_invalid", SAFE_TOKEN);
  const gateNonce = value.gateNonce === undefined ? undefined : safeText(value.gateNonce, "supplement_approval_nonce_invalid", SAFE_TOKEN);
  let gateMetadata: Record<string, unknown> | undefined;
  if (value.gateMetadata !== undefined) {
    if (!isRecord(value.gateMetadata)) throw new RestrictedSupplementDerivativeArchiveError(["supplement_approval_metadata_invalid"]);
    try { canonicalJson(value.gateMetadata); } catch { throw new RestrictedSupplementDerivativeArchiveError(["supplement_approval_metadata_invalid"]); }
    gateMetadata = clone(value.gateMetadata);
  }
  return { approved: true, approvalId, approvedAt, operatorReference, gate, ...(gateNonce ? { gateNonce } : {}), ...(gateMetadata ? { gateMetadata } : {}) };
}

function decodeSupplementBinaryBytes(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (!Array.isArray(value.documentBinaries)) return value;
  const result = clone(value);
  const binaries = (result.documentBinaries as unknown[]).map((candidate) => {
    if (!isRecord(candidate) || candidate.bytesBase64 === undefined) return candidate;
    const encoded = candidate.bytesBase64;
    if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new RestrictedSupplementDerivativeArchiveError(["supplement_binary_encoding_invalid"]);
    }
    const copy = { ...candidate } as Record<string, unknown>;
    delete copy.bytesBase64;
    copy.bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    return copy;
  });
  return { ...result, documentBinaries: binaries };
}

function parseSupplementPackage(value: unknown, archive: { envelope: ExportEnvelope; manifest: RedactedExportManifest }): { request: RestrictedSupplementRequest; approval: RestrictedSupplementApproval } {
  if (!isRecord(value)) throw new RestrictedSupplementDerivativeArchiveError(["supplement_package_invalid"]);
  assertAllowedKeys(value, ["version", "envelope", "manifest", "operatorAttestation", "applicationAnswers", "hapSubsidies", "documentBinaries", "applicationHistoryStatusCrosswalk", "approval", "parentEnvelopeSha256", "parentManifestSha256", "request"], "supplement_package_unsupported_field");
  if (value.version !== RESTRICTED_SUPPLEMENT_PACKAGE_VERSION && value.version !== RESTRICTED_SUPPLEMENT_DERIVATIVE_VERSION && value.version !== "rm-restricted-supplement/v1") throw new RestrictedSupplementDerivativeArchiveError(["supplement_package_version_invalid"]);
  const parsedRequestValue = value.request === undefined
    ? {
      envelope: value.envelope,
      manifest: value.manifest,
      operatorAttestation: value.operatorAttestation,
      applicationAnswers: value.applicationAnswers,
      hapSubsidies: value.hapSubsidies,
      documentBinaries: value.documentBinaries,
      applicationHistoryStatusCrosswalk: value.applicationHistoryStatusCrosswalk,
    }
    : value.request;
  if (!isRecord(parsedRequestValue)) throw new RestrictedSupplementDerivativeArchiveError(["supplement_package_request_invalid"]);
  let requestValue = parsedRequestValue;
  assertAllowedKeys(requestValue, ["envelope", "manifest", "operatorAttestation", "applicationAnswers", "hapSubsidies", "documentBinaries", "applicationHistoryStatusCrosswalk"], "supplement_request_unsupported_field");
  if (value.request !== undefined && value.applicationHistoryStatusCrosswalk !== undefined) {
    // A package may expose the request at the top level for compatibility or
    // under `request`, but never two competing crosswalk authorities.
    let sameCrosswalk = false;
    try {
      if (requestValue.applicationHistoryStatusCrosswalk === undefined) {
        requestValue = { ...requestValue, applicationHistoryStatusCrosswalk: value.applicationHistoryStatusCrosswalk };
        sameCrosswalk = false;
      } else {
        sameCrosswalk = canonicalJson(value.applicationHistoryStatusCrosswalk) === canonicalJson(requestValue.applicationHistoryStatusCrosswalk);
      }
    } catch {
      throw new RestrictedSupplementDerivativeArchiveError(["application_status_crosswalk_conflict"]);
    }
    if (sameCrosswalk) throw new RestrictedSupplementDerivativeArchiveError(["application_status_crosswalk_duplicate"]);
    if (requestValue.applicationHistoryStatusCrosswalk !== value.applicationHistoryStatusCrosswalk) {
      throw new RestrictedSupplementDerivativeArchiveError(["application_status_crosswalk_conflict"]);
    }
  }
  const attestation = requestValue.operatorAttestation as RestrictedSupplementOperatorAttestation;
  if (!isRecord(attestation)) throw new RestrictedSupplementDerivativeArchiveError(["evidence_attestation_missing"]);
  const approval = validateApproval(value.approval, attestation);
  const packageEnvelope = requestValue.envelope;
  const packageManifest = requestValue.manifest;
  if (packageEnvelope !== undefined && sha256(canonicalJson(packageEnvelope)) !== sha256(canonicalJson(archive.envelope))) throw new RestrictedSupplementDerivativeArchiveError(["supplement_parent_envelope_mismatch"]);
  if (packageManifest !== undefined && sha256(canonicalJson(packageManifest)) !== sha256(canonicalJson(archive.manifest))) throw new RestrictedSupplementDerivativeArchiveError(["supplement_parent_manifest_mismatch"]);
  if (value.parentEnvelopeSha256 !== undefined && safeHash(value.parentEnvelopeSha256, "supplement_parent_envelope_hash_invalid") !== sha256(canonicalJson(archive.envelope))) throw new RestrictedSupplementDerivativeArchiveError(["supplement_parent_envelope_mismatch"]);
  if (value.parentManifestSha256 !== undefined && safeHash(value.parentManifestSha256, "supplement_parent_manifest_hash_invalid") !== sha256(canonicalJson(archive.manifest))) throw new RestrictedSupplementDerivativeArchiveError(["supplement_parent_manifest_mismatch"]);
  const decoded = decodeSupplementBinaryBytes(requestValue);
  const request = {
    envelope: archive.envelope,
    manifest: archive.manifest,
    operatorAttestation: (decoded as Record<string, unknown>).operatorAttestation as RestrictedSupplementOperatorAttestation,
    ...(Array.isArray((decoded as Record<string, unknown>).applicationAnswers) ? { applicationAnswers: (decoded as Record<string, unknown>).applicationAnswers } : {}),
    ...(Array.isArray((decoded as Record<string, unknown>).hapSubsidies) ? { hapSubsidies: (decoded as Record<string, unknown>).hapSubsidies } : {}),
    ...(Array.isArray((decoded as Record<string, unknown>).documentBinaries) ? { documentBinaries: (decoded as Record<string, unknown>).documentBinaries } : {}),
    ...(Array.isArray((decoded as Record<string, unknown>).applicationHistoryStatusCrosswalk)
      ? { applicationHistoryStatusCrosswalk: (decoded as Record<string, unknown>).applicationHistoryStatusCrosswalk }
      : {}),
  } as unknown as RestrictedSupplementRequest;
  return { request, approval };
}

function provenanceFor(result: RestrictedSupplementResult, approval: RestrictedSupplementApproval, createdAt: string, externalVerification: RestrictedSupplementExternalVerification): RestrictedSupplementDerivativeProvenance {
  const rowSetSha256 = result.report.rowSetSha256;
  if (!rowSetSha256 || !SHA256.test(rowSetSha256)) throw new RestrictedSupplementDerivativeArchiveError(["supplement_row_set_digest_missing"]);
  return {
    version: RESTRICTED_SUPPLEMENT_DERIVATIVE_VERSION,
    sourceRunId: result.report.sourceRunId,
    createdAt,
    parentEnvelopeSha256: result.report.originalEnvelopeSha256,
    parentManifestSha256: result.report.originalManifestSha256,
    supplementSha256: result.report.supplementSha256,
    attestationSha256: result.report.attestationSha256,
    rowSetSha256,
    derivativeEnvelopeSha256: result.report.derivativeEnvelopeSha256,
    derivativeManifestSha256: result.report.derivativeManifestSha256,
    approval: {
      approvalId: approval.approvalId,
      approvedAt: approval.approvedAt,
      operatorReferenceHash: sha256(approval.operatorReference),
      gate: approval.gate,
      ...(approval.gateNonce ? { gateNonceHash: sha256(approval.gateNonce) } : {}),
      ...(approval.gateMetadata ? { gateMetadataSha256: sha256(canonicalJson(approval.gateMetadata)) } : {}),
    },
    externalVerificationIdHash: sha256(externalVerification.receiptId),
    countsAdded: clone(result.report.countsAdded),
    exceptionsRemoved: result.report.exceptionsRemoved,
    removedExceptionHashes: [...result.report.removedExceptionHashes],
  };
}

function provenanceDigest(value: RestrictedSupplementDerivativeProvenance): string {
  return sha256(canonicalJson(value));
}

function reportForNoOp(provenance: RestrictedSupplementDerivativeProvenance): RestrictedSupplementProvenanceReport {
  return {
    version: "rm-restricted-supplement/v1",
    sourceRunId: provenance.sourceRunId,
    originalEnvelopeSha256: provenance.parentEnvelopeSha256,
    originalManifestSha256: provenance.parentManifestSha256,
    derivativeEnvelopeSha256: provenance.derivativeEnvelopeSha256,
    derivativeManifestSha256: provenance.derivativeManifestSha256,
    supplementSha256: provenance.supplementSha256,
    attestationSha256: provenance.attestationSha256,
    rowSetSha256: provenance.rowSetSha256,
    countsAdded: clone(provenance.countsAdded),
    sourceIdHashes: { application_answers: [], hap_subsidies: [], document_binaries: [] },
    operatorReferenceHash: provenance.approval.operatorReferenceHash,
    verifiedAt: provenance.approval.approvedAt,
    manifestComplete: true,
    exceptionsRemoved: provenance.exceptionsRemoved,
    removedExceptionHashes: [...provenance.removedExceptionHashes],
  };
}

async function readProvenance(root: string): Promise<RestrictedSupplementDerivativeProvenance | undefined> {
  const path = resolve(root, RESTRICTED_SUPPLEMENT_PROVENANCE_FILE);
  try {
    await assertNoSymlink(path, "file", "restricted_derivative_provenance_invalid", true);
    const parsed: unknown = JSON.parse(Buffer.from(await readPrivateFileFromDescriptor(path, "restricted_derivative_provenance_invalid")).toString("utf8"));
    if (!isRecord(parsed) || parsed.version !== RESTRICTED_SUPPLEMENT_DERIVATIVE_VERSION) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_provenance_invalid"]);
    return parsed as unknown as RestrictedSupplementDerivativeProvenance;
  } catch (error) {
    if (error instanceof RestrictedSupplementDerivativeArchiveError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_provenance_invalid"]);
  }
}

async function validateExistingDerivative(root: string, expected: RestrictedSupplementDerivativeProvenance, supplementReceiptVerifier?: VerifiedSupplementReceiptVerifier): Promise<void> {
  const archive = await readRestrictedMigrationArchive(root, { supplementReceiptVerifier });
  const envelopeHash = sha256(canonicalJson(archive.envelope));
  const manifestHash = sha256(canonicalJson(archive.manifest));
  if (envelopeHash !== expected.derivativeEnvelopeSha256 || manifestHash !== expected.derivativeManifestSha256) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_digest_mismatch"]);
  const provenance = await readProvenance(root);
  if (!provenance || provenanceDigest(provenance) !== provenanceDigest(expected)) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_provenance_mismatch"]);
}

async function copyDerivativeBinaries(sourceRoot: string, temporaryRoot: string, envelope: ExportEnvelope, supplement: RestrictedSupplementRequest): Promise<void> {
  const supplementByPath = new Map<string, Uint8Array>();
  for (const binary of supplement.documentBinaries ?? []) {
    if (!isRecord(binary)) continue;
    const bytes = binary.bytes;
    if (bytes instanceof Uint8Array) supplementByPath.set(safeBinaryRelativePath((binary.descriptor as DocumentBinaryDescriptor).archivePath), new Uint8Array(bytes));
    else if (bytes instanceof ArrayBuffer) supplementByPath.set(safeBinaryRelativePath((binary.descriptor as DocumentBinaryDescriptor).archivePath), new Uint8Array(bytes.slice(0)));
  }
  for (const descriptor of binaryDescriptors(envelope)) {
    const relativePath = safeBinaryRelativePath(descriptor.archivePath);
    const bytes = supplementByPath.get(relativePath) ?? await readBinary(sourceRoot, relativePath);
    if (bytes.byteLength !== descriptor.sizeBytes || sha256(bytes) !== descriptor.sha256) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_binary_digest_mismatch"]);
    const path = resolve(temporaryRoot, ...relativePath.split("/"));
    assertContained(temporaryRoot, path, "restricted_derivative_binary_path_invalid");
    await ensureDirectory(dirname(path), 0o700, "restricted_derivative_directory_invalid");
    await writePrivateFile(path, bytes);
  }
}

/**
 * A supplement changes the approved envelope/manifest pair, so its derivative
 * must carry a matching independent checkpoint/page receipt as well.  Source
 * page chunks are already descriptor-audited by readRestrictedMigrationArchive;
 * we re-materialize those canonical rows into fresh private page files and
 * add explicitly attested manual rows as their own pages.  No page value is
 * returned to callers or placed in provenance.
 */
async function writeDerivativeControlFiles(
  temporaryRoot: string,
  sourceArchive: Awaited<ReturnType<typeof readRestrictedMigrationArchive>>,
  envelope: ExportEnvelope,
  manifest: RedactedExportManifest,
): Promise<void> {
  const checkpointCollections: Record<string, CollectionCheckpoint> = {};
  let pageIndex = 0;
  await ensureDirectory(resolve(temporaryRoot, "pages"), 0o700, "restricted_derivative_directory_invalid");
  for (const collection of manifest.collections) {
    const matchingChunks = sourceArchive.parity.sourceChunks.filter((chunk) => chunk.present && chunk.collectionName === collection.name && chunk.path === collection.path);
    const rawPages: unknown[][] = [];
    for (const chunk of matchingChunks) {
      const rows: unknown[] = [];
      for (const row of Array.from(chunk.rows)) {
        try { rows.push(JSON.parse(row.canonicalPayload)); }
        catch { throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_page_reconstruction_invalid"]); }
      }
      if (rows.length > 0) rawPages.push(rows);
    }
    // A manual collection shares its output array with retained parent rows.
    // Its manifest hashes bind only the added partition, in exact source order.
    if (rawPages.length === 0 && collection.path.startsWith("manual://")) {
      const candidate = (envelope.payload as unknown as Record<string, unknown>)[collection.outputKey];
      const expected = collection.recordHashes;
      const expectedSet = new Set(expected);
      const selected = new Map<string, unknown>();
      if (expectedSet.size !== expected.length) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_page_reconstruction_invalid"]);
      for (const row of Array.isArray(candidate) ? candidate : []) {
        const hash = hashRecord(row);
        if (!expectedSet.has(hash)) continue;
        if (selected.has(hash)) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_page_reconstruction_invalid"]);
        selected.set(hash, row);
      }
      if (selected.size !== expected.length) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_page_reconstruction_mismatch"]);
      if (expected.length > 0) rawPages.push(expected.map((hash) => selected.get(hash)!));
    }
    const received = rawPages.reduce((total, rows) => total + rows.length, 0);
    if (received !== collection.received) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_page_reconstruction_mismatch"]);
    const pageFiles: string[] = [];
    const hashes: string[] = [];
    for (const rows of rawPages) {
      pageIndex += 1;
      const relativePath = `pages/derivative-${pageIndex}.json`;
      await writePrivateFile(resolve(temporaryRoot, relativePath), canonicalJson(rows));
      pageFiles.push(relativePath);
      hashes.push(...rows.map((row) => hashRecord(row)));
    }
    const status: CollectionCheckpoint["status"] = collection.status === "not_available" ? "not_available" : collection.status === "empty" ? "complete" : collection.status;
    checkpointCollections[collection.name] = {
      nextPage: pageFiles.length + 1,
      nextParentIndex: 0,
      parentIds: [],
      pageSize: 0,
      pages: pageFiles.length,
      received,
      hashes,
      pageFiles,
      status,
      errors: [],
      exceptions: [],
    };
  }
  const checkpoint: ExportCheckpoint = {
    version: 2,
    runId: envelope.runId,
    registryHash: manifest.registryHash,
    startedAt: envelope.createdAt,
    updatedAt: envelope.createdAt,
    requestCount: 0,
    complete: true,
    collections: checkpointCollections,
  };
  await writePrivateFile(resolve(temporaryRoot, "checkpoint.json"), canonicalJson(checkpoint));
  const coverage: CollectionCoverage[] = manifest.collections.map((collection) => ({ ...collection }));
  await writePrivateFile(resolve(temporaryRoot, "coverage.json"), canonicalJson(coverage));
}

function sourceIdHash(sourceId: string): string {
  return `id_${sha256(sourceId).slice(0, 16)}`;
}

function validateRewrite(base: { envelope: ExportEnvelope; manifest: RedactedExportManifest }, result: RestrictedSupplementResult, request: RestrictedSupplementRequest): void {
  if (result.manifest.archiveEnvelopeSha256 !== result.report.derivativeEnvelopeSha256) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_digest_mismatch"]);
  if (sha256(canonicalJson(result.envelope)) !== result.report.derivativeEnvelopeSha256) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_digest_mismatch"]);
  if (result.report.originalEnvelopeSha256 !== sha256(canonicalJson(base.envelope)) || result.report.originalManifestSha256 !== sha256(canonicalJson(base.manifest))) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_parent_digest_mismatch"]);
  if (result.report.exceptionsRemoved !== result.report.removedExceptionHashes.length) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_exception_validation_failed"]);
  const claims: Array<{ collection: string; sourceIdHash: string; code: string; detail: string }> = [];
  for (const [kind, values] of [
    ["application_answers", request.applicationAnswers],
    ["hap_subsidies", request.hapSubsidies],
    ["document_binaries", request.documentBinaries],
  ] as const) {
    for (const value of values ?? []) {
      if (!isRecord(value)) continue;
      const collection = typeof value.sourceCollection === "string" ? value.sourceCollection : "";
      const sourceId = typeof value.sourceId === "string" ? value.sourceId : String(value.sourceId ?? "");
      if (!collection || !sourceId) continue;
      claims.push({
        collection,
        sourceIdHash: sourceIdHash(sourceId),
        code: kind === "document_binaries" ? "binary_unavailable" : "missing_source_id",
        detail: kind === "document_binaries" ? "binary_descriptor_without_archived_binary" : "record_source_id_missing",
      });
    }
  }
  const unresolved = [...result.manifest.exceptions, ...result.manifest.collections.flatMap((collection) => collection.exceptions)].some((exception) => claims.some((claim) => exception.code === claim.code && exception.detail === claim.detail && exception.collection === claim.collection && exception.sourceIdHash === claim.sourceIdHash));
  if (unresolved) throw new RestrictedSupplementDerivativeArchiveError(["supplement_required_exception_unresolved"]);
}

export async function writeRestrictedSupplementDerivativeArchive(options: {
  archiveRoot: string;
  derivativeRoot: string;
  supplementPackage: unknown;
  now?: () => Date;
  runtime?: RestrictedSupplementDerivativeRuntime;
  externalVerifier?: RestrictedSupplementExternalVerifier;
  supplementReceiptVerifier?: VerifiedSupplementReceiptVerifier;
}): Promise<RestrictedSupplementDerivativeResult> {
  const archiveRoot = assertSafeAbsolutePath(options.archiveRoot, "restricted_archive_path_invalid");
  const derivativeRoot = assertSafeAbsolutePath(options.derivativeRoot, "restricted_derivative_path_invalid");
  if (archiveRoot === derivativeRoot) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_must_be_distinct"]);
  await assertPathChainNoSymlinks(archiveRoot, "restricted_archive_symlink_rejected");
  const archive = await readRestrictedMigrationArchive(archiveRoot, {
    ...(options.supplementReceiptVerifier ? { supplementReceiptVerifier: options.supplementReceiptVerifier } : {}),
  });
  const parsed = parseSupplementPackage(options.supplementPackage, archive);
  const request = parsed.request;
  const result = buildRestrictedSupplement(request);
  validateRewrite(archive, result, request);
  const externalVerification = await verifySupplementExternally(result, options.externalVerifier);
  const externallyVerifiedTuple = {
    sourceRunId: result.report.sourceRunId,
    parentEnvelopeSha256: result.report.originalEnvelopeSha256,
    parentManifestSha256: result.report.originalManifestSha256,
    supplementSha256: result.report.supplementSha256,
    attestationSha256: result.report.attestationSha256,
    rowSetSha256: result.report.rowSetSha256,
    derivativeEnvelopeSha256: result.report.derivativeEnvelopeSha256,
    derivativeManifestSha256: result.report.derivativeManifestSha256,
  };
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const provenance = provenanceFor(result, parsed.approval, createdAt, externalVerification);
  const provenanceText = canonicalJson(provenance);
  const supplementReceiptVerifier = options.supplementReceiptVerifier ?? (options.externalVerifier
    ? async (input: Parameters<VerifiedSupplementReceiptVerifier>[0]) => {
      const tuple = {
        sourceRunId: input.sourceRunId,
        parentEnvelopeSha256: input.parentEnvelopeSha256,
        parentManifestSha256: input.parentManifestSha256,
        supplementSha256: input.supplementSha256,
        attestationSha256: input.attestationSha256,
        rowSetSha256: input.rowSetSha256,
        derivativeEnvelopeSha256: input.derivativeEnvelopeSha256,
        derivativeManifestSha256: input.derivativeManifestSha256,
      };
      if (canonicalJson(tuple) !== canonicalJson(externallyVerifiedTuple)) {
        throw new RestrictedSupplementDerivativeArchiveError(["supplement_external_verification_input_mismatch"]);
      }
      return { verified: true as const, receiptId: externalVerification.receiptId };
    }
    : undefined);
  await assertPathChainNoSymlinks(derivativeRoot, "restricted_derivative_symlink_rejected");
  const expectedExisting = await readProvenance(derivativeRoot).catch((error: unknown) => {
    if (error instanceof RestrictedSupplementDerivativeArchiveError && error.reasons.includes("restricted_derivative_provenance_invalid")) throw error;
    return undefined;
  });
  try {
    const existingStats = await lstat(derivativeRoot);
    if (existingStats.isSymbolicLink() || !existingStats.isDirectory()) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_exists"]);
    if (expectedExisting && expectedExisting.parentEnvelopeSha256 === provenance.parentEnvelopeSha256 && expectedExisting.parentManifestSha256 === provenance.parentManifestSha256 && expectedExisting.supplementSha256 === provenance.supplementSha256) {
      await validateExistingDerivative(derivativeRoot, expectedExisting, supplementReceiptVerifier);
      return { status: "no_op", report: reportForNoOp(expectedExisting), provenance: expectedExisting, provenanceSha256: provenanceDigest(expectedExisting), derivativeRootHash: sha256(derivativeRoot) };
    }
    throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_exists"]);
  } catch (error) {
    if (error instanceof RestrictedSupplementDerivativeArchiveError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_exists"]);
  }
  const parent = dirname(derivativeRoot);
  await assertPathChainNoSymlinks(parent, "restricted_derivative_symlink_rejected");
  try { await mkdir(parent, { recursive: true, mode: 0o700 }); }
  catch { throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_parent_invalid"]); }
  await assertNoSymlink(parent, "directory", "restricted_derivative_parent_invalid");
  let temporaryRoot: string | undefined;
  let committed = false;
  try {
    temporaryRoot = await mkdtemp(join(parent, ".restricted-supplement-"));
    await chmod(temporaryRoot, 0o700);
    await assertNoSymlink(temporaryRoot, "directory", "restricted_derivative_directory_invalid", true);
    await ensureDirectory(resolve(temporaryRoot, "binaries"), 0o700, "restricted_derivative_directory_invalid");
    await writePrivateFile(resolve(temporaryRoot, "export-envelope.json"), canonicalJson(result.envelope));
    await writePrivateFile(resolve(temporaryRoot, "manifest.json"), canonicalJson(result.manifest));
    // Rebuild source pages, including verified allocation overlay collections. Parent
    // provenance sidecars are not copied: the external receipt binds the exact parent.
    await writeDerivativeControlFiles(temporaryRoot, archive, result.envelope, result.manifest);
    await copyDerivativeBinaries(archiveRoot, temporaryRoot, result.envelope, request);
    await writePrivateFile(resolve(temporaryRoot, RESTRICTED_SUPPLEMENT_PROVENANCE_FILE), provenanceText);
    await verifyRestrictedArchiveBinaries(temporaryRoot, result.envelope);
    const rewritten = await readRestrictedMigrationArchive(temporaryRoot, { supplementReceiptVerifier });
    if (sha256(canonicalJson(rewritten.envelope)) !== result.report.derivativeEnvelopeSha256 || sha256(canonicalJson(rewritten.manifest)) !== result.report.derivativeManifestSha256) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_digest_mismatch"]);
    if (options.runtime?.beforeCommit) await options.runtime.beforeCommit(temporaryRoot);
    await (options.runtime?.rename ?? rename)(temporaryRoot, derivativeRoot);
    committed = true;
    temporaryRoot = undefined;
    await syncDirectory(parent);
    const stored = await readProvenance(derivativeRoot);
    if (!stored || provenanceDigest(stored) !== provenanceDigest(provenance)) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_provenance_mismatch"]);
    await validateExistingDerivative(derivativeRoot, provenance, supplementReceiptVerifier);
    return { status: "written", report: result.report, provenance, provenanceSha256: provenanceDigest(provenance), derivativeRootHash: sha256(derivativeRoot) };
  } catch (error) {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    if (committed) await rm(derivativeRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RestrictedSupplementDerivativeArchiveError) throw error;
    if (error instanceof RestrictedSupplementIntegrityError || error instanceof RestrictedMigrationArchiveError) throw new RestrictedSupplementDerivativeArchiveError(error.reasons);
    throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_write_failed"]);
  }
}

export async function applyRestrictedSupplementPackage(options: {
  archiveRoot: string;
  derivativeRoot: string;
  supplementPackagePath: string;
  now?: () => Date;
  runtime?: RestrictedSupplementDerivativeRuntime;
  externalVerifier?: RestrictedSupplementExternalVerifier;
  supplementReceiptVerifier?: VerifiedSupplementReceiptVerifier;
}): Promise<RestrictedSupplementDerivativeResult> {
  const path = assertSafeAbsolutePath(options.supplementPackagePath, "supplement_package_path_invalid");
  await assertPathChainNoSymlinks(path, "supplement_package_symlink_rejected");
  await assertNoSymlink(path, "file", "supplement_package_file_invalid", true);
  let value: unknown;
  try { value = JSON.parse(Buffer.from(await readPrivateFileFromDescriptor(path, "supplement_package_unreadable")).toString("utf8")); }
  catch { throw new RestrictedSupplementDerivativeArchiveError(["supplement_package_unreadable"]); }
  return writeRestrictedSupplementDerivativeArchive({ ...options, supplementPackage: value });
}

export const runRestrictedSupplementDerivative = writeRestrictedSupplementDerivativeArchive;
export const applyRestrictedSupplementArchive = writeRestrictedSupplementDerivativeArchive;

export async function readRestrictedSupplementDerivativeArchive(
  rootInput: string,
  options: { supplementReceiptVerifier?: VerifiedSupplementReceiptVerifier } = {},
): Promise<{
  envelope: ExportEnvelope;
  manifest: RedactedExportManifest;
  provenance: RestrictedSupplementDerivativeProvenance;
  verifiedSupplementReceipt?: VerifiedSupplementReceiptBinding;
}> {
  const root = assertSafeAbsolutePath(rootInput, "restricted_derivative_path_invalid");
  await assertPathChainNoSymlinks(root, "restricted_derivative_symlink_rejected");
  const archive = await readRestrictedMigrationArchive(root, options);
  const provenance = await readProvenance(root);
  if (!provenance) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_provenance_missing"]);
  const envelopeHash = sha256(canonicalJson(archive.envelope));
  const manifestHash = sha256(canonicalJson(archive.manifest));
  if (envelopeHash !== provenance.derivativeEnvelopeSha256 || manifestHash !== provenance.derivativeManifestSha256) throw new RestrictedSupplementDerivativeArchiveError(["restricted_derivative_digest_mismatch"]);
  return { ...archive, provenance };
}
