import assert from 'node:assert/strict';
import test from 'node:test';
import {serializeAdminActivity} from './entities';
import type {RentOpsActivityEvent} from '../../../shared/rent-ops-contracts';
const row={schema:'recurring_charge_terms_v1',id:'activity:charge-terms:qa',scheduleId:'s',scheduleRevision:1,reviewRevision:1,personId:'person',tenancyId:'t',propertyId:'p',unitId:'u',amountCents:127500,appliesFrom:'2026-09-12',verifiedRateFrom:'2025-10-01',rateFromKnowledge:'verified',leaseFrom:'2026-10-01',leaseFromKnowledge:'verified',leaseThrough:'2027-01-31',leaseThroughKnowledge:'verified',reviewedBy:'qa',reviewedAt:'2026-09-13T01:00:00.000Z',evidenceReference:'/Users/private/LEASE-SECRET.pdf',evidenceSha256:'a'.repeat(64)};
const event:RentOpsActivityEvent={id:row.id,personId:row.personId,tenancyId:row.tenancyId,propertyId:row.propertyId,unitId:row.unitId,type:'system',actor:row.reviewedBy,occurredAt:row.reviewedAt,summary:'Recurring charge terms reviewed',detail:JSON.stringify(row)};
test('review activity presents dates while removing private evidence and raw metadata',()=>{
 const view=serializeAdminActivity(event);assert.match(view.detail!,/Charge starts: 2025-10-01/);assert.match(view.detail!,/Lease through: 2027-01-31/);
 const serialized=JSON.stringify(view);for(const secret of ['LEASE-SECRET','/Users/private','evidenceSha256','scheduleRevision','recurring_charge_terms_v1',row.evidenceSha256])assert.equal(serialized.includes(secret),false,secret);
 const mtm=serializeAdminActivity({...event,detail:JSON.stringify({...row,verifiedRateFrom:null,rateFromKnowledge:'unknown',leaseThrough:null,leaseThroughKnowledge:'month_to_month'})});assert.match(mtm.detail!,/Charge starts: Unverified/);assert.match(mtm.detail!,/Lease through: Month-to-month/);
});
test('malformed or mismatched reserved activities fail closed without exposing raw detail or summary',()=>{
 for(const detail of ['/Users/private/SECRET',JSON.stringify({...row,personId:'wrong'}),JSON.stringify({...row,leaseThrough:'bad-date'})]){
  const view=serializeAdminActivity({...event,summary:'PRIVATE-RAW-SECRET',detail});assert.equal(view.summary,'Recurring charge terms reviewed');assert.equal(view.detail,'Charge terms could not be verified.');assert.equal(JSON.stringify(view).includes('SECRET'),false);
 }
});
test('ordinary activity summary and detail remain unchanged',()=>{
 const view=serializeAdminActivity({...event,id:'ordinary-activity',summary:'Called resident',detail:'Asked about renewal.'});assert.equal(view.summary,'Called resident');assert.equal(view.detail,'Asked about renewal.');
});
