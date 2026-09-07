import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureRentOpsSchema,
  rentOpsMigrationChecksum,
  rentOpsMigrationSql,
  renderRentOpsMigrationSql,
  RENT_OPS_MIGRATION_CHECKSUM_TOKEN,
  RENT_OPS_V2_MIGRATION_CHECKSUM_TOKEN,
  RENT_OPS_V8_MIGRATION_CHECKSUM_TOKEN,
  RENT_OPS_V9_MIGRATION_CHECKSUM_TOKEN,
  RENT_OPS_REQUIRED_TABLES,
  RENT_OPS_SUPPORTED_SCHEMA_VERSIONS,
  RENT_OPS_SCHEMA_VERSION,
  rentOpsMigrationDefinitions,
  rentOpsMigrationChecksumForVersion,
  splitRentOpsSqlStatements,
  renderRentOpsMigrationSqlForVersion,
} from "./persistence";

test("Rent Operations dry-run is read-only and exposes the version/checksum plan", async () => {
  let calls = 0;
  const result = await ensureRentOpsSchema({ apply: false, executor: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.mode, "dry_run");
  assert.equal(result.version, 13);
  assert.deepEqual(Object.keys(result.migrationChecksums ?? {}).map(Number), RENT_OPS_SUPPORTED_SCHEMA_VERSIONS);
  assert.ok(result.checksum.match(/^[a-f0-9]{64}$/));
  assert.ok(result.requiredTables.includes("rent_ops_schema_meta"));
  assert.ok(result.statementCount > RENT_OPS_REQUIRED_TABLES.length);
});

test("Rent Operations apply wraps the one SQL source in BEGIN/COMMIT", async () => {
  const statements: string[] = [];
  const result = await ensureRentOpsSchema({ apply: true, executor: async (statement) => { statements.push(statement); } });
  assert.equal(result.mode, "applied");
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(statements.length, result.statementCount);
  const body = statements.slice(1, -1).join(";\n");
  assert.ok(body.includes("rent_ops_schema_meta"));
  assert.ok(body.includes(result.checksum));
  assert.ok(!body.includes(RENT_OPS_MIGRATION_CHECKSUM_TOKEN));
});

test("Rent Operations apply rolls back and rethrows the original SQL error", async () => {
  const statements: string[] = [];
  await assert.rejects(
    () => ensureRentOpsSchema({ apply: true, executor: async (statement) => {
      statements.push(statement);
      if (statement.includes("rent_ops_units")) throw new Error("synthetic migration failure");
    } }),
    /synthetic migration failure/,
  );
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
});

test("migration checksum is deterministic and SQL splitting preserves quoted semicolons", () => {
  const sql = rentOpsMigrationSql();
  assert.equal(rentOpsMigrationChecksum(sql), rentOpsMigrationChecksum(sql.replace(/\r\n/g, "\n")));
  const statements = splitRentOpsSqlStatements("SELECT 'a;b'; -- comment ;\n SELECT 2;");
  assert.equal(statements.length, 2);
  assert.match(statements[0], /a;b/);
  assert.match(statements[1], /SELECT 2/);
});

test("rendered migration is operator-ready and contains no checksum placeholder", () => {
  const rendered = renderRentOpsMigrationSql();
  assert.equal(rendered.includes(RENT_OPS_MIGRATION_CHECKSUM_TOKEN), false);
  assert.match(rendered, /rent_ops_schema_checksum_guard/);
  assert.match(rendered, /CREATE UNIQUE INDEX IF NOT EXISTS rent_ops_tenancies_future_unit_unique/);
});

test("v2 migration renders strict nullable-fidelity constraints and a post-insert ordered checksum guard", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(2);
  assert.equal(rendered.includes(RENT_OPS_V2_MIGRATION_CHECKSUM_TOKEN), false);
  assert.equal(rendered.includes(RENT_OPS_MIGRATION_CHECKSUM_TOKEN), false);
  assert.match(rendered, /rent_ops_schedules_person_fk/);
  assert.match(rendered, /rent_ops_schedules_scope_shape_check/);
  assert.match(rendered, /scope_id IS NOT NULL/);
  assert.match(rendered, /rent_ops_deposits_v2_required_knowledge/);
  assert.match(rendered, /rent_ops_v2_post_insert_checksum_guard/);
  assert.match(rendered, /version = 2 AND checksum_sha256/);
});

test("v3 migration renders the immutable source-binding and operational-fidelity guards", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(3);
  assert.match(rendered, /rent_ops_guard_source_binding_insert/);
  assert.match(rendered, /BEFORE INSERT/);
  assert.match(rendered, /current_user NOT IN \('rent_ops_staging_importer', 'rent_ops_production_importer'\)/);
  assert.match(rendered, /account_person_id/);
  assert.match(rendered, /planned_move_in_knowledge/);
});

