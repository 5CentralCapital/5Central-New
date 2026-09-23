import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../persistence";
import { createPostgresRentOpsRepository } from "../repositories/postgres";
import { createSyntheticRuntimeExecutor } from "../../company/testing/synthetic-database";
import { applySchemaMigration, inspectSchema } from "../../company/operations/production-schema";
import { storageError } from "./errors";
import {
  DocumentRelocationError,
  RELOCATION_TARGET_BACKEND,
  applyRelocation,
  copyObjects,
  inventoryBindings,
  planRelocation,
  readEffectiveBindings,
  readbackRelocation,
  validateManifest,
  type RelocationManifest,
  type RelocationSession,
  type SourceObjectReader,
  type TargetObjectReader,
  type TargetObjectWriter,
} from "./document-relocation";
import { parseArgs, runCommand, type Dependencies } from "../../../scripts/company/document-relocation";
import type { ObjectStat, StorageByteStream, StorageVerificationRecord, VerificationOptions } from "./types";

const GCS = "replit-managed-gcs";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function session(db: PGlite): RelocationSession {
  return { query: async (text, values) => ({ rows: (await db.query(text, values as unknown[] | undefined)).rows as never[] }) };
}

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
  return db;
}

async function bind(db: PGlite, documentId: string, bytes: Buffer, generation: string, backend = GCS): Promise<void> {
  const checksum = digest(bytes);
  await db.query("INSERT INTO rent_ops_documents(id,file_name,mime_type,type,state,storage_key,availability,storage_key_knowledge,size_bytes,checksum_sha256,verified_at) VALUES ($1,'lease.pdf','application/pdf','lease','verified',$2,'verified','source',$3,$4,now())", [documentId, `documents/${checksum}`, bytes.length, checksum]);
  await db.query(
    "INSERT INTO rent_ops_document_objects(document_id,binding_kind,backend,logical_key,checksum_sha256,size_bytes,immutable_generation,verified_at) VALUES ($1,'admin',$2,$3,$4,$5,$6,now())",
    [documentId, backend, `sha256:${checksum}`, checksum, bytes.length, generation],
  );
}

class FakeGcs implements SourceObjectReader {
  readonly objects = new Map<string, Buffer>();
  reads = 0;
  put(bytes: Buffer, generation: string) { this.objects.set(`sha256:${digest(bytes)}#${generation}`, bytes); }
  async openVerified(logicalKey: string, options: VerificationOptions) {
    this.reads += 1;
    const bytes = this.objects.get(`${logicalKey}#${options.immutableGeneration}`);
    if (!bytes) throw storageError("storage_object_not_found");
    const checksum = digest(bytes);
    if (checksum !== logicalKey.slice(7) || checksum !== options.expectedChecksumSha256) throw storageError("storage_checksum_mismatch");
    if (bytes.length !== options.expectedSizeBytes) throw storageError("storage_size_mismatch");
    return { stream: Readable.from([bytes]), verification: { checksumSha256: checksum, sizeBytes: bytes.length, verificationState: "verified" as const } };
  }
}

class FakeS3 implements TargetObjectWriter, TargetObjectReader {
  readonly objects = new Map<string, { version: string; bytes: Buffer }>();
  private next = 0;
  puts = 0;
  async putIfAbsent(input: { logicalKey: string; body: StorageByteStream; checksumSha256: string; sizeBytes: number }) {
    this.puts += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of input.body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== input.checksumSha256 || bytes.length !== input.sizeBytes) throw storageError("storage_checksum_mismatch");
    const existing = this.objects.get(input.logicalKey);
    if (existing) return { existed: true, immutableVersion: existing.version };
    const version = `s3v-${++this.next}`;
    this.objects.set(input.logicalKey, { version, bytes });
    return { existed: false, immutableVersion: version };
  }
  async stat(logicalKey: string, options: { immutableVersion?: string } = {}): Promise<ObjectStat | null> {
    const object = this.objects.get(logicalKey);
    if (!object || (options.immutableVersion && options.immutableVersion !== object.version)) return null;
    return { backend: RELOCATION_TARGET_BACKEND, logicalKey, checksumSha256: logicalKey.slice(7), sizeBytes: object.bytes.length, immutableVersion: object.version };
  }
  async verify(logicalKey: string, options: VerificationOptions = {}): Promise<StorageVerificationRecord> {
    const object = this.objects.get(logicalKey);
    if (!object || options.immutableVersion !== object.version) throw storageError("storage_object_not_found");
    const checksum = digest(object.bytes);
    if (checksum !== options.expectedChecksumSha256) throw storageError("storage_checksum_mismatch");
    return { backend: RELOCATION_TARGET_BACKEND, logicalKey, checksumSha256: checksum, sizeBytes: object.bytes.length, immutableVersion: object.version, verificationState: "verified", verifiedAt: new Date().toISOString() };
  }
}

