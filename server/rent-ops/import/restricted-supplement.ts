import { canonicalJson, hashRecord, sha256 } from "../export/hash";
import { RestrictedCredentialFieldError } from "../export/collector";
import { scanSupplementCredentialBoundary } from "./supplement-credential-scan";
import type {
  DocumentBinaryDescriptor,
  ExportEnvelope,
  RedactedExportManifest,
} from "../export/types";
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type RentManagerApplicationStatusCrosswalkEntry,
  type RentManagerRawRecord,
} from "../../../shared/rent-ops-contracts";

/**
 * A deliberately small escape hatch for facts that RM's public export does
 * not expose.  This module is an in-memory boundary only: it does not read a
 * file, call RM, or write a database.  The caller must still pass the result
 * through the restricted archive/import path.
 */
export const RESTRICTED_SUPPLEMENT_VERSION = "rm-restricted-supplement/v1" as const;
export const RESTRICTED_SUPPLEMENT_SOURCE_BINDING_VERSION = "rm-restricted-source-binding/v2" as const;

export const RESTRICTED_SUPPLEMENT_KINDS = [
  "application_answers",
  "hap_subsidies",
  "document_binaries",
] as const;

export type RestrictedSupplementKind = (typeof RESTRICTED_SUPPLEMENT_KINDS)[number];

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_REFERENCE = /^[^\u0000\r\n]{1,1000}$/;
const PRIVATE_ARCHIVE_PATH = /^binaries\/[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/;
const SUPPLEMENT_EVIDENCE_TYPE = "independent_evidence_attestation" as const;
/** The only RM collection currently approved for historical application
 * status semantics.  Status labels are source facts, never a free-form
 * selector. */
const APPLICATION_STATUS_CROSSWALK_COLLECTIONS = ["prospectApplications"] as const;
const APPLICATION_STATUS_CROSSWALK_FIELDS = ["status", "Status", "ApplicationStatus"] as const;
const CROSSWALK_SOURCE_VALUE_MAX_LENGTH = 240;
const CROSSWALK_SOURCE_VALUE_FORBIDDEN = /[\\^$.*+?()[\]{}|]/;

/** The file claim is metadata only.  Bytes are never copied into a JSON
 * supplement record, but the descriptor is part of the source binding. */
export interface RestrictedSupplementSourceFileDescriptor {
  reference?: string;
  path?: string;
  filePath?: string;
  sha256?: string;
  hash?: string;
  fileHash?: string;
  descriptorHash?: string;
  sizeBytes?: number;
  size?: number;
  contentType?: string;
  mimeType?: string;
}

export interface RestrictedSupplementParentIdentity {
  sourceCollection: string;
  sourceId: string;
}

export interface RestrictedSupplementFieldIdentity {
  collection?: string;
  id?: string;
  path?: string;
}

export interface RestrictedSupplementOperatorAttestation {
  /** Stable evidence record identifier, not a boolean. */
  attestationId: string;
  /** Must match the envelope's immutable RM run identifier. */
  sourceRunId: string;
  /** Private evidence reference; it is never returned in the report. */
  sourceReference: string;
  /** SHA-256 of the independently reviewed evidence package. */
  sourceSha256: string;
  verifiedAt: string;
  operatorReference: string;
  /** Prevents a bare `verifiedSource: true` from being treated as proof. */
  evidenceType: typeof SUPPLEMENT_EVIDENCE_TYPE;
  /** Exact kinds covered by this attestation. */
  kinds: readonly RestrictedSupplementKind[];
}

export interface RestrictedSupplementSourceEvidence {
  sourceCollection: string;
  sourceId: string;
  sourceUpdatedAt: string;
  sourceReference: string;
  sourceSha256: string;
  operatorReference: string;
  parentSourceCollection?: string;
  parentSourceId?: string;
  fieldIdentity?: RestrictedSupplementFieldIdentity;
  sourceFileDescriptor: RestrictedSupplementSourceFileDescriptor;
}

export interface RestrictedSupplementSourceHashInput {
  kind: RestrictedSupplementKind;
  evidence: Omit<RestrictedSupplementSourceEvidence, "sourceSha256" | "sourceFileDescriptor"> & { sourceFileDescriptor?: RestrictedSupplementSourceFileDescriptor };
  payload: unknown;
  attestation: Pick<RestrictedSupplementOperatorAttestation, "attestationId" | "sourceSha256" | "operatorReference">;
  bytes?: { sha256: string; sizeBytes: number };
}

export interface RestrictedSupplementRow {
  sourceCollection: string;
  sourceId: string;
  sourceUpdatedAt: string;
  sourceReference: string;
  sourceSha256: string;
  operatorReference: string;
  parentSourceCollection?: string;
  parentSourceId?: string;
  parentSourceIdentity?: RestrictedSupplementParentIdentity;
  fieldIdentity?: string | RestrictedSupplementFieldIdentity;
  fieldId?: string;
  fieldPath?: string;
  sourceFileDescriptor?: RestrictedSupplementSourceFileDescriptor;
  sourceFile?: RestrictedSupplementSourceFileDescriptor;
  sourceFilePath?: string;
  sourceFileSha256?: string;
  sourceFileDescriptorSha256?: string;
  sourceFileHash?: string;
  sourceFileSizeBytes?: number;
  sourceFileContentType?: string;
  record: RentManagerRawRecord;
}

export interface RestrictedSupplementBinary {
  sourceCollection: string;
  sourceId: string;
  sourceUpdatedAt: string;
  sourceReference: string;
  sourceSha256: string;
  operatorReference: string;
  parentSourceCollection?: string;
  parentSourceId?: string;
  parentSourceIdentity?: RestrictedSupplementParentIdentity;
  fieldIdentity?: string | RestrictedSupplementFieldIdentity;
  fieldId?: string;
  fieldPath?: string;
  sourceFileDescriptor?: RestrictedSupplementSourceFileDescriptor;
  sourceFile?: RestrictedSupplementSourceFileDescriptor;
  sourceFilePath?: string;
  sourceFileSha256?: string;
  sourceFileDescriptorSha256?: string;
  sourceFileHash?: string;
  sourceFileSizeBytes?: number;
  sourceFileContentType?: string;
  descriptor: DocumentBinaryDescriptor;
  /** Optional bytes are checked but never copied into the derivative JSON. */
  bytes?: Uint8Array | ArrayBuffer;
}

export interface RestrictedSupplementRequest {
  envelope: ExportEnvelope;
  manifest: RedactedExportManifest;
  operatorAttestation: RestrictedSupplementOperatorAttestation;
  applicationAnswers?: readonly RestrictedSupplementRow[];
  hapSubsidies?: readonly RestrictedSupplementRow[];
  documentBinaries?: readonly RestrictedSupplementBinary[];
  /** Exact, independently attested historical-application status semantics.
   * This metadata is accepted only on the restricted supplement path. */
  applicationHistoryStatusCrosswalk?: readonly RentManagerApplicationStatusCrosswalkEntry[];
}

export interface RestrictedSupplementProvenanceReport {
  version: typeof RESTRICTED_SUPPLEMENT_VERSION;
  sourceRunId: string;
  originalEnvelopeSha256: string;
  originalManifestSha256: string;
  derivativeEnvelopeSha256: string;
  derivativeManifestSha256: string;
  supplementSha256: string;
  attestationSha256: string;
  /** Digest of every added row/descriptor, independent of package metadata. */
  rowSetSha256?: string;
  countsAdded: Record<RestrictedSupplementKind, number>;
  sourceIdHashes: Record<RestrictedSupplementKind, string[]>;
  operatorReferenceHash: string;
  verifiedAt: string;
  manifestComplete: boolean;
  exceptionsRemoved: number;
  removedExceptionHashes: string[];
}

export interface RestrictedSupplementResult {
  envelope: ExportEnvelope;
  manifest: RedactedExportManifest;
  report: RestrictedSupplementProvenanceReport;
}

/** Stable, redacted error surface for this boundary. */
export class RestrictedSupplementIntegrityError extends Error {
  readonly reasons: string[];

  constructor(reasons: readonly string[]) {
    const safeReasons = Array.from(new Set(reasons.map(safeReason))).sort();
    super(`Restricted supplement rejected: ${safeReasons.join("; ")}`);
    this.name = "RestrictedSupplementIntegrityError";
    this.reasons = safeReasons;
  }
}

function safeReason(value: unknown): string {
  const text = String(value ?? "");
  return text.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], reason: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new RestrictedSupplementIntegrityError([reason]);
}

