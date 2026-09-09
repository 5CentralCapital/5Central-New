import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../persistence";
import { DATABASE_AUDIT_SQL } from "./database-audit";

async function insertScheduleLineage(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO rent_ops_properties (id, name, slug)
    VALUES ('audit-property', 'Audit Property', 'audit-property');

    INSERT INTO rent_ops_recurring_charge_schedules (
      id, scope_type, scope_id, scope_type_knowledge, scope_link_knowledge,
      charge_definition_id, charge_definition_key, tenancy_id, person_id, property_id, unit_id,
      category, category_knowledge, description, description_knowledge,
      amount_cents, amount_knowledge, effective_from, effective_from_knowledge,
      effective_to, active, active_knowledge, source_confidence,
      charge_definition_knowledge, charge_definition_link_knowledge,
      source_artifact_sha256, artifact_observation_on, lineage_root_id,
      lineage_root_origin, version_origin, version_action, supersedes_id, record_revision,
      source_system, source_id
    ) VALUES
      (
        'audit-root', 'property', 'audit-property', 'manual', 'manual',
        NULL, 'audit-rent', NULL, NULL, 'audit-property', NULL,
        'base_rent', 'manual', 'Root rent', 'manual',
        100000, 'known', '2026-01-01', 'manual', '2026-12-31',
        TRUE, 'manual', 'confirmed', 'unknown', 'unknown',
        NULL, NULL, 'audit-root', 'manual', 'manual', 'root', NULL, 1,
        NULL, NULL
      ),
      (
        'audit-replace', 'property', 'audit-property', 'manual', 'manual',
        NULL, 'audit-rent', NULL, NULL, 'audit-property', NULL,
        'base_rent', 'manual', 'Root rent', 'manual',
        120000, 'known', '2026-06-01', 'manual', '2026-12-31',
        TRUE, 'manual', 'confirmed', 'unknown', 'unknown',
        NULL, NULL, 'audit-root', 'manual', 'manual', 'replace', 'audit-root', 2,
        NULL, NULL
      ),
      (
        'audit-end', 'property', 'audit-property', 'manual', 'manual',
        NULL, 'audit-rent', NULL, NULL, 'audit-property', NULL,
        'base_rent', 'manual', 'Root rent', 'manual',
        NULL, 'unknown', '2026-09-01', 'manual', '2026-09-01',
        FALSE, 'manual', 'confirmed', 'unknown', 'unknown',
        NULL, NULL, 'audit-root', 'manual', 'manual', 'end', 'audit-replace', 3,
        NULL, NULL
      )
    ;
  `);
}

test("audit schedule intervals truncate valid successors without changing raw fidelity conservation", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, query: (sql) => db.query(sql), executor: async (sql) => { await db.exec(sql); } });
    await insertScheduleLineage(db);

    const beforeReplacement = await db.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.reportParity, ["2026-05-31"]);
    const duringReplacement = await db.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.reportParity, ["2026-06-01"]);
    const beforeEnd = await db.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.reportParity, ["2026-08-31"]);
    const afterEnd = await db.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.reportParity, ["2026-09-01"]);

    assert.equal(Number(beforeReplacement.rows[0].effective_base_rent_cents), 100000);
    assert.equal(Number(duringReplacement.rows[0].effective_base_rent_cents), 120000);
    assert.equal(Number(beforeEnd.rows[0].effective_base_rent_cents), 120000);
    assert.equal(Number(afterEnd.rows[0].effective_base_rent_cents), 0);

    const fidelity = await db.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.fidelityControls, ["2026-06-01"]);
    assert.equal(Number(fidelity.rows[0].schedule_row_count), 3);
    assert.equal(Number(fidelity.rows[0].schedule_property_count), 3);
    assert.equal(Number(fidelity.rows[0].schedule_property_amount_cents), 220000);
    assert.equal(Number(fidelity.rows[0].effective_base_rent_cents_independent), 120000);
  } finally {
    await db.close();
  }
});

test("audit schedule intervals retain raw ranges for quarantined lineage rows", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, query: (sql) => db.query(sql), executor: async (sql) => { await db.exec(sql); } });
    await insertScheduleLineage(db);
    // Simulate a legacy malformed successor that bypassed the v8 insert guard.
    // The independent audit must quarantine the whole lineage and retain the
    // stored ranges so the conflicting rows remain visible to fidelity checks.
    await db.exec("ALTER TABLE rent_ops_recurring_charge_schedules DISABLE TRIGGER rent_ops_v8_schedule_lineage_guard");
    await db.exec(`
      INSERT INTO rent_ops_recurring_charge_schedules (
        id, scope_type, scope_id, scope_type_knowledge, scope_link_knowledge,
        charge_definition_id, charge_definition_key, tenancy_id, person_id, property_id, unit_id,
        category, category_knowledge, description, description_knowledge,
        amount_cents, amount_knowledge, effective_from, effective_from_knowledge,
        effective_to, active, active_knowledge, source_confidence,
        charge_definition_knowledge, charge_definition_link_knowledge,
        source_artifact_sha256, artifact_observation_on, lineage_root_id,
        lineage_root_origin, version_origin, version_action, record_revision,
        supersedes_id, source_system, source_id
      ) VALUES (
        'audit-invalid', 'property', 'audit-property', 'manual', 'manual',
        NULL, 'audit-rent', NULL, NULL, 'audit-property', NULL,
        'recurring_fee', 'manual', 'Root rent', 'manual',
        130000, 'known', '2026-10-01', 'manual', '2026-12-31',
        TRUE, 'manual', 'confirmed', 'unknown', 'unknown',
        NULL, NULL, 'audit-root', 'manual', 'manual', 'replace', 4,
        'audit-end', NULL, NULL
      );
    `);
    await db.exec("ALTER TABLE rent_ops_recurring_charge_schedules ENABLE TRIGGER rent_ops_v8_schedule_lineage_guard");

    const report = await db.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.reportParity, ["2026-10-15"]);
    assert.equal(Number(report.rows[0].effective_base_rent_cents), 220000);
    assert.equal(Number(report.rows[0].effective_recurring_fees_cents), 130000);
  } finally {
    await db.close();
  }
});

test("audit schedule intervals emit one raw row per source ID for a forked lineage", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, query: (sql) => db.query(sql), executor: async (sql) => { await db.exec(sql); } });
    await insertScheduleLineage(db);
    await db.exec("DROP INDEX rent_ops_schedules_predecessor_unique");
    await db.exec("ALTER TABLE rent_ops_recurring_charge_schedules DISABLE TRIGGER rent_ops_v8_schedule_lineage_guard");
    await db.exec(`
      INSERT INTO rent_ops_recurring_charge_schedules (
        id, scope_type, scope_id, scope_type_knowledge, scope_link_knowledge,
        charge_definition_id, charge_definition_key, tenancy_id, person_id, property_id, unit_id,
        category, category_knowledge, description, description_knowledge,
        amount_cents, amount_knowledge, effective_from, effective_from_knowledge,
        effective_to, active, active_knowledge, source_confidence,
        charge_definition_knowledge, charge_definition_link_knowledge,
        source_artifact_sha256, artifact_observation_on, lineage_root_id,
        lineage_root_origin, version_origin, version_action, supersedes_id,
        record_revision, source_system, source_id
      ) VALUES
        (
          'fork-root', 'property', 'audit-property', 'manual', 'manual',
          NULL, 'audit-fork', NULL, NULL, 'audit-property', NULL,
          'base_rent', 'manual', 'Fork rent', 'manual',
          70000, 'known', '2026-01-01', 'manual', '2026-12-31',
          TRUE, 'manual', 'confirmed', 'unknown', 'unknown',
          NULL, NULL, 'fork-root', 'manual', 'manual', 'root', NULL, 1,
          NULL, NULL
        ),
        (
          'fork-a', 'property', 'audit-property', 'manual', 'manual',
          NULL, 'audit-fork', NULL, NULL, 'audit-property', NULL,
          'base_rent', 'manual', 'Fork rent', 'manual',
          80000, 'known', '2026-06-01', 'manual', '2026-12-31',
          TRUE, 'manual', 'confirmed', 'unknown', 'unknown',
          NULL, NULL, 'fork-root', 'manual', 'manual', 'replace', 'fork-root', 2,
          NULL, NULL
        ),
        (
          'fork-b', 'property', 'audit-property', 'manual', 'manual',
          NULL, 'audit-fork', NULL, NULL, 'audit-property', NULL,
          'base_rent', 'manual', 'Fork rent', 'manual',
          90000, 'known', '2026-07-01', 'manual', '2026-12-31',
          TRUE, 'manual', 'confirmed', 'unknown', 'unknown',
          NULL, NULL, 'fork-root', 'manual', 'manual', 'replace', 'fork-root', 2,
          NULL, NULL
        )
      ;
    `);
    await db.exec("ALTER TABLE rent_ops_recurring_charge_schedules ENABLE TRIGGER rent_ops_v8_schedule_lineage_guard");

    const report = await db.query<Record<string, unknown>>(DATABASE_AUDIT_SQL.reportParity, ["2026-08-01"]);
    // The fork is quarantined and all three stored ranges remain visible. A
    // non-aggregated successor join would duplicate fork-root and add 70k.
    assert.equal(Number(report.rows[0].effective_base_rent_cents), 360000);
  } finally {
    await db.close();
  }
});