function manifestFrom(objects: RelocationManifest["objects"], runId = "relocate-20260923"): RelocationManifest {
  return { format: "5central-document-relocation-manifest/v1", runId, fromBackend: GCS, toBackend: RELOCATION_TARGET_BACKEND, target: { endpointHost: "s3.us-west-2.amazonaws.com", bucket: "fivecentral-ops-test", prefix: "rent-ops/private" }, objects };
}

const lease = Buffer.from("%PDF-1.4 synthetic lease A\n");
const shared = Buffer.from("%PDF-1.4 synthetic shared addendum\n");

test("migration 049: relocations continue the exact chain, are append-only, and the repository resolves the latest one", async () => {
  const db = await database();
  try {
    await bind(db, "doc-a", lease, "1700000000000001");
    const checksum = digest(lease);
    const runtime = await createSyntheticRuntimeExecutor(db);
    const repository = createPostgresRentOpsRepository(runtime);
    const original = await repository.getDocumentObjectBinding("doc-a");
    assert.equal(original?.backend, GCS);
    assert.equal(original?.immutableGeneration, "1700000000000001");

    const insert = (overrides: Record<string, unknown> = {}) => {
      const row = { document_id: "doc-a", relocation_sequence: 1, from_backend: GCS, from_generation: "1700000000000001", from_version: null, to_backend: RELOCATION_TARGET_BACKEND, to_version: "s3v-1", logical_key: `sha256:${checksum}`, checksum, size: lease.length, ...overrides };
      return db.query(
        `INSERT INTO rent_ops_document_object_relocations(document_id,relocation_sequence,relocation_run_id,from_backend,from_immutable_generation,from_immutable_version,to_backend,to_immutable_version,logical_key,checksum_sha256,size_bytes,verified_at,plan_sha256,authorization_reference)
         VALUES ($1,$2,'run-1',$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,'owner-20260923')`,
        [row.document_id, row.relocation_sequence, row.from_backend, row.from_generation, row.from_version, row.to_backend, row.to_version, row.logical_key, row.checksum, row.size, "a".repeat(64)],
      );
    };
    const other = digest(shared);
    await assert.rejects(insert({ logical_key: `sha256:${other}`, checksum: other }), /content_mismatch/);
    await assert.rejects(insert({ size: lease.length + 1 }), /content_mismatch/);
    await assert.rejects(insert({ from_generation: "999" }), /source_stale/);
    await assert.rejects(insert({ relocation_sequence: 2 }), /sequence_gap/);
    await assert.rejects(insert({ to_backend: GCS, to_version: null }), /violates check constraint/);
    await insert();
    await assert.rejects(insert({ to_version: "s3v-2" }), /duplicate key|sequence_gap/);
    await assert.rejects(insert({ relocation_sequence: 2 }), /source_stale/, "the next relocation must start from the S3 object");
    await assert.rejects(db.query("UPDATE rent_ops_document_object_relocations SET to_immutable_version = 'forged'"), /history_is_immutable/);
    await assert.rejects(db.query("DELETE FROM rent_ops_document_object_relocations"), /history_is_immutable/);
    await assert.rejects(db.query("TRUNCATE rent_ops_document_object_relocations"), /history_is_immutable/);

    // The web role resolves relocations but can never record one.
    await assert.rejects(runtime.query("INSERT INTO rent_ops_document_object_relocations(document_id) VALUES ('doc-a')"), /permission denied/);
    const effective = await repository.getDocumentObjectBinding("doc-a");
    assert.equal(effective?.backend, RELOCATION_TARGET_BACKEND);
    assert.equal(effective?.immutableVersion, "s3v-1");
    assert.equal(effective?.immutableGeneration, undefined);
    assert.equal(effective?.checksumSha256, checksum);
    // A retried original save stays idempotent against the immutable original row.
    await repository.saveDocumentObjectBinding(original!);
    const [binding] = (await db.query<{ backend: string }>("SELECT backend FROM rent_ops_document_objects WHERE document_id = 'doc-a'")).rows;
    assert.equal(binding!.backend, GCS, "the original binding row is never rewritten");
  } finally {
    await db.close();
  }
});

