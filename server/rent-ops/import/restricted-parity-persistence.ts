import { canonicalJson, sha256 } from "../export/hash";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type {
  RestrictedCollectionObservation,
  RestrictedImportObservation,
  RestrictedParityChunkRow,
  RestrictedParitySourceChunk,
} from "./restricted-parity";

/**
 * The restricted source payload table is intentionally a version registry: a
 * `(system, collection, source id, checksum)` conflict can be a legitimate
 * retry.  This adapter is the append-only occurrence ledger beside it.  It
 * never stores raw payload values and never collapses two source occurrences
 * merely because their identity/checksum is equal.
 */
export const RESTRICTED_PARITY_PERSISTENCE_VERSION = "rm-restricted-parity-persistence/v1" as const;

export const RESTRICTED_PARITY_OBSERVATION_TABLE = "rent_ops_restricted_parity_observations" as const;
export const RESTRICTED_PARITY_COLLECTION_TABLE = "rent_ops_restricted_parity_collection_occurrences" as const;
export const RESTRICTED_PARITY_ROW_TABLE = "rent_ops_restricted_parity_row_occurrences" as const;

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_TOKEN = /^[^\u0000\r\n]{1,240}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EMPTY_SEQUENCE_DIGEST = sha256("[]");
const MAX_COLLECTION_OCCURRENCES = 100_000;
const MAX_ROW_OCCURRENCES = 500_000;
const MAX_READ_ROWS = 500_001;

export interface RestrictedParityCollectionOccurrence {
  readonly occurrenceOrdinal: number;
  readonly path: string;
  readonly present: boolean;
  readonly rowCount: number;
  readonly orderedRowsSha256: string;
  readonly sourceIdentityRowsSha256: string;
}

export interface RestrictedParityRowOccurrence {
  /** Global source occurrence order. Equal identities still receive distinct ordinals. */
  readonly occurrenceOrdinal: number;
  readonly collectionOccurrenceOrdinal: number;
  readonly collectionPath: string;
  readonly rowOrdinal: number;
  readonly system: string;
  readonly sourceCollection: string;
  readonly sourceId: string;
  readonly checksumSha256: string;
  readonly rowDigestSha256: string;
}

/** Redacted row occurrence control returned by readback/audit seams. */
export interface RestrictedParityRowOccurrenceControl {
  readonly occurrenceOrdinal: number;
  readonly collectionOccurrenceOrdinal: number;
  readonly collectionPath: string;
  readonly rowOrdinal: number;
  readonly identitySha256: string;
  readonly checksumSha256: string;
  readonly rowDigestSha256: string;
}

/** A version row binding used by the existing unique source-payload table. */
export interface RestrictedParityPayloadBinding {
  readonly id: string;
  readonly system: string;
  readonly sourceCollection: string;
  readonly sourceId: string;
  readonly checksumSha256: string;
  readonly importRunId: string;
  readonly canonicalPayload?: string;
  readonly sourceUpdatedAt?: string;
}

export interface RestrictedParityPersistenceInput {
  /** Approved envelope observation. Its hashes are copied exactly, never recomputed from a lossy projection. */
  readonly observation: RestrictedImportObservation;
  /** Exact manifest digest. Optional only for compatibility; persistence rejects it when absent. */
  readonly sourceManifestSha256?: string;
  /** Optional exporter checkpoint/registry/coverage controls; always folded into sourceControlSha256. */
  readonly sourceControls?: RestrictedParitySourceControls;
  /** Preserve every observed collection occurrence in source order. */
  readonly collectionOccurrences?: readonly RestrictedParityCollectionOccurrence[];
  /** Preserve every source-row occurrence in source order, including duplicates. */
  readonly rowOccurrences?: readonly RestrictedParityRowOccurrence[];
  /**
   * Optional source chunks are reduced to row controls and never retained.
   * Production callers should derive these from checkpoint-listed page files
   * in order; the assembled envelope may collapse cross-partition duplicates.
   */
  readonly sourceChunks?: Iterable<RestrictedParitySourceChunk>;
  /** Optional bindings for the unique version table; values stay inside the restricted transaction. */
  readonly payloadBindings?: readonly RestrictedParityPayloadBinding[];
}

export interface RestrictedParitySourceControls {
  readonly schemaVersion?: string;
  readonly registryHash?: string;
  readonly checkpointSha256?: string;
  readonly coverageSha256?: string;
  readonly controlSha256?: string;
}

interface PersistedObservationRow {
  id: string;
  version: string;
  source: string;
  source_run_id: string;
  import_run_id: string;
  observed_at: string;
  source_envelope_sha256: string;
  source_manifest_sha256: string;
  source_rows_sha256: string;
  collections_sha256: string;
  collection_occurrence_count: number;
  collection_occurrence_order_sha256: string;
  collection_occurrence_set_sha256: string;
  row_occurrence_count: number;
  row_occurrence_order_sha256: string;
  row_occurrence_set_sha256: string;
  source_identity_order_sha256: string;
  source_schema_version: string;
  source_registry_sha256: string | null;
  source_checkpoint_sha256: string | null;
  source_coverage_sha256: string | null;
  source_control_sha256: string;
}

interface PersistedCollectionRow {
  id: string;
  observation_id: string;
  occurrence_ordinal: number;
  path: string;
  present: boolean;
  row_count: number;
  ordered_rows_sha256: string;
  source_identity_rows_sha256: string;
}

interface PersistedRowRow {
  id: string;
  observation_id: string;
  occurrence_ordinal: number;
  collection_occurrence_ordinal: number;
  collection_path: string;
  row_ordinal: number;
  system: string;
  source_collection: string;
  source_id: string;
  checksum_sha256: string;
  row_digest_sha256: string;
}

export interface RestrictedParityAggregateControls {
  readonly version: typeof RESTRICTED_PARITY_PERSISTENCE_VERSION;
  readonly observationId: string;
  readonly sourceRunId: string;
  readonly importRunId: string;
  readonly sourceEnvelopeSha256: string;
  readonly sourceManifestSha256: string;
  readonly sourceRowsSha256: string;
  readonly collectionsSha256: string;
  readonly collectionOccurrences: readonly RestrictedParityCollectionOccurrence[];
  readonly rowOccurrences: readonly RestrictedParityRowOccurrenceControl[];
  readonly collectionOccurrenceOrderSha256: string;
  readonly collectionOccurrenceSetSha256: string;
  readonly rowOccurrenceOrderSha256: string;
  readonly rowOccurrenceSetSha256: string;
  readonly sourceIdentityOrderSha256: string;
  readonly sourceSchemaVersion: string;
  readonly sourceRegistrySha256?: string;
  readonly sourceCheckpointSha256?: string;
  readonly sourceCoverageSha256?: string;
  readonly sourceControlSha256: string;
}

export interface RestrictedParityPayloadAuditInput {
  readonly expected: readonly RestrictedParityPayloadBinding[];
  readonly actual: Iterable<RestrictedParityPayloadBinding>;
}

export interface RestrictedParityStreamAuditInput {
  readonly expected: RestrictedParityPersistenceInput;
  readonly actual: RestrictedParityAggregateControls;
  readonly payloads?: RestrictedParityPayloadAuditInput;
}

