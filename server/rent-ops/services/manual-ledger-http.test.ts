import assert from 'node:assert/strict';import test from 'node:test';import express from 'express';import {PGlite} from '@electric-sql/pglite';import {ensureRentOpsSchema,RENT_OPS_RUNTIME_REQUIRED_TABLES} from '../persistence';import {PostgresRentOpsRepository} from '../repositories/postgres';import {registerRentOpsRoutes} from '../routes';import {RentOpsService} from './service';
test('manual ledger HTTP facts persist on schema26 with server-owned knowledge and no source provenance',async()=>{
 const db=new PGlite();let server:any;
 try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec("INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type) VALUES('p','QA','qa','1 QA','QA','FL','00000','multifamily')");
  await db.exec('CREATE ROLE qa_manual; GRANT USAGE ON SCHEMA public TO qa_manual');for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES)await db.exec(`GRANT ${table==='rent_ops_schema_migrations'?'SELECT':'SELECT,INSERT,UPDATE'} ON ${table} TO qa_manual`);await db.exec('SET ROLE qa_manual');
  const adapt=(d:any):any=>({query:(sql:string,args:any[])=>d.query(sql,args?.map(x=>x===undefined?null:x)),transaction:(work:any)=>d.transaction?d.transaction((tx:any)=>work(adapt(tx))):work(adapt(d))});
  const repository=new PostgresRentOpsRepository(adapt(db));const app=express();app.use(express.json());registerRentOpsRoutes(app,{repository,requireAdmin:(_q,_s,next)=>next()});server=await new Promise<any>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const base=`http://127.0.0.1:${server.address().port}/api/rent-ops`;
  const post=async(path:string,body:any)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const common={propertyId:'p',category:'other',status:'posted',amountCents:100,postedOn:'2026-09-08',description:'Manual QA'};
  for(const kind of ['charge','payment','credit','adjustment']){const r=await post('/ledger/transactions',{...common,id:kind,kind,...(kind==='payment'?{paymentMethod:'cash'}:{}),...(kind==='adjustment'?{adjustmentDirection:'credit'}:{})});assert.equal(r.status,201,kind+JSON.stringify(await r.json()));}
  const rows=(await db.query('SELECT * FROM rent_ops_ledger_transactions')).rows;assert.equal(rows.length,4);for(const row of rows){assert.equal(row.category_knowledge,'manual');assert.equal(row.status_knowledge,'manual');assert.equal(row.amount_knowledge,'known');assert.equal(row.property_link_knowledge,'manual');assert.equal(row.person_link_knowledge,'unknown');assert.equal(row.due_on_knowledge,'unknown');assert.equal(row.source_system,null);}
  for(const extra of [{source:{system:'rent-manager',sourceId:'x'}},{amountKnowledge:'unknown'},{sourceArtifactSha256:'a'.repeat(64)},{categoryKnowledge:'source'}])assert.equal((await post('/ledger/transactions',{...common,id:'forbidden',kind:'charge',...extra})).status,400);
  const service=new RentOpsService(repository);await assert.rejects(service.saveLedgerTransaction({...common,id:'forbidden',kind:'charge',source:{system:'rent-manager',sourceId:'x'}} as any),/provenance/);await assert.rejects(service.saveLedgerTransaction({...common,id:'forbidden',kind:'charge',amountKnowledge:'unknown'} as any),/knowledge/);
  assert.equal((await post('/ledger/allocations',{id:'allocation',paymentTransactionId:'payment',chargeTransactionId:'charge',amountCents:50,allocatedOn:'2026-09-08'})).status,201);
  assert.equal((await post('/ledger/charge/reverse',{id:'reversal',postedOn:'2026-09-08',description:'Reverse QA'})).status,201);
 }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));await db.close();}
});
