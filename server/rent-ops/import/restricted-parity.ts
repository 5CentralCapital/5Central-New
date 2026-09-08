import { canonicalJson, sha256 } from "../export/hash";
import type { ExportEnvelope, RedactedExportManifest } from "../export/types";

/**
 * A read-only, in-memory control for the restricted RM source boundary.
 *
 * This module intentionally has no archive, database, environment, transport,
 * or filesystem dependency.  It describes the evidence a writer must supply;
 * it does not try to discover that evidence from a live system.
 */

export const RESTRICTED_PARITY_VERSION = "rm-restricted-parity/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_TOKEN = /^[^\u0000\r\n]{1,240}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** The limits make this audit suitable for a canary or CI check, not a bulk loader. */
export const RESTRICTED_PARITY_LIMITS = {
  maxDepth: 32,
  maxNodes: 50_000,
  maxCollections: 512,
  maxRows: 25_000,
  maxCanonicalBytes: 4_000_000,
  maxFindings: 128,
} as const;

export interface RestrictedParityLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxCollections?: number;
  maxRows?: number;
  maxCanonicalBytes?: number;
  maxFindings?: number;
}

/**
 * One collection observation is the missing persistence seam in the current
 * source-payload writer.  `present` deliberately distinguishes an empty RM
 * array from an array that was never present in the source envelope.
 */
export interface RestrictedCollectionObservation {
  path: string;
  present: boolean;
  rowCount: number;
  orderedRowsSha256: string;
  sourceIdentityRowsSha256: string;
}

/**
 * Minimal import observation required to attest the atomic source envelope.
 * The existing restricted rows have `importRunId` but not these envelope and
 * collection controls, so a DB row set alone cannot reconstruct this record.
 */
export interface RestrictedImportObservation {
  version: typeof RESTRICTED_PARITY_VERSION;
  source: "rent_manager";
  sourceRunId: string;
  importRunId: string;
  observedAt: string;
  sourceEnvelopeSha256: string;
  sourceManifestSha256?: string;
  sourceRowsSha256: string;
  collectionsSha256: string;
  collections: readonly RestrictedCollectionObservation[];
}

/**
 * Shape accepted from a restricted table adapter.  Both camelCase and the
 * current SQL snake_case names are accepted so the audit can sit between the
 * writer and a repository without changing either owner.
 */
export interface RestrictedSourcePayloadRowLike {
  id?: unknown;
  system?: unknown;
  sourceCollection?: unknown;
  source_collection?: unknown;
  sourceId?: unknown;
  source_id?: unknown;
  sourceUpdatedAt?: unknown;
  source_updated_at?: unknown;
  payload?: unknown;
  canonicalPayload?: unknown;
  checksumSha256?: unknown;
  checksum_sha256?: unknown;
  importRunId?: unknown;
  import_run_id?: unknown;
  importedAt?: unknown;
  imported_at?: unknown;
  [key: string]: unknown;
}

/** A row emitted by the pure mapping seam.  Payload and metadata are frozen. */
export interface RestrictedSourcePayloadRow {
  readonly id: string;
  readonly system: string;
  readonly sourceCollection: string;
  readonly sourceId: string;
  readonly sourceUpdatedAt?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly canonicalPayload: string;
  readonly checksumSha256: string;
  readonly importRunId: string;
  readonly importedAt?: string;
  /** Audit-only source location; not a replacement database column. */
  readonly sourceCollectionPath: string;
  readonly sourceOrdinal: number;
  readonly [key: string]: unknown;
}

export interface RestrictedParityCanary {
  envelope: ExportEnvelope;
  observation: RestrictedImportObservation;
  restrictedRows: readonly RestrictedSourcePayloadRow[];
  normalizedSnapshot: unknown;
  publicDto: unknown;
  adminDto: unknown;
  logSafeSummary: unknown;
  protectedField: string;
  protectedValue: string;
}

export interface RestrictedParityProjectionSet {
  normalizedSnapshot?: unknown;
  publicDto?: unknown;
  adminDto?: unknown;
  logSafeSummary?: unknown;
}

export interface RestrictedParityProtectedCanary {
  field: string;
  value: string;
}

export interface RestrictedParityInput {
  envelope: ExportEnvelope;
  restrictedRows: readonly RestrictedSourcePayloadRowLike[];
  observation?: RestrictedImportObservation;
  manifest?: RedactedExportManifest;
  projections?: RestrictedParityProjectionSet;
  protectedCanary?: RestrictedParityProtectedCanary;
  /** Registry paths supplied by the caller to preserve absent-vs-empty state. */
  requiredCollectionPaths?: readonly string[];
  /** Opt in when the retention policy treats arrays nested inside rows as rows. */
  includeNestedRows?: boolean;
  limits?: RestrictedParityLimits;
}

/**
 * Raw-value-free row summary for the full-archive streaming seam.  A source
 * reader yields these summaries from bounded chunks; the checker retains only
 * digests and source identities, never the canonical payload values.
 */
export interface RestrictedParityChunkRow {
  readonly system: string;
  readonly sourceCollection: string;
  readonly sourceId: string;
  readonly sourceUpdatedAt?: string;
  readonly canonicalPayload: string;
  readonly checksumSha256: string;
}

/** One bounded, ordered source collection chunk. Repeated paths are allowed. */
export interface RestrictedParitySourceChunk {
  /** Audited registry partition identity; endpoint paths may be shared. */
  readonly collectionName?: string;
  readonly path: string;
  readonly present: boolean;
  readonly rows: Iterable<RestrictedParityChunkRow>;
}

export interface RestrictedParityStreamLimits {
  maxChunkRows?: number;
  maxChunks?: number;
  maxTotalRows?: number;
  maxCanonicalBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxFindings?: number;
}

export const RESTRICTED_PARITY_STREAM_LIMITS = {
  maxChunkRows: 512,
  maxChunks: 16_384,
  maxTotalRows: 500_000,
  maxCanonicalBytes: RESTRICTED_PARITY_LIMITS.maxCanonicalBytes,
  maxDepth: RESTRICTED_PARITY_LIMITS.maxDepth,
  maxNodes: RESTRICTED_PARITY_LIMITS.maxNodes,
  maxFindings: RESTRICTED_PARITY_LIMITS.maxFindings,
} as const;

export interface RestrictedParityStreamInput {
  /** Supplied by the approved artifact/envelope control; no raw envelope is loaded. */
  sourceEnvelopeSha256: string;
  sourceRunId: string;
  sourceChunks: Iterable<RestrictedParitySourceChunk>;
  restrictedRows: Iterable<RestrictedSourcePayloadRowLike>;
  observation?: RestrictedImportObservation;
  expectedManifestSha256?: string;
  projections?: RestrictedParityProjectionSet;
  protectedCanary?: RestrictedParityProtectedCanary;
  limits?: RestrictedParityStreamLimits;
}

export interface RestrictedParityChunkObservationInput {
  sourceEnvelopeSha256: string;
  sourceRunId: string;
  importRunId: string;
  observedAt: string;
  sourceChunks: Iterable<RestrictedParitySourceChunk>;
  sourceManifestSha256?: string;
  limits?: RestrictedParityStreamLimits;
}

export interface RestrictedParityCollectionChecks {
  expectedCount: number;
  observedCount: number;
  missingObservationCount: number;
  unexpectedObservationCount: number;
  duplicateObservationCount: number;
  presenceMismatchCount: number;
  rowCountMismatchCount: number;
  orderedDigestMismatchCount: number;
  sourceIdentityDigestMismatchCount: number;
  collectionsDigestMismatch: boolean;
}

export interface RestrictedParityRowChecks {
  expectedCount: number;
  actualCount: number;
  missingCount: number;
  duplicateCount: number;
  unexpectedCount: number;
  alteredCount: number;
  conflictingSourceCount: number;
  invalidIdentityCount: number;
  invalidChecksumCount: number;
  importObservationMismatchCount: number;
}

export interface RestrictedParityProjectionChecks {
  canaryConfigured: boolean;
  protectedValueInRestrictedRows: boolean;
  normalizedSnapshotLeak: boolean;
  publicDtoLeak: boolean;
  adminDtoLeak: boolean;
  logSafeSummaryLeak: boolean;
}

