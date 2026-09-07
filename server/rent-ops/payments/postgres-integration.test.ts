import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../persistence';
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from '../repositories/postgres';
import { TenantPaymentService } from './service';
import { PostgresTenantPaymentStore } from './store';
import { presentTenantHome } from '../tenant-portal/presentation';

test('real PostgreSQL payment and refund retries preserve complete tenant balance and allocations', async () => {
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
  await repo.saveLedgerTransaction({id:'rent',propertyId:'p',unitId:'u',personId:'person',tenancyId:'t',kind:'charge',category:'base_rent',categoryKnowledge:'manual',status:'posted',amountCents:10000,postedOn:'2026-09-01',dueOn:'2026-09-01',description:'Rent',payer:'tenant',payerKnowledge:'manual',propertyLinkKnowledge:'manual',unitLinkKnowledge:'manual',personLinkKnowledge:'manual',tenancyLinkKnowledge:'manual',amountKnowledge:'known',postedOnKnowledge:'manual',dueOnKnowledge:'manual',statusKnowledge:'manual',descriptionKnowledge:'manual',chargeDefinitionId:null,chargeDefinitionLinkKnowledge:'unknown',paymentMethod:null,paymentMethodKnowledge:'unknown'});
  const identity={id:'a',personId:'person',tenancyId:'t',email:'test@example.com',status:'active' as const};
  const service=new TenantPaymentService(new PostgresTenantPaymentStore(executor),{live:false,async createCheckout(){return{id:'cs_fake',url:'https://checkout.stripe.com/fake'};},verify(){throw Error('unused');}},()=>new Date('2026-09-07T12:00:00Z'));
  const payment=await service.checkout(identity,{tenancyId:'t',amountCents:10000,requestId:'00000000-0000-4000-8000-000000000001'});
  const success={id:'success',type:'payment_intent.succeeded',created:100,live:false,state:'success' as const,paymentId:payment.id,paymentIntentId:'pi_fake',amountCents:10000,currency:'usd'};
  await service.process(success);await service.process(success);await service.process({...success,id:'success_retry'});
  let snapshot=await repo.getSnapshot();
  assert.equal(snapshot.modelVersion,3);assert.equal(snapshot.paymentAllocations.length,1);
  assert.deepEqual(presentTenantHome(snapshot,identity,'2026-09-07')?.balance,{amountCents:0,complete:true,asOfDate:'2026-09-07'});
  const refund={id:'refund',type:'refund.updated',created:101,live:false,state:'adjustment' as const,paymentIntentId:'pi_fake',adjustment:{providerObjectId:'re_fake',kind:'refund' as const,amountCents:2000,active:true,terminal:true}};
  await service.process(refund);await service.process(refund);await service.process({...refund,id:'refund_retry'});
  snapshot=await repo.getSnapshot();assert.equal(snapshot.ledgerTransactions.length,4);assert.equal(snapshot.paymentAllocations.length,2);
  assert.deepEqual(presentTenantHome(snapshot,identity,'2026-09-07')?.balance,{amountCents:2000,complete:true,asOfDate:'2026-09-07'});
 } finally {await db.close();}
});
