/** TEST ONLY: real HTTP routers over disposable PGlite, local mail and fake payments. */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createTenantQa } from './tenant-local-qa';
import { runTenantFlow } from './tenant-flow-qa';
import { scheduleDisplayInterval } from '../client/src/features/rent-ops/workspace/schedule-display';
import type { AdminRecurringScheduleView } from '../client/src/features/rent-ops/types';

export async function runWorkspaceFlow({serve=false}:{serve?:boolean}={}) {
 const qa=await createTenantQa();
 let completed=false;
 try {
  qa.control.clock.date=new Date('2026-09-01T15:00:00Z');
  await runTenantFlow(qa,{keepOpen:true,port:serve?4176:0});
  const base=`http://127.0.0.1:${(qa.server.address() as AddressInfo).port}`;
  let cookie='',csrf='';
  async function request(path:string,body?:unknown,method=body===undefined?'GET':'POST',status=200):Promise<any> {
   const result=await fetch(base+path,{method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'}),...(csrf?{'x-rent-ops-csrf':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const setCookie=result.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
   const data=await result.json();
   assert.equal(result.status,status,`${method} ${path}: ${JSON.stringify(data)}`);
   if(data.csrfToken)csrf=data.csrfToken;
   return data;
  }
  const pass=(name:string)=>console.log(`PASS ${name}`);
  await request('/api/rent-ops/auth/login',{email:'manager@example.test',password:'LocalQA-Only-2026'});
  const filters='?propertyScope=active&propertyId=qa-property&asOfDate=2026-10-01';
  const bootstrap=async()=>request('/api/rent-ops/workspace'+filters);
  const initial=await bootstrap();
  const property=initial.snapshot.properties.find((row:any)=>row.id==='qa-property');
  const unit=initial.snapshot.units.find((row:any)=>row.id==='qa-unit-1');
  const person=initial.snapshot.people.find((row:any)=>row.email==='resident@example.test');
  assert.ok(property&&unit&&person,'synthetic directory fixtures present');
  for(const edit of [
   {route:'properties',row:property,patch:{name:'TEST ONLY — Renamed Example Homes'},collection:'properties'},
   {route:'units',row:unit,patch:{unitNumber:'TEST 1A',bedrooms:2},collection:'units'},
   {route:'people',row:person,patch:{firstName:'Edited',phone:'555-0199'},collection:'people'},
  ]) {
   const endpoint=`/api/rent-ops/${edit.route}/${encodeURIComponent(edit.row.id)}`;
   const revision=edit.row.recordRevision??1;
   const saved=await request(endpoint,{revision,...edit.patch},'PATCH');
   assert.equal(saved.recordRevision,revision+1);
   const reread=(await bootstrap()).snapshot[edit.collection].find((row:any)=>row.id===edit.row.id);
   for(const [key,value] of Object.entries(edit.patch))assert.equal(reread[key],value);
   assert.equal(reread.recordRevision,revision+1);
   const stale=await request(endpoint,{revision,...edit.patch},'PATCH',409);
   assert.equal(stale.code,'conflict');
   pass(`${edit.route} edit persists through fresh HTTP bootstrap; stale revision rejected`);
  }
  const collection=async(name:string)=>(await request(`/api/rent-ops/workspace/collections/${name}${filters}`)).items;
  const ledgerBefore=await collection('ledgerTransactions');
  const allocationsBefore=await collection('paymentAllocations');
  const schedulesBefore:AdminRecurringScheduleView[]=await collection('recurringSchedules');
  const root=schedulesBefore.find(row=>row.personId===person.id&&row.amountCents===125000)!;
  assert.ok(root?.id,'converted rent schedule exists');
  assert.equal(root.canScheduleSuccessor,true);
  assert.ok(ledgerBefore.some((row:any)=>row.kind==='charge'&&row.amountCents===125000&&row.postedOn?.startsWith('2026-10')),'October rent already posted');
  assert.ok(allocationsBefore.length>0,'baseline has a real synthetic payment allocation');
  const successorId='manual:qa-workspace-november-rent';
  const successorPath=`/api/rent-ops/recurring-schedules/${encodeURIComponent(root.id!)}/successor`;
  const successor=await request(successorPath,{id:successorId,expectedRevision:root.recordRevision??1,action:'replace',amountCents:130000,billingFrequency:'monthly',effectiveFrom:'2026-11-01'},'POST',201);
  assert.equal(successor.amountCents,130000);
  const after:AdminRecurringScheduleView[]=await collection('recurringSchedules');
  const old=after.find(row=>row.id===root.id)!;
  const next=after.find(row=>row.id===successorId)!;
  assert.equal(old.amountCents,125000);
  assert.equal(old.resolvedEffectiveTo,'2026-10-31');
  assert.equal(old.canScheduleSuccessor,false);
  assert.equal(next.canScheduleSuccessor,true);
  assert.equal(scheduleDisplayInterval(old,'2026-10-01').state,'current');
  assert.equal(scheduleDisplayInterval(next,'2026-10-01').state,'future');
  assert.equal(scheduleDisplayInterval(old,'2026-11-01').state,'ended');
  assert.equal(scheduleDisplayInterval(next,'2026-11-01').state,'current');
  pass('$1,250 predecessor ends October 31; $1,300 November replacement displays future on October 1');
  const unsafeBranch=await request(successorPath,{id:'manual:qa-unsafe-branch',expectedRevision:root.recordRevision??1,action:'replace',amountCents:140000,effectiveFrom:'2026-12-01'},'POST',409);
  assert.equal(unsafeBranch.code,'conflict');
  const unsafePatch=await request(`/api/rent-ops/recurring-schedules/${encodeURIComponent(root.id!)}`,{revision:root.recordRevision??1,amountCents:140000},'PATCH',409);
  assert.equal(unsafePatch.code,'versioned_schedule_required');
  assert.deepEqual(await collection('ledgerTransactions'),ledgerBefore);
  assert.deepEqual(await collection('paymentAllocations'),allocationsBefore);
  const finalSchedules=await collection('recurringSchedules');
  assert.equal(finalSchedules.length,schedulesBefore.length+1);
  pass('old-root replacement and direct overwrite rejected; posted October ledger and allocations unchanged');
  completed=true;
  console.log('ALL WORKSPACE SYNTHETIC FLOW CHECKS PASSED');
  if(serve)console.log(`TEST ONLY workspace browser host: ${base}/ops · business date 2026-10-01`);
 } finally {
  if(!serve||!completed){if(qa.server.listening)await new Promise<void>(done=>qa.server.close(()=>done()));if(!qa.db.closed)await qa.db.close();}
 }
}
if(process.argv[1]&&resolve(process.argv[1])===resolve('scripts/workspace-flow-qa.ts'))await runWorkspaceFlow({serve:process.argv.includes('--serve')});
