import type { RentOpsActivityEvent, RentOpsRecurringChargeSchedule, RentOpsTenancy } from '../../../shared/rent-ops-contracts';
import { recurringChargeTermsObservationSchema, type RecurringChargeTermsObservation, type RecurringChargeTermsView } from '../../../shared/recurring-charge-terms';
export const chargeTermsPrefix='activity:charge-terms:';
export const chargeTermsSummary='Recurring charge terms reviewed';
export interface ChargeTermsInputs { recurringSchedules:RentOpsRecurringChargeSchedule[]; tenancies:RentOpsTenancy[]; activityEvents:RentOpsActivityEvent[] }
export function chargeTermsBinding(row:Pick<RecurringChargeTermsObservation,'personId'|'tenancyId'|'propertyId'|'unitId'|'amountCents'>, schedule:RentOpsRecurringChargeSchedule, tenancy?:RentOpsTenancy):boolean {
  return !!tenancy && schedule.scopeType==='tenant' && schedule.tenancyId===row.tenancyId && tenancy.id===row.tenancyId && tenancy.primaryPersonId===row.personId
    && (schedule.personId == null || schedule.personId===row.personId) && schedule.scopeId===row.personId
    && schedule.propertyId===row.propertyId && tenancy.propertyId===row.propertyId && schedule.unitId===row.unitId && tenancy.unitId===row.unitId && schedule.amountCents===row.amountCents;
}
export function validChargeTerms(inputs:ChargeTermsInputs,schedule:RentOpsRecurringChargeSchedule):RecurringChargeTermsObservation[] {
  const tenancy=inputs.tenancies.find(row=>row.id===schedule.tenancyId);
  return inputs.activityEvents.flatMap(event=>{
    if(!event.id.startsWith(chargeTermsPrefix)||event.type!=='system'||event.summary!==chargeTermsSummary||!event.detail)return [];
    let parsed;try{parsed=recurringChargeTermsObservationSchema.safeParse(JSON.parse(event.detail));}catch{return [];}
    if(!parsed.success)return [];const row=parsed.data;
    if(row.scheduleId!==schedule.id||row.scheduleRevision!==(schedule.recordRevision??1)||!chargeTermsBinding(row,schedule,tenancy)
      ||row.id!==event.id||row.tenancyId!==event.tenancyId||row.personId!==event.personId||row.unitId!==event.unitId||row.propertyId!==event.propertyId||row.reviewedBy!==event.actor||row.reviewedAt!==event.occurredAt)return [];
    return [row];
  }).sort((a,b)=>a.reviewRevision-b.reviewRevision);
}
export function chargeTermsView(inputs:ChargeTermsInputs,schedule:RentOpsRecurringChargeSchedule,asOf?:string):RecurringChargeTermsView {
  const rows=validChargeTerms(inputs,schedule);
  // Ambiguous or gapped revision history is never allowed to assert a term.
  const valid=rows.every((row,index)=>row.reviewRevision===index+1);
  const row=valid?rows.filter(row=>!asOf||row.appliesFrom<=asOf).at(-1):undefined;
  return {scheduleId:schedule.id,latestReviewRevision:valid?rows.length:0,appliesFrom:row?.appliesFrom??null,reviewRevision:row?.reviewRevision??0,verifiedRateFrom:row?.verifiedRateFrom??null,rateFromKnowledge:row?.rateFromKnowledge??'unknown',leaseFrom:row?.leaseFrom??null,leaseFromKnowledge:row?.leaseFromKnowledge??'unknown',leaseThrough:row?.leaseThrough??null,leaseThroughKnowledge:row?.leaseThroughKnowledge??'unknown',reviewedAt:row?.reviewedAt??null};
}
