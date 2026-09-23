/**
 * Verified document relocation (storage provider move).
 *
 * Verified document bindings pin one exact object version in one backend and
 * are immutable. Moving from Replit-managed GCS to the private versioned S3
 * bucket happens in three separately reviewable steps:
 *
 *   1. copy     — read every source object at its pinned generation (verifying
 *                 its SHA-256 and size), write it to the target under the same
 *                 content-addressed key, then read it back through the
 *                 target's runtime identity at the exact new version. Produces
 *                 a manifest. No database writes.
 *   2. plan     — join the manifest with the live effective bindings into one
 *                 relocation row per document and a digest of exactly what
 *                 would be written. Read-only.
 *   3. apply    — re-check each target object version, then insert the rows in
 *                 one transaction (append-only table, chain-checked by a
 *                 trigger) only if the recomputed plan matches the reviewed
 *                 digest, and read the effective bindings back.
 *
 * Nothing here deletes or overwrites provider objects or binding history.
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { isStorageError } from "./errors";
import { checksumForLogicalKey, normalizeLogicalKey } from "./keys";
import type { ObjectStat, StorageByteStream, StorageVerificationRecord, StorageVersionOptions, VerificationOptions } from "./types";

export const RELOCATION_MANIFEST_FORMAT = "5central-document-relocation-manifest/v1" as const;
export const RELOCATION_TARGET_BACKEND = "private-versioned-object-store" as const;
export const REPLIT_MANAGED_GCS_BACKEND = "replit-managed-gcs" as const;
export const DOCUMENT_RELOCATION_LOCK_KEY = 5_243_113_706;

export interface RelocationSession {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export class DocumentRelocationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "DocumentRelocationError";
  }
}

const RUN_ID = /^[A-Za-z0-9_.:-]{3,160}$/;
const REFERENCE = /^[A-Za-z0-9_.:/-]{3,160}$/;
const BACKEND = /^[A-Za-z0-9_.:-]{1,80}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function versionText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text || text.length > 256 || /[\0\r\n]/.test(text)) throw new DocumentRelocationError("version_invalid", "An object version is malformed");
  return text;
}

/* ----------------------------- effective bindings ---------------------------- */

export interface EffectiveBinding {
  readonly documentId: string;
  readonly backend: string;
  readonly logicalKey: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly immutableGeneration: string | null;
  readonly immutableVersion: string | null;
  /** 0 when the binding was never relocated. */
  readonly relocationSequence: number;
}

/**
 * Every binding overlaid with its latest relocation, ordered by document id.
 * Before migration 049 exists (the copy step may run first) every binding is
 * its original row.
 */
