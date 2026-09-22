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

test('fidelity rent controls follow replacement intervals and terminal end boundaries',()=>{
 const snapshot={...emptyRentOpsSnapshot(),properties:[{id:'p'}],tenancies:[{id:'t',status:'current',propertyId:'p',unitId:'u',primaryPersonId:'person'}],recurringSchedules:[]} as unknown as RentOpsSnapshot;
 const root:any={id:'root',scopeType:'tenant',scopeId:'person',scopeTypeKnowledge:'manual',scopeLinkKnowledge:'manual',propertyId:'p',unitId:'u',tenancyId:'t',personId:'person',category:'base_rent',categoryKnowledge:'manual',chargeDefinitionId:'rent',chargeDefinitionLinkKnowledge:'manual',amountCents:10000,amountKnowledge:'known',effectiveFrom:'2025-01-01',effectiveFromKnowledge:'manual',effectiveTo:null,active:true,activeKnowledge:'manual',lineageRootId:'root',lineageRootOrigin:'manual',versionOrigin:'manual',versionAction:'root',supersedesId:null};
 const replacement:any={...root,id:'replacement',amountCents:12000,effectiveFrom:'2025-06-01',versionAction:'replace',supersedesId:'root'};
 const end:any={...replacement,id:'end',amountCents:null,amountKnowledge:'unknown',effectiveFrom:'2025-09-01',effectiveTo:'2025-09-01',active:false,activeKnowledge:'manual',versionAction:'end',supersedesId:'replacement'};
 snapshot.recurringSchedules=[root,replacement,end];
 assert.deepEqual(effectiveFidelityScheduleAmounts(snapshot,'2025-05-31'),{baseRentCents:10000,recurringFeesCents:0});
 assert.deepEqual(effectiveFidelityScheduleAmounts(snapshot,'2025-06-01'),{baseRentCents:12000,recurringFeesCents:0});
 assert.deepEqual(effectiveFidelityScheduleAmounts(snapshot,'2025-08-31'),{baseRentCents:12000,recurringFeesCents:0});
 assert.deepEqual(effectiveFidelityScheduleAmounts(snapshot,'2025-09-01'),{baseRentCents:0,recurringFeesCents:0});
});