/** Redacted report: no source IDs, payload values, paths, or arbitrary errors. */
export interface RestrictedParityReport {
  version: typeof RESTRICTED_PARITY_VERSION;
  passed: boolean;
  blockingReasons: string[];
  expectedEnvelopeSha256: string;
  observedEnvelopeSha256?: string;
  expectedManifestSha256?: string;
  observedManifestSha256?: string;
  expectedRowsSha256: string;
  observedRowsSha256?: string;
  expectedRestrictedRowsSha256: string;
  actualRestrictedRowsSha256: string;
  expectedCollectionsSha256: string;
  observedCollectionsSha256?: string;
  observationPresent: boolean;
  observationVersionValid: boolean;
  credentialShapedFieldCount: number;
  collectionChecks: RestrictedParityCollectionChecks;
  rowChecks: RestrictedParityRowChecks;
  projectionChecks: RestrictedParityProjectionChecks;
  /** The pure mapper freezes every emitted row and never mutates its input. */
  immutableMappingProven: true;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface Limits {
  maxDepth: number;
  maxNodes: number;
  maxCollections: number;
  maxRows: number;
  maxCanonicalBytes: number;
  maxFindings: number;
}

interface ExpectedRow {
  id: string;
  system: string;
  sourceCollection: string;
  sourceId: string;
  sourceUpdatedAt?: string;
  payload: JsonRecord;
  canonicalPayload: string;
  checksumSha256: string;
  sourceCollectionPath: string;
  sourceOrdinal: number;
  valid: boolean;
}

interface ExpectedCollection {
  path: string;
  present: boolean;
  rows: ExpectedRow[];
  orderedRowsSha256: string;
  sourceIdentityRowsSha256: string;
}

interface ExpectedEnvelope {
  rows: ExpectedRow[];
  collections: ExpectedCollection[];
  sourceEnvelopeSha256: string;
  sourceManifestSha256?: string;
  sourceRowsSha256: string;
  collectionsSha256: string;
  credentialShapedFieldCount: number;
}

interface ActualRow {
  id: string;
  system: string;
  sourceCollection: string;
  sourceId: string;
  sourceUpdatedAt?: string;
  payload: JsonRecord;
  canonicalPayload: string;
  checksumSha256: string;
  importRunId: string;
  importedAt?: string;
  valid: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function recordText(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const result = text(record[key]);
    if (result) return result;
  }
  return undefined;
}

function limitsFor(input: RestrictedParityLimits | undefined): Limits {
  const candidate = { ...RESTRICTED_PARITY_LIMITS, ...(input ?? {}) };
  const integer = (value: number, fallback: number): number => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return {
    maxDepth: integer(candidate.maxDepth, RESTRICTED_PARITY_LIMITS.maxDepth),
    maxNodes: integer(candidate.maxNodes, RESTRICTED_PARITY_LIMITS.maxNodes),
    maxCollections: integer(candidate.maxCollections, RESTRICTED_PARITY_LIMITS.maxCollections),
    maxRows: integer(candidate.maxRows, RESTRICTED_PARITY_LIMITS.maxRows),
    maxCanonicalBytes: integer(candidate.maxCanonicalBytes, RESTRICTED_PARITY_LIMITS.maxCanonicalBytes),
    maxFindings: integer(candidate.maxFindings, RESTRICTED_PARITY_LIMITS.maxFindings),
  };
}

function boundedWalk(value: unknown, limits: Limits, onKey?: (key: string) => void): string[] {
  const findings: string[] = [];
  const seen = new Set<unknown>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number, path: string): void => {
    if (findings.length >= limits.maxFindings) return;
    nodes += 1;
    if (nodes > limits.maxNodes) {
      findings.push("bounded_input_too_large");
      return;
    }
    if (depth > limits.maxDepth) {
      findings.push("bounded_input_too_deep");
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate)) {
      findings.push("bounded_input_cycle");
      return;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index += 1) visit(candidate[index], depth + 1, `${path}[${index}]`);
    } else {
      for (const [key, child] of Object.entries(candidate)) {
        onKey?.(key);
        visit(child, depth + 1, path ? `${path}.${key}` : key);
      }
    }
    seen.delete(candidate);
  };
  visit(value, 0, "");
  return findings;
}

function normalizedCredentialKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}

function isCredentialShapedKey(key: string): boolean {
  const normalized = normalizedCredentialKey(key).replace(/^_+|_+$/g, "");
  return /(?:^|_)(?:database_url|connection_string|password|secret|access_token|refresh_token|private_key|client_secret|api_key|authorization|bearer_token)(?:$|_)/i.test(normalized);
}

