import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCompanyDemoApp } from './demo';
import { SYNTHETIC_COMPANY as company } from './testing/synthetic-database';
import { createCompanyProjectPort } from './project-port';
import { createRentOpsMcpServer } from '../rent-ops/mcp/tools';
import { READ_SCOPE, WRITE_SCOPE } from '../rent-ops/mcp/oauth';
import { RentOpsService } from '../rent-ops/services/service';
import { createSyntheticRentOpsRepository } from '../rent-ops/fixtures/synthetic';
import { RentOpsRetryableConflict } from '../rent-ops/runtime-database';

const scope = { organizationId: company.organizationId, legalEntityId: company.entityId, propertyId: company.propertyId };
const envelope = (payload: unknown, revision?: number) => ({ operationId: randomUUID(), idempotencyKey: randomUUID(), scope, expectedRevision: revision, payload });

test('web and Codex share saved projects, exact costs, replay protection and current grants', async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${company.organizationId}`;
  const post = async (kind: string, body: unknown, csrf = true) => fetch(`${base}/project-commands/${kind}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-rent-ops-csrf': 'rent-ops-demo-csrf-token-local-only-20260817' } : {}) }, body: JSON.stringify(body),
  });
  let mcp: ReturnType<typeof createRentOpsMcpServer> | undefined;
  let client: Client | undefined;
  try {
    assert.equal((await fetch(`${origin}/api/company/context`)).headers.get('cache-control'), 'no-store');
    const create = envelope({ name: 'Synthetic unit renovation', description: 'A private synthetic test', projectType: 'unit_turn', propertyId: company.propertyId, unitId: company.unitId, startOn: '2026-01-01' });
    assert.equal((await post('project.create', create, false)).status, 403);
    const createdResponse = await post('project.create', create);
    assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
    const receipt = await createdResponse.json();
    const projectId = receipt.affectedRecordIds[0];
    await assert.rejects(fixture.database.db.query(`INSERT INTO company_project_posted_actuals
      (id,organization_id,project_id,provider,source_scope,external_id,description,amount_cents,currency,posted_on)
      VALUES ($1,$2,$3,'qbo','synthetic-realm','currency-test','Wrong currency',100,'CAD','2026-01-02')`,
      [randomUUID(), company.organizationId, projectId]), /company_actual_currency_matches_project/);
    await assert.rejects(fixture.database.db.query('UPDATE company_projects SET currency=\'CAD\' WHERE id=$1', [projectId]), /company_project_identity_immutable/);
    assert.deepEqual(await (await post('project.create', create)).json(), receipt);
    assert.equal((await post('project.create', { ...create, actorId: 'someone-else' })).status, 400);
    assert.equal((await post('project.create', { ...create, operationId: randomUUID(), payload: { ...create.payload as object, name: 'Changed same key' } })).status, 409);
    const cost = envelope({ projectId, description: 'Exact draft supplier cost', amountCents: '9007199254740993', incurredOn: '2026-01-02' });
    const costResponse = await post('project.draft_cost.create', cost);
    assert.equal(costResponse.status, 200, await costResponse.clone().text());
    const detailResponse = await fetch(`${base}/projects/${projectId}`);
    assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
    const detail = await detailResponse.json();
    assert.equal(detail.name, create.payload.name);
    assert.equal(detail.description, create.payload.description);
    assert.equal(detail.draftCostCents, '9007199254740993');
    assert.equal(detail.postedActualCents, null);
    assert.equal((await (await fetch(`${base}/projects?limit=1`)).json()).items.length, 1);
    assert.equal((await fetch(`${base}/projects?unexpected=true`)).status, 400);
    await fixture.database.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'oauth:synthetic-admin','admin')", [randomUUID(), company.organizationId]);
    const projects = createCompanyProjectPort(fixture.database.executor);
    mcp = createRentOpsMcpServer(new RentOpsService(createSyntheticRentOpsRepository()), { subject: 'synthetic-admin', scopes: [READ_SCOPE, WRITE_SCOPE] }, 'https://app.example.test/mcp', {
      company: { executor: fixture.database.executor, projects, properties: fixture.services.properties },
    });
    client = new Client({ name: 'company-test', version: '1' });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a); await client.connect(b);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'project_draft_cost_create'));
    assert.ok(tools.tools.some(tool => tool.name === 'property_setup'));
    const replay = await client.callTool({ name: 'project_create', arguments: { command: create } });
    assert.notEqual(replay.isError, true, JSON.stringify(replay));
    assert.deepEqual(replay.structuredContent?.data, receipt);
    const update = envelope({ projectId, name: 'Edited through Codex' }, detail.recordRevision);
    const updated = await client.callTool({ name: 'project_update', arguments: { command: update } });
    assert.notEqual(updated.isError, true, JSON.stringify(updated));
    assert.equal((await (await fetch(`${base}/projects/${projectId}`)).json()).name, 'Edited through Codex');
    const execute = projects.execute;
    try {
      projects.execute = async () => { throw new RentOpsRetryableConflict(); };
      const conflict = await client.callTool({ name: 'project_update', arguments: { command: update } });
      assert.equal(conflict.isError, true);
      assert.deepEqual(conflict.content, [{ type: 'text', text: 'retryable_conflict_retry_identical_command' }]);
    } finally { projects.execute = execute; }
    const stale = await post('project.update', envelope({ projectId, name: 'Stale edit' }, detail.recordRevision));
    assert.equal(stale.status, 409);
    await fixture.database.db.query('UPDATE company_legal_entities SET archived_at=now() WHERE id=$1', [company.entityId]);
    assert.equal((await post('project.draft_cost.create', envelope({ projectId, description: 'Archived entity cost', amountCents: '100', incurredOn: '2026-01-02' }))).status, 400);
    assert.equal((await fetch(`${base}/projects/${projectId}`)).status, 200, 'Archived entity history remains readable');
    await fixture.database.db.query("UPDATE company_access_grants SET revoked_at=now() WHERE actor_id=$1", [company.actorId]);
    assert.equal((await post('project.create', create)).status, 403);
    assert.equal((await fetch(`${base}/projects`)).status, 403);
    assert.equal((await fixture.database.db.query<{ count: number }>('SELECT count(*)::int AS count FROM company_projects')).rows[0].count, 1);
  } finally {
    await client?.close(); await mcp?.close();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});

