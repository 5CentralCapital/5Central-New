import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { isOccupiedTenancyOn } from './tenancy-occupancy';
import { projectFinancialOccupancy } from './financial-projection';
import { deriveRentRoll, deriveTenantProfile } from './reports';
function fixture() {
 const snapshot=structuredClone(syntheticRentOpsSnapshot());
 const tenancy=snapshot.tenancies[0];
 Object.assign(tenancy,{status:'current',statusKnowledge:'manual',actualMoveInOn:undefined,actualMoveInKnowledge:'unknown',actualMoveOutOn:undefined,occupancyConfirmedOn:'2026-09-08',occupancyConfirmationKnowledge:'manual'});
 snapshot.tenancies=[tenancy]; return {snapshot,tenancy};
}
test('observation counts current from confirmed day without claiming earlier move-in',()=>{
 const {snapshot,tenancy}=fixture();
 assert.equal(isOccupiedTenancyOn(tenancy,'2026-09-07'),false);
 assert.equal(isOccupiedTenancyOn(tenancy,'2026-09-08'),true);
 assert.equal(deriveTenantProfile(snapshot,tenancy.primaryPersonId,{asOfDate:'2026-09-12'})?.operationalStatus,'current');
 const row=deriveRentRoll(snapshot,{asOfDate:'2026-09-12'}).find(row=>row.unitId===tenancy.unitId)!;
 assert.equal(row.occupancy,'current'); assert.equal(tenancy.actualMoveInOn,undefined);
});
test('untrusted observation and conflicting real dates never become current',()=>{
 const {tenancy}=fixture();
 assert.equal(isOccupiedTenancyOn({...tenancy,occupancyConfirmationKnowledge:undefined},'2026-09-12'),false);
 assert.equal(isOccupiedTenancyOn({...tenancy,actualMoveInOn:'2026-10-01',actualMoveInKnowledge:'manual'},'2026-09-12'),false);
 assert.equal(isOccupiedTenancyOn({...tenancy,status:'cancelled'},'2026-09-12'),false);
});
test('observed transfer end stops old unit while preserving earlier occupancy and unknown departure',()=>{
 const {tenancy}=fixture();
 Object.assign(tenancy,{operationalEndConfirmedOn:'2026-09-12',operationalEndConfirmationKnowledge:'manual'});
 assert.equal(isOccupiedTenancyOn(tenancy,'2026-09-11'),true);
 assert.equal(isOccupiedTenancyOn(tenancy,'2026-09-12'),false);
 assert.equal(tenancy.actualMoveOutOn,undefined);
});

test('dated vacancy resolves old unknown occupancy without hiding a later confirmed occupant',()=>{
 const {snapshot,tenancy}=fixture();const unit=snapshot.units.find(row=>row.id===tenancy.unitId)!;
 tenancy.status='unknown' as any;tenancy.statusKnowledge='unknown';
 assert.equal(projectFinancialOccupancy(snapshot,unit,'2026-09','2026-09-12').occupancy,'unknown');
 Object.assign(unit,{vacancyConfirmedOn:'2026-09-12',vacancyConfirmationKnowledge:'manual'});
 assert.equal(projectFinancialOccupancy(snapshot,unit,'2026-09','2026-09-11').occupancy,'unknown');
 assert.equal(projectFinancialOccupancy(snapshot,unit,'2026-09','2026-09-12').occupancy,'vacant');
 tenancy.status='current';tenancy.statusKnowledge='manual';tenancy.occupancyConfirmedOn='2026-09-13';
 assert.equal(projectFinancialOccupancy(snapshot,unit,'2026-09','2026-09-13').occupancy,'current');
});
