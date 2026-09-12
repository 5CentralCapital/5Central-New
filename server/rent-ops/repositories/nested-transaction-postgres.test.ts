import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { RentOpsService } from "../services/service";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "./postgres";

test("query-only transaction children retain nested patch locks, audits and outer rollback", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    await db.exec("INSERT INTO rent_ops_properties(id,name,slug) VALUES('p','QA','qa'); INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('person','Test','Resident'); INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u','p','1','manual'); INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,status_knowledge,actual_move_in_on,actual_move_in_knowledge,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge) VALUES('t','p','u','person','current','manual','2026-01-01','manual',NOW(),'manual','manual','manual')");
    await db.exec("CREATE ROLE qa_nested; GRANT USAGE ON SCHEMA public TO qa_nested");
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : "SELECT,INSERT,UPDATE"} ON ${table} TO qa_nested`);
    await db.exec("SET ROLE qa_nested");
    const statements: string[] = [];
    let outerTransactions = 0;
    const queryOnly = (connection: any): RentOpsQueryExecutor => ({ query: async (sql, values) => {
      statements.push(sql); return connection.query(sql, values?.map(value => value === undefined ? null : value));
    } });
    const executor: RentOpsQueryExecutor = { ...queryOnly(db), transaction: async work => {
      outerTransactions++; return db.transaction(tx => work(queryOnly(tx)));
    } };
    const repository = new PostgresRentOpsRepository(executor);
    const context = { actorSubject: "qa", occurredAt: "2026-09-12T12:00:00.000Z" };
    await assert.rejects(repository.transaction(async inner => {
      await new RentOpsService(inner).patchRecord("tenancy", "t", 1, { status: "past" }, context);
      assert.equal((await inner.getSnapshot()).tenancies[0].status, "past");
      throw new Error("rollback outer plan");
    }), /rollback outer plan/);
    assert.equal((await db.query<any>("SELECT status,record_revision FROM rent_ops_tenancies WHERE id='t'")).rows[0].status, "current");
    assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM rent_ops_record_changes")).rows[0].n, 0);
    await repository.transaction(async inner => {
      await assert.rejects(inner.transaction(async nested => {
        await new RentOpsService(nested).patchRecord("tenancy", "t", 1, { status: "past" }, context);
        // Real SQL error aborts PostgreSQL's transaction until the savepoint is restored.
        await nested.applyRecordPatch!({ entityType: "tenancy", targetId: "t", expectedRevision: 2, nextRevision: 3, values: { status: "invalid-status" } });
      }), /check constraint/);
      const restored = (await inner.getSnapshot()).tenancies[0];
      assert.equal(restored.status, "current"); assert.equal(restored.recordRevision, 1);
      await new RentOpsService(inner).patchRecord("tenancy", "t", 1, { status: "cancelled" }, context);
    });
    assert.equal(outerTransactions, 2, "nested work never starts an independent transaction");
    const saved = (await db.query<any>("SELECT status,record_revision FROM rent_ops_tenancies WHERE id='t'")).rows[0];
    assert.equal(saved.status, "cancelled"); assert.equal(saved.record_revision, 2);
    const changes = (await db.query<any>("SELECT changed_fields,revision FROM rent_ops_record_changes")).rows;
    assert.equal(changes.length, 1); assert.deepEqual(changes[0].changed_fields, ["status"]);
    assert(statements.some(sql => sql.includes("rent_ops_tenancies") && sql.includes("FOR UPDATE")));
    assert(statements.some(sql => sql.startsWith("ROLLBACK TO SAVEPOINT")));
  } finally { await db.close(); }
});