/** Returns field-name paths only; values are never returned. */
export function findCredentialShapedFields(value: unknown, limitsInput?: RestrictedParityLimits): readonly string[] {
  const limits = limitsFor(limitsInput);
  const findings: string[] = [];
  const seen = new Set<unknown>();
  let nodes = 0;
  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (findings.length >= limits.maxFindings) return;
    nodes += 1;
    if (nodes > limits.maxNodes || depth > limits.maxDepth) return;
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
    } else {
      for (const [key, child] of Object.entries(candidate)) {
        const childPath = path ? `${path}.${key}` : key;
        if (isCredentialShapedKey(key)) findings.push(childPath.slice(0, 200));
        visit(child, childPath, depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, "", 0);
  return findings;
}

function safeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  const raw = text(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function safeRequiredToken(value: unknown, reason: string): string {
  const result = text(value);
  if (!result || !SAFE_TOKEN.test(result)) throw new Error(reason);
  return result;
}

function canonicalEnvelope(value: ExportEnvelope): ExportEnvelope {
  const record = value as unknown as JsonRecord;
  return {
    version: "rm-export/v2",
    runId: String(record.runId ?? ""),
    source: record.source as ExportEnvelope["source"],
    createdAt: String(record.createdAt ?? ""),
    payload: (record.payload ?? {}) as ExportEnvelope["payload"],
    documentBinaries: Array.isArray(record.documentBinaries) ? record.documentBinaries as ExportEnvelope["documentBinaries"] : [],
  };
}

/** Exact envelope digest shape used by approved import artifacts. */
export function restrictedSourceEnvelopeSha256(value: ExportEnvelope): string {
  return sha256(canonicalJson(canonicalEnvelope(value)));
}

function manifestSha256(value: RedactedExportManifest | undefined): string | undefined {
  return value ? sha256(canonicalJson(value)) : undefined;
}

function digestStrings(values: readonly string[]): string {
  return sha256(JSON.stringify([...values]));
}

function rowIdentity(row: Pick<ExpectedRow, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): string {
  return [row.system, row.sourceCollection, row.sourceId, row.checksumSha256].map((part) => `${part.length}:${part}`).join("|");
}

function rowDigest(row: Pick<ExpectedRow, "system" | "sourceCollection" | "sourceId" | "checksumSha256" | "canonicalPayload">): string {
  return sha256(canonicalJson({ system: row.system, sourceCollection: row.sourceCollection, sourceId: row.sourceId, checksumSha256: row.checksumSha256, canonicalPayload: row.canonicalPayload }));
}

function emptyRowsDigest(): string {
  return digestStrings([]);
}

function collectionSummary(collection: Pick<ExpectedCollection, "path" | "present" | "rows" | "orderedRowsSha256" | "sourceIdentityRowsSha256">): Record<string, unknown> {
  return {
    path: collection.path,
    present: collection.present,
    rowCount: collection.rows.length,
    orderedRowsSha256: collection.orderedRowsSha256,
    sourceIdentityRowsSha256: collection.sourceIdentityRowsSha256,
  };
}

function collectionsDigest(collections: readonly ExpectedCollection[]): string {
  return sha256(canonicalJson(collections.map(collectionSummary)));
}

function sourceRowsDigest(rows: readonly ExpectedRow[]): string {
  return digestStrings(rows.map((row) => rowDigest(row)));
}

function sourceRowsSetDigest(rows: readonly ExpectedRow[]): string {
  return digestStrings(rows.map((row) => rowDigest(row)).sort());
}

function sourceIdentityRowsDigest(rows: readonly ExpectedRow[]): string {
  return digestStrings(rows.map((row) => rowIdentity(row)));
}

function orderedRowsDigest(rows: readonly ExpectedRow[]): string {
  return digestStrings(rows.map((row) => rowDigest(row)));
}

interface StreamLimits {
  maxChunkRows: number;
  maxChunks: number;
  maxTotalRows: number;
  maxCanonicalBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxFindings: number;
}

interface StreamRow {
  readonly id: string;
  readonly system: string;
  readonly sourceCollection: string;
  readonly sourceId: string;
  readonly sourceUpdatedAt?: string;
  readonly checksumSha256: string;
  readonly valid: boolean;
  readonly importRunId?: string;
  readonly credentialShapedFieldCount: number;
  readonly protectedFieldValuePresent: boolean;
  readonly rowDigest: string;
  readonly identity: string;
  readonly sourceKey: string;
}

interface StreamCollectionState {
  path: string;
  present: boolean;
  rowCount: number;
  rowDigests: string[];
  identityDigests: string[];
}

function streamLimitsFor(input: RestrictedParityStreamLimits | undefined): StreamLimits {
  const candidate = { ...RESTRICTED_PARITY_STREAM_LIMITS, ...(input ?? {}) };
  const integer = (value: number, fallback: number): number => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return {
    maxChunkRows: integer(candidate.maxChunkRows, RESTRICTED_PARITY_STREAM_LIMITS.maxChunkRows),
    maxChunks: integer(candidate.maxChunks, RESTRICTED_PARITY_STREAM_LIMITS.maxChunks),
    maxTotalRows: integer(candidate.maxTotalRows, RESTRICTED_PARITY_STREAM_LIMITS.maxTotalRows),
    maxCanonicalBytes: integer(candidate.maxCanonicalBytes, RESTRICTED_PARITY_STREAM_LIMITS.maxCanonicalBytes),
    maxDepth: integer(candidate.maxDepth, RESTRICTED_PARITY_STREAM_LIMITS.maxDepth),
    maxNodes: integer(candidate.maxNodes, RESTRICTED_PARITY_STREAM_LIMITS.maxNodes),
    maxFindings: integer(candidate.maxFindings, RESTRICTED_PARITY_STREAM_LIMITS.maxFindings),
  };
}

function streamCollectionDigest(state: StreamCollectionState): RestrictedCollectionObservation {
  return {
    path: state.path,
    present: state.present,
    rowCount: state.rowCount,
    orderedRowsSha256: digestStrings(state.rowDigests),
    sourceIdentityRowsSha256: digestStrings(state.identityDigests),
  };
}

function streamCollectionsDigest(states: readonly StreamCollectionState[]): string {
  return sha256(canonicalJson(states.map(streamCollectionDigest).sort((left, right) => left.path.localeCompare(right.path))));
}

function streamPayload(canonicalPayload: string, limits: StreamLimits): { payload: JsonRecord; valid: boolean; credentialShapedFieldCount: number } {
  if (Buffer.byteLength(canonicalPayload, "utf8") > limits.maxCanonicalBytes) {
    return { payload: {}, valid: false, credentialShapedFieldCount: 0 };
  }
  try {
    const parsed = JSON.parse(canonicalPayload) as unknown;
    const valid = isRecord(parsed) && canonicalJson(parsed) === canonicalPayload;
    return {
      payload: isRecord(parsed) ? parsed : {},
      valid,
      credentialShapedFieldCount: findCredentialShapedFields(parsed, limits).length,
    };
  } catch {
    return { payload: {}, valid: false, credentialShapedFieldCount: 0 };
  }
}

function streamExpectedRow(value: RestrictedParityChunkRow, limits: StreamLimits, protectedCanary?: RestrictedParityProtectedCanary): StreamRow {
  const system = text(value.system) ?? "";
  const sourceCollection = text(value.sourceCollection) ?? "";
  const sourceId = text(value.sourceId) ?? "";
  const canonicalPayload = typeof value.canonicalPayload === "string" ? value.canonicalPayload : "";
  const checksumSha256 = text(value.checksumSha256)?.toLowerCase() ?? "";
  const payloadState = streamPayload(canonicalPayload, limits);
  const sourceUpdatedAt = value.sourceUpdatedAt ? safeTimestamp(value.sourceUpdatedAt) : undefined;
  const validIdentity = Boolean(system && sourceCollection && sourceId && SAFE_TOKEN.test(system) && SAFE_TOKEN.test(sourceCollection) && SAFE_TOKEN.test(sourceId));
  const valid = validIdentity && SHA256.test(checksumSha256) && checksumSha256 === sha256(canonicalPayload) && payloadState.valid && (!value.sourceUpdatedAt || Boolean(sourceUpdatedAt));
  const identity = rowIdentity({ system, sourceCollection, sourceId, checksumSha256 });
  const sourceKey = sourceKeyFor({ system, sourceCollection, sourceId });
  return {
    system,
    sourceCollection,
    sourceId,
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    checksumSha256,
    id: `rm-payload:${sha256(`${system}\u0000${sourceCollection}\u0000${sourceId}\u0000${checksumSha256}`)}`,
    valid,
    credentialShapedFieldCount: payloadState.credentialShapedFieldCount,
    protectedFieldValuePresent: protectedCanary ? containsCanaryFieldValue(payloadState.payload, protectedCanary.field, protectedCanary.value, limits) : false,
    rowDigest: rowDigest({ system, sourceCollection, sourceId, checksumSha256, canonicalPayload }),
    identity,
    sourceKey,
  };
}

function streamActualRow(value: RestrictedSourcePayloadRowLike, limits: StreamLimits, protectedCanary?: RestrictedParityProtectedCanary): StreamRow {
  const record = value as JsonRecord;
  const canonicalPayloadValue = record.canonicalPayload;
  let canonicalPayload = typeof canonicalPayloadValue === "string" ? canonicalPayloadValue : "";
  if (!canonicalPayload && record.payload !== undefined) {
    try { canonicalPayload = canonicalJson(record.payload); } catch { canonicalPayload = ""; }
  }
  const summary = streamExpectedRow({
    system: recordText(record, "system") ?? "",
    sourceCollection: recordText(record, "sourceCollection", "source_collection") ?? "",
    sourceId: recordText(record, "sourceId", "source_id") ?? "",
    sourceUpdatedAt: recordText(record, "sourceUpdatedAt", "source_updated_at") ?? undefined,
    canonicalPayload,
    checksumSha256: recordText(record, "checksumSha256", "checksum_sha256") ?? "",
  }, limits, protectedCanary);
  const importRunId = recordText(record, "importRunId", "import_run_id");
  const id = recordText(record, "id") ?? "";
  return { ...summary, id, importRunId, valid: summary.valid && Boolean(importRunId) && Boolean(id) && id === summary.id };
}

function payloadRecord(value: ExportEnvelope): JsonRecord {
  const payload = (value as unknown as JsonRecord).payload;
  if (!isRecord(payload)) throw new Error("restricted_parity_payload_invalid");
  return payload;
}

function expectedRow(
  value: unknown,
  collectionName: string,
  collectionPath: string,
  ordinal: number,
  system: string,
  limits: Limits,
): ExpectedRow {
  if (!isRecord(value)) {
    throw new Error("restricted_parity_source_row_invalid");
  }
  const sourceCollection = recordText(value, "sourceCollection") ?? collectionName;
  const sourceId = recordText(value, "sourceId");
  const canonicalPayload = canonicalJson(value);
  if (canonicalPayload.length > limits.maxCanonicalBytes) throw new Error("restricted_parity_row_too_large");
  const checksumSha256 = sha256(canonicalPayload);
  // CreateDate must remain creation provenance in the canonical payload.  It
  // is not evidence that this source row was updated at import/observation.
  const sourceUpdatedAtValue = recordText(value, "sourceUpdatedAt", "updatedAt", "UpdateDate");
  const sourceUpdatedAt = sourceUpdatedAtValue ? safeTimestamp(sourceUpdatedAtValue) : undefined;
  const valid = Boolean(sourceCollection && sourceId && SAFE_TOKEN.test(sourceCollection) && SAFE_TOKEN.test(sourceId));
  const stableSourceCollection = sourceCollection || "";
  const stableSourceId = sourceId || "";
  return {
    id: `rm-payload:${sha256(`${system}\u0000${stableSourceCollection}\u0000${stableSourceId}\u0000${checksumSha256}`)}`,
    system,
    sourceCollection: stableSourceCollection,
    sourceId: stableSourceId,
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    payload: value,
    canonicalPayload,
    checksumSha256,
    sourceCollectionPath: collectionPath,
    sourceOrdinal: ordinal,
    valid,
  };
}

function nestedRows(
  value: JsonRecord,
  collectionPath: string,
  system: string,
  limits: Limits,
  rows: ExpectedRow[],
  collections: ExpectedCollection[],
): void {
  for (const [key, child] of Object.entries(value)) {
    if (!Array.isArray(child)) continue;
    const nestedCollectionRows: ExpectedRow[] = [];
    for (let index = 0; index < child.length; index += 1) {
      const candidate = child[index];
      if (!isRecord(candidate)) continue;
      const path = `${collectionPath}.${key}[${index}]`;
      const nestedRow = expectedRow(candidate, key, path, index, system, limits);
      nestedCollectionRows.push(nestedRow);
      rows.push(nestedRow);
      nestedRows(candidate, path, system, limits, rows, collections);
    }
    collections.push({
      path: `${collectionPath}.${key}`,
      present: true,
      rows: nestedCollectionRows,
      orderedRowsSha256: orderedRowsDigest(nestedCollectionRows),
      sourceIdentityRowsSha256: sourceIdentityRowsDigest(nestedCollectionRows),
    });
  }
}

function collectExpected(
  envelope: ExportEnvelope,
  options: { includeNestedRows?: boolean; requiredCollectionPaths?: readonly string[]; manifest?: RedactedExportManifest; limits: Limits },
): ExpectedEnvelope {
  const walkFindings = boundedWalk(envelope, options.limits);
  if (walkFindings.length > 0) throw new Error(walkFindings[0]);
  const sourceSystem = recordText((envelope as unknown as JsonRecord).source as JsonRecord, "system") ?? "rent_manager";
  const payload = payloadRecord(envelope);
  const collections: ExpectedCollection[] = [];
  const allRows: ExpectedRow[] = [];
  let collectionCount = 0;
  const pushCollection = (path: string, name: string, value: unknown[]): void => {
    collectionCount += 1;
    if (collectionCount > options.limits.maxCollections) throw new Error("restricted_parity_collection_limit");
    const rows: ExpectedRow[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const candidate = value[index];
      if (!isRecord(candidate)) throw new Error("restricted_parity_source_row_invalid");
      const row = expectedRow(candidate, name, path, index, sourceSystem, options.limits);
      rows.push(row);
      allRows.push(row);
      if (options.includeNestedRows) nestedRows(candidate, `${path}[${index}]`, sourceSystem, options.limits, allRows, collections);
    }
    collections.push({
      path,
      present: true,
      rows,
      orderedRowsSha256: orderedRowsDigest(rows),
      sourceIdentityRowsSha256: sourceIdentityRowsDigest(rows),
    });
    if (collections.length > options.limits.maxCollections) throw new Error("restricted_parity_collection_limit");
  };
  for (const [name, value] of Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))) {
    if (Array.isArray(value)) pushCollection(`payload.${name}`, name, value);
  }
  const envelopeRecord = envelope as unknown as JsonRecord;
  if (Array.isArray(envelopeRecord.documentBinaries) && !Array.isArray(payload.documentBinaries)) {
    pushCollection("envelope.documentBinaries", "documentBinaries", envelopeRecord.documentBinaries);
  }
  const requiredPaths = new Set(options.requiredCollectionPaths ?? []);
  requiredPaths.forEach((path) => {
    if (!SAFE_TOKEN.test(path) && !/^[-A-Za-z0-9_.[\]]+$/.test(path)) throw new Error("restricted_parity_collection_path_invalid");
    if (collections.some((collection) => collection.path === path)) return;
    collections.push({ path, present: false, rows: [], orderedRowsSha256: emptyRowsDigest(), sourceIdentityRowsSha256: emptyRowsDigest() });
  });
  collections.sort((left, right) => left.path.localeCompare(right.path));
  if (allRows.length > options.limits.maxRows) throw new Error("restricted_parity_row_limit");
  const credentialShapedFieldCount = findCredentialShapedFields(envelope, options.limits).length;
  return {
    rows: allRows,
    collections,
    sourceEnvelopeSha256: restrictedSourceEnvelopeSha256(envelope),
    ...(options.manifest ? { sourceManifestSha256: manifestSha256(options.manifest) } : {}),
    sourceRowsSha256: sourceRowsDigest(allRows),
    collectionsSha256: collectionsDigest(collections),
    credentialShapedFieldCount,
  };
}

