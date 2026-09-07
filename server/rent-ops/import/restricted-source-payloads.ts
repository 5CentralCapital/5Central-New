import { canonicalJson, sha256 } from "../export/hash";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type {
  RestrictedSourcePayloadPersistenceContext,
  RestrictedSourcePayloadWriter,
} from "./persistence-importer";
import type { RestrictedParityPayloadBinding } from "./restricted-parity-persistence";

type JsonRecord = Record<string, unknown>;

interface SourcePayloadRow {
  id: string;
  system: string;
  sourceCollection: string;
  sourceId: string;
  sourceUpdatedAt?: string;
  canonicalPayload: string;
  checksumSha256: string;
  importRunId: string;
}

interface SourceBinaryRow {
  id: string;
  system: string;
  sourceCollection: string;
  sourceId: string;
  importRunId: string;
  storageKey: string;
  checksumSha256: string;
  sizeBytes: number;
  contentType?: string;
}

/** Stable source-binary row identity shared by the archive transfer and its
 * restricted persistence writer. It contains no payload bytes. */
export function restrictedSourceBinaryId(system: string, sourceCollection: string, sourceId: string, checksumSha256: string): string {
  return `rm-binary:${sha256(`${system}\u0000${sourceCollection}\u0000${sourceId}\u0000${checksumSha256}`)}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const result = String(value).trim();
    if (result) return result;
  }
  return undefined;
}

function isoTimestamp(record: JsonRecord): string | undefined {
  // CreateDate is source creation provenance, not an update observation.  Do
  // not silently relabel it as sourceUpdatedAt; the canonical payload keeps
  // the original field for the restricted audit surface.
  const value = text(record, "sourceUpdatedAt", "updatedAt", "UpdateDate");
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function payloadObject(input: RestrictedSourcePayloadPersistenceContext["input"]): JsonRecord {
  if (!isRecord(input)) throw new Error("restricted_source_input_invalid");
  const nested = isRecord(input.payload) ? input.payload : isRecord(input.input) ? input.input : input;
  return nested;
}

function directArrayCollections(input: RestrictedSourcePayloadPersistenceContext["input"]): Array<[string, unknown[]]> {
  const source = payloadObject(input);
  const rows = Object.entries(source)
    // HAP status crosswalks are artifact-bound metadata, not source rows. They
    // have no sourceId by design and must not be persisted as raw collections.
    .filter(([name, value]) => name !== "hapStatusCrosswalk" && name !== "applicationHistoryStatusCrosswalk" && Array.isArray(value)) as Array<[string, unknown[]]>;
  if (isRecord(input) && Array.isArray(input.documentBinaries) && !rows.some(([name]) => name === "documentBinaries")) {
    rows.push(["documentBinaries", input.documentBinaries]);
  }
  return rows.sort(([left], [right]) => left.localeCompare(right));
}

function sourcePayloadRows(context: RestrictedSourcePayloadPersistenceContext): SourcePayloadRow[] {
  const rows: SourcePayloadRow[] = [];
  const seenVersion = new Set<string>();
  for (const [fallbackCollection, records] of directArrayCollections(context.input)) {
    for (const candidate of records) {
      if (!isRecord(candidate)) throw new Error("restricted_source_row_invalid");
      const sourceCollection = text(candidate, "sourceCollection") ?? fallbackCollection;
      const sourceId = text(candidate, "sourceId");
      if (!sourceCollection || !sourceId) throw new Error("restricted_source_identity_missing");
      const canonicalPayload = canonicalJson(candidate);
      const checksumSha256 = sha256(canonicalPayload);
      const sourceKey = `${sourceCollection}\u0000${sourceId}`;
      // The source-payload table is a version registry, not an occurrence
      // table.  Keep every distinct checksum for an identity here; the
      // importer preflight reports an ambiguity blocker for ordinary rows,
      // while this writer still retains both versions atomically so an audit
      // can prove that no source value was silently discarded.
      const versionKey = `${sourceKey}\u0000${checksumSha256}`;
      if (seenVersion.has(versionKey)) continue;
      seenVersion.add(versionKey);
      rows.push({
        id: `rm-payload:${sha256(`${context.importRun.system}\u0000${versionKey}`)}`,
        system: context.importRun.system,
        sourceCollection,
        sourceId,
        sourceUpdatedAt: isoTimestamp(candidate),
        canonicalPayload,
        checksumSha256,
        importRunId: context.importRun.id,
      });
    }
  }
  return rows.sort((left, right) => `${left.sourceCollection}\u0000${left.sourceId}\u0000${left.checksumSha256}`.localeCompare(`${right.sourceCollection}\u0000${right.sourceId}\u0000${right.checksumSha256}`));
}

/** Internal importer seam: expose only version bindings, never a report or
 * browser/repository surface.  Canonical payloads stay inside the restricted
 * transaction for the postcommit checksum audit. */
export function restrictedSourcePayloadBindings(context: RestrictedSourcePayloadPersistenceContext): RestrictedParityPayloadBinding[] {
  return sourcePayloadRows(context).map((row) => ({
    id: row.id,
    system: row.system,
    sourceCollection: row.sourceCollection,
    sourceId: row.sourceId,
    checksumSha256: row.checksumSha256,
    importRunId: row.importRunId,
    canonicalPayload: row.canonicalPayload,
    ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}),
  }));
}

function sourceBinaryRows(context: RestrictedSourcePayloadPersistenceContext): SourceBinaryRow[] {
  const source = payloadObject(context.input);
  const descriptors = [
    ...(Array.isArray(source.documentBinaries) ? source.documentBinaries : []),
    ...(isRecord(context.input) && Array.isArray(context.input.documentBinaries) ? context.input.documentBinaries : []),
  ];
  const rows = new Map<string, SourceBinaryRow>();
  for (const candidate of descriptors) {
    if (!isRecord(candidate) || candidate.binaryAvailable !== true) continue;
    const sourceCollection = text(candidate, "sourceCollection") ?? "documentBinaries";
    const sourceId = text(candidate, "sourceId");
    const storageKey = text(candidate, "archivePath", "storageKey");
    const checksumValue = text(candidate, "sha256", "checksumSha256");
    const sizeBytes = Number(candidate.sizeBytes);
    if (!sourceId || !storageKey || storageKey.startsWith("/") || storageKey.split(/[\\/]+/).some((part) => part === "..") || !checksumValue || !/^[a-f0-9]{64}$/.test(checksumValue) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error("restricted_source_binary_binding_invalid");
    }
    const checksumSha256 = checksumValue;
    const versionKey = `${sourceCollection}\u0000${sourceId}\u0000${checksumSha256}`;
    const row: SourceBinaryRow = {
      id: restrictedSourceBinaryId(context.importRun.system, sourceCollection, sourceId, checksumSha256),
      system: context.importRun.system,
      sourceCollection,
      sourceId,
      importRunId: context.importRun.id,
      storageKey,
      checksumSha256: checksumSha256 as string,
      sizeBytes,
      contentType: text(candidate, "contentType", "mimeType"),
    };
    const prior = rows.get(versionKey);
    if (prior && (prior.storageKey !== row.storageKey || prior.sizeBytes !== row.sizeBytes || prior.contentType !== row.contentType)) {
      // A checksum is the binary version.  The same version cannot point to
      // two archive locations or claim two sizes/content types; silently
      // choosing one would make a retry/audit non-deterministic.
      throw new Error("restricted_source_binary_version_conflict");
    }
    rows.set(versionKey, prior ?? row);
  }
  return Array.from(rows.values()).sort((left, right) => left.id.localeCompare(right.id));
}

type RestrictedPayloadConflictRow = {
  id?: unknown;
  system?: unknown;
  source_collection?: unknown;
  source_id?: unknown;
  source_updated_at?: unknown;
  checksum_sha256?: unknown;
};

type RestrictedBinaryConflictRow = {
  id?: unknown;
  system?: unknown;
  source_collection?: unknown;
  source_id?: unknown;
  storage_key?: unknown;
  checksum_sha256?: unknown;
  size_bytes?: unknown;
  content_type?: unknown;
};

function sameValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? "");
  return normalize(left) === normalize(right);
}

async function insertPayloadAndVerify(executor: RentOpsQueryExecutor, row: SourcePayloadRow): Promise<void> {
  const values = [row.id, row.system, row.sourceCollection, row.sourceId, row.sourceUpdatedAt ?? null, row.canonicalPayload, row.checksumSha256, row.importRunId];
  let inserted: { rows: RestrictedPayloadConflictRow[] };
  try {
    inserted = await executor.query<RestrictedPayloadConflictRow>(
      "INSERT INTO rent_ops_source_payloads (id, system, source_collection, source_id, source_updated_at, payload, checksum_sha256, import_run_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (system, source_collection, source_id, checksum_sha256) DO NOTHING RETURNING id, system, source_collection, source_id, source_updated_at, checksum_sha256",
      values,
    );
  } catch {
    throw new Error("restricted_source_payload_persistence_failed");
  }
  const expected = {
    id: row.id,
    system: row.system,
    source_collection: row.sourceCollection,
    source_id: row.sourceId,
    source_updated_at: row.sourceUpdatedAt ?? null,
    checksum_sha256: row.checksumSha256,
  };
  if (inserted.rows.length > 0) {
    const actual = inserted.rows[0]!;
    if (Object.keys(expected).some((field) => !sameValue(expected[field as keyof typeof expected], actual[field as keyof RestrictedPayloadConflictRow])) ) {
      throw new Error("restricted_source_payload_conflict");
    }
    return;
  }
  let existing: { rows: RestrictedPayloadConflictRow[] };
  try {
    existing = await executor.query<RestrictedPayloadConflictRow>(
      "SELECT id, system, source_collection, source_id, source_updated_at, checksum_sha256 FROM rent_ops_source_payloads WHERE system = $1 AND source_collection = $2 AND source_id = $3 AND checksum_sha256 = $4",
      [row.system, row.sourceCollection, row.sourceId, row.checksumSha256],
    );
  } catch {
    throw new Error("restricted_source_payload_persistence_failed");
  }
  const actual = existing.rows[0];
  if (existing.rows.length !== 1 || !actual || Object.keys(expected).some((field) => !sameValue(expected[field as keyof typeof expected], actual[field as keyof RestrictedPayloadConflictRow]))) {
    throw new Error("restricted_source_payload_conflict");
  }
}

async function insertBinaryAndVerify(executor: RentOpsQueryExecutor, row: SourceBinaryRow): Promise<void> {
  const values = [row.id, row.system, row.sourceCollection, row.sourceId, row.importRunId, row.storageKey, row.checksumSha256, row.sizeBytes, row.contentType ?? null];
  let inserted: { rows: RestrictedBinaryConflictRow[] };
  try {
    inserted = await executor.query<RestrictedBinaryConflictRow>(
      "INSERT INTO rent_ops_source_binaries (id, system, source_collection, source_id, import_run_id, storage_key, checksum_sha256, size_bytes, content_type, verification_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'verified') ON CONFLICT (system, source_collection, source_id, checksum_sha256) DO NOTHING RETURNING id, system, source_collection, source_id, storage_key, checksum_sha256, size_bytes, content_type",
      values,
    );
  } catch {
    throw new Error("restricted_source_binary_persistence_failed");
  }
  const expected = {
    id: row.id,
    system: row.system,
    source_collection: row.sourceCollection,
    source_id: row.sourceId,
    storage_key: row.storageKey,
    checksum_sha256: row.checksumSha256,
    size_bytes: row.sizeBytes,
    content_type: row.contentType ?? null,
  };
  if (inserted.rows.length > 0) {
    const actual = inserted.rows[0]!;
    if (Object.keys(expected).some((field) => !sameValue(expected[field as keyof typeof expected], actual[field as keyof RestrictedBinaryConflictRow]))) throw new Error("restricted_source_binary_conflict");
    return;
  }
  let existing: { rows: RestrictedBinaryConflictRow[] };
  try {
    existing = await executor.query<RestrictedBinaryConflictRow>(
      "SELECT id, system, source_collection, source_id, storage_key, checksum_sha256, size_bytes, content_type FROM rent_ops_source_binaries WHERE system = $1 AND source_collection = $2 AND source_id = $3 AND checksum_sha256 = $4",
      [row.system, row.sourceCollection, row.sourceId, row.checksumSha256],
    );
  } catch {
    throw new Error("restricted_source_binary_persistence_failed");
  }
  const actual = existing.rows[0];
  if (existing.rows.length !== 1 || !actual || Object.keys(expected).some((field) => !sameValue(expected[field as keyof typeof expected], actual[field as keyof RestrictedBinaryConflictRow]))) throw new Error("restricted_source_binary_conflict");
}

/**
 * The writer is injected into PersistenceImporter so raw JSON and normal facts
 * commit atomically. It emits no payload data and has no read/export surface.
 */
export function createRestrictedSourcePayloadWriter(): RestrictedSourcePayloadWriter {
  return async (executor: RentOpsQueryExecutor, context: RestrictedSourcePayloadPersistenceContext): Promise<void> => {
    for (const row of sourcePayloadRows(context)) {
      await insertPayloadAndVerify(executor, row);
    }
    for (const row of sourceBinaryRows(context)) {
      await insertBinaryAndVerify(executor, row);
    }
  };
}

/** Redacted controls for audit/tests; never returns payloads or source IDs. */
export function restrictedSourcePayloadControlSummary(context: RestrictedSourcePayloadPersistenceContext): {
  payloadCount: number;
  binaryCount: number;
  collectionCounts: Record<string, number>;
  checksumSetSha256: string;
  versionSetSha256: string;
  ambiguousIdentityCount: number;
  ambiguousVersionCount: number;
  ambiguityDigestSha256: string;
  blockingReasons: readonly string[];
} {
  const payloads = sourcePayloadRows(context);
  const binaries = sourceBinaryRows(context);
  const collectionCounts: Record<string, number> = {};
  for (const row of payloads) collectionCounts[row.sourceCollection] = (collectionCounts[row.sourceCollection] ?? 0) + 1;
  const versionsByIdentity = new Map<string, Set<string>>();
  for (const row of payloads) {
    const key = `${row.sourceCollection}\u0000${row.sourceId}`;
    const versions = versionsByIdentity.get(key) ?? new Set<string>();
    versions.add(row.checksumSha256);
    versionsByIdentity.set(key, versions);
  }
  const ambiguous = Array.from(versionsByIdentity.entries())
    .filter(([, versions]) => versions.size > 1)
    .map(([identity, versions]) => ({ identitySha256: sha256(identity), versionChecksums: Array.from(versions).sort() }))
    .sort((left, right) => left.identitySha256.localeCompare(right.identitySha256));
  const ambiguousVersionCount = ambiguous.reduce((total, item) => total + item.versionChecksums.length, 0);
  return {
    payloadCount: payloads.length,
    binaryCount: binaries.length,
    collectionCounts,
    checksumSetSha256: sha256(payloads.map((row) => row.checksumSha256).sort().join("\n")),
    versionSetSha256: sha256(payloads.map((row) => `${row.sourceCollection}\u0000${row.sourceId}\u0000${row.checksumSha256}`).sort().join("\n")),
    ambiguousIdentityCount: ambiguous.length,
    ambiguousVersionCount,
    ambiguityDigestSha256: sha256(canonicalJson(ambiguous)),
    blockingReasons: ambiguous.length > 0 ? ["restricted_source_payload_ambiguous_version"] : [],
  };
}

/** Stable preflight blockers; callers never receive the source identity. */
export function restrictedSourcePayloadBlockingReasons(context: RestrictedSourcePayloadPersistenceContext): readonly string[] {
  return restrictedSourcePayloadControlSummary(context).blockingReasons;
}
