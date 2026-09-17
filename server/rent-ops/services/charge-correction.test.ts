import { deriveTenantLedger } from "../domain/reports";
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";
import type { RentOpsRecordChange, RentOpsRecurringChargeSchedule } from "../../../shared/rent-ops-contracts";

test("charge corrections preserve receipts and update balances atomically",async()=>{
 const db=new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec("CREATE ROLE qa_operations; GRANT USAGE ON SCHEMA public TO qa_operations");
  for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : ["rent_ops_ledger_transactions","rent_ops_payment_allocations"].includes(table) ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE"} ON ${table} TO qa_operations`);
  await db.exec("SET ROLE qa_operations");
  let failAudit=false;
  const adapt=(connection:any):RentOpsQueryExecutor=>({query:async(sql,values)=>{if(failAudit && sql.startsWith("INSERT INTO rent_ops_activity_events"))throw Error("audit unavailable");return connection.query(sql,values?.map(value=>value===undefined?null:value));},transaction:async work=>connection.transaction?connection.transaction((tx:any)=>work(adapt(tx))):work(adapt(connection))});
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

  const before=await service.chargeEditContext("charge");
  const correction={id:"edit-charge",expectedRevision:before.expectedRevision,amountCents:300,postedOn:"2026-09-02",dueOn:"2026-09-05",category:"one_time_fee" as const,description:"Corrected fee"};
  const result=await service.correctCharge("charge",correction,context);
  assert.equal(result.charge.amountCents,300);
  assert.equal(result.charge.dueOn,"2026-09-05");
  assert.equal((await service.correctCharge("charge",correction,context)).replayed,true);
  await assert.rejects(service.correctCharge("charge",{...correction,amountCents:400},context),/conflict/);
  const snapshot=await service.snapshot();
  assert.equal(snapshot.ledgerTransactions.find(row=>row.id==="charge")!.amountCents,1000);
  assert.equal(snapshot.ledgerTransactions.find(row=>row.id==="manual")!.amountCents,500);
  assert.equal(snapshot.paymentAllocations.find(row=>row.chargeTransactionId===result.charge.id)!.amountCents,300);
  assert.equal(deriveTenantLedger(snapshot,"t",{asOfDate:"2026-09-17"}).at(-1)!.runningBalanceCents,-200);
  await assert.rejects(service.chargeEditContext("charge"),/already/);
  const current=await service.chargeEditContext(result.charge.id);
  await assert.rejects(service.correctCharge(result.charge.id,{...correction,id:"stale",expectedRevision:"0".repeat(64)},context),/stale/);
  failAudit=true;
  await assert.rejects(service.correctCharge(result.charge.id,{...correction,id:"rollback",expectedRevision:current.expectedRevision,amountCents:600},context),/audit unavailable/);
  failAudit=false;
  assert.equal((await service.snapshot()).ledgerTransactions.length,snapshot.ledgerTransactions.length);
  assert.equal((await service.chargeEditContext(result.charge.id)).expectedRevision,current.expectedRevision);
 } finally {await db.close();}
});
