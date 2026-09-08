import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RentOpsRepository } from "../../../shared/rent-ops-contracts";
import type { TenantAccountSummary } from "../../../shared/tenant-portal-contracts";
import type { TenantAccountRecord, TenantAccountStore } from "./store";
import type { TenantAccessNotifier } from "./delivery";
import { eligibleTenantTenancies, resolveTenantBinding } from "./presentation";

export class TenantPortalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function tenantAccountSummary(record: TenantAccountRecord): TenantAccountSummary {
  return { id:record.id,email:record.email,personId:record.personId,tenancyId:record.tenancyId,status:record.status,createdAt:record.createdAt,activatedAt:record.activatedAt,invitationExpiresAt:record.invitationExpiresAt };
}
const grantSchema = z.object({email:z.string().trim().email().max(240).transform(value=>value.toLowerCase()),personId:z.string().min(1).max(160),tenancyId:z.string().min(1).max(160)}).strict();
/** Caller must authenticate and authorize administrator access. Only the manager
 * UI may return activationPath; tool adapters must return the account summary. */
export class TenantAccountAdminService {
  private readonly now: () => Date;
  constructor(private readonly options: {repository:RentOpsRepository;store:TenantAccountStore;notifier?:TenantAccessNotifier;now?:()=>Date}) { this.now=options.now??(()=>new Date()); }
  async list() {
    const accounts=await this.options.store.list();
    return {deliveryAvailable:!!this.options.notifier,accounts:accounts.map(tenantAccountSummary),eligibleTenancies:eligibleTenantTenancies(await this.options.repository.getSnapshot())};
  }
  async listForMcp() {
    return (await this.options.store.list()).map(record => ({...tenantAccountSummary(record),credentialRevision:record.sessionVersion}));
  }
  private actor(context:{actorSubject:string}) {
    if(!context || typeof context.actorSubject!=="string" || !context.actorSubject.trim() || context.actorSubject.length>240 || /[\x00-\x1f\x7f]/.test(context.actorSubject)) throw new TenantPortalError(403,"Verified administrator identity is required.");
    if(!this.options.store.auditedMutation) throw new TenantPortalError(503,"Audited account changes are unavailable.");
    return context.actorSubject;
  }
  async grantForMcp(input:{requestId:string;email:string;personId:string;tenancyId:string},context:{actorSubject:string}) {
    const actorSubject=this.actor(context);
    const requestId=z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(input.requestId);
    const value=grantSchema.parse({email:input.email,personId:input.personId,tenancyId:input.tenancyId});
    if(!eligibleTenantTenancies(await this.options.repository.getSnapshot()).some(row=>row.personId===value.personId&&row.tenancyId===value.tenancyId)) throw new TenantPortalError(400,"Select an exact current or future primary tenant before creating an account.");
    const id="tenant-account-"+createHash("sha256").update(actorSubject+":"+requestId).digest("hex");
    const existing=await this.options.store.getById(id);
    if(existing) {
      if(existing.email!==value.email||existing.personId!==value.personId||existing.tenancyId!==value.tenancyId) throw new TenantPortalError(409,"Request identifier already belongs to another account grant.");
      return {account:{...tenantAccountSummary(existing),credentialRevision:existing.sessionVersion}};
    }
    const token=this.token(24*60*60*1000);
    const account=await this.options.store.auditedMutation!({action:"grant",id,...value,actorSubject,now:token.now,tokenHash:token.hash,expiresAt:token.expiresAt});
    if(!account) throw new TenantPortalError(409,"Account already exists. Read current accounts before retrying.");
    return {account:{...tenantAccountSummary(account),credentialRevision:account.sessionVersion}};
  }
  async sendLinkForMcp(id:string,requestId:string,context:{actorSubject:string}) {
    const actorSubject=this.actor(context);
    z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(requestId);
    const store=this.options.store;
    if(!store.issueAuditedDelivery||!store.auditedDeliveryOutcome||!store.finishAuditedDelivery||!this.options.notifier) throw new TenantPortalError(503,"Audited account delivery is unavailable.");
    const record=await this.bound(id);
    if(record.status==="revoked") throw new TenantPortalError(404,"An eligible account was not found.");
    const commandId="account-delivery-"+createHash("sha256").update(actorSubject+":"+id+":"+requestId).digest("hex");
    const token=this.token(30*60*1000);
    const issued=await store.issueAuditedDelivery({commandId,accountId:id,actorSubject,tokenHash:token.hash,expiresAt:token.expiresAt,now:token.now});
    if(!issued) return {delivery:await store.auditedDeliveryOutcome(commandId),replayed:true};
    let delivery:"accepted"|"failed"|"indeterminate"="indeterminate";
    try {await this.options.notifier({issuanceId:commandId,accountId:id,email:issued.email,token:token.token,expiresAt:token.expiresAt,purpose:issued.status==="active"?"password_reset":"invitation"});delivery="accepted";}
    catch (error) {
      // Transport failure can be an accepted-but-lost response. Never resend the
      // same command; invalidate this token and report uncertainty honestly.
      try {await store.invalidateToken(id,token.hash);} catch { /* outcome remains indeterminate */ }
      delivery=error instanceof Error && /^email_recipient_/.test(error.message)?"failed":"indeterminate";
    }
    try {await store.finishAuditedDelivery({commandId,accountId:id,actorSubject,outcome:delivery,now:this.now().toISOString()});}
    catch {delivery="indeterminate";}
    return {delivery,replayed:false};
  }
  private async mutateForMcp(action:"reissue"|"revoke",id:string,expectedCredentialRevision:number,context:{actorSubject:string}) {
    const actorSubject=this.actor(context);
    z.number().int().positive().max(2147483646).parse(expectedCredentialRevision);
    if(action==="reissue") await this.bound(id);
    const token=this.token(24*60*60*1000);
    const account=await this.options.store.auditedMutation!({action,id,actorSubject,expectedCredentialRevision,now:token.now,...(action==="reissue"?{tokenHash:token.hash,expiresAt:token.expiresAt}:{})});
    if(!account) throw new TenantPortalError(409,"Account access changed. Read the current account before retrying.");
    return {account:{...tenantAccountSummary(account),credentialRevision:account.sessionVersion}};
  }
  reissueForMcp(id:string,expectedCredentialRevision:number,context:{actorSubject:string}) {return this.mutateForMcp("reissue",id,expectedCredentialRevision,context);}
  revokeForMcp(id:string,expectedCredentialRevision:number,context:{actorSubject:string}) {return this.mutateForMcp("revoke",id,expectedCredentialRevision,context);}
  private token(ttl:number) { const token=randomBytes(32).toString("base64url"); const now=this.now();return {token,hash:createHash("sha256").update(token).digest("hex"),now:now.toISOString(),expiresAt:new Date(now.getTime()+ttl).toISOString()}; }
  async grant(input:unknown) {
    const value=grantSchema.parse(input);
    if (!eligibleTenantTenancies(await this.options.repository.getSnapshot()).some(row=>row.personId===value.personId&&row.tenancyId===value.tenancyId)) throw new TenantPortalError(400,"Select an exact current or future primary tenant before creating an account.");
    const token=this.token(24*60*60*1000);
    const account=await this.options.store.create({id:`tenant-account-${randomUUID()}`,...value,tokenHash:token.hash,expiresAt:token.expiresAt,now:token.now});
    if(!account) throw new TenantPortalError(409,"An account already uses this email or tenancy. Reissue its secure link instead.");
    return {account:tenantAccountSummary(account),activationPath:`/tenant#activate=${token.token}`,expiresAt:token.expiresAt};
  }
  private async bound(id:string) {
    const record=await this.options.store.getById(id);
    if(!record) throw new TenantPortalError(404,"Tenant account was not found.");
    if(!resolveTenantBinding(await this.options.repository.getSnapshot(),record.personId,record.tenancyId)) throw new TenantPortalError(409,"Review the person and tenancy association before reissuing access.");
    return record;
  }
  async reissue(id:string) {
    await this.bound(id);const token=this.token(24*60*60*1000);
    const account=await this.options.store.rotateActivation(id,token.hash,token.expiresAt,token.now);
    if(!account) throw new TenantPortalError(404,"Tenant account was not found.");
    return {account:tenantAccountSummary(account),activationPath:`/tenant#activate=${token.token}`,expiresAt:token.expiresAt};
  }
  async revoke(id:string) {
    const account=await this.options.store.revoke(id,this.now().toISOString());
    if(!account) throw new TenantPortalError(404,"Tenant account was not found.");
    return {account:tenantAccountSummary(account)};
  }
  async sendLink(id:string) {
    const record=await this.bound(id);
    if(record.status==="revoked") throw new TenantPortalError(404,"An eligible account was not found.");
    if(!this.options.notifier) throw new TenantPortalError(503,"Email delivery is unavailable. Contact management for an access link.");
    const token=this.token(30*60*1000);
    const issued=await this.options.store.issueRecovery(id,token.hash,token.expiresAt,token.now);
    if(!issued) throw new TenantPortalError(409,"Account access changed. Refresh and try again.");
    try { await this.options.notifier({issuanceId:randomUUID(),accountId:id,email:record.email,token:token.token,expiresAt:token.expiresAt,purpose:record.status==="active"?"password_reset":"invitation"}); }
    catch {await this.options.store.invalidateToken(id,token.hash);throw new TenantPortalError(503,"Email delivery could not be confirmed. Request a new link or contact management.");}
    return {delivery:"accepted" as const,message:"The email provider accepted the access-link request."};
  }
}
