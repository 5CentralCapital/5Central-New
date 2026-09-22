/** Production public-flow QA. Explicit caller invocation only after deployment/import go.
 * This helper sends the application email to Michael's exact controlled mailbox.
 * Invitation and reset delivery are separate remaining QA steps; no other recipient.
 * Captured links and session credentials remain in caller/process memory.
 */
import assert from 'node:assert/strict';
export interface PublishedQaOptions {
 origin:string; managerCookie:string;managerCsrf:string;propertyId:string;unitId:string;chargeDefinitionId:string;
 /** Caller reads each actual received Gmail message privately and supplies its token. */
 receiveToken:(purpose:'application'|'invitation'|'reset')=>Promise<string>;
 today:string; tomorrow:string;
}
export async function runPublishedApplicationQa(input:PublishedQaOptions){
 assert.equal(new URL(input.origin).origin,input.origin);assert.ok(input.origin.startsWith('https://'));
 assert.match(input.propertyId,/^qa-/);assert.match(input.unitId,/^qa-/);assert.ok(input.tomorrow>input.today);
 const email='michael@5central.capital';let cookie='',csrf='';
 const call=async(path:string,body?:unknown,method=body===undefined?'GET':'POST',admin=false,token?:string)=>{
  const response=await fetch(input.origin+path,{method,redirect:'error',headers:{Origin:input.origin,'Content-Type':'application/json',Cookie:admin?input.managerCookie:cookie,...(admin?{'x-rent-ops-csrf':input.managerCsrf}:{'x-tenant-csrf':csrf}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(!admin){const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0];}const result=await response.json();if(!admin&&result.csrfToken)csrf=result.csrfToken;assert.ok(response.ok,`${path}: ${response.status}`);return result;
 };
 const before=await call('/api/rent-ops/snapshot',undefined,'GET',true);const snapshot=before.snapshot??before;
 assert.ok(snapshot.properties.some((p:any)=>p.id===input.propertyId&&p.name.startsWith('QA TEST')));
 assert.ok(snapshot.units.some((u:any)=>u.id===input.unitId&&u.propertyId===input.propertyId));
 assert.ok(!snapshot.applications.some((a:any)=>a.email===email),'Existing applicant mailbox must be reconciled first; never overwrite it');
 const accounts=await call('/api/rent-ops/tenant-accounts',undefined,'GET',true);assert.ok(!accounts.accounts.some((a:any)=>a.email===email),'Never replace an existing mailbox tenant account');
 await call('/api/rent-ops/public/applications/start',{email,firstName:'QA TEST',lastName:'Published Workflow',phone:'555-0100',currentAddress:'QA TEST synthetic address'});
 const resume=await input.receiveToken('application');
 const application=await call('/api/rent-ops/public/applications/resume',undefined,'GET',false,resume);
 await call('/api/rent-ops/public/applications/resume',{propertyId:input.propertyId,unitId:input.unitId,householdSummary:{adults:1,children:0,totalOccupants:1}},'PATCH',false,resume);
 await call('/api/rent-ops/public/applications/resume/certify',{certify:true},'POST',false,resume);
 await call('/api/rent-ops/public/applications/resume/submit',{},'POST',false,resume);
 const id=application.id??application.application?.id;assert.ok(id);
 for(const status of ['under_review','approved']){const detail=await call(`/api/rent-ops/applications/${encodeURIComponent(id)}`,undefined,'GET',true);const record=detail.application??detail;await call(`/api/rent-ops/applications/${encodeURIComponent(id)}/status`,{revision:record.recordRevision,status,note:'QA TEST synthetic published workflow only'},'PATCH',true);}
 const result=await call(`/api/rent-ops/applications/${encodeURIComponent(id)}/convert`,{propertyId:input.propertyId,unitId:input.unitId,plannedMoveInOn:input.tomorrow,leaseStatus:'executed',contractStartOn:input.tomorrow,contractEndOn:`${Number(input.today.slice(0,4))+1}-12-31`,monthToMonth:false,baseRentCents:1000,billingFrequency:'monthly',chargeDefinitionId:input.chargeDefinitionId,category:'base_rent',scheduleDescription:'QA TEST synthetic monthly rent',primaryFinanciallyResponsible:true,members:[{applicationMemberId:'primary',role:'primary',isFinanciallyResponsible:true}]},'POST',true);
 // Return only non-secret synthetic identities. Caller performs audited date correction,
 // authenticated manager lease upload, then bounded invitation/reset steps.
 return {applicationId:id,tenancy:result.tenancy,email,status:'approved_future_tenancy',remaining:['audited_today_move_in','authenticated_manager_lease_upload','invitation_email','reset_email','scope_checks','cleanup']};
}
