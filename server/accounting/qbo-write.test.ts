import assert from "node:assert/strict";
import test from "node:test";
import type { QuickBooksTransportRequest, QuickBooksTransportResponse } from "../../shared/accounting/quickbooks";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { QuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { createQboWriteService, PostgresQuickBooksWriteJournal, qboWritePolicyFromEnv, QBO_WRITES_DISABLED } from "./qbo-write";

const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "4620816365001234567" };
const enabled = qboWritePolicyFromEnv({ QBO_WRITES_ENABLED: "on", QBO_WRITE_TYPES: "Vendor:create, Vendor:update, Bill:void" });

function provider() {
  const posts: { requestId: string; body: Record<string, unknown> }[] = [];
  const committed = new Map<string, Record<string, unknown>>();
  let vendor: Record<string, unknown> | null = null;
  let mode: "timeout_after_commit" | "ok" | "stale" = "ok";
  const transport = async (request: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const requestId = url.searchParams.get("requestid") ?? "";
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      posts.push({ requestId, body });
      if (mode === "stale") return { status: 400, body: JSON.stringify({ Fault: { Error: [{ code: "5010", Message: "Stale Object Error" }] } }), headers: { intuit_tid: "tid-stale" } };
      if (!committed.has(requestId)) {
        vendor = body.Id ? { ...vendor, ...body, SyncToken: String(Number(vendor?.SyncToken ?? 0) + 1) } : { Id: "41", SyncToken: "0", ...body };
        committed.set(requestId, vendor);
      }
      if (mode === "timeout_after_commit") throw new QuickBooksIntegrationError("quickbooks_timeout", "QuickBooks request timed out", { retryable: true });
      return { status: 200, body: JSON.stringify({ Vendor: committed.get(requestId) }), headers: { intuit_tid: "tid-post" } };
    }
    if (url.pathname.endsWith("/query")) return { status: 200, body: JSON.stringify({ QueryResponse: vendor ? { Vendor: [vendor] } : {} }), headers: {} };
    return vendor ? { status: 200, body: JSON.stringify({ Vendor: vendor }), headers: { intuit_tid: "tid-read" } } : { status: 400, body: JSON.stringify({ Fault: { Error: [{ code: "610" }] } }), headers: {} };
  };
  const client = createQuickBooksAccountingClient({ scope, getAccessToken: async () => "access-token", transport });
  return { posts, client, setMode: (value: typeof mode) => { mode = value; }, vendor: () => vendor };
}

async function database() {
  const synthetic = await createSyntheticCompanyDatabase();
  return { synthetic, executor: await createSyntheticRuntimeExecutor(synthetic.db) };
}

async function journalState(executor: Awaited<ReturnType<typeof database>>["executor"], key: string) {
  const row = await executor.query<{ state: string; provider_entity_id: string | null; readback_at: unknown }>("SELECT state, provider_entity_id, readback_at FROM accounting_qbo_write_attempts WHERE operation_key = $1", [key]);
  return row.rows[0];
}

test("unsupported, disabled and production writes are held with an exact reason and never reach QuickBooks", async () => {
  const { synthetic, executor } = await database();
  try {
    const p = provider();
    const disabled = createQboWriteService({ executor, clientFor: () => p.client, policy: QBO_WRITES_DISABLED });
    const off = await disabled.execute({ scope, operationKey: "vendor-1", entity: "Vendor", operation: "create", fields: { DisplayName: "Synthetic" } });
    assert.equal(off.status, "held");
    assert.match((off as { reason: string }).reason, /turned off/);
    const writer = createQboWriteService({ executor, clientFor: () => p.client, policy: enabled });
    const voided = await writer.execute({ scope, operationKey: "bill-void-1", entity: "Bill", operation: "void", fields: {} });
    assert.equal(voided.status, "held");
    assert.match((voided as { reason: string }).reason, /cannot void a QuickBooks Bill/);
    const notAllowed = await writer.execute({ scope, operationKey: "customer-1", entity: "Customer", operation: "create", fields: { DisplayName: "Tenant" } });
    assert.match((notAllowed as { reason: string }).reason, /not in the enabled write types/);
    const production = await writer.execute({ scope: { ...scope, environment: "production" }, operationKey: "vendor-prod", entity: "Vendor", operation: "create", fields: { DisplayName: "Synthetic" } });
    assert.match((production as { reason: string }).reason, /production writes are turned off/);
    assert.equal(p.posts.length, 0);
    assert.equal((await executor.query("SELECT 1 FROM accounting_qbo_write_attempts")).rows.length, 0, "held writes are not journaled as provider attempts");
  } finally {
    await synthetic.close();
  }
});

