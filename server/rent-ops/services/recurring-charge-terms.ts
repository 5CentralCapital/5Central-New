import { randomUUID } from 'node:crypto';
import type { RentOpsRepository } from '../../../shared/rent-ops-contracts';
import { recurringChargeTermsInputSchema, recurringChargeTermsObservationSchema, type RecurringChargeTermsInput, type RecurringChargeTermsObservation } from '../../../shared/recurring-charge-terms';
import { chargeTermsBinding, chargeTermsPrefix, chargeTermsSummary, chargeTermsView, validChargeTerms, type ChargeTermsInputs } from '../domain/recurring-charge-terms';
import { RentOpsInvariantError } from '../domain/invariants';
export async function chargeTermsInputs(repository:RentOpsRepository,ids:string[]):Promise<ChargeTermsInputs> {
  if(repository.getRecurringChargeTermInputs)return repository.getRecurringChargeTermInputs(ids);
  const snapshot=await repository.getSnapshot();return {...snapshot,recurringSchedules:snapshot.recurringSchedules.filter(row=>ids.includes(row.id))};
}
export async function readChargeTerms(repository:RentOpsRepository,ids:string[],asOf?:string) {
  const inputs=await chargeTermsInputs(repository,ids);
  return inputs.recurringSchedules.map(row=>chargeTermsView(inputs,row,asOf));
}
export async function saveChargeTerms(repository:RentOpsRepository,scheduleId:string,raw:RecurringChargeTermsInput,context:{actorSubject:string;occurredAt:string}) {
  const input=recurringChargeTermsInputSchema.parse(raw);
  if(!context.actorSubject?.trim()||context.actorSubject.length>240||!Number.isFinite(Date.parse(context.occurredAt)))throw new RentOpsInvariantError('Authenticated review context required');
  return repository.transaction(async repo=>{
    const inputs=await chargeTermsInputs(repo,[scheduleId]);const schedule=inputs.recurringSchedules.find(row=>row.id===scheduleId);
    if(!schedule)throw new RentOpsInvariantError('Recurring schedule not found');
    if((schedule.recordRevision??1)!==input.expectedScheduleRevision)throw new RentOpsInvariantError('Schedule revision is stale');
    if(!chargeTermsBinding(input,schedule,inputs.tenancies.find(row=>row.id===input.tenancyId)))throw new RentOpsInvariantError('Charge terms scope or amount mismatch');
    const history=validChargeTerms(inputs,schedule);
    if(!history.every((row,index)=>row.reviewRevision===index+1)||history.length!==input.expectedReviewRevision)throw new RentOpsInvariantError('Review revision is stale');
    const {expectedScheduleRevision,expectedReviewRevision,...facts}=input;
    const row:RecurringChargeTermsObservation={...facts,schema:'recurring_charge_terms_v1',id:`${chargeTermsPrefix}${randomUUID()}`,scheduleId,scheduleRevision:expectedScheduleRevision,reviewRevision:expectedReviewRevision+1,reviewedBy:context.actorSubject,reviewedAt:context.occurredAt};
    recurringChargeTermsObservationSchema.parse(row);
    await repo.saveActivity({id:row.id,type:'system',summary:chargeTermsSummary,detail:JSON.stringify(row),personId:row.personId,tenancyId:row.tenancyId,propertyId:row.propertyId,unitId:row.unitId,actor:row.reviewedBy,occurredAt:row.reviewedAt});
    const after=await chargeTermsInputs(repo,[scheduleId]);return chargeTermsView(after,schedule);
  // The unchanged parent tuple write fences REPEATABLE READ snapshots before
  // reading append-only review history; SELECT FOR UPDATE alone is insufficient.
  },{lockAccountPersonId:input.personId,lockRecord:{entityType:'tenancy',targetId:input.tenancyId}});
}
