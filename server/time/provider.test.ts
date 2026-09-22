import assert from "node:assert/strict";
import test from "node:test";
import { AccountingError } from "../accounting/errors";
import { createQuickBooksTimeClient, createQuickBooksTimeFetchTransport, createQuickBooksTimeOAuthClient } from "./provider";

const now = new Date("2026-09-21T12:00:00.000Z");

test("QuickBooks Time OAuth records expiry, refresh expiry, and provider identity without exposing tokens", async () => {
  const requests: { method: string; url: string; body?: string }[] = [];
  const oauth = createQuickBooksTimeOAuthClient(async request => {
    requests.push({ method: request.method, url: request.url, body: request.body });
    return { status: 200, body: JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: "3600", refresh_expires_in: 86_400, user_id: "employee-1", company_id: "company-1" }) };
  }, () => now);
  const token = await oauth.exchangeCode({ clientId: "client", clientSecret: "secret", redirectUri: "https://rops.example.test/time/callback", code: "code" });
  assert.equal(token.accessTokenExpiresAt, "2026-09-21T13:00:00.000Z");
  assert.equal(token.refreshTokenExpiresAt, "2026-09-22T12:00:00.000Z");
  assert.equal(token.providerCompanyId, "company-1");
  assert.equal(requests[0]?.method, "POST");
  assert.match(requests[0]?.body ?? "", /grant_type=authorization_code/);
  assert.doesNotMatch(new Error("provider error").message, /access-secret|refresh-secret/);
});

test("QuickBooks Time client sends modified-since pagination and maps 401 to a reconnect conflict", async () => {
  let requestUrl = "";
  const client = createQuickBooksTimeClient(async request => {
    requestUrl = request.url;
    return { status: 200, body: JSON.stringify({ more: false, results: { timesheets: { "timesheet-1": { id: "timesheet-1" } } } }) };
  });
  const page = await client.getPage("timesheets", { accessToken: "access", page: 2, limit: 200, modifiedSince: "2026-09-20T00:00:00.000Z" });
  assert.equal(page.more, false);
  assert.equal(page.results["timesheet-1"]?.id, "timesheet-1");
  const url = new URL(requestUrl);
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("limit"), "200");
  assert.equal(url.searchParams.get("modified_since"), "2026-09-20T00:00:00.000Z");
  const unauthorized = createQuickBooksTimeClient(async () => ({ status: 401, body: JSON.stringify({ error: "expired" }) }));
  await assert.rejects(() => unauthorized.getPage("users", { accessToken: "access" }), (error: unknown) => error instanceof AccountingError && error.code === "accounting_conflict");
});

test("QuickBooks Time transport allows only the documented HTTPS origin and honors cancellation", async () => {
  let called = false;
  const transport = createQuickBooksTimeFetchTransport({ fetchImpl: async (_url, init) => { called = true; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); } });
  await transport({ method: "GET", url: "https://rest.tsheets.com/api/v1/users?page=1", headers: {} });
  assert.equal(called, true);
  await assert.rejects(() => transport({ method: "GET", url: "https://example.test/api/v1/users", headers: {} }), (error: unknown) => error instanceof AccountingError && error.code === "accounting_configuration");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => transport({ method: "GET", url: "https://rest.tsheets.com/api/v1/users", headers: {}, signal: controller.signal }), /cancelled/);
});