test("an ambiguous create is recovered by readback under the stable requestid without a second POST", async () => {
  const { synthetic, executor } = await database();
  try {
    const p = provider();
    const writer = createQboWriteService({ executor, clientFor: () => p.client, policy: enabled });
    const request = { scope, operationKey: "vendor-create-7", entity: "Vendor", operation: "create" as const, fields: { DisplayName: "Synthetic Supply" } };
    p.setMode("timeout_after_commit");
    const first = await writer.execute(request);
    assert.deepEqual(first, { status: "ambiguous", recovery: "reconcile_by_readback" });
    assert.equal((await journalState(executor, "vendor-create-7"))?.state, "ambiguous");
    assert.equal(p.posts.length, 1);

    p.setMode("ok");
    const second = await writer.execute(request);
    assert.equal(second.status, "confirmed");
    assert.equal((second as { providerEntityId: string }).providerEntityId, "41");
    assert.equal(p.posts.length, 1, "the readback proved the write, so nothing was reposted");
    const journal = await journalState(executor, "vendor-create-7");
    assert.equal(journal?.state, "confirmed");
    assert.ok(journal?.readback_at);
    const third = await writer.execute(request);
    assert.equal(third.status, "confirmed", "a confirmed operation replays as confirmed");
    assert.equal(p.posts.length, 1);

    const reused = await writer.execute({ ...request, fields: { DisplayName: "Different Vendor" } });
    assert.deepEqual(reused, { status: "conflict", reason: "operation_key_reused", recovery: "review_provider_record" });
    const journalApi = new PostgresQuickBooksWriteJournal(executor, scope, { entity: "Vendor", operation: "create" });
    const confirmed = await journalApi.load("vendor-create-7");
    await assert.rejects(() => journalApi.save({ ...confirmed!, state: "started" }), /refused/, "a confirmed write never changes state");
  } finally {
    await synthetic.close();
  }
});

test("a stale SyncToken is a definitive rejection that requires a reread, not a retry", async () => {
  const { synthetic, executor } = await database();
  try {
    const p = provider();
    const writer = createQboWriteService({ executor, clientFor: () => p.client, policy: enabled });
    await writer.execute({ scope, operationKey: "vendor-create-8", entity: "Vendor", operation: "create", fields: { DisplayName: "Synthetic Supply" } });
    p.setMode("stale");
    const update = { scope, operationKey: "vendor-update-1", entity: "Vendor", operation: "update" as const, entityId: "41", syncToken: "0", fields: { CompanyName: "Renamed" } };
    const rejected = await writer.execute(update);
    assert.deepEqual(rejected, { status: "conflict", reason: "stale_sync_token", recovery: "reread_and_resubmit" });
    assert.equal((await journalState(executor, "vendor-update-1"))?.state, "failed");
    const postsBefore = p.posts.length;
    assert.deepEqual(await writer.execute(update), { status: "conflict", reason: "rejected", recovery: "reread_and_resubmit" });
    assert.equal(p.posts.length, postsBefore, "the rejected operation is not resent");

    p.setMode("ok");
    const fresh = await writer.execute({ ...update, operationKey: "vendor-update-2", syncToken: String(p.vendor()?.SyncToken) });
    assert.equal(fresh.status, "confirmed");
    const sent = p.posts.at(-1)!.body;
    assert.equal(sent.sparse, true);
    assert.equal(sent.SyncToken, "0");
    await assert.rejects(() => writer.execute({ ...update, operationKey: "vendor-update-3", entityId: undefined }), /record Id/);
    await assert.rejects(() => writer.execute({ ...update, operationKey: "vendor-update-4", fields: { Id: "41" } }), /separately/);
  } finally {
    await synthetic.close();
  }
});

