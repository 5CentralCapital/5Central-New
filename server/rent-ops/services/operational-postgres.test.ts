import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";

test("schema26 native charge configuration requires audited revision and preserves category and source",async()=>{
 const db=new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec("CREATE ROLE qa_operations; GRANT USAGE ON SCHEMA public TO qa_operations");
  for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : "SELECT, INSERT, UPDATE"} ON ${table} TO qa_operations`);
  await db.exec("SET ROLE qa_operations");
  let failAudit=false;
  const adapt=(connection:any):RentOpsQueryExecutor=>({query:async(sql,values)=>{if(failAudit && sql.startsWith("INSERT INTO rent_ops_record_changes"))throw Error("audit unavailable");return connection.query(sql,values?.map(value=>value===undefined?null:value));},transaction:async work=>connection.transaction?connection.transaction((tx:any)=>work(adapt(tx))):work(adapt(connection))});
  const service=new RentOpsService(new PostgresRentOpsRepository(adapt(db)));
  const context={actorSubject:"qa",occurredAt:"2026-09-08T12:00:00.000Z"};
  await service.createChargeDefinition({id:"water",displayName:"Water",category:"recurring_fee",active:true},context);
  await service.patchChargeDefinition("water",1,{displayName:"Water billing",active:false},context);
  const stored=(await service.snapshot()).chargeDefinitions.find(row=>row.id==="water")!;
  assert.equal(stored.recordRevision,2);assert.equal(stored.displayName,"Water billing");assert.equal(stored.category,"recurring_fee");
  await assert.rejects(service.patchChargeDefinition("water",1,{active:true},context),/stale/);
  failAudit=true;await assert.rejects(service.patchChargeDefinition("water",2,{active:true},context),/audit unavailable/);failAudit=false;
  assert.equal((await service.snapshot()).chargeDefinitions.find(row=>row.id==="water")!.active,false);
  await assert.rejects(db.exec("UPDATE rent_ops_charge_definitions SET category='base_rent',record_revision=3 WHERE id='water'"),/immutable/);
  await assert.rejects(db.exec("UPDATE rent_ops_charge_definitions SET active=true,record_revision=3 WHERE id='water'"),/audit_required/);
  await db.exec(`INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type) VALUES('p','QA','qa','1 QA','QA','FL','00000','multifamily');
    INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u','p','1','manual');
    INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('person','QA','Resident');
    INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES('t','p','u','person','current',NOW(),'manual','manual','manual','manual');`);
  await service.saveLedgerTransaction({id:"charge",propertyId:"p",unitId:"u",tenancyId:"t",personId:"person",kind:"charge",category:"base_rent",categoryKnowledge:"manual",amountCents:1000,amountKnowledge:"known",status:"posted",statusKnowledge:"manual",postedOn:"2026-09-01",postedOnKnowledge:"manual",dueOn:"2026-09-01",dueOnKnowledge:"manual",paymentMethod:null,paymentMethodKnowledge:"unknown",chargeDefinitionId:null,chargeDefinitionLinkKnowledge:"unknown",description:"Rent",descriptionKnowledge:"manual",payer:"tenant",payerKnowledge:"manual",propertyLinkKnowledge:"manual",unitLinkKnowledge:"manual",tenancyLinkKnowledge:"manual",personLinkKnowledge:"manual"});
  const input={id:"manual",tenancyId:"t",amountCents:500,postedOn:"2026-09-08",paymentMethod:"cash" as const,description:"Received cash",category:"base_rent" as const,allocations:[{chargeTransactionId:"charge",amountCents:500}]};
  assert.equal((await service.recordManualPayment(input,context)).replayed,false);
  assert.equal((await service.recordManualPayment(input,context)).replayed,true);
  await assert.rejects(service.recordManualPayment({...input,id:"overpay",amountCents:600,allocations:[{chargeTransactionId:"charge",amountCents:600}]},context),/exceed/);
  const after=await service.snapshot();assert.equal(after.ledgerTransactions.filter(row=>row.id==="manual").length,1);assert.equal(after.paymentAllocations.length,1);assert.equal(after.ledgerTransactions.some(row=>row.id==="overpay"),false);
  await service.createChargeDefinition({id:"rent",displayName:"Rent",category:"base_rent",active:true},context);
  await db.exec("RESET ROLE; CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON rent_ops_recurring_charge_schedules TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
  await db.exec(`INSERT INTO rent_ops_recurring_charge_schedules(id,scope_type,scope_id,scope_type_knowledge,scope_link_knowledge,charge_definition_id,tenancy_id,person_id,property_id,unit_id,category,category_knowledge,description,description_knowledge,amount_cents,amount_knowledge,effective_from,effective_from_knowledge,active,active_knowledge,source_confidence,charge_definition_knowledge,charge_definition_link_knowledge,source_artifact_sha256,artifact_observation_on,lineage_root_id,lineage_root_origin,version_origin,version_action,record_revision,source_system,source_id)
    VALUES('source-schedule','tenant','person','source','exact','rent','t','person','p','u','base_rent','source','Rent','source',1000,'known','2026-01-01','source',true,'source','confirmed','source','exact',repeat('a',64),'2026-09-01','source-schedule','artifact','artifact','root',1,'rm','source-schedule');`);
  await db.exec("SET ROLE qa_operations");
  const confirmed=await service.saveRecurringScheduleSuccessor("source-schedule",{id:"monthly-confirmed",expectedRevision:1,action:"replace",effectiveFrom:"2026-10-01",amountCents:1000,billingFrequency:"monthly"},context);
  assert.equal(confirmed.billingFrequency,"monthly");
  const cadence=await db.query("SELECT id,billing_frequency FROM rent_ops_recurring_charge_schedules ORDER BY id");
  assert.equal(cadence.rows.find((row:any)=>row.id==="source-schedule")?.billing_frequency,null);
  assert.equal(cadence.rows.find((row:any)=>row.id==="monthly-confirmed")?.billing_frequency,"monthly");
  const changes=await db.query("SELECT revision FROM rent_ops_record_changes WHERE entity_type='charge_definition' AND target_id='water' ORDER BY revision");assert.equal(changes.rows.length,2);
 }finally{await db.close();}
});
