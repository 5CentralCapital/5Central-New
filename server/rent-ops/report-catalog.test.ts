import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getReportCatalog, ReportCatalogSchema, ReportFilterDefinitionsSchema } from '../../shared/report-catalog';
import { getReportFilterDefinition } from '../../shared/report-filter-definitions';
import type { FixedReportName, RentOpsFilters } from '../../shared/rent-ops-contracts';
import { deriveFixedReport } from './domain/reports';
import { registerRentOpsRoutes } from './routes';
import { createSyntheticRentOpsRepository } from './fixtures/synthetic';
import { RentOpsService } from './services/service';
import { createRentOpsMcpServer } from './mcp/tools';
import { READ_SCOPE } from './mcp/oauth';

test('catalog advertises exactly the existing rental capabilities and preserves metadata isolation', () => {
  const catalog = getReportCatalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.reports.length, 53);
  const enabled = catalog.reports.filter(report => report.availability === 'available');
  assert.equal(enabled.length, 11);
  assert.deepEqual(enabled.map(report => report.reportKey).sort(), ['rent-roll','occupancy','scheduled-income','collected-income','scheduled-vs-collected','delinquency','tenant-ledger','lease-expiration','security-deposit','applicant-pipeline','hap'].sort());
  assert.equal(catalog.reports.find(report => report.id === 'rent-paid')?.availability, 'planned');
  assert.equal(enabled.find(report => report.id === 'lease-expiration')?.mcpReport, 'lease-expirations');
  assert.equal(enabled.find(report => report.id === 'security-deposit')?.mcpReport, 'deposits');
  for (const report of catalog.reports.filter(report => report.availability === 'planned')) { assert.equal(report.reportKey, undefined); assert.equal(report.mcpReport, undefined); assert.ok(report.reason); }
  assert.equal(ReportCatalogSchema.safeParse({...catalog, reports: [...catalog.reports, catalog.reports[0]]}).success, false);
  const runnable = enabled[0];
  for (const absent of ['reportKey', 'mcpReport'] as const) {
    const invalid = {...runnable}; delete invalid[absent];
    assert.equal(ReportCatalogSchema.safeParse({schemaVersion: 1, reports: [invalid]}).success, false, `Missing ${absent}`);
  }
  assert.equal(ReportCatalogSchema.safeParse({schemaVersion: 1, reports: [{...catalog.reports[0], reportKey: 'rent-roll', mcpReport: 'rent-roll'}]}).success, false);
  catalog.reports[0].title = 'Changed';
  assert.notEqual(getReportCatalog().reports[0].title, 'Changed');
});

