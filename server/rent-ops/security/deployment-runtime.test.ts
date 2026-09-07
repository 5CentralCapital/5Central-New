import assert from "node:assert/strict";
import test from "node:test";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type { Request, RequestHandler, Response } from "express";
import {
  RENT_OPS_EDGE_ATTESTATION_HEADER,
  createRentOpsPublicRateLimiter,
  signRentOpsEdgeAttestation,
  verifyRentOpsEdgeAttestation,
} from "./deployment-runtime";

function request(method = "POST", path = "/applications/start") {
  return {
    method,
    path,
    originalUrl: path,
    get(name: string) { return name.toLowerCase() === RENT_OPS_EDGE_ATTESTATION_HEADER ? undefined : undefined; },
  } as never;
}

test("edge attestation signs the request method/path and expires", () => {
  const now = 1_700_000_000_000;
  const secret = "edge-secret";
  const req = request();
  const token = signRentOpsEdgeAttestation({ secret, timestampSeconds: now / 1000, method: "POST", path: "/applications/start" });
  assert.equal(verifyRentOpsEdgeAttestation(req, token, { secret, now: () => now }), true);
  assert.equal(verifyRentOpsEdgeAttestation({ ...req, method: "GET" } as never, token, { secret, now: () => now }), false);
  assert.equal(verifyRentOpsEdgeAttestation(req, token, { secret, now: () => now + 91_000 }), false);
});

test("public applicant middleware fails closed without a valid shared attestation", () => {
  const middleware = createRentOpsPublicRateLimiter({ secret: "edge-secret", enforce: true, now: () => 1_700_000_000_000 });
  const statuses: number[] = [];
  const response = { status(code: number) { statuses.push(code); return { json() {} }; } } as never;
  let nextCalls = 0;
  middleware(request(), response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 0);
  assert.deepEqual(statuses, [403]);
});

