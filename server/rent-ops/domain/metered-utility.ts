import type { RentOpsSnapshot } from '../../../shared/rent-ops-contracts';
export interface MeteredUtilityView {
  utility: 'water'; billingMethod: 'metered'; effectiveFrom: string;
  amountCents: null; amountKnowledge: 'unknown';
}
export interface MeteredUtilityObservation extends MeteredUtilityView {
  schema: 'metered_utility_v1'; id: string; tenancyId: string; personId: string; propertyId: string; unitId: string;
  reviewedBy: string; reviewedAt: string; evidenceReference: string; evidenceSha256: string;
}
export const utilityDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
export function parseMeteredUtilityObservation(value: unknown): MeteredUtilityObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as MeteredUtilityObservation;
  if (row.schema !== 'metered_utility_v1' || row.utility !== 'water' || row.billingMethod !== 'metered'
    || row.amountCents !== null || row.amountKnowledge !== 'unknown' || !utilityDate(row.effectiveFrom)
    || !Number.isFinite(Date.parse(row.reviewedAt)) || !/^[a-f0-9]{64}$/.test(row.evidenceSha256)
    || [row.id,row.tenancyId,row.personId,row.propertyId,row.unitId,row.reviewedBy,row.evidenceReference].some(item=>typeof item!=='string'||!item.trim())) return undefined;
  return row;
}
/** Includes confirmed upcoming terms, without pretending a usage amount is known. */
export function meteredUtilitiesForTenancy(snapshot: RentOpsSnapshot, tenancyId: string, asOfDate: string): MeteredUtilityView[] {
  if (!utilityDate(asOfDate)) return [];
  const tenancy=snapshot.tenancies.find(row=>row.id===tenancyId); if(!tenancy)return [];
  const observations=snapshot.activityEvents.flatMap(event=>{
    if(event.type!=='note'||event.tenancyId!==tenancyId||!event.detail)return [];
    let row:MeteredUtilityObservation|undefined;try{row=parseMeteredUtilityObservation(JSON.parse(event.detail));}catch{return [];}
    if(!row||row.id!==event.id||row.tenancyId!==tenancy.id||row.personId!==tenancy.primaryPersonId||row.propertyId!==tenancy.propertyId||row.unitId!==tenancy.unitId
      ||event.personId!==row.personId||event.propertyId!==row.propertyId||event.unitId!==row.unitId||event.actor!==row.reviewedBy||event.occurredAt!==row.reviewedAt||row.reviewedAt.slice(0,10)>asOfDate)return [];
    return [row];
  }).sort((a,b)=>b.reviewedAt.localeCompare(a.reviewedAt)||b.id.localeCompare(a.id));
  const seen=new Set<string>();
  return observations.flatMap(row=>{const key=`${row.utility}:${row.effectiveFrom}`;if(seen.has(key))return [];seen.add(key);return [{utility:row.utility,billingMethod:row.billingMethod,effectiveFrom:row.effectiveFrom,amountCents:null,amountKnowledge:'unknown'} as MeteredUtilityView];});
}
