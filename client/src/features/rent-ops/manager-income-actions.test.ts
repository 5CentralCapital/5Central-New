import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { registerRentOpsRoutes } from "../../../../server/rent-ops/routes";
import { createSyntheticRentOpsRepository } from "../../../../server/rent-ops/fixtures/synthetic";
import { allocationChargeLabel, saveManagerIncomeAction } from "./manager-income-actions";

test("manager income transport reaches the actual mounted definition and payment routes", async () => {
  const app = express(); app.use(express.json());
  registerRentOpsRoutes(app, { repository: createSyntheticRentOpsRepository(), requireAdmin: (req, _res, next) => { req.rentOpsAdminUser = { id: "qa-manager" } as never; next(); } });
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const statuses: number[] = [];
  const request = async (path: RequestInfo | URL, init?: RequestInit) => { const response = await fetch(`http://127.0.0.1:${address.port}${String(path)}`, init); statuses.push(response.status); return response; };
  try {
    // Invalid bodies must reach each real route's validation, never a 404.
    await assert.rejects(saveManagerIncomeAction("charge-definitions", {}, "POST", request));
    await assert.rejects(saveManagerIncomeAction("charge-definitions/qa", {}, "PATCH", request));
    await assert.rejects(saveManagerIncomeAction("manual-payments", {}, "POST", request));
    assert.deepEqual(statuses, [400, 400, 400]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a charge with an unknown amount is labeled Unknown in the allocation list, never $0.00", () => {
  assert.equal(allocationChargeLabel({ postedOn: "2026-09-01", description: "Rent", amountCents: 125000 }), "2026-09-01 · Rent · $1,250.00");
  assert.equal(allocationChargeLabel({ postedOn: "2026-09-01", description: "Water", amountCents: undefined }), "2026-09-01 · Water · Unknown");
});
