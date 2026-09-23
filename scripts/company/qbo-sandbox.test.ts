import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { QboProviderSyncResult } from "../../server/accounting/provider-sync";
import { createQboSandboxHarness, qboProviderSyncAcceptance, sandboxEnvironmentProblems } from "./qbo-sandbox";

const env = {
  QBO_CLIENT_ID: "sandbox-client-id",
  QBO_CLIENT_SECRET: "sandbox-client-secret",
  QBO_REDIRECT_URI: "http://localhost:4178/api/accounting/qbo/callback",
  QBO_ENVIRONMENT: "sandbox",
} as NodeJS.ProcessEnv;

test("sandbox provider sync acceptance requires complete coverage for every stream", () => {
  const stream = {
    stream: "transactions.purchase",
    result: { status: "complete", checkpoint: null, pagesFetched: 1, itemsApplied: 2 },
    unsupportedCount: 0,
    coverageStatus: "complete",
  } as const;
  const complete: QboProviderSyncResult = { status: "complete", streams: [stream] };
  assert.deepEqual(qboProviderSyncAcceptance(complete), {
    pass: true,
    notes: ["status=complete", "transactions.purchase: complete, coverage=complete, unsupported=0"],
  });

  const partialCoverage: QboProviderSyncResult = {
    status: "partial",
    streams: [{ ...stream, unsupportedCount: 10, coverageStatus: "partial" }],
  };
  const partial = qboProviderSyncAcceptance(partialCoverage);
  assert.equal(partial.pass, false);
  assert.deepEqual(partial.notes, ["status=partial", "transactions.purchase: complete, coverage=partial, unsupported=10"]);

  const failedStream: QboProviderSyncResult = {
    status: "partial",
    streams: [{ ...stream, result: { ...stream.result, status: "failed" }, coverageStatus: "partial" }],
  };
  const failed = qboProviderSyncAcceptance(failedStream);
  assert.equal(failed.pass, false);
  assert.deepEqual(failed.notes, ["status=partial", "transactions.purchase: failed, coverage=partial, unsupported=0"]);
});

/** Offline sandbox double with Vendor create/read/sparse-update/stale semantics. */
function sandboxDouble() {
  let tid = 0;
  let refreshes = 0;
  const vendors = new Map<string, Record<string, unknown>>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", intuit_tid: `tid-${++tid}` } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/tokens/bearer")) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") { refreshes += 1; return json(200, { access_token: `access-r${refreshes}`, refresh_token: `refresh-r${refreshes}`, expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }); }
      return json(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 });
    }
    if (url.pathname.endsWith("/revoke")) return new Response("", { status: 200, headers: { intuit_tid: `tid-${++tid}` } });
    assert.equal(url.host, "sandbox-quickbooks.api.intuit.com");
    const [, , , , entity, id] = url.pathname.split("/");
    if (entity === "companyinfo") return json(200, { CompanyInfo: { Id: "1", CompanyName: "Sandbox Company_US_1", HomeCurrency: { value: "USD" }, MetaData: { LastUpdatedTime: "2026-09-01T00:00:00-07:00" } } });
    if (entity === "query") return json(200, { QueryResponse: {} });
    if (entity === "vendor" && method === "GET") return vendors.has(id!) ? json(200, { Vendor: vendors.get(id!) }) : json(400, { Fault: { Error: [{ code: "610" }] } });
    if (entity === "vendor" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!body.Id) { const created = { Id: String(vendors.size + 50), SyncToken: "0", DisplayName: body.DisplayName }; vendors.set(created.Id, created); return json(200, { Vendor: created }); }
      const current = vendors.get(String(body.Id))!;
      if (body.SyncToken !== current.SyncToken) return json(400, { Fault: { Error: [{ code: "5010" }], type: "ValidationFault" } });
      const { sparse: _sparse, ...fields } = body;
      const updated = { ...current, ...fields, SyncToken: String(Number(current.SyncToken) + 1) };
      vendors.set(String(body.Id), updated);
      return json(200, { Vendor: updated });
    }
    return json(404, {});
  };
  return { fetchImpl };
}

