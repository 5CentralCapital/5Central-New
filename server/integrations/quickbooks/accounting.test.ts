import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksAccountingClient } from "./accounting";
import { QuickBooksIntegrationError } from "./errors";
import { isQuickBooksAdapterCapabilityImplemented, isQuickBooksCapabilityEnabled } from "../../../shared/accounting/quickbooks";
import type { QuickBooksTransportRequest, QuickBooksTransportResponse } from "../../../shared/accounting/quickbooks";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  legalEntityId: "20000000-0000-4000-8000-000000000001",
  realmId: "4620816365001234567",
  environment: "sandbox" as const,
};

function response(status: number, body: unknown, headers: Record<string, string> = {}): QuickBooksTransportResponse {
  return { status, body: JSON.stringify(body), headers };
}

test("Accounting read, query, create, and SyncToken update stay on the scoped sandbox realm", async () => {
  const calls: QuickBooksTransportRequest[] = [];
  const transport = async (request: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
    calls.push(request);
    if (request.method === "GET" && request.url.includes("/query?")) return response(200, { QueryResponse: { Account: [{ Id: "1", Name: "Operating" }], startPosition: 1, maxResults: 1 } });
    if (request.method === "GET") return response(200, { Account: { Id: "1", SyncToken: "2", Name: "Operating" } }, { intuit_tid: "tid-read" });
    return response(200, { Account: { Id: "1", SyncToken: "3", Name: "Updated" } }, { intuit_tid: "tid-write" });
  };
  const client = createQuickBooksAccountingClient({ scope, getAccessToken: async () => "access-token", transport });

  const read = await client.read("Account", "1");
  assert.equal(read.entity.Name, "Operating");
  assert.equal(read.intuitTid, "tid-read");
  const queried = await client.query("select * from Account");
  assert.equal(queried.entities.length, 1);
  const created = await client.create("Account", { Name: "Operating" });
  assert.equal(created.entity.Id, "1");
  const updated = await client.update({ entity: "Account", id: "1", syncToken: "2", fields: { Name: "Updated" } });
  assert.equal(updated.entity.SyncToken, "3");

  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /^https:\/\/sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/4620816365001234567\/account\/1\?minorversion=75$/);
  assert.equal(calls[0].headers.Authorization, "Bearer access-token");
  assert.equal(new URL(calls[1].url).searchParams.get("query"), "select * from Account");
  const createBody = JSON.parse(calls[2].body ?? "{}");
  assert.equal(createBody.Name, "Operating");
  const updateBody = JSON.parse(calls[3].body ?? "{}");
  assert.deepEqual(updateBody, { Name: "Updated", Id: "1", SyncToken: "2" });
});

test("write uncertainty is explicit and never retried, while definitive validation remains definitive", async () => {
  let calls = 0;
  const client = createQuickBooksAccountingClient({
    scope,
    getAccessToken: async () => "access-token",
    transport: async () => {
      calls += 1;
      return response(503, { Fault: { Error: [{ code: "500", Detail: "provider unavailable" }] } }, { "retry-after": "3" });
    },
  });
  await assert.rejects(() => client.create("Account", { Name: "May exist" }), (error: unknown) => {
    assert.ok(error instanceof QuickBooksIntegrationError);
    assert.equal(error.code, "quickbooks_ambiguous_write");
    assert.equal(error.ambiguous, true);
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfterMs, 3_000);
    return true;
  });
  assert.equal(calls, 1);

  const definitive = createQuickBooksAccountingClient({
    scope,
    getAccessToken: async () => "access-token",
    transport: async () => response(400, { Fault: { Error: [{ code: "2170", Message: "Name is required" }] } }),
  });
  await assert.rejects(() => definitive.create("Account", {}), (error: unknown) => {
    assert.ok(error instanceof QuickBooksIntegrationError);
    assert.equal(error.code, "quickbooks_api");
    assert.equal(error.ambiguous, false);
    assert.doesNotMatch(JSON.stringify(error), /Name is required/);
    return true;
  });
});

test("premium or unsupported project entities stay disabled", async () => {
  assert.equal(isQuickBooksAdapterCapabilityImplemented("accounting.read"), true);
  assert.equal(isQuickBooksCapabilityEnabled("accounting.read"), false);
  assert.equal(isQuickBooksCapabilityEnabled("accounting.read", true), true);
  assert.equal(isQuickBooksCapabilityEnabled("projects.graphql", true), false);
  const client = createQuickBooksAccountingClient({ scope, getAccessToken: async () => "access-token", transport: async () => response(200, {}) });
  await assert.rejects(() => client.read("Project", "1"), (error: unknown) => {
    assert.ok(error instanceof QuickBooksIntegrationError);
    assert.equal(error.code, "quickbooks_unsupported_capability");
    return true;
  });
});

test("production scope selects the production Accounting host", async () => {
  let requested = "";
  const client = createQuickBooksAccountingClient({
    scope: { ...scope, environment: "production" },
    getAccessToken: async () => "access-token",
    transport: async request => {
      requested = request.url;
      return response(200, { Account: { Id: "1", SyncToken: "0" } });
    },
  });
  await client.read("Account", "1");
  assert.match(requested, /^https:\/\/quickbooks\.api\.intuit\.com\/v3\/company\//);
});

test("preserves large JSON monetary lexemes until the caller can validate them", async () => {
  const client = createQuickBooksAccountingClient({
    scope,
    getAccessToken: async () => "access-token",
    transport: async () => ({ status: 200, body: '{"Purchase":{"Id":9007199254740993,"SyncToken":17,"TotalAmt":90071992547409.93}}' }),
  });
  const result = await client.read("Purchase", "9007199254740993");
  assert.equal(result.entity.Id, "9007199254740993");
  assert.equal(result.entity.TotalAmt, "90071992547409.93");
});