function assertExpectedBuildable(expected: ExpectedEnvelope): void {
  if (expected.credentialShapedFieldCount > 0) throw new Error("restricted_parity_credential_field");
  const invalid = expected.rows.find((row) => !row.valid);
  if (invalid) throw new Error("restricted_parity_source_identity_missing");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach((child) => deepFreeze(child));
  else Object.values(value as JsonRecord).forEach((child) => deepFreeze(child));
  return Object.freeze(value);
}

function buildExpectedRows(expected: ExpectedEnvelope, importRunId: string, importedAt?: string): RestrictedSourcePayloadRow[] {
  assertExpectedBuildable(expected);
  return expected.rows.map((row) => deepFreeze({
    id: row.id,
    system: row.system,
    sourceCollection: row.sourceCollection,
    sourceId: row.sourceId,
    ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}),
    payload: deepFreeze(structuredClone(row.payload)),
    canonicalPayload: row.canonicalPayload,
    checksumSha256: row.checksumSha256,
    importRunId,
    ...(importedAt ? { importedAt } : {}),
    sourceCollectionPath: row.sourceCollectionPath,
    sourceOrdinal: row.sourceOrdinal,
  }));
}

function observationFor(
  expected: ExpectedEnvelope,
  options: { importRunId: string; observedAt: string },
): RestrictedImportObservation {
  const importRunId = safeRequiredToken(options.importRunId, "restricted_parity_import_run_invalid");
  const observedAt = safeTimestamp(options.observedAt);
  if (!observedAt || !ISO_TIMESTAMP.test(observedAt)) throw new Error("restricted_parity_observed_at_invalid");
  return deepFreeze({
    version: RESTRICTED_PARITY_VERSION,
    source: "rent_manager",
    sourceRunId: "",
    importRunId,
    observedAt,
    sourceEnvelopeSha256: expected.sourceEnvelopeSha256,
    ...(expected.sourceManifestSha256 ? { sourceManifestSha256: expected.sourceManifestSha256 } : {}),
    sourceRowsSha256: expected.sourceRowsSha256,
    collectionsSha256: expected.collectionsSha256,
    collections: expected.collections.map((collection) => ({
      path: collection.path,
      present: collection.present,
      rowCount: collection.rows.length,
      orderedRowsSha256: collection.orderedRowsSha256,
      sourceIdentityRowsSha256: collection.sourceIdentityRowsSha256,
    })),
  });
}

/**
 * Creates frozen restricted rows from the exact source envelope.  It is an
 * in-memory test/integration seam, not a replacement for the current writer.
 */
export function mapRestrictedEnvelopeToRows(
  envelope: ExportEnvelope,
  options: { importRunId: string; importedAt?: string; includeNestedRows?: boolean; requiredCollectionPaths?: readonly string[]; limits?: RestrictedParityLimits } = { importRunId: "" },
): readonly RestrictedSourcePayloadRow[] {
  const expected = collectExpected(envelope, {
    includeNestedRows: options.includeNestedRows,
    requiredCollectionPaths: options.requiredCollectionPaths,
    limits: limitsFor(options.limits),
  });
  return buildExpectedRows(expected, safeRequiredToken(options.importRunId, "restricted_parity_import_run_invalid"), options.importedAt);
}

/** Builds the minimal order/presence/full-envelope evidence record. */
export function createRestrictedImportObservation(
  envelope: ExportEnvelope,
  options: { importRunId: string; observedAt: string; manifest?: RedactedExportManifest; includeNestedRows?: boolean; requiredCollectionPaths?: readonly string[]; limits?: RestrictedParityLimits },
): RestrictedImportObservation {
  const expected = collectExpected(envelope, {
    includeNestedRows: options.includeNestedRows,
    requiredCollectionPaths: options.requiredCollectionPaths,
    manifest: options.manifest,
    limits: limitsFor(options.limits),
  });
  const observation = observationFor(expected, options);
  return deepFreeze({ ...observation, sourceRunId: safeRequiredToken((envelope as unknown as JsonRecord).runId, "restricted_parity_source_run_invalid") });
}

interface StreamSourceScan {
  states: Map<string, StreamCollectionState>;
  sourceRowDigests: string[];
  expectedByVersion: Map<string, { row: StreamRow; count: number }>;
  totalRows: number;
  chunkCount: number;
  credentialShapedFieldCount: number;
  protectedValueInSourceRows: boolean;
}

interface StreamRestrictedScan {
  actualByVersion: Map<string, { row: StreamRow; count: number }>;
  actualBySource: Map<string, Set<string>>;
  rowDigests: string[];
  totalRows: number;
  credentialShapedFieldCount: number;
  protectedValueInRestrictedRows: boolean;
  invalidIdentityCount: number;
  invalidChecksumCount: number;
  importObservationMismatchCount: number;
}

function emptyStreamSourceScan(): StreamSourceScan {
  return {
    states: new Map(),
    sourceRowDigests: [],
    expectedByVersion: new Map(),
    totalRows: 0,
    chunkCount: 0,
    credentialShapedFieldCount: 0,
    protectedValueInSourceRows: false,
  };
}

function emptyStreamRestrictedScan(): StreamRestrictedScan {
  return {
    actualByVersion: new Map(),
    actualBySource: new Map(),
    rowDigests: [],
    totalRows: 0,
    credentialShapedFieldCount: 0,
    protectedValueInRestrictedRows: false,
    invalidIdentityCount: 0,
    invalidChecksumCount: 0,
    importObservationMismatchCount: 0,
  };
}

function scanRestrictedSourceChunks(
  chunks: Iterable<RestrictedParitySourceChunk>,
  limits: StreamLimits,
  reasons: Set<string>,
  protectedCanary?: RestrictedParityProtectedCanary,
): StreamSourceScan {
  const scan = emptyStreamSourceScan();
  const chunkIterator = chunks[Symbol.iterator]();
  let chunkNext = chunkIterator.next();
  while (!chunkNext.done) {
    const chunk = chunkNext.value;
    scan.chunkCount += 1;
    if (scan.chunkCount > limits.maxChunks) throw new Error("restricted_parity_stream_chunk_limit");
    const path = text(chunk.path) ?? "";
    if (!path || !SAFE_TOKEN.test(path)) {
      reasons.add("stream_collection_path_invalid");
      continue;
    }
    let state = scan.states.get(path);
    if (!state) {
      state = { path, present: chunk.present === true, rowCount: 0, rowDigests: [], identityDigests: [] };
      scan.states.set(path, state);
    } else if (state.present !== (chunk.present === true)) {
      reasons.add("stream_collection_presence_conflict");
    }
    let chunkRows = 0;
    const rowIterator = chunk.rows[Symbol.iterator]();
    let rowNext = rowIterator.next();
    while (!rowNext.done) {
      const candidate = rowNext.value;
      chunkRows += 1;
      if (chunkRows > limits.maxChunkRows) throw new Error("restricted_parity_stream_chunk_limit");
      scan.totalRows += 1;
      if (scan.totalRows > limits.maxTotalRows) throw new Error("restricted_parity_stream_row_limit");
      const row = streamExpectedRow(candidate, limits, protectedCanary);
      state.rowCount += 1;
      state.rowDigests.push(row.rowDigest);
      state.identityDigests.push(row.identity);
      scan.sourceRowDigests.push(row.rowDigest);
      scan.credentialShapedFieldCount += row.credentialShapedFieldCount;
      scan.protectedValueInSourceRows ||= row.protectedFieldValuePresent;
      if (row.credentialShapedFieldCount > 0) reasons.add("credential_shaped_field_detected");
      if (!row.valid) reasons.add("source_chunk_row_invalid");
      if (!chunk.present) reasons.add("absent_collection_contains_rows");
      const prior = scan.expectedByVersion.get(row.identity);
      if (prior) prior.count += 1;
      else scan.expectedByVersion.set(row.identity, { row, count: 1 });
      rowNext = rowIterator.next();
    }
    chunkNext = chunkIterator.next();
  }
  return scan;
}

