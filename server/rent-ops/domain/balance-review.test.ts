import assert from 'node:assert/strict';
import test from 'node:test';
import type { RentOpsBalanceReview } from '../../../shared/rent-ops-contracts';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { SyntheticRentOpsRepository } from '../repositories/synthetic';
import { applyOwnerBalanceReview } from '../reconciliation/balance-review';
import { createBalanceReviewEvent, parseBalanceReview, selectBalanceReview, balanceReviewLedgerFingerprint } from './balance-review';
import { deriveDashboardSummary, deriveDelinquency, deriveRentRoll, deriveTenantProfile } from './reports';
import { serializeRentRollRow, serializeDelinquencyRow } from '../presentation/reports';
import { serializeAdminTenantProfile } from '../presentation/entities';

function fixture() {
 const snapshot = structuredClone(syntheticRentOpsSnapshot());
 const tenancy = snapshot.tenancies.find(row => row.status === 'current')!;
 const review: RentOpsBalanceReview = { schema:'balance_review_v1', ledgerFingerprint:balanceReviewLedgerFingerprint(snapshot,tenancy.primaryPersonId), id:'review-1', tenancyId:tenancy.id, personId:tenancy.primaryPersonId, propertyId:tenancy.propertyId, unitId:tenancy.unitId, asOfDate:'2026-08-16', reviewedAt:'2026-08-16T12:00:00Z', reviewedBy:'owner', reviewedBalanceCents:0, tenantBalanceCents:0, agencyBalanceCents:0, qualifications:['Owner-direct payment confirmed; posted ledger unreconciled'], sourceRefs:['owner-correction:2026-08-16'] };
 return { snapshot, tenancy, review };
}

test('review is append-only, source-backed and does not mutate ledger or allocations', async () => {
 const { snapshot, review } = fixture();
 const repository = new SyntheticRentOpsRepository(snapshot);
 const context = { actorSubject: review.reviewedBy, occurredAt: review.reviewedAt };
 await applyOwnerBalanceReview(repository, review, context);
 await applyOwnerBalanceReview(repository, review, context);
 const saved = await repository.getSnapshot();
 assert.equal(saved.activityEvents.filter(row => row.id === review.id).length, 1);
 assert.deepEqual(saved.ledgerTransactions, snapshot.ledgerTransactions);
 assert.deepEqual(saved.paymentAllocations, snapshot.paymentAllocations);
 await assert.rejects(applyOwnerBalanceReview(repository, {...review, personId:'wrong'}, context), /identity/);
 await assert.rejects(applyOwnerBalanceReview(repository, {...review, reviewedBalanceCents:1, tenantBalanceCents:1}, context), /append-only/);
 assert.equal(parseBalanceReview({...review, sourceRefs:[]}), undefined);
 assert.equal(parseBalanceReview({...review, asOfDate:'2026-02-30'}),undefined);
 assert.equal(parseBalanceReview({...review, reviewedBalanceCents:null, qualifications:[]}), undefined);
});

