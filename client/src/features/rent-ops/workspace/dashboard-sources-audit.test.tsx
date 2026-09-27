import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { ConnectorHealth } from '@shared/accounting/operations';
import type { CompanyContextOrganization } from '@shared/company/context';
import type { ForecastScenarioSummary } from '@shared/forecasting/contracts';
import { approvedDashboardScenario, loadDashboardProjects, qboEntities, selectOrganization, usePayables } from './dashboard-sources';
import { centsNumber, shortCents, sumCents, wholeCents, type DashboardData } from './dashboard-kit';
import { refreshDashboardQueries } from './use-workspace-data';
import { ACCOUNTING_WIDGETS } from './dashboard-widgets-accounting';
(globalThis as { React?: typeof React }).React = React;

test('money display preserves decimal-string cents beyond safe chart range', () => {
  assert.equal(wholeCents('9007199254741049'), '$90,071,992,547,410');
  assert.equal(wholeCents('-9007199254741049'), '−$90,071,992,547,410');
  assert.equal(wholeCents('999999999999999999999999999950'), '$10,000,000,000,000,000,000,000,000,000');
  assert.equal(shortCents('999999999999999999999999999950'), '$10000000000000000000000M');
  assert.equal(centsNumber('9007199254740992'), undefined);
  assert.equal(centsNumber('12550'), 12550);
  assert.equal(wholeCents(Number.POSITIVE_INFINITY), '—');
  assert.equal(sumCents(['9007199254740992', '9']), '9007199254741001');
});

test('unavailable production connections cannot fall back to sandbox', () => {
  const health = (environment: 'sandbox' | 'production', status: string) => ({
    scope: { organizationId: 'o', legalEntityId: 'e', environment, realmId: environment },
    connection: { status, readEnabled: true }, legalEntityName: 'Company',
  } as unknown as ConnectorHealth);
  const entities = qboEntities([health('production', 'needs_reconnect'), health('sandbox', 'active')])!;
  assert.equal(entities.length, 1);
  assert.equal(entities[0].scope.environment, 'production');
  assert.equal(entities[0].available, false);
  const reconnected = qboEntities([health('production', 'revoked'), health('production', 'active')])!;
  assert.equal(reconnected[0].available, true);
});

test('ambiguous company selection never silently chooses the first organization', () => {
  const organizations = [{ id: 'a' }, { id: 'b' }] as CompanyContextOrganization[];
  assert.equal(selectOrganization(organizations), undefined);
  assert.equal(selectOrganization(organizations, 'b')?.id, 'b');
  assert.equal(selectOrganization(organizations, 'missing'), undefined);
  assert.equal(selectOrganization(organizations.slice(0, 1))?.id, 'a');
});

test('only the most recently approved base scenario drives the dashboard', () => {
  const scenario = (id: string, state: string, kind: string, updatedAt: string) => ({id, state, kind, currentAssumptionVersion: 1, updatedAt} as ForecastScenarioSummary);
  const draft = scenario('draft', 'draft', 'base', '2026-09-30');
  const whatIf = scenario('sale', 'approved', 'upside', '2026-09-29');
  const older = scenario('old', 'approved', 'base', '2026-09-10');
  const latest = scenario('latest', 'approved', 'base', '2026-09-20');
  assert.equal(approvedDashboardScenario([draft, whatIf]), undefined);
  assert.equal(approvedDashboardScenario([draft, older, latest, whatIf])?.id, 'latest');
});

test('refreshing the dashboard invalidates shared QuickBooks and forecast caches', async () => {
  const client = new QueryClient();
  const keys = [['rent-ops-workspace','dashboard-projects'], ['forecasting','list','o'], ['accounting','financial-dashboard','o'], ['unrelated']];
  for (const key of keys) client.setQueryData(key, {});
  await refreshDashboardQueries(client);
  for (const key of keys.slice(0,3)) assert.equal(client.getQueryState(key)?.isInvalidated, true);
  assert.equal(client.getQueryState(keys[3])?.isInvalidated, false);
  client.clear();
});


test('project totals reject truncated pages and repeated cursors', async () => {
  let reads = 0;
  await assert.rejects(loadDashboardProjects({ listProjects: async () => ({ items: [], nextCursor: String(++reads) }) }, 'o'), /Too many projects/);
  assert.equal(reads, 5);
  await assert.rejects(loadDashboardProjects({ listProjects: async () => ({ items: [], nextCursor: 'repeated' }) }, 'o'), /completely/);
  assert.deepEqual(await loadDashboardProjects({ listProjects: async () => ({ items: [], nextCursor: null }) }, 'o'), []);
});


for (const state of ['truncated', 'disconnected'] as const) test(`payables expose ${state} reads instead of complete cached totals`, () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  const data = {identity:'manager', organizationId:'org', filters:{asOfDate:'2026-09-26'}} as DashboardData;
  client.setQueryData(['rent-ops-workspace','company-context','manager'], {organizations:[{id:'org',entities:[{id:'entity',currency:'USD'}]}]});
  client.setQueryData(['rent-ops-workspace','dashboard-qbo-health','manager','org'], {items:[{
    scope:{organizationId:'org',legalEntityId:'entity',environment:'production',realmId:'realm'},
    connection:{status:state === 'disconnected' ? 'needs_reconnect':'active',readEnabled:true},legalEntityName:'Synthetic company',
  }]});
  client.setQueryData(['rent-ops-workspace','dashboard-payables','org','entity','production','realm','bills'], {items:[{id:'cached-bill',objectId:'bill1',postingState:'posted',mirrored:true,openBalanceCents:'125000',currency:'USD'}],coverage:{status:'complete'},nextCursor:state === 'truncated'?'more':null});
  let captured: ReturnType<typeof usePayables> | undefined;
  function Harness() {captured=usePayables(data,'bills');return null;}
  renderToStaticMarkup(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  assert.equal(captured!.incomplete,true);
  assert.equal(captured!.items.length,state === 'disconnected'?0:1);
  const widget = ACCOUNTING_WIDGETS.find(item => item.id === 'bills-open')!;
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}>{widget.render({data,metrics:{size:'S',w:2,h:2,bodyWidth:160,bodyHeight:130}})}</QueryClientProvider>);
  assert.match(markup,state === 'disconnected'?/Bills unavailable/:/Unknown/);
  assert.doesNotMatch(markup, /<strong[^>]*>\$1,250<\/strong>/);
  client.clear();
});
