import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";
import type { RentOpsRecordChange, RentOpsRecurringChargeSchedule } from "../../../shared/rent-ops-contracts";

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

test("append-only runtime role can end a recurring schedule without row-update privileges", async () => {
 const db = new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec("CREATE ROLE qa_schedule_owner; GRANT USAGE ON SCHEMA public TO qa_schedule_owner");
  for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : "SELECT, INSERT, UPDATE"} ON public.${table} TO qa_schedule_owner`);
  await db.exec("SET ROLE qa_schedule_owner");
  await db.exec(`INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type) VALUES('runtime-property','QA','runtime-qa','1 QA Way','QA','FL','00000','multifamily');
    INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('runtime-unit','runtime-property','1','manual');
    INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('runtime-person','QA','Resident');
    INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES('runtime-tenancy','runtime-property','runtime-unit','runtime-person','current',NOW(),'manual','manual','manual','manual');
    INSERT INTO rent_ops_charge_definitions(id,display_name,display_name_knowledge,category,category_knowledge,active,active_knowledge) VALUES('runtime-definition','Base rent','manual','base_rent','manual',true,'manual');`);
  const adapt = (connection:any):RentOpsQueryExecutor => ({
   query: async <T>(sql:string, values?:unknown[]) => ({rows:(await connection.query(sql, values?.map(value=>value===undefined?null:value))).rows as T[]}),
   transaction: async work => connection.transaction ? connection.transaction((tx:any)=>work(adapt(tx))) : work(adapt(connection)),
  });
  const ownerRepository = new PostgresRentOpsRepository(adapt(db));
  const root: RentOpsRecurringChargeSchedule = {
   id: "runtime-schedule-root", source: undefined, scopeType: "tenant", scopeId: "runtime-person",
   scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual", chargeDefinitionId: "runtime-definition",
   chargeDefinitionKey: null, tenancyId: "runtime-tenancy", personId: "runtime-person", propertyId: "runtime-property",
   unitId: "runtime-unit", category: "base_rent", categoryKnowledge: "manual", description: "QA rent",
   descriptionKnowledge: "manual", amountCents: 1000, amountKnowledge: "known", effectiveFrom: "2026-09-09",
   effectiveFromKnowledge: "manual", effectiveTo: "2027-12-31", active: true, activeKnowledge: "manual",
   sourceConfidence: "confirmed", chargeDefinitionKnowledge: "manual", chargeDefinitionLinkKnowledge: "manual",
   sourceArtifactSha256: null, artifactObservationOn: null, lineageRootId: "runtime-schedule-root", lineageRootOrigin: "manual",
   versionOrigin: "manual", supersedesId: null, versionAction: "root", recordRevision: 1, billingFrequency: "monthly",
  };
  const rootChange: RentOpsRecordChange = {
   id: "record-change:runtime-schedule-root", entityType: "recurring_schedule", targetId: root.id, revision: 1,
   origin: "admin", actorSubject: "qa", occurredAt: "2026-09-08T12:00:00.000Z", changedFields: ["effectiveFrom", "versionAction"],
  };
  await ownerRepository.saveRecurringScheduleRoot({schedule: root, change: rootChange});

  await db.exec("RESET ROLE; CREATE ROLE rent_ops_append_only_runtime; GRANT USAGE ON SCHEMA public TO rent_ops_append_only_runtime");
  await db.exec(`GRANT SELECT ON ${RENT_OPS_RUNTIME_REQUIRED_TABLES.map(table=>`public.${table}`).join(", ")} TO rent_ops_append_only_runtime`);
  await db.exec("GRANT INSERT ON public.rent_ops_recurring_charge_schedules, public.rent_ops_record_changes TO rent_ops_append_only_runtime");
  await db.exec("SET ROLE rent_ops_append_only_runtime");
  const privileges = await db.query<{schedule_insert:boolean; schedule_update:boolean; schedule_delete:boolean; change_insert:boolean; change_update:boolean; change_delete:boolean}>("SELECT has_table_privilege(current_user, 'public.rent_ops_recurring_charge_schedules', 'INSERT') AS schedule_insert, has_table_privilege(current_user, 'public.rent_ops_recurring_charge_schedules', 'UPDATE') AS schedule_update, has_table_privilege(current_user, 'public.rent_ops_recurring_charge_schedules', 'DELETE') AS schedule_delete, has_table_privilege(current_user, 'public.rent_ops_record_changes', 'INSERT') AS change_insert, has_table_privilege(current_user, 'public.rent_ops_record_changes', 'UPDATE') AS change_update, has_table_privilege(current_user, 'public.rent_ops_record_changes', 'DELETE') AS change_delete");
  assert.deepEqual(privileges.rows, [{schedule_insert: true, schedule_update: false, schedule_delete: false, change_insert: true, change_update: false, change_delete: false}]);
  const runtimeRepository = new PostgresRentOpsRepository(adapt(db));
  const successor: RentOpsRecurringChargeSchedule = {
   ...root, id: "runtime-schedule-end", source: undefined, amountCents: null, amountKnowledge: "unknown",
   effectiveFrom: "2026-09-10", effectiveFromKnowledge: "manual", effectiveTo: "2026-09-10", active: false,
   activeKnowledge: "manual", supersedesId: root.id, versionAction: "end", recordRevision: 2,
  };
  const change: RentOpsRecordChange = {
   id: "record-change:runtime-schedule-end", entityType: "recurring_schedule", targetId: successor.id, revision: 2,
   origin: "admin", actorSubject: "qa", occurredAt: "2026-09-08T12:00:01.000Z",
   changedFields: ["active", "activeKnowledge", "amountCents", "amountKnowledge", "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "recordRevision", "supersedesId", "versionAction", "versionOrigin"],
  };
  const saved = await runtimeRepository.saveRecurringScheduleSuccessor({predecessorId: root.id, successor, expectedRevision: 1, change});
  assert.equal(saved.id, successor.id);
  const replay = await runtimeRepository.saveRecurringScheduleSuccessor({predecessorId: root.id, successor, expectedRevision: 1, change});
  assert.equal(replay.id, successor.id);
  await assert.rejects(
   () => runtimeRepository.saveRecurringScheduleSuccessor({predecessorId: root.id, successor: {...successor, id: "runtime-schedule-other"}, expectedRevision: 1, change: {...change, id: "record-change:runtime-schedule-other", targetId: "runtime-schedule-other"}}),
   /branch already exists/i,
  );
  await assert.rejects(
   () => runtimeRepository.saveRecurringScheduleSuccessor({predecessorId: root.id, successor, expectedRevision: 0, change}),
   /revision is stale/i,
  );
  const rows = await db.query<{id:string; active:boolean|null; amount_cents:number|null; effective_to:string|null}>("SELECT id, active, amount_cents, effective_to::text FROM rent_ops_recurring_charge_schedules WHERE id IN ('runtime-schedule-root','runtime-schedule-end') ORDER BY id");
  assert.deepEqual(rows.rows, [
   {id: "runtime-schedule-end", active: false, amount_cents: null, effective_to: "2026-09-10"},
   {id: "runtime-schedule-root", active: true, amount_cents: 1000, effective_to: "2027-12-31"},
  ]);
  const audits = await db.query<{target_id:string; revision:number; changed_fields:string[]}>("SELECT target_id, revision, changed_fields FROM rent_ops_record_changes WHERE target_id = 'runtime-schedule-end'");
  assert.deepEqual(audits.rows, [{target_id: "runtime-schedule-end", revision: 2, changed_fields: ["active", "activeKnowledge", "amountCents", "amountKnowledge", "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "recordRevision", "supersedesId", "versionAction", "versionOrigin"]}]);
 } finally { await db.close(); }
});