function requiredText(value: unknown, reason: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) throw new RestrictedSupplementIntegrityError([reason]);
  const text = value.trim();
  if (pattern && !pattern.test(text)) throw new RestrictedSupplementIntegrityError([reason]);
  return text;
}

function requiredSha256(value: unknown, reason: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new RestrictedSupplementIntegrityError([reason]);
  return value.toLowerCase();
}

function requiredTimestamp(value: unknown, reason: string): string {
  if (typeof value !== "string") throw new RestrictedSupplementIntegrityError([reason]);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new RestrictedSupplementIntegrityError([reason]);
  return value;
}

function optionalText(value: unknown, reason: string, pattern: RegExp = SAFE_REFERENCE): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, reason, pattern);
}

function optionalInteger(value: unknown, reason: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RestrictedSupplementIntegrityError([reason]);
  return number;
}

function optionalSha256(value: unknown, reason: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredSha256(value, reason);
}

function normalizedFieldIdentity(value: unknown, reason: string): RestrictedSupplementFieldIdentity | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return { id: requiredText(value, reason, SAFE_REFERENCE) };
  if (!isRecord(value)) throw new RestrictedSupplementIntegrityError([reason]);
  assertAllowedKeys(value, ["collection", "id", "path"], `${reason}_unsupported_field`);
  const collection = optionalText(value.collection, `${reason}_collection_invalid`, SAFE_TOKEN);
  const id = optionalText(value.id, `${reason}_id_invalid`);
  const path = optionalText(value.path, `${reason}_path_invalid`);
  if (!collection && !id && !path) throw new RestrictedSupplementIntegrityError([reason]);
  return { ...(collection ? { collection } : {}), ...(id ? { id } : {}), ...(path ? { path } : {}) };
}

function normalizedParentIdentity(value: Record<string, unknown>, reason: string): RestrictedSupplementParentIdentity | undefined {
  const nested = value.parentSourceIdentity ?? value.parentIdentity ?? value.parentSource ?? value.parent;
  let sourceCollection = optionalText(value.parentSourceCollection ?? value.sourceParentCollection, `${reason}_collection_invalid`, SAFE_TOKEN);
  let sourceId = optionalText(value.parentSourceId ?? value.sourceParentId, `${reason}_id_invalid`);
  if (nested !== undefined) {
    if (!isRecord(nested)) throw new RestrictedSupplementIntegrityError([`${reason}_invalid`]);
    assertAllowedKeys(nested, ["sourceCollection", "sourceId", "collection", "id"], `${reason}_unsupported_field`);
    sourceCollection ??= optionalText(nested.sourceCollection ?? nested.collection, `${reason}_collection_invalid`, SAFE_TOKEN);
    sourceId ??= optionalText(nested.sourceId ?? nested.id, `${reason}_id_invalid`);
  }
  if (!sourceCollection && !sourceId) return undefined;
  if (!sourceCollection || !sourceId) throw new RestrictedSupplementIntegrityError([`${reason}_incomplete`]);
  return { sourceCollection, sourceId };
}

