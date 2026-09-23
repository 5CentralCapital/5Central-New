import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { rentOpsMigrationDefinitions } from "../../rent-ops/persistence";
import {
  ProductionSchemaError,
  applyRuntimeGrants,
  applySchemaMigration,
  compareBackup,
  describeSession,
  expectedTablePrivileges,
  inspectSchema,
  planRuntimeGrants,
  planSchemaMigration,
  verifyRuntimeGrants,
  type SchemaSession,
} from "./production-schema";
import { parseArgs, runCommand, type SessionHandle } from "../../../scripts/company/production-schema";

const definitions = rentOpsMigrationDefinitions();
const latest = definitions.length;

function session(db: PGlite): SchemaSession {
  return { query: async (text, values) => ({ rows: (await db.query(text, values)).rows as never[] }) };
}

function ledger(through: number) {
  return definitions.slice(0, through).map(definition => ({ version: definition.version, checksum_sha256: definition.checksum }));
}

async function migratedTo(through: number): Promise<PGlite> {
  const db = new PGlite();
  const s = session(db);
  const plan = await inspectSchema(s, through);
  await applySchemaMigration(s, { throughVersion: through, confirmPlanSha256: plan.planSha256 });
  return db;
}

function rejects(code: string) {
  return (error: unknown) => error instanceof ProductionSchemaError && error.code === code;
}

test("plan lists only the missing reviewed artifacts in order", () => {
  const plan = planSchemaMigration(ledger(42), 48);
  assert.equal(plan.installedThrough, 42);
  assert.deepEqual(plan.pending.map(item => item.version), [43, 44, 45, 46, 47, 48]);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.pending.every(item => item.statementCount > 0));
  assert.deepEqual(planSchemaMigration(ledger(48), 48).pending, []);
});

test("plan refuses drift, gaps, duplicates and databases ahead of the target or build", () => {
  const drifted = ledger(42);
  drifted[10] = { ...drifted[10]!, checksum_sha256: "0".repeat(64) };
  assert.throws(() => planSchemaMigration(drifted, 48), rejects("schema_checksum_mismatch"));
  assert.throws(() => planSchemaMigration(ledger(42).filter(row => row.version !== 7), 48), rejects("schema_chain_gap"));
  assert.throws(() => planSchemaMigration([...ledger(3), ledger(3)[2]!], 48), rejects("schema_ledger_duplicate"));
  assert.throws(() => planSchemaMigration(ledger(44), 43), rejects("schema_ahead_of_target"));
  assert.throws(() => planSchemaMigration([...ledger(latest), { version: latest + 1, checksum_sha256: "a".repeat(64) }], latest), rejects("schema_ahead_of_build"));
  assert.throws(() => planSchemaMigration([], latest + 1), rejects("schema_target_invalid"));
});

test("the plan digest changes when the installed ledger or target changes", () => {
  const a = planSchemaMigration(ledger(42), 48).planSha256;
  assert.notEqual(a, planSchemaMigration(ledger(43), 48).planSha256);
  assert.notEqual(a, planSchemaMigration(ledger(42), 47).planSha256);
  assert.equal(a, planSchemaMigration(ledger(42), 48).planSha256);
});

test("apply brings a version-42 database to 48 in one transaction and reads the ledger back", async () => {
  const db = await migratedTo(42);
  const s = session(db);
  const plan = await inspectSchema(s, 48);
  assert.deepEqual(plan.pending.map(item => item.version), [43, 44, 45, 46, 47, 48]);
  const result = await applySchemaMigration(s, { throughVersion: 48, confirmPlanSha256: plan.planSha256 });
  assert.deepEqual(result.applied, [43, 44, 45, 46, 47, 48]);
  assert.equal(result.installedThrough, 48);
  assert.equal((await inspectSchema(s, 48)).pending.length, 0);
  const tables = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('company_jobs','accounting_qbo_webhook_events','company_forecast_snapshots')");
  assert.equal(tables.rows[0]!.n, 3);
  await db.close();
});

test("apply refuses a stale or unreviewed digest and leaves the database untouched", async () => {
  const db = await migratedTo(42);
  const s = session(db);
  const reviewed = (await inspectSchema(s, 48)).planSha256;
  await assert.rejects(applySchemaMigration(s, { throughVersion: 48, confirmPlanSha256: "not-a-digest" }), rejects("schema_confirmation_invalid"));
  await assert.rejects(applySchemaMigration(s, { throughVersion: 47, confirmPlanSha256: reviewed }), rejects("schema_plan_changed"));
  // Someone else advanced the database after review.
  const step = await inspectSchema(s, 43);
  await applySchemaMigration(s, { throughVersion: 43, confirmPlanSha256: step.planSha256 });
  await assert.rejects(applySchemaMigration(s, { throughVersion: 48, confirmPlanSha256: reviewed }), rejects("schema_plan_changed"));
  assert.equal((await inspectSchema(s, 48)).installedThrough, 43);
  await db.close();
});

test("a failing migration statement rolls back every pending version", async () => {
  const db = await migratedTo(42);
  const s = session(db);
  // Pre-create a table that migration 46 creates so it fails part-way through the batch.
  await db.exec("CREATE TABLE company_jobs (id int)");
  const plan = await inspectSchema(s, 48);
  await assert.rejects(applySchemaMigration(s, { throughVersion: 48, confirmPlanSha256: plan.planSha256 }));
  const after = await inspectSchema(s, 48);
  assert.equal(after.installedThrough, 42);
  const intake = await db.query<{ present: string | null }>("SELECT to_regclass('public.company_intake_packets')::text AS present");
  assert.equal(intake.rows[0]!.present, null, "migration 43 must roll back with the failed batch");
  await db.close();
});

