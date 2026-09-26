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
      company: { executor: fixture.database.executor, projects, properties: fixture.services.properties, legalEntities: fixture.services.legalEntities },
    });
    client = new Client({ name: 'company-test', version: '1' });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a); await client.connect(b);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'project_draft_cost_create'));
    assert.ok(tools.tools.some(tool => tool.name === 'property_setup'));
    assert.ok(tools.tools.some(tool => tool.name === 'legal_entity_create'));
    const legalEntityCommand = {
      operationId: randomUUID(), idempotencyKey: randomUUID(), scope: { organizationId: company.organizationId },
      payload: { name: 'Synthetic MCP Entity', entityType: 'llc', currency: 'USD' },
    };
    const legalEntityResult = await client.callTool({ name: 'legal_entity_create', arguments: { command: legalEntityCommand } });
    assert.notEqual(legalEntityResult.isError, true, JSON.stringify(legalEntityResult));
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


test('legal entity create is organization-scoped, idempotent and name-fenced', async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${company.organizationId}`;
  const scope = { organizationId: company.organizationId };
  const command = (payload: unknown, requestedScope = scope) => ({
    operationId: randomUUID(), idempotencyKey: randomUUID(), scope: requestedScope, payload,
  });
  const post = (body: unknown) => fetch(`${base}/legal-entity-commands/legal_entity.create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rent-ops-csrf': 'rent-ops-demo-csrf-token-local-only-20260817' },
    body: JSON.stringify(body),
  });
  try {
    const create = command({ name: '  Synthetic Capital LLC  ', entityType: 'llc', currency: 'USD' });
    const response = await post(create);
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json();
    const entityId = String(receipt.affectedRecordIds[0]);
    const entity = await fixture.database.db.query<{ id: string; name: string; entity_type: string; currency: string }>(
      'SELECT id, name, entity_type, currency FROM company_legal_entities WHERE organization_id=$1 AND id=$2',
      [company.organizationId, entityId],
    );
    assert.deepEqual(entity.rows, [{ id: entityId, name: 'Synthetic Capital LLC', entity_type: 'llc', currency: 'USD' }]);
    assert.deepEqual(await (await post(create)).json(), receipt);

    const duplicate = await post(command({ name: 'synthetic capital llc', entityType: 'corporation', currency: 'USD' }));
    assert.equal(duplicate.status, 409, await duplicate.clone().text());
    const entityScope = await post(command({ name: 'Wrong scope entity', entityType: 'llc', currency: 'USD' }, {
      organizationId: company.organizationId, legalEntityId: company.entityId,
    }));
    assert.equal(entityScope.status, 403, await entityScope.clone().text());
    const propertyScope = await post(command({ name: 'Wrong property scope entity', entityType: 'llc', currency: 'USD' }, {
      organizationId: company.organizationId, legalEntityId: company.entityId, propertyId: company.propertyId,
    }));
    assert.equal(propertyScope.status, 403, await propertyScope.clone().text());
    const context = await (await fetch(`${origin}/api/company/context`)).json();
    assert.equal(context.organizations.flatMap((organization: { entities: Array<{ id: string }> }) => organization.entities).some((item: { id: string }) => item.id === entityId), true);
  } finally {
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


test('planned property setup supports planning reads and edits while blocking pre-close execution', async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${company.organizationId}`;
  const legalScope = { organizationId: company.organizationId, legalEntityId: company.entityId };
  const command = (payload: unknown, scope = legalScope, extra: Record<string, unknown> = {}) => ({
    operationId: randomUUID(),
    idempotencyKey: randomUUID(),
    scope,
    ...extra,
    payload,
  });
  const postProperty = (kind: string, body: unknown) => fetch(`${base}/property-commands/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rent-ops-csrf': 'rent-ops-demo-csrf-token-local-only-20260817' },
    body: JSON.stringify(body),
  });
  const postProject = (kind: string, body: unknown) => fetch(`${base}/project-commands/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rent-ops-csrf': 'rent-ops-demo-csrf-token-local-only-20260817' },
    body: JSON.stringify(body),
  });
  const postExecution = (kind: string, body: unknown) => fetch(`${base}/project-execution-commands/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rent-ops-csrf': 'rent-ops-demo-csrf-token-local-only-20260817' },
    body: JSON.stringify(body),
  });
  try {
    const plannedPayload = {
      name: 'Synthetic planned flip', slug: 'synthetic-planned-flip',
      address: { line1: '123 Planning Way', city: 'Tampa', state: 'fl', postalCode: '33602' },
      propertyType: 'single_family', state: 'active', operatingContact: null,
      associationType: 'planned', assignmentStartOn: '2026-09-01', notes: 'Closing date remains unknown',
    };
    const setupResponse = await postProperty('property.setup', command(plannedPayload));
    assert.equal(setupResponse.status, 200, await setupResponse.clone().text());
    const setupReceipt = await setupResponse.json();
    const propertyId = String(setupReceipt.affectedRecordIds[0]);
    const planId = String(setupReceipt.affectedRecordIds[1]);
    assert.equal((await fixture.database.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM company_property_entity_periods WHERE property_id=$1', [propertyId],
    )).rows[0]?.count, '0');
    assert.equal((await fixture.database.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM rent_ops_units WHERE property_id=$1', [propertyId],
    )).rows[0]?.count, '0');
    const planRow = await fixture.database.db.query<{ status: string; assignment_start_on: string; notes: string | null }>(
      'SELECT status, assignment_start_on::text, notes FROM company_project_property_plans WHERE id=$1', [planId],
    );
    assert.deepEqual(planRow.rows, [{ status: 'planned', assignment_start_on: '2026-09-01', notes: 'Closing date remains unknown' }]);

    const plansResponse = await fetch(`${base}/property-plans?legalEntityId=${company.entityId}`);
    assert.equal(plansResponse.status, 200, await plansResponse.clone().text());
    const plans = await plansResponse.json();
    assert.equal(plans.items.some((item: { id: string; propertyId: string; status: string }) => item.id === planId && item.propertyId === propertyId && item.status === 'planned'), true);

    const wrongEntity = await postProperty('property.setup', command({ ...plannedPayload, name: 'Wrong entity planned property', slug: 'wrong-entity-planned-property' }, {
      organizationId: company.organizationId,
      legalEntityId: '20000000-0000-4000-8000-000000000002',
    }));
    assert.equal(wrongEntity.status, 403, await wrongEntity.clone().text());
    assert.equal((await fixture.database.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM rent_ops_properties WHERE slug='wrong-entity-planned-property'",
    )).rows[0]?.count, '0');

    const createResponse = await postProject('project.create', command({
      name: 'Synthetic planned project', description: 'Planning-only synthetic project', projectType: 'flip',
      propertyId, status: 'planning', startOn: '2026-09-15',
    }, legalScope, { effectiveDate: '2026-09-15' }));
    assert.equal(createResponse.status, 200, await createResponse.clone().text());
    const projectReceipt = await createResponse.json();
    const projectId = String(projectReceipt.affectedRecordIds[0]);

    const listResponse = await fetch(`${base}/projects?legalEntityId=${company.entityId}&asOf=2026-09-15`);
    assert.equal(listResponse.status, 200, await listResponse.clone().text());
    const list = await listResponse.json();
    assert.equal(list.items.some((item: { id: string; status: string; propertyId: string }) => item.id === projectId && item.status === 'planning' && item.propertyId === propertyId), true);
    const detailResponse = await fetch(`${base}/projects/${projectId}?legalEntityId=${company.entityId}&asOf=2026-09-15`);
    assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
    const detail = await detailResponse.json();
    assert.equal(detail.unitId, null);
    assert.equal(detail.status, 'planning');

    const activateBeforeClose = await postProject('project.update', command({ projectId, status: 'active' }, legalScope, {
      effectiveDate: '2026-09-15', expectedRevision: detail.recordRevision,
    }));
    assert.equal(activateBeforeClose.status, 400, await activateBeforeClose.clone().text());
    const drawBeforeClose = await postExecution('project.draw_request.create', command({
      projectId, periodFrom: '2026-09-15', periodTo: '2026-09-30', retainagePercent: '0', currency: 'USD',
    }, legalScope, { effectiveDate: '2026-09-15' }));
    assert.equal(drawBeforeClose.status, 400, await drawBeforeClose.clone().text());

    const editResponse = await postProject('project.update', command({ projectId, name: 'Edited planned project' }, legalScope, {
      effectiveDate: '2026-09-15', expectedRevision: detail.recordRevision,
    }));
    assert.equal(editResponse.status, 200, await editResponse.clone().text());
    const editReceipt = await editResponse.json();
    const editedRevision = editReceipt.resultingRevisions.find((item: { recordId: string }) => item.recordId === projectId)?.revision;
    const draftResponse = await postProject('project.draft_cost.create', command({
      projectId, description: 'Planning estimate', amountCents: '12500', incurredOn: '2026-09-20',
    }, legalScope, { effectiveDate: '2026-09-20', expectedRevision: editedRevision }));
    assert.equal(draftResponse.status, 200, await draftResponse.clone().text());

    const staleConvertResponse = await postProperty('property.plan.convert', command({ planId, effectiveFrom: '2026-09-21' }, legalScope, { expectedRevision: 999 }));
    assert.equal(staleConvertResponse.status, 409, await staleConvertResponse.clone().text());
    const convertResponse = await postProperty('property.plan.convert', command({ planId, effectiveFrom: '2026-09-21' }, legalScope, { expectedRevision: 1 }));
    assert.equal(convertResponse.status, 200, await convertResponse.clone().text());
    const mapping = await fixture.database.db.query<{ effective_from: string }>(
      'SELECT effective_from::text FROM company_property_entity_periods WHERE organization_id=$1 AND legal_entity_id=$2 AND property_id=$3',
      [company.organizationId, company.entityId, propertyId],
    );
    assert.deepEqual(mapping.rows, [{ effective_from: '2026-09-21' }]);

    const postCloseDetail = await (await fetch(`${base}/projects/${projectId}?legalEntityId=${company.entityId}&asOf=2026-09-21`)).json();
    const activateAfterClose = await postProject('project.update', command({ projectId, status: 'active' }, legalScope, {
      effectiveDate: '2026-09-21', expectedRevision: postCloseDetail.recordRevision,
    }));
    assert.equal(activateAfterClose.status, 200, await activateAfterClose.clone().text());
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
