import { deriveTenantLedger } from "../domain/reports";
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";
import type { RentOpsRecordChange, RentOpsRecurringChargeSchedule } from "../../../shared/rent-ops-contracts";

test("payment corrections are atomic, persistent, allocated and idempotent",async()=>{
 const db=new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec("CREATE ROLE qa_operations; GRANT USAGE ON SCHEMA public TO qa_operations");
  for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : ["rent_ops_ledger_transactions","rent_ops_payment_allocations"].includes(table) ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE"} ON ${table} TO qa_operations`);
  await db.exec("SET ROLE qa_operations");
  let failAudit=false;
  const adapt=(connection:any):RentOpsQueryExecutor=>({query:async(sql,values)=>{if(failAudit && sql.startsWith("INSERT INTO rent_ops_record_changes"))throw Error("audit unavailable");return connection.query(sql,values?.map(value=>value===undefined?null:value));},transaction:async work=>connection.transaction?connection.transaction((tx:any)=>work(adapt(tx))):work(adapt(connection))});
  const service=new RentOpsService(new PostgresRentOpsRepository(adapt(db)));
  const context={actorSubject:"qa",occurredAt:"2026-09-08T12:00:00.000Z"};
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

  const before=await service.paymentEditContext("manual");
  const correction={id:"edit-1",expectedRevision:before.expectedRevision,amountCents:400,postedOn:"2026-09-07",paymentMethod:"check" as const,description:"Corrected receipt",allocations:[{chargeTransactionId:"charge",amountCents:400}]};
  const result=await service.correctPayment("manual",correction,context);
  assert.equal(result.payment.amountCents,400);
  assert.equal((await service.correctPayment("manual",correction,context)).replayed,true);
  await assert.rejects(service.correctPayment("manual",{...correction,amountCents:450},context),/conflict/);
  const corrected=await service.snapshot();
  assert.equal(corrected.ledgerTransactions.find(row=>row.id==="manual")!.amountCents,500);
  assert.equal(corrected.ledgerTransactions.filter(row=>row.reversalOfId==="manual").length,1);
  assert.equal(corrected.paymentAllocations.find(row=>row.paymentTransactionId===result.payment.id)!.amountCents,400);
  const ledger=deriveTenantLedger(corrected,"t",{asOfDate:"2026-09-17"});
  assert.equal(ledger.at(-1)!.runningBalanceCents,600,"reports use the corrected payment, not both payments");
  assert.equal(ledger.find(row=>row.transaction.id==="charge")!.openCents,600);
  await assert.rejects(service.paymentEditContext("manual"),/already/);
  const current=await service.paymentEditContext(result.payment.id);
  await assert.rejects(service.correctPayment(result.payment.id,{...correction,id:"bad",expectedRevision:"0".repeat(64)},context),/stale/);
  await assert.rejects(service.correctPayment(result.payment.id,{...correction,id:"overallocated",expectedRevision:current.expectedRevision,amountCents:300},context),/exceed/);
  // A failure after reversal/replacement insertion must roll back all rows.
  const count=corrected.ledgerTransactions.length;
  await assert.rejects(service.correctPayment(result.payment.id,{...correction,id:"rollback",expectedRevision:current.expectedRevision,allocations:[{chargeTransactionId:"charge",amountCents:1001}],amountCents:1100},context),/exceed/);
  assert.equal((await service.snapshot()).ledgerTransactions.length,count);
  assert.equal((await service.paymentEditContext(result.payment.id)).expectedRevision,current.expectedRevision);
  await db.exec("RESET ROLE; CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON rent_ops_ledger_transactions TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
  await db.exec(`INSERT INTO rent_ops_ledger_transactions(id,property_id,unit_id,tenancy_id,person_id,kind,category,category_knowledge,status,status_knowledge,amount_cents,amount_knowledge,posted_on,posted_on_knowledge,due_on_knowledge,payment_method_knowledge,description,description_knowledge,payer,payer_knowledge,property_link_knowledge,unit_link_knowledge,tenancy_link_knowledge,person_link_knowledge,charge_definition_link_knowledge,source_system,source_id,source_artifact_sha256,artifact_observation_on)
   VALUES('imported-payment','p',NULL,'t','person','payment','base_rent','source','posted','source',125000,'known','2026-09-02','source','unknown','unknown','Payment','source','tenant','source','exact','unknown','exact','exact','unknown','rent_manager','source-payment',repeat('a',64),'2026-09-12')`);
  await db.exec("SET ROLE qa_operations");
  const imported=await service.paymentEditContext("imported-payment");
  const importedResult=await service.correctPayment("imported-payment",{...correction,id:"import-correction",expectedRevision:imported.expectedRevision,amountCents:120000,allocations:[]},context);
  assert.equal(importedResult.payment.amountCents,120000);
  assert.equal(importedResult.payment.unitId,null,"editing never guesses a missing unit");
  assert.equal((await service.snapshot()).ledgerTransactions.find(row=>row.id==="imported-payment")!.source!.system,"rent_manager");
 } finally {await db.close();}
});
