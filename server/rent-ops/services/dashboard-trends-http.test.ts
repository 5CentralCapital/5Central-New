import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { registerRentOpsRoutes } from "../routes";
import { dashboardTrendsSchema } from "../../../shared/rent-ops-dashboard";

test("dashboard history is manager-only, loads once, and exposes only aggregates", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  Object.assign(snapshot.people[0], { rawPayload: "PRIVATE_CANARY", passwordHash: "PRIVATE_CANARY" });
  const repository = new SyntheticRentOpsRepository(snapshot);
  let reads = 0;
  Object.assign(repository, { getOperationalSnapshot: async () => { reads++; return structuredClone(snapshot); } });
  const app = express();
  registerRentOpsRoutes(app, { repository, previewSource: "synthetic", now: () => new Date("2026-08-15T12:00:00Z"),
    requireAdmin: (req, res, next) => { if (req.headers["x-test-admin"] !== "yes") { res.sendStatus(401); return; } next(); },
  });
  const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rent-ops/workspace`;
  try {
    for (const path of ["dashboard-trends", "dashboard-cash"]) assert.equal((await fetch(`${base}/${path}`)).status, 401);
    assert.equal(reads, 0);
    const response = await fetch(`${base}/dashboard-trends?asOfDate=2026-08-15&propertyId=demo-property-a`, { headers: { "x-test-admin": "yes" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(reads, 1);
    assert.ok(dashboardTrendsSchema.safeParse(body).success);
    assert.ok(!JSON.stringify(body).includes("PRIVATE_CANARY"));
    assert.ok(body.months.every((month: { properties: Array<{ propertyId: string }> }) => month.properties.every(property => property.propertyId === "demo-property-a")));
    assert.deepEqual(await (await fetch(`${base}/dashboard-cash`, { headers: { "x-test-admin": "yes" } })).json(), { state: "unconfigured" });
    assert.equal((await fetch(`${base}/dashboard-trends?fromDate=2026-08-01`, { headers: { "x-test-admin": "yes" } })).status, 400);
    assert.equal(reads, 1, "invalid date ranges do not trigger a snapshot read");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
