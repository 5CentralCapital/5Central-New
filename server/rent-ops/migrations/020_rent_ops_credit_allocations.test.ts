import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../persistence';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../repositories/postgres';
import { deriveSharedPaymentApplications, deriveTenantLedger } from '../domain/reports';
import type { RentOpsLedgerTransaction } from '../../../shared/rent-ops-contracts';

test('PostgreSQL retains a source credit application without creating a cash receipt',async()=>{
 const db=new PGlite();try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  const executor:RentOpsQueryExecutor={async query<T>(sql,args){if(sql.includes('has_table_privilege'))return{rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};return db.query<T>(sql,args?.map(v=>v===undefined?null:v));}};
  const repo=new PostgresRentOpsRepository(executor);
  await db.exec(`INSERT INTO rent_ops_properties(id,slug) VALUES('p1','p1'),('p2','p2');INSERT INTO rent_ops_units(id,property_id,property_link_knowledge)VALUES('u1','p1','manual'),('u2','p2','manual');INSERT INTO rent_ops_people(id)VALUES('person');INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)VALUES('t1','p1','u1','person','current',NOW(),'manual','manual','manual','manual'),('t2','p2','u2','person','current',NOW(),'manual','manual','manual','manual');`);
  await db.exec('CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA public TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer');
  const base:RentOpsLedgerTransaction={id:'charge1',reversalOfId:null,adjustmentDirection:null,allocationMode:null,propertyId:'p1',unitId:'u1',personId:'person',tenancyId:'t1',kind:'charge',category:'base_rent',categoryKnowledge:'source',status:'posted',amountCents:6000,postedOn:'2026-07-01',dueOn:null,dueOnKnowledge:'unknown',description:'Rent',payer:'tenant',payerKnowledge:'source',propertyLinkKnowledge:'exact',unitLinkKnowledge:'exact',personLinkKnowledge:'exact',tenancyLinkKnowledge:'exact',amountKnowledge:'known',postedOnKnowledge:'source',statusKnowledge:'source',descriptionKnowledge:'source',chargeDefinitionId:null,chargeDefinitionLinkKnowledge:'unknown',paymentMethod:null,paymentMethodKnowledge:'unknown',sourceArtifactSha256:'a'.repeat(64),artifactObservationOn:'2026-08-06',source:{system:'rent_manager',entityType:'ledger_transaction',sourceId:'charge1'}};
  await repo.saveLedgerTransaction(base);
  await repo.saveLedgerTransaction({...base,id:'credit',kind:'credit',source:{...base.source!,sourceId:'credit'}});
  const allocation={id:'credit-a',kind:'credit_allocation' as const,creditTransactionId:'credit',creditLinkKnowledge:'exact' as const,paymentTransactionId:null,paymentLinkKnowledge:'unknown' as const,chargeTransactionId:'charge1',chargeLinkKnowledge:'exact' as const,amountCents:6000,amountKnowledge:'known' as const,allocatedOn:'2026-08-02',allocatedOnKnowledge:'source' as const,source:{system:'rent_manager',entityType:'payment_allocation' as const,sourceId:'credit-a'},sourceArtifactSha256:'a'.repeat(64),artifactObservationOn:'2026-08-06'};
  await repo.savePaymentAllocation(allocation);
  const snapshot=await repo.getSnapshot();
  assert.equal(snapshot.paymentAllocations[0].creditTransactionId,'credit');
  assert.equal(snapshot.paymentAllocations[0].paymentTransactionId,null);
  assert.equal(snapshot.ledgerTransactions.filter(row=>row.kind==='payment').length,0);
  const {validateSnapshot}=await import('../domain/invariants');
  assert.equal(validateSnapshot({...snapshot,paymentAllocations:[...snapshot.paymentAllocations,{...allocation,id:'excess',amountCents:1}]}).some(v=>v.code==='allocations_exceed_payment'),true);
  assert.equal(validateSnapshot({...snapshot,paymentAllocations:[...snapshot.paymentAllocations,{...allocation,id:'excess',amountCents:1}]}).some(v=>v.code==='allocations_exceed_charge'),true);
  assert.equal(deriveTenantLedger(snapshot,'t1',{asOfDate:'2026-08-03'}).find(row=>row.transaction.id==='charge1')?.openCents,0);
  await assert.rejects(repo.savePaymentAllocation({...allocation,id:'native',source:undefined,sourceArtifactSha256:null}));
  await assert.rejects(repo.savePaymentAllocation({...allocation,id:'negative',source:{...allocation.source,sourceId:'negative'},amountCents:-1}));
  await assert.rejects(repo.savePaymentAllocation({...allocation,id:'unbound',source:{...allocation.source,sourceId:'unbound'},creditLinkKnowledge:'unknown'}));
 }finally{await db.close();}
});
