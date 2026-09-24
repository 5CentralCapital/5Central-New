import assert from "node:assert/strict";
import test from "node:test";
import { createInvestorSignupRateLimiter, parseInvestorSignupInput } from "./legacy-security";

process.env.DATABASE_URL ??= "postgresql://synthetic:synthetic@localhost/synthetic";
const auth = await import("./auth");

function request(values: Record<string, unknown>) {
  const headers = new Map(
    Object.entries(values)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key.toLowerCase(), value as string]),
  );
  return {
    method: typeof values.method === "string" ? values.method : "POST",
    protocol: "https",
    user: values.user,
    headers: Object.fromEntries(headers),
    get(name: string) { return headers.get(name.toLowerCase()); },
    socket: { remoteAddress: "127.0.0.1" },
  } as never;
}

function responseRecorder() {
  let status = 200;
  let body: unknown;
  return {
    response: {
      status(code: number) { status = code; return { json(value: unknown) { body = value; } }; },
    } as never,
    getStatus: () => status,
    getBody: () => body,
  };
}

test("legacy cookie mutations require a same-origin proof while safe reads remain available", () => {
  const admin = { id: "admin", role: "admin" };
  const blocked = responseRecorder();
  let nextCalls = 0;
  auth.requireAdmin(request({ method: "POST", host: "app.example.test", user: admin }), blocked.response, () => { nextCalls++; });
  assert.equal(blocked.getStatus(), 403);
  assert.deepEqual(blocked.getBody(), { code: "csrf_required" });
  assert.equal(nextCalls, 0);

  const sameOrigin = request({ method: "POST", host: "app.example.test", origin: "https://app.example.test", user: admin });
  assert.equal(auth.requestHasSameOrigin(sameOrigin), true);
  auth.requireAdmin(sameOrigin, blocked.response, () => { nextCalls++; });
  assert.equal(nextCalls, 1);

  const crossOrigin = responseRecorder();
  auth.requireAdmin(request({ method: "POST", host: "app.example.test", origin: "https://attacker.example.test", user: admin }), crossOrigin.response, () => { nextCalls++; });
  assert.equal(crossOrigin.getStatus(), 403);

  auth.requireAdmin(request({ method: "GET", host: "app.example.test", user: admin }), blocked.response, () => { nextCalls++; });
  assert.equal(nextCalls, 2);
});

test("legacy API-key automation remains explicit and does not inherit browser CSRF headers", () => {
  const prior = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = "synthetic-legacy-api-key";
  try {
    const nextCalls: unknown[] = [];
    auth.requireAdminOrApiKey(request({ method: "POST", "x-api-key": "synthetic-legacy-api-key" }), {} as never, () => nextCalls.push(true));
    assert.equal(nextCalls.length, 1);
  } finally {
    if (prior === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prior;
  }
});

test("public investor intake accepts bounded fields and cannot self-assert verified status", () => {
  const parsed = parseInvestorSignupInput({
    firstName: "  Ada ",
    lastName: "Lovelace",
    email: "ADA@EXAMPLE.TEST",
    phone: "+1 (555) 555-0100",
    company: "Analytical Engines",
    investableCapital: "100000.00",
    accreditedStatus: "self_reported",
    source: "forged-source",
    unexpected: "discarded",
  });
  assert.deepEqual(parsed, {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    phone: "+1 (555) 555-0100",
    company: "Analytical Engines",
    investableCapital: "100000.00",
    accreditedStatus: "self_reported",
    source: "website",
  });
  assert.equal(parseInvestorSignupInput({ firstName: "A", lastName: "B", email: "a@example.test", accreditedStatus: "verified" }), null);
  assert.equal(parseInvestorSignupInput({ firstName: "A", lastName: "B", email: "a@example.test", investableCapital: "-1" }), null);
  assert.equal(parseInvestorSignupInput({ firstName: "A", lastName: "B", email: "not-an-email" }), null);
});

test("public investor intake limiter bounds IP and email spray and expires", () => {
  let now = 0;
  const limit = createInvestorSignupRateLimiter(() => now);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(limit("ip-1", `person-${attempt}@example.test`), 0);
  assert.equal(limit("ip-1", "another@example.test"), 900);
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(limit(`ip-${attempt + 2}`, "person@example.test"), 0);
  assert.equal(limit("ip-9", "person@example.test"), 900);
  now = 900001;
  assert.equal(limit("ip-1", "person@example.test"), 0);
});

test("public investor intake requires same-origin requests", () => {
  let nextCalls = 0;
  const blocked = responseRecorder();
  auth.requireSameOriginForMutation(request({ method: "POST", host: "app.example.test" }), blocked.response, () => { nextCalls++; });
  assert.equal(blocked.getStatus(), 403);
  assert.equal(nextCalls, 0);

  auth.requireSameOriginForMutation(request({ method: "POST", host: "app.example.test", origin: "https://app.example.test" }), blocked.response, () => { nextCalls++; });
  assert.equal(nextCalls, 1);
});