export interface RestrictedParityStreamAuditReport {
  readonly version: typeof RESTRICTED_PARITY_PERSISTENCE_VERSION;
  readonly passed: boolean;
  readonly blockingReasons: readonly string[];
  readonly expectedEnvelopeSha256: string;
  readonly actualEnvelopeSha256: string;
  readonly expectedManifestSha256: string;
  readonly actualManifestSha256: string;
  readonly expectedSourceControlSha256: string;
  readonly actualSourceControlSha256: string;
  readonly expectedCollectionOccurrenceCount: number;
  readonly actualCollectionOccurrenceCount: number;
  readonly expectedRowOccurrenceCount: number;
  readonly actualRowOccurrenceCount: number;
  readonly expectedCollectionOccurrenceOrderSha256: string;
  readonly actualCollectionOccurrenceOrderSha256: string;
  readonly expectedRowOccurrenceOrderSha256: string;
  readonly actualRowOccurrenceOrderSha256: string;
  readonly duplicateExpectedOccurrences: number;
  readonly duplicateActualOccurrences: number;
  readonly payloadExpectedCount?: number;
  readonly payloadActualCount?: number;
}

export class RestrictedParityPersistenceError extends Error {
  readonly reasons: readonly string[];
  readonly restoreRequired?: {
    readonly status: "restore_required";
    readonly safeReason: string;
    readonly preApplyTablesSha256: string;
    readonly observedTablesSha256?: string;
  };

  constructor(reasons: readonly string[], restoreRequired?: RestrictedParityPersistenceError["restoreRequired"]) {
    const safe = Array.from(new Set(reasons.map((reason) => safeCode(reason)))).sort();
    super(`Restricted parity persistence failed: ${safe.join("; ")}`);
    this.name = "RestrictedParityPersistenceError";
    this.reasons = safe;
    if (restoreRequired) this.restoreRequired = restoreRequired;
  }
}

function safeCode(value: unknown): string {
  const result = typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) : "restricted_parity_persistence_failed";
  return result || "restricted_parity_persistence_failed";
}