test("rental postings are held unless the entity's posting policy allows that method on that date", async () => {
  const { synthetic, executor } = await database();
  try {
    const p = provider();
    const policy = qboWritePolicyFromEnv({ QBO_WRITES_ENABLED: "on", QBO_WRITE_TYPES: "JournalEntry:create" });
    const writer = createQboWriteService({ executor, clientFor: () => p.client, policy });
    const entry = { scope, operationKey: "bridge-2026-08", entity: "JournalEntry", operation: "create" as const, fields: { TxnDate: "2026-08-31" } };
    const missing = await writer.execute({ ...entry, rentalPosting: { activityDate: "2026-08-31", method: "summary_bridge" } });
    assert.equal(missing.status, "held");
    assert.match((missing as { reason: string }).reason, /Set the rental accounting method/);
    await synthetic.executor.query(`INSERT INTO accounting_rental_posting_policies (id, organization_id, legal_entity_id, method, effective_from, cutoff_date, invoice_delivery_verified, approved_by, reason)
      VALUES ('60000000-0000-4000-8000-000000000001',$1,$2,'native_receivables','2026-01-01','2026-01-01',true,'demo-admin','native')`, [scope.organizationId, scope.legalEntityId]);
    const unclassified = await writer.execute({ ...entry, operationKey: "bridge-unclassified" });
    assert.equal(unclassified.status, "held");
    assert.match((unclassified as { reason: string }).reason, /must declare its rental posting method/);
    const conflict = await writer.execute({ ...entry, rentalPosting: { activityDate: "2026-08-31", method: "summary_bridge" } });
    assert.match((conflict as { reason: string }).reason, /double count/);
    const invoice = await createQboWriteService({ executor, clientFor: () => p.client, policy: qboWritePolicyFromEnv({ QBO_WRITES_ENABLED: "on", QBO_WRITE_TYPES: "Invoice:create" }) }).execute({ scope, operationKey: "inv-1", entity: "Invoice", operation: "create", fields: {} });
    assert.equal(invoice.status, "held");
    assert.equal(p.posts.length, 0, "an unclassified journal entry never reaches QuickBooks");
    assert.equal((await executor.query("SELECT 1 FROM accounting_qbo_write_attempts")).rows.length, 0);
  } finally {
    await synthetic.close();
  }
});

test("a write refused before it is sent (token, cooldown, capability) returns to validated and is retried, not held as possibly recorded", async () => {
  const { synthetic, executor } = await database();
  try {
    const posts: string[] = [];
    let bill: Record<string, unknown> | null = null;
    let tokenAvailable = false;
    const transport = async (request: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
      if (request.method === "POST") {
        posts.push(new URL(request.url).searchParams.get("requestid") ?? "");
        bill = { Id: "77", SyncToken: "0", ...(JSON.parse(request.body ?? "{}") as Record<string, unknown>) };
        return { status: 200, body: JSON.stringify({ Bill: bill }), headers: {} };
      }
      return bill ? { status: 200, body: JSON.stringify({ Bill: bill }), headers: {} } : { status: 400, body: JSON.stringify({ Fault: { Error: [{ code: "610" }] } }), headers: {} };
    };
    const client = createQuickBooksAccountingClient({
      scope,
      getAccessToken: async () => {
        if (!tokenAvailable) throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks connection needs to be reconnected");
        return "access-token";
      },
      transport,
    });
    const writer = createQboWriteService({ executor, clientFor: () => client, policy: qboWritePolicyFromEnv({ QBO_WRITES_ENABLED: "on", QBO_WRITE_TYPES: "Bill:create" }) });
    const request = { scope, operationKey: "bill-create-1", entity: "Bill", operation: "create" as const, fields: { VendorRef: { value: "41" }, Line: [{ Amount: 25, DetailType: "AccountBasedExpenseLineDetail" }] } };
    await assert.rejects(() => writer.execute(request), (error: unknown) => error instanceof QuickBooksIntegrationError && error.code === "quickbooks_unauthorized");
    assert.equal(posts.length, 0);
    assert.equal((await journalState(executor, "bill-create-1"))?.state, "validated", "an unsent write is not journaled as ambiguous");

    tokenAvailable = true;
    const retried = await writer.execute(request);
    assert.equal(retried.status, "confirmed", "the retry sends the write instead of holding it for manual review");
    assert.equal(posts.length, 1);
    assert.equal((await journalState(executor, "bill-create-1"))?.state, "confirmed");
  } finally {
    await synthetic.close();
  }
});
