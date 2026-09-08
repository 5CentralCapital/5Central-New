/** Explicitly invoked QA against already-created synthetic tenancies only.
 * No provider/email, clock change, payment, import, or real-record mutation.
 * Host approval and fixture creation must be confirmed separately before invocation.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
export interface ProductionQaInput {origin:string;managerCookie:string;managerCsrf:string;personId:string;tenancyId:string;otherTenancyId:string;leaseId?:string;email:string;}
export async function runProductionTenantQa(input:ProductionQaInput) {
 const origin=new URL(input.origin);assert.equal(origin.protocol,'https:');assert.equal(origin.origin,input.origin);
 assert.match(input.email,/^qa-[a-z0-9-]+@qa\.example\.test$/);
 assert.match(input.personId,/^qa-/);assert.match(input.tenancyId,/^qa-/);assert.match(input.otherTenancyId,/^qa-/);
 let cookie='',csrf='';const password=`QA-${randomBytes(24).toString('base64url')}`;const replacement=`QA-${randomBytes(24).toString('base64url')}`;
 const request=async(path:string,body?:unknown,admin=false)=>{
  const response=await fetch(origin.origin+path,{method:body===undefined?'GET':'POST',redirect:'error',headers:{Cookie:admin?input.managerCookie:cookie,Origin:origin.origin,'Content-Type':'application/json',...(admin?{'x-rent-ops-csrf':input.managerCsrf}:{'x-tenant-csrf':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
  if(!admin){const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0];}
  const payload=await response.json();if(!admin&&payload.csrfToken)csrf=payload.csrfToken;return {status:response.status,payload};
 };
 const accounts=await request('/api/rent-ops/tenant-accounts',undefined,true);assert.equal(accounts.status,200);
 assert.ok(accounts.payload.eligibleTenancies.some((t:any)=>t.personId===input.personId&&t.tenancyId===input.tenancyId&&t.personName.startsWith('QA TEST')),'Synthetic primary tenant must be visible and explicitly labeled QA TEST');
 assert.ok(!accounts.payload.accounts.some((a:any)=>a.email===input.email||a.tenancyId===input.tenancyId),'Use a fresh synthetic tenancy; never replace an existing account');
 const created=await request('/api/rent-ops/tenant-accounts',{email:input.email,personId:input.personId,tenancyId:input.tenancyId},true);assert.equal(created.status,201);
 const id=created.payload.account.id;const token=new URL(created.payload.activationPath,origin).hash.slice('#activate='.length);
 try {
  assert.equal((await request('/api/tenant/auth/activate',{token,password})).status,200);
  assert.equal((await request('/api/tenant/auth/activate',{token,password})).status,400);
  const home=await request('/api/tenant/home');assert.equal(home.status,200);assert.equal(home.payload.tenancy.id,input.tenancyId);
  assert.equal((await request('/api/rent-ops/tenant-accounts')).status,401);
  const override=await request(`/api/tenant/home?tenancyId=${encodeURIComponent(input.otherTenancyId)}`);assert.equal(override.payload.tenancy.id,input.tenancyId);
  if(input.leaseId){assert.match(input.leaseId,/^qa-/);const pdf=await fetch(origin.origin+`/api/tenant/lease-files/${encodeURIComponent(input.leaseId)}/download`,{headers:{Cookie:cookie},redirect:'error',cache:'no-store'});assert.equal(pdf.status,200);assert.equal(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0,5)),'%PDF-');}
  assert.equal((await request('/api/tenant/auth/password',{currentPassword:password,newPassword:replacement})).status,200);
  const reissued=await request(`/api/rent-ops/tenant-accounts/${encodeURIComponent(id)}/reissue`,{},true);assert.equal(reissued.status,200);
  assert.equal((await request('/api/tenant/home')).status,401);
  const resetToken=new URL(reissued.payload.activationPath,origin).hash.slice('#activate='.length);
  assert.equal((await request('/api/tenant/auth/activate',{token:resetToken,password:replacement})).status,200);
  return {accountId:id,tenancyId:input.tenancyId,status:'passed',credentialsRetained:false};
 } finally {
  // Revoke only the newly created synthetic account even if a verification fails.
  assert.equal((await request(`/api/rent-ops/tenant-accounts/${encodeURIComponent(id)}/revoke`,{},true)).status,200);
 }
}