test('property setup atomically creates a mapped property without units and fences duplicate slugs', async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${company.organizationId}`;
  const post = (body: unknown) => fetch(`${base}/property-commands/property.setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rent-ops-csrf': 'rent-ops-demo-csrf-token-local-only-20260817' },
    body: JSON.stringify(body),
  });
  const setup = {
    operationId: randomUUID(),
    idempotencyKey: randomUUID(),
    scope: { organizationId: company.organizationId, legalEntityId: company.entityId },
    payload: {
      name: 'Synthetic flip setup', slug: 'synthetic-flip-setup',
      address: { line1: '123 Synthetic Way', city: 'Tampa', state: 'fl', postalCode: '33602' },
      propertyType: 'single_family', state: 'active', operatingContact: null, effectiveFrom: '2024-01-01',
    },
  };
  try {
    const response = await post(setup);
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json();
    assert.equal(receipt.affectedRecordIds.length, 2);
    const propertyId = receipt.affectedRecordIds[0];
    const mappingId = receipt.affectedRecordIds[1];
    const property = await fixture.database.db.query<{ slug: string; state_status: string; property_type: string }>('SELECT slug, state_status, property_type FROM rent_ops_properties WHERE id=$1', [propertyId]);
    assert.deepEqual(property.rows, [{ slug: 'synthetic-flip-setup', state_status: 'active', property_type: 'single_family' }]);
    const mapping = await fixture.database.db.query<{ id: string; effective_from: string }>('SELECT id, effective_from::text FROM company_property_entity_periods WHERE id=$1 AND organization_id=$2 AND legal_entity_id=$3 AND property_id=$4', [mappingId, company.organizationId, company.entityId, propertyId]);
    assert.deepEqual(mapping.rows, [{ id: mappingId, effective_from: '2024-01-01' }]);
    assert.equal((await fixture.database.db.query<{ count: string }>('SELECT count(*)::text AS count FROM rent_ops_units WHERE property_id=$1', [propertyId])).rows[0]?.count, '0');
    assert.deepEqual(await (await post(setup)).json(), receipt);
    const duplicate = await post({ ...setup, operationId: randomUUID(), idempotencyKey: randomUUID() });
    assert.equal(duplicate.status, 409);

    const racePayload = { ...setup.payload, name: 'Synthetic race property', slug: 'synthetic-race-property' };
    const [raceA, raceB] = await Promise.all([
      post({ ...setup, operationId: randomUUID(), idempotencyKey: randomUUID(), payload: racePayload }),
      post({ ...setup, operationId: randomUUID(), idempotencyKey: randomUUID(), payload: racePayload }),
    ]);
    assert.deepEqual([raceA.status, raceB.status].sort((a, b) => a - b), [200, 409]);

    const propertyScoped = await post({ ...setup, operationId: randomUUID(), idempotencyKey: randomUUID(), scope: { ...setup.scope, propertyId: company.propertyId }, payload: { ...setup.payload, slug: 'property-scope-rejected' } });
    assert.equal(propertyScoped.status, 403);
    const missingEntity = await post({ ...setup, operationId: randomUUID(), idempotencyKey: randomUUID(), scope: { organizationId: company.organizationId }, payload: { ...setup.payload, slug: 'missing-entity-rejected' } });
    assert.equal(missingEntity.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
