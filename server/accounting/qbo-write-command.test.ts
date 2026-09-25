import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { QuickBooksTransportRequest, QuickBooksTransportResponse } from "../../shared/accounting/quickbooks";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { QuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { PermanentJobError, PostgresJobQueue, RetryLaterJobError } from "../jobs/queue";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { AccountingServices } from "./index";
import { createAccountingOperationsPort } from "./operations";
import { createQboWriteService, qboWritePolicyFromEnv } from "./qbo-write";
import { qboWriteJobKey, qboWriteOperationKey } from "./qbo-write-command";
import { QBO_WRITE_TOPIC } from "./webhook-ingest";
import { createAccountingJobHandlers } from "./worker-handlers";

const ORG = SYNTHETIC_COMPANY.organizationId;
const ENTITY = SYNTHETIC_COMPANY.entityId;
const REALM = "4620816365001234567";
const scope = { organizationId: ORG, legalEntityId: ENTITY, environment: "sandbox" as const, realmId: REALM };
const policy = qboWritePolicyFromEnv({ QBO_WRITES_ENABLED: "on", QBO_WRITE_TYPES: "Vendor:create,Bill:create,JournalEntry:create,Invoice:create" });

/** A synthetic QuickBooks sandbox: POST commits per requestid; reads by Id or DisplayName. */
function provider() {
  const posts: { entity: string; requestId: string; body: Record<string, unknown> }[] = [];
  const objects = new Map<string, Record<string, unknown>>();
  const byRequest = new Map<string, string>();
  let nextId = 100;
  let mode: "ok" | "timeout_after_commit" = "ok";
  const transport = async (request: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    if (request.method === "POST") {
      const entity = parts.at(-1)!.replace(/^./, c => c.toUpperCase());
      const requestId = url.searchParams.get("requestid") ?? "";
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      posts.push({ entity, requestId, body });
      if (!byRequest.has(requestId)) {
        const id = String(nextId++);
        objects.set(`${entity}:${id}`, { Id: id, SyncToken: "0", ...body });
        byRequest.set(requestId, `${entity}:${id}`);
      }
      if (mode === "timeout_after_commit") throw new QuickBooksIntegrationError("quickbooks_timeout", "QuickBooks request timed out", { retryable: true });
      return { status: 200, body: JSON.stringify({ [entity]: objects.get(byRequest.get(requestId)!) }), headers: { intuit_tid: "tid-post" } };
    }
    if (url.pathname.endsWith("/query")) {
      const query = url.searchParams.get("query") ?? "";
      const entity = /FROM (\w+)/.exec(query)?.[1] ?? "";
      const name = /DisplayName = '([^']*)'/.exec(query)?.[1];
      const found = Array.from(objects.entries()).filter(([key, value]) => key.startsWith(`${entity}:`) && value.DisplayName === name).map(([, value]) => value);
      return { status: 200, body: JSON.stringify({ QueryResponse: found.length ? { [entity]: found } : {} }), headers: {} };
    }
    const entity = parts.at(-2)!.replace(/^./, c => c.toUpperCase());
    const found = objects.get(`${entity}:${parts.at(-1)}`);
    return found ? { status: 200, body: JSON.stringify({ [entity]: found }), headers: { intuit_tid: "tid-read" } } : { status: 400, body: JSON.stringify({ Fault: { Error: [{ code: "610" }] } }), headers: {} };
  };
  const client = createQuickBooksAccountingClient({ scope, getAccessToken: async () => "access-token", transport });
  return { posts, client, setMode: (value: typeof mode) => { mode = value; } };
}

async function harness() {
  const synthetic = await createSyntheticCompanyDatabase();
  const raw = synthetic.executor;
  await raw.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id) VALUES ($1,$2,'finance-1','finance',$3)", [randomUUID(), ORG, ENTITY]);
  await raw.query(
    `INSERT INTO accounting_qbo_connections (organization_id, legal_entity_id, environment, realm_id, encrypted_access_token, access_token_iv, access_token_auth_tag, encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag, access_token_expires_at)
     VALUES ($1,$2,'sandbox',$3,'enc','iv','tag','enc','iv','tag',now())`, [ORG, ENTITY, REALM]);
  const executor = await createSyntheticRuntimeExecutor(synthetic.db);
  const access = async (actorId = SYNTHETIC_COMPANY.actorId, role: "admin" | "finance" = "admin") => {
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId: ORG, role });
    return { principal: await resolvePrincipal(executor), resolvePrincipal, transport: attestTransport("codex_mcp") };
  };
  return { synthetic, raw, executor, access, close: () => synthetic.close() };
}

