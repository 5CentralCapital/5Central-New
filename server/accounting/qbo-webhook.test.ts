import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { quickBooksWebhookSignature } from "../integrations/quickbooks/webhook";
import { PostgresJobQueue } from "../jobs/queue";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ingestQuickBooksWebhookDelivery, mergeWebhookObjectPayload, QBO_SYNC_TOPIC, QBO_WEBHOOK_EVENT_TOPIC } from "./webhook-ingest";
import { registerQuickBooksWebhookRoute } from "./webhook-route";
import { createAccountingJobHandlers } from "./worker-handlers";
import type { AccountingServices } from "./index";

const VERIFIER = "synthetic-verifier-token";
const ORG_A = SYNTHETIC_COMPANY.organizationId;
const ENTITY_A = SYNTHETIC_COMPANY.entityId;
const ORG_B = "10000000-0000-4000-8000-000000000002";
const ENTITY_B = "20000000-0000-4000-8000-000000000002";
const ENTITY_A2 = "20000000-0000-4000-8000-000000000003";
const SHARED_REALM = "9130350000000001";
const SECOND_REALM = "9130350000000002";
const UNBOUND_REALM = "9130350000000099";

async function bind(raw: RentOpsQueryExecutor, organizationId: string, legalEntityId: string, realmId: string, status = "active") {
  await raw.query(
    `INSERT INTO accounting_qbo_connections (organization_id, legal_entity_id, environment, realm_id, encrypted_access_token, access_token_iv, access_token_auth_tag,
       encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag, access_token_expires_at, status, revoked_at)
     VALUES ($1,$2,'sandbox',$3,$4,'iv','tag',$5,'iv','tag',now() + interval '1 hour',$6,$7)`,
    [organizationId, legalEntityId, realmId, status === "active" ? "enc" : null, status === "active" ? "enc" : null, status, status === "active" ? null : new Date().toISOString()],
  ).catch(async () => {
    await raw.query(
      `INSERT INTO accounting_qbo_connections (organization_id, legal_entity_id, environment, realm_id, access_token_expires_at, status, revoked_at)
       VALUES ($1,$2,'sandbox',$3,now(),$4,now())`,
      [organizationId, legalEntityId, realmId, status],
    );
  });
  await raw.query(
    `INSERT INTO accounting_qbo_realm_bindings (organization_id, legal_entity_id, environment, realm_id, provider_company_id, evidence_version, company_info_hash, confirmed_by)
     VALUES ($1,$2,'sandbox',$3,$4,'v1',$5,'demo-admin')`,
    [organizationId, legalEntityId, realmId, `company-${realmId}`, "e".repeat(64)],
  );
}

async function harness() {
  const synthetic = await createSyntheticCompanyDatabase();
  const raw = synthetic.executor;
  await raw.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Second Company')", [ORG_B]);
  await raw.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Second LLC','llc','USD')", [ENTITY_B, ORG_B]);
  await raw.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Other Property LLC','llc','USD')", [ENTITY_A2, ORG_A]);
  // One QuickBooks company bound by two organizations, plus a second realm.
  await bind(raw, ORG_A, ENTITY_A, SHARED_REALM);
  await bind(raw, ORG_B, ENTITY_B, SHARED_REALM);
  await bind(raw, ORG_A, ENTITY_A2, SECOND_REALM);
  const executor = await createSyntheticRuntimeExecutor(synthetic.db);
  return { synthetic, raw, executor, close: () => synthetic.close() };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    specversion: "1.0", id: "evt-1", source: "intuit.synthetic-source", type: "qbo.bill.updated.v1",
    time: "2026-09-23T10:00:00.000Z", intuitentityid: "501", intuitaccountid: SHARED_REALM, data: {},
    ...overrides,
  };
}

function delivery(events: readonly Record<string, unknown>[]) {
  const body = Buffer.from(JSON.stringify(events), "utf8");
  return { body, signature: quickBooksWebhookSignature(body, VERIFIER) };
}

test("a bad signature is rejected before anything is persisted", async () => {
  const h = await harness();
  try {
    const { body } = delivery([event()]);
    const wrong = await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: body, signature: quickBooksWebhookSignature(body, "another-token"), verifierToken: VERIFIER });
    assert.deepEqual(wrong, { status: "rejected", reason: "signature" });
    const missing = await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: body, signature: undefined, verifierToken: VERIFIER });
    assert.deepEqual(missing, { status: "rejected", reason: "signature" });
    const tamperedBody = Buffer.from(body.toString("utf8").replace("501", "502"), "utf8");
    assert.equal((await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: tamperedBody, signature: quickBooksWebhookSignature(body, VERIFIER), verifierToken: VERIFIER })).status, "rejected");
    const legacy = Buffer.from(JSON.stringify({ eventNotifications: [] }));
    assert.deepEqual(await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: legacy, signature: quickBooksWebhookSignature(legacy, VERIFIER), verifierToken: VERIFIER }), { status: "rejected", reason: "payload" });
    assert.equal((await h.raw.query("SELECT 1 FROM accounting_qbo_webhook_events")).rows.length, 0);
    assert.equal((await h.raw.query("SELECT 1 FROM company_jobs")).rows.length, 0);
  } finally {
    await h.close();
  }
});