function token(value: unknown, reason: string): string {
  if (typeof value !== "string" || !value || !SAFE_TOKEN.test(value)) throw new RestrictedParityPersistenceError([reason]);
  return value;
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sequenceDigest<T>(values: readonly T[]): string {
  return digest(values);
}

function sortedSequenceDigest<T>(values: readonly T[]): string {
  return digest([...values].map((value) => canonicalJson(value)).sort());
}

function nonNegativeInteger(value: unknown, reason: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RestrictedParityPersistenceError([reason]);
  return Number(value);
}

function sha(value: unknown, reason: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new RestrictedParityPersistenceError([reason]);
  return value.toLowerCase();
}

function collectionControl(value: RestrictedParityCollectionOccurrence): Record<string, unknown> {
  return {
    occurrenceOrdinal: value.occurrenceOrdinal,
    path: value.path,
    present: value.present,
    rowCount: value.rowCount,
    orderedRowsSha256: value.orderedRowsSha256,
    sourceIdentityRowsSha256: value.sourceIdentityRowsSha256,
  };
}

/** Matches the approved observation's collection digest (which has no local ordinal). */
function sourceCollectionDigest(values: readonly RestrictedParityCollectionOccurrence[]): string {
  return sha256(canonicalJson([...values].map((value) => ({
    path: value.path,
    present: value.present,
    rowCount: value.rowCount,
    orderedRowsSha256: value.orderedRowsSha256,
    sourceIdentityRowsSha256: value.sourceIdentityRowsSha256,
  })).sort((left, right) => left.path.localeCompare(right.path))));
}

function rowIdentityControl(value: Pick<RestrictedParityRowOccurrence, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): Record<string, string> {
  return {
    system: value.system,
    sourceCollection: value.sourceCollection,
    sourceId: value.sourceId,
    checksumSha256: value.checksumSha256,
  };
}

/** Matches restricted-parity's length-prefixed identity digest exactly. */
function rowIdentityToken(value: Pick<RestrictedParityRowOccurrence, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): string {
  return [value.system, value.sourceCollection, value.sourceId, value.checksumSha256].map((part) => `${part.length}:${part}`).join("|");
}

function rowControl(value: RestrictedParityRowOccurrence): RestrictedParityRowOccurrenceControl {
  return {
    occurrenceOrdinal: value.occurrenceOrdinal,
    collectionOccurrenceOrdinal: value.collectionOccurrenceOrdinal,
    collectionPath: value.collectionPath,
    rowOrdinal: value.rowOrdinal,
    identitySha256: sha256(rowIdentityToken(value)),
    checksumSha256: value.checksumSha256,
    rowDigestSha256: value.rowDigestSha256,
  };
}

function rowControlDigest(value: RestrictedParityRowOccurrenceControl): Record<string, unknown> {
  return {
    occurrenceOrdinal: value.occurrenceOrdinal,
    collectionOccurrenceOrdinal: value.collectionOccurrenceOrdinal,
    collectionPath: value.collectionPath,
    rowOrdinal: value.rowOrdinal,
    identitySha256: value.identitySha256,
    checksumSha256: value.checksumSha256,
    rowDigestSha256: value.rowDigestSha256,
  };
}

/** Duplicate detection intentionally ignores occurrence ordinals. */
function rowDuplicateControl(value: RestrictedParityRowOccurrenceControl): Record<string, unknown> {
  return {
    identitySha256: value.identitySha256,
    checksumSha256: value.checksumSha256,
    rowDigestSha256: value.rowDigestSha256,
  };
}

function normalizeCollectionOccurrence(value: RestrictedParityCollectionOccurrence, index: number): RestrictedParityCollectionOccurrence {
  const occurrenceOrdinal = nonNegativeInteger(value.occurrenceOrdinal, "restricted_parity_collection_ordinal_invalid");
  if (occurrenceOrdinal !== index) throw new RestrictedParityPersistenceError(["restricted_parity_collection_order_invalid"]);
  if (typeof value.present !== "boolean") throw new RestrictedParityPersistenceError(["restricted_parity_collection_presence_invalid"]);
  const path = token(value.path, "restricted_parity_collection_path_invalid");
  const rowCount = nonNegativeInteger(value.rowCount, "restricted_parity_collection_row_count_invalid");
  const orderedRowsSha256 = sha(value.orderedRowsSha256, "restricted_parity_collection_order_digest_invalid");
  const sourceIdentityRowsSha256 = sha(value.sourceIdentityRowsSha256, "restricted_parity_collection_identity_digest_invalid");
  if (!value.present && rowCount !== 0) throw new RestrictedParityPersistenceError(["restricted_parity_absent_collection_has_rows"]);
  if (rowCount === 0 && (orderedRowsSha256 !== EMPTY_SEQUENCE_DIGEST || sourceIdentityRowsSha256 !== EMPTY_SEQUENCE_DIGEST)) {
    throw new RestrictedParityPersistenceError(["restricted_parity_empty_collection_digest_invalid"]);
  }
  return { occurrenceOrdinal, path, present: value.present, rowCount, orderedRowsSha256, sourceIdentityRowsSha256 };
}

function normalizeRowOccurrence(value: RestrictedParityRowOccurrence, index: number): RestrictedParityRowOccurrence {
  const occurrenceOrdinal = nonNegativeInteger(value.occurrenceOrdinal, "restricted_parity_row_ordinal_invalid");
  if (occurrenceOrdinal !== index) throw new RestrictedParityPersistenceError(["restricted_parity_row_order_invalid"]);
  const collectionOccurrenceOrdinal = nonNegativeInteger(value.collectionOccurrenceOrdinal, "restricted_parity_collection_ordinal_invalid");
  const collectionPath = token(value.collectionPath, "restricted_parity_collection_path_invalid");
  const rowOrdinal = nonNegativeInteger(value.rowOrdinal, "restricted_parity_row_ordinal_invalid");
  const system = token(value.system, "restricted_parity_source_system_invalid");
  const sourceCollection = token(value.sourceCollection, "restricted_parity_source_collection_invalid");
  const sourceId = token(value.sourceId, "restricted_parity_source_id_invalid");
  const checksumSha256 = sha(value.checksumSha256, "restricted_parity_source_checksum_invalid");
  const rowDigestSha256 = sha(value.rowDigestSha256, "restricted_parity_row_digest_invalid");
  return { occurrenceOrdinal, collectionOccurrenceOrdinal, collectionPath, rowOrdinal, system, sourceCollection, sourceId, checksumSha256, rowDigestSha256 };
}

function normalizeObservationCollections(observation: RestrictedImportObservation): RestrictedParityCollectionOccurrence[] {
  if (!Array.isArray(observation.collections) || observation.collections.length > MAX_COLLECTION_OCCURRENCES) {
    throw new RestrictedParityPersistenceError(["restricted_parity_collection_limit"]);
  }
  return observation.collections.map((collection, index) => normalizeCollectionOccurrence({
    occurrenceOrdinal: index,
    path: collection.path,
    present: collection.present,
    rowCount: collection.rowCount,
    orderedRowsSha256: collection.orderedRowsSha256,
    sourceIdentityRowsSha256: collection.sourceIdentityRowsSha256,
  }, index));
}

function rowDigestFromChunkRow(row: RestrictedParityChunkRow): string {
  return digest({
    system: row.system,
    sourceCollection: row.sourceCollection,
    sourceId: row.sourceId,
    checksumSha256: row.checksumSha256.toLowerCase(),
    canonicalPayload: row.canonicalPayload,
  });
}

function identityDigestFromRow(row: Pick<RestrictedParityRowOccurrence, "system" | "sourceCollection" | "sourceId" | "checksumSha256">): string {
  return rowIdentityToken(row);
}

function deriveFromChunks(chunks: Iterable<RestrictedParitySourceChunk>): {
  collections: RestrictedParityCollectionOccurrence[];
  rows: RestrictedParityRowOccurrence[];
} {
  const collections: RestrictedParityCollectionOccurrence[] = [];
  const rows: RestrictedParityRowOccurrence[] = [];
  let globalOrdinal = 0;
  let chunkOrdinal = 0;
  const chunkIterator = chunks[Symbol.iterator]();
  let chunkStep = chunkIterator.next();
  while (!chunkStep.done) {
    const chunk = chunkStep.value;
    if (chunkOrdinal >= MAX_COLLECTION_OCCURRENCES) throw new RestrictedParityPersistenceError(["restricted_parity_collection_limit"]);
    const path = token(chunk.path, "restricted_parity_collection_path_invalid");
    const rowControls: RestrictedParityRowOccurrence[] = [];
    let rowOrdinal = 0;
    const rowIterator = chunk.rows[Symbol.iterator]();
    let rowStep = rowIterator.next();
    while (!rowStep.done) {
      const row = rowStep.value;
      if (globalOrdinal >= MAX_ROW_OCCURRENCES) throw new RestrictedParityPersistenceError(["restricted_parity_row_limit"]);
      const checksumSha256 = sha(row.checksumSha256, "restricted_parity_source_checksum_invalid");
      if (sha256(row.canonicalPayload) !== checksumSha256) throw new RestrictedParityPersistenceError(["restricted_parity_source_checksum_binding_invalid"]);
      const normalized: RestrictedParityRowOccurrence = {
        occurrenceOrdinal: globalOrdinal,
        collectionOccurrenceOrdinal: chunkOrdinal,
        collectionPath: path,
        rowOrdinal,
        system: token(row.system, "restricted_parity_source_system_invalid"),
        sourceCollection: token(row.sourceCollection, "restricted_parity_source_collection_invalid"),
        sourceId: token(row.sourceId, "restricted_parity_source_id_invalid"),
        checksumSha256,
        rowDigestSha256: rowDigestFromChunkRow(row),
      };
      rowControls.push(normalized);
      rows.push(normalized);
      globalOrdinal += 1;
      rowOrdinal += 1;
      rowStep = rowIterator.next();
    }
    const rowDigests = rowControls.map((row) => row.rowDigestSha256);
    const identityDigests = rowControls.map((row) => identityDigestFromRow(row));
    collections.push({
      occurrenceOrdinal: chunkOrdinal,
      path,
      present: chunk.present === true,
      rowCount: rowControls.length,
      orderedRowsSha256: sequenceDigest(rowDigests),
      sourceIdentityRowsSha256: sequenceDigest(identityDigests),
    });
    if (!chunk.present && rowControls.length > 0) throw new RestrictedParityPersistenceError(["restricted_parity_absent_collection_has_rows"]);
    chunkOrdinal += 1;
    chunkStep = chunkIterator.next();
  }
  return { collections, rows };
}

function normalizeRows(rows: readonly RestrictedParityRowOccurrence[] | undefined): RestrictedParityRowOccurrence[] {
  if (!rows) return [];
  if (rows.length > MAX_ROW_OCCURRENCES) throw new RestrictedParityPersistenceError(["restricted_parity_row_limit"]);
  return rows.map((row, index) => normalizeRowOccurrence(row, index));
}

function observationId(observation: RestrictedImportObservation, manifestSha256: string): string {
  return `rm-parity-observation:${sha256(canonicalJson({
    version: RESTRICTED_PARITY_PERSISTENCE_VERSION,
    sourceRunId: observation.sourceRunId,
    importRunId: observation.importRunId,
    observedAt: observation.observedAt,
    sourceEnvelopeSha256: observation.sourceEnvelopeSha256,
    sourceManifestSha256: manifestSha256,
  }))}`;
}

function controlsForInput(input: RestrictedParityPersistenceInput): {
  observation: RestrictedImportObservation;
  manifestSha256: string;
  observationId: string;
  collections: RestrictedParityCollectionOccurrence[];
  rows: RestrictedParityRowOccurrence[];
  header: PersistedObservationRow;
  collectionRows: PersistedCollectionRow[];
  rowRows: PersistedRowRow[];
} {
  if (!input || !input.observation) throw new RestrictedParityPersistenceError(["restricted_parity_observation_missing"]);
  const observation = input.observation;
  if (observation.version !== "rm-restricted-parity/v1" || observation.source !== "rent_manager") throw new RestrictedParityPersistenceError(["restricted_parity_observation_invalid"]);
  const sourceRunId = token(observation.sourceRunId, "restricted_parity_source_run_invalid");
  const importRunId = token(observation.importRunId, "restricted_parity_import_run_invalid");
  const observedAt = token(observation.observedAt, "restricted_parity_observed_at_invalid");
  if (!ISO_TIMESTAMP.test(observedAt)) throw new RestrictedParityPersistenceError(["restricted_parity_observed_at_invalid"]);
  const sourceEnvelopeSha256 = sha(observation.sourceEnvelopeSha256, "restricted_parity_envelope_digest_invalid");
  const manifestSha256 = sha(input.sourceManifestSha256 ?? observation.sourceManifestSha256, "restricted_parity_manifest_digest_missing");
  if (observation.sourceManifestSha256 && observation.sourceManifestSha256.toLowerCase() !== manifestSha256) throw new RestrictedParityPersistenceError(["restricted_parity_manifest_digest_mismatch"]);
  const sourceRowsSha256 = sha(observation.sourceRowsSha256, "restricted_parity_source_rows_digest_invalid");
  const collectionsSha256 = sha(observation.collectionsSha256, "restricted_parity_collections_digest_invalid");
  const sourceControls = input.sourceControls ?? {};
  const sourceSchemaVersion = token(sourceControls.schemaVersion ?? observation.version, "restricted_parity_source_schema_invalid");
  const sourceRegistrySha256 = sourceControls.registryHash === undefined ? null : sha(sourceControls.registryHash, "restricted_parity_registry_digest_invalid");
  const sourceCheckpointSha256 = sourceControls.checkpointSha256 === undefined ? null : sha(sourceControls.checkpointSha256, "restricted_parity_checkpoint_digest_invalid");
  const sourceCoverageSha256 = sourceControls.coverageSha256 === undefined ? null : sha(sourceControls.coverageSha256, "restricted_parity_coverage_digest_invalid");

  let collections = input.collectionOccurrences ? input.collectionOccurrences.map(normalizeCollectionOccurrence) : normalizeObservationCollections(observation);
  let rows = normalizeRows(input.rowOccurrences);
  if (input.sourceChunks) {
    const derived = deriveFromChunks(input.sourceChunks);
    if (!input.collectionOccurrences) collections = derived.collections;
    if (!input.rowOccurrences) rows = derived.rows;
  }
  if (collections.length > MAX_COLLECTION_OCCURRENCES) throw new RestrictedParityPersistenceError(["restricted_parity_collection_limit"]);
  if (rows.length > MAX_ROW_OCCURRENCES) throw new RestrictedParityPersistenceError(["restricted_parity_row_limit"]);
  // The envelope-level collection digest may collapse repeated page paths.
  // When checkpoint/page occurrences are supplied, their independent ordered
  // controls below are authoritative for occurrence fidelity; retain the
  // envelope digest verbatim instead of comparing it to that projection.
  if (!input.sourceChunks && !input.collectionOccurrences && sourceCollectionDigest(collections) !== collectionsSha256) {
    throw new RestrictedParityPersistenceError(["restricted_parity_collections_digest_mismatch"]);
  }
  for (const row of rows) {
    const collection = collections[row.collectionOccurrenceOrdinal];
    if (!collection || collection.path !== row.collectionPath) throw new RestrictedParityPersistenceError(["restricted_parity_row_collection_binding_invalid"]);
  }
  const rowsByCollection = new Map<number, RestrictedParityRowOccurrence[]>();
  for (const row of rows) rowsByCollection.set(row.collectionOccurrenceOrdinal, [...(rowsByCollection.get(row.collectionOccurrenceOrdinal) ?? []), row]);
  for (const collection of collections) {
    const actualRows = rowsByCollection.get(collection.occurrenceOrdinal) ?? [];
    if (collection.rowCount !== actualRows.length) throw new RestrictedParityPersistenceError(["restricted_parity_row_count_mismatch"]);
    if (actualRows.some((row, index) => row.rowOrdinal !== index)) throw new RestrictedParityPersistenceError(["restricted_parity_row_order_invalid"]);
    if (actualRows.length > 0) {
      const orderedDigest = sequenceDigest(actualRows.map((row) => row.rowDigestSha256));
      const identityDigest = sequenceDigest(actualRows.map((row) => identityDigestFromRow(row)));
      if (orderedDigest !== collection.orderedRowsSha256 || identityDigest !== collection.sourceIdentityRowsSha256) throw new RestrictedParityPersistenceError(["restricted_parity_collection_digest_mismatch"]);
    }
  }
  if (sequenceDigest(rows.map((row) => row.rowDigestSha256)) !== sourceRowsSha256) throw new RestrictedParityPersistenceError(["restricted_parity_source_rows_digest_mismatch"]);
  const collectionControls = collections.map(collectionControl);
  const rowControls = rows.map(rowControl);
  const sourceControlSha256 = sourceControls.controlSha256 === undefined
    ? digest({ sourceSchemaVersion, sourceRunId, importRunId, observedAt, sourceEnvelopeSha256, sourceManifestSha256: manifestSha256, sourceRowsSha256, collectionsSha256, registryHash: sourceRegistrySha256, checkpointSha256: sourceCheckpointSha256, coverageSha256: sourceCoverageSha256, collections: collectionControls, rows: rowControls })
    : sha(sourceControls.controlSha256, "restricted_parity_source_control_digest_invalid");
  const id = observationId({ ...observation, sourceRunId, importRunId, observedAt, sourceEnvelopeSha256, sourceManifestSha256: manifestSha256, sourceRowsSha256, collectionsSha256, collections } as RestrictedImportObservation, manifestSha256);
  const header: PersistedObservationRow = {
    id,
    version: RESTRICTED_PARITY_PERSISTENCE_VERSION,
    source: "rent_manager",
    source_run_id: sourceRunId,
    import_run_id: importRunId,
    observed_at: observedAt,
    source_envelope_sha256: sourceEnvelopeSha256,
    source_manifest_sha256: manifestSha256,
    source_rows_sha256: sourceRowsSha256,
    collections_sha256: collectionsSha256,
    collection_occurrence_count: collections.length,
    collection_occurrence_order_sha256: sequenceDigest(collectionControls),
    collection_occurrence_set_sha256: sortedSequenceDigest(collectionControls),
    row_occurrence_count: rows.length,
    row_occurrence_order_sha256: sequenceDigest(rowControls),
    row_occurrence_set_sha256: sortedSequenceDigest(rowControls),
    // The per-row identity is already one-way hashed before this aggregate is
    // exposed.  Keeping this digest over those hashes lets bounded readback
    // independently verify order without returning source identifiers.
    source_identity_order_sha256: sequenceDigest(rowControls.map((row) => row.identitySha256)),
    source_schema_version: sourceSchemaVersion,
    source_registry_sha256: sourceRegistrySha256,
    source_checkpoint_sha256: sourceCheckpointSha256,
    source_coverage_sha256: sourceCoverageSha256,
    source_control_sha256: sourceControlSha256,
  };
  const collectionRows = collections.map((collection) => ({
    id: `${id}:collection:${sha256(String(collection.occurrenceOrdinal))}`,
    observation_id: id,
    occurrence_ordinal: collection.occurrenceOrdinal,
    path: collection.path,
    present: collection.present,
    row_count: collection.rowCount,
    ordered_rows_sha256: collection.orderedRowsSha256,
    source_identity_rows_sha256: collection.sourceIdentityRowsSha256,
  }));
  const rowRows = rows.map((row) => ({
    id: `${id}:row:${sha256(String(row.occurrenceOrdinal))}`,
    observation_id: id,
    occurrence_ordinal: row.occurrenceOrdinal,
    collection_occurrence_ordinal: row.collectionOccurrenceOrdinal,
    collection_path: row.collectionPath,
    row_ordinal: row.rowOrdinal,
    system: row.system,
    source_collection: row.sourceCollection,
    source_id: row.sourceId,
    checksum_sha256: row.checksumSha256,
    row_digest_sha256: row.rowDigestSha256,
  }));
  return { observation, manifestSha256, observationId: id, collections, rows, header, collectionRows, rowRows };
}

function compareFields(expected: object, actual: object, fields: readonly string[]): boolean {
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const comparable = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? "");
  return fields.every((field) => comparable(expectedRecord[field]) === comparable(actualRecord[field]));
}