test('available reports expose audited filter definitions, aliases, and explicit setup presets', () => {
  const catalog = getReportCatalog();
  const available = catalog.reports.filter(report => report.availability === 'available');
  const expectedFields: Record<string, string[]> = {
    'rent-roll': ['propertyScope', 'propertyIds', 'asOfDate', 'unitId', 'occupancy', 'readiness', 'listing', 'balanceStatus', 'search'],
    occupancy: ['propertyScope', 'propertyIds', 'asOfDate', 'unitId', 'occupancy', 'readiness', 'listing'],
    'scheduled-income': ['propertyScope', 'propertyIds', 'asOfDate', 'month', 'unitId', 'tenantStatus', 'search'],
    'collected-income': ['propertyScope', 'propertyIds', 'asOfDate', 'month', 'fromDate', 'toDate', 'unitId', 'tenancyId', 'personId', 'tenantStatus', 'search'],
    'scheduled-vs-collected': ['propertyScope', 'propertyIds', 'asOfDate', 'month', 'unitId', 'tenantStatus', 'search'],
    delinquency: ['propertyScope', 'propertyIds', 'asOfDate', 'unitId', 'tenantStatus', 'balanceStatus', 'search'],
    'tenant-ledger': ['propertyScope', 'propertyIds', 'asOfDate', 'fromDate', 'toDate', 'unitId', 'tenancyId', 'personId', 'tenantStatus'],
    'lease-expiration': ['propertyScope', 'propertyIds', 'asOfDate', 'tenantStatus', 'status', 'search'],
    'security-deposit': ['propertyScope', 'propertyIds', 'asOfDate', 'unitId', 'tenantStatus', 'search'],
    'applicant-pipeline': ['propertyScope', 'propertyIds', 'asOfDate', 'status', 'search'],
    hap: ['propertyScope', 'propertyIds', 'asOfDate', 'month', 'tenantStatus', 'status', 'search'],
  };
  for (const report of available) {
    assert.ok(report.filters?.length, `${report.id} must expose filters`);
    assert.deepEqual(report.filters?.map(filter => filter.name), expectedFields[report.reportKey!], report.id);
    assert.deepEqual(report.filters, getReportFilterDefinition(report.reportKey!), report.id);
    assert.equal(ReportFilterDefinitionsSchema.safeParse(report.filters).success, true, report.id);
    assert.equal(new Set(report.filters!.map(filter => filter.name)).size, report.filters!.length, `${report.id} filter names must be unique`);
    for (const filter of report.filters!) {
      if (filter.default === undefined || !filter.options) continue;
      const values = new Set(filter.options.map(option => option.value));
      for (const value of Array.isArray(filter.default) ? filter.default : [filter.default]) assert.ok(values.has(value), `${report.id}.${filter.name} has an undeclared default`);
    }
  }
  assert.deepEqual(getReportFilterDefinition('lease-expirations'), getReportFilterDefinition('lease-expiration'));
  assert.deepEqual(getReportFilterDefinition('deposits'), getReportFilterDefinition('security-deposit'));
  assert.equal(getReportFilterDefinition('current-tenants'), undefined);
  assert.equal(getReportFilterDefinition('constructor'), undefined);
  assert.equal(getReportFilterDefinition('toString'), undefined);
  const rentRoll = available.find(report => report.id === 'rent-roll')!;
  assert.deepEqual(rentRoll.filters?.find(filter => filter.name === 'propertyIds')?.acceptedAliases, ['propertyId']);
  assert.deepEqual(rentRoll.filters?.find(filter => filter.name === 'propertyScope')?.default, 'active');
  assert.deepEqual(rentRoll.filters?.find(filter => filter.name === 'occupancy')?.default, ['current']);
  assert.deepEqual(available.find(report => report.id === 'occupancy')?.filters?.find(filter => filter.name === 'occupancy')?.default, ['vacant']);
  assert.deepEqual(available.find(report => report.id === 'delinquency')?.filters?.find(filter => filter.name === 'balanceStatus')?.default, 'due');
  assert.deepEqual(available.find(report => report.id === 'lease-expiration')?.filters?.find(filter => filter.name === 'asOfDate')?.dateSemantics, {mode: 'as_of', inclusive: true, lookaheadDays: 90});
  assert.equal(available.find(report => report.id === 'hap')?.filters?.find(filter => filter.name === 'status')?.options?.some(option => option.value === 'pending'), false);
  assert.equal(ReportFilterDefinitionsSchema.safeParse([...rentRoll.filters!, rentRoll.filters![0]]).success, false);
  assert.equal(ReportCatalogSchema.safeParse({schemaVersion: 1, reports: [{...rentRoll, filters: []}]}).success, false);
  const cachedV1 = {...rentRoll}; delete cachedV1.filters;
  assert.equal(ReportCatalogSchema.safeParse({schemaVersion: 1, reports: [cachedV1]}).success, true, 'schema v1 remains readable without additive metadata');
});