test("one delivery with several realms fans out to every active binding and dedupes replays by source and id", async () => {
  const h = await harness();
  try {
    const { body, signature } = delivery([
      event(),
      event({ id: "evt-2", intuitaccountid: SECOND_REALM, type: "qbo.purchase.created.v1", intuitentityid: "77" }),
      event({ id: "evt-3", intuitaccountid: UNBOUND_REALM }),
      event({ id: "evt-4", type: "qbo.invoice.created.v1", intuitentityid: "9" }),
      event({ id: "evt-5", type: "qbo.account.updated.v1", intuitentityid: undefined }),
    ]);
    const first = await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: body, signature, verifierToken: VERIFIER, now: new Date("2026-09-23T10:00:05Z") });
    assert.deepEqual(first, { status: "accepted", received: 5, fresh: 5, jobs: 5, unrouted: 1, ignored: 1 });
    const jobs = await h.raw.query<{ topic: string; organization_id: string; payload: Record<string, unknown> }>("SELECT topic, organization_id, payload FROM company_jobs ORDER BY topic, organization_id, payload->>'legalEntityId'");
    const fetches = jobs.rows.filter(row => row.topic === QBO_WEBHOOK_EVENT_TOPIC);
    assert.deepEqual(fetches.map(row => [row.organization_id, row.payload.legalEntityId, row.payload.realmId, row.payload.objectType, row.payload.objectId]), [
      [ORG_A, ENTITY_A, SHARED_REALM, "Bill", "501"],
      [ORG_A, ENTITY_A2, SECOND_REALM, "Purchase", "77"],
      [ORG_B, ENTITY_B, SHARED_REALM, "Bill", "501"],
    ]);
    const syncs = jobs.rows.filter(row => row.topic === QBO_SYNC_TOPIC);
    assert.equal(syncs.length, 2, "an event without an entity id triggers a scoped catch-up per binding");
    const states = await h.raw.query<{ event_id: string; state: string; routed_bindings: number }>("SELECT event_id, state, routed_bindings FROM accounting_qbo_webhook_events ORDER BY event_id");
    assert.deepEqual(states.rows.map(row => [row.event_id, row.state, row.routed_bindings]), [
      ["evt-1", "routed", 2], ["evt-2", "routed", 1], ["evt-3", "unrouted", 0], ["evt-4", "processed", 0], ["evt-5", "routed", 2],
    ]);

    const replay = await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: body, signature, verifierToken: VERIFIER });
    assert.deepEqual(replay, { status: "accepted", received: 5, fresh: 0, jobs: 0, unrouted: 0, ignored: 0 });
    // Same event id from another source is a different CloudEvent; the object job absorbs it.
    const other = delivery([event({ source: "intuit.second-source" })]);
    const coalesced = await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: other.body, signature: other.signature, verifierToken: VERIFIER });
    assert.equal(coalesced.status === "accepted" && coalesced.fresh, 1);
    assert.equal(coalesced.status === "accepted" && coalesced.jobs, 0, "pending fetch jobs coalesce per binding and object");
    const merged = await h.raw.query<{ payload: { events: unknown[] } }>("SELECT payload FROM company_jobs WHERE topic = $1 AND organization_id = $2 AND payload->>'realmId' = $3", [QBO_WEBHOOK_EVENT_TOPIC, ORG_A, SHARED_REALM]);
    assert.equal(merged.rows.length, 1);
    assert.equal(merged.rows[0]!.payload.events.length, 2);
    // Production events are a separate ledger.
    const production = await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "production", rawBody: body, signature, verifierToken: VERIFIER });
    assert.equal(production.status === "accepted" && production.fresh, 5);
    assert.equal(production.status === "accepted" && production.unrouted, 5, "no production bindings exist");
  } finally {
    await h.close();
  }
});

test("the raw-body route verifies per-environment tokens and acknowledges without provider calls", async () => {
  const h = await harness();
  const app = express();
  registerQuickBooksWebhookRoute(app, { getExecutor: () => h.executor, env: { QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX: VERIFIER } });
  app.use(express.json());
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const { body, signature } = delivery([event()]);
    const post = (path: string, headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/cloudevents-batch+json", ...headers }, body });
    assert.equal((await post("/api/integrations/quickbooks/webhook/sandbox", { "intuit-signature": "bad" })).status, 401);
    assert.equal((await post("/api/integrations/quickbooks/webhook/production", { "intuit-signature": signature })).status, 503, "no production verifier is configured");
    assert.equal((await post("/api/integrations/quickbooks/webhook/staging", { "intuit-signature": signature })).status, 404);
    const accepted = await post("/api/integrations/quickbooks/webhook/sandbox", { "intuit-signature": signature });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { received: 1, accepted: 1 });
  } finally {
    server.close();
    await h.close();
  }
});