export async function readEffectiveBindings(session: RelocationSession): Promise<EffectiveBinding[]> {
  const table = (await session.query<{ present: string | null }>("SELECT to_regclass('public.rent_ops_document_object_relocations')::text AS present")).rows[0];
  const relocations = Boolean(table?.present);
  const rows = (await session.query<Record<string, unknown>>(relocations ? RELOCATED_BINDINGS_SQL : ORIGINAL_BINDINGS_SQL)).rows;
  return rows.map(row => {
    const logicalKey = normalizeLogicalKey(String(row.logical_key));
    const checksumSha256 = String(row.checksum_sha256);
    if (checksumForLogicalKey(logicalKey) !== checksumSha256) throw new DocumentRelocationError("binding_invalid", "A binding's key and checksum disagree", { documentId: String(row.document_id) });
    const sizeBytes = Number(row.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new DocumentRelocationError("binding_invalid", "A binding's size is invalid", { documentId: String(row.document_id) });
    return {
      documentId: String(row.document_id),
      backend: String(row.backend),
      logicalKey,
      checksumSha256,
      sizeBytes,
      immutableGeneration: versionText(row.immutable_generation),
      immutableVersion: versionText(row.immutable_version),
      relocationSequence: Number(row.relocation_sequence),
    };
  });
}

const ORIGINAL_BINDINGS_SQL = `SELECT document_id, backend, logical_key, checksum_sha256, size_bytes, immutable_generation, immutable_version, 0 AS relocation_sequence
  FROM rent_ops_document_objects ORDER BY document_id`;

const RELOCATED_BINDINGS_SQL = `SELECT o.document_id,
            CASE WHEN r.document_id IS NULL THEN o.backend ELSE r.to_backend END AS backend,
            o.logical_key, o.checksum_sha256, o.size_bytes,
            CASE WHEN r.document_id IS NULL THEN o.immutable_generation ELSE r.to_immutable_generation END AS immutable_generation,
            CASE WHEN r.document_id IS NULL THEN o.immutable_version ELSE r.to_immutable_version END AS immutable_version,
            COALESCE(r.relocation_sequence, 0) AS relocation_sequence
       FROM rent_ops_document_objects o
       LEFT JOIN LATERAL (
         SELECT document_id, to_backend, to_immutable_generation, to_immutable_version, relocation_sequence
           FROM rent_ops_document_object_relocations
          WHERE document_id = o.document_id
          ORDER BY relocation_sequence DESC
          LIMIT 1
       ) r ON true
      ORDER BY o.document_id`;

function objectKey(value: { logicalKey: string; immutableGeneration: string | null; immutableVersion: string | null }): string {
  return `${value.logicalKey}|g:${value.immutableGeneration ?? ""}|v:${value.immutableVersion ?? ""}`;
}

export interface BackendInventory {
  readonly documents: number;
  readonly objects: number;
  readonly bytes: number;
}

export interface BindingInventory {
  readonly documents: number;
  readonly byBackend: Readonly<Record<string, BackendInventory>>;
  readonly inventorySha256: string;
}

export function inventoryBindings(bindings: readonly EffectiveBinding[]): BindingInventory {
  const byBackend: Record<string, { documents: number; objects: Map<string, number> }> = {};
  for (const binding of bindings) {
    const entry = byBackend[binding.backend] ??= { documents: 0, objects: new Map() };
    entry.documents += 1;
    entry.objects.set(objectKey(binding), binding.sizeBytes);
  }
  const summary: Record<string, BackendInventory> = {};
  for (const [backend, entry] of Object.entries(byBackend).sort(([a], [b]) => a.localeCompare(b))) {
    summary[backend] = { documents: entry.documents, objects: entry.objects.size, bytes: Array.from(entry.objects.values()).reduce((sum, size) => sum + size, 0) };
  }
  const canonical = bindings.map(binding => [binding.documentId, binding.backend, binding.logicalKey, binding.sizeBytes, binding.immutableGeneration, binding.immutableVersion, binding.relocationSequence]);
  return { documents: bindings.length, byBackend: summary, inventorySha256: sha256(JSON.stringify(canonical)) };
}

/* ------------------------------------ copy ----------------------------------- */

export interface SourceObjectReader {
  openVerified(logicalKey: string, options: VerificationOptions): Promise<{ stream: Readable | AsyncIterable<Uint8Array>; verification: Pick<StorageVerificationRecord, "checksumSha256" | "sizeBytes" | "verificationState"> }>;
}

export interface TargetObjectWriter {
  putIfAbsent(input: { logicalKey: string; body: StorageByteStream; checksumSha256: string; sizeBytes: number }): Promise<{ existed: boolean; immutableVersion?: string; immutableGeneration?: string }>;
}

export interface TargetObjectReader {
  stat(logicalKey: string, options?: StorageVersionOptions): Promise<ObjectStat | null>;
  verify(logicalKey: string, options?: VerificationOptions): Promise<StorageVerificationRecord>;
}

export interface ManifestTarget {
  /** Host of the S3 endpoint, e.g. s3.us-west-2.amazonaws.com. */
  readonly endpointHost: string;
  readonly bucket: string;
  readonly prefix: string;
}

export interface CopiedObject {
  readonly logicalKey: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly fromImmutableGeneration: string | null;
  readonly fromImmutableVersion: string | null;
  readonly toImmutableVersion: string;
  readonly existed: boolean;
  readonly verifiedAt: string;
}

export interface RelocationManifest {
  readonly format: typeof RELOCATION_MANIFEST_FORMAT;
  readonly runId: string;
  readonly fromBackend: string;
  readonly toBackend: typeof RELOCATION_TARGET_BACKEND;
  readonly target: ManifestTarget;
  readonly objects: readonly CopiedObject[];
}

export interface CopyFailure {
  readonly logicalKey: string;
  readonly code: string;
}

export interface CopyOptions {
  readonly bindings: readonly EffectiveBinding[];
  readonly fromBackend: string;
  readonly source: SourceObjectReader;
  readonly writer: TargetObjectWriter;
  readonly reader: TargetObjectReader;
  /** Objects already copied by an earlier run of the same manifest. */
  readonly previous?: readonly CopiedObject[];
  readonly concurrency?: number;
  readonly limit?: number;
  readonly now?: () => Date;
  /** Called after each object so the caller can persist progress. */
  readonly onCopied?: (object: CopiedObject, done: number, total: number) => Promise<void> | void;
}

export interface CopyResult {
  readonly objects: readonly CopiedObject[];
  readonly copiedThisRun: number;
  readonly skippedAlreadyCopied: number;
  readonly remaining: number;
  readonly failures: readonly CopyFailure[];
}

function errorCode(error: unknown): string {
  if (isStorageError(error)) return error.code;
  if (error instanceof DocumentRelocationError) return error.code;
  return "copy_failed";
}

/** Copy each distinct source object once; never throws for a single object. */
export async function copyObjects(options: CopyOptions): Promise<CopyResult> {
  if (!BACKEND.test(options.fromBackend) || options.fromBackend === RELOCATION_TARGET_BACKEND) {
    throw new DocumentRelocationError("backend_invalid", "The source backend must differ from the target backend");
  }
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4));
  const now = options.now ?? (() => new Date());
  const pending = new Map<string, EffectiveBinding>();
  for (const binding of options.bindings) {
    if (binding.backend !== options.fromBackend) continue;
    if (binding.immutableGeneration === null && binding.immutableVersion === null) throw new DocumentRelocationError("binding_invalid", "A source binding has no pinned version", { documentId: binding.documentId });
    if (!pending.has(objectKey(binding))) pending.set(objectKey(binding), binding);
  }
  const done = new Map<string, CopiedObject>();
  for (const object of options.previous ?? []) {
    done.set(objectKey({ logicalKey: object.logicalKey, immutableGeneration: object.fromImmutableGeneration, immutableVersion: object.fromImmutableVersion }), object);
  }
  const queue = Array.from(pending.entries()).filter(([key]) => !done.has(key));
  const skippedAlreadyCopied = pending.size - queue.length;
  const selected = options.limit !== undefined ? queue.slice(0, Math.max(0, options.limit)) : queue;
  const failures: CopyFailure[] = [];
  let copiedThisRun = 0;
  let cursor = 0;
  const total = pending.size;

  const copyOne = async (binding: EffectiveBinding): Promise<CopiedObject> => {
    const pinned: StorageVersionOptions = {
      ...(binding.immutableGeneration !== null ? { immutableGeneration: binding.immutableGeneration } : {}),
      ...(binding.immutableVersion !== null ? { immutableVersion: binding.immutableVersion } : {}),
    };
    const opened = await options.source.openVerified(binding.logicalKey, { ...pinned, expectedChecksumSha256: binding.checksumSha256, expectedSizeBytes: binding.sizeBytes });
    if (opened.verification.verificationState !== "verified" || opened.verification.checksumSha256 !== binding.checksumSha256 || opened.verification.sizeBytes !== binding.sizeBytes) {
      throw new DocumentRelocationError("source_unverified", "The source object did not verify");
    }
    const put = await options.writer.putIfAbsent({ logicalKey: binding.logicalKey, body: opened.stream, checksumSha256: binding.checksumSha256, sizeBytes: binding.sizeBytes });
    const toImmutableVersion = versionText(put.immutableVersion);
    if (!toImmutableVersion || put.immutableGeneration !== undefined) throw new DocumentRelocationError("target_version_missing", "The target did not return an object version");
    // Read back through the runtime identity at the exact version the app will pin.
    const verified = await options.reader.verify(binding.logicalKey, { immutableVersion: toImmutableVersion, expectedChecksumSha256: binding.checksumSha256, expectedSizeBytes: binding.sizeBytes });
    if (verified.verificationState !== "verified" || verified.checksumSha256 !== binding.checksumSha256 || verified.sizeBytes !== binding.sizeBytes || verified.immutableVersion !== toImmutableVersion) {
      throw new DocumentRelocationError("target_unverified", "The target object did not verify at its exact version");
    }
    return {
      logicalKey: binding.logicalKey,
      checksumSha256: binding.checksumSha256,
      sizeBytes: binding.sizeBytes,
      fromImmutableGeneration: binding.immutableGeneration,
      fromImmutableVersion: binding.immutableVersion,
      toImmutableVersion,
      existed: put.existed,
      verifiedAt: now().toISOString(),
    };
  };

  const worker = async () => {
    while (cursor < selected.length) {
      const [key, binding] = selected[cursor++]!;
      try {
        const copied = await copyOne(binding);
        done.set(key, copied);
        copiedThisRun += 1;
        await options.onCopied?.(copied, done.size, total);
      } catch (error) {
        failures.push({ logicalKey: binding.logicalKey, code: errorCode(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, selected.length)) }, worker));
  const objects = Array.from(done.values()).sort((a, b) => objectKey({ logicalKey: a.logicalKey, immutableGeneration: a.fromImmutableGeneration, immutableVersion: a.fromImmutableVersion }).localeCompare(objectKey({ logicalKey: b.logicalKey, immutableGeneration: b.fromImmutableGeneration, immutableVersion: b.fromImmutableVersion })));
  const remaining = Array.from(pending.keys()).filter(key => !done.has(key)).length;
  return { objects, copiedThisRun, skippedAlreadyCopied, remaining, failures };
}

