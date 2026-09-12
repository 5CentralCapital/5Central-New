import {nowIsoDate} from '../domain/dates';
import {randomUUID} from 'node:crypto';
import type {RentOpsRepository} from '../../../shared/rent-ops-contracts';
import {isOccupiedTenancyOn,hasOperationalEndOn} from '../domain/tenancy-occupancy';
import type {RentOpsAdminPatchContext} from '../services/service';
/** Internal helper; caller must guard evidence, exact unit hash, and snapshot plan token. */
export async function applyOwnerVacancy(repository:RentOpsRepository,unitId:string,expectedRevision:number,confirmedOn:string,context:RentOpsAdminPatchContext) {
 if (!context.actorSubject?.trim() || !Number.isFinite(Date.parse(context.occurredAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(confirmedOn) || !Number.isFinite(Date.parse(confirmedOn)) || new Date(confirmedOn).toISOString().slice(0,10)!==confirmedOn || confirmedOn>nowIsoDate(new Date(context.occurredAt))) throw new Error('Valid dated owner vacancy context required');
 return repository.transaction(async transaction=>{
  const snapshot=await transaction.getSnapshot();const before=snapshot.units.find(row=>row.id===unitId);
  if(!before || (before.recordRevision??1)!==expectedRevision || !snapshot.properties.some(row=>row.id===before.propertyId) || !['manual','exact'].includes(before.propertyLinkKnowledge??'')) throw new Error('Exact unit/property revision required');
  if(before.vacancyConfirmedOn) throw new Error('Existing vacancy observation requires separate review');
  if(snapshot.tenancies.some(row=>row.unitId===unitId && !hasOperationalEndOn(row,confirmedOn) && (isOccupiedTenancyOn(row,confirmedOn) || row.status==='future'))) throw new Error('Current or future occupancy requires separate reconciliation');
  if(!transaction.applyRecordPatch || !transaction.saveRecordChange) throw new Error('Revision audit unavailable');
  await transaction.applyRecordPatch({entityType:'unit',targetId:unitId,expectedRevision,nextRevision:expectedRevision+1,values:{vacancy_confirmed_on:confirmedOn,vacancy_confirmation_knowledge:'manual'}});
  await transaction.saveRecordChange({id:`record-change:vacancy:${randomUUID()}`,entityType:'unit',targetId:unitId,revision:expectedRevision+1,origin:'admin',actorSubject:context.actorSubject,occurredAt:context.occurredAt,changedFields:['vacancyConfirmedOn']});
  const after={...before,vacancyConfirmedOn:confirmedOn,vacancyConfirmationKnowledge:'manual' as const,recordRevision:expectedRevision+1};
  return {before,after};
 });
}
