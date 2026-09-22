import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { createCompanyDemoApp, COMPANY_DEMO_CSRF_TOKEN } from "../company/demo";
import { SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQboTokenCipher } from "./token-crypto";
import { registerAccountingMcpTools } from "./mcp";

const realmId = "123456";
const organizationId = SYNTHETIC_COMPANY.organizationId;
const legalEntityId = SYNTHETIC_COMPANY.entityId;
const scope = { organizationId, legalEntityId, environment: "sandbox" as const, realmId };
const SESSION = "harness-session-aaaaaaaa";

type RevokeBehavior = "ok" | "server_error" | "network_error" | "invalid_grant";

/** Offline Intuit double. Records method/host/path and form grant types only. */
function createIntuitDouble() {
  const calls: { method: string; host: string; path: string; grantType?: string; revokedToken?: string }[] = [];
  let refreshCounter = 0;
  const state = { revoke: "ok" as RevokeBehavior };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const form = typeof init?.body === "string" && url.host !== "sandbox-quickbooks.api.intuit.com" ? new URLSearchParams(init.body) : null;
    calls.push({ method, host: url.host, path: url.pathname, ...(form?.get("grant_type") ? { grantType: form.get("grant_type")! } : {}), ...(url.pathname.endsWith("/revoke") ? { revokedToken: form?.get("token") ?? "" } : {}) });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", intuit_tid: `tid-${calls.length}` } });
    if (url.pathname.endsWith("/revoke")) {
      if (state.revoke === "network_error") throw new TypeError("socket hang up");
      if (state.revoke === "server_error") return json(503, { error: "temporarily_unavailable" });
      if (state.revoke === "invalid_grant") return json(400, { error: "invalid_grant" });
      return new Response("", { status: 200, headers: { intuit_tid: `tid-${calls.length}` } });
    }
    if (url.pathname.endsWith("/tokens/bearer")) {
      if (form?.get("grant_type") === "refresh_token") {
        refreshCounter += 1;
        return json(200, { access_token: `access-refreshed-${refreshCounter}`, refresh_token: `refresh-rotated-${refreshCounter}`, expires_in: 3_600, x_refresh_token_expires_in: 86_400 });
      }
      return json(200, { access_token: `access-${form?.get("code")}`, refresh_token: `refresh-${form?.get("code")}`, expires_in: 3_600, x_refresh_token_expires_in: 86_400 });
    }
    if (url.pathname.includes("/companyinfo/") || url.pathname.includes("/CompanyInfo/")) {
      return json(200, { CompanyInfo: { Id: "1", CompanyName: "Sandbox Company_US_1", LegalName: "Sandbox Company", HomeCurrency: { value: "USD" }, MetaData: { LastUpdatedTime: "2026-09-01T00:00:00-07:00" } } });
    }
    if (url.pathname.endsWith("/query")) return json(200, { QueryResponse: {} });
    return json(404, {});
  };
  return { fetchImpl, calls, state };
}