test("v7 migration constrains positive revisions and redacted sorted change fields", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(7);
  assert.match(rendered, /rent_ops_properties_record_revision_check CHECK \(record_revision > 0\)/);
  assert.match(rendered, /changed_fields.*BETWEEN 1 AND 64/s);
  assert.match(rendered, /changed_fields.*array_to_string\(changed_fields, ','\)/s);
  assert.match(rendered, /rent_ops_record_changes\.changed_fields must be sorted/);
  assert.match(rendered, /rent_ops_record_changes\.changed_fields must be unique/);
  assert.match(rendered, /record_revision FROM %I WHERE id = \$1/);
  assert.match(rendered, /revision does not match target row/);
  assert.doesNotMatch(rendered, /effective_from IS NULL[^;]*'manual'/s);
  assert.doesNotMatch(rendered, /received_on IS NULL[^;]*'manual'/s);
  assert.doesNotMatch(rendered, /unit_id IS NULL[^;]*'manual'/s);
  assert.match(rendered, /rent_ops_record_changes_admin_actor_check/);
  assert.match(rendered, /entity_type IN \('property', 'unit', 'person'/);
});

test("v8 migration is empty-cutover guarded, artifact-bound, and lineage immutable", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(8);
  assert.equal(rendered.includes(RENT_OPS_V8_MIGRATION_CHECKSUM_TOKEN), false);
  assert.match(rendered, /rent_ops_v8_nonempty_financial_target_requires_empty_rebuild/);
  assert.match(rendered, /rent_ops_financial_crosswalk_binding_check/);
  assert.match(rendered, /rent_ops_financial_crosswalk_target_domain_check/);
  assert.match(rendered, /VALIDATE CONSTRAINT rent_ops_schedules_charge_definition_fk/);
  assert.match(rendered, /VALIDATE CONSTRAINT rent_ops_schedules_lineage_root_fk/);
  assert.match(rendered, /rent_ops_guard_v8_schedule_lineage/);
  assert.match(rendered, /successor_artifact_boundary_mismatch/);
  assert.match(rendered, /effective_from_knowledge NOT IN \('source','manual'\)/);
  assert.match(rendered, /version = 8 AND checksum_sha256/);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((version) => rentOpsMigrationChecksumForVersion(version)),
    [
      "11565d4cb4dc92e06f9e24a6e0dc2ab5c583ec1d4787d262712c71d158a8700b",
      "584e3b8ea33a75f8f4b06223bc4aea2019eed60dd0d7dbfd7ed13a8d74712ec5",
      "a2c452cba136abd913862cfad6df1fb55ecafbbad386783dc757b511d339d912",
      "dc7cc34b2b11b001deabc0b1db1a490566ffdc0b09c393a16a803fbf88cf0e11",
      "fbae12050daac9b77ea68b5a39c012bbdf8330eb9f5757a4fc615535d38e6ad7",
      "b29e74a97842b9e345715c1d192927d7749e6fa830713990714eeeefa516e63a",
      "b124b72d04953c6e17e27951d8c1efe0fbf8fb1e95b85d453c5b57d697ca6fa6",
    ],
  );
});

test("v9 migration renders immutable application-history storage and its checksum guard", () => {
  const rendered = renderRentOpsMigrationSqlForVersion(9);
  assert.equal(rendered.includes(RENT_OPS_V9_MIGRATION_CHECKSUM_TOKEN), false);
  assert.match(rendered, /rent_ops_application_history/);
  assert.match(rendered, /rent_ops_application_history_aggregates/);
  assert.match(rendered, /rent_ops_application_history_immutable_guard/);
  assert.match(rendered, /version = 9 AND checksum_sha256/);
});


test("additive application migrations preserve all previously recorded source checksums", () => {
  assert.equal(rentOpsMigrationChecksumForVersion(8), "6d38f29b6f05946e8d22cc3273c3dee9cd2f4f05288ae7ede9cb052eb11c2fca");
  assert.equal(rentOpsMigrationChecksumForVersion(9), "d45c5e9a884ab57355156e938a1e0172019e3c966f05ca949698899f56fd6a0a");
  assert.deepEqual(RENT_OPS_SUPPORTED_SCHEMA_VERSIONS, Array.from({ length: RENT_OPS_SCHEMA_VERSION }, (_, index) => index + 1));
  const definitions = rentOpsMigrationDefinitions();
  assert.equal(new Set(definitions.map((definition) => definition.fileName)).size, RENT_OPS_SCHEMA_VERSION);
  for (const definition of definitions) {
    assert.doesNotMatch(definition.renderedSql, /__RENT_OPS_V\d+_CHECKSUM__/);
    assert.match(definition.renderedSql, new RegExp(`version = ${definition.version} AND checksum_sha256 = '${definition.checksum}'`));
  }
  for (const version of [0, -1, 1.5, Number.NaN, RENT_OPS_SCHEMA_VERSION + 1]) {
    assert.throws(() => renderRentOpsMigrationSqlForVersion(version), /Unknown Rent Operations migration version/);
  }
});
