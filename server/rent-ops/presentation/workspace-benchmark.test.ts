import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { emptyRentOpsSnapshot, type RentOpsSnapshot, type RentOpsWorkspaceCollection } from "../../../shared/rent-ops-contracts";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { registerRentOpsRoutes } from "../routes";
import { deriveDashboardSummary, deriveRentRoll, deriveOccupancy, deriveScheduledIncome, deriveCollectedIncome, deriveDelinquency, deriveLeaseExpirations, deriveDepositLiability } from "../domain/reports";
import { workspaceBootstrapCollections } from "./workspace-read";

/** Opt-in, entirely synthetic HTTP benchmark. No database or provider connection. */
test("synthetic HTTP workspace workload benchmark", {skip: process.env.RENT_OPS_BENCHMARK !== "1"}, async () => {
  const copies = Number(process.env.RENT_OPS_BENCHMARK_COPIES ?? 50);
  assert.ok(Number.isSafeInteger(copies) && copies > 0 && copies <= 200);
  const original = syntheticRentOpsSnapshot();
  const allIds = new Set(Object.values(original).flatMap(value => Array.isArray(value) ? value.map(row => row.id).filter((id): id is string => typeof id === "string") : []));
  const fixture = emptyRentOpsSnapshot();
  for (let index = 0; index < copies; index++) {
    const remap = (value: unknown): unknown => typeof value === "string" ? allIds.has(value) ? `${value}-copy${index}` : value
      : Array.isArray(value) ? value.map(remap)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)])) : value;
    const copy = remap(original) as RentOpsSnapshot;
    for (const [name, rows] of Object.entries(copy)) if (Array.isArray(rows)) (fixture[name as keyof RentOpsSnapshot] as unknown[]).push(...rows);
  }
  const domainTimings: Record<string, number> = {};
  const filters = {propertyScope: "active" as const, asOfDate: "2026-08-15", month: "2026-08"};
  for (const [name, derive] of Object.entries({deriveDashboardSummary, deriveRentRoll, deriveOccupancy, deriveScheduledIncome, deriveCollectedIncome, deriveDelinquency, deriveLeaseExpirations, deriveDepositLiability})) {
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      derive(fixture, filters);
      if (i > 0) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    domainTimings[name] = Number(times[2].toFixed(2));
  }
  const repository = new SyntheticRentOpsRepository(fixture);
  const reads = {full: 0, operational: 0, bootstrap: 0, collection: 0};
  Object.assign(repository, {
    getSnapshot: async () => { reads.full++; return structuredClone(fixture); },
    getOperationalSnapshot: async () => { reads.operational++; return structuredClone(fixture); },
    getWorkspaceSnapshot: async () => {
      reads.bootstrap++;
      const projection = emptyRentOpsSnapshot();
      for (const name of workspaceBootstrapCollections) Object.assign(projection, {[name]: structuredClone(fixture[name])});
      return projection;
    },
    getWorkspaceCollection: async (name: RentOpsWorkspaceCollection) => { reads.collection++; return structuredClone(fixture[name]); },
  });
  const app = express();
  registerRentOpsRoutes(app, {repository, requireAdmin: (_req, _res, next) => next(), now: () => new Date("2026-08-15T12:00:00.000Z")});
  const server = await new Promise<Server>(resolve => {const listener = app.listen(0, "127.0.0.1", () => resolve(listener));});
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rent-ops`;
  const paths = ["/snapshot", "/workspace", "/workspace/collections/recurringSchedules", "/workspace/collections/documents", "/workspace/collections/activityEvents", `/tenants/${fixture.people[0].id}`, "/dashboard", "/reports/tenant-ledger"];
  const results: unknown[] = [];
  try {
    for (const path of paths) {
      const times: number[] = [];
      let decodedBytes = 0; let wireBytes = 0; let encoding = "identity";
      for (let iteration = 0; iteration < 6; iteration++) {
        if (iteration === 1) Object.assign(reads, {full: 0, operational: 0, bootstrap: 0, collection: 0});
        const start = performance.now();
        const response = await fetch(`${origin}${path}?asOfDate=2026-08-15&month=2026-08`, {headers: {"accept-encoding": "gzip"}});
        const bytes = await response.arrayBuffer();
        assert.equal(response.status, 200, `${path}: ${new TextDecoder().decode(bytes).slice(0, 200)}`);
        if (iteration > 0) times.push(performance.now() - start);
        decodedBytes = bytes.byteLength;
        wireBytes = Number(response.headers.get("content-length"));
        encoding = response.headers.get("content-encoding") ?? "identity";
      }
      times.sort((a, b) => a - b);
      results.push({path, medianMs: Number(times[2].toFixed(2)), minMs: Number(times[0].toFixed(2)), maxMs: Number(times[4].toFixed(2)), decodedBytes, wireBytes, encoding, repositoryReadsPerRequest: Object.fromEntries(Object.entries(reads).map(([key, count]) => [key, count / 5]))});
    }
    console.log(JSON.stringify({fixture: {copies, people: fixture.people.length, tenancies: fixture.tenancies.length, ledgerTransactions: fixture.ledgerTransactions.length}, domainMedianMs: domainTimings, results}, null, 2));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
