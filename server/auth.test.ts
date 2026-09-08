import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// auth.ts imports the database singleton, but these tests never query it.
process.env.DATABASE_URL ??= "postgresql://synthetic:synthetic@localhost/synthetic";
const auth = await import("./auth");

test("Rent Ops CSRF tokens are opaque and checked with the dedicated header", () => {
  const token = auth.createRentOpsCsrfToken();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  const request = {
    session: { rentOpsCsrfToken: token },
    get(name: string) { return name.toLowerCase() === "x-rent-ops-csrf" ? token : undefined; },
  } as never;
  assert.equal(auth.rentOpsSessionHasCsrf(request), true);
  const wrongHeader = { ...request, get: () => `${token}x` } as never;
  assert.equal(auth.rentOpsSessionHasCsrf(wrongHeader), false);
});

test("Rent Ops admin middleware rejects generic sessions and every API-key path", async () => {
  const responses: Array<{ status: number; body: unknown }> = [];
  const res = {
    status(code: number) { return { json(body: unknown) { responses.push({ status: code, body }); } }; },
  } as never;
  const nextCalls: unknown[] = [];
  await auth.requireRentOpsAdmin({ session: { userId: "investor-session" }, headers: {} } as never, res, () => nextCalls.push(true));
  await auth.requireRentOpsAdmin({ session: { rentOpsAdminUserId: "admin-session" }, headers: { "x-api-key": "legacy" } } as never, res, () => nextCalls.push(true));
  assert.equal(nextCalls.length, 0);
  assert.deepEqual(responses.map((value) => value.status), [401, 401]);
});

test("Rent Ops auth boundary names dedicated session, CSRF, and legacy-key rejection", () => {
  const source = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "auth.ts"), "utf8");
  assert.match(source, /rentOpsAdminUserId/);
  assert.match(source, /rentOpsCsrfToken/);
  assert.match(source, /x-rent-ops-csrf/);
  assert.match(source, /\/api\/rent-ops\/auth\/session/);
  assert.match(source, /userWithoutPassword/);
  assert.match(source, /extractApiKey\(req\).*rentOpsAdminUserId/);
  assert.doesNotMatch(source, /requireRentOpsAdmin[\s\S]{0,500}hasValidApiKey/);
});

test("host login limiter bounds account attempts across IPs and expires", () => {
  let now = 0;
  const limit = auth.createLoginAttemptLimiter(() => now);
  for (let i = 0; i < 10; i++) assert.equal(limit(`ip-${i}`, "resident@example.test"), 0);
  assert.equal(limit("new-ip", "resident@example.test"), 900);
  now = 900001;
  assert.equal(limit("new-ip", "resident@example.test"), 0);
  for (let i = 0; i < 30; i++) assert.equal(limit("one-ip", `account-${i}`), 0);
  assert.equal(limit("one-ip", "new-account"), 900);
});

test("OAuth manager session rejects a removed subject allowlist before loading the host user", async () => {
  const prior = process.env.RENT_OPS_OAUTH_ADMIN_SUBJECTS;
  process.env.RENT_OPS_OAUTH_ADMIN_SUBJECTS = "";
  let status = 0;
  try {
    await auth.requireRentOpsAdmin({ session: { rentOpsAdminUserId: "admin", rentOpsOAuthSubject: "google-oauth2|118183229923455274061" }, headers: {} } as never,
      { status(code: number) { status = code; return { json() {} }; } } as never, () => assert.fail("revoked subject reached route"));
    assert.equal(status, 403);
  } finally { if (prior === undefined) delete process.env.RENT_OPS_OAUTH_ADMIN_SUBJECTS; else process.env.RENT_OPS_OAUTH_ADMIN_SUBJECTS = prior; }
});
