import type { TenantAccessNotifier, TenantAccessDelivery } from "./delivery";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import express from "express";
import session from "express-session";
import type { RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import type { TenantActivationResponse, TenantHome, TenantSessionResponse } from "../../../shared/tenant-portal-contracts";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { registerTenantPortalRoutes } from "./routes";
import { InMemoryTenantAccountStore } from "./test-store";

const initialPassword = "Synthetic tenant password 1!";
const changedPassword = "Synthetic tenant password 2!";
const adminPath = "/api/rent-ops/tenant-accounts";
const tenantPath = "/api/tenant";
const binding = { email: "tenant.one@example.test", personId: "demo-person-1", tenancyId: "demo-tenancy-1" };
const forbiddenKeys = new Set(["passwordHash", "activationTokenHash", "sessionVersion", "password", "source", "sourceRecords", "importRuns", "storageKey", "phone", "activityEvents", "householdMemberships"]);

function assertNoPrivateFields(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(assertNoPrivateFields); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenKeys.has(key), false, `Private field leaked: ${key}`);
    assertNoPrivateFields(child);
  }
}

async function fixture(t: TestContext, source: RentOpsSnapshot = structuredClone(syntheticRentOpsSnapshot()), accessNotifier?: TenantAccessNotifier) {
  const repository = new SyntheticRentOpsRepository(source);
  const store = new InMemoryTenantAccountStore();
  let timestamp = new Date("2026-09-07T16:00:00.000Z");
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "synthetic-integration-test-session-secret", resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" } }));
  // These diagnostic endpoints exist only in this isolated HTTP test server.
  app.post("/test/generic-session", (req, res) => {
    Object.assign(req.session, { userId: 123, rentOpsAdminUserId: 456, rentOpsCsrfToken: "old-admin-token" });
    res.json({ seeded: true });
  });
  app.get("/test/session-markers", (req, res) => {
    const data = req.session as unknown as Record<string, unknown>;
    res.json({ userId: data.userId ?? null, rentOpsAdminUserId: data.rentOpsAdminUserId ?? null,
      rentOpsCsrfToken: data.rentOpsCsrfToken ?? null, hasReqUser: !!req.user, tenantAccountId: data.tenantAccountId ?? null });
  });
  registerTenantPortalRoutes(app, { accessNotifier, repository, accountStore: store, now: () => new Date(timestamp), publicAppUrl: "https://tenant.example.test",
    requireAdmin: (req, res, next) => { if (req.get("x-test-admin") === "authorized-test-admin") next(); else res.status(403).json({ message: "Administrator required." }); } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function client(admin = false) {
    let cookie = "";
    let csrf = "";
    return {
      get cookie() { return cookie; },
      get csrf() { return csrf; },
      async request<T = Record<string, unknown>>(path: string, options: { method?: string; body?: unknown; csrf?: boolean | string; headers?: Record<string, string> } = {}) {
        const response = await fetch(`${url}${path}`, {
          method: options.method ?? "GET",
          headers: { ...(cookie ? { Cookie: cookie } : {}), ...(admin ? { "x-test-admin": "authorized-test-admin" } : {}),
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(options.csrf ? { "x-tenant-csrf": typeof options.csrf === "string" ? options.csrf : csrf } : {}), ...options.headers },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
        const updatedCookie = response.headers.get("set-cookie");
        if (updatedCookie) cookie = updatedCookie.split(";", 1)[0];
        const body = await response.json() as T;
        if (body && typeof body === "object" && "csrfToken" in body && typeof body.csrfToken === "string") csrf = body.csrfToken;
        return { status: response.status, body, headers: response.headers };
      },
    };
  }
  const admin = client(true);
  async function create(input = binding) {
    const result = await admin.request<TenantActivationResponse>(adminPath, { method: "POST", body: input });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return { ...result.body, token: result.body.activationPath.split("#activate=")[1] };
  }
  async function activate(target = client(), input?: Awaited<ReturnType<typeof create>>) {
    const invite = input ?? await create();
    const result = await target.request<TenantSessionResponse>(`${tenantPath}/auth/activate`, { method: "POST", body: { token: invite.token, password: initialPassword } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { target, invite, result };
  }
  return { repository, store, client, admin, create, activate,
    advance(ms: number) { timestamp = new Date(timestamp.getTime() + ms); } };
}

test("admin account creation requires an exact primary tenant grant and does not expose credential material", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client().request(adminPath)).status, 403);
  assert.equal((await f.client().request(adminPath, { method: "POST", body: binding })).status, 403);
  assert.equal((await f.admin.request(adminPath, { method: "POST", body: { ...binding, personId: "demo-person-3" } })).status, 400);
  assert.equal((await f.admin.request(adminPath, { method: "POST", body: { ...binding, tenancyId: "missing-tenancy" } })).status, 400);
  assert.equal((await f.admin.request(adminPath, { method: "POST", body: { ...binding, role: "admin" } })).status, 400);
  const invite = await f.create({ ...binding, email: " Tenant.One@Example.Test " });
  assert.equal(invite.account.email, binding.email);
  assertNoPrivateFields(invite.account);
  const stored = (await f.store.getById(invite.account.id))!;
  assert.equal(stored.passwordHash, null);
  assert.equal(stored.activationTokenHash, createHash("sha256").update(invite.token).digest("hex"));
  assert.notEqual(stored.activationTokenHash, invite.token);
  const list = await f.admin.request(adminPath);
  assert.equal(list.status, 200);
  assertNoPrivateFields(list.body);
  assert.equal(JSON.stringify(list.body).includes(invite.token), false);
  assert.equal((await f.admin.request(adminPath, { method: "POST", body: binding })).status, 409);
  assert.equal((await f.admin.request(adminPath, { method: "POST", body: { ...binding, email: "other@example.test" } })).status, 409);
});

test("ambiguous imported tenancy links cannot receive tenant access", async (t) => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  source.tenancies[0].source = { system: "rm", entityType: "tenancy", sourceId: "synthetic-unverified" };
  const f = await fixture(t, source);
  assert.equal((await f.admin.request(adminPath, { method: "POST", body: binding })).status, 400);
  assert.equal((await f.store.list()).length, 0);
});

test("activation is one use, requires a long password, and rotates an existing generic/admin session", async (t) => {
  const f = await fixture(t);
  const invite = await f.create();
  const tenant = f.client();
  await tenant.request("/test/generic-session", { method: "POST", body: {} });
  const originalCookie = tenant.cookie;
  assert.equal((await tenant.request(`${tenantPath}/auth/session`)).status, 401);
  assert.equal((await tenant.request(`${tenantPath}/auth/activate`, { method: "POST", body: { token: invite.token, password: "short" } })).status, 400);
  const active = await f.activate(tenant, invite);
  assert.notEqual(tenant.cookie, originalCookie);
  assert.match(tenant.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.match(active.result.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(active.result.headers.get("set-cookie")!, /SameSite=Lax/i);
  assertNoPrivateFields(active.result.body);
  assert.deepEqual((await tenant.request("/test/session-markers")).body, {
    userId: null, rentOpsAdminUserId: null, rentOpsCsrfToken: null, hasReqUser: false, tenantAccountId: invite.account.id,
  });
  assert.equal((await tenant.request(adminPath)).status, 403);
  assert.equal((await f.client().request(`${tenantPath}/auth/activate`, { method: "POST", body: { token: invite.token, password: initialPassword } })).status, 400);
  const stored = (await f.store.getById(invite.account.id))!;
  assert.match(stored.passwordHash!, /^scrypt\.v1\./);
  assert.equal(stored.activationTokenHash, null);
  assert.equal(stored.invitationExpiresAt, null);
  assert.equal(stored.status, "active");
});

test("activation expires exactly at its deadline and concurrent requests cannot reuse the token", async (t) => {
  const f = await fixture(t);
  const expired = await f.create();
  f.advance(24 * 60 * 60 * 1000);
  assert.equal((await f.client().request(`${tenantPath}/auth/activate`, { method: "POST", body: { token: expired.token, password: initialPassword } })).status, 400);
  const reissued = await f.admin.request<TenantActivationResponse>(`${adminPath}/${expired.account.id}/reissue`, { method: "POST", body: {} });
  assert.equal(reissued.status, 200);
  const token = reissued.body.activationPath.split("#activate=")[1];
  const results = await Promise.all([f.client(), f.client()].map((target) => target.request(`${tenantPath}/auth/activate`, { method: "POST", body: { token, password: initialPassword } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
});

test("login returns the same failure for unknown addresses, wrong passwords, and pending accounts", async (t) => {
  const f = await fixture(t);
  const invite = await f.create();
  const pending = await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: initialPassword } });
  await f.activate(f.client(), invite);
  const wrong = await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: "Incorrect password!" } });
  const unknown = await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: "unknown@example.test", password: initialPassword } });
  assert.equal(pending.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(pending.body, wrong.body);
  assert.deepEqual(wrong.body, unknown.body);
  const tenant = f.client();
  const loggedIn = await tenant.request<TenantSessionResponse>(`${tenantPath}/auth/login`, { method: "POST", body: { email: "TENANT.ONE@EXAMPLE.TEST", password: initialPassword } });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.account.tenancyId, binding.tenancyId);
  assertNoPrivateFields(loggedIn.body);
  assert.equal((await tenant.request(adminPath)).status, 403);
});

