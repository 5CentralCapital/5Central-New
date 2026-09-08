import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, rentOpsMigrationDefinitions, RENT_OPS_REQUIRED_TABLES, RENT_OPS_SCHEMA_VERSION } from "../persistence";
import { createRentOpsSecurityManifest, renderRentOpsSecuritySql, RENT_OPS_APPLICATION_TABLES, RENT_OPS_RUNTIME_EPHEMERAL_TABLES } from "../security/deployment-security";

// Always isolated in-memory PostgreSQL; never uses any environment database URL.
test("complete immutable migration chain replays and enforces actual role boundaries", async () => {
  assert.equal(RENT_OPS_SCHEMA_VERSION, rentOpsMigrationDefinitions().length);
  assert.equal(RENT_OPS_SCHEMA_VERSION, rentOpsMigrationDefinitions().at(-1)!.version);
  const db = new PGlite();
  try {
    for (let run = 0; run < 2; run++) {
      await ensureRentOpsSchema({ apply: true, query: sql => db.query(sql), executor: async (statement) => { await db.exec(statement); } });
      const versions = await db.query<{ version: number; checksum_sha256: string }>("SELECT version, checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version");
      assert.deepEqual(versions.rows, rentOpsMigrationDefinitions().map(m => ({ version: m.version, checksum_sha256: m.checksum })));
    }
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    for (const name of RENT_OPS_REQUIRED_TABLES) assert.ok(tables.rows.some(t => t.table_name === name), name);
    const manifest = createRentOpsSecurityManifest("staging", {
      gates: { backupVerified: true, backupAttestation: "synthetic-backup", independentAuditVerified: true, independentAuditAttestation: "synthetic-audit", schemaChecksumSha256: rentOpsMigrationDefinitions().at(-1)!.checksum },
      roleAttestation: { runtimeRoleIsNotRestrictedTableOwner: true, runtimeRoleNoInherit: true, importerRoleIsDistinct: true, auditorRoleIsDistinct: true, auditorRoleNoInherit: true },
    });
    for (const role of [manifest.target.runtimeRole, manifest.target.importerRole, manifest.target.auditorRole]) await db.exec(`CREATE ROLE "${role}"`);
    await db.exec(renderRentOpsSecuritySql(manifest, { mode: "apply" }).sql);
    for (const table of RENT_OPS_APPLICATION_TABLES) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const result = await db.query<{ runtime: boolean; importer: boolean }>("SELECT has_table_privilege($1, $3, $4) AS runtime, has_table_privilege($2, $3, $4) AS importer", [manifest.target.runtimeRole, manifest.target.importerRole, table, privilege]);
        assert.equal(result.rows[0].importer, false, `${table} importer ${privilege}`);
        if (privilege === "DELETE") assert.equal(result.rows[0].runtime, (RENT_OPS_RUNTIME_EPHEMERAL_TABLES as readonly string[]).includes(table), `${table} runtime DELETE`);
        if (privilege === "SELECT") assert.equal(result.rows[0].runtime, true, `${table} runtime SELECT`);
      }
    }
    await db.exec("UPDATE rent_ops_schema_migrations SET checksum_sha256 = repeat('0',64) WHERE version = 13");
    await assert.rejects(() => ensureRentOpsSchema({ apply: true, query: sql => db.query(sql), executor: async statement => { await db.exec(statement); } }), /checksum_mismatch/);
  } finally { await db.close(); }
});