test("copy verifies each distinct object at both ends, resumes, and records failures without stopping", async () => {
  const db = await database();
  try {
    await bind(db, "doc-a", lease, "11");
    await bind(db, "doc-b", shared, "22");
    await bind(db, "doc-c", shared, "22");
    const broken = Buffer.from("%PDF-1.4 synthetic document with corrupted source\n");
    await bind(db, "doc-d", broken, "44");
    const gcs = new FakeGcs();
    gcs.put(lease, "11");
    gcs.put(shared, "22");
    gcs.objects.set(`sha256:${digest(broken)}#44`, Buffer.from("tampered"));
    const s3 = new FakeS3();
    const bindings = await readEffectiveBindings(session(db));
    const inventory = inventoryBindings(bindings);
    assert.deepEqual(inventory.byBackend[GCS], { documents: 4, objects: 3, bytes: lease.length + shared.length + broken.length });

    const first = await copyObjects({ bindings, fromBackend: GCS, source: gcs, writer: s3, reader: s3, limit: 1 });
    assert.equal(first.copiedThisRun, 1);
    assert.equal(first.remaining, 2);
    const second = await copyObjects({ bindings, fromBackend: GCS, source: gcs, writer: s3, reader: s3, previous: first.objects });
    assert.equal(second.skippedAlreadyCopied, 1);
    assert.equal(second.copiedThisRun, 1);
    assert.equal(second.objects.length, 2);
    assert.deepEqual(second.failures.map(failure => failure.code), ["storage_checksum_mismatch"]);
    assert.equal(s3.puts, 2, "a corrupted source is never written to the target");
    await assert.rejects(copyObjects({ bindings, fromBackend: RELOCATION_TARGET_BACKEND, source: gcs, writer: s3, reader: s3 }), (error: unknown) => error instanceof DocumentRelocationError && error.code === "backend_invalid");
  } finally {
    await db.close();
  }
});

test("plan and apply relocate every document in one reviewed transaction and read back through the runtime reader", async () => {
  const db = await database();
  const s = session(db);
  try {
    await bind(db, "doc-a", lease, "11");
    await bind(db, "doc-b", shared, "22");
    await bind(db, "doc-c", shared, "22");
    await bind(db, "doc-local", Buffer.from("already elsewhere\n"), "7", "local-staging");
    const gcs = new FakeGcs();
    gcs.put(lease, "11");
    gcs.put(shared, "22");
    const s3 = new FakeS3();
    const copied = await copyObjects({ bindings: await readEffectiveBindings(s), fromBackend: GCS, source: gcs, writer: s3, reader: s3 });
    const manifest = validateManifest(JSON.parse(JSON.stringify(manifestFrom(copied.objects))));
    const options = { runId: "relocate-20260923", authorization: "michael-20260923-cutover", fromBackend: GCS };
    const plan = planRelocation(await readEffectiveBindings(s), manifest, options);
    assert.equal(plan.rows.length, 3);
    assert.equal(plan.objects, 2);
    assert.deepEqual(plan.missingDocumentIds, []);
    assert.throws(() => planRelocation([], manifest, { ...options, runId: "other-run" }), /different run/);
    assert.throws(() => planRelocation([], manifest, { ...options, authorization: "has space" }), /authorization/);

    await assert.rejects(applyRelocation(s, manifest, { ...options, confirmPlanSha256: "0".repeat(64), reader: s3 }), (error: unknown) => error instanceof DocumentRelocationError && error.code === "plan_changed");
    // A target object missing at apply time blocks the whole batch.
    const saved = s3.objects.get(plan.rows[0]!.logicalKey)!;
    s3.objects.delete(plan.rows[0]!.logicalKey);
    await assert.rejects(applyRelocation(s, manifest, { ...options, confirmPlanSha256: plan.planSha256, reader: s3 }), (error: unknown) => error instanceof DocumentRelocationError && error.code === "target_check_failed");
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM rent_ops_document_object_relocations")).rows[0]!.n, 0);
    s3.objects.set(plan.rows[0]!.logicalKey, saved);

    const result = await applyRelocation(s, manifest, { ...options, confirmPlanSha256: plan.planSha256, reader: s3, rehash: true });
    assert.equal(result.relocated, 3);
    assert.equal(result.objectsChecked, 2);
    assert.deepEqual(result.readback.byBackend[RELOCATION_TARGET_BACKEND], { documents: 3, objects: 2, bytes: lease.length + shared.length });
    assert.equal(result.readback.byBackend["local-staging"]?.documents, 1, "other backends are untouched");
    const stored = (await db.query<{ plan_sha256: string; authorization_reference: string; relocation_run_id: string }>("SELECT DISTINCT plan_sha256, authorization_reference, relocation_run_id FROM rent_ops_document_object_relocations")).rows;
    assert.deepEqual(stored, [{ plan_sha256: plan.planSha256, authorization_reference: options.authorization, relocation_run_id: options.runId }]);

    const again = planRelocation(await readEffectiveBindings(s), manifest, options);
    assert.equal(again.rows.length, 0);
    assert.equal(again.alreadyOnTarget, 3);
    await assert.rejects(applyRelocation(s, manifest, { ...options, confirmPlanSha256: again.planSha256, reader: s3 }), (error: unknown) => error instanceof DocumentRelocationError && error.code === "plan_empty");

    const readback = await readbackRelocation(s, s3);
    assert.equal(readback.verified, 2);
    assert.deepEqual(readback.failures, []);
    s3.objects.get(plan.rows[0]!.logicalKey)!.version = "replaced";
    const drift = await readbackRelocation(s, s3, { sample: 1 });
    assert.equal(drift.verified + drift.failures.length, 1);
  } finally {
    await db.close();
  }
});