function normalizedSourceFileDescriptor(
  value: Record<string, unknown>,
  sourceReference: string,
  reason: string,
  fallback: Partial<RestrictedSupplementSourceFileDescriptor> = {},
): RestrictedSupplementSourceFileDescriptor {
  const nested = value.sourceFileDescriptor ?? value.sourceFile;
  const descriptor = nested === undefined ? {} : typeof nested === "string" ? { path: nested } : nested;
  if (!isRecord(descriptor)) throw new RestrictedSupplementIntegrityError([`${reason}_invalid`]);
  assertAllowedKeys(descriptor, ["reference", "path", "filePath", "sha256", "hash", "fileHash", "descriptorHash", "sizeBytes", "size", "contentType", "mimeType"], `${reason}_unsupported_field`);
  const reference = optionalText(descriptor.reference, `${reason}_reference_invalid`, SAFE_REFERENCE) ?? sourceReference;
  const path = optionalText(descriptor.path ?? descriptor.filePath, `${reason}_path_invalid`, SAFE_REFERENCE) ?? optionalText(value.sourceFilePath, `${reason}_path_invalid`, SAFE_REFERENCE) ?? fallback.path;
  const sha = optionalSha256(descriptor.sha256 ?? descriptor.hash ?? descriptor.fileHash ?? descriptor.descriptorHash ?? value.sourceFileSha256 ?? value.sourceFileDescriptorSha256 ?? value.sourceFileHash, `${reason}_hash_invalid`) ?? fallback.sha256;
  const sizeBytes = optionalInteger(descriptor.sizeBytes ?? descriptor.size ?? value.sourceFileSizeBytes, `${reason}_size_invalid`) ?? fallback.sizeBytes;
  const contentType = optionalText(descriptor.contentType ?? descriptor.mimeType ?? value.sourceFileContentType, `${reason}_content_type_invalid`) ?? fallback.contentType;
  return {
    reference,
    ...(path ? { path } : {}),
    ...(sha ? { sha256: sha } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(contentType ? { contentType } : {}),
  };
}

function recordParentSourceId(record: Record<string, unknown>): string | undefined {
  const value = record.parentSourceId ?? record._parentSourceId ?? record.ApplicationID ?? record.ApplicationId ?? record.applicationId
    ?? record.ParentID ?? record.ParentId ?? record.TenantID ?? record.TenantId ?? record.UnitID ?? record.UnitId;
  return value === undefined || value === null || value === "" ? undefined : requiredText(String(value), "supplement_parent_source_id_invalid");
}

function recordFieldIdentity(record: Record<string, unknown>): RestrictedSupplementFieldIdentity | undefined {
  const explicit = record.fieldIdentity ?? record.fieldId ?? record.fieldPath ?? record.ApplicationFieldID ?? record.ApplicationFieldId
    ?? record.FieldID ?? record.FieldId ?? record.QuestionID ?? record.QuestionId;
  if (explicit === undefined || explicit === null || explicit === "") return undefined;
  return { id: requiredText(String(explicit), "supplement_field_identity_invalid", SAFE_REFERENCE) };
}

function assertCanonicalHashable(value: unknown, reason: string): string {
  try {
    return canonicalJson(value);
  } catch {
    throw new RestrictedSupplementIntegrityError([reason]);
  }
}

function collectionKindFor(kind: RestrictedSupplementKind): {
  outputKey: string;
  entityType: string;
  collectionName: string;
  path: string;
} {
  if (kind === "application_answers") return {
    outputKey: "applicationAnswerRecords",
    entityType: "application_answer",
    collectionName: "manual.applicationAnswerRecords",
    path: "manual://applicationAnswerRecords",
  };
  if (kind === "hap_subsidies") return {
    outputKey: "subsidies",
    entityType: "subsidy",
    collectionName: "manual.subsidies",
    path: "manual://subsidies",
  };
  return {
    outputKey: "documentBinaryDescriptors",
    entityType: "document",
    collectionName: "manual.documentBinaries",
    path: "manual://documentBinaries",
  };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sourceIdHash(sourceId: string): string {
  return `id_${sha256(sourceId).slice(0, 16)}`;
}

function supplementRowId(kind: RestrictedSupplementKind, sourceCollection: string, sourceId: string, parentSourceCollection?: string, parentSourceId?: string, fieldIdentity?: RestrictedSupplementFieldIdentity): string {
  return `rm-supplement:${kind}:${sha256(sourceIdentityKey(sourceCollection, sourceId, parentSourceCollection, parentSourceId, fieldIdentity))}`;
}

function validateBase(envelope: ExportEnvelope, manifest: RedactedExportManifest): {
  envelopeSha256: string;
  manifestSha256: string;
} {
  if (!isRecord(envelope) || envelope.version !== "rm-export/v2") throw new RestrictedSupplementIntegrityError(["base_envelope_invalid"]);
  if (!isRecord(manifest) || manifest.version !== "rm-export-manifest/v2") throw new RestrictedSupplementIntegrityError(["base_manifest_invalid"]);
  if (envelope.source?.system !== "rent_manager" || envelope.source?.transport !== "injected" || envelope.source?.readOnly !== true) {
    throw new RestrictedSupplementIntegrityError(["base_source_provenance_invalid"]);
  }
  if (!isRecord(envelope.payload) || !Array.isArray(envelope.documentBinaries) || !Array.isArray(manifest.collections) || !isRecord(manifest.counts)) {
    throw new RestrictedSupplementIntegrityError(["base_shape_invalid"]);
  }
  if (typeof envelope.runId !== "string" || !envelope.runId || manifest.runId !== envelope.runId) {
    throw new RestrictedSupplementIntegrityError(["source_run_binding_invalid"]);
  }
  const envelopeCanonical = assertCanonicalHashable(envelope, "base_envelope_not_hashable");
  const envelopeSha256 = sha256(envelopeCanonical);
  if (manifest.archiveEnvelopeSha256 !== envelopeSha256) throw new RestrictedSupplementIntegrityError(["base_envelope_digest_mismatch"]);
  if (!SHA256.test(manifest.registryHash)) throw new RestrictedSupplementIntegrityError(["base_registry_hash_invalid"]);
  if (!manifest.rawArchive || manifest.rawArchive.mode !== "0600" || manifest.rawArchive.directoryMode !== "0700") {
    throw new RestrictedSupplementIntegrityError(["base_archive_permissions_invalid"]);
  }
  const manifestCanonical = assertCanonicalHashable(manifest, "base_manifest_not_hashable");
  return { envelopeSha256, manifestSha256: sha256(manifestCanonical) };
}

function approvedArtifactSha256(envelope: ExportEnvelope): string {
  const payload = envelope.payload as unknown as Record<string, unknown>;
  const declared = payload.artifactSha256;
  // The collector's parent export does not invent a second artifact ID. Its
  // immutable envelope hash is the stable parent identity; a declared
  // external artifact ID, when present, is the approved identity instead.
  return declared === undefined
    ? sha256(canonicalJson(envelope))
    : requiredSha256(declared, "application_status_crosswalk_artifact_invalid");
}

type ValidatedApplicationStatusCrosswalkEntry = RentManagerApplicationStatusCrosswalkEntry;

/**
 * Validates and canonicalizes the only status semantics that may cross the
 * restricted supplement boundary.  The source label stays in the private
 * derivative envelope, while every rejection is an aggregate-only reason.
 */
function validateApplicationHistoryStatusCrosswalk(
  value: unknown,
  envelope: ExportEnvelope,
): readonly ValidatedApplicationStatusCrosswalkEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_invalid"]);
  if (value.length === 0) throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_empty"]);
  const expectedArtifact = approvedArtifactSha256(envelope);
  const seen = new Map<string, ApplicationStatus>();
  const normalized: ValidatedApplicationStatusCrosswalkEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_entry_invalid"]);
    assertAllowedKeys(candidate, ["artifactSha256", "sourceCollection", "sourceField", "sourceValue", "targetStatus"], "application_status_crosswalk_entry_unsupported_field");
    const artifactSha256 = requiredSha256(candidate.artifactSha256, "application_status_crosswalk_artifact_invalid");
    if (artifactSha256 !== expectedArtifact) throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_artifact_mismatch"]);
    const sourceCollection = requiredText(candidate.sourceCollection, "application_status_crosswalk_collection_invalid", SAFE_TOKEN);
    if (!(APPLICATION_STATUS_CROSSWALK_COLLECTIONS as readonly string[]).includes(sourceCollection)) {
      throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_collection_unsupported"]);
    }
    const sourceField = requiredText(candidate.sourceField, "application_status_crosswalk_field_invalid", SAFE_TOKEN);
    if (!(APPLICATION_STATUS_CROSSWALK_FIELDS as readonly string[]).includes(sourceField)) {
      throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_field_unsupported"]);
    }
    const rawSourceValue = requiredText(candidate.sourceValue, "application_status_crosswalk_source_value_invalid");
    const sourceValue = rawSourceValue.normalize("NFKC").trim();
    if (!sourceValue || sourceValue.length > CROSSWALK_SOURCE_VALUE_MAX_LENGTH || /[\u0000-\u001F\u007F\r\n]/.test(sourceValue)) {
      throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_source_value_invalid"]);
    }
    if (CROSSWALK_SOURCE_VALUE_FORBIDDEN.test(sourceValue)) {
      throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_source_value_pattern_invalid"]);
    }
    const targetStatus = requiredText(candidate.targetStatus, "application_status_crosswalk_target_invalid", SAFE_TOKEN);
    if (!(APPLICATION_STATUSES as readonly string[]).includes(targetStatus)) {
      throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_target_unsupported"]);
    }
    const key = `${artifactSha256}\u0000${sourceCollection}\u0000${sourceField}\u0000${sourceValue}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new RestrictedSupplementIntegrityError([
        prior === targetStatus ? "application_status_crosswalk_duplicate" : "application_status_crosswalk_conflict",
      ]);
    }
    seen.set(key, targetStatus as ApplicationStatus);
    normalized.push({ artifactSha256, sourceCollection, sourceField: sourceField as ValidatedApplicationStatusCrosswalkEntry["sourceField"], sourceValue, targetStatus: targetStatus as ApplicationStatus });
  }
  normalized.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return normalized;
}

function supplementAttestationSha256(
  attestation: RestrictedSupplementOperatorAttestation,
  applicationHistoryStatusCrosswalk: readonly ValidatedApplicationStatusCrosswalkEntry[],
): string {
  return sha256(assertCanonicalHashable({
    attestation,
    applicationHistoryStatusCrosswalk: applicationHistoryStatusCrosswalk.map((entry) => ({ ...entry })),
  }, "supplement_attestation_digest_failed"));
}

function applicationHistoryStatusCrosswalkRowHash(entry: ValidatedApplicationStatusCrosswalkEntry): string {
  return sha256(assertCanonicalHashable({
    domain: "rm-restricted-supplement/application-history-status-crosswalk-row/v1",
    entry,
  }, "application_status_crosswalk_digest_failed"));
}

function validateAttestation(
  value: unknown,
  sourceRunId: string,
  suppliedKinds: readonly RestrictedSupplementKind[],
): RestrictedSupplementOperatorAttestation {
  if (!isRecord(value)) throw new RestrictedSupplementIntegrityError(["evidence_attestation_missing"]);
  assertAllowedKeys(value, ["attestationId", "sourceRunId", "sourceReference", "sourceSha256", "verifiedAt", "operatorReference", "evidenceType", "kinds"], "evidence_attestation_unsupported_field");
  const attestationId = requiredText(value.attestationId, "evidence_attestation_id_invalid", SAFE_TOKEN);
  const attestedRunId = requiredText(value.sourceRunId, "evidence_attestation_run_invalid");
  const sourceReference = requiredText(value.sourceReference, "evidence_attestation_reference_invalid", SAFE_REFERENCE);
  const sourceSha256 = requiredSha256(value.sourceSha256, "evidence_attestation_hash_invalid");
  const verifiedAt = requiredTimestamp(value.verifiedAt, "evidence_attestation_timestamp_invalid");
  const operatorReference = requiredText(value.operatorReference, "evidence_attestation_operator_invalid", SAFE_REFERENCE);
  if (value.evidenceType !== SUPPLEMENT_EVIDENCE_TYPE) throw new RestrictedSupplementIntegrityError(["evidence_attestation_type_invalid"]);
  if (attestedRunId !== sourceRunId) throw new RestrictedSupplementIntegrityError(["evidence_attestation_run_mismatch"]);
  if (!Array.isArray(value.kinds) || value.kinds.length === 0) throw new RestrictedSupplementIntegrityError(["evidence_attestation_scope_invalid"]);
  const kinds = value.kinds.map((kind) => {
    if (typeof kind !== "string" || !(RESTRICTED_SUPPLEMENT_KINDS as readonly string[]).includes(kind)) throw new RestrictedSupplementIntegrityError(["supplement_kind_unsupported"]);
    return kind as RestrictedSupplementKind;
  });
  if (new Set(kinds).size !== kinds.length || kinds.some((kind) => !suppliedKinds.includes(kind)) || suppliedKinds.some((kind) => !kinds.includes(kind))) {
    throw new RestrictedSupplementIntegrityError(["evidence_attestation_scope_mismatch"]);
  }
  return { attestationId, sourceRunId: attestedRunId, sourceReference, sourceSha256, verifiedAt, operatorReference, evidenceType: SUPPLEMENT_EVIDENCE_TYPE, kinds: [...kinds].sort() };
}

type ValidatedSupplementEvidence = RestrictedSupplementSourceEvidence & { claimedSourceSha256: string };

const SOURCE_EVIDENCE_KEYS = [
  "sourceCollection", "sourceId", "sourceUpdatedAt", "sourceReference", "sourceSha256", "operatorReference",
  "parentSourceCollection", "parentSourceId", "parentSourceIdentity", "parentIdentity", "parent",
  "fieldIdentity", "fieldId", "fieldPath", "sourceFileDescriptor", "sourceFile", "sourceFilePath",
  "sourceFileSha256", "sourceFileDescriptorSha256", "sourceFileHash", "sourceFileSizeBytes", "sourceFileContentType",
] as const;

/** RM source timestamps may omit an offset. Preserve that local literal;
 * assigning UTC would invent a source instant. Attestation times remain UTC. */
function sourceTimestamp(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(value)) {
    const seconds = value.slice(0, 19);
    const parsed = new Date(`${seconds}Z`);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === seconds) return value;
  }
  return requiredTimestamp(value, "supplement_source_timestamp_invalid");
}

function validateSourceEvidence(
  value: unknown,
  attestation: RestrictedSupplementOperatorAttestation,
  valueKind: "row" | "binary",
): ValidatedSupplementEvidence {
  if (!isRecord(value)) throw new RestrictedSupplementIntegrityError(["supplement_source_evidence_invalid"]);
  assertAllowedKeys(value, [...SOURCE_EVIDENCE_KEYS, ...(valueKind === "row" ? ["record"] : ["descriptor", "bytes"])], valueKind === "row" ? "supplement_row_unsupported_field" : "supplement_binary_unsupported_field");
  const sourceCollection = requiredText(value.sourceCollection, "supplement_source_collection_invalid", SAFE_TOKEN);
  const sourceId = requiredText(value.sourceId, "supplement_source_id_invalid", SAFE_REFERENCE);
  const sourceUpdatedAt = sourceTimestamp(value.sourceUpdatedAt);
  const sourceReference = requiredText(value.sourceReference, "supplement_source_reference_invalid", SAFE_REFERENCE);
  const claimedSourceSha256 = requiredSha256(value.sourceSha256, "supplement_source_hash_invalid");
  const operatorReference = requiredText(value.operatorReference, "supplement_operator_reference_invalid", SAFE_REFERENCE);
  if (operatorReference !== attestation.operatorReference) throw new RestrictedSupplementIntegrityError(["supplement_operator_reference_mismatch"]);
  const parent = normalizedParentIdentity(value, "supplement_parent_identity");
  const fieldIdentity = normalizedFieldIdentity(value.fieldIdentity ?? value.fieldId ?? value.fieldPath, "supplement_field_identity");
  const sourceFileDescriptor = normalizedSourceFileDescriptor(value, sourceReference, "supplement_source_file_descriptor");
  return {
    sourceCollection,
    sourceId,
    sourceUpdatedAt,
    sourceReference,
    sourceSha256: claimedSourceSha256,
    claimedSourceSha256,
    operatorReference,
    ...(parent ? { parentSourceCollection: parent.sourceCollection, parentSourceId: parent.sourceId } : {}),
    ...(fieldIdentity ? { fieldIdentity } : {}),
    sourceFileDescriptor,
  };
}

function canonicalSourceBinding(
  kind: RestrictedSupplementKind,
  evidence: ValidatedSupplementEvidence,
  payload: unknown,
  attestation: Pick<RestrictedSupplementOperatorAttestation, "attestationId" | "sourceSha256" | "operatorReference">,
  bytes?: { sha256: string; sizeBytes: number },
): Record<string, unknown> {
  return {
    version: RESTRICTED_SUPPLEMENT_SOURCE_BINDING_VERSION,
    kind,
    sourceCollection: evidence.sourceCollection,
    sourceId: evidence.sourceId,
    sourceUpdatedAt: evidence.sourceUpdatedAt,
    sourceReference: evidence.sourceReference,
    parentSourceIdentity: evidence.parentSourceCollection || evidence.parentSourceId
      ? { sourceCollection: evidence.parentSourceCollection ?? null, sourceId: evidence.parentSourceId ?? null }
      : null,
    fieldIdentity: evidence.fieldIdentity ?? null,
    sourceFileDescriptor: evidence.sourceFileDescriptor,
    attestationId: attestation.attestationId,
    attestationSourceSha256: attestation.sourceSha256,
    operatorReference: attestation.operatorReference,
    restrictedPayload: payload,
    ...(bytes ? { restrictedPayloadBytes: bytes } : {}),
  };
}

/** Computes the source hash that a row/binary claim must carry.  The caller's
 * sourceSha256 is intentionally not an input: it is the value being checked,
 * while identity, evidence-file metadata, and restricted payload are all
 * canonicalized into this digest. */
export function restrictedSupplementSourceSha256(input: RestrictedSupplementSourceHashInput): string {
  const rawEvidence = input.evidence as unknown as Record<string, unknown>;
  const sourceReference = requiredText(rawEvidence.sourceReference, "supplement_source_reference_invalid", SAFE_REFERENCE);
  const evidence = applyDerivedEvidenceIdentity({
    ...input.evidence,
    sourceFileDescriptor: normalizedSourceFileDescriptor(rawEvidence, sourceReference, "supplement_source_file_descriptor"),
    sourceSha256: "",
    claimedSourceSha256: "",
  } as ValidatedSupplementEvidence, input.payload, rawEvidence, input.kind);
  return sha256(assertCanonicalHashable(canonicalSourceBinding(input.kind, evidence, input.payload, input.attestation, input.bytes), "supplement_source_binding_not_hashable"));
}

function assertSourceBinding(
  kind: RestrictedSupplementKind,
  evidence: ValidatedSupplementEvidence,
  payload: unknown,
  attestation: Pick<RestrictedSupplementOperatorAttestation, "attestationId" | "sourceSha256" | "operatorReference">,
  bytes?: { sha256: string; sizeBytes: number },
): ValidatedSupplementEvidence {
  const expected = sha256(assertCanonicalHashable(canonicalSourceBinding(kind, evidence, payload, attestation, bytes), "supplement_source_binding_not_hashable"));
  if (evidence.claimedSourceSha256 !== expected) throw new RestrictedSupplementIntegrityError(["supplement_source_hash_mismatch"]);
  return { ...evidence, sourceSha256: expected };
}

function applyDerivedEvidenceIdentity(evidence: ValidatedSupplementEvidence, payload: unknown, value: Record<string, unknown>, kind: RestrictedSupplementKind): ValidatedSupplementEvidence {
  const record = isRecord(payload) ? payload : {};
  const parentSourceId = evidence.parentSourceId ?? recordParentSourceId(record);
  const parentSourceCollection = evidence.parentSourceCollection
    ?? optionalText(value.parentSourceCollection ?? value.sourceParentCollection, "supplement_parent_source_collection_invalid", SAFE_TOKEN);
  const fieldIdentity = evidence.fieldIdentity ?? recordFieldIdentity(record);
  const sourceFileDescriptor = kind === "document_binaries" ? normalizedSourceFileDescriptor(
    value,
    evidence.sourceReference,
    "supplement_source_file_descriptor",
    {
      path: isRecord(payload) ? optionalText(payload.archivePath, "supplement_binary_archive_path_invalid", PRIVATE_ARCHIVE_PATH) : undefined,
      sha256: isRecord(payload) ? optionalSha256(payload.sha256, "supplement_binary_hash_invalid") : undefined,
      sizeBytes: isRecord(payload) ? optionalInteger(payload.sizeBytes, "supplement_binary_size_invalid") : undefined,
      contentType: isRecord(payload) ? optionalText(payload.contentType, "supplement_binary_content_type_invalid") : undefined,
    },
  ) : evidence.sourceFileDescriptor;
  return {
    ...evidence,
    ...(parentSourceId ? { parentSourceId } : {}),
    ...(parentSourceCollection ? { parentSourceCollection } : {}),
    ...(fieldIdentity ? { fieldIdentity } : {}),
    sourceFileDescriptor,
  };
}

function validateRow(kind: RestrictedSupplementKind, value: unknown, attestation: RestrictedSupplementOperatorAttestation): { evidence: RestrictedSupplementSourceEvidence; record: RentManagerRawRecord; rowId: string } {
  if (!isRecord(value)) throw new RestrictedSupplementIntegrityError(["supplement_row_invalid"]);
  const rawEvidence = validateSourceEvidence(value, attestation, "row");
  if (!isRecord(value.record)) throw new RestrictedSupplementIntegrityError(["supplement_record_invalid"]);
  const record = value.record as RentManagerRawRecord;
  const recordSourceId = record.sourceId === undefined ? undefined : String(record.sourceId).trim();
  const recordCollection = record.sourceCollection === undefined ? undefined : String(record.sourceCollection).trim();
  if (recordSourceId && recordSourceId !== rawEvidence.sourceId) throw new RestrictedSupplementIntegrityError(["supplement_source_id_conflict"]);
  if (recordCollection && recordCollection !== rawEvidence.sourceCollection) throw new RestrictedSupplementIntegrityError(["supplement_source_collection_conflict"]);
  if (hasOwn(record as unknown as Record<string, unknown>, "supplementEvidence") || hasOwn(record as unknown as Record<string, unknown>, "supplementRowId")) {
    throw new RestrictedSupplementIntegrityError(["supplement_reserved_field_conflict"]);
  }
  const evidence = applyDerivedEvidenceIdentity(rawEvidence, record, value, kind);
  const boundEvidence = assertSourceBinding(kind, evidence, record, attestation);
  const rowId = supplementRowId(kind, boundEvidence.sourceCollection, boundEvidence.sourceId, boundEvidence.parentSourceCollection, boundEvidence.parentSourceId, boundEvidence.fieldIdentity);
  const kindInfo = collectionKindFor(kind);
  const normalized: RentManagerRawRecord = {
    ...clone(record),
    entityType: record.entityType ?? kindInfo.entityType,
    sourceCollection: boundEvidence.sourceCollection,
    sourceId: boundEvidence.sourceId,
    ...(boundEvidence.parentSourceId ? { parentSourceId: boundEvidence.parentSourceId } : {}),
    ...(boundEvidence.parentSourceCollection ? { parentSourceCollection: boundEvidence.parentSourceCollection } : {}),
    ...(boundEvidence.fieldIdentity ? { fieldIdentity: boundEvidence.fieldIdentity } : {}),
    sourceFileDescriptor: boundEvidence.sourceFileDescriptor,
    supplementRowId: rowId,
    supplementEvidence: {
      sourceReference: boundEvidence.sourceReference,
      sourceSha256: boundEvidence.sourceSha256,
      sourceUpdatedAt: boundEvidence.sourceUpdatedAt,
      operatorReference: boundEvidence.operatorReference,
      attestationId: attestation.attestationId,
      ...(boundEvidence.parentSourceId ? { parentSourceId: boundEvidence.parentSourceId } : {}),
      ...(boundEvidence.parentSourceCollection ? { parentSourceCollection: boundEvidence.parentSourceCollection } : {}),
      ...(boundEvidence.fieldIdentity ? { fieldIdentity: boundEvidence.fieldIdentity } : {}),
      sourceFileDescriptor: boundEvidence.sourceFileDescriptor,
    },
  };
  return { evidence: boundEvidence, record: normalized, rowId };
}

function validateBinary(value: unknown, attestation: RestrictedSupplementOperatorAttestation): { evidence: RestrictedSupplementSourceEvidence; descriptor: DocumentBinaryDescriptor; rowId: string; bytes?: Uint8Array } {
  if (!isRecord(value)) throw new RestrictedSupplementIntegrityError(["supplement_binary_invalid"]);
  assertAllowedKeys(value, [...SOURCE_EVIDENCE_KEYS, "descriptor", "bytes"], "supplement_binary_unsupported_field");
  const rawEvidence = validateSourceEvidence(value, attestation, "binary");
  if (!isRecord(value.descriptor)) throw new RestrictedSupplementIntegrityError(["supplement_binary_descriptor_invalid"]);
  const descriptorValue = value.descriptor;
  assertAllowedKeys(descriptorValue, ["sourceId", "fileName", "metadataAvailable", "binaryAvailable", "descriptorOnly", "contentType", "sizeBytes", "sha256", "archivePath", "availabilityReason"], "supplement_binary_descriptor_unsupported_field");
  const descriptorSourceId = requiredText(descriptorValue.sourceId, "supplement_binary_source_id_invalid", SAFE_REFERENCE);
  if (descriptorSourceId !== rawEvidence.sourceId) throw new RestrictedSupplementIntegrityError(["supplement_binary_source_id_conflict"]);
  if (descriptorValue.metadataAvailable !== true || descriptorValue.binaryAvailable !== true || descriptorValue.descriptorOnly === true) {
    throw new RestrictedSupplementIntegrityError(["supplement_binary_not_verified"]);
  }
  const checksum = requiredSha256(descriptorValue.sha256, "supplement_binary_hash_invalid");
  const sizeBytes = Number(descriptorValue.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new RestrictedSupplementIntegrityError(["supplement_binary_size_invalid"]);
  const archivePath = requiredText(descriptorValue.archivePath, "supplement_binary_archive_path_invalid", PRIVATE_ARCHIVE_PATH);
  if (archivePath.includes("..") || archivePath.includes("//") || archivePath.includes("\\")) throw new RestrictedSupplementIntegrityError(["supplement_binary_archive_path_invalid"]);
  if (descriptorValue.availabilityReason !== "archived") throw new RestrictedSupplementIntegrityError(["supplement_binary_archive_state_invalid"]);
  if (descriptorValue.contentType !== undefined && (typeof descriptorValue.contentType !== "string" || !SAFE_REFERENCE.test(descriptorValue.contentType))) {
    throw new RestrictedSupplementIntegrityError(["supplement_binary_content_type_invalid"]);
  }
  let bytes: Uint8Array | undefined;
  if (value.bytes !== undefined) {
    if (value.bytes instanceof Uint8Array) bytes = new Uint8Array(value.bytes);
    else if (value.bytes instanceof ArrayBuffer) bytes = new Uint8Array(value.bytes.slice(0));
    else throw new RestrictedSupplementIntegrityError(["supplement_binary_bytes_invalid"]);
    if (bytes.byteLength !== sizeBytes || sha256(bytes) !== checksum) throw new RestrictedSupplementIntegrityError(["supplement_binary_content_mismatch"]);
  }
  const fileName = optionalText(descriptorValue.fileName, "supplement_binary_filename_invalid", SAFE_REFERENCE);
  if (fileName && (fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..")) throw new RestrictedSupplementIntegrityError(["supplement_binary_filename_invalid"]);
  const descriptor: DocumentBinaryDescriptor = {
    sourceId: descriptorSourceId,
    ...(fileName === undefined ? {} : { fileName }),
    metadataAvailable: true,
    binaryAvailable: true,
    descriptorOnly: false,
    ...(descriptorValue.contentType === undefined ? {} : { contentType: descriptorValue.contentType as string }),
    sizeBytes,
    sha256: checksum,
    archivePath,
    availabilityReason: "archived",
  };
  const evidence = applyDerivedEvidenceIdentity(rawEvidence, descriptor, value, "document_binaries");
  const boundEvidence = assertSourceBinding("document_binaries", evidence, descriptor, attestation, { sha256: checksum, sizeBytes });
  return {
    evidence: boundEvidence,
    descriptor,
    rowId: supplementRowId("document_binaries", boundEvidence.sourceCollection, boundEvidence.sourceId, boundEvidence.parentSourceCollection, boundEvidence.parentSourceId, boundEvidence.fieldIdentity),
    ...(bytes ? { bytes } : {}),
  };
}

function sourceIdentityKey(
  sourceCollection: string,
  sourceId: string,
  parentSourceCollection?: string,
  parentSourceId?: string,
  fieldIdentity?: RestrictedSupplementFieldIdentity,
): string {
  return canonicalJson({
    sourceCollection,
    sourceId,
    parentSourceCollection: parentSourceCollection ?? null,
    parentSourceId: parentSourceId ?? null,
    fieldIdentity: fieldIdentity ?? null,
  });
}

function sourceIdentityFromRecord(row: Record<string, unknown>, fallbackCollection: string): string {
  const sourceCollection = row.sourceCollection === undefined ? fallbackCollection : String(row.sourceCollection).trim();
  const sourceId = row.sourceId === undefined ? "" : String(row.sourceId).trim();
  const parentSourceCollection = row.parentSourceCollection === undefined ? undefined : String(row.parentSourceCollection).trim();
  const parentSourceId = row.parentSourceId === undefined ? undefined : String(row.parentSourceId).trim();
  const fieldIdentity = normalizedFieldIdentity(row.fieldIdentity ?? row.fieldId ?? row.fieldPath, "base_field_identity");
  return sourceIdentityKey(sourceCollection, sourceId, parentSourceCollection, parentSourceId, fieldIdentity);
}

function baseSourceIds(value: unknown, fallbackCollection: string, descriptor = false): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw new RestrictedSupplementIntegrityError(["base_target_collection_invalid"]);
  const result = new Set<string>();
  for (const row of value) {
    if (!isRecord(row)) throw new RestrictedSupplementIntegrityError(["base_target_collection_invalid"]);
    const sourceId = row.sourceId ?? (descriptor ? row.sourceId : undefined);
    if (sourceId === undefined || sourceId === null || String(sourceId).trim() === "") continue;
    const normalized = sourceIdentityFromRecord(row, fallbackCollection);
    if (result.has(normalized)) throw new RestrictedSupplementIntegrityError(["base_target_collection_duplicate"]);
    result.add(normalized);
  }
  return result;
}

function updateCoverage(
  manifest: RedactedExportManifest,
  kind: RestrictedSupplementKind,
  records: readonly { rowId: string }[],
  envelope: ExportEnvelope,
): RedactedExportManifest["collections"][number] {
  const info = collectionKindFor(kind);
  const payload = envelope.payload as unknown as Record<string, unknown>;
  const candidateValue = payload[info.outputKey];
  const candidateRows: Record<string, unknown>[] = Array.isArray(candidateValue)
    ? candidateValue.filter((row: unknown): row is Record<string, unknown> => isRecord(row))
    : [];
  const rowIds = new Set(records.map((record) => record.rowId));
  const recordHashes = candidateRows
    .filter((row: Record<string, unknown>) => typeof row.supplementRowId === "string" && rowIds.has(row.supplementRowId))
    .map((row) => hashRecord(row));
  if (recordHashes.length !== records.length) throw new RestrictedSupplementIntegrityError(["supplement_manifest_row_binding_invalid"]);
  return {
    name: info.collectionName,
    path: info.path,
    outputKey: info.outputKey,
    kind: "collection",
    required: true,
    status: records.length > 0 ? "complete" : "empty",
    pages: records.length > 0 ? 1 : 0,
    requested: records.length,
    received: records.length,
    expected: records.length,
    recordHashes,
    errors: [],
    exceptions: [],
    clientSideValidation: "operator_attested_source_rows",
  };
}

function exceptionCodeFor(kind: RestrictedSupplementKind): string {
  return kind === "document_binaries" ? "binary_unavailable" : "missing_source_id";
}

function exceptionDetailFor(kind: RestrictedSupplementKind): string {
  return kind === "document_binaries" ? "binary_descriptor_without_archived_binary" : "record_source_id_missing";
}

interface AddedSupplementRecord {
  rowId: string;
  evidence: RestrictedSupplementSourceEvidence;
  record?: RentManagerRawRecord;
  descriptor?: DocumentBinaryDescriptor;
  bytes?: Uint8Array;
}

function exactExceptionMatches(kind: RestrictedSupplementKind, exception: { code: string; collection: string; sourceIdHash?: string; detail: string }, evidence: RestrictedSupplementSourceEvidence): boolean {
  return exception.code === exceptionCodeFor(kind)
    && exception.collection === evidence.sourceCollection
    && exception.sourceIdHash === sourceIdHash(evidence.sourceId)
    && exception.detail === exceptionDetailFor(kind);
}

function exceptionHash(exception: unknown): string {
  return sha256(assertCanonicalHashable(exception, "exception_hash_failed"));
}

interface RebuiltManifestResult {
  manifest: RedactedExportManifest;
  removedExceptionHashes: string[];
}

function rebuildManifest(
  original: RedactedExportManifest,
  envelope: ExportEnvelope,
  added: Record<RestrictedSupplementKind, readonly AddedSupplementRecord[]>,
): RebuiltManifestResult {
  const updatedCollections = [...original.collections];
  const removedExceptionHashes: string[] = [];
  for (const kind of RESTRICTED_SUPPLEMENT_KINDS) {
    if (added[kind].length === 0) continue;
    for (let index = 0; index < updatedCollections.length; index += 1) {
      const collection = updatedCollections[index];
      const matchingEvidence = added[kind]
        .map((record) => record.evidence)
        .filter((evidence) => collection.exceptions.some((exception) => exactExceptionMatches(kind, exception, evidence)));
      if (matchingEvidence.length === 0) continue;
      const exceptions = collection.exceptions.filter((exception) => {
        const matching = matchingEvidence.some((evidence) => exactExceptionMatches(kind, exception, evidence));
        if (matching) removedExceptionHashes.push(exceptionHash(exception));
        return !matching;
      });
      updatedCollections[index] = {
        ...collection,
        exceptions,
        ...(collection.errors.length === 0 && exceptions.length === 0
          ? { status: added[kind].length > 0 ? "complete" as const : "empty" as const }
          : {}),
      };
    }
    updatedCollections.push(updateCoverage(original, kind, added[kind], envelope));
  }
  const rootExceptions = original.exceptions.filter((exception) => {
    const matching = RESTRICTED_SUPPLEMENT_KINDS.some((kind) => added[kind].some((record) => exactExceptionMatches(kind, exception, record.evidence)));
    if (matching) removedExceptionHashes.push(exceptionHash(exception));
    return !matching;
  });
  const counts = { ...original.counts };
  if (added.application_answers.length > 0) counts.applicationAnswerRecords = (envelope.payload.applicationAnswerRecords ?? []).length;
  if (added.hap_subsidies.length > 0) counts.subsidies = (envelope.payload.subsidies ?? []).length;
  if (added.document_binaries.length > 0) {
    counts.documentBinaryDescriptors = (envelope.payload.documentBinaryDescriptors ?? []).length;
    counts.documentBinaries = envelope.documentBinaries.length;
  }
  const documentBinarySummary = added.document_binaries.length > 0
    ? {
      metadataCount: envelope.documentBinaries.length,
      binaryAvailableCount: envelope.documentBinaries.filter((descriptor) => descriptor.binaryAvailable).length,
      descriptorOnlyCount: envelope.documentBinaries.filter((descriptor) => descriptor.descriptorOnly || !descriptor.binaryAvailable).length,
    }
    : { ...original.documentBinarySummary };
  const candidate: RedactedExportManifest = {
    ...clone(original),
    archiveEnvelopeSha256: sha256(canonicalJson(envelope)),
    counts,
    collections: updatedCollections,
    exceptions: rootExceptions,
    documentBinarySummary,
  };
  const allCoverageResolved = candidate.collections.every((collection) => {
    if (!collection.required) return collection.status === "complete" || collection.status === "empty" || collection.status === "not_available";
    return (collection.status === "complete" || collection.status === "empty") && collection.errors.length === 0 && collection.exceptions.length === 0;
  });
  // Collector completeness permits an explicitly unavailable optional endpoint.
  // Keep its evidence in the manifest; it is not an unfinished required read.
  const optionalUnavailable = (collectionName: string | undefined) => typeof collectionName === "string" && candidate.collections.some((collection) => collection.name === collectionName && !collection.required && collection.status === "not_available");
  candidate.complete = allCoverageResolved
    && candidate.errors.every((error) => optionalUnavailable(error.collection))
    && candidate.exceptions.every((exception) => optionalUnavailable(exception.collection));
  return { manifest: candidate, removedExceptionHashes: removedExceptionHashes.sort() };
}

function sourceIdsForReport(kind: RestrictedSupplementKind, rows: readonly { evidence: RestrictedSupplementSourceEvidence }[]): string[] {
  return rows.map((row) => sourceIdHash(`${kind}\u0000${sourceIdentityKey(row.evidence.sourceCollection, row.evidence.sourceId, row.evidence.parentSourceCollection, row.evidence.parentSourceId, row.evidence.fieldIdentity)}`)).sort();
}

/**
 * Adds only explicitly attested rows to a fresh envelope/manifest pair.
 * Every path is allow-listed and every failure is a stable code, so this
 * boundary is safe to call from an operator-facing CLI without leaking PII.
 */
export function buildRestrictedSupplement(request: RestrictedSupplementRequest): RestrictedSupplementResult {
  if (!isRecord(request as unknown as Record<string, unknown>)) throw new RestrictedSupplementIntegrityError(["supplement_request_invalid"]);
  const requestValue = request as unknown as Record<string, unknown>;
  assertAllowedKeys(requestValue, ["envelope", "manifest", "operatorAttestation", "applicationAnswers", "hapSubsidies", "documentBinaries", "applicationHistoryStatusCrosswalk"], "supplement_request_unsupported_field");
  try {
    // The collector's recursive boundary is reused here before any
    // derivative clone, source hash, or manifest write.  Supplement rows are
    // untrusted inputs even when their operator envelope is well-shaped.
    scanSupplementCredentialBoundary(requestValue);
  } catch (error) {
    if (error instanceof RestrictedCredentialFieldError) {
      throw new RestrictedSupplementIntegrityError(["credential_field_rejected"]);
    }
    throw error;
  }
  const envelope = request.envelope;
  const manifest = request.manifest;
  const base = validateBase(envelope, manifest);
  const applicationHistoryStatusCrosswalk = validateApplicationHistoryStatusCrosswalk(request.applicationHistoryStatusCrosswalk, envelope);
  const suppliedKinds = RESTRICTED_SUPPLEMENT_KINDS.filter((kind) => {
    const value = kind === "application_answers" ? request.applicationAnswers : kind === "hap_subsidies" ? request.hapSubsidies : request.documentBinaries;
    return value !== undefined;
  });
  if (suppliedKinds.length === 0) throw new RestrictedSupplementIntegrityError(["supplement_empty"]);
  // Status semantics are an application supplement, never a free-standing
  // caller claim.  Requiring the independently attested application-answer
  // partition keeps the crosswalk on the same approved receipt chain.
  if (applicationHistoryStatusCrosswalk.length > 0 && !suppliedKinds.includes("application_answers")) {
    throw new RestrictedSupplementIntegrityError(["application_status_crosswalk_attestation_scope_invalid"]);
  }
  for (const kind of suppliedKinds) {
    const value = kind === "application_answers" ? request.applicationAnswers : kind === "hap_subsidies" ? request.hapSubsidies : request.documentBinaries;
    if (!Array.isArray(value) || value.length === 0) throw new RestrictedSupplementIntegrityError(["supplement_collection_empty"]);
  }
  const attestation = validateAttestation(request.operatorAttestation, envelope.runId, suppliedKinds);
  const derivative = clone(envelope);
  derivative.payload = clone(envelope.payload);
  derivative.documentBinaries = clone(envelope.documentBinaries);
  if (applicationHistoryStatusCrosswalk.length > 0) {
    if (derivative.payload.artifactSha256 === undefined) derivative.payload.artifactSha256 = approvedArtifactSha256(envelope);
    derivative.payload.applicationHistoryStatusCrosswalk = applicationHistoryStatusCrosswalk.map((entry) => ({ ...entry }));
  }
  const addedRows: Record<RestrictedSupplementKind, Array<AddedSupplementRecord>> = {
    application_answers: [],
    hap_subsidies: [],
    document_binaries: [],
  };

  const existingApplicationIds = baseSourceIds(derivative.payload.applicationAnswerRecords, "applicationAnswerRecords");
  const existingSubsidyIds = baseSourceIds(derivative.payload.subsidies, "subsidies");
  const existingDescriptorIds = baseSourceIds(derivative.payload.documentBinaryDescriptors, "documentBinaryDescriptors", true);
  const existingBinaryIds = baseSourceIds(derivative.documentBinaries, "documentBinaryDescriptors", true);
  existingDescriptorIds.forEach((sourceId) => existingBinaryIds.add(sourceId));
  const seenIds: Record<RestrictedSupplementKind, Set<string>> = {
    application_answers: new Set(),
    hap_subsidies: new Set(),
    document_binaries: new Set(),
  };
  const addRows = (kind: "application_answers" | "hap_subsidies", values: readonly RestrictedSupplementRow[] | undefined): void => {
    for (const value of values ?? []) {
      const row = validateRow(kind, value, attestation);
      const key = sourceIdentityKey(row.evidence.sourceCollection, row.evidence.sourceId, row.evidence.parentSourceCollection, row.evidence.parentSourceId, row.evidence.fieldIdentity);
      if (seenIds[kind].has(key)) throw new RestrictedSupplementIntegrityError(["supplement_duplicate_row"]);
      seenIds[kind].add(key);
      const existing = kind === "application_answers" ? existingApplicationIds : existingSubsidyIds;
      if (existing.has(key)) throw new RestrictedSupplementIntegrityError(["supplement_source_id_duplicate"]);
      addedRows[kind].push({ evidence: row.evidence, rowId: row.rowId, record: row.record });
      const outputKey = collectionKindFor(kind).outputKey as "applicationAnswerRecords" | "subsidies";
      const target = ((derivative.payload as Record<string, unknown>)[outputKey] ?? []) as RentManagerRawRecord[];
      target.push(row.record);
      (derivative.payload as Record<string, unknown>)[outputKey] = target;
    }
  };
  addRows("application_answers", request.applicationAnswers);
  addRows("hap_subsidies", request.hapSubsidies);
  for (const value of request.documentBinaries ?? []) {
    const binary = validateBinary(value, attestation);
    const key = sourceIdentityKey(binary.evidence.sourceCollection, binary.evidence.sourceId, binary.evidence.parentSourceCollection, binary.evidence.parentSourceId, binary.evidence.fieldIdentity);
    if (seenIds.document_binaries.has(key) || existingBinaryIds.has(key)) throw new RestrictedSupplementIntegrityError(["supplement_binary_duplicate"]);
    seenIds.document_binaries.add(key);
    addedRows.document_binaries.push({ evidence: binary.evidence, rowId: binary.rowId, descriptor: binary.descriptor, ...(binary.bytes ? { bytes: binary.bytes } : {}) });
    const descriptorRow = {
      ...binary.descriptor,
      entityType: "document",
      sourceCollection: binary.evidence.sourceCollection,
      supplementRowId: binary.rowId,
      supplementEvidence: {
        sourceReference: binary.evidence.sourceReference,
        sourceSha256: binary.evidence.sourceSha256,
        sourceUpdatedAt: binary.evidence.sourceUpdatedAt,
        operatorReference: binary.evidence.operatorReference,
        attestationId: attestation.attestationId,
        ...(binary.evidence.parentSourceId ? { parentSourceId: binary.evidence.parentSourceId } : {}),
        ...(binary.evidence.parentSourceCollection ? { parentSourceCollection: binary.evidence.parentSourceCollection } : {}),
        ...(binary.evidence.fieldIdentity ? { fieldIdentity: binary.evidence.fieldIdentity } : {}),
        sourceFileDescriptor: binary.evidence.sourceFileDescriptor,
      },
    } as unknown as RentManagerRawRecord;
    const descriptorRows = ((derivative.payload as Record<string, unknown>).documentBinaryDescriptors ?? []) as RentManagerRawRecord[];
    descriptorRows.push(descriptorRow);
    (derivative.payload as Record<string, unknown>).documentBinaryDescriptors = descriptorRows;
    derivative.documentBinaries.push(binary.descriptor);
    const payloadBinaries = ((derivative.payload as Record<string, unknown>).documentBinaries ?? []) as DocumentBinaryDescriptor[];
    payloadBinaries.push(binary.descriptor);
    (derivative.payload as Record<string, unknown>).documentBinaries = payloadBinaries;
  }

  // Preserve the base snapshot order, while making every newly supplied
  // partition independent of caller array order.  This is what makes a
  // retry/replay digest stable without reordering RM's original export.
  for (const outputKey of ["applicationAnswerRecords", "subsidies", "documentBinaryDescriptors"] as const) {
    const target = (derivative.payload as Record<string, unknown>)[outputKey];
    if (!Array.isArray(target)) continue;
    const baseRows = target.filter((row) => !isRecord(row) || typeof row.supplementRowId !== "string");
    const supplementedRows = target
      .filter((row): row is Record<string, unknown> => isRecord(row) && typeof row.supplementRowId === "string")
      .sort((left, right) => String(left.supplementRowId).localeCompare(String(right.supplementRowId)));
    (derivative.payload as Record<string, unknown>)[outputKey] = [...baseRows, ...supplementedRows];
  }
  derivative.documentBinaries.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const payloadBinaries = (derivative.payload as Record<string, unknown>).documentBinaries;
  if (Array.isArray(payloadBinaries)) payloadBinaries.sort((left, right) => String((left as DocumentBinaryDescriptor).sourceId).localeCompare(String((right as DocumentBinaryDescriptor).sourceId)));

  for (const kind of RESTRICTED_SUPPLEMENT_KINDS) {
    addedRows[kind].sort((left, right) => left.rowId.localeCompare(right.rowId));
  }
  const applicationHistoryStatusCrosswalkRowHashes = applicationHistoryStatusCrosswalk
    .map(applicationHistoryStatusCrosswalkRowHash)
    .sort();
  if (applicationHistoryStatusCrosswalkRowHashes.length > 0) {
    const crosswalkRowSetSha256 = sha256(applicationHistoryStatusCrosswalkRowHashes.join("\n"));
    for (const row of addedRows.application_answers) {
      if (!row.record || !isRecord(row.record.supplementEvidence)) continue;
      row.record.supplementEvidence = {
        ...row.record.supplementEvidence,
        applicationHistoryStatusCrosswalkRowHashes: [...applicationHistoryStatusCrosswalkRowHashes],
        applicationHistoryStatusCrosswalkRowSetSha256: crosswalkRowSetSha256,
      };
    }
  }
  const supplementDigestInput = {
    version: RESTRICTED_SUPPLEMENT_VERSION,
    sourceRunId: envelope.runId,
    attestation,
    applicationHistoryStatusCrosswalk: applicationHistoryStatusCrosswalk.map((entry) => ({ ...entry })),
    applicationAnswers: addedRows.application_answers.map((row) => ({ rowId: row.rowId, evidence: row.evidence, record: row.record })),
    hapSubsidies: addedRows.hap_subsidies.map((row) => ({ rowId: row.rowId, evidence: row.evidence, record: row.record })),
    documentBinaries: addedRows.document_binaries.map((row) => ({ rowId: row.rowId, evidence: row.evidence, descriptor: row.descriptor, bytes: row.bytes ? { sha256: sha256(row.bytes), sizeBytes: row.bytes.byteLength } : undefined })),
  };
  const supplementSha256 = sha256(assertCanonicalHashable(supplementDigestInput, "supplement_digest_failed"));
  const attestationSha256 = supplementAttestationSha256(attestation, applicationHistoryStatusCrosswalk);
  const rowHashes = RESTRICTED_SUPPLEMENT_KINDS.flatMap((kind) => addedRows[kind].map((row) => {
    // Application-answer rows are consumed by the normalizer's approved
    // supplement gate, which hashes the canonical normalized row itself.
    // The private evidence marker above carries the domain-separated
    // crosswalk row hashes into that canonical row without exposing source
    // labels or adding non-row hashes that would fail the gate's cardinality
    // check. Other supplement kinds retain their wrapper-bound row digest.
    if (kind === "application_answers" && row.record) return sha256(canonicalJson(row.record));
    return sha256(canonicalJson({
      kind,
      rowId: row.rowId,
      evidence: row.evidence,
      ...(row.record ? { record: row.record } : {}),
      ...(row.descriptor ? { descriptor: row.descriptor } : {}),
      ...(row.bytes ? { bytes: { sha256: sha256(row.bytes), sizeBytes: row.bytes.byteLength } } : {}),
    }));
  })).sort();
  // Bind the approved provenance to the derivative envelope itself.  The
  // artifact builder can therefore distinguish a verified supplement from a
  // caller-supplied row-shaped attestation without trusting any row field.
  derivative.supplementEvidence = {
    version: RESTRICTED_SUPPLEMENT_VERSION,
    sourceRunId: envelope.runId,
    supplementSha256,
    attestationSha256,
    kinds: [...suppliedKinds].sort(),
    rowHashes,
    rowSetSha256: sha256(rowHashes.join("\n")),
  };
  // The envelope-level provenance marker is part of the canonical envelope,
  // so rebuild the manifest only after adding it.  Otherwise
  // archiveEnvelopeSha256 would describe a pre-attestation envelope and the
  // derivative would fail its own digest check.
  const rebuiltManifest = rebuildManifest(manifest, derivative, {
    application_answers: addedRows.application_answers,
    hap_subsidies: addedRows.hap_subsidies,
    document_binaries: addedRows.document_binaries,
  });
  const derivativeManifest: RedactedExportManifest = {
    ...rebuiltManifest.manifest,
    ...(applicationHistoryStatusCrosswalk.length > 0
      ? { counts: { ...rebuiltManifest.manifest.counts, applicationHistoryStatusCrosswalk: applicationHistoryStatusCrosswalk.length } }
      : {}),
  };
  const derivativeEnvelopeSha256 = sha256(canonicalJson(derivative));
  const derivativeManifestSha256 = sha256(canonicalJson(derivativeManifest));
  const report: RestrictedSupplementProvenanceReport = {
    version: RESTRICTED_SUPPLEMENT_VERSION,
    sourceRunId: envelope.runId,
    originalEnvelopeSha256: base.envelopeSha256,
    originalManifestSha256: base.manifestSha256,
    derivativeEnvelopeSha256,
    derivativeManifestSha256,
    supplementSha256,
    attestationSha256,
    rowSetSha256: sha256(rowHashes.join("\n")),
    countsAdded: {
      application_answers: addedRows.application_answers.length,
      hap_subsidies: addedRows.hap_subsidies.length,
      document_binaries: addedRows.document_binaries.length,
    },
    sourceIdHashes: {
      application_answers: sourceIdsForReport("application_answers", addedRows.application_answers),
      hap_subsidies: sourceIdsForReport("hap_subsidies", addedRows.hap_subsidies),
      document_binaries: sourceIdsForReport("document_binaries", addedRows.document_binaries),
    },
    operatorReferenceHash: sha256(attestation.operatorReference),
    verifiedAt: attestation.verifiedAt,
    manifestComplete: derivativeManifest.complete,
    exceptionsRemoved: rebuiltManifest.removedExceptionHashes.length,
    removedExceptionHashes: rebuiltManifest.removedExceptionHashes,
  };
  return { envelope: derivative, manifest: derivativeManifest, report };
}

export function restrictedSupplementRowId(kind: RestrictedSupplementKind, sourceCollection: string, sourceId: string): string {
  requiredText(sourceCollection, "supplement_source_collection_invalid", SAFE_TOKEN);
  requiredText(sourceId, "supplement_source_id_invalid", SAFE_REFERENCE);
  return supplementRowId(kind, sourceCollection, sourceId);
}

export function restrictedSupplementDigest(value: unknown): string {
  return sha256(assertCanonicalHashable(value, "supplement_digest_failed"));
}
