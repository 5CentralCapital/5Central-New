import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveObservedFinancialCrosswalk } from './observed-financial-crosswalk';
import { validateFinancialSemanticCrosswalkForArtifact } from '../../../shared/rent-ops-contracts';
import { normalizeRentManagerExport } from './normalizer';
test('derived source enum crosswalk is artifact bound and does not classify prose or unknown values',()=>{
 const payload={tenants:[{TenantID:1,Status:'Future'},{TenantID:2,Status:'Surprise'}],recurringSchedules:[{EntityType:'Tenant'},{EntityType:'Tenant'}],chargeTypeRecords:[{Description:'Monthly Rent',ChargeTypeID:99}]};
 const crosswalk=deriveObservedFinancialCrosswalk(payload,'a'.repeat(64));
 assert.equal(crosswalk.entries.length,2);assert.equal(validateFinancialSemanticCrosswalkForArtifact(crosswalk,'a'.repeat(64)).valid,true);
 assert.equal(validateFinancialSemanticCrosswalkForArtifact(crosswalk,'b'.repeat(64)).valid,false);
 const result=normalizeRentManagerExport({...payload,financialSemanticCrosswalk:crosswalk,leases:[{LeaseID:1,TenantID:1,MoveInDate:'2026-10-01'}]},{artifactSha256:'a'.repeat(64)});
 assert.equal(result.input.leases![0].plannedMoveInOn,'2026-10-01');
 assert.equal(result.input.leases![0].actualMoveInOn,undefined);
});