function scanRestrictedRows(
  rows: Iterable<RestrictedSourcePayloadRowLike>,
  limits: StreamLimits,
  importRunId: string | undefined,
  reasons: Set<string>,
  protectedCanary?: RestrictedParityProtectedCanary,
): StreamRestrictedScan {
  const scan = emptyStreamRestrictedScan();
  const rowIterator = rows[Symbol.iterator]();
  let rowNext = rowIterator.next();
  while (!rowNext.done) {
    const candidate = rowNext.value;
    scan.totalRows += 1;
    if (scan.totalRows > limits.maxTotalRows) throw new Error("restricted_parity_stream_row_limit");
    const row = streamActualRow(candidate, limits, protectedCanary);
    scan.rowDigests.push(row.rowDigest);
    scan.credentialShapedFieldCount += row.credentialShapedFieldCount;
    scan.protectedValueInRestrictedRows ||= row.protectedFieldValuePresent;
    if (row.credentialShapedFieldCount > 0) reasons.add("credential_shaped_field_detected");
    if (!row.valid) reasons.add("restricted_row_shape_or_digest_invalid");
    if (!row.system || !row.sourceCollection || !row.sourceId || !row.id || !row.importRunId) scan.invalidIdentityCount += 1;
    if (!SHA256.test(row.checksumSha256)) scan.invalidChecksumCount += 1;
    if (importRunId && row.importRunId !== importRunId) scan.importObservationMismatchCount += 1;
    const prior = scan.actualByVersion.get(row.identity);
    if (prior) prior.count += 1;
    else scan.actualByVersion.set(row.identity, { row, count: 1 });
    const checksums = scan.actualBySource.get(row.sourceKey) ?? new Set<string>();
    checksums.add(row.checksumSha256);
    scan.actualBySource.set(row.sourceKey, checksums);
    rowNext = rowIterator.next();
  }
  return scan;
}

function streamCollectionStatesWithObservation(
  sourceStates: Map<string, StreamCollectionState>,
  observation: RestrictedImportObservation | undefined,
): StreamCollectionState[] {
  const states = new Map(sourceStates);
  for (const collection of observation?.collections ?? []) {
    if (!states.has(collection.path)) states.set(collection.path, {
      path: collection.path,
      present: false,
      rowCount: 0,
      rowDigests: [],
      identityDigests: [],
    });
  }
  return Array.from(states.values()).sort((left, right) => left.path.localeCompare(right.path));
}

/** Builds an observation while consuming bounded source chunks, without retaining payloads. */
export function createRestrictedImportObservationFromChunks(
  input: RestrictedParityChunkObservationInput,
): RestrictedImportObservation {
  const limits = streamLimitsFor(input.limits);
  const sourceEnvelopeSha256 = safeRequiredToken(input.sourceEnvelopeSha256, "restricted_parity_source_envelope_invalid");
  if (!SHA256.test(sourceEnvelopeSha256)) throw new Error("restricted_parity_source_envelope_invalid");
  const sourceRunId = safeRequiredToken(input.sourceRunId, "restricted_parity_source_run_invalid");
  const importRunId = safeRequiredToken(input.importRunId, "restricted_parity_import_run_invalid");
  const observedAt = safeTimestamp(input.observedAt);
  if (!observedAt || !ISO_TIMESTAMP.test(observedAt)) throw new Error("restricted_parity_observed_at_invalid");
  if (input.sourceManifestSha256 !== undefined && !SHA256.test(input.sourceManifestSha256)) throw new Error("restricted_parity_source_manifest_invalid");
  const reasons = new Set<string>();
  const source = scanRestrictedSourceChunks(input.sourceChunks, limits, reasons);
  if (reasons.size > 0) throw new Error(Array.from(reasons)[0]);
  const collections = Array.from(source.states.values()).map(streamCollectionDigest).sort((left, right) => left.path.localeCompare(right.path));
  return deepFreeze({
    version: RESTRICTED_PARITY_VERSION,
    source: "rent_manager",
    sourceRunId,
    importRunId,
    observedAt,
    sourceEnvelopeSha256,
    ...(input.sourceManifestSha256 ? { sourceManifestSha256: input.sourceManifestSha256 } : {}),
    sourceRowsSha256: digestStrings(source.sourceRowDigests),
    collectionsSha256: sha256(canonicalJson(collections)),
    collections,
  });
}

/**
 * Full-archive parity over replayable bounded chunks.  Only row digests,
 * source identities, and bounded counters survive each iterator step, so a
 * 100MB archive is not duplicated in this checker and the canary limits stay
 * unchanged for the object-envelope audit above.
 */
