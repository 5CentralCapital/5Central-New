import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRentManagerExport } from './normalizer';
test('explicit RM prepay location resolves an unallocated payment without moving its future date',()=>{
 const result=normalizeRentManagerExport({payments:[{PaymentID:1,AccountID:2,Amount:1000,TransactionDate:'2026-10-01T00:00:00',PrepayPropertyID:30,PrepayUnitID:185}]});
 const row=result.input.payments![0] as Record<string,unknown>;
 assert.equal(row.propertyId,'30');assert.equal(row.unitId,'185');assert.equal(row.transactionDate,'2026-10-01T00:00:00');
 assert.equal(result.exceptions.some(e=>e.detail==='payment_property_not_resolved_unallocated'),false);
});
test('missing prepay location remains unresolved and direct location is preserved',()=>{
 const result=normalizeRentManagerExport({payments:[{PaymentID:1,Amount:100,TransactionDate:'2026-09-01'},{PaymentID:2,PropertyID:31,UnitID:190,PrepayPropertyID:30,PrepayUnitID:185,Amount:100,TransactionDate:'2026-09-01'}]});
 assert.equal(result.exceptions.filter(e=>e.detail==='payment_property_not_resolved_unallocated').length,1);
 assert.equal((result.input.payments![1] as Record<string,unknown>).propertyId,31);
});