test("public applicant middleware accepts only the signed request", () => {
  const now = 1_700_000_000_000;
  const token = signRentOpsEdgeAttestation({ secret: "edge-secret", timestampSeconds: now / 1000, method: "POST", path: "/applications/start" });
  const req = request();
  req.get = (name: string) => name.toLowerCase() === RENT_OPS_EDGE_ATTESTATION_HEADER ? token : undefined;
  const middleware = createRentOpsPublicRateLimiter({ secret: "edge-secret", enforce: true, now: () => now });
  let nextCalls = 0;
  middleware(req, {} as never, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});

const databaseEnv = {
  NODE_ENV: "production",
  RENT_OPS_PUBLIC_LIMITER_MODE: "database",
  RENT_OPS_SESSION_SECRET: "synthetic-test-secret-at-least-32-characters",
};

async function invoke(middleware: RequestHandler, method = "POST", path = "/applications/start", ip = "192.0.2.1") {
  const state = { status: 200, body: undefined as unknown, headers: {} as Record<string, string>, nextCalls: 0 };
  const req = { method, path, ip, originalUrl: `/api/rent-ops/public${path}`, get() { return "untrusted-forwarded-value"; } } as unknown as Request;
  const res = {
    set(name: string, value: string) { state.headers[name] = value; return this; },
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  } as unknown as Response;
  await middleware(req, res, () => { state.nextCalls += 1; });
  return state;
}

test("database mode requires its runtime executor and hashing secret without requiring an edge secret", () => {
  assert.throws(() => createRentOpsPublicRateLimiter({ env: databaseEnv }), /configuration_required/);
  const executor = { async query() { return { rows: [] }; } } as RentOpsQueryExecutor;
  assert.throws(() => createRentOpsPublicRateLimiter({ env: { ...databaseEnv, RENT_OPS_SESSION_SECRET: "short" }, executor }), /configuration_required/);
  assert.throws(() => createRentOpsPublicRateLimiter({ env: { ...databaseEnv, RENT_OPS_PUBLIC_LIMITER_MODE: "memory" }, executor }), /mode_invalid/);
  assert.doesNotThrow(() => createRentOpsPublicRateLimiter({ env: databaseEnv, executor }));
});

test("database mode only stores canonical address hashes and constant route buckets", async () => {
  const values: string[] = [];
  const executor = {
    async query(_sql: string, parameters: unknown[]) {
      values.push(String(parameters[0]));
      return { rows: [{ allowed: true, retry_after_seconds: "1" }] };
    },
  } as RentOpsQueryExecutor;
  const middleware = createRentOpsPublicRateLimiter({ env: databaseEnv, executor });
  assert.equal((await invoke(middleware)).nextCalls, 1);
  assert.equal((await invoke(middleware, "POST", "/applications/start", "::ffff:c000:201")).nextCalls, 1);
  assert.equal((await invoke(middleware, "POST", "/applications/start", "::ffff:192.0.2.1")).nextCalls, 1);
  assert.equal(values[0], values[1]);
  assert.equal(values[1], values[2]);
  assert.equal(values[0].includes("192.0.2.1"), false);
  assert.equal(values[0].includes("applications/start"), false);
  assert.equal(values[0].includes("untrusted-forwarded-value"), false);
  const settings = JSON.parse(values[0]);
  assert.equal(settings.length, 4);
  assert.match(settings[2].bucket_key, /^client:[a-f0-9]{64}:all$/);
  assert.equal(settings[3].request_limit, 5);
  assert.equal(settings[3].window_seconds, 600);
});

test("database mode enforces route/method allowlist before querying and ignores forged forwarded addresses", async () => {
  let calls = 0;
  const executor = { async query() { calls += 1; return { rows: [{ allowed: true, retry_after_seconds: 1 }] }; } } as RentOpsQueryExecutor;
  const middleware = createRentOpsPublicRateLimiter({ env: databaseEnv, executor });
  assert.equal((await invoke(middleware, "DELETE", "/applications/start")).status, 404);
  assert.equal((await invoke(middleware, "POST", "/applications/start/forged")).status, 404);
  assert.equal((await invoke(middleware, "POST", "/applications/start", "invalid")).status, 503);
  assert.equal(calls, 0);
  assert.equal((await invoke(middleware, "HEAD", "/listings")).nextCalls, 1);
  assert.equal(calls, 1);
});

test("database mode returns Retry-After on limits and fails closed on query failure or malformed results", async () => {
  const denied = { async query() { return { rows: [{ allowed: false, retry_after_seconds: "42" }] }; } } as RentOpsQueryExecutor;
  const blocked = await invoke(createRentOpsPublicRateLimiter({ env: databaseEnv, executor: denied }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.nextCalls, 0);
  assert.equal(blocked.headers["Retry-After"], "42");
  for (const executor of [
    { async query() { throw new Error("secret-driver-diagnostics"); } },
    { async query() { return { rows: [] }; } },
    { async query() { return { rows: [{ allowed: "true", retry_after_seconds: 1 }] }; } },
    { async query() { return { rows: [{ allowed: true, retry_after_seconds: 99999 }] }; } },
  ]) {
    const result = await invoke(createRentOpsPublicRateLimiter({ env: databaseEnv, executor: executor as RentOpsQueryExecutor }));
    assert.equal(result.status, 503);
    assert.equal(result.nextCalls, 0);
    assert.deepEqual(result.body, { code: "public_limiter_unavailable" });
    assert.equal(result.headers["Retry-After"], "30");
  }
});

test("PostgreSQL counters atomically enforce shared client/global limits, window rollover and bounded cleanup", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFile } = await import("node:fs/promises");
  const db = new PGlite();
  try {
    const migration = await readFile(new URL("../migrations/013_rent_ops_public_rate_limits.sql", import.meta.url), "utf8");
    await db.exec(migration.split("INSERT INTO rent_ops_schema_migrations")[0]);
    const executor = { query: (sql: string, values?: unknown[]) => db.query(sql, values) } as RentOpsQueryExecutor;
    const first = createRentOpsPublicRateLimiter({ env: databaseEnv, executor });
    const second = createRentOpsPublicRateLimiter({ env: databaseEnv, executor });
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => invoke(i % 2 ? first : second)));
    assert.equal(responses.filter(result => result.nextCalls === 1).length, 5);
    assert.equal(responses.filter(result => result.status === 429).length, 3);
    const initial = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM rent_ops_public_rate_limits");
    assert.equal(initial.rows[0].count, 4);
    await db.exec("UPDATE rent_ops_public_rate_limits SET window_start = window_start - interval '1 hour'");
    assert.equal((await invoke(first)).nextCalls, 1);
    await db.exec("UPDATE rent_ops_public_rate_limits SET request_count=1000000 WHERE bucket_key='global:all'");
    assert.equal((await invoke(second, "POST", "/applications/start", "192.0.2.2")).status, 429);
    const gated = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM rent_ops_public_rate_limits");
    assert.equal(gated.rows[0].count, 4);
    await db.exec(`INSERT INTO rent_ops_public_rate_limits
      SELECT 'client:' || lpad(to_hex(n),64,'0') || ':all',
      statement_timestamp()-interval '2 hours',1,statement_timestamp()-interval '1 hour'
      FROM generate_series(1,100) n`);
    await invoke(first);
    const expired = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM rent_ops_public_rate_limits WHERE expires_at <= statement_timestamp()");
    assert.equal(expired.rows[0].count, 36);
  } finally { await db.close(); }
});
