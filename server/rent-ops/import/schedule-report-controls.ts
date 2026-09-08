import type {RentOpsSnapshot} from '../../../shared/rent-ops-contracts';
import {effectiveSchedules} from '../domain/invariants';
/** Candidate schedule reconciliation, including explicit unknown activity.
 * This is not a billing authorization or a complete scheduled-rent assertion. */
export function effectiveFidelityScheduleAmounts(snapshot:RentOpsSnapshot,asOfDate:string){
 const selected=snapshot.tenancies.filter(t=>t.status==='current'||t.status==='notice').flatMap(t=>effectiveSchedules(
  snapshot.recurringSchedules.filter(row=>row.scopeType!=='property'),t.id,asOfDate,
  {personId:t.primaryPersonId,unitId:t.unitId,propertyId:t.propertyId,allowPersonScopedTenant:!snapshot.tenancies.some(other=>other.id!==t.id&&other.primaryPersonId===t.primaryPersonId&&other.propertyId===t.propertyId&&other.unitId===t.unitId)}));
 for(const property of snapshot.properties)selected.push(...effectiveSchedules(snapshot.recurringSchedules.filter(row=>row.scopeType==='property'),'property-report-only',asOfDate,{propertyId:property.id}));
 const sum=(category:string)=>selected.filter(row=>row.category===category).reduce((n,row)=>n+(typeof row.amountCents==='number'?row.amountCents:0),0);
 return {baseRentCents:sum('base_rent'),recurringFeesCents:sum('recurring_fee')};
}
