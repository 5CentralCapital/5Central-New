import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticRentOpsSnapshot } from '../fixtures/synthetic';
import { createTenantProfileReader, deriveTenantProfile } from './reports';

test('batch profiles retain each account history and unknown allocations across date and property scopes', () => {
  const snapshot = syntheticRentOpsSnapshot();
  const unknown = structuredClone(snapshot);
  Object.assign(unknown.paymentAllocations[0], { chargeTransactionId: null, chargeLinkKnowledge: 'unknown' });
  for (const data of [snapshot, unknown]) for (const filters of [
    { asOfDate: '2026-08-01' }, { asOfDate: '2026-09-12', tenantStatus: 'current' as const },
    { asOfDate: '2026-08-15', propertyId: data.properties[0].id },
  ]) {
    const read = createTenantProfileReader(data, filters);
    for (const person of data.people) assert.deepEqual(read(person.id), deriveTenantProfile(data, person.id, filters));
  }
});
