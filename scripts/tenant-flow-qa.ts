/** Synthetic HTTP integration checks against the same routers used in production. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTenantQa, syntheticLeasePdf } from './tenant-local-qa';
export async function runTenantFlow(qa:Awaited<ReturnType<typeof createTenantQa>>, options:{serve?:boolean;untilBilling?:boolean}={}) {
const serve=options.serve??false;
await new Promise<void>(ok=>qa.server.listen(serve?4176:0,'127.0.0.1',ok));
const base=`http://127.0.0.1:${(qa.server.address() as any).port}`;
class Client {
 cookie='';csrf='';
 async request(path:string,body?:unknown,method=body===undefined?'GET':'POST',extra:Record<string,string>={}) {
  const response=await fetch(base+path,{method,headers:{...(this.cookie?{Cookie:this.cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(this.csrf?{'x-rent-ops-csrf':this.csrf,'x-tenant-csrf':this.csrf}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const cookie=response.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];
  const text=await response.text();let data:any;try{data=JSON.parse(text)}catch{data=text;}
  if(data.csrfToken)this.csrf=data.csrfToken;
  return {status:response.status,data};
 }
}
const manager=new Client(), applicant=new Client(), tenant=new Client(), other=new Client();
const pass=(name:string)=>console.log(`PASS ${name}`);
const expected=(result:any,status:number,label:string)=>{assert.equal(result.status,status,`${label}: ${JSON.stringify(result.data)}`);return result.data;};
let completed=false;
try {
 expected(await manager.request('/api/rent-ops/auth/login',{email:'manager@example.test',password:'LocalQA-Only-2026'}),200,'manager login');
 expected(await applicant.request('/api/rent-ops/public/applications/start',{email:'resident@example.test',firstName:'Test',lastName:'Applicant',phone:'555-0100',currentAddress:'2 Synthetic Street'}),202,'start');
 const resume=String(qa.inbox.at(-1)!.token),bearer={Authorization:`Bearer ${resume}`};
 expected(await applicant.request('/api/rent-ops/public/applications/resume',undefined,'GET',bearer),200,'resume');
 expected(await applicant.request('/api/rent-ops/public/applications/resume',{propertyId:'qa-property',unitId:'qa-unit-1',employment:{employerName:'Synthetic Employer',monthlyIncomeCents:500000},householdSummary:{adults:1,children:0,totalOccupants:1}},'PATCH',bearer),200,'save application');
 expected(await applicant.request('/api/rent-ops/public/applications/resume/certify',{certify:true},'POST',bearer),200,'certify');
 expected(await applicant.request('/api/rent-ops/public/applications/resume/submit',{},'POST',bearer),200,'submit');pass('public application start, local resume delivery, save, certification, submit');
 let application=(await qa.repository.getSnapshot()).applications.find(a=>a.email==='resident@example.test')!;
 for(const status of ['under_review','approved']) {
  expected(await manager.request(`/api/rent-ops/applications/${application.id}/status`,{revision:application.recordRevision,status},'PATCH'),200,`status ${status}`);
  application=(await qa.repository.getSnapshot()).applications.find(a=>a.id===application.id)!;
 }
 const nextMonth=new Date();nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1,1);
 const moveIn=nextMonth.toISOString().slice(0,10);
 const year=Number(moveIn.slice(0,4));
 const converted=expected(await manager.request(`/api/rent-ops/applications/${application.id}/convert`,{propertyId:'qa-property',unitId:'qa-unit-1',plannedMoveInOn:moveIn,leaseStatus:'executed',contractStartOn:moveIn,contractEndOn:`${year+1}-09-30`,monthToMonth:false,baseRentCents:125000,chargeDefinitionId:'qa-base-rent',category:'base_rent',scheduleDescription:'TEST monthly rent',primaryFinanciallyResponsible:true,members:[{applicationMemberId:'primary',role:'primary',isFinanciallyResponsible:true}]}),201,'conversion');
 const tenancyId=converted.tenancy.id;
 const snapshot=await qa.repository.getSnapshot();const tenancy=snapshot.tenancies.find(t=>t.id===tenancyId)!;
 assert.equal(snapshot.applications.find(a=>a.id===application.id)?.status,'converted');assert.ok(snapshot.leaseTerms.some(t=>t.tenancyId===tenancyId));assert.ok(snapshot.recurringSchedules.some(t=>t.tenancyId===tenancyId));pass('manager review, approval and atomic application-to-tenancy/lease/schedule conversion');
 assert.equal(tenancy.status,'future');
 qa.control.clock.date=new Date(`${moveIn}T15:00:00Z`);
 expected(await manager.request(`/api/rent-ops/tenancies/${encodeURIComponent(tenancyId)}`,{revision:tenancy.recordRevision,status:'current',actualMoveInOn:moveIn},'PATCH'),200,'actual move-in');
 assert.equal((await qa.repository.getSnapshot()).tenancies.find(t=>t.id===tenancyId)?.status,'current');pass('clock advances to planned date; manager records actual move-in and current tenancy');
 const previewContext=expected(await manager.request('/api/rent-ops/preview-context'),200,'manager preview context');
 assert.equal(previewContext.asOfDate,moveIn);
 assert.equal(previewContext.dataMode,'synthetic');
 const defaultDashboard=expected(await manager.request('/api/rent-ops/dashboard'),200,'manager default dashboard');
 assert.equal(defaultDashboard.asOfDate,moveIn);
 const defaultSnapshot=expected(await manager.request('/api/rent-ops/snapshot'),200,'manager default snapshot');
 assert.equal(defaultSnapshot.summary.asOfDate,moveIn);
 pass('manager preview follows the simulated business date after move-in');
 const leaseBytes=syntheticLeasePdf();
 const object=await qa.storage.putIfAbsent({bytes:leaseBytes});
 await qa.repository.saveDocument({id:'qa-lease',propertyId:'qa-property',unitId:'qa-unit-1',personId:tenancy.primaryPersonId,tenancyId,type:'lease',typeKnowledge:'manual',state:'verified',stateKnowledge:'manual',availability:'verified',mimeType:'application/pdf',fileName:'TEST-only-lease.pdf',sizeBytes:object.sizeBytes,checksumSha256:object.checksumSha256,storageKey:`documents/${object.checksumSha256}`,storageKeyKnowledge:'source',verifiedAt:new Date().toISOString()});
 await qa.repository.saveDocumentObjectBinding({documentId:'qa-lease',bindingKind:'applicant',backend:object.backend,logicalKey:object.logicalKey,checksumSha256:object.checksumSha256,sizeBytes:object.sizeBytes,immutableGeneration:object.immutableGeneration,verifiedAt:new Date().toISOString()});
 const created=expected(await manager.request('/api/rent-ops/tenant-accounts',{email:'resident@example.test',personId:tenancy.primaryPersonId,tenancyId}),201,'tenant account');
 qa.control.failMail=true;expected(await manager.request(`/api/rent-ops/tenant-accounts/${created.account.id}/send-link`,{}),503,'mail failure');qa.control.failMail=false;
 expected(await manager.request(`/api/rent-ops/tenant-accounts/${created.account.id}/send-link`,{}),200,'send invite');
 let token=String(qa.inbox.at(-1)!.token);
 expected(await tenant.request('/api/tenant/auth/activate',{token,password:'LocalQA-Only-2026'}),200,'activate');
 expected(await applicant.request('/api/tenant/auth/activate',{token,password:'LocalQA-Only-2026'}),400,'reused token');
 expected(await tenant.request('/api/tenant/home'),200,'tenant home');expected(await tenant.request('/api/rent-ops/tenant-accounts'),401,'tenant admin deny');pass('invitation failure/accepted delivery, setup, one-use token, tenant/admin isolation');
 expected(await other.request('/api/tenant/auth/login',{email:'other@example.test',password:'LocalQA-Only-2026'}),200,'other login');
 const otherHome=expected(await other.request(`/api/tenant/home?tenancyId=${tenancyId}`),200,'other home');assert.equal(otherHome.tenancy.id,'qa-other-tenancy');
 expected(await other.request('/api/tenant/payments/checkout',{tenancyId,amountCents:5000,requestId:randomUUID()}),403,'cross tenant payment');pass('other-tenant home override ignored and payment rejected');
 const ownLease=expected(await tenant.request('/api/tenant/lease-files/qa-lease/download'),200,'own lease');assert.equal(ownLease,leaseBytes.toString());
 expected(await other.request('/api/tenant/lease-files/qa-lease/download'),404,'other lease denied');
 expected(await applicant.request('/api/tenant/lease-files/qa-lease/download'),401,'anonymous lease denied');pass('verified own lease PDF served, other tenant and anonymous access denied');
 qa.control.failMail=true;
 const failedReset=expected(await applicant.request('/api/tenant/auth/recovery',{email:'resident@example.test'}),200,'failed reset nonenumeration');
 const unknownReset=expected(await applicant.request('/api/tenant/auth/recovery',{email:'nobody@example.test'}),200,'unknown reset nonenumeration');
 assert.deepEqual(failedReset,unknownReset);qa.control.failMail=false;
 expected(await tenant.request('/api/tenant/home'),200,'delivery failure preserves session');
 const oldCookie=tenant.cookie;expected(await applicant.request('/api/tenant/auth/recovery',{email:'resident@example.test'}),200,'recovery');token=String(qa.inbox.at(-1)!.token);
 expected(await tenant.request('/api/tenant/home'),200,'session retained pending reset');
 expected(await tenant.request('/api/tenant/auth/activate',{token,password:'LocalQA-Reset-2026'}),200,'reset consume');
 const oldClient=new Client();oldClient.cookie=oldCookie;expected(await oldClient.request('/api/tenant/home'),401,'old session revoked');
 expected(await applicant.request('/api/tenant/auth/login',{email:'resident@example.test',password:'LocalQA-Only-2026'}),401,'old password rejected');pass('password reset preserves access until consumption then revokes prior session/password');
 const month=moveIn.slice(0,7);const preview=expected(await manager.request(`/api/rent-ops/billing/preview?month=${month}`),200,'billing preview');

 const posted=expected(await manager.request('/api/rent-ops/billing/post',{month,previewToken:preview.previewToken}),200,'billing post');pass('billing preview/post');
 assert.equal(posted.postedCount,1);const replay=expected(await manager.request('/api/rent-ops/billing/post',{month,previewToken:preview.previewToken}),200,'billing replay');assert.equal(replay.postedCount,0);pass('billing replay does not duplicate monthly rent');
 if(options.untilBilling){completed=true;console.log('SYNTHETIC RESIDENT READY: resident@example.test / LocalQA-Reset-2026; due $1,250.00; no checkout invoked');return;}
 const payments=expected(await tenant.request('/api/tenant/payments'),200,'payments');assert.ok(payments.accounts[0].payableCents>0,JSON.stringify(payments));
 const payment=expected(await tenant.request('/api/tenant/payments/checkout',{tenancyId,amountCents:5000,requestId:randomUUID()}),200,'checkout');
 const event={id:'evt_qa_success',type:'checkout.session.completed',created:Math.floor(Date.now()/1000),live:false,state:'success',paymentId:payment.id,checkoutSessionId:`cs_test_${payment.id}`,paymentIntentId:`pi_test_${payment.id}`,amountCents:5000,currency:'usd'};
 expected(await applicant.request('/api/tenant/payments/webhook',event),400,'unsigned event rejected');
 expected(await applicant.request('/api/tenant/payments/webhook',event,'POST',{'stripe-signature':'qa-local-signature'}),200,'synthetic signed event');
 expected(await applicant.request('/api/tenant/payments/webhook',event,'POST',{'stripe-signature':'qa-local-signature'}),200,'duplicate event');
 const after=expected(await tenant.request('/api/tenant/payments'),200,'posted payment');assert.equal(after.payments[0].status,'posted');const finalSnapshot=await qa.repository.getSnapshot();assert.equal(finalSnapshot.ledgerTransactions.filter(row=>row.kind==='payment'&&row.tenancyId===tenancyId).length,1);
 pass('synthetic checkout, signature rejection, event replay safety, ledger posting');
 expected(await tenant.request('/api/tenant/auth/logout',{}),200,'logout');expected(await tenant.request('/api/tenant/home'),401,'logged out session');
 expected(await tenant.request('/api/tenant/auth/login',{email:'resident@example.test',password:'LocalQA-Reset-2026'}),200,'reset password login');pass('logout and new password login');
 completed=true;console.log('ALL COMPLETED SYNTHETIC FLOW CHECKS PASSED');
} finally {if(!serve||!completed){await new Promise<void>(ok=>qa.server.close(()=>ok()));await qa.db.close();} else console.log('TEST ONLY synthetic flow host: '+base+'/qa · resident@example.test / LocalQA-Reset-2026');}

}
if(process.argv[1]?.endsWith('/tenant-flow-qa.ts')||process.argv[1]==='scripts/tenant-flow-qa.ts') {await runTenantFlow(await createTenantQa(),{serve:process.argv.includes('--serve')});}