test("apply refuses an incomplete copy unless partial relocation is explicit", async () => {
  const db = await database();
  const s = session(db);
  try {
    await bind(db, "doc-a", lease, "11");
    await bind(db, "doc-b", shared, "22");
    const gcs = new FakeGcs();
    gcs.put(lease, "11");
    const s3 = new FakeS3();
    const copied = await copyObjects({ bindings: await readEffectiveBindings(s), fromBackend: GCS, source: gcs, writer: s3, reader: s3 });
    assert.equal(copied.failures.length, 1);
    const manifest = manifestFrom(copied.objects);
    const options = { runId: "relocate-20260923", authorization: "owner-ref", fromBackend: GCS };
    const plan = planRelocation(await readEffectiveBindings(s), manifest, options);
    assert.deepEqual(plan.missingDocumentIds, ["doc-b"]);
    await assert.rejects(applyRelocation(s, manifest, { ...options, confirmPlanSha256: plan.planSha256, reader: s3 }), (error: unknown) => error instanceof DocumentRelocationError && error.code === "plan_incomplete");
    const result = await applyRelocation(s, manifest, { ...options, confirmPlanSha256: plan.planSha256, reader: s3, allowPartial: true });
    assert.equal(result.relocated, 1);
    assert.equal(result.readback.byBackend[GCS]?.documents, 1);
  } finally {
    await db.close();
  }
});

test("manifests are validated before use", () => {
  const good = manifestFrom([{ logicalKey: `sha256:${digest(lease)}`, checksumSha256: digest(lease), sizeBytes: lease.length, fromImmutableGeneration: "11", fromImmutableVersion: null, toImmutableVersion: "v1", existed: false, verifiedAt: "2026-09-23T20:00:00.000Z" }]);
  assert.equal(validateManifest(good).objects.length, 1);
  assert.throws(() => validateManifest({ ...good, toBackend: GCS }), /target backend/);
  assert.throws(() => validateManifest({ ...good, objects: [{ ...good.objects[0], checksumSha256: "b".repeat(64) }] }), /disagree/);
  assert.throws(() => validateManifest({ ...good, objects: [{ ...good.objects[0], toImmutableVersion: null }] }), /target version/);
  assert.throws(() => validateManifest({ ...good, objects: [good.objects[0], good.objects[0]] }), /twice/);
});

