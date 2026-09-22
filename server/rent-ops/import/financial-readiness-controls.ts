import type {RentOpsSnapshot} from '../../../shared/rent-ops-contracts';
import {tenantFinancialReadiness} from '../payments/model';
export interface ImportedFinancialControls {
 asOfDate:string;
 accounts:Array<{sourceTenantId:string;balanceCents:number;expectedPaymentReason:string|null;expectedPayableCents:number|null}>;
}
/** Compare the actual portal model to independently pinned source account controls. */
export function verifyImportedFinancialControls(snapshot:RentOpsSnapshot, controls:ImportedFinancialControls){
 const check=(value:unknown)=>{if(!value)throw Error('imported_financial_readiness_control_mismatch')};
 check(/^\d{4}-\d{2}-\d{2}$/.test(controls.asOfDate)&&controls.accounts.length>0);
 const expected=new Map(controls.accounts.map(row=>[row.sourceTenantId,row]));
 check(expected.size===controls.accounts.length&&controls.accounts.every(row=>/^\d+$/.test(row.sourceTenantId)&&Number.isSafeInteger(row.balanceCents)));
 const rows=tenantFinancialReadiness(snapshot,new Date(controls.asOfDate+'T12:00:00Z')).map(row=>{
  const people=snapshot.people.filter(person=>person.id===row.personId);check(people.length===1&&people[0].source?.system==='rent_manager');
  const sourceTenantId=people[0].source!.sourceId.replace(/^tenant:/,'');const control=expected.get(sourceTenantId);
  check(control&&row.balanceComplete&&row.balanceCents===control.balanceCents&&row.paymentReason===control.expectedPaymentReason&&row.payableCents===control.expectedPayableCents);
  return {...row,sourceTenantId};
 });
 check(rows.length===expected.size&&new Set(rows.map(row=>row.sourceTenantId)).size===expected.size);
 return {asOfDate:controls.asOfDate,accounts:rows.length,balanceCents:rows.reduce((n,row)=>n+row.balanceCents!,0),rows};
}
