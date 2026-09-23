import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import { COMPANY_DEMO_CSRF_TOKEN, createCompanyDemoApp } from "../company/demo";
import { SYNTHETIC_COMPANY as fixture } from "../company/testing/synthetic-database";
import { createJobsPort } from "../jobs/operator";
import { createRentOpsMcpServer } from "../rent-ops/mcp/tools";
import { READ_SCOPE, WRITE_SCOPE } from "../rent-ops/mcp/oauth";
import { RentOpsService } from "../rent-ops/services/service";
import { createSyntheticRentOpsRepository } from "../rent-ops/fixtures/synthetic";

test("browser HTTP and Codex MCP share accounting operations and job operator tools", async () => {
  const demo = await createCompanyDemoApp();
  const listener = demo.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/company/${fixture.organizationId}`;
  const server = createRentOpsMcpServer(new RentOpsService(createSyntheticRentOpsRepository()), { subject: "verified-admin-subject", scopes: [READ_SCOPE, WRITE_SCOPE] }, "https://example.test/mcp", { company: demo.services, companyActorId: fixture.actorId });
  const client = new Client({ name: "accounting-operations-parity", version: "1" });
  const scope = { organizationId: fixture.organizationId, legalEntityId: fixture.entityId };
  const envelope = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const operationId = randomUUID();
    return { operationId, idempotencyKey: `acct-parity:${operationId}`, scope, payload, ...extra };
  };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN }, body: JSON.stringify(body) });
  const get = async (path: string) => { const response = await fetch(`${base}${path}`); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return (result.structuredContent as { data: any }).data;
  };
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const tools = await client.listTools();
    const names = tools.tools.map(item => item.name);
    for (const name of ["get_accounting_connector_health", "get_period_close_checklist", "list_rental_posting_policies", "set_rental_posting_policy", "close_rental_posting_policy",
      "list_pm_settlements", "get_pm_settlement", "create_pm_settlement", "update_pm_settlement", "reconcile_pm_settlement", "mark_pm_settlement_exception", "clear_pm_settlement_exception",
      "preview_rental_bridge", "list_accounting_payables", "sync_accounting_source", "list_jobs", "get_job", "requeue_job", "cancel_job"]) {
      assert.ok(names.includes(name), `${name} is registered`);
    }
    const annotations = Object.fromEntries(tools.tools.map(item => [item.name, item.annotations]));
    assert.equal(annotations.get_accounting_connector_health?.readOnlyHint, true);
    assert.equal(annotations.list_jobs?.readOnlyHint, true);
    assert.notEqual(annotations.create_pm_settlement?.readOnlyHint, true);

    // Browser sets the posting method; Codex reads the same record.
    const set = await post("/accounting-commands/accounting.rental_posting_policy.set", envelope({ method: "summary_bridge", effectiveFrom: "2026-01-01", cutoffDate: "2026-01-01", reason: "Monthly PM summary" }));
    assert.equal(set.status, 200, await set.clone().text());
    const httpPolicies = await get(`/accounting/posting-policies?legalEntityId=${fixture.entityId}`);
    assert.deepEqual(await tool("list_rental_posting_policies", scope), httpPolicies);

    // Codex records a PM statement; the browser reads the same gross-to-net report.
    const statement = {
      propertyId: fixture.propertyId, managerName: "Synthetic PM", periodStart: "2026-08-01", periodEnd: "2026-08-31", currency: "USD",
      openingHeldCents: "0", grossCollectionsCents: "100000", pmFeesCents: "10000", pmExpensesCents: "0", otherDeductionsCents: "0", ownerRemittanceCents: "90000", closingHeldCents: "0",
      lines: [{ kind: "rent_receipt", description: "Rent", amountCents: "100000" }, { kind: "pm_fee", description: "Fee", amountCents: "10000" }, { kind: "owner_remittance", description: "Draw", amountCents: "90000" }],
    };
    const receipt = await tool("create_pm_settlement", { command: envelope(statement) });
    const settlementId = receipt.affectedRecordIds[0];
    const httpDetail = await get(`/accounting/pm-settlements/${settlementId}`);
    assert.deepEqual(await tool("get_pm_settlement", { scope: { organizationId: fixture.organizationId }, settlementId }), httpDetail);
    assert.equal(httpDetail.grossToNet.operatingCollectionsCents, "100000");
    assert.equal(httpDetail.grossToNet.remittedCents, "90000");
    const list = await get(`/accounting/pm-settlements?legalEntityId=${fixture.entityId}&state=draft`);
    assert.equal(list.items.length, 1);
    const stale = await post("/accounting-commands/accounting.pm_settlement.reconcile", envelope({ settlementId, bankObservationReference: "dep", bankSettledOn: "2026-09-02" }, { expectedRevision: 7 }));
    assert.equal(stale.status, 409);

    const { generatedAt: _mcpAt, ...mcpHealth } = await tool("get_accounting_connector_health", { organizationId: fixture.organizationId });
    const { generatedAt: _httpAt, ...httpHealth } = await get("/accounting/health");
    assert.deepEqual(mcpHealth, httpHealth);
    const close = await get(`/accounting/period-close?legalEntityId=${fixture.entityId}&periodStart=2026-08-01&periodEnd=2026-08-31`);
    assert.equal(close.items.find((item: { code: string }) => item.code === "posting_policy").state, "complete");
    const preview = await get(`/accounting/rental-bridge?legalEntityId=${fixture.entityId}&periodStart=2026-08-01&periodEnd=2026-08-31`);
    const mcpPreview = await tool("preview_rental_bridge", { ...scope, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    assert.equal(mcpPreview.fingerprint, preview.fingerprint);
    const csv = await fetch(`${base}/accounting/rental-bridge?legalEntityId=${fixture.entityId}&periodStart=2026-08-01&periodEnd=2026-08-31&format=csv`);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(await csv.text(), /nothing was posted to QuickBooks/);
    const payables = await get(`/accounting/qbo/payables?legalEntityId=${fixture.entityId}&environment=sandbox&realmId=123&kind=bills`);
    assert.deepEqual(payables.items, []);
    assert.equal(payables.coverage.status, "unavailable");

    // Job operators: list over HTTP, requeue over MCP, read back over HTTP.
    const jobId = randomUUID();
    await demo.database.db.query(`INSERT INTO company_jobs (id, organization_id, job_key, topic, payload, state, attempts, max_attempts, finished_at, last_error_code, last_error_message) VALUES ($1,$2,'parity-dead','accounting.qbo.sync','{}'::jsonb,'dead',3,3,now(),'quickbooks_server','Provider unavailable')`, [jobId, fixture.organizationId]);
    await demo.database.db.query(`INSERT INTO company_job_attempts (job_id, attempt, lease_owner, started_at, finished_at, outcome) VALUES ($1,1,'w',now(),now(),'retry'),($1,2,'w',now(),now(),'retry'),($1,3,'w',now(),now(),'dead')`, [jobId]);
    const jobs = await get("/jobs?state=dead");
    assert.deepEqual(jobs.items.map((item: { id: string }) => item.id), [jobId]);
    assert.deepEqual(await tool("list_jobs", { query: { organizationId: fixture.organizationId, states: ["dead"] } }), jobs);
    const requeue = await tool("requeue_job", { command: { operationId: randomUUID(), idempotencyKey: `requeue-${jobId}`, scope: { organizationId: fixture.organizationId }, payload: { jobId, additionalAttempts: 2 } } });
    assert.deepEqual(requeue.affectedRecordIds, [jobId]);
    const detail = await get(`/jobs/${jobId}`);
    assert.equal(detail.state, "queued");
    assert.equal(detail.maxAttempts, 5);
    assert.equal(detail.attemptHistory.length, 3);
    const cancel = await post("/job-commands/job.cancel", { operationId: randomUUID(), idempotencyKey: `cancel-${jobId}`, scope: { organizationId: fixture.organizationId }, payload: { jobId } });
    assert.equal(cancel.status, 200, await cancel.clone().text());
    assert.equal((await get(`/jobs/${jobId}`)).state, "cancelled");
    const entityScoped = await post("/job-commands/job.requeue", { operationId: randomUUID(), idempotencyKey: `entity-${jobId}`, scope, payload: { jobId } });
    assert.equal(entityScoped.status, 403, "job operations are organization-level");

    // Finance users run accounting but are not job operators.
    await demo.database.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'finance-2','finance')", [randomUUID(), fixture.organizationId]);
    const jobsPort = createJobsPort(demo.database.executor);
    const finance = await loadAuthenticatedPrincipal(demo.database.executor, { actorId: "finance-2", organizationId: fixture.organizationId, role: "finance" });
    await assert.rejects(jobsPort.list(finance, { organizationId: fixture.organizationId }), (error: unknown) => error instanceof CompanyCommandError && error.status === 403);
    await assert.rejects(jobsPort.execute("job.cancel", { operationId: randomUUID(), idempotencyKey: `finance-${jobId}`, scope: { organizationId: fixture.organizationId }, payload: { jobId } }, {
      principal: finance, transport: attestTransport("web"), resolvePrincipal: executor => loadAuthenticatedPrincipal(executor, { actorId: "finance-2", organizationId: fixture.organizationId, role: "finance" }),
    }), (error: unknown) => error instanceof CompanyCommandError && error.status === 403);
  } finally {
    await client.close().catch(() => undefined);
    listener.close();
    await demo.close();
  }
});