export function auditRestrictedSourceParityChunks(input: RestrictedParityStreamInput): RestrictedParityReport {
  const limits = streamLimitsFor(input.limits);
  const reasons = new Set<string>();
  const expectedSource = emptyStreamSourceScan();
  const actual = emptyStreamRestrictedScan();
  const sourceEnvelopeSha256 = text(input.sourceEnvelopeSha256) ?? "";
  const sourceRunId = text(input.sourceRunId) ?? "";
  if (!SHA256.test(sourceEnvelopeSha256)) reasons.add("source_envelope_digest_invalid");
  if (!sourceRunId || !SAFE_TOKEN.test(sourceRunId)) reasons.add("source_run_invalid");
  if (input.expectedManifestSha256 !== undefined && !SHA256.test(input.expectedManifestSha256)) reasons.add("source_manifest_digest_invalid");
  let sourceScan = expectedSource;
  let actualScan = actual;
  try {
    sourceScan = scanRestrictedSourceChunks(input.sourceChunks, limits, reasons, input.protectedCanary);
    actualScan = scanRestrictedRows(input.restrictedRows, limits, input.observation?.importRunId, reasons, input.protectedCanary);
  } catch (error) {
    reasons.add(error instanceof Error ? safeReason(error.message) : "restricted_parity_stream_invalid");
  }

  const sourceRowsSha256 = digestStrings(sourceScan.sourceRowDigests);
  const expectedRestrictedRowsSha256 = digestStrings([...sourceScan.sourceRowDigests].sort());
  const actualRestrictedRowsSha256 = digestStrings([...actualScan.rowDigests].sort());
  if (sourceScan.credentialShapedFieldCount > 0 || actualScan.credentialShapedFieldCount > 0) reasons.add("credential_shaped_field_detected");
  if (actualRestrictedRowsSha256 !== expectedRestrictedRowsSha256) reasons.add("restricted_rows_digest_mismatch");
  if (actualScan.totalRows !== sourceScan.totalRows) reasons.add("restricted_row_count_mismatch");

  const duplicateExpectedCount = Array.from(sourceScan.expectedByVersion.values()).reduce((sum, entry) => sum + Math.max(0, entry.count - 1), 0);
  const duplicateActualCount = Array.from(actualScan.actualByVersion.values()).reduce((sum, entry) => sum + Math.max(0, entry.count - 1), 0);
  const conflictingSourceCount = Array.from(actualScan.actualBySource.values()).filter((checksums) => checksums.size > 1).length;
  if (duplicateExpectedCount > 0) reasons.add("source_row_duplicate");
  if (duplicateActualCount > 0) reasons.add("restricted_row_duplicate");
  if (conflictingSourceCount > 0) reasons.add("restricted_source_version_conflict");
  if (actualScan.invalidIdentityCount > 0) reasons.add("restricted_row_identity_invalid");
  if (actualScan.invalidChecksumCount > 0) reasons.add("restricted_row_checksum_invalid");

  let missingCount = 0;
  let unexpectedCount = 0;
  let alteredCount = 0;
  sourceScan.expectedByVersion.forEach((entry, key) => {
    const actualEntry = actualScan.actualByVersion.get(key);
    if (!actualEntry) {
      missingCount += entry.count;
      if (actualScan.actualBySource.has(entry.row.sourceKey)) alteredCount += 1;
      return;
    }
    if (actualEntry.row.id !== entry.row.id || actualEntry.row.system !== entry.row.system || actualEntry.row.sourceCollection !== entry.row.sourceCollection || actualEntry.row.sourceId !== entry.row.sourceId || actualEntry.row.sourceUpdatedAt !== entry.row.sourceUpdatedAt || actualEntry.row.checksumSha256 !== entry.row.checksumSha256 || actualEntry.row.importRunId !== input.observation?.importRunId || actualEntry.row.rowDigest !== entry.row.rowDigest) alteredCount += 1;
  });
  actualScan.actualByVersion.forEach((entry, key) => {
    if (!sourceScan.expectedByVersion.has(key)) unexpectedCount += entry.count;
  });
  if (missingCount > 0) reasons.add("restricted_row_missing");
  if (unexpectedCount > 0) reasons.add("restricted_row_unexpected");
  if (alteredCount > 0) reasons.add("restricted_row_altered");

  const observation = input.observation;
  let observationVersionValid = false;
  const sourceStates = streamCollectionStatesWithObservation(sourceScan.states, observation);
  const collectionChecks: RestrictedParityCollectionChecks = {
    expectedCount: sourceStates.length,
    observedCount: observation?.collections?.length ?? 0,
    missingObservationCount: 0,
    unexpectedObservationCount: 0,
    duplicateObservationCount: 0,
    presenceMismatchCount: 0,
    rowCountMismatchCount: 0,
    orderedDigestMismatchCount: 0,
    sourceIdentityDigestMismatchCount: 0,
    collectionsDigestMismatch: false,
  };
  const expectedCollectionsSha256 = streamCollectionsDigest(sourceStates);
  if (!observation) {
    reasons.add("import_observation_missing");
  } else {
    observationVersionValid = observation.version === RESTRICTED_PARITY_VERSION && observation.source === "rent_manager" && Boolean(observation.sourceRunId) && Boolean(observation.importRunId) && Boolean(safeTimestamp(observation.observedAt));
    if (!observationVersionValid) reasons.add("import_observation_invalid");
    if (observation.sourceRunId !== sourceRunId) reasons.add("source_run_observation_mismatch");
    if (observation.sourceEnvelopeSha256 !== sourceEnvelopeSha256) reasons.add("source_envelope_digest_mismatch");
    if (input.expectedManifestSha256 !== undefined && observation.sourceManifestSha256 !== input.expectedManifestSha256) reasons.add("source_manifest_digest_mismatch");
    if (observation.sourceRowsSha256 !== sourceRowsSha256) reasons.add("source_rows_digest_mismatch");
    if (observation.collectionsSha256 !== expectedCollectionsSha256) {
      collectionChecks.collectionsDigestMismatch = true;
      reasons.add("source_collections_digest_mismatch");
    }
    const observedByPath = new Map<string, RestrictedCollectionObservation>();
    for (const collection of observation.collections ?? []) {
      if (observedByPath.has(collection.path)) collectionChecks.duplicateObservationCount += 1;
      else observedByPath.set(collection.path, collection);
    }
    for (const state of sourceStates) {
      const observedCollection = observedByPath.get(state.path);
      if (!observedCollection) {
        collectionChecks.missingObservationCount += 1;
        continue;
      }
      const expectedCollection = streamCollectionDigest(state);
      if (observedCollection.present !== expectedCollection.present) collectionChecks.presenceMismatchCount += 1;
      if (observedCollection.rowCount !== expectedCollection.rowCount) collectionChecks.rowCountMismatchCount += 1;
      if (!SHA256.test(observedCollection.orderedRowsSha256) || observedCollection.orderedRowsSha256 !== expectedCollection.orderedRowsSha256) collectionChecks.orderedDigestMismatchCount += 1;
      if (!SHA256.test(observedCollection.sourceIdentityRowsSha256) || observedCollection.sourceIdentityRowsSha256 !== expectedCollection.sourceIdentityRowsSha256) collectionChecks.sourceIdentityDigestMismatchCount += 1;
    }
    Array.from(observedByPath.keys()).forEach((path) => { if (!sourceStates.some((state) => state.path === path)) collectionChecks.unexpectedObservationCount += 1; });
    if (collectionChecks.missingObservationCount > 0) reasons.add("collection_observation_missing");
    if (collectionChecks.unexpectedObservationCount > 0) reasons.add("collection_observation_unexpected");
    if (collectionChecks.duplicateObservationCount > 0) reasons.add("collection_observation_duplicate");
    if (collectionChecks.presenceMismatchCount > 0) reasons.add("collection_presence_mismatch");
    if (collectionChecks.rowCountMismatchCount > 0) reasons.add("collection_row_count_mismatch");
    if (collectionChecks.orderedDigestMismatchCount > 0) reasons.add("collection_order_digest_mismatch");
    if (collectionChecks.sourceIdentityDigestMismatchCount > 0) reasons.add("collection_identity_digest_mismatch");
  }
  if (sourceStates.some((state) => !sourceScan.states.has(state.path))) reasons.add("source_collection_chunk_missing");
  if (Array.from(sourceScan.states.keys()).some((path) => !(observation?.collections ?? []).some((collection) => collection.path === path))) reasons.add("source_collection_observation_missing");

  const projectionChecks: RestrictedParityProjectionChecks = {
    canaryConfigured: Boolean(input.protectedCanary),
    protectedValueInRestrictedRows: input.protectedCanary ? actualScan.protectedValueInRestrictedRows : false,
    normalizedSnapshotLeak: input.protectedCanary ? containsCanaryValue(input.projections?.normalizedSnapshot, input.protectedCanary.value, limits) : false,
    publicDtoLeak: input.protectedCanary ? containsCanaryValue(input.projections?.publicDto, input.protectedCanary.value, limits) : false,
    adminDtoLeak: input.protectedCanary ? containsCanaryValue(input.projections?.adminDto, input.protectedCanary.value, limits) : false,
    logSafeSummaryLeak: input.protectedCanary ? containsCanaryValue(input.projections?.logSafeSummary, input.protectedCanary.value, limits) : false,
  };
  if (input.protectedCanary && !projectionChecks.protectedValueInRestrictedRows) reasons.add("protected_canary_missing_from_restricted_rows");
  if (projectionChecks.normalizedSnapshotLeak) reasons.add("protected_canary_leaked_to_normalized_snapshot");
  if (projectionChecks.publicDtoLeak) reasons.add("protected_canary_leaked_to_public_dto");
  if (projectionChecks.adminDtoLeak) reasons.add("protected_canary_leaked_to_admin_dto");
  if (projectionChecks.logSafeSummaryLeak) reasons.add("protected_canary_leaked_to_log_safe_summary");
  for (const projection of [input.projections?.normalizedSnapshot, input.projections?.publicDto, input.projections?.adminDto, input.projections?.logSafeSummary]) {
    if (findCredentialShapedFields(projection, limits).length > 0) reasons.add("credential_shaped_field_detected");
  }

  const sortedReasons = Array.from(reasons).map(safeReason).slice(0, limits.maxFindings).sort();
  return {
    version: RESTRICTED_PARITY_VERSION,
    passed: sortedReasons.length === 0,
    blockingReasons: sortedReasons,
    expectedEnvelopeSha256: sourceEnvelopeSha256,
    ...(observation?.sourceEnvelopeSha256 ? { observedEnvelopeSha256: observation.sourceEnvelopeSha256 } : {}),
    ...(input.expectedManifestSha256 ? { expectedManifestSha256: input.expectedManifestSha256 } : {}),
    ...(observation?.sourceManifestSha256 ? { observedManifestSha256: observation.sourceManifestSha256 } : {}),
    expectedRowsSha256: sourceRowsSha256,
    ...(observation?.sourceRowsSha256 ? { observedRowsSha256: observation.sourceRowsSha256 } : {}),
    expectedRestrictedRowsSha256,
    actualRestrictedRowsSha256,
    expectedCollectionsSha256,
    ...(observation?.collectionsSha256 ? { observedCollectionsSha256: observation.collectionsSha256 } : {}),
    observationPresent: Boolean(observation),
    observationVersionValid,
    credentialShapedFieldCount: sourceScan.credentialShapedFieldCount + actualScan.credentialShapedFieldCount,
    collectionChecks,
    rowChecks: {
      expectedCount: sourceScan.totalRows,
      actualCount: actualScan.totalRows,
      missingCount,
      duplicateCount: duplicateExpectedCount + duplicateActualCount,
      unexpectedCount,
      alteredCount,
      conflictingSourceCount,
      invalidIdentityCount: actualScan.invalidIdentityCount,
      invalidChecksumCount: actualScan.invalidChecksumCount,
      importObservationMismatchCount: actualScan.importObservationMismatchCount,
    },
    projectionChecks,
    immutableMappingProven: true,
  };
}

function actualRow(value: RestrictedSourcePayloadRowLike): ActualRow {
  const record = value as JsonRecord;
  const system = recordText(record, "system") ?? "";
  const sourceCollection = recordText(record, "sourceCollection", "source_collection") ?? "";
  const sourceId = recordText(record, "sourceId", "source_id") ?? "";
  const importRunId = recordText(record, "importRunId", "import_run_id") ?? "";
  const id = recordText(record, "id") ?? "";
  const checksumSha256 = (recordText(record, "checksumSha256", "checksum_sha256") ?? "").toLowerCase();
  const payloadInput = record.payload ?? record.canonicalPayload;
  let payload: JsonRecord = {};
  let canonicalPayload = "";
  let valid = true;
  try {
    payload = typeof payloadInput === "string" ? JSON.parse(payloadInput) as JsonRecord : structuredClone(payloadInput) as JsonRecord;
    if (!isRecord(payload)) valid = false;
    canonicalPayload = canonicalJson(payload);
    if (typeof record.canonicalPayload === "string" && record.canonicalPayload !== canonicalPayload) valid = false;
  } catch {
    valid = false;
  }
  if (!sourceCollection || !sourceId || !system || !importRunId || !id || !SHA256.test(checksumSha256) || checksumSha256 !== sha256(canonicalPayload)) valid = false;
  const sourceUpdatedAt = safeTimestamp(record.sourceUpdatedAt ?? record.source_updated_at);
  const importedAt = safeTimestamp(record.importedAt ?? record.imported_at);
  return { id, system, sourceCollection, sourceId, ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}), payload, canonicalPayload, checksumSha256, importRunId, ...(importedAt ? { importedAt } : {}), valid };
}

function keyFor(row: Pick<ActualRow, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): string {
  return rowIdentity(row);
}