test("tenant routes reject API credentials, cross-origin requests, and unauthenticated account access", async (t) => {
  const f = await fixture(t);
  const { target } = await f.activate();
  assert.equal((await f.client().request(`${tenantPath}/home`)).status, 401);
  assert.equal((await target.request(`${tenantPath}/home`, { headers: { "x-api-key": "synthetic-key" } })).status, 401);
  assert.equal((await target.request(`${tenantPath}/home`, { headers: { Authorization: "Bearer synthetic" } })).status, 401);
  const loginBody = { email: binding.email, password: initialPassword };
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: loginBody, headers: { Origin: "https://attacker.example.test" } })).status, 403);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: loginBody, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: loginBody, headers: { Origin: "https://tenant.example.test" } })).status, 200);
});

test("tenant mutations require session CSRF and logout destroys the session", async (t) => {
  const f = await fixture(t);
  const { target } = await f.activate();
  const passwordBody = { currentPassword: initialPassword, newPassword: changedPassword };
  assert.equal((await target.request(`${tenantPath}/auth/password`, { method: "POST", body: passwordBody })).status, 403);
  assert.equal((await target.request(`${tenantPath}/auth/password`, { method: "POST", body: passwordBody, csrf: "wrong-token" })).status, 403);
  assert.equal((await target.request(`${tenantPath}/auth/logout`, { method: "POST", body: {} })).status, 403);
  assert.equal((await target.request(`${tenantPath}/auth/session`)).status, 200);
  assert.equal((await target.request(`${tenantPath}/auth/logout`, { method: "POST", body: {}, csrf: true })).status, 200);
  assert.equal((await target.request(`${tenantPath}/auth/session`)).status, 401);
  assert.equal((await target.request(`${tenantPath}/home`)).status, 401);
});

