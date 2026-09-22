import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

test("SQL receipts reject duplicates, mismatches and mutation, rolling back ledger insert", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE rent_ops_recurring_charge_schedules(id varchar(160) PRIMARY KEY, lineage_root_id text, amount_cents bigint, category text, charge_definition_id text);
      CREATE TABLE rent_ops_tenancies(id varchar(160) PRIMARY KEY);
      CREATE TABLE rent_ops_ledger_transactions(id varchar(160) PRIMARY KEY, tenancy_id text, amount_cents bigint, posted_on date, due_on date, kind text, status text, category text, charge_definition_id text, source_system text, source_id text);
      INSERT INTO rent_ops_tenancies VALUES ('t');
      INSERT INTO rent_ops_recurring_charge_schedules VALUES ('s','s',125000,'base_rent','d');
      INSERT INTO rent_ops_ledger_transactions VALUES ('l','t',125000,'2025-05-01','2025-05-01','charge','posted','base_rent','d',NULL,NULL);`);
    await db.exec(readFileSync(new URL("../migrations/012_rent_ops_recurring_billing.sql", import.meta.url), "utf8").split("INSERT INTO rent_ops_schema_migrations")[0]);
    const insert = "INSERT INTO rent_ops_billing_charges VALUES ('s','s','2025-05-01',$1,'t',125000,$2,'admin',NOW())";
    await db.query(insert, ['l', 'a'.repeat(64)]);
    await assert.rejects(db.query(insert, ['l', 'a'.repeat(64)]), /duplicate/);
    await assert.rejects(db.exec("UPDATE rent_ops_billing_charges SET amount_cents = 1"), /immutable/);
    await assert.rejects(db.exec("DELETE FROM rent_ops_billing_charges"), /immutable/);
    await assert.rejects(db.transaction(async tx => {
      await tx.exec("INSERT INTO rent_ops_ledger_transactions SELECT 'l2',tenancy_id,amount_cents,posted_on,due_on,kind,status,category,charge_definition_id,source_system,source_id FROM rent_ops_ledger_transactions WHERE id='l'");
      await tx.query(insert, ['l2', 'b'.repeat(64)]);
    }), /duplicate/);
    assert.equal((await db.query("SELECT id FROM rent_ops_ledger_transactions WHERE id='l2'")).rows.length, 0);
    await assert.rejects(db.query("INSERT INTO rent_ops_billing_charges VALUES ('s','s','2025-06-01','l','t',1,$1,'admin',NOW())", ['c'.repeat(64)]), /mismatch/);
  } finally { await db.close(); }
});
