import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";
const require = createRequire(import.meta.url);
const { prepareValue } = require("pg/lib/utils") as {prepareValue:(value:unknown)=>unknown};

test("unit amenities PATCH encodes JSONB through node-postgres and preserves exact strings and empty lists", async () => {
 const db=new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec("CREATE ROLE qa_amenities; GRANT USAGE ON SCHEMA public TO qa_amenities");
  for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES)await db.exec(`GRANT ${table==="rent_ops_schema_migrations"?"SELECT":"SELECT, INSERT, UPDATE"} ON ${table} TO qa_amenities`);
  await db.exec("SET ROLE qa_amenities");
  let failAudit=false;
  const adapt=(connection:any):RentOpsQueryExecutor=>({query:async(sql,values)=>{if(failAudit&&sql.startsWith("INSERT INTO rent_ops_record_changes"))throw Error("audit unavailable");return connection.query(sql,values?.map(value=>prepareValue(value)));},transaction:async work=>connection.transaction?connection.transaction((tx:any)=>work(adapt(tx))):work(adapt(connection))});
  const repository=new PostgresRentOpsRepository(adapt(db)),service=new RentOpsService(repository);
  await service.saveProperty({id:"p",name:"Property",slug:"property",address:{line1:"1 Street",city:"Tampa",state:"FL",postalCode:"33602"},propertyType:"multifamily",state:"active"});
  await service.saveUnit({id:"u",propertyId:"p",unitNumber:"1",readiness:"ready",listing:"unlisted",amenities:[]});
  const context={actorSubject:"qa",occurredAt:"2026-09-12T12:00:00.000Z"},amenities=['Washer, dryer','Storage "A"','Entry \\ path'];
  // Demonstrates the production driver's raw-array encoding is not JSONB.
  await assert.rejects(()=>db.query("SELECT $1::jsonb",[prepareValue(amenities)]),/invalid input syntax for type json/);
  await service.patchRecord("unit","u",1,{amenities},context);
  assert.deepEqual((await repository.getSnapshot()).units[0].amenities,amenities);
  assert.deepEqual((await db.query("SELECT amenities FROM rent_ops_units WHERE id='u'")).rows[0].amenities,amenities);
  const changes=(await db.query("SELECT changed_fields FROM rent_ops_record_changes WHERE target_id='u' AND revision=2")).rows;
  assert.deepEqual(changes[0].changed_fields,["amenities"]);
  failAudit=true;await assert.rejects(()=>service.patchRecord("unit","u",2,{amenities:[]},context),/audit unavailable/);
  assert.deepEqual((await repository.getSnapshot()).units[0].amenities,amenities);
  failAudit=false;await service.patchRecord("unit","u",2,{amenities:[]},context);
  const stored=(await repository.getSnapshot()).units[0];assert.deepEqual(stored.amenities,[]);assert.equal(stored.recordRevision,3);
  await assert.rejects(()=>repository.applyRecordPatch({entityType:"unit",targetId:"u",expectedRevision:3,nextRevision:4,values:{source_id:"forged"}}),/positive allowlist/i);
 }finally{await db.close();}
});