function envelope(payload: Record<string, unknown>) {
  const operationId = randomUUID();
  return { operationId, idempotencyKey: `qbo-write:${operationId}`, scope: { organizationId: ORG, legalEntityId: ENTITY }, payload: { environment: "sandbox", realmId: REALM, ...payload } };
}

async function rejects(work: Promise<unknown>, reason: string, status?: number) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, `expected a command error, got ${String(error)}`);
    assert.equal(error.details.reason, reason, error.message);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

function runHandler(h: Awaited<ReturnType<typeof harness>>, client: ReturnType<typeof provider>["client"]) {
  const services = { qbo: { status: "configured", environment: "sandbox", createAccountingClient: () => client } } as unknown as AccountingServices;
  const handlers = createAccountingJobHandlers({ services, writePolicy: policy });
  const queue = new PostgresJobQueue(h.executor);
  return async () => {
    // Skip the retry backoff: the test runs the next attempt immediately.
    await h.raw.query("UPDATE company_jobs SET run_after = now() - interval '1 minute' WHERE state = 'retry'");
    const [job] = await queue.claim({ workerId: "worker-w", topics: [QBO_WRITE_TOPIC] });
    assert.ok(job, "a write job is claimable");
    try {
      const result = await handlers[QBO_WRITE_TOPIC]!.handler({ job, workerId: "worker-w", signal: new AbortController().signal, queue, executor: h.executor, now: () => new Date(), checkpoint: async () => {} });
      await queue.complete(job.id, "worker-w", result ?? {});
      return { job, result };
    } catch (error) {
      await queue.fail(job.id, "worker-w", error);
      throw error;
    }
  };
}

test("a submitted write is validated, queued under a stable key, run by the worker and confirmed by readback", async () => {
  const h = await harness();
  try {
    const p = provider();
    const operations = createAccountingOperationsPort(h.executor, { writePolicy: policy });
    const admin = await h.access();
    const command = envelope({ entity: "Vendor", operation: "create", fields: { DisplayName: "Synthetic Supply" } });
    const receipt = await operations.execute("accounting.qbo_write.submit", command, admin);
    assert.equal(receipt.state, "saved_in_rops", "saved and queued, never presented as posted");
    assert.match(receipt.validationOutcomes[0]!.message, /not in QuickBooks until the worker confirms it/);
    assert.deepEqual(await operations.execute("accounting.qbo_write.submit", command, admin), receipt, "an identical retry replays the receipt");
    const jobs = await h.raw.query<{ id: string; job_key: string; payload: Record<string, unknown> }>("SELECT id, job_key, payload FROM company_jobs WHERE topic = $1", [QBO_WRITE_TOPIC]);
    assert.equal(jobs.rows.length, 1);
    assert.equal(jobs.rows[0]!.id, receipt.affectedRecordIds[0]);
    const operationKey = qboWriteOperationKey(command.operationId);
    assert.equal(jobs.rows[0]!.job_key, qboWriteJobKey(scope, operationKey));
    assert.equal(jobs.rows[0]!.payload.operationKey, operationKey);
    assert.equal(p.posts.length, 0, "the command never calls QuickBooks");

    const run = runHandler(h, p.client);
    const { result } = await run();
    assert.equal((result as { status: string }).status, "confirmed");
    assert.equal((result as { providerEntityId: string }).providerEntityId, "100");
    assert.equal(p.posts.length, 1);
    const journal = await h.raw.query<{ state: string; readback_at: unknown; operation_key: string }>("SELECT state, readback_at, operation_key FROM accounting_qbo_write_attempts");
    assert.equal(journal.rows[0]?.state, "confirmed");
    assert.equal(journal.rows[0]?.operation_key, operationKey);
    assert.ok(journal.rows[0]?.readback_at, "confirmation comes from a readback");
    assert.equal((await h.raw.query<{ state: string }>("SELECT state FROM company_jobs WHERE topic = $1", [QBO_WRITE_TOPIC])).rows[0]?.state, "succeeded");
  } finally {
    await h.close();
  }
});

