import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCompanyDemoApp } from './demo';
import { SYNTHETIC_COMPANY as fixture } from './testing/synthetic-database';
import { createRentOpsMcpServer } from '../rent-ops/mcp/tools';
import { READ_SCOPE, WRITE_SCOPE } from '../rent-ops/mcp/oauth';
import { RentOpsService } from '../rent-ops/services/service';
import { createSyntheticRentOpsRepository } from '../rent-ops/fixtures/synthetic';

test('browser and Codex share report snapshots and private presets through a verified actor mapping', async () => {
  const demo = await createCompanyDemoApp();
  const listener = demo.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${fixture.organizationId}/reporting`;
  const server = createRentOpsMcpServer(new RentOpsService(createSyntheticRentOpsRepository()), {
    subject: 'verified-admin-subject', scopes: [READ_SCOPE, WRITE_SCOPE],
  }, 'https://example.test/mcp', { company: demo.services, companyActorId: fixture.actorId });
  const client = new Client({ name: 'report-parity-test', version: '1' });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rent-ops-csrf': 'rent-ops-demo-csrf-token-local-only-20260817' },
    body: JSON.stringify(body),
  });
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const request = {
      requestId: 'report-transport-parity', reportId: 'occupancy', definitionVersion: '1',
      scope: { organizationId: fixture.organizationId, legalEntityIds: [fixture.entityId], propertyIds: [fixture.propertyId] },
      filters: { propertyScope: 'all' }, period: { mode: 'as_of', asOfDate: '2026-08-15' }, basis: 'operational', currency: null,
    };
    const response = await post('/runs', request);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const browser = await response.json();
    assert.equal(browser.run.rows, undefined, 'Run headers must not duplicate the full dataset');
    const replay = await post('/runs', request);
    assert.equal(replay.status, 201, await replay.clone().text());
    assert.deepEqual(await replay.json(), browser);
    const codex = await client.callTool({ name: 'run_company_report', arguments: { request } });
    assert.notEqual(codex.isError, true, JSON.stringify(codex));
    assert.deepEqual(codex.structuredContent?.data, browser, 'The same request reopens the same durable run across transports');
    const { requestId: _requestId, ...presetSetup } = request;
    const presetResponse = await post('/presets', { ...presetSetup, name: 'Monthly occupancy', visibility: 'private' });
    assert.equal(presetResponse.status, 201, await presetResponse.clone().text());
    const preset = await presetResponse.json();
    const presets = await client.callTool({ name: 'list_company_report_presets', arguments: { organizationId: fixture.organizationId } });
    assert.notEqual(presets.isError, true, JSON.stringify(presets));
    assert.deepEqual(presets.structuredContent?.data, [preset]);
    await demo.database.db.query('UPDATE company_access_grants SET revoked_at=now() WHERE organization_id=$1 AND actor_id=$2', [fixture.organizationId, fixture.actorId]);
    assert.equal((await fetch(`${base}/runs/${browser.run.id}`)).status, 403);
    const revoked = await client.callTool({ name: 'get_company_report_page', arguments: { organizationId: fixture.organizationId, runId: browser.run.id } });
    assert.equal(revoked.isError, true);
  } finally {
    await client.close(); await server.close();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await demo.close();
  }
});
