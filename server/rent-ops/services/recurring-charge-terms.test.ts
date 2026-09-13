import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntheticRentOpsRepository } from '../fixtures/synthetic';
import { readChargeTerms, saveChargeTerms } from './recurring-charge-terms';
import { RentOpsService } from './service';
import { recurringChargeTermsInputSchema, type RecurringChargeTermsInput } from '../../../shared/recurring-charge-terms';
import { chargeTermsView } from '../domain/recurring-charge-terms';
const context={actorSubject:'qa-reviewer',occurredAt:'2026-09-12T14:00:00.000Z'};
async function fixture(){
  const repo=createSyntheticRentOpsRepository();const snapshot=await repo.getSnapshot();const schedule=snapshot.recurringSchedules[0];const tenancy=snapshot.tenancies.find(row=>row.id===schedule.tenancyId)!;
  const input:RecurringChargeTermsInput={appliesFrom:'2026-09-12',expectedScheduleRevision:schedule.recordRevision??1,expectedReviewRevision:0,personId:tenancy.primaryPersonId,tenancyId:tenancy.id,propertyId:tenancy.propertyId,unitId:tenancy.unitId,amountCents:schedule.amountCents!,verifiedRateFrom:'2026-01-01',rateFromKnowledge:'verified',leaseFrom:'2026-01-01',leaseFromKnowledge:'verified',leaseThrough:'2026-12-31',leaseThroughKnowledge:'verified',evidenceReference:'QA executed lease',evidenceSha256:'a'.repeat(64)};
  return {repo,snapshot,schedule,input};
}
test('terms append with readback while schedule and ledger remain unchanged; revisions reject concurrent stale correction',async()=>{
  const {repo,snapshot,schedule,input}=await fixture();
  assert.equal((await readChargeTerms(repo,[schedule.id]))[0].rateFromKnowledge,'unknown');
  const saved=await saveChargeTerms(repo,schedule.id,input,context);assert.equal(saved.reviewRevision,1);assert.equal(saved.leaseThrough,'2026-12-31');
  assert.deepEqual((await repo.getSnapshot()).recurringSchedules,snapshot.recurringSchedules);assert.deepEqual((await repo.getSnapshot()).ledgerTransactions,snapshot.ledgerTransactions);
  assert.equal((await readChargeTerms(repo,[schedule.id],'2026-09-11'))[0].reviewRevision,0);
  const attempts=await Promise.allSettled([saveChargeTerms(repo,schedule.id,{...input,expectedReviewRevision:1,leaseThrough:null,leaseThroughKnowledge:'month_to_month'},context),saveChargeTerms(repo,schedule.id,{...input,expectedReviewRevision:1},context)]);
  assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);
  assert.equal((await readChargeTerms(repo,[schedule.id]))[0].reviewRevision,2);
});
test('review input rejects inconsistent knowledge, impossible dates, cross-account binding, amount mismatch, forged context and stale schedule',async()=>{
  const {repo,schedule,input}=await fixture();
  for(const invalid of [{...input,verifiedRateFrom:'2026-02-30'},{...input,leaseThroughKnowledge:'unknown'},{...input,rateFromKnowledge:'unknown'},{...input,reviewedBy:'forged'}])assert.equal(recurringChargeTermsInputSchema.safeParse(invalid).success,false);
  for(const invalid of [{...input,personId:'another-person'},{...input,unitId:'another-unit'},{...input,amountCents:1},{...input,expectedScheduleRevision:2}])await assert.rejects(saveChargeTerms(repo,schedule.id,invalid,context));
  await assert.rejects(saveChargeTerms(repo,schedule.id,input,{...context,actorSubject:''}));
  await assert.rejects(new RentOpsService(repo).patchRecord('activity','activity:charge-terms:forged',1,{detail:'forged'},context),/activity_append_only/);
  await assert.rejects(new RentOpsService(repo).saveActivity({id:'activity:charge-terms:forged',type:'system',summary:'Recurring charge terms reviewed',occurredAt:context.occurredAt,actor:context.actorSubject}),/Dedicated/);
});
test('mismatched persisted activity binding and duplicate revision fail closed',async()=>{
  const {repo,schedule,input}=await fixture();await saveChargeTerms(repo,schedule.id,input,context);const snapshot=await repo.getSnapshot();
  const original=snapshot.activityEvents.find(row=>row.id.startsWith('activity:charge-terms:'))!;
  const forged={...original,personId:'another'};assert.equal(chargeTermsView({...snapshot,activityEvents:[forged]},schedule).reviewRevision,0);
  assert.equal(chargeTermsView({...snapshot,activityEvents:[original,original]},schedule).reviewRevision,0);
});

test('business applicability survives NY midnight and future term does not overwrite September',async()=>{
 const {repo,schedule,input}=await fixture();
 await saveChargeTerms(repo,schedule.id,input,{...context,occurredAt:'2026-09-13T01:00:00.000Z'});
 await saveChargeTerms(repo,schedule.id,{...input,expectedReviewRevision:1,appliesFrom:'2026-10-01',leaseThrough:'2027-01-31'},{...context,occurredAt:'2026-09-13T01:01:00.000Z'});
 const september=(await readChargeTerms(repo,[schedule.id],'2026-09-12'))[0];assert.equal(september.reviewRevision,1);assert.equal(september.latestReviewRevision,2);assert.equal(september.leaseThrough,'2026-12-31');
 const october=(await readChargeTerms(repo,[schedule.id],'2026-10-01'))[0];assert.equal(october.reviewRevision,2);assert.equal(october.leaseThrough,'2027-01-31');
});