export function validateManifest(value: unknown): RelocationManifest {
  const fail = (message: string): never => { throw new DocumentRelocationError("manifest_invalid", message); };
  if (!value || typeof value !== "object") fail("The manifest is not an object");
  const manifest = value as Partial<RelocationManifest>;
  if (manifest.format !== RELOCATION_MANIFEST_FORMAT) fail("Unknown manifest format");
  if (typeof manifest.runId !== "string" || !RUN_ID.test(manifest.runId)) fail("The manifest run id is invalid");
  if (typeof manifest.fromBackend !== "string" || !BACKEND.test(manifest.fromBackend)) fail("The manifest source backend is invalid");
  if (manifest.toBackend !== RELOCATION_TARGET_BACKEND) fail("The manifest target backend is invalid");
  const target = manifest.target as Partial<ManifestTarget> | undefined;
  if (!target || typeof target.endpointHost !== "string" || typeof target.bucket !== "string" || typeof target.prefix !== "string") fail("The manifest target is incomplete");
  if (!Array.isArray(manifest.objects)) fail("The manifest has no objects");
  const seen = new Set<string>();
  for (const object of manifest.objects!) {
    if (!object || typeof object !== "object") fail("A manifest object is malformed");
    const logicalKey = normalizeLogicalKey(String(object.logicalKey));
    if (logicalKey !== object.logicalKey || checksumForLogicalKey(logicalKey) !== object.checksumSha256 || !SHA256.test(object.checksumSha256)) fail("A manifest object key and checksum disagree");
    if (!Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1) fail("A manifest object size is invalid");
    if (versionText(object.toImmutableVersion) === null) fail("A manifest object has no target version");
    const from = { logicalKey, immutableGeneration: versionText(object.fromImmutableGeneration), immutableVersion: versionText(object.fromImmutableVersion) };
    if (from.immutableGeneration === null && from.immutableVersion === null) fail("A manifest object has no source version");
    if (typeof object.verifiedAt !== "string" || !Number.isFinite(Date.parse(object.verifiedAt))) fail("A manifest object has no verification time");
    if (seen.has(objectKey(from))) fail("A manifest object is listed twice");
    seen.add(objectKey(from));
  }
  return manifest as RelocationManifest;
}