test('advertised reference and status filters narrow real synthetic report rows', async () => {
  const snapshot = await createSyntheticRentOpsRepository().getSnapshot();
  const run = (report: FixedReportName, filters: RentOpsFilters) => deriveFixedReport(snapshot, report, filters) as Array<Record<string, unknown>>;
  const asOf = {asOfDate: '2026-08-16' as const};
  const month = {...asOf, month: '2026-08' as const};
  const range = {...asOf, fromDate: '2026-08-01' as const, toDate: '2026-08-16' as const};

  const allRentRoll = run('rent-roll', asOf);
  const unitRentRoll = run('rent-roll', {...asOf, unitId: 'demo-unit-a-1'});
  assert.equal(allRentRoll.length, 7);
  assert.equal(unitRentRoll.length, 1);
  assert.ok(unitRentRoll.every(row => row.unitId === 'demo-unit-a-1'));
  const currentRentRoll = run('rent-roll', {...asOf, occupancy: ['current']});
  assert.ok(currentRentRoll.length > 0 && currentRentRoll.length < allRentRoll.length);
  assert.ok(currentRentRoll.every(row => row.occupancy === 'current'));
  const notReadyRentRoll = run('rent-roll', {...asOf, readiness: ['not_ready']});
  assert.equal(notReadyRentRoll.length, 1);
  assert.ok(notReadyRentRoll.every(row => row.readiness === 'not_ready'));
  const unlistedRentRoll = run('rent-roll', {...asOf, listing: ['unlisted']});
  assert.equal(unlistedRentRoll.length, 2);
  assert.ok(unlistedRentRoll.every(row => row.listing === 'unlisted'));
  const creditRentRoll = run('rent-roll', {...asOf, balanceStatus: 'credit'});
  assert.equal(creditRentRoll.length, 1);
  assert.ok(creditRentRoll.every(row => row.operationalBalanceCents && (row.operationalBalanceCents as number) < 0));
  const propertyBRoll = run('occupancy', {...asOf, propertyIds: ['demo-property-b']});
  assert.equal(propertyBRoll.length, 2);
  assert.ok(propertyBRoll.every(row => row.propertyId === 'demo-property-b'));
  const scheduled = run('scheduled-income', {...month, unitId: 'demo-unit-a-1', tenantStatus: 'current', search: 'Tenant One'});
  assert.equal(scheduled.length, 2);
  assert.ok(scheduled.every(row => row.unitId === 'demo-unit-a-1' && row.tenantName === 'Tenant One'));
  const collected = run('collected-income', {...range, unitId: 'demo-unit-a-1', tenancyId: 'demo-tenancy-1', personId: 'demo-person-1', tenantStatus: 'current', search: 'Tenant One'});
  assert.equal(collected.length, 3);
  assert.ok(collected.every(row => row.unitId === 'demo-unit-a-1' && row.tenancyId === 'demo-tenancy-1' && row.personId === 'demo-person-1'));
  const scheduledVsCollected = run('scheduled-vs-collected', {...month, unitId: 'demo-unit-a-1', tenantStatus: 'current', search: 'Demo Harbor'});
  assert.equal(scheduledVsCollected.length, 1);
  assert.ok(scheduledVsCollected.every(row => row.propertyId === 'demo-property-a'));
  const delinquency = run('delinquency', {...asOf, unitId: 'demo-unit-a-1', tenantStatus: 'current', balanceStatus: 'due', search: 'Tenant One'});
  assert.equal(delinquency.length, 1);
  assert.ok(delinquency.every(row => row.unitId === 'demo-unit-a-1' && row.tenancyStatus === 'current'));
  const ledgerRows = run('tenant-ledger', {...range, unitId: 'demo-unit-a-1', tenancyId: 'demo-tenancy-1', personId: 'demo-person-1', tenantStatus: 'current'});
  assert.equal(ledgerRows.length, 8);
  assert.ok(ledgerRows.filter(row => row.rowType !== 'opening_balance').every(row => row.transaction && (row.transaction as {unitId?: string}).unitId === 'demo-unit-a-1'));
  const expiring = run('lease-expiration', {...asOf, status: ['expiring'], tenantStatus: 'current', search: 'Tenant One'});
  assert.equal(expiring.length, 1);
  assert.ok(expiring.every(row => row.actionStatus === 'expiring'));
  const deposits = run('security-deposit', {...asOf, unitId: 'demo-unit-a-1', tenantStatus: 'current', search: 'Tenant One'});
  assert.equal(deposits.length, 1);
  assert.ok(deposits.every(row => row.unitId === 'demo-unit-a-1'));
  const applications = run('applicant-pipeline', {...asOf, status: ['submitted'], search: 'Applicant Four'});
  assert.equal(applications.length, 1);
  assert.ok(applications.every(row => row.status === 'submitted'));
  const hap = run('hap', {...month, status: ['active'], tenantStatus: 'current', search: 'Tenant One'});
  assert.equal(hap.length, 1);
  assert.ok(hap.every(row => row.month === '2026-08'));
});