test("revoke immediately invalidates all tenant sessions and credentials", async (t) => {
  const f = await fixture(t);
  const { target, invite } = await f.activate();
  const second = f.client();
  assert.equal((await second.request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: initialPassword } })).status, 200);
  const revoked = await f.admin.request(`${adminPath}/${invite.account.id}/revoke`, { method: "POST", body: {} });
  assert.equal(revoked.status, 200);
  assertNoPrivateFields(revoked.body);
  assert.equal((await target.request(`${tenantPath}/home`)).status, 401);
  assert.equal((await second.request(`${tenantPath}/auth/session`)).status, 401);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: initialPassword } })).status, 401);
  assert.equal((await f.store.getById(invite.account.id))?.passwordHash, null);
});

test("reissued links invalidate prior pending links and existing sessions", async (t) => {
  const f = await fixture(t);
  const original = await f.create();
  const reissued = await f.admin.request<TenantActivationResponse>(`${adminPath}/${original.account.id}/reissue`, { method: "POST", body: {} });
  assert.equal(reissued.status, 200);
  assert.equal((await f.client().request(`${tenantPath}/auth/activate`, { method: "POST", body: { token: original.token, password: initialPassword } })).status, 400);
  const token = reissued.body.activationPath.split("#activate=")[1];
  const { target } = await f.activate(f.client(), { ...reissued.body, token });
  const secondIssue = await f.admin.request<TenantActivationResponse>(`${adminPath}/${original.account.id}/reissue`, { method: "POST", body: {} });
  assert.equal(secondIssue.status, 200);
  assert.equal((await target.request(`${tenantPath}/auth/session`)).status, 401);
  assert.equal((await f.client().request(`${tenantPath}/auth/activate`, { method: "POST", body: { token, password: initialPassword } })).status, 400);
  assert.equal((await f.client().request(`${tenantPath}/auth/activate`, { method: "POST", body: { token: secondIssue.body.activationPath.split("#activate=")[1], password: changedPassword } })).status, 200);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: initialPassword } })).status, 401);
});

