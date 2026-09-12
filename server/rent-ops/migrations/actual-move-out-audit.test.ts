import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { rentOpsMigrationDefinitions, renderRentOpsMigrationSqlForVersion } from "../persistence";

test("migration 028 restores actual departure auditing without widening other field guards", async () => {
  const db = new PGlite();
  try {
    for (const migration of rentOpsMigrationDefinitions().filter(row => row.version <= 27)) await db.exec(migration.renderedSql);
    const definition = async () => (await db.query<{ guard: string }>("SELECT pg_get_constraintdef(oid) AS guard FROM pg_constraint WHERE conrelid='rent_ops_record_changes'::regclass AND conname='rent_ops_record_changes_changed_fields_check'")).rows[0].guard;
    const before = await definition();
    assert.ok(!before.includes("'actualMoveOutOn'::text"));
    await db.exec("INSERT INTO rent_ops_properties(id,slug) VALUES('p','p'); INSERT INTO rent_ops_units(id,property_id) VALUES('u','p'); INSERT INTO rent_ops_people(id) VALUES('person'); INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,record_revision) VALUES('departure','p','u','person','past',NOW(),2),('invalid','p','u','person','past',NOW(),2)");
    const insertAudit = (id: string, targetId: string, fields: string[]) => db.query("INSERT INTO rent_ops_record_changes(id,entity_type,target_id,revision,origin,actor_subject,occurred_at,changed_fields) VALUES($1,'tenancy',$2,2,'admin','test',NOW(),$3)", [id, targetId, fields]);
    await assert.rejects(insertAudit("before", "departure", ["actualMoveOutOn", "expectedMoveOutOn"]), /rent_ops_record_changes_changed_fields_check/);
    await db.exec(renderRentOpsMigrationSqlForVersion(28));
    const after = await definition();
    assert.equal(after, before.replace("'expectedMoveOutOn'::text", "'actualMoveOutOn'::text, 'expectedMoveOutOn'::text"));
    await insertAudit("accepted", "departure", ["actualMoveOutOn", "expectedMoveOutOn"]);
    const saved = await db.query<{ changed_fields: string[] }>("SELECT changed_fields FROM rent_ops_record_changes WHERE id='accepted'");
    assert.deepEqual(saved.rows[0].changed_fields, ["actualMoveOutOn", "expectedMoveOutOn"]);
    await assert.rejects(insertAudit("invalid", "invalid", ["inventedField"]), /rent_ops_record_changes_changed_fields_check/);
    await assert.rejects(insertAudit("unapproved-knowledge", "invalid", ["actualMoveOutKnowledge"]), /rent_ops_record_changes_changed_fields_check/);
    const version = await db.query<{ version: number }>("SELECT version FROM rent_ops_schema_migrations ORDER BY version DESC LIMIT 1");
    assert.equal(version.rows[0].version, 28);
  } finally { await db.close(); }
});
