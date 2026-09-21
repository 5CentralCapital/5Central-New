import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getReportCatalog, ReportCatalogSchema } from '../../shared/report-catalog';
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
