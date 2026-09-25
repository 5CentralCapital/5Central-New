import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";

const adapt = (connection: any): RentOpsQueryExecutor => ({
  query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await connection.query(sql, values?.map((value) => value === undefined ? null : value))).rows as T[] }),
  transaction: async (work) => connection.transaction ? connection.transaction((tx: any) => work(adapt(tx))) : work(adapt(connection)),
});

test("admin reversal of an imported charge is an operator entry that satisfies the ledger source and date checks", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, executor: async (sql) => { await db.exec(sql); } });
    await db.exec(`INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type) VALUES('p','QA','qa','1 QA','QA','FL','00000','multifamily');
      INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u','p','1','manual');
      INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('person','QA','Resident');
      INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES('t','p','u','person','current',NOW(),'manual','manual','manual','manual');
      CREATE ROLE rent_ops_staging_importer; GRANT USAGE ON SCHEMA public TO rent_ops_staging_importer; GRANT SELECT, INSERT ON rent_ops_ledger_transactions TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer;
      INSERT INTO rent_ops_ledger_transactions(id,source_system,source_id,source_artifact_sha256,artifact_observation_on,property_id,unit_id,tenancy_id,person_id,kind,category,category_knowledge,status,status_knowledge,amount_cents,amount_knowledge,posted_on,posted_on_knowledge,due_on,due_on_knowledge,payment_method,payment_method_knowledge,description,description_knowledge,payer,payer_knowledge,property_link_knowledge,unit_link_knowledge,tenancy_link_knowledge,person_link_knowledge,charge_definition_id,charge_definition_link_knowledge)
        VALUES('imported-charge','rent_manager','lt-1',repeat('c',64),'2026-09-02','p','u','t','person','charge','base_rent','source','posted','source',1000,'known','2026-09-01','source','2026-09-01','source',NULL,'unknown','Rent','source','tenant','source','exact','exact','exact','exact',NULL,'unknown');
      RESET ROLE;`);
    await db.exec("CREATE ROLE qa_reversal; GRANT USAGE ON SCHEMA public TO qa_reversal");
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : "SELECT, INSERT, UPDATE"} ON ${table} TO qa_reversal`);
    await db.exec("SET ROLE qa_reversal");
    const service = new RentOpsService(new PostgresRentOpsRepository(adapt(db)));
    // Posted after the original's due date: inheriting that due date would break the date-order check.
    const reversal = await service.reverseLedgerTransaction("imported-charge", { id: "imported-charge-reversal", postedOn: "2026-09-15", description: "Charge entered in error", status: "posted" });
    assert.equal(reversal.kind, "reversal");
    assert.equal(reversal.reversalOfId, "imported-charge");
    assert.equal(reversal.amountCents, 1000);
    assert.equal(reversal.source, undefined);
    assert.equal(reversal.dueOn, null);
    const row = (await db.query<any>("SELECT * FROM rent_ops_ledger_transactions WHERE id='imported-charge-reversal'")).rows[0];
    assert.equal(row.source_system, null);
    assert.equal(row.source_artifact_sha256, null);
    assert.equal(row.due_on, null);
    for (const column of ["category_knowledge", "status_knowledge", "posted_on_knowledge", "description_knowledge", "payer_knowledge"]) assert.equal(row[column], "manual", column);
    for (const column of ["property_link_knowledge", "unit_link_knowledge", "tenancy_link_knowledge", "person_link_knowledge"]) assert.equal(row[column], "manual", column);
    const original = (await db.query<any>("SELECT source_system, category_knowledge FROM rent_ops_ledger_transactions WHERE id='imported-charge'")).rows[0];
    assert.deepEqual(original, { source_system: "rent_manager", category_knowledge: "source" });
    // Replaying the same request is harmless; a second different reversal is refused.
    assert.equal((await service.reverseLedgerTransaction("imported-charge", { id: "imported-charge-reversal", postedOn: "2026-09-15", description: "Charge entered in error", status: "posted" })).id, "imported-charge-reversal");
    await assert.rejects(service.reverseLedgerTransaction("imported-charge", { id: "second", postedOn: "2026-09-16", description: "Again", status: "posted" }), /already been reversed/);
  } finally { await db.close(); }
});