/* ------------------------------------ plan ----------------------------------- */

export interface RelocationRow {
  readonly documentId: string;
  readonly relocationSequence: number;
  readonly fromBackend: string;
  readonly fromImmutableGeneration: string | null;
  readonly fromImmutableVersion: string | null;
  readonly toBackend: string;
  readonly toImmutableVersion: string;
  readonly logicalKey: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly verifiedAt: string;
}

export interface RelocationPlan {
  readonly runId: string;
  readonly authorization: string;
  readonly fromBackend: string;
  readonly toBackend: string;
  readonly rows: readonly RelocationRow[];
  /** Documents still on the source backend with no copied object in the manifest. */
  readonly missingDocumentIds: readonly string[];
  /** Documents already on the target backend (e.g. relocated earlier). */
  readonly alreadyOnTarget: number;
  readonly objects: number;
  readonly bytes: number;
  readonly planSha256: string;
}

export interface PlanOptions {
  readonly runId: string;
  readonly authorization: string;
  readonly fromBackend: string;
}

export function planRelocation(bindings: readonly EffectiveBinding[], manifest: RelocationManifest, options: PlanOptions): RelocationPlan {
  if (!RUN_ID.test(options.runId)) throw new DocumentRelocationError("run_id_invalid", "The run id is invalid (letters, digits and _ . : - only)");
  if (!REFERENCE.test(options.authorization)) throw new DocumentRelocationError("authorization_invalid", "An authorization reference is required (letters, digits and _ . : / - only)");
  if (manifest.runId !== options.runId || manifest.fromBackend !== options.fromBackend) throw new DocumentRelocationError("manifest_mismatch", "The manifest was produced for a different run or source backend");
  const copied = new Map(manifest.objects.map(object => [objectKey({ logicalKey: object.logicalKey, immutableGeneration: object.fromImmutableGeneration, immutableVersion: object.fromImmutableVersion }), object]));
  const rows: RelocationRow[] = [];
  const missingDocumentIds: string[] = [];
  let alreadyOnTarget = 0;
  const usedObjects = new Map<string, number>();
  for (const binding of bindings) {
    if (binding.backend === manifest.toBackend) { alreadyOnTarget += 1; continue; }
    if (binding.backend !== options.fromBackend) continue;
    const object = copied.get(objectKey(binding));
    if (!object) { missingDocumentIds.push(binding.documentId); continue; }
    if (object.checksumSha256 !== binding.checksumSha256 || object.sizeBytes !== binding.sizeBytes) {
      throw new DocumentRelocationError("manifest_mismatch", "A manifest object does not match its binding", { documentId: binding.documentId });
    }
    usedObjects.set(object.toImmutableVersion + "|" + object.logicalKey, object.sizeBytes);
    rows.push({
      documentId: binding.documentId,
      relocationSequence: binding.relocationSequence + 1,
      fromBackend: binding.backend,
      fromImmutableGeneration: binding.immutableGeneration,
      fromImmutableVersion: binding.immutableVersion,
      toBackend: manifest.toBackend,
      toImmutableVersion: object.toImmutableVersion,
      logicalKey: binding.logicalKey,
      checksumSha256: binding.checksumSha256,
      sizeBytes: binding.sizeBytes,
      verifiedAt: object.verifiedAt,
    });
  }
  const canonical = {
    runId: options.runId,
    authorization: options.authorization,
    fromBackend: options.fromBackend,
    toBackend: manifest.toBackend,
    target: manifest.target,
    rows: rows.map(row => [row.documentId, row.relocationSequence, row.fromBackend, row.fromImmutableGeneration, row.fromImmutableVersion, row.toBackend, row.toImmutableVersion, row.logicalKey, row.sizeBytes, row.verifiedAt]),
  };
  return {
    runId: options.runId,
    authorization: options.authorization,
    fromBackend: options.fromBackend,
    toBackend: manifest.toBackend,
    rows,
    missingDocumentIds,
    alreadyOnTarget,
    objects: usedObjects.size,
    bytes: Array.from(usedObjects.values()).reduce((sum, size) => sum + size, 0),
    planSha256: sha256(JSON.stringify(canonical)),
  };
}

