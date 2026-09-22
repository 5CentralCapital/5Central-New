import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../persistence';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../repositories/postgres';
import { TenantPaymentService } from './service';
import { PostgresTenantPaymentStore } from './store';
import { presentTenantHome } from '../tenant-portal/presentation';

for (const importedAccount of [false,true]) test(`real PostgreSQL ${importedAccount ? 'RM account-scoped' : 'native tenancy'} payment and refund retries preserve complete balance`, async () => {
 const db = new PGlite();
 try {
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  // Privilege probe alone is stubbed: all repository writes/reads and transactions use PostgreSQL.
  const adapt=(conn:any):RentOpsQueryExecutor=>({async query<T>(sql:string,args?:unknown[]){if(sql.includes('has_table_privilege'))return {rows:(args![0] as string[]).map(table_name=>({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false})) as T[]};return conn.query(sql,args?.map(v=>v===undefined?null:v));},transaction:async work=>conn.transaction ? conn.transaction((tx:any)=>work(adapt(tx))) : work(adapt(conn))});
  const executor=adapt(db),repo=new PostgresRentOpsRepository(executor);
  await db.exec(`INSERT INTO rent_ops_properties(id,slug) VALUES ('p','p');
   INSERT INTO rent_ops_units(id,property_id,property_link_knowledge) VALUES ('u','p','manual');
   INSERT INTO rent_ops_people(id) VALUES ('person');
   INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES ('t','p','u','person','current',NOW(),'manual','manual','manual','manual');
   INSERT INTO rent_ops_tenant_accounts(id,email,person_id,tenancy_id) VALUES ('a','test@example.com','person','t');`);
  if(importedAccount) await db.exec("CREATE ROLE rent_ops_staging_importer; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer; UPDATE rent_ops_people SET source_system='rent_manager',source_id='887' WHERE id='person'");
  await repo.saveLedgerTransaction({id:'rent',propertyId:'p',unitId:'u',personId:'person',tenancyId:importedAccount?null:'t',...(importedAccount?{source:{system:'rent_manager' as const,entityType:'ledger_transaction' as const,sourceId:'charge:1'},sourceArtifactSha256:'a'.repeat(64),artifactObservationOn:'2026-09-07',reversalOfId:null,adjustmentDirection:null,allocationMode:null}:{}),kind:'charge',category:'base_rent',categoryKnowledge:'manual',status:'posted',amountCents:10000,postedOn:'2026-09-01',dueOn:'2026-09-01',description:'Rent',payer:'tenant',payerKnowledge:'manual',propertyLinkKnowledge:'manual',unitLinkKnowledge:'manual',personLinkKnowledge:importedAccount?'exact':'manual',tenancyLinkKnowledge:importedAccount?'unknown':'manual',amountKnowledge:'known',postedOnKnowledge:'manual',dueOnKnowledge:'manual',statusKnowledge:'manual',descriptionKnowledge:'manual',chargeDefinitionId:null,chargeDefinitionLinkKnowledge:'unknown',paymentMethod:null,paymentMethodKnowledge:'unknown'});
  if(importedAccount) {
    await db.exec("INSERT INTO rent_ops_units(id,property_id,property_link_knowledge) VALUES ('old-unit','p','manual')");
    const rent=(await repo.getSnapshot()).ledgerTransactions.find(row=>row.id==='rent')!;
    await repo.saveLedgerTransaction({...rent,id:'historical-unknown',unitId:'old-unit',propertyLinkKnowledge:'exact',unitLinkKnowledge:'exact',source:{...rent.source!,sourceId:'charge:unknown'},category:null,categoryKnowledge:'unknown',amountCents:85000});
    await repo.saveLedgerTransaction({...rent,id:'historical-receipt',source:{...rent.source!,sourceId:'payment:historical'},kind:'payment',category:null,categoryKnowledge:'unknown',amountCents:85000});
    await repo.savePaymentAllocation({id:'historical-allocation',paymentTransactionId:'historical-receipt',chargeTransactionId:'historical-unknown',amountCents:85000,allocatedOn:'2026-09-01',paymentLinkKnowledge:'manual',chargeLinkKnowledge:'manual',amountKnowledge:'known',allocatedOnKnowledge:'manual'});
    await db.exec('RESET ROLE');
  }
  const identity={id:'a',personId:'person',tenancyId:'t',email:'test@example.com',status:'active' as const};
  const secondIdentity={...identity,id:'b',tenancyId:'t2'};
  if(importedAccount) await db.exec("INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES ('t2','p','u','person','future',NOW(),'manual','manual','manual','manual'); INSERT INTO rent_ops_tenant_accounts(id,email,person_id,tenancy_id) VALUES ('b','second@example.test','person','t2')");
  const service=new TenantPaymentService(new PostgresTenantPaymentStore(executor),{live:false,async createCheckout(){return{id:'cs_fake',url:'https://checkout.stripe.com/fake'};},verify(){throw Error('unused');}},()=>new Date('2026-09-07T12:00:00Z'));
  const attempts=await Promise.allSettled([service.checkout(identity,{tenancyId:'t',amountCents:10000,requestId:'00000000-0000-4000-8000-000000000001'}),...(importedAccount?[service.checkout(secondIdentity,{tenancyId:'t2',amountCents:10000,requestId:'00000000-0000-4000-8000-000000000002'})]:[])]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  if(importedAccount){assert.equal(attempts.filter(r=>r.status==='rejected').length,1);assert.equal((await service.list(secondIdentity)).accounts[0].pendingCents,10000);}
  const payment=(attempts.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;
  const success={id:'success',type:'payment_intent.succeeded',created:100,live:false,state:'success' as const,paymentId:payment.id,paymentIntentId:'pi_fake',amountCents:10000,currency:'usd'};
  await service.process(success);await service.process(success);await service.process({...success,id:'success_retry'});
  let snapshot=await repo.getSnapshot();
  assert.equal(snapshot.modelVersion,3);assert.equal(snapshot.paymentAllocations.length,importedAccount?2:1);
  assert.deepEqual(presentTenantHome(snapshot,identity,'2026-09-07')?.balance,{amountCents:0,complete:true,asOfDate:'2026-09-07'});
  if(importedAccount) assert.deepEqual(presentTenantHome(snapshot,secondIdentity,'2026-09-07')?.balance,{amountCents:0,complete:true,asOfDate:'2026-09-07'});
  const refund={id:'refund',type:'refund.updated',created:101,live:false,state:'adjustment' as const,paymentIntentId:'pi_fake',adjustment:{providerObjectId:'re_fake',kind:'refund' as const,amountCents:2000,active:true,terminal:true}};
  await service.process(refund);await service.process(refund);await service.process({...refund,id:'refund_retry'});
  snapshot=await repo.getSnapshot();assert.equal(snapshot.ledgerTransactions.length,importedAccount?6:4);assert.equal(snapshot.paymentAllocations.length,importedAccount?3:2);
  assert.deepEqual(presentTenantHome(snapshot,identity,'2026-09-07')?.balance,{amountCents:2000,complete:true,asOfDate:'2026-09-07'});
  if(importedAccount){assert.deepEqual(presentTenantHome(snapshot,secondIdentity,'2026-09-07')?.balance,{amountCents:2000,complete:true,asOfDate:'2026-09-07'});assert.equal((await service.list(secondIdentity)).accounts[0].payableCents,2000);}
  if(importedAccount){
    await db.exec('SET ROLE rent_ops_staging_importer');
    const receipt=snapshot.ledgerTransactions.find(row=>row.id==='historical-receipt')!;
    await repo.saveLedgerTransaction({...receipt,id:'historical-return',source:{...receipt.source!,sourceId:'payment:historical:reversal'},kind:'reversal',reversalOfId:receipt.id,postedOn:'2026-09-07',dueOn:null,dueOnKnowledge:'unknown'});
    await db.exec('RESET ROLE');
    assert.equal((await service.list(secondIdentity)).accounts[0].reason,'account_scope_payment_review_required');
  }
 } finally {await db.close();}
});
