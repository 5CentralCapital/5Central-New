import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveFixedReport, deriveTenantLedger, deriveTenantProfile } from "./reports";
import type { LedgerRow, RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";

test("manager account ledger includes exact imported null-tenancy rows once across two leases and respects account/property scope", () => {
 const snapshot=structuredClone(syntheticRentOpsSnapshot());snapshot.modelVersion=3;
 const first=snapshot.tenancies[0], person=snapshot.people.find(row=>row.id===first.primaryPersonId)!;
 person.source={system:"rent_manager",sourceId:"tenant:123"};
 snapshot.tenancies=[first,{...first,id:"second-lease",status:"past"}];
 const property=snapshot.properties.find(row=>row.id===first.propertyId)!;property.state="active";
 snapshot.properties.push({...property,id:"inactive-property",state:"archived"});
 snapshot.people.push({...person,id:"other-account",source:{system:"rent_manager",sourceId:"tenant:456"}});
 const make=(id:string,extra:Partial<RentOpsLedgerTransaction>={}):RentOpsLedgerTransaction=>({id,propertyId:property.id,personId:person.id,personLinkKnowledge:"exact",kind:"charge",kindKnowledge:"source",category:"base_rent",categoryKnowledge:"source",status:"posted",statusKnowledge:"source",amountCents:10000,amountKnowledge:"known",postedOn:"2026-09-01",postedOnKnowledge:"source",source:{system:"rent_manager",sourceId:id,entityType:"ledger_transaction"},sourceArtifactSha256:"a".repeat(64),...extra});
 snapshot.ledgerTransactions=[make("account-charge"),make("account-payment",{kind:"payment",amountCents:2500}),make("later",{postedOn:"2026-10-01"}),make("other",{personId:"other-account"}),make("inactive",{propertyId:"inactive-property"}),make("unassigned",{propertyId:undefined}),make("uncertain",{personLinkKnowledge:"unknown"})];
 snapshot.paymentAllocations=[];snapshot.creditAllocations=[];
 const filters={asOfDate:"2026-09-07",propertyScope:"active" as const};
 const profile=deriveTenantProfile(snapshot,person.id,filters)!;
 assert.deepEqual(profile.ledger.map(row=>row.transaction.id),["account-charge","account-payment"]);
 assert.equal(profile.ledger[1].runningBalanceCents,null);
 assert.equal(profile.ledger[1].balanceComplete,false);
 assert.ok(profile.ledger[1].balanceUncertaintyCodes?.includes("account_ledger_link_unknown"));
 assert.ok(profile.ledger.every(row=>row.transaction.tenancyId===undefined));
 const report=deriveFixedReport(snapshot,"tenant-ledger",filters) as LedgerRow[];
 assert.equal(report.filter(row=>row.transaction.id==="account-charge").length,1);
 assert.deepEqual(report.map(row=>row.transaction.id).sort(),["account-charge","account-payment","other"]);
 assert.deepEqual((deriveFixedReport(snapshot,"tenant-ledger",{...filters,personId:person.id}) as LedgerRow[]).map(row=>row.transaction.id),["account-charge","account-payment"]);
 assert.deepEqual(deriveTenantProfile(snapshot,person.id,{...filters,propertyId:"inactive-property"})!.ledger.map(row=>row.transaction.id),["inactive"]);
 const all=deriveTenantProfile(snapshot,person.id,{...filters,propertyScope:"all"})!.ledger;
 assert.deepEqual(all.map(row=>row.transaction.id),["account-charge","account-payment","inactive","unassigned"]);
 assert.deepEqual(deriveTenantProfile(snapshot,person.id,{asOfDate:filters.asOfDate})!.ledger,all);
 assert.deepEqual((deriveFixedReport(snapshot,"tenant-ledger",{...filters,tenancyId:"second-lease"}) as LedgerRow[]).map(row=>row.transaction.id),["account-charge","account-payment"]);
});

test("manager account ledger preserves native tenancy ledger results",()=>{
 const snapshot=syntheticRentOpsSnapshot(), tenancy=snapshot.tenancies[0];
 assert.deepEqual(deriveTenantProfile(snapshot,tenancy.primaryPersonId)!.ledger,deriveTenantLedger(snapshot,tenancy.id));
});
