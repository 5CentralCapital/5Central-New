import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../../rent-ops/persistence";
import { PostgresRentOpsRepository } from "../../rent-ops/repositories/postgres";
import { createSyntheticCompanyDatabase, pgliteExecutor, SYNTHETIC_COMPANY } from "./synthetic-database";
import { seedRentalDemo } from "./seed-rental-demo";
import { createCompanyDemoApp } from "../demo";

test("seedRentalDemo writes both properties and a shared Postgres snapshot", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Example Company')", [SYNTHETIC_COMPANY.organizationId]);
    await db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Example Property LLC','llc','USD')", [SYNTHETIC_COMPANY.entityId, SYNTHETIC_COMPANY.organizationId]);
    await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ('40000000-0000-4000-8000-000000000001',$1,$2,'admin')", [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.actorId]);

    const executor = pgliteExecutor(db);
    await seedRentalDemo({ executor, actorId: SYNTHETIC_COMPANY.actorId, actorRole: "owner" });
    const repository = new PostgresRentOpsRepository(executor);
    (repository as unknown as { ready: boolean }).ready = true;
    const snapshot = await repository.getSnapshot();
    assert.deepEqual(snapshot.properties.map(property => property.id).sort(), ["demo-property-a", "demo-property-b"]);
    assert.equal(snapshot.ledgerTransactions.length, 10);
    const mappings = await db.query<{ property_id: string }>("SELECT property_id FROM company_property_entity_periods ORDER BY property_id");
    assert.deepEqual(mappings.rows.map(row => row.property_id), ["demo-property-a", "demo-property-b"]);
  } finally {
    await db.close();
  }
});

test("seedRentalDemo rejects a non-owner before touching the database", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await assert.rejects(() => seedRentalDemo({ executor: fixture.executor, actorId: "other-actor", actorRole: "owner" }), /owner identity/);
    const properties = await fixture.db.query<{ id: string }>("SELECT id FROM rent_ops_properties");
    assert.equal(properties.rows.length, 1);
  } finally {
    await fixture.close();
  }
});

test("seedRentalDemo upgrades the legacy minimal demo property and unit", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await seedRentalDemo({ executor: fixture.executor, actorId: SYNTHETIC_COMPANY.actorId, actorRole: "owner" });
    const property = await fixture.db.query<{ name: string; slug: string }>(
      "SELECT name,slug FROM rent_ops_properties WHERE id=$1",
      [SYNTHETIC_COMPANY.propertyId],
    );
    assert.deepEqual(property.rows[0], { name: "Demo Harbor Homes", slug: "demo-harbor" });
    const counts = await fixture.db.query<{ properties: number; units: number; ledger: number }>(
      `SELECT
         (SELECT count(*) FROM rent_ops_properties) AS properties,
         (SELECT count(*) FROM rent_ops_units) AS units,
         (SELECT count(*) FROM rent_ops_ledger_transactions) AS ledger`,
    );
    assert.deepEqual(counts.rows[0], { properties: 2, units: 7, ledger: 10 });
  } finally {
    await fixture.close();
  }
});

test("createCompanyDemoApp exposes the seeded snapshot through the shared database", async () => {
  const demo = await createCompanyDemoApp();
  try {
    const counts = await demo.database.executor.query<{ properties: number; units: number; ledger: number }>(
      `SELECT
         (SELECT count(*) FROM rent_ops_properties) AS properties,
         (SELECT count(*) FROM rent_ops_units) AS units,
         (SELECT count(*) FROM rent_ops_ledger_transactions) AS ledger`,
    );
    assert.deepEqual(counts.rows[0], { properties: 2, units: 7, ledger: 10 });
  } finally {
    await demo.close();
  }
});
