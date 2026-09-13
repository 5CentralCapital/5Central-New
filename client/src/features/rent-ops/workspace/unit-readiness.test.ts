import assert from 'node:assert/strict';
import test from 'node:test';
import { READINESS_OPTIONS, unitOccupancyMap, unitReadinessDisplay, unitReadinessPayload, unitReadinessQuery } from './unit-readiness-model';
import { propertyUnitListItems } from './property-unit-model';
import type { AdminSnapshot, ReportRow, ViewFilters } from '../types';

test('occupied report state overrides every preparation status without altering the unit', () => {
  for (const [readiness] of READINESS_OPTIONS) {
    const unit = { id: 'u', recordRevision: 4, readiness, readinessKnowledge: 'manual' };
    assert.deepEqual(unitReadinessDisplay(unit, 'current'), { label: 'Occupied', status: 'current' });
    assert.equal(unit.readiness, readiness);
    assert.deepEqual(unitReadinessPayload(unit, 'not_ready'), { id: 'u', revision: 4, readiness: 'not_ready' });
  }
  assert.ok(!READINESS_OPTIONS.some(([key]) => String(key) === 'occupied'));
});

test('as-of report query excludes directory and report filters that could hide occupied units', () => {
  const query = unitReadinessQuery({ propertyScope: 'active', propertyId: 'all', propertyIds: ['b', 'a'], asOfDate: '2026-09-12', tenantStatus: 'former', status: 'vacant', readiness: ['ready'], search: '101', balanceStatus: 'due' } as ViewFilters);
  assert.deepEqual(query, { propertyScope: 'active', propertyIds: ['a', 'b'], asOfDate: '2026-09-12', tenantStatus: 'all' });
});

test('preleased and vacant units retain readiness; missing occupancy cannot look like a confirmed ready vacancy', () => {
  assert.equal(unitReadinessDisplay({ readiness: 'ready' }, 'future_preleased').label, 'Ready');
  assert.equal(unitReadinessDisplay({ readiness: 'off_market' }, 'vacant').label, 'Off market');
  assert.equal(unitReadinessDisplay({ readiness: 'ready' }).label, 'Checking occupancy');
  assert.equal(unitReadinessDisplay({ readiness: 'ready', readinessKnowledge: 'unknown' }, 'vacant').label, 'Not recorded');
});

test('readiness update requires identity, exact revision, and valid preparation state', () => {
  assert.throws(() => unitReadinessPayload({ id: 'u' }, 'ready'), /Refresh/);
  assert.throws(() => unitReadinessPayload({ id: 'u', recordRevision: 2 }, 'occupied'), /Choose/);
  assert.throws(() => unitReadinessPayload({ recordRevision: 2 }, 'ready'), /Refresh/);
});

test('directory displays server-derived occupancy and refreshes when the report changes', () => {
  const snapshot = { snapshot: { properties: [{ id: 'p', name: 'Court', state: 'active' }], units: [{ id: 'u', propertyId: 'p', unitNumber: '1', readiness: 'ready' }] } } as AdminSnapshot;
  const occupancy = unitOccupancyMap([{ unitId: 'u', occupancy: 'current' }] as ReportRow[]);
  assert.equal(propertyUnitListItems(snapshot, { propertyId: 'all', propertyScope: 'active' }, '', occupancy)[1].subtitle, 'Occupied');
  assert.equal(propertyUnitListItems(snapshot, { propertyId: 'all', propertyScope: 'active' }, 'occupied', occupancy)[1].id, 'u');
  assert.equal(propertyUnitListItems(snapshot, { propertyId: 'all', propertyScope: 'active' }, 'ready', occupancy).length, 0);
  const future = unitOccupancyMap([{ unitId: 'u', occupancy: 'future_preleased' }] as ReportRow[]);
  assert.equal(propertyUnitListItems(snapshot, { propertyId: 'all', propertyScope: 'active' }, '', future)[1].subtitle, 'Ready');
});