test("the object job applies the change through the scoped provider sync and marks its events processed", async () => {
  const h = await harness();
  try {
    const { body, signature } = delivery([event({ type: "qbo.bill.deleted.v1" })]);
    await ingestQuickBooksWebhookDelivery({ executor: h.executor, environment: "sandbox", rawBody: body, signature, verifierToken: VERIFIER });
    const calls: unknown[] = [];
    const services = {
      qbo: {
        status: "configured",
        environment: "sandbox",
        createProviderSync: (scope: unknown) => ({
          applyObject: async (input: Record<string, unknown>) => { calls.push({ scope, ...input }); return { status: "deleted", objectType: input.objectType, objectId: input.objectId, version: null }; },
        }),
      },
    } as unknown as AccountingServices;
    const handlers = createAccountingJobHandlers({ services });
    const queue = new PostgresJobQueue(h.executor);
    const claimed = await queue.claim({ workerId: "worker-a", topics: [QBO_WEBHOOK_EVENT_TOPIC], limit: 10 });
    assert.equal(claimed.length, 2);
    for (const job of claimed) {
      const result = await handlers[QBO_WEBHOOK_EVENT_TOPIC]!.handler({ job, workerId: "worker-a", signal: new AbortController().signal, queue, executor: h.executor, now: () => new Date(), checkpoint: async () => {} });
      assert.equal((result as { status: string }).status, "deleted");
      const events = await h.raw.query<{ state: string }>("SELECT state FROM accounting_qbo_webhook_events");
      // The first binding's job leaves the event routed until the second finishes.
      assert.equal(events.rows[0]?.state, job === claimed[0] ? "routed" : "processed");
      await queue.complete(job.id, "worker-a", result as Record<string, unknown>);
    }
    assert.deepEqual(calls.map(call => (call as { operation: string; occurredAt: string }).operation), ["deleted", "deleted"]);
    assert.equal((calls[0] as { occurredAt: string }).occurredAt, "2026-09-23T10:00:00.000Z");

    // A worker for the other environment dead-letters the job instead of touching the wrong realm.
    const productionWorker = createAccountingJobHandlers({ services: { qbo: { status: "configured", environment: "production" } } as unknown as AccountingServices });
    await queue.enqueue({ jobKey: "wrong-env", topic: QBO_WEBHOOK_EVENT_TOPIC, organizationId: ORG_A, payload: { organizationId: ORG_A, legalEntityId: ENTITY_A, environment: "sandbox", realmId: SHARED_REALM, objectType: "Bill", objectId: "1", operation: "updated", events: [] } });
    const [job] = await queue.claim({ workerId: "worker-b", topics: [QBO_WEBHOOK_EVENT_TOPIC] });
    await assert.rejects(() => productionWorker[QBO_WEBHOOK_EVENT_TOPIC]!.handler({ job: job!, workerId: "worker-b", signal: new AbortController().signal, queue, executor: h.executor, now: () => new Date(), checkpoint: async () => {} }), (error: unknown) => (error as { code?: string }).code === "qbo_environment_mismatch");
  } finally {
    await h.close();
  }
});

test("merging notices keeps every event ref, lets the latest notice decide, and prefers a deletion on a tie", () => {
  const pending = { objectType: "Bill", objectId: "7", operation: "deleted", occurredAt: "2026-09-23T10:00:00.000Z", events: [{ source: "s", id: "e1" }] };
  const olderUpdate = mergeWebhookObjectPayload(pending, { ref: { source: "s", id: "e0" }, operation: "updated", occurredAt: "2026-09-23T09:59:00.000Z" });
  assert.equal(olderUpdate.operation, "deleted", "an older update never overwrites a newer deletion");
  assert.deepEqual(olderUpdate.events, [{ source: "s", id: "e1" }, { source: "s", id: "e0" }]);
  const tiedUpdate = mergeWebhookObjectPayload(pending, { ref: { source: "s", id: "e2" }, operation: "updated", occurredAt: "2026-09-23T10:00:00.000Z" });
  assert.equal(tiedUpdate.operation, "deleted", "a deletion wins a same-instant tie");
  const tiedDelete = mergeWebhookObjectPayload({ ...pending, operation: "updated" }, { ref: { source: "s", id: "e3" }, operation: "deleted", occurredAt: "2026-09-23T03:00:00.000-07:00" });
  assert.equal(tiedDelete.operation, "deleted");
  assert.equal(tiedDelete.occurredAt, "2026-09-23T10:00:00.000Z");
  const newer = mergeWebhookObjectPayload(pending, { ref: { source: "s", id: "e4" }, operation: "updated", occurredAt: "2026-09-23T10:00:01.000Z" });
  assert.equal(newer.operation, "updated", "a later update (the object came back) decides");
  const duplicate = mergeWebhookObjectPayload(pending, { ref: { source: "s", id: "e1" }, operation: "deleted", occurredAt: "2026-09-23T10:00:00.000Z" });
  assert.deepEqual(duplicate.events, [{ source: "s", id: "e1" }]);
});