test("password change rotates the current session and invalidates other sessions and old credentials", async (t) => {
  const f = await fixture(t);
  const { target } = await f.activate();
  const second = f.client();
  await second.request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: initialPassword } });
  const oldCookie = target.cookie;
  const oldCsrf = target.csrf;
  assert.equal((await target.request(`${tenantPath}/auth/password`, { method: "POST", body: { currentPassword: "Incorrect password!", newPassword: changedPassword }, csrf: true })).status, 400);
  const changed = await target.request(`${tenantPath}/auth/password`, { method: "POST", body: { currentPassword: initialPassword, newPassword: changedPassword }, csrf: true });
  assert.equal(changed.status, 200);
  assertNoPrivateFields(changed.body);
  assert.notEqual(target.cookie, oldCookie);
  assert.notEqual(target.csrf, oldCsrf);
  assert.equal((await target.request(`${tenantPath}/auth/session`)).status, 200);
  assert.equal((await second.request(`${tenantPath}/auth/session`)).status, 401);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: initialPassword } })).status, 401);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: changedPassword } })).status, 200);
  assert.equal((await target.request(`${tenantPath}/auth/logout`, { method: "POST", body: {}, csrf: oldCsrf })).status, 403);
});

test("tenant home ignores attempted person and tenancy overrides and omits other residents and private metadata", async (t) => {
  const f = await fixture(t);
  const { target } = await f.activate();
  const result = await target.request<TenantHome>(`${tenantPath}/home?tenancyId=demo-tenancy-3&personId=demo-person-3`);
  assert.equal(result.status, 200);
  assert.equal(result.body.tenancy.id, binding.tenancyId);
  assert.equal(result.body.account.personId, binding.personId);
  assert.deepEqual(result.body.resident, { firstName: "Tenant", lastName: "One" });
  assert.equal(result.body.ledger.some((row) => row.id === "demo-charge-rent-3" || row.id === "demo-payment-3"), false);
  assert.deepEqual(result.body.leases.map((row) => row.id), ["demo-term-1"]);
  assertNoPrivateFields(result.body);
  const serialized = JSON.stringify(result.body);
  for (const canary of ["tenant.three@example.test", "+1-555-0101", "demo-activity-1", "demo-person-3", "demo-tenancy-3", "demo-property-b"]) assert.equal(serialized.includes(canary), false, canary);
  assert.equal(result.headers.get("cache-control"), "no-store");
});