test('HTTP report catalog denies anonymous access and returns shared discovery metadata to an admin without reading records', async () => {
  const app = express();
  app.use((req, _res, next) => { if (req.headers.authorization === 'Bearer synthetic-admin') req.user = {role: 'admin'} as typeof req.user; next(); });
  const repository = createSyntheticRentOpsRepository();
  repository.getSnapshot = async () => { throw new Error('Catalog must not read tenant data'); };
  registerRentOpsRoutes(app, {repository});
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/api/rent-ops/report-catalog`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, {headers: {authorization: 'Bearer synthetic-admin'}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(ReportCatalogSchema.parse(await response.json()), getReportCatalog());
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('MCP catalog matches HTTP factory and all available reports have HTTP/MCP row parity', async () => {
  const repository = createSyntheticRentOpsRepository();
  const now = () => new Date('2026-08-16T12:00:00.000Z');
  const service = new RentOpsService(repository, now);
  const app = express();
  app.use((req, _res, next) => { req.user = {role: 'admin'} as typeof req.user; next(); });
  registerRentOpsRoutes(app, {repository, now});
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => httpServer.once('listening', resolve));
  const address = httpServer.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/rent-ops`;
  const propertyId = (await repository.getSnapshot()).properties[0].id;

  const server = createRentOpsMcpServer(service, {subject: 'admin', scopes: [READ_SCOPE]}, 'https://app.example.test/mcp');
  const client = new Client({name: 'catalog-test', version: '1'});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const result = await client.callTool({name: 'get_report_catalog', arguments: {}});
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent?.data, getReportCatalog());
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'get_report_catalog');
    assert.equal(tool?.annotations?.readOnlyHint, true);
    for (const report of getReportCatalog().reports.filter(report => report.availability === 'available')) {
      const filters: Record<string, string> = {propertyId, asOfDate: '2026-08-16', ...(report.period === 'month' ? {month: '2026-08'} : report.period === 'range' ? {fromDate: '2026-08-01', toDate: '2026-08-16'} : {})};
      const query = new URLSearchParams(filters);
      const result = await client.callTool({name: 'get_report', arguments: {report: report.mcpReport, filters}});
      assert.notEqual(result.isError, true, `${report.id}: ${JSON.stringify(result)}`);
      const response = await fetch(`${base}/reports/${report.reportKey}?${query}`);
      assert.equal(response.status, 200, `${report.id}: HTTP request failed`);
      const envelope = await response.json();
      assert.ok(Array.isArray(envelope.rows), `${report.id}: HTTP rows missing`);
      assert.deepEqual(envelope.rows, result.structuredContent?.data, `${report.id}: HTTP/MCP rows differ`);
    }
  } finally { await client.close(); await server.close(); await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve())); }
});

test('MCP catalog retains read-scope enforcement', async () => {
  const server = createRentOpsMcpServer(new RentOpsService(createSyntheticRentOpsRepository()), {subject: 'admin', scopes: []}, 'https://app.example.test/mcp');
  const client = new Client({name: 'catalog-denied-test', version: '1'});
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try { assert.equal((await client.callTool({name: 'get_report_catalog', arguments: {}})).isError, true); }
  finally { await client.close(); await server.close(); }
});