test("sandbox harness refuses non-sandbox or incomplete configuration", async () => {
  assert.deepEqual(sandboxEnvironmentProblems(env), []);
  assert.match(sandboxEnvironmentProblems({ ...env, QBO_ENVIRONMENT: "production" }).join(";"), /must be exactly "sandbox"/);
  assert.match(sandboxEnvironmentProblems({ ...env, QBO_CLIENT_SECRET: "" }).join(";"), /QBO_CLIENT_SECRET is required/);
  await assert.rejects(() => createQboSandboxHarness({ env: { ...env, QBO_ENVIRONMENT: "production" } }), /refused to start/);
});

test("sandbox harness connects through replay, runs acceptance, and writes sanitized evidence", async () => {
  const evidenceDir = await mkdtemp(path.join(tmpdir(), "qbo-sandbox-"));
  const harness = await createQboSandboxHarness({ env, fetchImpl: sandboxDouble().fetchImpl, evidenceDir });
  const listener = harness.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (pathname: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${pathname}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.body ? { "content-type": "application/json" } : {}) } });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    return response;
  };
  try {
    const status = await (await call("/__sandbox/status")).json() as { environment: string; connections: unknown[] };
    assert.equal(status.environment, "sandbox");
    assert.deepEqual(status.connections, []);
    const connect = await (await call("/__sandbox/connect-url", { method: "POST" })).json() as { authorizationUrl: string };
    const authorize = new URL(connect.authorizationUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, "https://appcenter.intuit.com/connect/oauth2");
    assert.equal(authorize.searchParams.get("redirect_uri"), env.QBO_REDIRECT_URI);
    assert.equal(authorize.searchParams.get("scope"), "com.intuit.quickbooks.accounting");
    const state = authorize.searchParams.get("state")!;

    // The browser that completed Intuit login was elsewhere; replay its URL.
    const redirected = `http://localhost:4178/api/accounting/qbo/callback?code=sandbox-code&state=${state}&realmId=9130350000000001`;
    const replay = await call(`/__sandbox/replay?${new URLSearchParams({ url: redirected })}`);
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await replay.json() as { status: string }).status, "pending_confirmation");
    const confirm = await call("/__sandbox/confirm", { method: "POST", body: "{}" });
    assert.equal(confirm.status, 200, await confirm.clone().text());

    const acceptance = await call("/__sandbox/acceptance", { method: "POST", body: "{}" });
    const text = await acceptance.clone().text();
    assert.equal(acceptance.status, 200, text);
    const evidence = await acceptance.json() as { evidenceFile: string; summary: { failed: number; total: number }; steps: { name: string; pass: boolean; notes: string[] }[] };
    assert.equal(evidence.summary.failed, 0, JSON.stringify(evidence.steps.filter(item => !item.pass), null, 2));
    assert.deepEqual(evidence.steps.map(item => item.name), [
      "companyinfo_read_bootstrap", "provider_sync_catch_up", "accounting_query", "enable_write_capabilities_sandbox_only",
      "create_and_read_back", "update_with_synctoken_and_read_back", "stale_synctoken_update_rejected_without_retry",
      "forced_refresh_rotation", "disconnect_via_route", "post_disconnect_requires_reconnect",
    ]);
    const written = await readFile(evidence.evidenceFile, "utf8");
    assert.doesNotMatch(written, /access-1|refresh-1|access-r1|refresh-r1|sandbox-client-secret|sandbox-code/);
    assert.doesNotMatch(text, /refresh-r1|access-r1|sandbox-client-secret/);
    assert.equal(JSON.parse(await readFile(path.join(evidenceDir, "latest.json"), "utf8")).summary.failed, 0);
    const after = await (await call("/__sandbox/status")).json() as { connections: unknown[] };
    assert.deepEqual(after.connections, []);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await harness.close();
    await rm(evidenceDir, { recursive: true, force: true });
  }
});
