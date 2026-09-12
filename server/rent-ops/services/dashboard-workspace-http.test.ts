import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { RentOpsService } from "./service";
import { assertValidSnapshot } from "../domain/invariants";
import { deriveDashboardSummary, deriveRentRoll, deriveDelinquency } from "../domain/reports";
import { registerRentOpsRoutes } from "../routes";
import type { RentOpsSnapshot } from "../../../shared/rent-ops-contracts";

function countedRepository(source: RentOpsSnapshot) {
  let reads = 0; let validations = 0;
  const repository = new SyntheticRentOpsRepository(source);
  Object.assign(repository, {
    getSnapshot: async () => {throw new Error("Combined dashboard must not use legacy snapshot");},
    getOperationalSnapshot: async () => {
      reads++;
      const snapshot = structuredClone(source);
      validations++;
      assertValidSnapshot(snapshot);
      return snapshot;
    },
  });
  return {repository, counts: () => ({reads, validations})};
}

test("workspace dashboard loads and validates once with summary and report parity", async () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  const {repository, counts} = countedRepository(source);
  const service = new RentOpsService(repository);
  const filters = {propertyScope: "active" as const, propertyId: "demo-property-a", asOfDate: "2026-08-15", month: "2026-08"};
  const result = await service.workspaceDashboard(filters);
  assert.deepEqual(counts(), {reads: 1, validations: 1});
  assert.deepEqual(result.summary, deriveDashboardSummary(source, filters));
  assert.deepEqual(result.rentRoll, deriveRentRoll(source, filters));
  assert.deepEqual(result.delinquency, deriveDelinquency(source, filters));
  assert.ok(result.rentRoll.every(row => row.propertyId === "demo-property-a"));
  assert.ok(result.delinquency.every(row => row.propertyId === "demo-property-a"));
  await assert.rejects(service.workspaceDashboard({...filters, fromDate: "2026-08-01", toDate: "2026-08-15"}));
  assert.deepEqual(counts(), {reads: 1, validations: 1}, "invalid dashboard filters must fail before reading");
});

test("workspace dashboard HTTP preserves authorization, positive DTOs and existing endpoint contents", async () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  Object.assign(source.people[0], {rawPayload: "SENSITIVE_CANARY", resumeTokenHash: "SENSITIVE_CANARY"});
  Object.assign(source.ledgerTransactions[0], {rawPayload: "SENSITIVE_CANARY", storageKey: "SENSITIVE_CANARY"});
  const {repository, counts} = countedRepository(source);
  const app = express();
  registerRentOpsRoutes(app, {
    repository,
    requireAdmin: (req, res, next) => {if (req.headers["x-test-admin"] !== "yes") {res.sendStatus(401); return;} next();},
    now: () => new Date("2026-08-15T12:00:00Z"),
  });
  const server = await new Promise<Server>(resolve => {const listener = app.listen(0, "127.0.0.1", () => resolve(listener));});
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rent-ops`;
  const query = "?propertyId=demo-property-a&asOfDate=2026-08-15&month=2026-08";
  const headers = {"x-test-admin": "yes"};
  try {
    const denied = await fetch(`${origin}/workspace/dashboard${query}`);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("server-timing"), null);
    assert.equal(denied.headers.get("x-rent-ops-timing"), null);
    assert.deepEqual(counts(), {reads: 0, validations: 0});
    const combined = await fetch(`${origin}/workspace/dashboard${query}`, {headers});
    assert.equal(combined.status, 200);
    assert.equal(combined.headers.get("cache-control"), "no-store");
    assert.equal(combined.headers.get("server-timing"), combined.headers.get("x-rent-ops-timing"));
    assert.ok(combined.headers.get("server-timing")?.includes("derive;dur="));
    const body = await combined.json();
    assert.deepEqual(counts(), {reads: 1, validations: 1});
    assert.deepEqual(Object.keys(body).sort(), ["delinquency", "rentRoll", "summary"]);
    assert.ok(!JSON.stringify(body).includes("SENSITIVE_CANARY"));
    assert.equal("snapshot" in body, false);
    const [summary, rentRoll, delinquency] = await Promise.all([
      fetch(`${origin}/dashboard${query}`, {headers}).then(response => response.json()),
      fetch(`${origin}/reports/rent-roll${query}`, {headers}).then(response => response.json()),
      fetch(`${origin}/reports/delinquency${query}`, {headers}).then(response => response.json()),
    ]);
    assert.deepEqual(body, {summary, rentRoll, delinquency});
    assert.deepEqual(counts(), {reads: 4, validations: 4}, "three legacy requests retain their independent reads");
    assert.ok(body.rentRoll.rows.every((row: {propertyId: string}) => row.propertyId === "demo-property-a"));
    assert.ok(body.delinquency.rows.every((row: {propertyId: string}) => row.propertyId === "demo-property-a"));
    const invalid = await fetch(`${origin}/workspace/dashboard?asOfDate=invalid`, {headers});
    assert.equal(invalid.status, 400);
    assert.deepEqual(counts(), {reads: 4, validations: 4});
  } finally {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}
});

test("workspace dashboard preserves unknown balances instead of manufacturing zeros", async () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  Object.assign(source.ledgerTransactions[0], {amountCents: null, amountKnowledge: "unknown"});
  const {repository, counts} = countedRepository(source);
  const filters = {propertyId: "demo-property-a", asOfDate: "2026-08-16", month: "2026-08"};
  const combined = await new RentOpsService(repository).workspaceDashboard(filters);
  assert.deepEqual(counts(), {reads: 1, validations: 1});
  assert.deepEqual(combined.summary, deriveDashboardSummary(source, filters));
  assert.deepEqual(combined.rentRoll, deriveRentRoll(source, filters));
  assert.deepEqual(combined.delinquency, deriveDelinquency(source, filters));
  assert.equal(combined.summary.balanceComplete, false);
  assert.equal(combined.summary.totalDelinquencyCents, null);
  assert.ok(combined.delinquency.some(row => row.balanceComplete === false));
});