test("the write command refuses disabled, unlisted, unsupported, receivable and unauthorized writes before queuing", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    const off = createAccountingOperationsPort(h.executor);
    await rejects(off.execute("accounting.qbo_write.submit", envelope({ entity: "Vendor", operation: "create", fields: { DisplayName: "X" } }), admin), "qbo_write_held", 409);
    const operations = createAccountingOperationsPort(h.executor, { writePolicy: policy });
    await rejects(operations.execute("accounting.qbo_write.submit", envelope({ entity: "Customer", operation: "create", fields: { DisplayName: "X" } }), admin), "qbo_write_held");
    await rejects(operations.execute("accounting.qbo_write.submit", envelope({ entity: "Bill", operation: "void", fields: {} }), admin), "qbo_write_held");
    await rejects(operations.execute("accounting.qbo_write.submit", envelope({ entity: "Invoice", operation: "create", fields: {} }), admin), "qbo_write_held");
    await rejects(operations.execute("accounting.qbo_write.submit", envelope({ entity: "JournalEntry", operation: "create", fields: { TxnDate: "2026-08-31" } }), admin), "qbo_write_held");
    await rejects(operations.execute("accounting.qbo_write.submit", envelope({ entity: "JournalEntry", operation: "create", fields: { TxnDate: "2026-08-31" }, rentalPosting: { activityDate: "2026-08-31", method: "summary_bridge" } }), admin), "rental_posting_policy_missing");
    await rejects(operations.execute("accounting.qbo_write.submit", envelope({ entity: "Vendor", operation: "create", fields: { Id: "7", DisplayName: "X" } }), admin), "qbo_write_invalid", 400);
    await rejects(operations.execute("accounting.qbo_write.submit", { ...envelope({ entity: "Vendor", operation: "create", fields: { DisplayName: "X" } }), payload: { environment: "sandbox", realmId: "999", entity: "Vendor", operation: "create", fields: { DisplayName: "X" } } }, admin), "qbo_connection_missing");
    const production = qboWritePolicyFromEnv({ QBO_WRITES_ENABLED: "on", QBO_WRITE_TYPES: "Vendor:create" });
    await rejects(createAccountingOperationsPort(h.executor, { writePolicy: production }).execute("accounting.qbo_write.submit", { ...envelope({}), payload: { environment: "production", realmId: REALM, entity: "Vendor", operation: "create", fields: { DisplayName: "X" } } }, admin), "qbo_write_held");
    const finance = await h.access("finance-1", "finance");
    await assert.rejects(operations.execute("accounting.qbo_write.submit", envelope({ entity: "Vendor", operation: "create", fields: { DisplayName: "X" } }), finance), (error: unknown) => error instanceof CompanyCommandError && error.status === 403, "finance users cannot post to QuickBooks");
    assert.equal((await h.raw.query("SELECT 1 FROM company_jobs")).rows.length, 0, "nothing was queued");
  } finally {
    await h.close();
  }
});

test("an ambiguous Bill create has no readback key, so the worker holds it for manual review instead of resending", async () => {
  const h = await harness();
  try {
    const p = provider();
    const operations = createAccountingOperationsPort(h.executor, { writePolicy: policy });
    await operations.execute("accounting.qbo_write.submit", envelope({ entity: "Bill", operation: "create", fields: { VendorRef: { value: "56" }, Line: [] } }), await h.access());
    const run = runHandler(h, p.client);
    p.setMode("timeout_after_commit");
    await assert.rejects(run(), (error: unknown) => error instanceof RetryLaterJobError && error.code === "quickbooks_ambiguous_write");
    assert.equal(p.posts.length, 1);
    p.setMode("ok");
    await assert.rejects(run(), (error: unknown) => error instanceof PermanentJobError && error.code === "qbo_write_ambiguous_manual_review");
    assert.equal(p.posts.length, 1, "the Bill was not posted a second time");
    const job = await h.raw.query<{ state: string; last_error_code: string }>("SELECT state, last_error_code FROM company_jobs WHERE topic = $1", [QBO_WRITE_TOPIC]);
    assert.deepEqual(job.rows[0], { state: "dead", last_error_code: "qbo_write_ambiguous_manual_review" });
    assert.equal((await h.raw.query<{ state: string }>("SELECT state FROM accounting_qbo_write_attempts")).rows[0]?.state, "ambiguous");

    // The service answers the same way directly; a Vendor create (natural key) still reconciles by readback.
    const writer = createQboWriteService({ executor: h.executor, clientFor: () => p.client, policy });
    const operationKey = (await h.raw.query<{ operation_key: string }>("SELECT operation_key FROM accounting_qbo_write_attempts")).rows[0]!.operation_key;
    assert.deepEqual(await writer.execute({ scope, operationKey, entity: "Bill", operation: "create", fields: { VendorRef: { value: "56" }, Line: [] } }), { status: "ambiguous", recovery: "manual_review", reason: "no_readback_key" });
    assert.equal(p.posts.length, 1);
  } finally {
    await h.close();
  }
});