function sourceKeyFor(row: Pick<ActualRow, "system" | "sourceCollection" | "sourceId">): string {
  return [row.system, row.sourceCollection, row.sourceId].map((part) => `${part.length}:${part}`).join("|");
}

function safeReason(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) || "restricted_parity_failed";
}

function containsCanaryValue(value: unknown, target: string, limits: Pick<Limits, "maxDepth" | "maxNodes">): boolean {
  let found = false;
  const seen = new Set<unknown>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (found || nodes >= limits.maxNodes || depth > limits.maxDepth) return;
    nodes += 1;
    if (typeof candidate === "string") {
      if (candidate === target || candidate.includes(target)) found = true;
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) candidate.forEach((child) => visit(child, depth + 1));
    else for (const child of Object.values(candidate)) visit(child, depth + 1);
    seen.delete(candidate);
  };
  visit(value, 0);
  return found;
}

function containsCanaryFieldValue(value: unknown, field: string, target: string, limits: Pick<Limits, "maxDepth" | "maxNodes">): boolean {
  let found = false;
  const seen = new Set<unknown>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (found || nodes >= limits.maxNodes || depth > limits.maxDepth) return;
    nodes += 1;
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) candidate.forEach((child) => visit(child, depth + 1));
    else for (const [key, child] of Object.entries(candidate)) {
      if (key === field && child === target) found = true;
      visit(child, depth + 1);
    }
    seen.delete(candidate);
  };
  visit(value, 0);
  return found;
}

function normalizeObservation(value: RestrictedImportObservation | undefined): RestrictedImportObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value;
}

/**
 * Pure parity audit.  Results contain only counts, reason codes, and digests.
 * Missing observation is blocking by design: restricted rows by themselves
 * cannot prove collection order, empty-vs-absent state, or atomic envelope
 * provenance.
 */
export function auditRestrictedSourceParity(input: RestrictedParityInput): RestrictedParityReport {
  const limits = limitsFor(input.limits);
  const reasons = new Set<string>();
  let expected: ExpectedEnvelope;
  try {
    expected = collectExpected(input.envelope, {
      includeNestedRows: input.includeNestedRows,
      requiredCollectionPaths: input.requiredCollectionPaths,
      manifest: input.manifest,
      limits,
    });
  } catch (error) {
    const reason = error instanceof Error ? safeReason(error.message) : "restricted_parity_input_invalid";
    reasons.add(reason);
    const empty = emptyRowsDigest();
    return {
      version: RESTRICTED_PARITY_VERSION,
      passed: false,
      blockingReasons: Array.from(reasons),
      expectedEnvelopeSha256: "".padStart(64, "0"),
      expectedRowsSha256: empty,
      expectedRestrictedRowsSha256: empty,
      actualRestrictedRowsSha256: empty,
      expectedCollectionsSha256: empty,
      observationPresent: false,
      observationVersionValid: false,
      credentialShapedFieldCount: findCredentialShapedFields(input.envelope, limits).length,
      collectionChecks: { expectedCount: 0, observedCount: 0, missingObservationCount: 0, unexpectedObservationCount: 0, duplicateObservationCount: 0, presenceMismatchCount: 0, rowCountMismatchCount: 0, orderedDigestMismatchCount: 0, sourceIdentityDigestMismatchCount: 0, collectionsDigestMismatch: false },
      rowChecks: { expectedCount: 0, actualCount: input.restrictedRows.length, missingCount: 0, duplicateCount: 0, unexpectedCount: 0, alteredCount: 0, conflictingSourceCount: 0, invalidIdentityCount: 0, invalidChecksumCount: 0, importObservationMismatchCount: 0 },
      projectionChecks: { canaryConfigured: false, protectedValueInRestrictedRows: false, normalizedSnapshotLeak: false, publicDtoLeak: false, adminDtoLeak: false, logSafeSummaryLeak: false },
      immutableMappingProven: true,
    };
  }
  if (expected.credentialShapedFieldCount > 0) reasons.add("credential_shaped_field_detected");

  const actual = input.restrictedRows.map((row) => actualRow(row));
  const actualByVersion = new Map<string, ActualRow>();
  const actualVersionCounts = new Map<string, number>();
  const actualBySource = new Map<string, Set<string>>();
  let invalidIdentityCount = 0;
  let invalidChecksumCount = 0;
  let importObservationMismatchCount = 0;
  for (const row of actual) {
    if (!row.system || !row.sourceCollection || !row.sourceId || !row.id || !row.importRunId) invalidIdentityCount += 1;
    if (!SHA256.test(row.checksumSha256)) invalidChecksumCount += 1;
    if (!row.valid) reasons.add("restricted_row_shape_or_digest_invalid");
    const versionKey = keyFor(row);
    actualVersionCounts.set(versionKey, (actualVersionCounts.get(versionKey) ?? 0) + 1);
    actualByVersion.set(versionKey, actualByVersion.get(versionKey) ?? row);
    const sourceKey = sourceKeyFor(row);
    const checksums = actualBySource.get(sourceKey) ?? new Set<string>();
    checksums.add(row.checksumSha256);
    actualBySource.set(sourceKey, checksums);
    if (findCredentialShapedFields(row, limits).length > 0) reasons.add("credential_shaped_field_detected");
  }
  const duplicateCount = Array.from(actualVersionCounts.values()).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const conflictingSourceCount = Array.from(actualBySource.values()).filter((checksums) => checksums.size > 1).length;
  if (duplicateCount > 0) reasons.add("restricted_row_duplicate");
  if (conflictingSourceCount > 0) reasons.add("restricted_source_version_conflict");
  if (invalidIdentityCount > 0) reasons.add("restricted_row_identity_invalid");
  if (invalidChecksumCount > 0) reasons.add("restricted_row_checksum_invalid");

  const expectedByVersion = new Map<string, ExpectedRow>();
  let duplicateExpectedCount = 0;
  for (const row of expected.rows) {
    if (!row.valid) {
      reasons.add("source_row_identity_invalid");
      continue;
    }
    const key = keyFor(row);
    if (expectedByVersion.has(key)) duplicateExpectedCount += 1;
    else expectedByVersion.set(key, row);
  }
  if (duplicateExpectedCount > 0) reasons.add("source_row_duplicate");
  let missingCount = 0;
  let unexpectedCount = 0;
  let alteredCount = 0;
  expectedByVersion.forEach((row, key) => {
    const actualRowValue = actualByVersion.get(key);
    if (!actualRowValue) {
      if (actualBySource.has(sourceKeyFor(row))) alteredCount += 1;
      missingCount += 1;
      return;
    }
    const expectedId = row.id;
    const expectedTimestamp = row.sourceUpdatedAt;
    if (actualRowValue.id !== expectedId || actualRowValue.system !== row.system || actualRowValue.sourceCollection !== row.sourceCollection || actualRowValue.sourceId !== row.sourceId || actualRowValue.sourceUpdatedAt !== expectedTimestamp || actualRowValue.importRunId !== input.observation?.importRunId || actualRowValue.canonicalPayload !== row.canonicalPayload) alteredCount += 1;
  });
  Array.from(actualByVersion.keys()).forEach((key) => { if (!expectedByVersion.has(key)) unexpectedCount += 1; });
  if (missingCount > 0) reasons.add("restricted_row_missing");
  if (unexpectedCount > 0) reasons.add("restricted_row_unexpected");
  if (alteredCount > 0) reasons.add("restricted_row_altered");

  const actualRowsForDigest: ExpectedRow[] = actual.map((row, index) => ({
    id: row.id,
    system: row.system,
    sourceCollection: row.sourceCollection,
    sourceId: row.sourceId,
    ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}),
    payload: row.payload,
    canonicalPayload: row.canonicalPayload,
    checksumSha256: row.checksumSha256,
    sourceCollectionPath: "",
    sourceOrdinal: index,
    valid: row.valid,
  }));
  const actualRestrictedRowsSha256 = sourceRowsSetDigest(actualRowsForDigest);
  const expectedRestrictedRowsSha256 = sourceRowsSetDigest(expected.rows);
  if (actualRestrictedRowsSha256 !== expectedRestrictedRowsSha256) reasons.add("restricted_rows_digest_mismatch");
  if (actual.length !== expected.rows.length) reasons.add("restricted_row_count_mismatch");

  const observation = normalizeObservation(input.observation);
  let observationVersionValid = false;
  const collectionChecks: RestrictedParityCollectionChecks = {
    expectedCount: expected.collections.length,
    observedCount: observation?.collections?.length ?? 0,
    missingObservationCount: 0,
    unexpectedObservationCount: 0,
    duplicateObservationCount: 0,
    presenceMismatchCount: 0,
    rowCountMismatchCount: 0,
    orderedDigestMismatchCount: 0,
    sourceIdentityDigestMismatchCount: 0,
    collectionsDigestMismatch: false,
  };
  if (!observation) {
    reasons.add("import_observation_missing");
  } else {
    observationVersionValid = observation.version === RESTRICTED_PARITY_VERSION && observation.source === "rent_manager" && Boolean(observation.sourceRunId) && Boolean(observation.importRunId) && Boolean(safeTimestamp(observation.observedAt));
    if (!observationVersionValid) reasons.add("import_observation_invalid");
    if (observation.sourceRunId !== text((input.envelope as unknown as JsonRecord).runId)) reasons.add("source_run_observation_mismatch");
    if (!SHA256.test(observation.sourceEnvelopeSha256) || observation.sourceEnvelopeSha256 !== expected.sourceEnvelopeSha256) reasons.add("source_envelope_digest_mismatch");
    if (expected.sourceManifestSha256 && observation.sourceManifestSha256 !== expected.sourceManifestSha256) reasons.add("source_manifest_digest_mismatch");
    if (observation.sourceRowsSha256 !== expected.sourceRowsSha256) reasons.add("source_rows_digest_mismatch");
    if (observation.collectionsSha256 !== expected.collectionsSha256) {
      collectionChecks.collectionsDigestMismatch = true;
      reasons.add("source_collections_digest_mismatch");
    }
    const observedByPath = new Map<string, RestrictedCollectionObservation>();
    for (const collection of observation.collections ?? []) {
      if (observedByPath.has(collection.path)) collectionChecks.duplicateObservationCount += 1;
      else observedByPath.set(collection.path, collection);
    }
    for (const expectedCollectionValue of expected.collections) {
      const observedCollection = observedByPath.get(expectedCollectionValue.path);
      if (!observedCollection) {
        collectionChecks.missingObservationCount += 1;
        continue;
      }
      if (observedCollection.present !== expectedCollectionValue.present) collectionChecks.presenceMismatchCount += 1;
      if (observedCollection.rowCount !== expectedCollectionValue.rows.length) collectionChecks.rowCountMismatchCount += 1;
      if (!SHA256.test(observedCollection.orderedRowsSha256) || observedCollection.orderedRowsSha256 !== expectedCollectionValue.orderedRowsSha256) collectionChecks.orderedDigestMismatchCount += 1;
      if (!SHA256.test(observedCollection.sourceIdentityRowsSha256) || observedCollection.sourceIdentityRowsSha256 !== expectedCollectionValue.sourceIdentityRowsSha256) collectionChecks.sourceIdentityDigestMismatchCount += 1;
    }
    Array.from(observedByPath.keys()).forEach((path) => { if (!expected.collections.some((collection) => collection.path === path)) collectionChecks.unexpectedObservationCount += 1; });
    if (collectionChecks.missingObservationCount > 0) reasons.add("collection_observation_missing");
    if (collectionChecks.unexpectedObservationCount > 0) reasons.add("collection_observation_unexpected");
    if (collectionChecks.duplicateObservationCount > 0) reasons.add("collection_observation_duplicate");
    if (collectionChecks.presenceMismatchCount > 0) reasons.add("collection_presence_mismatch");
    if (collectionChecks.rowCountMismatchCount > 0) reasons.add("collection_row_count_mismatch");
    if (collectionChecks.orderedDigestMismatchCount > 0) reasons.add("collection_order_digest_mismatch");
    if (collectionChecks.sourceIdentityDigestMismatchCount > 0) reasons.add("collection_identity_digest_mismatch");
  }
  for (const row of actual) {
    if (observation && row.importRunId !== observation.importRunId) importObservationMismatchCount += 1;
    if (findCredentialShapedFields(row, limits).length > 0) reasons.add("credential_shaped_field_detected");
  }
  if (importObservationMismatchCount > 0) reasons.add("restricted_row_import_observation_mismatch");

  const protectedCanary = input.protectedCanary;
  const projectionChecks: RestrictedParityProjectionChecks = {
    canaryConfigured: Boolean(protectedCanary),
    protectedValueInRestrictedRows: protectedCanary ? containsCanaryFieldValue(actual, protectedCanary.field, protectedCanary.value, limits) : false,
    normalizedSnapshotLeak: protectedCanary ? containsCanaryValue(input.projections?.normalizedSnapshot, protectedCanary.value, limits) : false,
    publicDtoLeak: protectedCanary ? containsCanaryValue(input.projections?.publicDto, protectedCanary.value, limits) : false,
    adminDtoLeak: protectedCanary ? containsCanaryValue(input.projections?.adminDto, protectedCanary.value, limits) : false,
    logSafeSummaryLeak: protectedCanary ? containsCanaryValue(input.projections?.logSafeSummary, protectedCanary.value, limits) : false,
  };
  if (protectedCanary && !projectionChecks.protectedValueInRestrictedRows) reasons.add("protected_canary_missing_from_restricted_rows");
  if (projectionChecks.normalizedSnapshotLeak) reasons.add("protected_canary_leaked_to_normalized_snapshot");
  if (projectionChecks.publicDtoLeak) reasons.add("protected_canary_leaked_to_public_dto");
  if (projectionChecks.adminDtoLeak) reasons.add("protected_canary_leaked_to_admin_dto");
  if (projectionChecks.logSafeSummaryLeak) reasons.add("protected_canary_leaked_to_log_safe_summary");
  for (const projection of [input.projections?.normalizedSnapshot, input.projections?.publicDto, input.projections?.adminDto, input.projections?.logSafeSummary]) {
    if (findCredentialShapedFields(projection, limits).length > 0) reasons.add("credential_shaped_field_detected");
  }

  const sortedReasons = Array.from(reasons).map(safeReason).sort();
  return {
    version: RESTRICTED_PARITY_VERSION,
    passed: sortedReasons.length === 0,
    blockingReasons: sortedReasons,
    expectedEnvelopeSha256: expected.sourceEnvelopeSha256,
    ...(observation?.sourceEnvelopeSha256 ? { observedEnvelopeSha256: observation.sourceEnvelopeSha256 } : {}),
    ...(expected.sourceManifestSha256 ? { expectedManifestSha256: expected.sourceManifestSha256 } : {}),
    ...(observation?.sourceManifestSha256 ? { observedManifestSha256: observation.sourceManifestSha256 } : {}),
    expectedRowsSha256: expected.sourceRowsSha256,
    ...(observation?.sourceRowsSha256 ? { observedRowsSha256: observation.sourceRowsSha256 } : {}),
    expectedRestrictedRowsSha256,
    actualRestrictedRowsSha256,
    expectedCollectionsSha256: expected.collectionsSha256,
    ...(observation?.collectionsSha256 ? { observedCollectionsSha256: observation.collectionsSha256 } : {}),
    observationPresent: Boolean(observation),
    observationVersionValid,
    credentialShapedFieldCount: expected.credentialShapedFieldCount + input.restrictedRows.reduce((count, row) => count + (findCredentialShapedFields(row, limits).length > 0 ? 1 : 0), 0),
    collectionChecks,
    rowChecks: {
      expectedCount: expected.rows.length,
      actualCount: actual.length,
      missingCount,
      duplicateCount: duplicateCount + duplicateExpectedCount,
      unexpectedCount,
      alteredCount,
      conflictingSourceCount,
      invalidIdentityCount,
      invalidChecksumCount,
      importObservationMismatchCount,
    },
    projectionChecks,
    immutableMappingProven: true,
  };
}

