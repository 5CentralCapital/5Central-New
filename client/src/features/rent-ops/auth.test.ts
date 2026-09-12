import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RENT_OPS_AUTH_ROUTES, RentOpsAuthClient } from "./auth";

const user = { id: "user:admin", email: "operator@example.com", role: "admin", firstName: "Rent", lastName: "Operator" };
const csrfToken = "csrf-token-that-is-long-enough-for-the-browser-contract-123456";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("dedicated browser flow restores only the Rent Ops session and fetches CSRF in memory", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new RentOpsAuthClient({
    fetchImpl: async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === RENT_OPS_AUTH_ROUTES.session) return response({ user, csrfToken });
      if (path === RENT_OPS_AUTH_ROUTES.csrf) return response({ csrfToken });
      if (path === "/api/rent-ops/properties") return response({ ok: true });
      throw new Error(`unexpected route ${path}`);
    },
  });

  assert.equal(await client.restore(), true);
  assert.equal(client.getSnapshot().user?.email, user.email);
  assert.deepEqual(calls.map((call) => call.path), [RENT_OPS_AUTH_ROUTES.session, RENT_OPS_AUTH_ROUTES.csrf]);

  const mutation = await client.request("/api/rent-ops/properties", { method: "POST", body: "{}" });
  assert.equal(mutation.ok, true);
  const mutationHeaders = new Headers(calls[2]?.init?.headers);
  assert.equal(mutationHeaders.get("x-rent-ops-csrf"), csrfToken);
  assert.equal(calls[2]?.init?.credentials, "include");
  assert.equal(mutationHeaders.get("x-api-key"), null);
  assert.equal(mutationHeaders.get("authorization"), null);
});

test("dedicated login posts credentials only to the dedicated route and then fetches CSRF", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new RentOpsAuthClient({
    fetchImpl: async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === RENT_OPS_AUTH_ROUTES.login) return response({ user, csrfToken });
      if (path === RENT_OPS_AUTH_ROUTES.csrf) return response({ csrfToken });
      throw new Error(`unexpected route ${path}`);
    },
  });
  const loggedIn = await client.login(user.email, "one-time-password");
  assert.equal(loggedIn.email, user.email);
  assert.deepEqual(calls.map((call) => call.path), [RENT_OPS_AUTH_ROUTES.login, RENT_OPS_AUTH_ROUTES.csrf]);
  const loginHeaders = new Headers(calls[0]?.init?.headers);
  assert.equal(loginHeaders.get("x-api-key"), null);
  assert.equal(loginHeaders.get("authorization"), null);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { email: user.email, password: "one-time-password" });
  assert.equal(client.getSnapshot().status, "authenticated");
});

test("every mutating method receives the dedicated CSRF header and 401 expires the session", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new RentOpsAuthClient({
    fetchImpl: async (input, init) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === RENT_OPS_AUTH_ROUTES.session) return response({ user, csrfToken });
      if (path === RENT_OPS_AUTH_ROUTES.csrf) return response({ csrfToken });
      if (path === "/api/rent-ops/unauthorized") return response({ message: "expired" }, 401);
      return response({ ok: true });
    },
  });
  await client.restore();

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await client.request(`/api/rent-ops/${method.toLowerCase()}`, { method });
    const headers = new Headers(calls.at(-1)?.init?.headers);
    assert.equal(headers.get("x-rent-ops-csrf"), csrfToken, method);
  }
  await assert.rejects(client.request("/api/rent-ops/unauthorized"), /session has ended/);
  assert.equal(client.getSnapshot().status, "unauthenticated");
});

test("client auth has no generic host-auth or browser credential persistence fallback", () => {
  const source = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "auth.ts"), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage|IndexedDB|x-api-key|Authorization/);
  assert.match(source, /credentials:\s*["']include["']/);
  assert.match(source, /x-rent-ops-csrf/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const status of [200, 401, 403]) {
  test(`a previous session's delayed ${status} response cannot affect the new session`, async () => {
    const old = deferred<Response>();
    let nextUser = user;
    const client = new RentOpsAuthClient({ fetchImpl: async (input) => {
      if (String(input).endsWith('/old-profile')) return old.promise;
      return response({ user: nextUser, csrfToken });
    } });
    await client.login(user.email, 'synthetic');
    const pending = client.request('/api/rent-ops/old-profile');
    const rejected = assert.rejects(pending, /earlier Rent Operations session/);
    await client.logout();
    nextUser = { ...user, id: 'user:second' };
    await client.login(nextUser.email, 'synthetic');
    old.resolve(response({ privateRecord: 'first session' }, status));
    await rejected;
    assert.equal(client.getSnapshot().status, 'authenticated');
    assert.equal(client.getSnapshot().user?.id, 'user:second');
  });
}

test('a delayed logout response cannot clear a later login', async () => {
  const old = deferred<Response>();
  const entered = deferred<void>();
  const client = new RentOpsAuthClient({ fetchImpl: async (input) => {
    if (String(input) === RENT_OPS_AUTH_ROUTES.logout) { entered.resolve(); return old.promise; }
    return response({ user, csrfToken });
  } });
  await client.login(user.email, 'synthetic');
  const logout = client.logout();
  await entered.promise;
  await client.login(user.email, 'synthetic');
  old.resolve(response({ ok: true }));
  await logout;
  assert.equal(client.getSnapshot().status, 'authenticated');
});

test('a delayed restore response cannot restore a session after logout', async () => {
  const old = deferred<Response>();
  const client = new RentOpsAuthClient({ fetchImpl: async () => old.promise });
  const restore = client.restore();
  const rejected = assert.rejects(restore, /earlier Rent Operations session/);
  await client.logout();
  old.resolve(response({ user, csrfToken }));
  await rejected;
  assert.equal(client.getSnapshot().status, 'unauthenticated');
});

test('a superseded CSRF fetch cannot replace the later login token', async () => {
  const old = deferred<Response>();
  const entered = deferred<void>();
  let csrfCalls = 0;
  let mutationToken: string | null = null;
  const newToken = 'new-session-csrf-token-'.repeat(3);
  const client = new RentOpsAuthClient({ fetchImpl: async (input, init) => {
    if (String(input) === RENT_OPS_AUTH_ROUTES.csrf) {
      if (++csrfCalls === 1) { entered.resolve(); return old.promise; }
      return response({ csrfToken: newToken });
    }
    if (String(input).endsWith('/properties')) mutationToken = new Headers(init?.headers).get('x-rent-ops-csrf');
    return response({ user, csrfToken });
  } });
  const first = client.login(user.email, 'synthetic');
  const rejected = assert.rejects(first, /earlier Rent Operations session/);
  await entered.promise;
  await client.login(user.email, 'synthetic');
  old.resolve(response({ csrfToken }));
  await rejected;
  await client.request('/api/rent-ops/properties', { method: 'POST' });
  assert.equal(mutationToken, newToken);
  assert.equal(client.getSnapshot().status, 'authenticated');
});
