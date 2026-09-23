import assert from "node:assert/strict";
import test from "node:test";
import { endWebsiteSession, signInWebsite } from "./auth-context";

const investor = { id: "u1", email: "investor@example.test", role: "investor" as const, firstName: "Ivy", lastName: "Investor", createdAt: "2026-01-01T00:00:00.000Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("website sign-out forgets cached account data even when the server is unreachable", async () => {
  let forgotten = 0;
  await endWebsiteSession(async () => { throw new TypeError("offline"); }, async () => { forgotten++; });
  assert.equal(forgotten, 1);
  const calls: string[] = [];
  await endWebsiteSession(async (url, init) => { calls.push(`${init.method} ${url}`); return json({}); }, async () => { forgotten++; });
  assert.deepEqual(calls, ["POST /api/auth/logout"]);
  assert.equal(forgotten, 2);
});

test("website sign-in returns the account, so the redirect needs no second request", async () => {
  const calls: string[] = [];
  const result = await signInWebsite("investor@example.test", "pw", async (url) => { calls.push(url); return json({ user: investor }); });
  assert.deepEqual(result, { success: true, user: investor });
  assert.deepEqual(calls, ["/api/auth/login"]);
});

test("website sign-in failures return a message instead of rejecting", async () => {
  assert.deepEqual(await signInWebsite("a@example.test", "bad", async () => json({ message: "Invalid email or password" }, 401)), { success: false, error: "Invalid email or password" });
  assert.deepEqual(await signInWebsite("a@example.test", "pw", async () => new Response("<html>", { status: 502 })), { success: false, error: "Login service unavailable" });
  assert.deepEqual(await signInWebsite("a@example.test", "pw", async () => { throw new TypeError("offline"); }), { success: false, error: "Login service unavailable" });
});