async function query<T>(executor: RentOpsQueryExecutor, statement: string, values: unknown[]): Promise<T[]> {
  try {
    const result = await executor.query<T>(statement, values);
    return result.rows;
  } catch {
    throw new RestrictedParityPersistenceError(["restricted_parity_persistence_query_failed"]);
  }
}

async function insertAndVerify<T extends object>(
  executor: RentOpsQueryExecutor,
  insertStatement: string,
  values: unknown[],
  selectStatement: string,
  selectValues: unknown[],
  expected: T,
  fields: readonly string[],
): Promise<void> {
  const inserted = await query<T>(executor, insertStatement, values);
  if (inserted.length > 0) {
    if (!compareFields(expected, inserted[0] ?? {}, fields)) throw new RestrictedParityPersistenceError(["restricted_parity_persistence_insert_conflict"]);
    return;
  }
  const existing = await query<T>(executor, selectStatement, selectValues);
  if (existing.length !== 1 || !compareFields(expected, existing[0] ?? {}, fields)) throw new RestrictedParityPersistenceError(["restricted_parity_persistence_insert_conflict"]);
}

const OBSERVATION_FIELDS = [
  "id", "version", "source", "source_run_id", "import_run_id", "observed_at", "source_envelope_sha256", "source_manifest_sha256", "source_rows_sha256", "collections_sha256", "collection_occurrence_count", "collection_occurrence_order_sha256", "collection_occurrence_set_sha256", "row_occurrence_count", "row_occurrence_order_sha256", "row_occurrence_set_sha256", "source_identity_order_sha256", "source_schema_version", "source_registry_sha256", "source_checkpoint_sha256", "source_coverage_sha256", "source_control_sha256",
] as const;
const COLLECTION_FIELDS = ["id", "observation_id", "occurrence_ordinal", "path", "present", "row_count", "ordered_rows_sha256", "source_identity_rows_sha256"] as const;
const ROW_FIELDS = ["id", "observation_id", "occurrence_ordinal", "collection_occurrence_ordinal", "collection_path", "row_ordinal", "system", "source_collection", "source_id", "checksum_sha256", "row_digest_sha256"] as const;