/* ------------------------------------ apply ---------------------------------- */

export interface ApplyOptions extends PlanOptions {
  readonly confirmPlanSha256: string;
  /** Required when documents on the source backend have no copied object. */
  readonly allowPartial?: boolean;
  /** Target reader for the pre-apply existence check of every object version. */
  readonly reader: TargetObjectReader;
  /** Full SHA-256 re-read of every object instead of an exact-version HEAD. */
  readonly rehash?: boolean;
}

export interface ApplyResult {
  readonly planSha256: string;
  readonly relocated: number;
  readonly objectsChecked: number;
  readonly readback: BindingInventory;
}

async function checkTargets(plan: RelocationPlan, reader: TargetObjectReader, rehash: boolean): Promise<number> {
  const unique = new Map<string, RelocationRow>();
  for (const row of plan.rows) unique.set(`${row.logicalKey}|${row.toImmutableVersion}`, row);
  const failures: CopyFailure[] = [];
  const entries = Array.from(unique.values());
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const row = entries[cursor++]!;
      try {
        if (rehash) {
          const verified = await reader.verify(row.logicalKey, { immutableVersion: row.toImmutableVersion, expectedChecksumSha256: row.checksumSha256, expectedSizeBytes: row.sizeBytes });
          if (verified.verificationState !== "verified" || verified.immutableVersion !== row.toImmutableVersion) throw new DocumentRelocationError("target_unverified", "Target did not verify");
        } else {
          const stat = await reader.stat(row.logicalKey, { immutableVersion: row.toImmutableVersion });
          if (!stat || stat.sizeBytes !== row.sizeBytes || stat.immutableVersion !== row.toImmutableVersion || stat.checksumSha256 !== row.checksumSha256) throw new DocumentRelocationError("target_missing", "Target object version is missing");
        }
      } catch (error) {
        failures.push({ logicalKey: row.logicalKey, code: errorCode(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, entries.length)) }, worker));
  if (failures.length) throw new DocumentRelocationError("target_check_failed", "Some target objects are not readable at their recorded version", { failures: failures.slice(0, 20), count: failures.length });
  return entries.length;
}

