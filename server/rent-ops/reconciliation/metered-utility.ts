import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { RentOpsActivityEvent, RentOpsRepository, RentOpsSnapshot } from '../../../shared/rent-ops-contracts';
import { utilityDate, type MeteredUtilityObservation } from '../domain/metered-utility';
export interface OwnerMeteredUtilityInput {
  id:string;tenancyId:string;personId:string;propertyId:string;unitId:string;expectedRevision:number;
  utility:'water';billingMethod:'metered';effectiveFrom:string;amountCents:null;amountKnowledge:'unknown';
  evidence:{path:string;sha256:string;reference:string};
}
/** Outer reconciliation transaction owns rollback. This writes only an immutable observation. */
export async function applyOwnerMeteredUtility(repository:RentOpsRepository,input:OwnerMeteredUtilityInput,context:{actorSubject:string;occurredAt:string},preparedSnapshot?:RentOpsSnapshot):Promise<RentOpsActivityEvent>{
  if(!context.actorSubject?.trim()||!Number.isFinite(Date.parse(context.occurredAt)))throw new Error('Metered utility operator context required');
  if(Object.keys(input).some(key=>!['id','tenancyId','personId','propertyId','unitId','expectedRevision','utility','billingMethod','effectiveFrom','amountCents','amountKnowledge','evidence'].includes(key))
    ||!input.id?.trim()||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||input.utility!=='water'||input.billingMethod!=='metered'||!utilityDate(input.effectiveFrom)||input.amountCents!==null||input.amountKnowledge!=='unknown')throw new Error('Metered utility requires an explicit unknown usage amount');
  if(!input.evidence?.path||!input.evidence.reference?.trim()||!/^[a-f0-9]{64}$/.test(input.evidence.sha256)
    ||createHash('sha256').update(await readFile(input.evidence.path)).digest('hex')!==input.evidence.sha256)throw new Error('Metered utility evidence differs');
  const before=preparedSnapshot??await repository.getSnapshot();const tenancy=before.tenancies.find(row=>row.id===input.tenancyId);
  if(!tenancy||tenancy.primaryPersonId!==input.personId||tenancy.propertyId!==input.propertyId||tenancy.unitId!==input.unitId
    ||!before.people.some(row=>row.id===input.personId)||!before.units.some(row=>row.id===input.unitId&&row.propertyId===input.propertyId))throw new Error('Metered utility identity differs');
  if((tenancy.recordRevision??1)!==input.expectedRevision)throw new Error('Metered utility tenancy revision changed');
  if(before.activityEvents.some(row=>row.id===input.id))throw new Error('Metered utility observation already exists');
  const observation:MeteredUtilityObservation={schema:'metered_utility_v1',id:input.id,tenancyId:input.tenancyId,personId:input.personId,propertyId:input.propertyId,unitId:input.unitId,
    utility:'water',billingMethod:'metered',effectiveFrom:input.effectiveFrom,amountCents:null,amountKnowledge:'unknown',reviewedBy:context.actorSubject,reviewedAt:new Date(context.occurredAt).toISOString(),evidenceReference:input.evidence.reference,evidenceSha256:input.evidence.sha256};
  const event:RentOpsActivityEvent={id:input.id,tenancyId:input.tenancyId,personId:input.personId,propertyId:input.propertyId,unitId:input.unitId,type:'note',actor:context.actorSubject,occurredAt:observation.reviewedAt,
    summary:`Metered water begins ${input.effectiveFrom}; usage amount is not yet known.`,detail:JSON.stringify(observation),occurredAtKnowledge:'manual',actorKnowledge:'manual',summaryKnowledge:'manual',typeKnowledge:'manual',tenancyLinkKnowledge:'manual',personLinkKnowledge:'manual',propertyLinkKnowledge:'manual',unitLinkKnowledge:'manual'};
  const saved=await repository.saveActivity(event);
  if(!preparedSnapshot){const after=await repository.getSnapshot();const stored=after.activityEvents.find(row=>row.id===event.id);
    if(stored?.detail!==event.detail)throw new Error('Metered utility readback differs');
    for(const key of ['tenancies','leaseTerms','recurringSchedules','ledgerTransactions','paymentAllocations'] as const)if(JSON.stringify(after[key])!==JSON.stringify(before[key]))throw new Error('Metered utility altered financial or lease state');}
  return saved;
}