async function persistObservationRows(executor: RentOpsQueryExecutor, controls: ReturnType<typeof controlsForInput>): Promise<void> {
  const h = controls.header;
  await insertAndVerify(
    executor,
    `INSERT INTO ${RESTRICTED_PARITY_OBSERVATION_TABLE} (id, version, source, source_run_id, import_run_id, observed_at, source_envelope_sha256, source_manifest_sha256, source_rows_sha256, collections_sha256, collection_occurrence_count, collection_occurrence_order_sha256, collection_occurrence_set_sha256, row_occurrence_count, row_occurrence_order_sha256, row_occurrence_set_sha256, source_identity_order_sha256, source_schema_version, source_registry_sha256, source_checkpoint_sha256, source_coverage_sha256, source_control_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (id) DO NOTHING RETURNING id, version, source, source_run_id, import_run_id, observed_at, source_envelope_sha256, source_manifest_sha256, source_rows_sha256, collections_sha256, collection_occurrence_count, collection_occurrence_order_sha256, collection_occurrence_set_sha256, row_occurrence_count, row_occurrence_order_sha256, row_occurrence_set_sha256, source_identity_order_sha256, source_schema_version, source_registry_sha256, source_checkpoint_sha256, source_coverage_sha256, source_control_sha256`,
    [h.id, h.version, h.source, h.source_run_id, h.import_run_id, h.observed_at, h.source_envelope_sha256, h.source_manifest_sha256, h.source_rows_sha256, h.collections_sha256, h.collection_occurrence_count, h.collection_occurrence_order_sha256, h.collection_occurrence_set_sha256, h.row_occurrence_count, h.row_occurrence_order_sha256, h.row_occurrence_set_sha256, h.source_identity_order_sha256, h.source_schema_version, h.source_registry_sha256, h.source_checkpoint_sha256, h.source_coverage_sha256, h.source_control_sha256],
    `SELECT id, version, source, source_run_id, import_run_id, observed_at, source_envelope_sha256, source_manifest_sha256, source_rows_sha256, collections_sha256, collection_occurrence_count, collection_occurrence_order_sha256, collection_occurrence_set_sha256, row_occurrence_count, row_occurrence_order_sha256, row_occurrence_set_sha256, source_identity_order_sha256, source_schema_version, source_registry_sha256, source_checkpoint_sha256, source_coverage_sha256, source_control_sha256 FROM ${RESTRICTED_PARITY_OBSERVATION_TABLE} WHERE id = $1`,
    [h.id], h, OBSERVATION_FIELDS,
  );
  for (const row of controls.collectionRows) {
    await insertAndVerify(
      executor,
      `INSERT INTO ${RESTRICTED_PARITY_COLLECTION_TABLE} (id, observation_id, occurrence_ordinal, path, present, row_count, ordered_rows_sha256, source_identity_rows_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING id, observation_id, occurrence_ordinal, path, present, row_count, ordered_rows_sha256, source_identity_rows_sha256`,
      [row.id, row.observation_id, row.occurrence_ordinal, row.path, row.present, row.row_count, row.ordered_rows_sha256, row.source_identity_rows_sha256],
      `SELECT id, observation_id, occurrence_ordinal, path, present, row_count, ordered_rows_sha256, source_identity_rows_sha256 FROM ${RESTRICTED_PARITY_COLLECTION_TABLE} WHERE id = $1`,
      [row.id], row, COLLECTION_FIELDS,
    );
  }
  for (const row of controls.rowRows) {
    await insertAndVerify(
      executor,
      `INSERT INTO ${RESTRICTED_PARITY_ROW_TABLE} (id, observation_id, occurrence_ordinal, collection_occurrence_ordinal, collection_path, row_ordinal, system, source_collection, source_id, checksum_sha256, row_digest_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING RETURNING id, observation_id, occurrence_ordinal, collection_occurrence_ordinal, collection_path, row_ordinal, system, source_collection, source_id, checksum_sha256, row_digest_sha256`,
      [row.id, row.observation_id, row.occurrence_ordinal, row.collection_occurrence_ordinal, row.collection_path, row.row_ordinal, row.system, row.source_collection, row.source_id, row.checksum_sha256, row.row_digest_sha256],
      `SELECT id, observation_id, occurrence_ordinal, collection_occurrence_ordinal, collection_path, row_ordinal, system, source_collection, source_id, checksum_sha256, row_digest_sha256 FROM ${RESTRICTED_PARITY_ROW_TABLE} WHERE id = $1`,
      [row.id], row, ROW_FIELDS,
    );
  }
}

/**
 * Persist only redacted parity controls. Call this inside the caller's
 * existing import transaction; the adapter deliberately does not open a
 * nested transaction or expose a repository/browser surface.
 */
export async function persistRestrictedParityObservation(executor: RentOpsQueryExecutor, input: RestrictedParityPersistenceInput): Promise<RestrictedParityAggregateControls> {
  const controls = controlsForInput(input);
  await persistObservationRows(executor, controls);
  return aggregateControlsFromNormalized(controls);
}

export function createRestrictedParityPersistenceWriter(input?: RestrictedParityPersistenceInput): (executor: RentOpsQueryExecutor, overrideInput?: RestrictedParityPersistenceInput) => Promise<RestrictedParityAggregateControls> {
  return (executor, overrideInput) => {
    const selected = overrideInput ?? input;
    if (!selected) return Promise.reject(new RestrictedParityPersistenceError(["restricted_parity_observation_missing"]));
    return persistRestrictedParityObservation(executor, selected);
  };
}