async function rollbackQuietly(session: RelocationSession): Promise<void> {
  try { await session.query("ROLLBACK"); } catch { /* the connection is discarded by the caller */ }
}

export async function applyRelocation(session: RelocationSession, manifest: RelocationManifest, options: ApplyOptions): Promise<ApplyResult> {
  if (!SHA256.test(options.confirmPlanSha256)) throw new DocumentRelocationError("confirm_invalid", "--confirm must be the planSha256 printed by plan");
  const preview = planRelocation(await readEffectiveBindings(session), manifest, options);
  if (preview.planSha256 !== options.confirmPlanSha256) throw new DocumentRelocationError("plan_changed", "The live bindings or manifest differ from the reviewed plan", { planSha256: preview.planSha256 });
  if (preview.missingDocumentIds.length && !options.allowPartial) {
    throw new DocumentRelocationError("plan_incomplete", "Some documents on the source backend have no copied object; finish the copy or pass --allow-partial", { missing: preview.missingDocumentIds.length });
  }
  if (!preview.rows.length) throw new DocumentRelocationError("plan_empty", "Nothing to relocate");
  const objectsChecked = await checkTargets(preview, options.reader, options.rehash === true);

  await session.query("BEGIN");
  try {
    await session.query("SET LOCAL lock_timeout = '15s'");
    await session.query("SET LOCAL statement_timeout = '10min'");
    const lock = (await session.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [DOCUMENT_RELOCATION_LOCK_KEY])).rows[0];
    if (!lock?.locked) throw new DocumentRelocationError("locked", "Another relocation is running");
    const plan = planRelocation(await readEffectiveBindings(session), manifest, options);
    if (plan.planSha256 !== options.confirmPlanSha256) throw new DocumentRelocationError("plan_changed", "The live bindings changed after the target check", { planSha256: plan.planSha256 });
    const column = <K extends keyof RelocationRow>(key: K) => plan.rows.map(row => row[key]);
    await session.query(
      `INSERT INTO rent_ops_document_object_relocations
         (document_id, relocation_sequence, relocation_run_id, from_backend, from_immutable_generation, from_immutable_version,
          to_backend, to_immutable_generation, to_immutable_version, logical_key, checksum_sha256, size_bytes, verified_at,
          plan_sha256, authorization_reference)
       SELECT r.document_id, r.relocation_sequence, $1, r.from_backend, r.from_generation, r.from_version,
              r.to_backend, NULL, r.to_version, r.logical_key, r.checksum_sha256, r.size_bytes, r.verified_at,
              $2, $3
         FROM unnest($4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::int[], $14::timestamptz[])
           AS r(document_id, relocation_sequence, from_backend, from_generation, from_version, to_backend, to_version, logical_key, checksum_sha256, size_bytes, verified_at)`,
      [
        plan.runId, plan.planSha256, plan.authorization,
        column("documentId"), column("relocationSequence"), column("fromBackend"), column("fromImmutableGeneration"), column("fromImmutableVersion"),
        column("toBackend"), column("toImmutableVersion"), column("logicalKey"), column("checksumSha256"), column("sizeBytes"), column("verifiedAt"),
      ],
    );
    const after = await readEffectiveBindings(session);
    const byId = new Map(after.map(binding => [binding.documentId, binding]));
    const mismatched = plan.rows.filter(row => {
      const binding = byId.get(row.documentId);
      return !binding || binding.backend !== row.toBackend || binding.immutableVersion !== row.toImmutableVersion || binding.immutableGeneration !== null || binding.relocationSequence !== row.relocationSequence;
    });
    if (mismatched.length) throw new DocumentRelocationError("readback_failed", "Effective bindings differ from the plan after inserting", { count: mismatched.length });
    await session.query("COMMIT");
    return { planSha256: plan.planSha256, relocated: plan.rows.length, objectsChecked, readback: inventoryBindings(after) };
  } catch (error) {
    await rollbackQuietly(session);
    throw error;
  }
}