export const auditRestrictedParity = auditRestrictedSourceParity;
export const mapEnvelopeToRestrictedRows = mapRestrictedEnvelopeToRows;

/** Synthetic, non-PII canary fixture for restricted-only field retention. */
export function createRestrictedParityCanary(): RestrictedParityCanary {
  const protectedField = "restrictedOnlyCanary";
  const protectedValue = "restricted-only-canary-20260817";
  const envelope = {
    version: "rm-export/v2" as const,
    runId: "canary-run-20260817",
    source: { system: "rent_manager" as const, transport: "injected" as const, readOnly: true as const },
    createdAt: "2026-08-17T12:00:00.000Z",
    payload: {
      properties: [{ entityType: "property", sourceId: "property-canary-1", PropertyID: "property-canary-1", Name: "Synthetic Property", [protectedField]: protectedValue }],
      emptyCollection: [],
    },
    documentBinaries: [],
  } as unknown as ExportEnvelope;
  const observation = createRestrictedImportObservation(envelope, { importRunId: "canary-import-20260817", observedAt: "2026-08-17T12:00:01.000Z" });
  const restrictedRows = mapRestrictedEnvelopeToRows(envelope, { importRunId: observation.importRunId, importedAt: observation.observedAt });
  return {
    envelope,
    observation,
    restrictedRows,
    normalizedSnapshot: { properties: [{ sourceId: "property-canary-1", Name: "Synthetic Property" }], sourceRecords: [] },
    publicDto: { properties: [{ id: "property-canary-1", name: "Synthetic Property" }] },
    adminDto: { summary: { propertyCount: 1 }, properties: [{ id: "property-canary-1", name: "Synthetic Property" }] },
    logSafeSummary: { runId: "canary-run-20260817", complete: true, counts: { properties: 1, emptyCollection: 0 } },
    protectedField,
    protectedValue,
  };
}

export function runRestrictedParityCanary(): RestrictedParityReport {
  const canary = createRestrictedParityCanary();
  return auditRestrictedSourceParity({
    envelope: canary.envelope,
    observation: canary.observation,
    restrictedRows: canary.restrictedRows,
    projections: { normalizedSnapshot: canary.normalizedSnapshot, publicDto: canary.publicDto, adminDto: canary.adminDto, logSafeSummary: canary.logSafeSummary },
    protectedCanary: { field: canary.protectedField, value: canary.protectedValue },
  });
}

export const buildRestrictedParityCanary = createRestrictedParityCanary;
