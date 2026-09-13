import assert from "node:assert/strict";
import test from "node:test";
import { createDemoAdminSnapshot } from "../demo";
import { buildTenantSummary } from "./tenant-model";
import type { AdminLeaseTermView } from "../types";

function fixture() {
 const snapshot=createDemoAdminSnapshot();snapshot.summary.asOfDate="2026-09-12";
 const tenant=snapshot.tenants[0];tenant.operationalStatus="current";tenant.primaryLease=undefined;
 tenant.tenancy={...tenant.tenancy,id:"current",status:"current",actualMoveInOn:"2026-03-01"};
 tenant.tenancies=[{...tenant.tenancy,id:"old",actualMoveInOn:"2024-10-15",actualMoveOutOn:"2026-02-28"},tenant.tenancy];
 const current:AdminLeaseTermView={id:"current-term",tenancyId:"current",contractStartOn:"2026-03-01",contractEndOn:"2027-02-28",tenancyLinkKnowledge:"exact",contractStartKnowledge:"source",contractEndKnowledge:"source",statusKnowledge:"unknown"};
 tenant.leaseTerms=[{id:"old-term",tenancyId:"old",contractStartOn:"2024-10-15",tenancyLinkKnowledge:"exact",contractStartKnowledge:"source",statusKnowledge:"unknown"},current];
 return {snapshot,tenant,current};
}

test("source dates on the exact current tenancy remain visible without inventing executed status",()=>{
 const {snapshot,tenant,current}=fixture(),before=JSON.stringify(tenant);
 assert.equal(buildTenantSummary(tenant,snapshot).primaryLease?.contractEndOn,"2027-02-28");
 assert.equal(buildTenantSummary(tenant,snapshot).primaryLease?.status,undefined);
 assert.equal(JSON.stringify(tenant),before);assert.equal(tenant.leaseTerms.length,2);
 tenant.leaseTerms.reverse();assert.equal(buildTenantSummary(tenant,snapshot).primaryLease?.id,current.id);
});

test("display fallback does not borrow future, draft, ambiguous, or untrusted lease dates",()=>{
 for(const patch of [{contractEndOn:"2026-02-28"},{tenancyId:"old"},{contractStartOn:"2026-10-01"},{status:"draft"},{status:"terminated"},{contractEndKnowledge:"unknown"},{tenancyLinkKnowledge:"unknown"}]){
  const {snapshot,tenant,current}=fixture();Object.assign(current,patch);assert.equal(buildTenantSummary(tenant,snapshot).primaryLease,undefined);
 }
 const {snapshot,tenant,current}=fixture();tenant.leaseTerms.push({...current,id:"conflicting",contractEndOn:"2027-03-31"});assert.equal(buildTenantSummary(tenant,snapshot).primaryLease,undefined);
 tenant.leaseTerms=[current];tenant.operationalStatus="former";assert.equal(buildTenantSummary(tenant,snapshot).primaryLease,undefined);
});

test("server-selected lease remains authoritative and future history is retained separately",()=>{
 const {snapshot,tenant,current}=fixture();tenant.primaryLease={...current,id:"server",status:"executed"};tenant.leaseTerms.push({...current,id:"future",contractStartOn:"2027-03-01",contractEndOn:"2028-02-29"});
 assert.equal(buildTenantSummary(tenant,snapshot).primaryLease?.id,"server");assert.equal(tenant.leaseTerms.length,3);
});
