import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "../services/service";

test("Postgres phone methods persist as JSON with atomic person audit and stale-write protection",async()=>{
 const db=new PGlite();try {
  await ensureRentOpsSchema({apply:true,query:sql=>db.query(sql),executor:async sql=>{await db.exec(sql);}});
  const wrap=(connection:Pick<PGlite,"query"|"transaction">):RentOpsQueryExecutor=>({
   async query<T>(sql,args){if(sql.includes("has_table_privilege"))return{rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};return connection.query<T>(sql,args?.map(value=>value===undefined?null:value));},
   transaction:work=>typeof connection.transaction === "function" ? connection.transaction(tx=>work(wrap(tx as unknown as PGlite))) : work(wrap(connection)),
  });
  const repository=new PostgresRentOpsRepository(wrap(db));const service=new RentOpsService(repository);
  const context={actorSubject:"verified-phone-admin",occurredAt:"2026-09-08T00:00:00.000Z"};
  const methods=[{value:"555-0100",type:"Mobile",isPrimary:true},{id:"secondary",value:"555-0101",isTextReady:false}];
  await service.savePerson({id:"phone-person",firstName:"Synthetic",lastName:"Phone",phone:"display unchanged",phoneMethods:methods},context);
  assert.deepEqual((await repository.getSnapshot()).people[0].phoneMethods,methods);
  const replacement=[{value:"555-0102"}];
  await service.patchRecord("person","phone-person",1,{phoneMethods:replacement},context);
  const saved=(await repository.getSnapshot()).people[0];assert.deepEqual(saved.phoneMethods,replacement);assert.equal(saved.phone,"display unchanged");assert.equal(saved.recordRevision,2);
  await assert.rejects(service.patchRecord("person","phone-person",1,{phoneMethods:[]},context),/stale/);
  await db.exec("ALTER TABLE rent_ops_record_changes ADD CONSTRAINT reject_phone_audit CHECK(actor_subject <> 'reject-audit')");
  await assert.rejects(service.patchRecord("person","phone-person",2,{phoneMethods:[]},{...context,actorSubject:"reject-audit"}));
  assert.deepEqual((await repository.getSnapshot()).people[0].phoneMethods,replacement);assert.equal((await repository.getSnapshot()).people[0].recordRevision,2);
  const audit=(await db.query<{actor_subject:string;changed_fields:string[]}>("SELECT actor_subject,changed_fields FROM rent_ops_record_changes ORDER BY revision")).rows;
  assert.equal(audit.length,2);assert.equal(audit[1].actor_subject,context.actorSubject);assert.deepEqual(audit[1].changed_fields,["phoneMethods"]);
 }finally {await db.close();}
});