async function startHarness() {
  const intuit = createIntuitDouble();
  const demo = await createCompanyDemoApp({
    accountingQbo: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:4178/api/accounting/qbo/callback",
      environment: "sandbox",
      tokenCipher: createQboTokenCipher(Buffer.alloc(32, 7)),
      transport: { fetchImpl: intuit.fetchImpl },
    },
  });
  const outer = express();
  // Test-only session stand-in; the OAuth flow binds to request.sessionID.
  outer.use((request, _response, next) => { const id = request.get("x-test-session"); if (id) (request as unknown as { sessionID: string }).sessionID = id; next(); });
  outer.use(demo.app);
  const listener = outer.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${organizationId}/accounting/qbo`;
  const headers = (session = SESSION) => ({ "x-test-session": session, "content-type": "application/json", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN });
  const post = (path: string, body: unknown, session = SESSION) => fetch(`${base}${path}`, { method: "POST", headers: headers(session), body: JSON.stringify(body) });
  const begin = async (session = SESSION) => {
    const response = await post("/connect", { legalEntityId }, session);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { authorizationUrl: string };
    const state = new URL(body.authorizationUrl).searchParams.get("state");
    assert.ok(state);
    return state;
  };
  const callback = (query: Record<string, string>, session = SESSION) => fetch(`${origin}/api/accounting/qbo/callback?${new URLSearchParams(query)}`, { headers: { "x-test-session": session }, redirect: "manual" });
  const connect = async (code: string) => {
    const state = await begin();
    const redirected = await callback({ state, code, realmId });
    assert.equal(redirected.status, 303, await redirected.clone().text());
    const location = new URL(redirected.headers.get("location")!, origin);
    assert.equal(location.pathname, "/ops");
    assert.equal(location.searchParams.get("company"), organizationId);
    assert.equal(location.searchParams.get("qboEntity"), legalEntityId);
    const pendingId = location.searchParams.get("qboPending")!;
    const confirmed = await post("/confirm", { legalEntityId, pendingId, confirmRealmBinding: true });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
  };
  const listConnections = async () => {
    const response = await fetch(`${base}/connections?legalEntityId=${legalEntityId}&environment=sandbox`, { headers: { "x-test-session": SESSION } });
    assert.equal(response.status, 200);
    return (await response.json() as { items: unknown[] }).items;
  };
  const qbo = demo.services.accounting.qbo;
  if (qbo.status !== "configured") throw new Error("expected configured QBO services");
  const close = async () => {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await demo.close();
  };
  return { intuit, demo, qbo, origin, base, post, begin, callback, connect, listConnections, close };
}

const tokenExchanges = (calls: readonly { grantType?: string }[]) => calls.filter(call => call.grantType === "authorization_code").length;

test("organization-free callback completes a valid state through the shared confirmation path", async () => {
  const harness = await startHarness();
  try {
    await harness.connect("code-1");
    assert.equal(tokenExchanges(harness.intuit.calls), 1);
    const items = await harness.listConnections() as { scope: { realmId: string; environment: string } }[];
    assert.deepEqual(items.map(item => [item.scope.environment, item.scope.realmId]), [["sandbox", realmId]]);
  } finally {
    await harness.close();
  }
});

test("organization-free callback rejects invalid, expired, and used state without exchanging a code", async () => {
  const harness = await startHarness();
  try {
    const invalid = await harness.callback({ state: "A".repeat(43), code: "code-x", realmId });
    assert.equal(invalid.status, 409);

    const expiredState = await harness.begin();
    await harness.demo.database.db.query("UPDATE accounting_qbo_oauth_states SET expires_at = now() - interval '1 minute'");
    const expired = await harness.callback({ state: expiredState, code: "code-x", realmId });
    assert.equal(expired.status, 409);
    assert.equal(tokenExchanges(harness.intuit.calls), 0);

    const state = await harness.begin();
    const first = await harness.callback({ state, code: "code-1", realmId });
    assert.equal(first.status, 303);
    const replay = await harness.callback({ state, code: "code-1", realmId });
    assert.equal(replay.status, 409);
    assert.equal(tokenExchanges(harness.intuit.calls), 1);
  } finally {
    await harness.close();
  }
});

test("organization-free callback rejects actor and session mismatches", async () => {
  const harness = await startHarness();
  try {
    const otherActor = await harness.qbo.oauthConnection.begin({ actorId: "another-admin", sessionBinding: SESSION, organizationId, legalEntityId, environment: "sandbox" });
    const actorMismatch = await harness.callback({ state: otherActor.state, code: "code-a", realmId });
    assert.equal(actorMismatch.status, 409);

    const state = await harness.begin("initiating-session-1");
    const sessionMismatch = await harness.callback({ state, code: "code-b", realmId }, "different-session-2");
    assert.equal(sessionMismatch.status, 409);
    const missingSession = await fetch(`${harness.origin}/api/accounting/qbo/callback?${new URLSearchParams({ state: await harness.begin(), code: "code-c", realmId })}`, { redirect: "manual" });
    assert.equal(missingSession.status, 409);
    assert.equal(tokenExchanges(harness.intuit.calls), 0);
    assert.deepEqual(await harness.listConnections(), []);
  } finally {
    await harness.close();
  }
});

test("provider access_denied consumes the state and leaves no usable token", async () => {
  const harness = await startHarness();
  try {
    const state = await harness.begin();
    const denied = await harness.callback({ state, error: "access_denied", error_description: "User denied access" });
    assert.equal(denied.status, 503);
    assert.equal(tokenExchanges(harness.intuit.calls), 0);
    const retried = await harness.callback({ state, code: "code-late", realmId });
    assert.equal(retried.status, 409);
    const db = harness.demo.database.db;
    assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM accounting_qbo_connections")).rows[0]!.count, 0);
    assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM accounting_qbo_pending_bindings")).rows[0]!.count, 0);
    await assert.rejects(() => harness.qbo.tokenManager.getAccessToken(scope), /not authorized/);
  } finally {
    await harness.close();
  }
});

test("disconnect revokes the latest refresh token, clears the connection, disables capabilities, audits, and allows reconnect", async () => {
  const harness = await startHarness();
  try {
    await harness.connect("code-1");
    await harness.qbo.createProviderSync(scope).bootstrapRead();
    assert.equal(await harness.qbo.capabilityGate.isEnabled(scope, "accounting.read"), true);
    // Force a refresh so the latest refresh token differs from the original.
    await harness.demo.database.db.query("UPDATE accounting_qbo_connections SET access_token_expires_at = now() - interval '1 hour'");
    await harness.qbo.tokenManager.getAccessToken(scope);

    const missingCsrf = await fetch(`${harness.base}/disconnect`, { method: "POST", headers: { "x-test-session": SESSION, "content-type": "application/json" }, body: JSON.stringify({ legalEntityId, realmId }) });
    assert.equal(missingCsrf.status, 403);

    const disconnected = await harness.post("/disconnect", { legalEntityId, realmId });
    assert.equal(disconnected.status, 200, await disconnected.clone().text());
    const result = await disconnected.json() as { status: string; providerOutcome: string; reconnectRequired: boolean; intuitTid: string | null };
    assert.equal(result.status, "disconnected");
    assert.equal(result.providerOutcome, "revoked");
    assert.equal(result.reconnectRequired, true);
    assert.match(result.intuitTid ?? "", /^tid-/);
    const revokes = harness.intuit.calls.filter(call => call.path.endsWith("/revoke"));
    assert.deepEqual(revokes.map(call => [call.host, call.revokedToken]), [["developer.api.intuit.com", "refresh-rotated-1"]]);
    assert.doesNotMatch(JSON.stringify(result), /refresh-|access-/);

    assert.deepEqual(await harness.listConnections(), []);
    assert.equal(await harness.qbo.capabilityGate.isEnabled(scope, "accounting.read"), false);
    await assert.rejects(() => harness.qbo.tokenManager.getAccessToken(scope), /not authorized/);
    const beforeSync = harness.intuit.calls.length;
    const sync = await harness.post("/sync", { legalEntityId, environment: "sandbox", realmId });
    assert.equal(sync.status, 503);
    assert.equal((await sync.json() as { recovery: string }).recovery, "reconnect");
    assert.equal(harness.intuit.calls.length, beforeSync, "no provider call is made without a connection");
    const db = harness.demo.database.db;
    const credentials = await db.query<{ revoked: boolean; access: unknown; refresh: unknown }>("SELECT revoked_at IS NOT NULL AS revoked, encrypted_access_token AS access, encrypted_refresh_token AS refresh FROM accounting_qbo_connections");
    assert.deepEqual(credentials.rows, [{ revoked: true, access: null, refresh: null }]);
    const audit = await db.query<{ actor_id: string; channel: string; receipt: { state: string; validationOutcomes: { code: string }[] } }>("SELECT actor_id, channel, receipt FROM company_command_receipts WHERE command_kind='accounting.qbo.disconnect'");
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.actor_id, SYNTHETIC_COMPANY.actorId);
    assert.equal(audit.rows[0]!.channel, "web");
    assert.equal(audit.rows[0]!.receipt.state, "saved_in_rops");
    assert.equal(audit.rows[0]!.receipt.validationOutcomes[0]!.code, "accounting.qbo.disconnected");

    const again = await harness.post("/disconnect", { legalEntityId, realmId });
    assert.equal(again.status, 404);

    await harness.connect("code-2");
    const items = await harness.listConnections() as { scope: { realmId: string } }[];
    assert.deepEqual(items.map(item => item.scope.realmId), [realmId]);
    assert.equal(await harness.qbo.tokenManager.getAccessToken(scope), "access-code-2");
    const bootstrap = await harness.qbo.createProviderSync(scope).bootstrapRead();
    assert.equal(bootstrap.providerCompanyId, "1");
  } finally {
    await harness.close();
  }
});

test("failed or uncertain revoke keeps the connection for retry; provider-side disconnect clears it", async () => {
  const harness = await startHarness();
  try {
    await harness.connect("code-1");
    for (const behavior of ["server_error", "network_error"] as const) {
      harness.intuit.state.revoke = behavior;
      const failed = await harness.post("/disconnect", { legalEntityId, realmId });
      assert.equal(failed.status, 503, behavior);
      const body = await failed.json() as { code: string; retryable: boolean; recovery: string };
      assert.equal(body.code, "accounting_disconnect_unconfirmed");
      assert.equal(body.retryable, true);
      assert.equal(body.recovery, "retry_same_operation");
      assert.equal((await harness.listConnections()).length, 1, `${behavior} keeps the connection`);
      assert.equal(await harness.qbo.tokenManager.getAccessToken(scope), "access-code-1");
    }
    const db = harness.demo.database.db;
    const failures = await db.query<{ receipt: { state: string } }>("SELECT receipt FROM company_command_receipts WHERE command_kind='accounting.qbo.disconnect'");
    assert.deepEqual(failures.rows.map(row => row.receipt.state), ["failed", "failed"]);

    // The user already disconnected the app inside QuickBooks: Intuit reports
    // the grant as invalid, so the local connection is cleared.
    harness.intuit.state.revoke = "invalid_grant";
    const cleared = await harness.post("/disconnect", { legalEntityId, realmId });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal((await cleared.json() as { providerOutcome: string }).providerOutcome, "already_revoked");
    assert.deepEqual(await harness.listConnections(), []);
  } finally {
    await harness.close();
  }
});

test("Codex MCP disconnect calls the same scoped command", async () => {
  const harness = await startHarness();
  try {
    await harness.connect("code-1");
    const tools = new Map<string, (args: unknown) => Promise<unknown>>();
    registerAccountingMcpTools((name, _description, _schema, _write, handler) => { tools.set(name, handler); }, { executor: harness.demo.database.executor, services: harness.demo.services.accounting, actorId: SYNTHETIC_COMPANY.actorId });
    const result = await tools.get("disconnect_quickbooks")!({ scope: { provider: "qbo", ...scope } }) as { providerOutcome: string };
    assert.equal(result.providerOutcome, "revoked");
    assert.deepEqual(await harness.listConnections(), []);
    const audit = await harness.demo.database.db.query<{ channel: string }>("SELECT channel FROM company_command_receipts WHERE command_kind='accounting.qbo.disconnect'");
    assert.deepEqual(audit.rows.map(row => row.channel), ["codex_mcp"]);
  } finally {
    await harness.close();
  }
});