test("runtime grants apply from the security manifest and verify against live privileges", async () => {
  const db = await migratedTo(latest);
  const s = session(db);
  for (const role of ["ops_web", "ops_importer", "ops_auditor"]) await db.exec(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
  const plan = planRuntimeGrants({ runtimeRole: "ops_web", importerRole: "ops_importer", auditorRole: "ops_auditor" }, { backup: "neon-branch:rops-pre-v48", review: "operator-review", authorization: "owner-approval-20260923" }, "rent_ops_production");
  await assert.rejects(applyRuntimeGrants(s, plan, "0".repeat(64)), rejects("grant_plan_changed"));
  const result = await applyRuntimeGrants(s, plan, plan.grantSha256);
  assert.ok(result.verifiedTables > 50);
  assert.deepEqual(await verifyRuntimeGrants(s, plan), []);
  // Append-only tables never receive UPDATE; the webhook ledger is writable by the web role.
  const expected = expectedTablePrivileges(plan.statements).get("ops_web")!;
  assert.equal(expected.get("company_review_case_events")?.has("UPDATE"), false);
  assert.equal(expected.get("company_review_case_events")?.has("INSERT"), true);
  assert.equal(expected.get("rent_ops_schema_migrations")?.has("INSERT"), false);
  // Drift is reported.
  await db.exec('GRANT DELETE ON public.company_review_case_events TO "ops_web"');
  const drift = await verifyRuntimeGrants(s, plan);
  assert.ok(drift.some(item => item.role === "ops_web" && item.table === "company_review_case_events" && item.privilege === "DELETE" && item.actual));
  await db.close();
});

test("grants refuse missing roles and roll back", async () => {
  const db = await migratedTo(latest);
  const s = session(db);
  await db.exec('CREATE ROLE "ops_web" NOLOGIN NOINHERIT');
  const plan = planRuntimeGrants({ runtimeRole: "ops_web", importerRole: "ops_importer", auditorRole: "ops_auditor" }, { backup: "backup-ref", review: "review-ref", authorization: "auth-ref" }, "rent_ops_production");
  await assert.rejects(applyRuntimeGrants(s, plan, plan.grantSha256), rejects("grant_role_missing"));
  assert.throws(() => planRuntimeGrants({ runtimeRole: "Bad-Role", importerRole: "i", auditorRole: "a" }, { backup: "backup-ref", review: "review-ref", authorization: "auth-ref" }, "db"), rejects("grant_role_invalid"));
  assert.throws(() => planRuntimeGrants({ runtimeRole: "w", importerRole: "i", auditorRole: "a" }, { backup: "has space", review: "review-ref", authorization: "auth-ref" }, "db"), rejects("grant_attestation_invalid"));
  await db.close();
});

test("backup comparison proves the copy has the same ledger and row counts", async () => {
  const source = await migratedTo(42);
  const backup = await migratedTo(42);
  const same = await compareBackup(session(source), session(backup));
  assert.equal(same.matches, true);
  assert.ok(same.tables > 20);
  await source.exec("INSERT INTO rent_ops_schema_meta (version) VALUES (9999)");
  const differs = await compareBackup(session(source), session(backup));
  assert.equal(differs.matches, false);
  assert.equal(differs.ledgerMatches, true);
  assert.deepEqual(differs.differingTables, ["rent_ops_schema_meta"]);
  const step = await inspectSchema(session(source), 43);
  await applySchemaMigration(session(source), { throughVersion: 43, confirmPlanSha256: step.planSha256 });
  assert.equal((await compareBackup(session(source), session(backup))).ledgerMatches, false);
  await source.close();
  await backup.close();
});

test("describe reports names and flags only", async () => {
  const db = await migratedTo(2);
  const facts = await describeSession(session(db));
  assert.equal(typeof facts.database, "string");
  assert.equal(facts.migrationLedgerOwner !== undefined, true);
  assert.ok(Array.isArray(facts.roles));
  assert.equal(JSON.stringify(facts).includes("postgres://"), false);
  await db.close();
});

test("CLI requires the reviewed digest, the explicit flag and a named connection variable", async () => {
  assert.throws(() => parseArgs(["migrate"]), rejects("cli_usage"));
  assert.throws(() => parseArgs(["apply", "--force"]), rejects("cli_usage"));
  const db = await migratedTo(42);
  const open = async (): Promise<SessionHandle> => ({ session: session(db), close: async () => undefined });
  const env = { RENT_OPS_MIGRATION_DATABASE_URL: "postgresql://owner@db.invalid/rent_ops_production" };
  const inspected = await runCommand(parseArgs(["inspect", "--through", "48"]), env, open);
  assert.equal(inspected.installedThrough, 42);
  assert.equal(JSON.stringify(inspected).includes("db.invalid"), false);
  await assert.rejects(runCommand(parseArgs(["apply", "--through", "48", "--confirm", String(inspected.planSha256)]), env, open), rejects("cli_usage"));
  await assert.rejects(runCommand(parseArgs(["inspect"]), {}, open), rejects("connection_missing"));
  await assert.rejects(runCommand(parseArgs(["inspect", "--url-env", "lower"]), env, open), rejects("cli_usage"));
  const applied = await runCommand(parseArgs(["apply", "--through", "48", "--confirm", String(inspected.planSha256), "--apply-reviewed"]), env, open);
  assert.equal(applied.installedThrough, 48);
  await db.close();
});