test('manager projection keeps posted balance separate and rejects future or mismatched reviews', () => {
 const { snapshot, tenancy, review } = fixture();
 const filters = {asOfDate:review.asOfDate};
 const before = deriveDelinquency(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
 snapshot.activityEvents.push(createBalanceReviewEvent(review));
 const due = deriveDelinquency(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
 assert.equal(due.totalBalanceCents, before.totalBalanceCents);
 assert.equal(due.balanceReview?.reviewedBalanceCents, 0);
 assert.equal((serializeDelinquencyRow(due).balanceReview as any).reviewedBalanceCents, 0);
 assert.equal("sourceRefs" in (serializeDelinquencyRow(due).balanceReview as any), false);
 const roll = deriveRentRoll(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
 assert.equal((serializeRentRollRow(roll).balanceReview as any).reviewedBalanceCents, 0);
 const profile = deriveTenantProfile(snapshot, tenancy.primaryPersonId, filters)!;
 assert.equal(serializeAdminTenantProfile(profile).balanceReview?.reviewedBalanceCents,0);
 assert.equal(selectBalanceReview(snapshot, tenancy.id, '2026-08-15'),undefined);
 snapshot.activityEvents.push(createBalanceReviewEvent({...review,id:'review-2',unitId:'wrong'}));
 assert.equal(selectBalanceReview(snapshot, tenancy.id, review.asOfDate)?.id,review.id);
});

test('later posted charge marks reviewed zero stale; unresolved total never becomes zero', () => {
 const { snapshot, tenancy, review } = fixture();
 snapshot.activityEvents.push(createBalanceReviewEvent(review));
 snapshot.ledgerTransactions.push({id:'later-charge',propertyId:tenancy.propertyId,unitId:tenancy.unitId,tenancyId:tenancy.id,personId:tenancy.primaryPersonId,kind:'charge',category:'base_rent',status:'posted',amountCents:10000,postedOn:'2026-09-01',description:'New month'});
 assert.equal(selectBalanceReview(snapshot,tenancy.id,'2026-09-01')?.stale,true);
 assert.equal(selectBalanceReview(snapshot,tenancy.id,'2026-08-16')?.stale,true);
 snapshot.ledgerTransactions.at(-1)!.postedOn = '2026-08-01';
 assert.equal(selectBalanceReview(snapshot,tenancy.id,'2026-08-16')?.stale,true);
 snapshot.activityEvents.push(createBalanceReviewEvent({...review,id:'review-2',asOfDate:'2026-09-01',reviewedAt:'2026-09-01T12:00:00Z',reviewedBalanceCents:null,tenantBalanceCents:null,agencyBalanceCents:null,qualifications:['Base rent paid; extra charges unresolved']}));
 assert.equal(selectBalanceReview(snapshot,tenancy.id,'2026-09-01')?.reviewedBalanceCents,null);
});

test('review captures already-known later ledger and invalidates allocation changes across prior tenancies', () => {
 const { snapshot, tenancy, review } = fixture();
 snapshot.tenancies.push({...tenancy,id:'prior-tenancy',status:'past'});
 snapshot.ledgerTransactions.push({id:'prior-charge',propertyId:tenancy.propertyId,unitId:tenancy.unitId,tenancyId:'prior-tenancy',personId:null,kind:'charge',category:'base_rent',status:'posted',amountCents:10000,postedOn:'2026-08-16',description:'Prior account charge'});
 const dated = {...review,asOfDate:'2026-08-10',ledgerFingerprint:balanceReviewLedgerFingerprint(snapshot,tenancy.primaryPersonId)};
 snapshot.activityEvents.push(createBalanceReviewEvent(dated));
 assert.equal(selectBalanceReview(snapshot,tenancy.id,'2026-08-16')?.stale,false);
 snapshot.paymentAllocations.push({id:'allocation',paymentTransactionId:null,chargeTransactionId:'prior-charge',amountCents:1000,allocatedOn:'2026-08-01'});
 assert.equal(selectBalanceReview(snapshot,tenancy.id,'2026-08-16')?.stale,true);
 snapshot.activityEvents.at(-1)!.actor = 'someone-else';
 assert.equal(selectBalanceReview(snapshot,tenancy.id,'2026-08-16'),undefined);
});


test('manager due routing excludes reviewed zero and unresolved review while all retains unknown', () => {
 const { snapshot, tenancy, review } = fixture();
 snapshot.activityEvents.push(createBalanceReviewEvent(review));
 assert.equal(deriveDelinquency(snapshot,{asOfDate:review.asOfDate,balanceStatus:"due"}).some(row=>row.tenancyId===tenancy.id),false);
 assert.equal(deriveRentRoll(snapshot,{asOfDate:review.asOfDate,balanceStatus:"due"}).some(row=>row.tenancyId===tenancy.id),false);
 assert.equal(deriveDelinquency(snapshot,{asOfDate:review.asOfDate,balanceStatus:"zero"}).find(row=>row.tenancyId===tenancy.id)?.operationalBalanceCents,0);
 const posted = deriveDelinquency(snapshot,{asOfDate:review.asOfDate}).find(row=>row.tenancyId===tenancy.id)!.totalBalanceCents;
 snapshot.activityEvents.push(createBalanceReviewEvent({...review,id:"review-unknown",reviewedAt:"2026-08-16T13:00:00Z",reviewedBalanceCents:null,tenantBalanceCents:null,agencyBalanceCents:null,qualifications:["Extra charges unresolved"]}));
 const all = deriveDelinquency(snapshot,{asOfDate:review.asOfDate}).find(row=>row.tenancyId===tenancy.id)!;
 assert.equal(all.operationalBalanceCents,null);
 assert.equal(all.totalBalanceCents,posted);
 for (const balanceStatus of ["due","zero"] as const) {
   assert.equal(deriveDelinquency(snapshot,{asOfDate:review.asOfDate,balanceStatus}).some(row=>row.tenancyId===tenancy.id),false);
   assert.equal(deriveRentRoll(snapshot,{asOfDate:review.asOfDate,balanceStatus}).some(row=>row.tenancyId===tenancy.id),false);
 }
 const summary = deriveDashboardSummary(snapshot,{asOfDate:review.asOfDate});
 assert.equal(summary.operationalDelinquencyCents,null);
 assert.ok(summary.operationalBalanceUnresolvedCount! > 0);
});

test('current dashboard totals use reviewed amounts without replacing posted financial totals', () => {
 const { snapshot, review } = fixture();
 const filters = {asOfDate:review.asOfDate};
 const before = deriveDashboardSummary(snapshot,filters);
 for (const tenancy of snapshot.tenancies.filter(row => row.status === 'current' || row.status === 'notice')) {
   snapshot.activityEvents.push(createBalanceReviewEvent({...review,id:`review-${tenancy.id}`,tenancyId:tenancy.id,personId:tenancy.primaryPersonId,propertyId:tenancy.propertyId,unitId:tenancy.unitId,ledgerFingerprint:balanceReviewLedgerFingerprint(snapshot,tenancy.primaryPersonId)}));
 }
 const after = deriveDashboardSummary(snapshot,filters);
 assert.equal(after.operationalDelinquencyCents,0);
 assert.equal(after.operationalBalanceUnresolvedCount,0);
 assert.equal(after.totalDelinquencyCents,before.totalDelinquencyCents);
 assert.equal(after.rentOnlyDelinquencyCents,before.rentOnlyDelinquencyCents);
});
