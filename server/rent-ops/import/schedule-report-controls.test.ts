import assert from 'node:assert/strict';import test from 'node:test';
import {emptyRentOpsSnapshot,type RentOpsSnapshot} from '../../../shared/rent-ops-contracts';
import {effectiveFidelityScheduleAmounts} from './schedule-report-controls';
test('fidelity rent controls select current scope and precedence without activating unknown schedules',()=>{
 const snapshot={...emptyRentOpsSnapshot(),properties:[{id:'p'}],tenancies:[{id:'current',status:'current',propertyId:'p',unitId:'u',primaryPersonId:'person'},{id:'past',status:'past',propertyId:'p',unitId:'old',primaryPersonId:'former'}],recurringSchedules:[
 {id:'unit',scopeType:'unit',scopeId:'u',propertyId:'p',unitId:'u',category:'base_rent',chargeDefinitionId:'rent',amountCents:10000,active:null},
 {id:'tenant',scopeType:'tenant',scopeId:'person',tenancyId:'current',propertyId:'p',unitId:'u',personId:'person',category:'base_rent',chargeDefinitionId:'rent',amountCents:12000,active:null},
 {id:'old',scopeType:'tenant',scopeId:'former',tenancyId:'past',propertyId:'p',unitId:'old',personId:'former',category:'base_rent',chargeDefinitionId:'rent',amountCents:8000,active:true},
 {id:'property',scopeType:'property',scopeId:'p',propertyId:'p',category:'recurring_fee',chargeDefinitionId:'fee',amountCents:500,active:null},
 ]} as unknown as RentOpsSnapshot;
 for(const row of snapshot.recurringSchedules){row.scopeTypeKnowledge='source';row.scopeLinkKnowledge='exact';row.categoryKnowledge='source';row.chargeDefinitionLinkKnowledge='exact';}
 assert.deepEqual(effectiveFidelityScheduleAmounts(snapshot,'2026-09-07'),{baseRentCents:12000,recurringFeesCents:500});
 assert.equal(snapshot.recurringSchedules.filter(s=>s.active===null).length,3);
 assert.equal(snapshot.recurringSchedules.reduce((n,s)=>n+s.amountCents!,0),30500);
});
