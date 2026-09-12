import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { deriveRentRoll, deriveTenantNavigation, deriveTenantProfile } from './reports';
import { serializeAdminSnapshot, serializeAdminTenantProfile } from '../presentation/entities';
import { buildTenantSummary } from '../../../client/src/features/rent-ops/workspace/tenant-model';
import type { AdminSnapshot, TenantView } from '../../../client/src/features/rent-ops/types';
function fixture() {
  const snapshot=syntheticRentOpsSnapshot();
  snapshot.tenancies.forEach(tenancy=>{if(tenancy.status==='future')tenancy.plannedMoveInOn='2027-01-01';});
  const tenancy=snapshot.tenancies[0];
  const person=snapshot.people.find(person=>person.id===tenancy.primaryPersonId)!;
  return {snapshot,tenancy,person};
}
function displayed(snapshot:ReturnType<typeof syntheticRentOpsSnapshot>,personId:string,date:string) {
  const profile=deriveTenantProfile(snapshot,personId,{asOfDate:date})!;
  const serialized=serializeAdminTenantProfile(profile,snapshot.recurringSchedules) as TenantView;
  const admin={snapshot:serializeAdminSnapshot(snapshot),summary:{asOfDate:date},delinquency:[],chargeDefinitions:snapshot.chargeDefinitions} as unknown as AdminSnapshot;
  return {profile,summary:buildTenantSummary(serialized,admin)};
}
test('profile summary preserves authoritative former account category over stale current lease status',()=>{
  const {snapshot,tenancy,person}=fixture(); tenancy.status='current';tenancy.statusKnowledge='source';
  person.sourceAccountFacts={status:'past',rawStatus:'Former',statusKnowledge:'source',postingStartOn:null,postingEndOn:null,postingStartKnowledge:'unknown',postingEndKnowledge:'unknown',observedOn:'2026-09-07',artifactSha256:'a'.repeat(64)};
  const result=displayed(snapshot,person.id,'2026-09-12');
  assert.equal(deriveTenantNavigation(snapshot,person.id,{asOfDate:'2026-09-12'})?.category,'former');
  assert.equal(result.summary.status,'former'); assert.equal(result.summary.primaryLease,undefined);
  assert.equal(result.profile.tenancy?.status,'current','historical source remains visible in tenancy detail');
  tenancy.statusKnowledge='manual';
  assert.equal(displayed(snapshot,person.id,'2026-09-12').summary.status,'current','explicit tenancy correction overrides account observation');
});
test('profile lease uses report date and executed terms rather than first historical array entry',()=>{
  const {snapshot,tenancy,person}=fixture(); const current=snapshot.leaseTerms.find(term=>term.tenancyId===tenancy.id)!;
  current.contractEndOn='2026-09-30';
  const expired={...current,id:'old-expired',status:'expired' as const,contractStartOn:'2020-01-01',contractEndOn:'2020-12-31'};
  const renewal={...current,id:'october-renewal',status:'executed' as const,contractStartOn:'2026-10-01',contractEndOn:'2027-09-30'};
  snapshot.leaseTerms.unshift(expired,renewal);
  for(const date of ['2026-09-12','2026-10-01']) {
    const result=displayed(snapshot,person.id,date);
    const rentRoll=deriveRentRoll(snapshot,{asOfDate:date}).find(row=>row.tenancyId===tenancy.id)!;
    assert.equal(result.summary.primaryLease?.contractEndOn,rentRoll.contractEndOn);
    assert.equal(result.summary.primaryLease?.id,date==='2026-09-12'?current.id:renewal.id);
  }
  assert.ok(displayed(snapshot,person.id,'2026-09-12').profile.leaseTerms.some(term=>term.id===expired.id));
});
