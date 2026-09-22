import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../persistence';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../repositories/postgres';
import { deriveSharedPaymentApplications, deriveTenantLedger } from '../domain/reports';
import type { RentOpsLedgerTransaction } from '../../../shared/rent-ops-contracts';

test('PostgreSQL readback keeps one shared receipt and reconstructs lagged applications',async()=>{
 const db=new PGlite();try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  const executor:RentOpsQueryExecutor={async query<T>(sql,args){if(sql.includes('has_table_privilege'))return{rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};return db.query<T>(sql,args?.map(v=>v===undefined?null:v));}};
  const repo=new PostgresRentOpsRepository(executor);
  await db.exec(`INSERT INTO rent_ops_properties(id,slug) VALUES('p1','p1'),('p2','p2');INSERT INTO rent_ops_units(id,property_id,property_link_knowledge)VALUES('u1','p1','manual'),('u2','p2','manual');INSERT INTO rent_ops_people(id)VALUES('person');INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)VALUES('t1','p1','u1','person','current',NOW(),'manual','manual','manual','manual'),('t2','p2','u2','person','current',NOW(),'manual','manual','manual','manual');`);
  await db.exec('CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA public TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer');
  const base:RentOpsLedgerTransaction={id:'charge1',reversalOfId:null,adjustmentDirection:null,allocationMode:null,propertyId:'p1',unitId:'u1',personId:'person',tenancyId:'t1',kind:'charge',category:'base_rent',categoryKnowledge:'source',status:'posted',amountCents:6000,postedOn:'2026-07-01',dueOn:null,dueOnKnowledge:'unknown',description:'Rent',payer:'tenant',payerKnowledge:'source',propertyLinkKnowledge:'exact',unitLinkKnowledge:'exact',personLinkKnowledge:'exact',tenancyLinkKnowledge:'exact',amountKnowledge:'known',postedOnKnowledge:'source',statusKnowledge:'source',descriptionKnowledge:'source',chargeDefinitionId:null,chargeDefinitionLinkKnowledge:'unknown',paymentMethod:null,paymentMethodKnowledge:'unknown',sourceArtifactSha256:'a'.repeat(64),artifactObservationOn:'2026-08-06',source:{system:'rent_manager',entityType:'ledger_transaction',sourceId:'charge1'}};
  await repo.saveLedgerTransaction(base);
  await repo.saveLedgerTransaction({...base,id:'charge2',propertyId:'p2',unitId:'u2',tenancyId:'t2',amountCents:4000,source:{...base.source!,sourceId:'charge2'}});
  const receipt:RentOpsLedgerTransaction={...base,id:'receipt',kind:'payment',propertyId:null,unitId:null,tenancyId:null,propertyLinkKnowledge:'unknown',unitLinkKnowledge:'unknown',tenancyLinkKnowledge:'unknown',amountCents:10000,postedOn:'2026-07-30',allocationMode:'multi_property',source:{...base.source!,sourceId:'receipt'}};
  await repo.saveLedgerTransaction(receipt);
  for(const [id,amountCents,allocatedOn] of [['1',6000,'2026-08-02'],['2',4000,'2026-08-05']] as const) await repo.savePaymentAllocation({id:`allocation${id}`,source:{system:'rent_manager',entityType:'payment_allocation',sourceId:`allocation${id}`,sourceUpdatedAt:'2026-08-06T12:00:00.000Z'},sourceArtifactSha256:'a'.repeat(64),artifactObservationOn:'2026-08-06',kind:'allocation',paymentTransactionId:'receipt',chargeTransactionId:`charge${id}`,amountCents,allocatedOn,paymentLinkKnowledge:'exact',chargeLinkKnowledge:'exact',amountKnowledge:'known',allocatedOnKnowledge:'source'});
  await repo.saveLedgerTransaction(receipt);
  const snapshot=await repo.getSnapshot();
  assert.equal(snapshot.paymentAllocations[0].source?.sourceUpdatedAt,'2026-08-06T12:00:00.000Z');
  assert.equal(snapshot.ledgerTransactions.filter(row=>row.kind==='payment').length,1);
  const root=snapshot.ledgerTransactions.find(row=>row.id==='receipt')!;
  assert.equal(root.amountCents,10000);assert.equal(root.postedOn,'2026-07-30');assert.equal(root.propertyId,null);assert.equal(root.unitId,null);assert.equal(root.tenancyId,null);
  assert.equal(deriveSharedPaymentApplications(snapshot,{asOfDate:'2026-07-31'})[0].unappliedCents,10000);
  assert.equal(deriveSharedPaymentApplications(snapshot,{asOfDate:'2026-08-03'})[0].unappliedCents,4000);
  assert.equal(deriveSharedPaymentApplications(snapshot,{asOfDate:'2026-08-06'})[0].unappliedCents,0);
  assert.equal(deriveTenantLedger(snapshot,'t1',{asOfDate:'2026-08-03'}).at(-1)?.runningBalanceCents,0);
  assert.equal(deriveTenantLedger(snapshot,'t2',{asOfDate:'2026-08-03'}).at(-1)?.runningBalanceCents,4000);
 }finally{await db.close();}
});
