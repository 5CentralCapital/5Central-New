import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { canonicalJson } from "../export/hash";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type { RestrictedSourcePayloadPersistenceContext } from "./persistence-importer";
import { createRestrictedSourcePayloadWriter, restrictedSourcePayloadControlSummary } from "./restricted-source-payloads";

function context(count: number, binaryCount = 0, padding = ""): RestrictedSourcePayloadPersistenceContext {
  return { input: { payload: {
    properties: Array.from({ length: count }, (_, i) => ({ sourceId: `row-${String(i).padStart(4, "0")}`, amount: i + 0.01, nested: { value: null, padding }, UpdateDate: "2026-09-01T12:00:00Z" })),
    documentBinaries: Array.from({ length: binaryCount }, (_, i) => ({ sourceId: `binary-${i}`, binaryAvailable: true, archivePath: `binaries/${i}.pdf`, sha256: "a".repeat(64), sizeBytes: i, contentType: "application/pdf" })),
  } }, importRun: { id: "run1", system: "rent_manager", startedAt: "2026-09-01T12:00:00Z", mode: "apply", counts: {}, exceptionCount: 0, status: "completed" }, sourceRecords: [], sourceManifestHash: "b".repeat(64) };
}

async function database() {
  const db = new PGlite();
  await db.exec("CREATE TABLE rent_ops_import_runs(id varchar(160) PRIMARY KEY); INSERT INTO rent_ops_import_runs VALUES ('run1'),('run2');");
  const migration = readFileSync(new URL("../migrations/001_rent_ops.sql", import.meta.url), "utf8");
  for (const table of ["rent_ops_source_payloads", "rent_ops_source_binaries"]) {
    const start = migration.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    await db.exec(migration.slice(start, migration.indexOf(";", start) + 1));
  }
  let calls = 0;
  const executor: RentOpsQueryExecutor = { async query<T>(sql: string, values: unknown[] = []) { calls += 1; return db.query<T>(sql, values); } };
  return { db, executor, calls: () => calls };
}

test("actual PG batches payload/binary insert and cross-run replay while preserving every stored field", async () => {
  const { db, executor, calls } = await database();
  try {
    const input = context(251, 251); // 502 payloads and 251 binaries => 3+2 batches
    const controls = restrictedSourcePayloadControlSummary(input);
    const writer = createRestrictedSourcePayloadWriter();
    await writer(executor, input);
    assert.equal(calls(), 5); // formerly 753 insert round trips
    const before = await db.query("SELECT * FROM rent_ops_source_payloads ORDER BY id");
    const binaries = await db.query("SELECT * FROM rent_ops_source_binaries ORDER BY id");
    assert.equal(before.rows.length, 502);
    assert.equal(binaries.rows.length, 251);
    const raw = (input.input as any).payload.properties[0];
    const actual = await db.query<{payload: unknown}>("SELECT payload FROM rent_ops_source_payloads WHERE source_collection='properties' AND source_id=$1", [raw.sourceId]);
    assert.equal(canonicalJson(actual.rows[0].payload), canonicalJson(raw));
    input.importRun.id = "run2";
    await writer(executor, input);
    assert.equal(calls(), 15); // replay 10 calls, formerly 1506
    assert.deepEqual((await db.query("SELECT * FROM rent_ops_source_payloads ORDER BY id")).rows, before.rows);
    assert.deepEqual((await db.query("SELECT * FROM rent_ops_source_binaries ORDER BY id")).rows, binaries.rows);
    assert.deepEqual(restrictedSourcePayloadControlSummary(input), controls);
  } finally { await db.close(); }
});

test("actual PG catches payload metadata and binary descriptor drift and rolls back earlier batches", async () => {
  const { db, executor } = await database();
  try {
    const writer = createRestrictedSourcePayloadWriter();
    await writer(executor, context(1, 1));
    await db.exec("UPDATE rent_ops_source_payloads SET source_updated_at='2020-01-01' WHERE source_collection='properties'");
    await assert.rejects(() => writer(executor, context(1, 1)), /restricted_source_payload_conflict/);
    await db.exec("UPDATE rent_ops_source_payloads SET source_updated_at='2026-09-01T12:00:00Z' WHERE source_collection='properties'; UPDATE rent_ops_source_binaries SET size_bytes=999");
    const before = await db.query("SELECT count(*)::int AS count FROM rent_ops_source_payloads");
    await db.exec("BEGIN");
    await assert.rejects(() => writer(executor, context(251, 1)), /restricted_source_binary_conflict/);
    await db.exec("ROLLBACK");
    assert.deepEqual((await db.query("SELECT count(*)::int AS count FROM rent_ops_source_payloads")).rows, before.rows);
  } finally { await db.close(); }
});

test("byte boundary batches large JSON and mixed insert/conflict reads only the conflicting subset", async () => {
  const { db, executor, calls } = await database();
  try {
    const writer = createRestrictedSourcePayloadWriter();
    await writer(executor, context(1));
    await writer(executor, context(2));
    assert.equal(calls(), 3); // one initial insert; mixed insert + one conflict read
    await writer(executor, context(3, 0, "x".repeat(600_000)));
    assert.equal(calls(), 6); // each > half the 1MiB payload budget
    assert.equal((await db.query<{count: number}>("SELECT count(*)::int AS count FROM rent_ops_source_payloads")).rows[0].count, 5);
  } finally { await db.close(); }
});

test("batch verification rejects duplicate returned identities and incomplete conflict readback", async () => {
  const { db, executor } = await database();
  try {
    const duplicate: RentOpsQueryExecutor = { async query<T>(sql: string, values: unknown[] = []) {
      const result = await executor.query<T>(sql, values);
      return { rows: result.rows.length ? [...result.rows, result.rows[0]] : result.rows };
    } };
    await assert.rejects(() => createRestrictedSourcePayloadWriter()(duplicate, context(2)), /restricted_source_payload_conflict/);
    const missing: RentOpsQueryExecutor = { async query<T>(sql: string, values: unknown[] = []) {
      const result = await executor.query<T>(sql, values);
      return { rows: sql.startsWith("SELECT") ? result.rows.slice(1) : result.rows };
    } };
    await assert.rejects(() => createRestrictedSourcePayloadWriter()(missing, context(2)), /restricted_source_payload_conflict/);
  } finally { await db.close(); }
});
