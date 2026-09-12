import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import type { RentOpsWorkspaceDashboard } from '../api';
import type { RentOpsAuthSnapshot } from '../auth';
import type { ApiFilters, DashboardSummary, ReportRow } from '../types';
import { seedWorkspaceDashboardReports } from './dashboard-cache';
import { reportQueryKey } from './report-model';

const filters: ApiFilters = { propertyScope: 'active', propertyId: 'test-property', asOfDate: '2026-09-12' };
const session: RentOpsAuthSnapshot = { status: 'authenticated', user: { id: 'test-manager', email: 'manager@example.test', role: 'admin', firstName: 'Test', lastName: 'Manager' } };
const dashboard: RentOpsWorkspaceDashboard = {
  summary: {} as DashboardSummary,
  reports: {
    'rent-roll': [{ propertyId: 'test-property', unitId: 'test-unit', unitNumber: '1A', occupancy: 'current' }],
    delinquency: [{ propertyId: 'test-property', unitId: 'test-unit', totalBalanceCents: null, balanceComplete: false }],
  },
};

test('a completed dashboard reuses report rows under the exact identity, property and date keys', () => {
  const client = new QueryClient();
  try {
    seedWorkspaceDashboardReports(client, dashboard, filters, 'test-manager', 10_000, session);
    for (const report of ['rent-roll', 'delinquency'] as const) {
      const key = reportQueryKey(report, filters, 'test-manager');
      assert.deepEqual(client.getQueryData(key), dashboard.reports[report]);
      assert.equal(client.getQueryState(key)?.dataUpdatedAt, 10_000);
      assert.equal(client.getQueryData(reportQueryKey(report, filters, 'another-manager')), undefined);
      assert.equal(client.getQueryData(reportQueryKey(report, { ...filters, propertyId: 'another-property' }, 'test-manager')), undefined);
      assert.equal(client.getQueryData(reportQueryKey(report, { ...filters, asOfDate: '2026-09-13' }, 'test-manager')), undefined);
      assert.equal(client.getQueryData(reportQueryKey(report, { ...filters, search: 'Alex' }, 'test-manager')), undefined);
    }
  } finally { client.clear(); }
});

test('a stale session cannot refill cleared private report caches', () => {
  const client = new QueryClient();
  try {
    for (const current of [{ status: 'unknown' }, { status: 'unauthenticated' }, { ...session, user: { ...session.user!, id: 'another-manager' } }] as RentOpsAuthSnapshot[]) {
      seedWorkspaceDashboardReports(client, dashboard, filters, 'test-manager', 10_000, current);
      assert.equal(client.getQueryCache().getAll().length, 0);
    }
  } finally { client.clear(); }
});

test('newer report reads and explicit invalidations win over a dashboard cache', async () => {
  const client = new QueryClient();
  const rentRollKey = reportQueryKey('rent-roll', filters, 'test-manager');
  const delinquencyKey = reportQueryKey('delinquency', filters, 'test-manager');
  const newer: ReportRow[] = [{ propertyId: 'test-property', unitId: 'new-unit', unitNumber: '2B' }];
  try {
    client.setQueryData(rentRollKey, newer, { updatedAt: 20_000 });
    client.setQueryData(delinquencyKey, [], { updatedAt: 5_000 });
    await client.invalidateQueries({ queryKey: delinquencyKey, refetchType: 'none' });
    seedWorkspaceDashboardReports(client, dashboard, filters, 'test-manager', 10_000, session);
    assert.deepEqual(client.getQueryData(rentRollKey), newer);
    assert.equal(client.getQueryState(rentRollKey)?.dataUpdatedAt, 20_000);
    assert.deepEqual(client.getQueryData(delinquencyKey), []);
    assert.equal(client.getQueryState(delinquencyKey)?.isInvalidated, true);
  } finally { client.clear(); }
});