/* ---------------------------------- readback --------------------------------- */

export interface ReadbackResult {
  readonly inventory: BindingInventory;
  readonly verified: number;
  readonly failures: readonly (CopyFailure & { documentId: string })[];
}

/**
 * Verify target-backend bindings through the runtime reader at their exact
 * versions (full SHA-256). `sample` limits the number of distinct objects.
 */
export async function readbackRelocation(session: RelocationSession, reader: TargetObjectReader, options: { sample?: number } = {}): Promise<ReadbackResult> {
  const bindings = await readEffectiveBindings(session);
  const onTarget = bindings.filter(binding => binding.backend === RELOCATION_TARGET_BACKEND);
  const unique = new Map<string, EffectiveBinding>();
  for (const binding of onTarget) if (!unique.has(objectKey(binding))) unique.set(objectKey(binding), binding);
  let entries = Array.from(unique.values());
  if (options.sample !== undefined && options.sample < entries.length) {
    // Deterministic spread across the id order rather than the first N.
    const step = entries.length / options.sample;
    entries = Array.from({ length: options.sample }, (_, index) => entries[Math.floor(index * step)]!);
  }
  const failures: (CopyFailure & { documentId: string })[] = [];
  let verified = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const binding = entries[cursor++]!;
      try {
        const result = await reader.verify(binding.logicalKey, { immutableVersion: binding.immutableVersion ?? undefined, expectedChecksumSha256: binding.checksumSha256, expectedSizeBytes: binding.sizeBytes });
        if (result.verificationState !== "verified" || result.immutableVersion !== binding.immutableVersion) throw new DocumentRelocationError("target_unverified", "Target did not verify");
        verified += 1;
      } catch (error) {
        failures.push({ documentId: binding.documentId, logicalKey: binding.logicalKey, code: errorCode(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, entries.length)) }, worker));
  return { inventory: inventoryBindings(bindings), verified, failures };
}