/** Alias kept short for the importer integration seam. */
export const createRestrictedParityObservationWriter = createRestrictedParityPersistenceWriter;

function aggregateControlsFromNormalized(controls: ReturnType<typeof controlsForInput>): RestrictedParityAggregateControls {
  const h = controls.header;
  return {
    version: RESTRICTED_PARITY_PERSISTENCE_VERSION,
    observationId: h.id,
    sourceRunId: h.source_run_id,
    importRunId: h.import_run_id,
    sourceEnvelopeSha256: h.source_envelope_sha256,
    sourceManifestSha256: h.source_manifest_sha256,
    sourceRowsSha256: h.source_rows_sha256,
    collectionsSha256: h.collections_sha256,
    collectionOccurrences: controls.collections,
    rowOccurrences: controls.rows.map(rowControl),
    collectionOccurrenceOrderSha256: h.collection_occurrence_order_sha256,
    collectionOccurrenceSetSha256: h.collection_occurrence_set_sha256,
    rowOccurrenceOrderSha256: h.row_occurrence_order_sha256,
    rowOccurrenceSetSha256: h.row_occurrence_set_sha256,
    sourceIdentityOrderSha256: h.source_identity_order_sha256,
    sourceSchemaVersion: h.source_schema_version,
    ...(h.source_registry_sha256 ? { sourceRegistrySha256: h.source_registry_sha256 } : {}),
    ...(h.source_checkpoint_sha256 ? { sourceCheckpointSha256: h.source_checkpoint_sha256 } : {}),
    ...(h.source_coverage_sha256 ? { sourceCoverageSha256: h.source_coverage_sha256 } : {}),
    sourceControlSha256: h.source_control_sha256,
  };
}

function collectionFromDb(row: PersistedCollectionRow, index: number): RestrictedParityCollectionOccurrence {
  return normalizeCollectionOccurrence({
    occurrenceOrdinal: Number(row.occurrence_ordinal),
    path: String(row.path),
    present: row.present === true,
    rowCount: Number(row.row_count),
    orderedRowsSha256: String(row.ordered_rows_sha256),
    sourceIdentityRowsSha256: String(row.source_identity_rows_sha256),
  }, index);
}

function rowFromDb(row: PersistedRowRow, index: number): RestrictedParityRowOccurrence {
  return normalizeRowOccurrence({
    occurrenceOrdinal: Number(row.occurrence_ordinal),
    collectionOccurrenceOrdinal: Number(row.collection_occurrence_ordinal),
    collectionPath: String(row.collection_path),
    rowOrdinal: Number(row.row_ordinal),
    system: String(row.system),
    sourceCollection: String(row.source_collection),
    sourceId: String(row.source_id),
    checksumSha256: String(row.checksum_sha256),
    rowDigestSha256: String(row.row_digest_sha256),
  }, index);
}

/** Read bounded controls only; source identifiers remain internal to the adapter and are not returned in the audit report. */
export async function readRestrictedParityAggregateControls(executor: RentOpsQueryExecutor, observationId: string): Promise<RestrictedParityAggregateControls> {
  const id = token(observationId, "restricted_parity_observation_id_invalid");
  const observations = await query<PersistedObservationRow>(executor, `SELECT id, version, source, source_run_id, import_run_id, observed_at, source_envelope_sha256, source_manifest_sha256, source_rows_sha256, collections_sha256, collection_occurrence_count, collection_occurrence_order_sha256, collection_occurrence_set_sha256, row_occurrence_count, row_occurrence_order_sha256, row_occurrence_set_sha256, source_identity_order_sha256, source_schema_version, source_registry_sha256, source_checkpoint_sha256, source_coverage_sha256, source_control_sha256 FROM ${RESTRICTED_PARITY_OBSERVATION_TABLE} WHERE id = $1`, [id]);
  if (observations.length !== 1) throw new RestrictedParityPersistenceError(["restricted_parity_observation_not_found"]);
  const header = observations[0]!;
  const collections = await query<PersistedCollectionRow>(executor, `SELECT id, observation_id, occurrence_ordinal, path, present, row_count, ordered_rows_sha256, source_identity_rows_sha256 FROM ${RESTRICTED_PARITY_COLLECTION_TABLE} WHERE observation_id = $1 ORDER BY occurrence_ordinal ASC LIMIT $2`, [id, MAX_READ_ROWS]);
  const rows = await query<PersistedRowRow>(executor, `SELECT id, observation_id, occurrence_ordinal, collection_occurrence_ordinal, collection_path, row_ordinal, system, source_collection, source_id, checksum_sha256, row_digest_sha256 FROM ${RESTRICTED_PARITY_ROW_TABLE} WHERE observation_id = $1 ORDER BY occurrence_ordinal ASC LIMIT $2`, [id, MAX_READ_ROWS]);
  if (collections.length >= MAX_READ_ROWS || rows.length >= MAX_READ_ROWS) throw new RestrictedParityPersistenceError(["restricted_parity_read_limit"]);
  const normalizedCollections = collections.map(collectionFromDb);
  const normalizedRows = rows.map(rowFromDb);
  if (header.collection_occurrence_count !== normalizedCollections.length || header.row_occurrence_count !== normalizedRows.length) throw new RestrictedParityPersistenceError(["restricted_parity_aggregate_count_mismatch"]);
  const rowsByCollection = new Map<number, RestrictedParityRowOccurrence[]>();
  for (const row of normalizedRows) {
    const collection = normalizedCollections[row.collectionOccurrenceOrdinal];
    if (!collection || collection.path !== row.collectionPath) throw new RestrictedParityPersistenceError(["restricted_parity_row_collection_binding_invalid"]);
    rowsByCollection.set(row.collectionOccurrenceOrdinal, [...(rowsByCollection.get(row.collectionOccurrenceOrdinal) ?? []), row]);
  }
  for (const collection of normalizedCollections) {
    const collectionRows = rowsByCollection.get(collection.occurrenceOrdinal) ?? [];
    if (collectionRows.length !== collection.rowCount || collectionRows.some((row, index) => row.rowOrdinal !== index)) throw new RestrictedParityPersistenceError(["restricted_parity_aggregate_count_mismatch"]);
    if (sequenceDigest(collectionRows.map((row) => row.rowDigestSha256)) !== collection.orderedRowsSha256 || sequenceDigest(collectionRows.map((row) => identityDigestFromRow(row))) !== collection.sourceIdentityRowsSha256) {
      throw new RestrictedParityPersistenceError(["restricted_parity_aggregate_digest_mismatch"]);
    }
  }
  if (sequenceDigest(normalizedRows.map((row) => row.rowDigestSha256)) !== header.source_rows_sha256) {
    throw new RestrictedParityPersistenceError(["restricted_parity_aggregate_digest_mismatch"]);
  }
  const safeRows = normalizedRows.map(rowControl);
  const result: RestrictedParityAggregateControls = {
    version: header.version as typeof RESTRICTED_PARITY_PERSISTENCE_VERSION,
    observationId: header.id,
    sourceRunId: header.source_run_id,
    importRunId: header.import_run_id,
    sourceEnvelopeSha256: header.source_envelope_sha256,
    sourceManifestSha256: header.source_manifest_sha256,
    sourceRowsSha256: header.source_rows_sha256,
    collectionsSha256: header.collections_sha256,
    collectionOccurrences: normalizedCollections,
    rowOccurrences: safeRows,
    collectionOccurrenceOrderSha256: header.collection_occurrence_order_sha256,
    collectionOccurrenceSetSha256: header.collection_occurrence_set_sha256,
    rowOccurrenceOrderSha256: header.row_occurrence_order_sha256,
    rowOccurrenceSetSha256: header.row_occurrence_set_sha256,
    sourceIdentityOrderSha256: header.source_identity_order_sha256,
    sourceSchemaVersion: header.source_schema_version,
    ...(header.source_registry_sha256 ? { sourceRegistrySha256: header.source_registry_sha256 } : {}),
    ...(header.source_checkpoint_sha256 ? { sourceCheckpointSha256: header.source_checkpoint_sha256 } : {}),
    ...(header.source_coverage_sha256 ? { sourceCoverageSha256: header.source_coverage_sha256 } : {}),
    sourceControlSha256: header.source_control_sha256,
  };
  const expected = aggregateControlDigest(result);
  if (
    expected.collectionOccurrenceOrderSha256 !== header.collection_occurrence_order_sha256 ||
    expected.collectionOccurrenceSetSha256 !== header.collection_occurrence_set_sha256 ||
    expected.rowOccurrenceOrderSha256 !== header.row_occurrence_order_sha256 ||
    expected.rowOccurrenceSetSha256 !== header.row_occurrence_set_sha256 ||
    expected.sourceIdentityOrderSha256 !== header.source_identity_order_sha256
  ) throw new RestrictedParityPersistenceError(["restricted_parity_aggregate_digest_mismatch"]);
  return result;
}