test("CLI: copy writes a private resumable manifest, plan prints the digest, apply needs the digest and the flag", async () => {
  const db = await database();
  try {
    await bind(db, "doc-a", lease, "11");
    await bind(db, "doc-b", shared, "22");
    const gcs = new FakeGcs();
    gcs.put(lease, "11");
    gcs.put(shared, "22");
    const s3 = new FakeS3();
    const logs: string[] = [];
    const deps: Dependencies = {
      open: async () => ({ session: session(db), close: async () => undefined }),
      source: async () => gcs,
      writer: () => s3,
      reader: () => s3,
      log: line => logs.push(line),
    };
    const env = {
      RENT_OPS_MIGRATION_DATABASE_URL: "postgresql://owner@db.invalid/rent_ops_production",
      RENT_OPS_RELOCATION_TARGET_ENDPOINT: "https://s3.us-west-2.amazonaws.com",
      RENT_OPS_RELOCATION_TARGET_REGION: "us-west-2",
      RENT_OPS_RELOCATION_TARGET_BUCKET: "fivecentral-ops-test",
      RENT_OPS_RELOCATION_TARGET_PREFIX: "rent-ops/private",
      RENT_OPS_RELOCATION_TARGET_IMPORTER_IDENTITY: "AKIAWRITER",
      RENT_OPS_RELOCATION_TARGET_IMPORTER_TOKEN: "writer-secret",
      RENT_OPS_RELOCATION_TARGET_RUNTIME_IDENTITY: "AKIAREADER",
      RENT_OPS_RELOCATION_TARGET_RUNTIME_TOKEN: "reader-secret",
    } as NodeJS.ProcessEnv;
    const manifestPath = join(mkdtempSync(join(tmpdir(), "relocation-")), "manifest.json");
    assert.throws(() => parseArgs(["copy", "--bogus"]), /Unknown option/);
    await assert.rejects(runCommand(parseArgs(["copy", "--manifest", manifestPath, "--run-id", "r1"]), { ...env, RENT_OPS_RELOCATION_TARGET_RUNTIME_IDENTITY: "AKIAWRITER" }, deps), /must differ/);

    const partial = await runCommand(parseArgs(["copy", "--manifest", manifestPath, "--run-id", "relocate-20260923", "--limit", "1"]), env, deps);
    assert.equal(partial.remaining, 1);
    assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    const full = await runCommand(parseArgs(["copy", "--manifest", manifestPath, "--run-id", "relocate-20260923"]), env, deps);
    assert.equal(full.objectsInManifest, 2);
    assert.equal(full.remaining, 0);
    assert.ok(!readFileSync(manifestPath, "utf8").includes("secret"), "credentials never enter the manifest");
    await assert.rejects(runCommand(parseArgs(["copy", "--manifest", manifestPath, "--run-id", "another-run"]), env, deps), /another run/);

    const plan = await runCommand(parseArgs(["plan", "--manifest", manifestPath, "--run-id", "relocate-20260923", "--authorization", "owner-20260923"]), env, deps);
    assert.equal(plan.documentsToRelocate, 2);
    const planSha256 = String(plan.planSha256);
    const apply = ["apply", "--manifest", manifestPath, "--run-id", "relocate-20260923", "--authorization", "owner-20260923", "--confirm", planSha256];
    await assert.rejects(runCommand(parseArgs(apply), env, deps), /--apply-reviewed/);
    await assert.rejects(runCommand(parseArgs([...apply, "--apply-reviewed"]), { ...env, RENT_OPS_RELOCATION_TARGET_BUCKET: "some-other-bucket" }, deps), /differs from the manifest/);
    const applied = await runCommand(parseArgs([...apply, "--apply-reviewed"]), env, deps);
    assert.equal(applied.relocated, 2);
    const readback = await runCommand(parseArgs(["readback"]), env, deps);
    assert.equal(readback.verifiedObjects, 2);
    assert.equal(readback.failureCount, 0);
    assert.ok(logs.some(line => line.startsWith("copied")));
    assert.ok(!JSON.stringify([partial, full, plan, applied, readback]).includes("db.invalid"), "connection strings are never echoed");
  } finally {
    await db.close();
  }
});

test("inventory and copy work on a database that has not received migration 049 yet", async () => {
  const db = new PGlite();
  try {
    const s = session(db);
    const plan = await inspectSchema(s, 48);
    await applySchemaMigration(s, { throughVersion: 48, confirmPlanSha256: plan.planSha256 });
    await bind(db, "doc-a", lease, "11");
    const bindings = await readEffectiveBindings(s);
    assert.deepEqual(bindings.map(binding => [binding.documentId, binding.backend, binding.relocationSequence]), [["doc-a", GCS, 0]]);
    const gcs = new FakeGcs();
    gcs.put(lease, "11");
    const s3 = new FakeS3();
    const copied = await copyObjects({ bindings, fromBackend: GCS, source: gcs, writer: s3, reader: s3 });
    assert.equal(copied.objects.length, 1);
  } finally {
    await db.close();
  }
});
