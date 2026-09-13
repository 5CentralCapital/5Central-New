import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { AdminSnapshot, OperationalScheduleRegister } from '../types';
import { propertyRecurringRows } from './property-recurring-panel-model';

const metadata: OperationalScheduleRegister = { asOfDate: '2026-09-12', currentScheduleIds: ['current', 'shared', 'unit-default'], historicalScheduleIds: ['old', 'prorate'], futureScheduleIds: ['future'], reviewScheduleIds: ['unknown'], propertyDefaultScheduleIds: ['shared'], unitDefaultScheduleIds: ['unit-default'], complete: false };
function fixture(): AdminSnapshot {
  return {
    chargeDefinitions: [{ id: 'rent', displayName: 'Base rent' }],
    snapshot: {
      properties: [{ id: 'p' }], units: [{ id: 'u', propertyId: 'p', unitNumber: '1' }, { id: 'v', propertyId: 'p', unitNumber: '2' }],
      people: [{ id: 'person', firstName: 'Jane', lastName: 'Tenant' }],
      tenancies: [{ id: 'tenancy', unitId: 'u', propertyId: 'p', primaryPersonId: 'person' }],
      recurringSchedules: [
        ...['current', 'old', 'prorate', 'future', 'unknown', 'unclassified'].map(id => ({ id, propertyId: 'p', unitId: 'u', tenancyId: 'tenancy', personId: 'person', scopeType: 'tenant', scopeId: 'person', chargeDefinitionId: 'rent', category: 'base_rent', description: 'Retain original source description', amountCents: 150000, active: true, effectiveFrom: '2026-09-12', effectiveTo: null, lineageState: 'valid', resolvedEffectiveTo: null, canScheduleSuccessor: true, recordRevision: 1 })),
        { id: 'shared', propertyId: 'p', scopeType: 'property', scopeId: 'p', amountCents: 500 },
        { id: 'unit-default', propertyId: 'p', unitId: 'v', scopeType: 'unit', scopeId: 'v', amountCents: 1000 },
        { id: 'elsewhere', propertyId: 'other', scopeType: 'property', scopeId: 'other' },
      ],
    },
  } as AdminSnapshot;
}

test('property and unit current views follow the operational register, not source open/import dates', () => {
  const snapshot = fixture();
  assert.deepEqual(propertyRecurringRows(snapshot, 'p', undefined, metadata, 'current').map(row => row.id), ['current', 'shared', 'unit-default']);
  const unitRows = propertyRecurringRows(snapshot, 'p', snapshot.snapshot.units[0], metadata, 'current');
  assert.deepEqual(unitRows.map(row => row.id), ['current', 'shared']);
  assert.equal(unitRows[0].tenantName, 'Jane Tenant');
  assert.equal(unitRows[0].linkedPersonId, 'person');
  assert.equal(unitRows[0].linkedUnitId, 'u');
  assert.equal(unitRows[0].chargeName, 'Base rent');
  assert.equal(unitRows[1].tenantName, 'Shared charge');
  assert.equal(unitRows[1].unitName, 'All units');
  assert.equal(unitRows[1].linkedUnitId, undefined);
  assert.deepEqual(propertyRecurringRows(snapshot, 'other', snapshot.snapshot.units[0], metadata, 'current'), []);
});

test('past, future and all retain originals and label unclassified schedules for review', () => {
  const snapshot = fixture();
  const before = JSON.stringify(snapshot);
  const past = propertyRecurringRows(snapshot, 'p', undefined, metadata, 'history');
  assert.deepEqual(past.map(row => row.id), ['old', 'prorate']);
  assert.ok(past.every(row => row.displayStatus === 'Historical' && !row.canChange));
  assert.deepEqual(propertyRecurringRows(snapshot, 'p', undefined, metadata, 'future').map(row => row.id), ['future']);
  const all = propertyRecurringRows(snapshot, 'p', undefined, metadata, 'all');
  assert.equal(all.length, 8);
  assert.equal(all.find(row => row.id === 'unclassified')?.displayStatus, 'Needs review');
  assert.equal(all.find(row => row.id === 'unknown')?.displayStatus, 'Needs review');
  assert.equal(past[0].description, 'Retain original source description');
  assert.equal(JSON.stringify(snapshot), before);
});

test('property panel displays verified terms and guards edits without a description column', () => {
  const source = readFileSync(new URL('./property-recurring-panel.tsx', import.meta.url), 'utf8');
  assert.match(source, /useState<RecurringRegisterView>\('current'\)/);
  assert.match(source, /terms\.label\(row\.id, 'start', row\.scopeType\)/);
  assert.match(source, /terms\.label\(row\.id, 'through', row\.scopeType\)/);
  assert.doesNotMatch(source, /key: 'description'|label: 'Description'|row\.effectiveFrom/);
  assert.match(source, /!readOnly && auth\.status === 'authenticated'/);
  assert.match(source, /row\.canChange \? recurringRecordSuccessorValues/);
});