/**
 * Read and audit the restricted payload version table without returning its
 * payload values. The payload JSON is held only long enough to recompute its
 * checksum inside this function; callers receive the redacted report.
 */
export async function auditPersistedRestrictedParity(executor: RentOpsQueryExecutor, expected: RestrictedParityPersistenceInput): Promise<RestrictedParityStreamAuditReport> {
  const controls = controlsForInput(expected);
  const actual = await readRestrictedParityAggregateControls(executor, controls.observationId);
  if (!expected.payloadBindings) {
    const base = auditRestrictedParityStreamWithControls(controls, actual);
    return {
      ...base,
      passed: false,
      blockingReasons: [...base.blockingReasons, "restricted_parity_payload_expectation_missing"].sort(),
    };
  }
  const payloadRows = await query<{
    id?: unknown;
    system?: unknown;
    source_collection?: unknown;
    source_id?: unknown;
    source_updated_at?: unknown;
    checksum_sha256?: unknown;
    import_run_id?: unknown;
    payload?: unknown;
  }>(executor, "SELECT id, system, source_collection, source_id, source_updated_at, checksum_sha256, import_run_id, payload FROM rent_ops_source_payloads ORDER BY system, source_collection, source_id, checksum_sha256, id LIMIT $1", [MAX_READ_ROWS]);
  if (payloadRows.length >= MAX_READ_ROWS) throw new RestrictedParityPersistenceError(["restricted_parity_payload_read_limit"]);
  const actualBindings: RestrictedParityPayloadBinding[] = payloadRows.map((row) => {
    let canonicalPayload: string | undefined;
    try {
      const candidate = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      canonicalPayload = canonicalJson(candidate);
    } catch {
      canonicalPayload = "";
    }
    const binding: RestrictedParityPayloadBinding = {
      id: String(row.id ?? ""),
      system: String(row.system ?? ""),
      sourceCollection: String(row.source_collection ?? ""),
      sourceId: String(row.source_id ?? ""),
      checksumSha256: String(row.checksum_sha256 ?? ""),
      importRunId: String(row.import_run_id ?? ""),
      ...(row.source_updated_at !== undefined && row.source_updated_at !== null ? { sourceUpdatedAt: row.source_updated_at instanceof Date ? row.source_updated_at.toISOString() : String(row.source_updated_at) } : {}),
    };
    return canonicalPayload && SHA256.test(binding.checksumSha256) && sha256(canonicalPayload) === binding.checksumSha256.toLowerCase()
      ? { ...binding, canonicalPayload }
      : binding;
  });
  return auditRestrictedParityStreamWithControls(controls, actual, { expected: expected.payloadBindings, actual: actualBindings });
}

function aggregateControlDigest(value: Pick<RestrictedParityAggregateControls, "collectionOccurrences" | "rowOccurrences">): {
  collectionOccurrenceOrderSha256: string;
  collectionOccurrenceSetSha256: string;
  rowOccurrenceOrderSha256: string;
  rowOccurrenceSetSha256: string;
  sourceIdentityOrderSha256: string;
} {
  const collectionControls = value.collectionOccurrences.map(collectionControl);
  const rowControls = value.rowOccurrences.map(rowControlDigest);
  return {
    collectionOccurrenceOrderSha256: sequenceDigest(collectionControls),
    collectionOccurrenceSetSha256: sortedSequenceDigest(collectionControls),
    rowOccurrenceOrderSha256: sequenceDigest(rowControls),
    rowOccurrenceSetSha256: sortedSequenceDigest(rowControls),
    sourceIdentityOrderSha256: sequenceDigest(value.rowOccurrences.map((row) => row.identitySha256)),
  };
}

function duplicateCount<T>(values: readonly T[]): number {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = canonicalJson(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.values()).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function normalizePayloadBindings(values: readonly RestrictedParityPayloadBinding[]): RestrictedParityPayloadBinding[] {
  return values.map((value) => {
    const id = token(value.id, "restricted_parity_payload_id_invalid");
    const system = token(value.system, "restricted_parity_source_system_invalid");
    const sourceCollection = token(value.sourceCollection, "restricted_parity_source_collection_invalid");
    const sourceId = token(value.sourceId, "restricted_parity_source_id_invalid");
    const checksumSha256 = sha(value.checksumSha256, "restricted_parity_source_checksum_invalid");
    const importRunId = token(value.importRunId, "restricted_parity_import_run_invalid");
    if (value.canonicalPayload !== undefined && sha256(value.canonicalPayload) !== checksumSha256) throw new RestrictedParityPersistenceError(["restricted_parity_source_checksum_binding_invalid"]);
    return { id, system, sourceCollection, sourceId, checksumSha256, importRunId, ...(value.canonicalPayload !== undefined ? { canonicalPayload: value.canonicalPayload } : {}), ...(value.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: value.sourceUpdatedAt } : {}) };
  });
}

/**
 * Redacted stream audit. Exact ordered sequences are compared in addition to
 * set digests, so missing/extra/reordered/duplicate/empty-vs-absent changes
 * cannot hide behind equal result summaries.
 */
export function auditRestrictedParityStream(input: RestrictedParityStreamAuditInput): RestrictedParityStreamAuditReport {
  const expectedControls = controlsForInput(input.expected);
  return auditRestrictedParityStreamWithControls(expectedControls, input.actual, input.payloads);
}

