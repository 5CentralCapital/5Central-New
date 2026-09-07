import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { emptyRentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { RecurringBillingService } from "./service";
import { registerRentOpsBillingRoutes } from "./routes";

test("billing requires admin and rejects malformed or client-supplied actor requests", async () => {
  let reads = 0;
  const service = new RecurringBillingService({ read: async () => { reads++; return {snapshot: emptyRentOpsSnapshot(), receipts: []}; }, transaction: async () => { throw new Error("unexpected write"); } });
  const app = express(); app.use(express.json());
  registerRentOpsBillingRoutes(app, {service, requireAdmin: (req, res, next) => { if(req.get("x-admin") === "yes") { req.rentOpsAdminUser = {id:"admin"} as any; next(); } else res.sendStatus(401); }});
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/rent-ops/billing`;
  try {
    assert.equal((await fetch(base + "/preview?month=2025-05")).status, 401);
    assert.equal(reads, 0);
    assert.equal((await fetch(base + "/preview?month=bad", {headers:{"x-admin":"yes"}})).status, 400);
    const preview = await fetch(base + "/preview?month=2025-05", {headers:{"x-admin":"yes"}});
    assert.equal(preview.status,200); assert.equal(preview.headers.get("cache-control"),"no-store");
    assert.equal((await fetch(base + "/post", {method:"POST", headers:{"x-admin":"yes","content-type":"application/json"}, body:JSON.stringify({month:"2025-05",previewToken:"a".repeat(64),actorSubject:"spoof"})})).status,400);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
