import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";

test("property address PATCH uses actual SQL columns, preserves operating state, and remains audited and atomic", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
    await db.exec("CREATE ROLE qa_address; GRANT USAGE ON SCHEMA public TO qa_address");
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : "SELECT, INSERT, UPDATE"} ON ${table} TO qa_address`);
    await db.exec("SET ROLE qa_address");
    let failAudit = false;
    const adapt = (connection:any):RentOpsQueryExecutor => ({
      query:async(sql,values)=>{if(failAudit && sql.startsWith("INSERT INTO rent_ops_record_changes")) throw Error("audit unavailable");return connection.query(sql,values?.map(v=>v===undefined?null:v));},
      transaction:async work=>connection.transaction?connection.transaction((tx:any)=>work(adapt(tx))):work(adapt(connection)),
    });
    const repository = new PostgresRentOpsRepository(adapt(db)), service = new RentOpsService(repository);
    await service.saveProperty({id:"p",name:"Property",slug:"property",address:{line1:"Old street",line2:"Building A",city:"Old city",state:"FL",postalCode:"00000"},propertyType:"multifamily",state:"active"});
    const context={actorSubject:"qa-admin",occurredAt:"2026-09-12T12:00:00.000Z"};
    await service.patchRecord("property","p",1,{address:{line1:"123 New Street",city:"Tampa",state:"FL",postalCode:"33602"},operatingContact:"Current manager"},context);
    const stored=(await repository.getSnapshot()).properties[0];
    assert.deepEqual(stored.address,{line1:"123 New Street",line2:"Building A",city:"Tampa",state:"FL",postalCode:"33602"});
    assert.equal(stored.state,"active");assert.equal(stored.recordRevision,2);assert.equal(stored.addressKnowledge,"manual");assert.equal(stored.operatingContact,"Current manager");
    const audit=(await db.query("SELECT changed_fields,actor_subject FROM rent_ops_record_changes WHERE target_id='p' AND revision=2")).rows[0];
    assert.deepEqual(audit.changed_fields,["address","operatingContact"]);assert.equal(audit.actor_subject,"qa-admin");
    await assert.rejects(()=>repository.applyRecordPatch({entityType:"property",targetId:"p",expectedRevision:2,nextRevision:3,values:{address_city:"invalid"}}),/positive allowlist/i);
    await assert.rejects(()=>repository.applyRecordPatch({entityType:"property",targetId:"p",expectedRevision:2,nextRevision:3,values:{source_id:"forged"}}),/positive allowlist/i);
    failAudit=true;
    await assert.rejects(()=>service.patchRecord("property","p",2,{address:{city:"Must roll back"}},context),/audit unavailable/);
    const after=(await repository.getSnapshot()).properties[0];assert.deepEqual(after,stored);
  } finally { await db.close(); }
});