function auditRestrictedParityStreamWithControls(
  expectedControls: ReturnType<typeof controlsForInput>,
  actual: RestrictedParityAggregateControls,
  payloads?: RestrictedParityPayloadAuditInput,
): RestrictedParityStreamAuditReport {
  const expectedAggregate = aggregateControlsFromNormalized(expectedControls);
  const actualDigest = aggregateControlDigest(actual);
  const reasons = new Set<string>();
  if (actual.version !== RESTRICTED_PARITY_PERSISTENCE_VERSION) reasons.add("restricted_parity_persistence_version_mismatch");
  if (actual.sourceEnvelopeSha256 !== expectedAggregate.sourceEnvelopeSha256) reasons.add("restricted_parity_envelope_digest_mismatch");
  if (actual.sourceManifestSha256 !== expectedAggregate.sourceManifestSha256) reasons.add("restricted_parity_manifest_digest_mismatch");
  if (actual.sourceRunId !== expectedAggregate.sourceRunId || actual.importRunId !== expectedAggregate.importRunId) reasons.add("restricted_parity_observation_binding_mismatch");
  if (actual.sourceRowsSha256 !== expectedAggregate.sourceRowsSha256) reasons.add("restricted_parity_source_rows_digest_mismatch");
  if (actual.collectionsSha256 !== expectedAggregate.collectionsSha256) reasons.add("restricted_parity_collections_digest_mismatch");
  if (actual.sourceSchemaVersion !== expectedAggregate.sourceSchemaVersion || actual.sourceRegistrySha256 !== expectedAggregate.sourceRegistrySha256 || actual.sourceCheckpointSha256 !== expectedAggregate.sourceCheckpointSha256 || actual.sourceCoverageSha256 !== expectedAggregate.sourceCoverageSha256 || actual.sourceControlSha256 !== expectedAggregate.sourceControlSha256) reasons.add("restricted_parity_source_control_mismatch");
  if (actual.collectionOccurrences.length !== expectedAggregate.collectionOccurrences.length) reasons.add("restricted_parity_collection_occurrence_count_mismatch");
  if (actual.rowOccurrences.length !== expectedAggregate.rowOccurrences.length) reasons.add("restricted_parity_row_occurrence_count_mismatch");
  if (actual.collectionOccurrenceOrderSha256 !== expectedAggregate.collectionOccurrenceOrderSha256 || actualDigest.collectionOccurrenceOrderSha256 !== expectedAggregate.collectionOccurrenceOrderSha256) reasons.add("restricted_parity_collection_occurrence_order_mismatch");
  if (actual.collectionOccurrenceSetSha256 !== expectedAggregate.collectionOccurrenceSetSha256 || actualDigest.collectionOccurrenceSetSha256 !== expectedAggregate.collectionOccurrenceSetSha256) reasons.add("restricted_parity_collection_occurrence_set_mismatch");
  if (actual.rowOccurrenceOrderSha256 !== expectedAggregate.rowOccurrenceOrderSha256 || actualDigest.rowOccurrenceOrderSha256 !== expectedAggregate.rowOccurrenceOrderSha256) reasons.add("restricted_parity_row_occurrence_order_mismatch");
  if (actual.rowOccurrenceSetSha256 !== expectedAggregate.rowOccurrenceSetSha256 || actualDigest.rowOccurrenceSetSha256 !== expectedAggregate.rowOccurrenceSetSha256) reasons.add("restricted_parity_row_occurrence_set_mismatch");
  if (actual.sourceIdentityOrderSha256 !== expectedAggregate.sourceIdentityOrderSha256 || actualDigest.sourceIdentityOrderSha256 !== expectedAggregate.sourceIdentityOrderSha256) reasons.add("restricted_parity_source_identity_order_mismatch");
  const expectedEmptyPresence = expectedAggregate.collectionOccurrences.filter((collection) => collection.rowCount === 0).map((collection) => `${collection.path}\u0000${collection.present}`).sort();
  const actualEmptyPresence = actual.collectionOccurrences.filter((collection) => collection.rowCount === 0).map((collection) => `${collection.path}\u0000${collection.present}`).sort();
  if (canonicalJson(expectedEmptyPresence) !== canonicalJson(actualEmptyPresence)) reasons.add("restricted_parity_empty_presence_mismatch");
  const expectedDuplicates = duplicateCount(expectedAggregate.rowOccurrences.map(rowDuplicateControl));
  const actualDuplicates = duplicateCount(actual.rowOccurrences.map(rowDuplicateControl));
  if (actualDuplicates !== expectedDuplicates) reasons.add("restricted_parity_duplicate_occurrence_mismatch");

  let payloadExpectedCount: number | undefined;
  let payloadActualCount: number | undefined;
  if (payloads) {
    const expectedPayloads = normalizePayloadBindings(payloads.expected);
    const actualPayloads = normalizePayloadBindings(Array.from(payloads.actual));
    payloadExpectedCount = expectedPayloads.length;
    payloadActualCount = actualPayloads.length;
    const expectedByKey = new Map(expectedPayloads.map((row) => [`${row.system}\u0000${row.sourceCollection}\u0000${row.sourceId}\u0000${row.checksumSha256}`, row]));
    const actualByKey = new Map(actualPayloads.map((row) => [`${row.system}\u0000${row.sourceCollection}\u0000${row.sourceId}\u0000${row.checksumSha256}`, row]));
    if (expectedByKey.size !== actualByKey.size || Array.from(expectedByKey.keys()).some((key) => !actualByKey.has(key))) reasons.add("restricted_parity_payload_binding_mismatch");
    if (duplicateCount(actualPayloads.map((row) => ({ system: row.system, sourceCollection: row.sourceCollection, sourceId: row.sourceId, checksumSha256: row.checksumSha256 }))) > 0) reasons.add("restricted_parity_payload_duplicate");
    for (const [key, expectedPayload] of Array.from(expectedByKey.entries())) {
      const actualPayload = actualByKey.get(key);
      if (!actualPayload || actualPayload.id !== expectedPayload.id || actualPayload.sourceUpdatedAt !== expectedPayload.sourceUpdatedAt || (expectedPayload.canonicalPayload !== undefined && actualPayload.canonicalPayload !== expectedPayload.canonicalPayload)) reasons.add("restricted_parity_payload_binding_mismatch");
    }
  }
  const sortedReasons = Array.from(reasons).map(safeCode).sort();
  return {
    version: RESTRICTED_PARITY_PERSISTENCE_VERSION,
    passed: sortedReasons.length === 0,
    blockingReasons: sortedReasons,
    expectedEnvelopeSha256: expectedAggregate.sourceEnvelopeSha256,
    actualEnvelopeSha256: actual.sourceEnvelopeSha256,
    expectedManifestSha256: expectedAggregate.sourceManifestSha256,
    actualManifestSha256: actual.sourceManifestSha256,
    expectedSourceControlSha256: expectedAggregate.sourceControlSha256,
    actualSourceControlSha256: actual.sourceControlSha256,
    expectedCollectionOccurrenceCount: expectedAggregate.collectionOccurrences.length,
    actualCollectionOccurrenceCount: actual.collectionOccurrences.length,
    expectedRowOccurrenceCount: expectedAggregate.rowOccurrences.length,
    actualRowOccurrenceCount: actual.rowOccurrences.length,
    expectedCollectionOccurrenceOrderSha256: expectedAggregate.collectionOccurrenceOrderSha256,
    actualCollectionOccurrenceOrderSha256: actual.collectionOccurrenceOrderSha256,
    expectedRowOccurrenceOrderSha256: expectedAggregate.rowOccurrenceOrderSha256,
    actualRowOccurrenceOrderSha256: actual.rowOccurrenceOrderSha256,
    duplicateExpectedOccurrences: expectedDuplicates,
    duplicateActualOccurrences: actualDuplicates,
    ...(payloadExpectedCount !== undefined ? { payloadExpectedCount } : {}),
    ...(payloadActualCount !== undefined ? { payloadActualCount } : {}),
  };
}

export const auditRestrictedParityPersistence = auditRestrictedParityStream;
