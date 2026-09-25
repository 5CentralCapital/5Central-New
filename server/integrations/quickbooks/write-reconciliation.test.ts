import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksAccountingClient } from "./accounting";
import { QuickBooksIntegrationError } from "./errors";
import { createInMemoryQuickBooksWriteJournal, createQuickBooksWriteReconciler, quickBooksWriteRequestId } from "./write-reconciliation";
import type { QuickBooksTransportRequest, QuickBooksTransportResponse } from "../../../shared/accounting/quickbooks";

const scope = { organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", realmId: "4620816365001234567", environment: "sandbox" as const };
const request = { DisplayName: "Synthetic Vendor" };

function harness() {
  const posts: string[] = [];
  let providerVendor: Record<string, unknown> | null = null;
  let postBehavior: "timeout_after_commit" | "timeout_before_commit" | "ok" = "timeout_after_commit";
  const committedRequestIds = new Set<string>();
  const transport = async (req: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
    const url = new URL(req.url);
    if (req.method === "POST") {
      const requestId = url.searchParams.get("requestid") ?? "";
      posts.push(requestId);
      // Intuit de-duplicates by requestid: a replay returns the original object.
      if (!committedRequestIds.has(requestId) && postBehavior !== "timeout_before_commit") {
        committedRequestIds.add(requestId);
        providerVendor = { Id: String(committedRequestIds.size + 40), SyncToken: "0", ...JSON.parse(req.body ?? "{}") };
      }
      if (postBehavior !== "ok") throw new QuickBooksIntegrationError("quickbooks_timeout", "QuickBooks request timed out", { retryable: true });
      return { status: 200, body: JSON.stringify({ Vendor: providerVendor }), headers: { intuit_tid: "tid-post" } };
    }
    return { status: 200, body: JSON.stringify({ QueryResponse: providerVendor ? { Vendor: [providerVendor] } : {} }), headers: { intuit_tid: "tid-read" } };
  };
  const client = createQuickBooksAccountingClient({ scope, getAccessToken: async () => "access-token", transport });
  const readback = async () => {
    const found = await client.query("select * from Vendor where DisplayName = 'Synthetic Vendor'");
    const entity = found.entities[0];
    return entity ? { exists: true, providerEntity: entity, providerEntityId: String(entity.Id), providerVersion: String(entity.SyncToken), intuitTid: found.intuitTid } : { exists: false };
  };
  return { posts, client, readback, setPost: (value: typeof postBehavior) => { postBehavior = value; }, vendorCount: () => committedRequestIds.size };
}

test("an uncertain write is journaled ambiguous and later confirmed by provider readback without a second POST", async () => {
  const h = harness();
  const journal = createInMemoryQuickBooksWriteJournal();
  const reconciler = createQuickBooksWriteReconciler(journal);
  const write = ({ requestId }: { requestId: string }) => h.client.create("Vendor", request, { requestId });
  await assert.rejects(() => reconciler.execute({ operationKey: "vendor-create-1", request, write, readback: h.readback }), (error: unknown) => {
    assert.ok(error instanceof QuickBooksIntegrationError);
    assert.equal(error.code, "quickbooks_ambiguous_write");
    return true;
  });
  assert.equal((await journal.load("vendor-create-1"))?.state, "ambiguous");
  assert.deepEqual(h.posts, [quickBooksWriteRequestId("vendor-create-1")]);

  h.setPost("ok");
  const result = await reconciler.execute({ operationKey: "vendor-create-1", request, write, readback: h.readback });
  assert.equal(result.status, "confirmed");
  assert.equal(result.providerEntityId, "41");
  assert.equal(h.posts.length, 1, "readback confirmed the write, so it was not re-sent");
  assert.equal((await journal.load("vendor-create-1"))?.state, "confirmed");
});

test("a retry after a not-found readback reuses the original requestid so Intuit de-duplicates it", async () => {
  const h = harness();
  const journal = createInMemoryQuickBooksWriteJournal();
  const reconciler = createQuickBooksWriteReconciler(journal);
  const write = ({ requestId }: { requestId: string }) => h.client.create("Vendor", request, { requestId });
  // First attempt never reached the provider's commit.
  h.setPost("timeout_before_commit");
  await assert.rejects(() => reconciler.execute({ operationKey: "vendor-create-2", request, write, readback: h.readback }), /outcome is unknown|unresolved/);
  h.setPost("ok");
  const result = await reconciler.execute({ operationKey: "vendor-create-2", request, write, readback: h.readback });
  assert.equal(result.status, "confirmed");
  const expected = quickBooksWriteRequestId("vendor-create-2");
  assert.ok(expected.length <= 50);
  assert.deepEqual(h.posts, [expected, expected], "the retry sends the identical requestid");
  assert.equal(h.vendorCount(), 1);
  assert.notEqual(quickBooksWriteRequestId("vendor-create-3"), expected);
});

test("readback compares requested numbers with the provider's decimal lexemes by value", async () => {
  // QuickBooks serializes whole amounts as 200.0; the lossless parser keeps that text.
  const saved = '{"Bill":{"Id":"77","SyncToken":"0","VendorRef":{"value":"41"},"Line":[{"Amount":200.0,"DetailType":"AccountBasedExpenseLineDetail"}],"TotalAmt":200.00}}';
  const client = createQuickBooksAccountingClient({ scope, getAccessToken: async () => "access-token", transport: async () => ({ status: 200, body: saved, headers: {} }) });
  const reconciler = createQuickBooksWriteReconciler(createInMemoryQuickBooksWriteJournal());
  const fields = { VendorRef: { value: "41" }, Line: [{ Amount: 200, DetailType: "AccountBasedExpenseLineDetail" }], TotalAmt: 200 };
  const readback = async () => {
    const found = await client.read("Bill", "77");
    return { exists: true, providerEntity: found.entity, providerEntityId: "77" };
  };
  const result = await reconciler.execute({ operationKey: "bill-200", request: fields, write: ({ requestId }) => client.create("Bill", fields, { requestId }), readback });
  assert.equal(result.status, "confirmed");
  await assert.rejects(
    () => createQuickBooksWriteReconciler(createInMemoryQuickBooksWriteJournal()).execute({ operationKey: "bill-201", request: { ...fields, TotalAmt: 201 }, write: ({ requestId }) => client.create("Bill", fields, { requestId }), readback }),
    (error: unknown) => error instanceof QuickBooksIntegrationError && error.code === "quickbooks_conflict",
    "a different amount is still a mismatch",
  );
});
