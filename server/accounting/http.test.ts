import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { createCompanyDemoApp, COMPANY_DEMO_CSRF_TOKEN } from "../company/demo";
import { createQboTokenCipher } from "./token-crypto";
import { SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { newOperationId } from "../../shared/company";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "123456",
};

test("Accounting HTTP requires environment and reads named mirrors through the restricted company executor", async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${scope.organizationId}/accounting/qbo`;
  try {
    await fixture.services.accounting.mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "bank-1",
      version: "0",
      providerUpdatedAt: "2026-09-21T12:00:00.000Z",
      providerBody: { Id: "bank-1", Name: "Operating account", AccountType: "Bank", Active: true },
      receivedAt: "2026-09-21T12:00:00.000Z",
    });

    const missingEnvironment = await fetch(`${base}/mirrors?legalEntityId=${scope.legalEntityId}&realmId=${scope.realmId}&kind=accounts`);
    assert.equal(missingEnvironment.status, 400);

    const mirrors = await fetch(`${base}/mirrors?legalEntityId=${scope.legalEntityId}&environment=sandbox&realmId=${scope.realmId}&kind=accounts`);
    assert.equal(mirrors.status, 200, await mirrors.clone().text());
    const payload = await mirrors.json() as { items: Array<{ displayName: string; providerObjectId: string; objectType: string }> };
    assert.deepEqual(payload.items.map(item => [item.displayName, item.providerObjectId, item.objectType]), [["Operating account", "bank-1", "Account"]]);

    const connections = await fetch(`${base}/connections?legalEntityId=${scope.legalEntityId}&environment=sandbox`);
    assert.equal(connections.status, 200, await connections.clone().text());
    assert.deepEqual((await connections.json()).items, []);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});

test("Accounting HTTP maps a reviewed capitalized-cost Account through the shared idempotent command", async () => {
  const fixture = await createCompanyDemoApp();
  const listener = fixture.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${scope.organizationId}/accounting/qbo`;
  try {
    await fixture.database.executor.query(
      `INSERT INTO accounting_qbo_connections
        (organization_id, legal_entity_id, environment, realm_id,
         encrypted_access_token, access_token_iv, access_token_auth_tag,
         encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag,
         access_token_expires_at, status)
       VALUES ($1,$2,'sandbox','123456','access','iv','tag','refresh','iv','tag',now() + interval '1 hour','active')`,
      [scope.organizationId, scope.legalEntityId],
    );
    await fixture.database.executor.query(
      `INSERT INTO accounting_qbo_realm_bindings
        (organization_id, legal_entity_id, environment, realm_id, provider_company_id,
         evidence_version, company_info_hash, confirmed_by)
       VALUES ($1,$2,'sandbox','123456','synthetic-company','v1',$3,'synthetic-admin')`,
      [scope.organizationId, scope.legalEntityId, "f".repeat(64)],
    );
    await fixture.database.executor.query(
      `INSERT INTO accounting_qbo_capabilities
        (organization_id, legal_entity_id, environment, realm_id, capability,
         enabled, evidence, evidence_version, verified_at)
       VALUES ($1,$2,'sandbox','123456','accounting.read',true,'live_provider_readback','v1',now())`,
      [scope.organizationId, scope.legalEntityId],
    );
    await fixture.services.accounting.mirror.ingestSourceObject({
      scope,
      objectType: "Account",
      objectId: "132",
      version: "4",
      providerUpdatedAt: "2026-09-23T19:30:49.000Z",
      providerBody: { Id: "132", SyncToken: "4", Name: "Capital account", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" },
      receivedAt: "2026-09-24T00:00:00.000Z",
    });
    const operationId = newOperationId();
    const save = await fetch(`${base}/purpose-commands/accounting.qbo_purpose.map_capitalized_cost`, { method: "POST", headers: { "content-type": "application/json", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN }, body: JSON.stringify({ operationId, idempotencyKey: `http-purpose:${operationId}`, scope: { organizationId: scope.organizationId, legalEntityId: scope.legalEntityId }, payload: { providerAccountId: "132", accountSourceVersion: "4", environment: "sandbox", realmId: scope.realmId, effectiveFrom: "2026-01-01", reviewEvidence: "Synthetic HTTP review" } }) });
    assert.equal(save.status, 200, await save.clone().text());
    const receipt = await save.json() as { state: string; affectedRecordIds: string[] };
    assert.equal(receipt.state, "saved_in_rops");
    assert.equal(receipt.affectedRecordIds.length, 1);
    const mappings = await fetch(`${base}/purpose-mappings?legalEntityId=${scope.legalEntityId}&environment=sandbox&realmId=${scope.realmId}`);
    assert.equal(mappings.status, 200, await mappings.clone().text());
    assert.equal((await mappings.json() as { items: Array<{ providerAccountId: string; purpose: string; accountSourceVersion: string }> }).items[0]?.providerAccountId, "132");
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});


test("a directly connected OAuth callback redirects to a clean URL and never renders the code-bearing response", async () => {
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/tokens/bearer")) return new Response(JSON.stringify({ access_token: "access-synthetic", refresh_token: "refresh-synthetic", expires_in: 3_600, x_refresh_token_expires_in: 86_400 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  };
  const fixture = await createCompanyDemoApp({
    accountingQbo: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:4178/api/accounting/qbo/callback",
      environment: "sandbox",
      tokenCipher: createQboTokenCipher(Buffer.alloc(32, 7)),
      transport: { fetchImpl },
      // An existing, already-verified binding: the root verifier returns no new proof.
      verifyRealmBinding: async () => undefined,
    },
  });
  const outer = express();
  outer.use((request, _response, next) => { (request as unknown as { sessionID: string }).sessionID = "http-test-session-1"; next(); });
  outer.use(fixture.app);
  const listener = outer.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const begin = await fetch(`${origin}/api/company/${scope.organizationId}/accounting/qbo/connect`, { method: "POST", headers: { "content-type": "application/json", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN }, body: JSON.stringify({ legalEntityId: scope.legalEntityId }) });
    assert.equal(begin.status, 200, await begin.clone().text());
    const state = new URL((await begin.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
    const callback = await fetch(`${origin}/api/accounting/qbo/callback?${new URLSearchParams({ state, code: "one-time-auth-code", realmId: scope.realmId })}`, { redirect: "manual" });
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    const location = new URL(callback.headers.get("location")!, origin);
    assert.equal(location.pathname, "/ops");
    assert.equal(location.searchParams.get("qboConnected"), scope.realmId);
    assert.equal(location.searchParams.get("qboEntity"), scope.legalEntityId);
    assert.doesNotMatch(location.search + (await callback.text()), /one-time-auth-code|access-synthetic|refresh-synthetic/);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});

test("an OAuth callback without an administrator session is redirected to sign-in, never answered with JSON", async () => {
  const fixture = await createCompanyDemoApp({
    accountingQbo: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:4178/api/accounting/qbo/callback",
      environment: "sandbox",
      tokenCipher: createQboTokenCipher(Buffer.alloc(32, 7)),
      transport: { fetchImpl: async () => new Response("{}", { status: 404 }) },
    },
  });
  const outer = express();
  // Production wiring supplies hasAdminSession; emulate a lapsed session here.
  const { registerAccountingHttpRoutes } = await import("./http");
  registerAccountingHttpRoutes(outer, { executor: fixture.database.executor, requireAdmin: (_request, response) => { response.status(401).json({ message: "should not be reached" }); }, services: fixture.services.accounting, hasAdminSession: () => false });
  const listener = outer.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const callback = await fetch(`${origin}/api/accounting/qbo/callback?${new URLSearchParams({ state: "stale-state", code: "one-time-auth-code", realmId: "123456" })}`, { redirect: "manual" });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    const location = new URL(callback.headers.get("location")!, origin);
    assert.equal(location.pathname, "/ops");
    assert.equal(location.searchParams.get("qboError"), "session_expired");
    assert.doesNotMatch(location.search + (await callback.text()), /one-time-auth-code|stale-state/);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});

test("an OAuth callback with an invalid or replayed state lands on the application URL with an error code", async () => {
  const fixture = await createCompanyDemoApp({
    accountingQbo: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:4178/api/accounting/qbo/callback",
      environment: "sandbox",
      tokenCipher: createQboTokenCipher(Buffer.alloc(32, 7)),
      transport: { fetchImpl: async () => new Response("{}", { status: 404 }) },
    },
  });
  const outer = express();
  outer.use((request, _response, next) => { (request as unknown as { sessionID: string }).sessionID = "http-test-session-2"; next(); });
  outer.use(fixture.app);
  const listener = outer.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  try {
    const callback = await fetch(`${origin}/api/accounting/qbo/callback?${new URLSearchParams({ state: "never-issued", code: "one-time-auth-code", realmId: "123456" })}`, { redirect: "manual" });
    assert.equal(callback.status, 303, await callback.clone().text());
    const location = new URL(callback.headers.get("location")!, origin);
    assert.equal(location.pathname, "/ops");
    assert.ok(["accounting_validation", "accounting_conflict"].includes(location.searchParams.get("qboError") ?? ""), location.search);
    assert.doesNotMatch(location.search + (await callback.text()), /one-time-auth-code/);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
