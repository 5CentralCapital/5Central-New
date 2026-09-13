import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {ensureRentOpsSchema,RENT_OPS_RUNTIME_REQUIRED_TABLES} from '../persistence';
import {PostgresRentOpsRepository} from '../repositories/postgres';
import {RentOpsService} from './service';
import {registerRentOpsRoutes} from '../routes';
test('charge terms authenticated HTTP append and scoped Postgres read preserve financial rows',async()=>{
 const db=new PGlite();let server:any;
 try{
  await ensureRentOpsSchema({apply:true,executor:async sql=>{await db.exec(sql);}});
  await db.exec(`INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type) VALUES('p','QA','qa','1 QA','QA','FL','00000','multifamily');
    INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES('u','p','1','manual');
    INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('person','QA','Resident');
    INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES('t','p','u','person','current',NOW(),'manual','manual','manual','manual');`);
  await db.exec('CREATE ROLE qa_terms; GRANT USAGE ON SCHEMA public TO qa_terms');for(const table of RENT_OPS_RUNTIME_REQUIRED_TABLES)await db.exec(`GRANT ${table==='rent_ops_schema_migrations'?'SELECT':'SELECT,INSERT,UPDATE'} ON ${table} TO qa_terms`);await db.exec('SET ROLE qa_terms');
  const statements:string[]=[];const adapt=(d:any):any=>({query:(sql:string,args:any[])=>{statements.push(sql);return d.query(sql,args?.map(x=>x===undefined?null:x));},transaction:(work:any)=>d.transaction?d.transaction((tx:any)=>work(adapt(tx))):work(adapt(d))});
  const repository=new PostgresRentOpsRepository(adapt(db));const service=new RentOpsService(repository);const context={actorSubject:'qa',occurredAt:'2026-09-12T14:00:00.000Z'};
  await service.createChargeDefinition({id:'rent',displayName:'Rent',category:'base_rent',active:true},context);
  await service.saveRecurringSchedule({id:'schedule',scopeType:'tenant',scopeId:'person',personId:'person',tenancyId:'t',propertyId:'p',unitId:'u',chargeDefinitionId:'rent',category:'base_rent',description:'Rent',amountCents:100000,effectiveFrom:'2026-09-12',active:true,billingFrequency:'monthly',lineageRootId:'schedule',lineageRootOrigin:'manual',versionOrigin:'manual',versionAction:'root'},context);
  const before=(await db.query("SELECT * FROM rent_ops_recurring_charge_schedules")).rows;
  const app=express();app.use(express.json());registerRentOpsRoutes(app,{repository,now:()=>new Date(context.occurredAt),requireAdmin:(req,res,next)=>{if(req.headers['x-test-admin']!=='yes'){res.sendStatus(401);return;}req.rentOpsAdminUser={id:'qa'} as any;next();}});
  server=await new Promise<any>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const base=`http://127.0.0.1:${server.address().port}/api/rent-ops`;
  const input={appliesFrom:'2026-09-12',expectedScheduleRevision:1,expectedReviewRevision:0,personId:'person',tenancyId:'t',propertyId:'p',unitId:'u',amountCents:100000,verifiedRateFrom:'2025-07-01',rateFromKnowledge:'verified',leaseFrom:'2025-07-01',leaseFromKnowledge:'verified',leaseThrough:null,leaseThroughKnowledge:'month_to_month',evidenceReference:'QA lease evidence',evidenceSha256:'a'.repeat(64)};
  const post=()=>fetch(base+'/recurring-schedules/schedule/terms',{method:'POST',headers:{'x-test-admin':'yes','content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await fetch(base+'/recurring-charge-terms?scheduleIds=schedule')).status,401);
  statements.length=0;const concurrent=await Promise.all([post(),post()]);assert.deepEqual(concurrent.map(row=>row.status).sort(),[201,409]);
  const saved=concurrent.find(row=>row.status===201)!;assert.equal((await saved.json()).verifiedRateFrom,'2025-07-01');
  const fence=statements.findIndex(sql=>sql.startsWith('UPDATE rent_ops_people SET id = id'));const scheduleRead=statements.findIndex(sql=>sql.startsWith('SELECT * FROM rent_ops_recurring_charge_schedules WHERE'));assert(fence>=0&&scheduleRead>fence,'parent tuple fence precedes review snapshot read');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM rent_ops_activity_events WHERE id LIKE 'activity:charge-terms:%'")).rows[0].n,1);
  statements.length=0;const response=await fetch(base+'/recurring-charge-terms?scheduleIds=schedule',{headers:{'x-test-admin':'yes'}});assert.equal(response.status,200);const read=await response.json();assert.equal(read.rows[0].leaseThroughKnowledge,'month_to_month');assert.equal('evidenceReference' in read.rows[0],false);
  assert.equal(statements.some(sql=>/FROM rent_ops_ledger|FROM rent_ops_documents/.test(sql)),false);
  assert.deepEqual((await db.query('SELECT * FROM rent_ops_recurring_charge_schedules')).rows,before);
  assert.equal((await db.query('SELECT * FROM rent_ops_ledger_transactions')).rows.length,0);
 }finally{if(server)await new Promise<void>(r=>server.close(()=>r()));await db.close();}
});
