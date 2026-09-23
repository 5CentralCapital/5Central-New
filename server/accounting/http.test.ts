import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { createCompanyDemoApp, COMPANY_DEMO_CSRF_TOKEN } from "../company/demo";
import { createQboTokenCipher } from "./token-crypto";
import { SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

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
