import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

test("accounting tables apply through the canonical company migration chain", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const tables = await synthetic.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'accounting_qbo_%' ORDER BY table_name");
    assert.ok(tables.rows.length >= 12);
    const versions = await synthetic.db.query<{ version: number }>("SELECT version FROM rent_ops_schema_migrations WHERE version = 34");
    assert.deepEqual(versions.rows, [{ version: 34 }]);
    const lifecycle = await synthetic.db.query<{ version: number }>("SELECT version FROM rent_ops_schema_migrations WHERE version = 41");
    assert.deepEqual(lifecycle.rows, [{ version: 41 }]);
    const columns = await synthetic.db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('accounting_qbo_connections','accounting_qbo_pending_bindings')
          AND column_name IN ('status','refresh_token_hard_expires_at') ORDER BY table_name,column_name`,
    );
    assert.deepEqual(columns.rows, [
      { table_name: "accounting_qbo_connections", column_name: "refresh_token_hard_expires_at" },
      { table_name: "accounting_qbo_connections", column_name: "status" },
      { table_name: "accounting_qbo_pending_bindings", column_name: "refresh_token_hard_expires_at" },
    ]);
    const eventTable = await synthetic.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='accounting_qbo_connection_events'");
    assert.deepEqual(eventTable.rows, [{ table_name: "accounting_qbo_connection_events" }]);
  } finally {
    await synthetic.close();
  }
});

test("registered schema requires all encrypted secret components together", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  try {
    await assert.rejects(() => fixture.db.query(`INSERT INTO accounting_qbo_connections (organization_id,legal_entity_id,environment,realm_id,encrypted_access_token,access_token_expires_at) VALUES ($1,$2,'sandbox','123','cipher',now())`, [SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId]));
  } finally {
    await fixture.close();
  }
});
