import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../persistence';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../repositories/postgres';
import { DATABASE_AUDIT_SQL } from '../import/database-audit';
import { deriveTenantLedger } from '../domain/reports';
import type { RentOpsLedgerTransaction, RentOpsPaymentAllocation } from '../../../shared/rent-ops-contracts';

test('PostgreSQL persists exact signed source allocations and forbids native negatives or mutation',async()=>{
 const db=new PGlite();try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  const executor:RentOpsQueryExecutor={async query<T>(sql,args){if(sql.includes('has_table_privilege'))return{rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};return db.query<T>(sql,args?.map(v=>v===undefined?null:v));}};
  const repo=new PostgresRentOpsRepository(executor);
  await db.exec(`INSERT INTO rent_ops_properties(id,slug) VALUES('p','p');INSERT INTO rent_ops_units(id,property_id,property_link_knowledge)VALUES('u','p','manual');INSERT INTO rent_ops_people(id)VALUES('person');INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)VALUES('t','p','u','person','current',NOW(),'manual','manual','manual','manual');`);
  const base:RentOpsLedgerTransaction={id:'charge',propertyId:'p',unitId:'u',personId:'person',tenancyId:'t',kind:'charge',category:'base_rent',categoryKnowledge:'manual',status:'posted',amountCents:10000,postedOn:'2026-09-01',dueOn:null,dueOnKnowledge:'unknown',description:'Rent',payer:'tenant',payerKnowledge:'manual',propertyLinkKnowledge:'manual',unitLinkKnowledge:'manual',personLinkKnowledge:'manual',tenancyLinkKnowledge:'manual',amountKnowledge:'known',postedOnKnowledge:'manual',statusKnowledge:'manual',descriptionKnowledge:'manual',chargeDefinitionId:null,chargeDefinitionLinkKnowledge:'unknown',paymentMethod:null,paymentMethodKnowledge:'unknown'};
  await repo.saveLedgerTransaction(base);await repo.saveLedgerTransaction({...base,id:'payment',kind:'payment'});
  await db.exec("CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA public TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer");
  const positive:RentOpsPaymentAllocation={id:'a',source:{system:'rent_manager',entityType:'payment_allocation',sourceId:'allocation:1'},paymentTransactionId:'payment',chargeTransactionId:'charge',amountCents:10000,allocatedOn:'2026-09-01',paymentLinkKnowledge:'exact',chargeLinkKnowledge:'exact',amountKnowledge:'known',allocatedOnKnowledge:'source'};
  await repo.savePaymentAllocation(positive);
  const reverse:RentOpsPaymentAllocation={...positive,id:'r',source:{...positive.source!,sourceId:'allocation:2'},kind:'reversal',amountCents:-10000,allocatedOn:'2026-09-03',sourceArtifactSha256:'a'.repeat(64),artifactObservationOn:'2026-09-07'};
  await repo.savePaymentAllocation(reverse);await repo.savePaymentAllocation(reverse);
  await repo.savePaymentAllocation({...reverse,id:"transfer",kind:"transfer",amountCents:10000,source:{...reverse.source!,sourceId:"allocation:3"}});
  const snapshot=await repo.getSnapshot();assert.equal(snapshot.paymentAllocations.length,3);assert.equal(snapshot.paymentAllocations.find(r=>r.id==='r')?.amountCents,-10000);
  assert.equal(deriveTenantLedger(snapshot,'t',{asOfDate:'2026-09-02'}).find(r=>r.transaction.id==='charge')?.openCents,0);
  assert.equal(deriveTenantLedger(snapshot,'t',{asOfDate:'2026-09-04'}).find(r=>r.transaction.id==='charge')?.openCents,10000);
  await db.exec("RESET ROLE");
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);},query:sql=>db.query(sql)});
  assert.equal((await repo.getSnapshot()).paymentAllocations.find(row=>row.id==="r")?.amountCents,-10000);
  await db.exec("SET ROLE rent_ops_staging_importer");
  const audit=await db.query<Record<string,unknown>>(DATABASE_AUDIT_SQL.allocationInvariants);assert.ok(Object.values(audit.rows[0]).every(value=>Number(value)===0));
  await assert.rejects(repo.savePaymentAllocation({...reverse,id:'native',source:undefined}),/constraint/);
  await assert.rejects(repo.savePaymentAllocation({...reverse,id:'unbound',sourceArtifactSha256:null}),/constraint/);
  await assert.rejects(repo.savePaymentAllocation({...reverse,amountCents:-1}),/append|different|immutable|conflict/i);
 }finally{await db.close();}
});