test("a changed source binding blocks an already authenticated tenant on the next request", async (t) => {
  const f = await fixture(t);
  const { target } = await f.activate();
  const snapshot = await f.repository.getSnapshot();
  await f.repository.savePerson({ ...snapshot.people.find((person) => person.id === binding.personId)!, archived: true });
  assert.equal((await target.request(`${tenantPath}/home`)).status, 403);
  assert.equal((await target.request(`${tenantPath}/auth/session`)).status, 403);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: binding.email, password: initialPassword } })).status, 401);
});

test("recovery gives the same truthful response for known and unknown addresses without issuing links", async (t) => {
  const f = await fixture(t);
  const invite = await f.create();
  const before = await f.store.getById(invite.account.id);
  const known = await f.client().request(`${tenantPath}/auth/recovery`, { method: "POST", body: { email: binding.email } });
  const unknown = await f.client().request(`${tenantPath}/auth/recovery`, { method: "POST", body: { email: "unknown@example.test" } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.body, unknown.body);
  assert.match(String(known.body.message), /Contact management/);
  assert.deepEqual(await f.store.getById(invite.account.id), before);
  assert.equal((await f.store.list()).length, 1);
});

test("public recovery and login rate limits are shared across clients and reset after their window", async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await f.client().request(`${tenantPath}/auth/recovery`, { method: "POST", body: { email: `unknown${attempt}@example.test` } })).status, 200);
  }
  assert.equal((await f.client().request(`${tenantPath}/auth/recovery`, { method: "POST", body: { email: "unknown@example.test" } })).status, 429);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: "unknown@example.test", password: initialPassword } })).status, 401);
  }
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: "UNKNOWN@EXAMPLE.TEST", password: initialPassword } })).status, 429);
  assert.equal(Array.from(f.store.limits.keys()).every((key) => /^[a-f0-9]{64}$/.test(key)), true);
  f.advance(15 * 60 * 1000);
  assert.equal((await f.client().request(`${tenantPath}/auth/recovery`, { method: "POST", body: { email: "unknown@example.test" } })).status, 200);
  assert.equal((await f.client().request(`${tenantPath}/auth/login`, { method: "POST", body: { email: "unknown@example.test", password: initialPassword } })).status, 401);
});


test("configured reset is nonenumerating, preserves access until use, and rejects replay", async t => {
  const deliveries: TenantAccessDelivery[] = [];
  let fail = false;
  const f = await fixture(t, undefined, async input => { deliveries.push(input); if (fail) throw new Error("synthetic timeout"); });
  const {target,invite} = await f.activate();
  const before = (await f.store.getById(invite.account.id))!;
  const known = await f.client().request(`${tenantPath}/auth/recovery`, {method:"POST",body:{email:binding.email}});
  const unknown = await f.client().request(`${tenantPath}/auth/recovery`, {method:"POST",body:{email:"unknown@example.test"}});
  assert.deepEqual(known.body,unknown.body);
  assert.equal(deliveries.length,1);
  assert.equal((await f.store.getById(invite.account.id))!.sessionVersion,before.sessionVersion);
  assert.equal((await target.request(`${tenantPath}/auth/session`)).status,200);
  const reset = await f.client().request(`${tenantPath}/auth/activate`,{method:"POST",body:{token:deliveries[0].token,password:changedPassword}});
  assert.equal(reset.status,200);
  assert.equal((await target.request(`${tenantPath}/auth/session`)).status,401);
  assert.equal((await f.client().request(`${tenantPath}/auth/activate`,{method:"POST",body:{token:deliveries[0].token,password:initialPassword}})).status,400);
  fail=true;
  const failed=await f.client().request(`${tenantPath}/auth/recovery`,{method:"POST",body:{email:binding.email}});
  assert.deepEqual(failed.body,unknown.body);
  assert.equal((await f.store.getById(invite.account.id))!.activationTokenHash,null);
  assert.equal((await f.admin.request(`${adminPath}/${invite.account.id}/send-link`,{method:"POST",body:{}})).status,503);
  fail=false;
  const sent=await f.admin.request(`${adminPath}/${invite.account.id}/send-link`,{method:"POST",body:{}});
  assert.equal(sent.status,200); assert.equal(sent.body.delivery,"accepted");
});
