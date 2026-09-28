import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";
import { registerTenantQuickBooksPaymentRoutes, type TenantQuickBooksPayments } from "./quickbooks-routes";

const identity: TenantIdentity = { id: "account", personId: "person", tenancyId: "tenancy", email: "synthetic@example.test", status: "active" };
const view = { provider: "quickbooks" as const, available: true, reasons: [], invoices: [{ id: "123", number: "RENT-123", balanceCents: "900719925474099301", dueDate: "2026-10-01" }] };
const link = { invoiceId: "123", url: "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-synthetic" };
async function fixture(run: (base: string, calls: unknown[]) => Promise<void>, failing = false) {
  const calls: unknown[] = [];
  const service: TenantQuickBooksPayments = {
    async list(who) { calls.push(["list", who]); if (failing) throw new Error("private realm or provider failure"); return view; },
    async link(who, id) { calls.push(["link", who, id]); if (failing) throw new Error("private realm or provider failure"); return link; },
  };
  const app = express(); app.use(express.json());
  registerTenantQuickBooksPaymentRoutes(app, { service,
    requireTenant(req, res, next) {
      if (req.get("x-test-auth") !== "active") { res.sendStatus(401); return; }
      if (req.method === "POST" && req.get("x-tenant-csrf") !== "synthetic-session-token") { res.sendStatus(403); return; }
      next();
    },
    getTenantIdentity(req) { return req.get("x-test-binding") === "missing" ? undefined : identity; },
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/tenant/payments/quickbooks`, calls); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const auth = { "x-test-auth": "active", "x-tenant-csrf": "synthetic-session-token", "content-type": "application/json" };

test("both payment routes require the tenant session and link requests require CSRF", async () => {
  await fixture(async (base, calls) => {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}/link`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"invoiceId":"123"}' })).status, 401);
    assert.equal((await fetch(`${base}/link`, { method: "POST", headers: { "x-test-auth": "active", "content-type": "application/json" }, body: '{"invoiceId":"123"}' })).status, 403);
    assert.equal((await fetch(base, { headers: { ...auth, "x-test-binding": "missing" } })).status, 401);
    assert.deepEqual(calls, []);
  });
});
test("tenant routes preserve exact money and pass only the authenticated identity and invoice id", async () => {
  await fixture(async (base, calls) => {
    const result = await fetch(base, { headers: auth });
    assert.equal(result.headers.get("cache-control"), "no-store"); assert.deepEqual(await result.json(), view);
    const response = await fetch(`${base}/link`, { method: "POST", headers: auth, body: JSON.stringify({ invoiceId: "123" }) });
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(await response.json(), link);
    assert.deepEqual(calls, [["list", identity], ["link", identity, "123"]]);
  });
});
test("tenant routes reject caller-supplied ownership or financial scope before provider work", async () => {
  await fixture(async (base, calls) => {
    for (const name of ["organizationId", "tenancyId", "realmId", "customerId", "amountCents", "url"]) {
      const response = await fetch(`${base}/link`, { method: "POST", headers: auth, body: JSON.stringify({ invoiceId: "123", [name]: "other" }) });
      assert.equal(response.status, 400);
    }
    assert.deepEqual(calls, []);
  });
});
test("provider and mapping failures never disclose private merchant information", async () => {
  await fixture(async base => {
    for (const response of [await fetch(base, { headers: auth }), await fetch(`${base}/link`, { method: "POST", headers: auth, body: '{"invoiceId":"123"}' })]) {
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "quickbooks_payments_unavailable" });
    }
  }, true);
});
