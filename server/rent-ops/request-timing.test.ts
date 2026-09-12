import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRentOpsPoolExecutor } from "./runtime-database";
import { createPostgresRentOpsRepository } from "./repositories/postgres";
import { RENT_OPS_RUNTIME_REQUIRED_TABLES } from "./persistence";
import { registerRentOpsRoutes } from "./routes";
import { countRentOpsTiming, measureRentOps, measureRentOpsAsync } from "./request-timing";

function metrics(header: string | null) {
  assert.ok(header);
  const parsed = new Map<string, number>();
  for (const field of header.split(", ")) {
    const match = field.match(/^(db|decode|map|validate|derive|total);dur=(\d+\.\d{2})$|^(db_calls|batch_calls);desc="(\d+)"$/);
    assert.ok(match, `Unexpected timing field: ${field}`);
    parsed.set(match[1] ?? match[3], Number(match[2] ?? match[4]));
  }
  return parsed;
}

test("protected request timings expose only isolated numeric phases and preserve endpoint bodies/auth", async () => {
  const database = createRentOpsPoolExecutor({
    async query<T>(sql: string, values?: unknown[]): Promise<{rows: T[]}> {
      if (sql.includes("information_schema.tables")) return {rows: RENT_OPS_RUNTIME_REQUIRED_TABLES.map(table_name => ({table_name})) as T[]};
      if (sql.includes("has_table_privilege")) return {rows: ((values?.[0] as string[]) ?? []).map(table_name => ({table_name, can_select: false, can_insert: false, can_update: false, can_delete: false})) as T[]};
      if (sql.startsWith("SELECT COALESCE(")) {
        // Different await windows exercise concurrent ALS contexts, not shared counters.
        await new Promise(resolve => setTimeout(resolve, sql.includes("rent_ops_documents") ? 12 : 3));
        return {rows: [Object.fromEntries(Array.from(sql.matchAll(/FROM (rent_ops_[a-z_]+) AS r/g)).map(match => [match[1], []]))] as T[]};
      }
      return {rows: []};
    },
    connect: async () => {throw new Error("Unexpected batch transaction");},
  });
  const repository = createPostgresRentOpsRepository(database);
  await repository.assertReady();
  const app = express();
  registerRentOpsRoutes(app, {
    repository,
    requireAdmin: (req, res, next) => {if (req.headers["x-test-admin"] !== "yes") {res.sendStatus(401); return;} next();},
    now: () => new Date("2026-08-15T12:00:00Z"),
  });
  const server = await new Promise<Server>(resolve => {const listener = app.listen(0, "127.0.0.1", () => resolve(listener));});
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rent-ops`;
  const headers = {"x-test-admin": "yes"};
  try {
    const unauthorized = await fetch(`${origin}/workspace`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("server-timing"), null);
    assert.equal(unauthorized.headers.get("x-rent-ops-timing"), null);
    const preview = await fetch(`${origin}/preview-context`, {headers});
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("server-timing"), null);
    assert.equal(preview.headers.get("x-rent-ops-timing"), null);
    const [workspace, dashboard, report, tenant] = await Promise.all([
      fetch(`${origin}/workspace`, {headers}), fetch(`${origin}/dashboard`, {headers}),
      fetch(`${origin}/reports/rent-roll`, {headers}), fetch(`${origin}/tenants/not-a-real-person`, {headers}),
    ]);
    assert.equal(workspace.status, 200); assert.equal(dashboard.status, 200); assert.equal(report.status, 200); assert.equal(tenant.status, 404);
    for (const response of [workspace, dashboard, report, tenant]) {
      assert.equal(response.headers.get("x-rent-ops-timing"), response.headers.get("server-timing"));
      const timing = metrics(response.headers.get("server-timing"));
      assert.equal(timing.get("db_calls"), 1);
      assert.equal(timing.get("batch_calls"), 1);
      for (const phase of ["db", "decode", "map", "derive", "total"]) assert.ok(timing.has(phase), phase);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (response !== workspace) assert.ok(timing.has("validate"));
    }
    const workspaceBody = await workspace.json();
    assert.equal(workspaceBody.workspaceVersion, 1);
    assert.deepEqual(workspaceBody.tenantIndex, []);
    assert.equal("timings" in workspaceBody, false);
    const reportBody = await report.json();
    assert.deepEqual(reportBody.rows, []);
    assert.equal(reportBody.report, "rent-roll");
    assert.equal((await dashboard.json()).unitCount, 0);
    assert.deepEqual(await tenant.json(), {code: "not_found"});
  } finally {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}
});

test("timing helpers are transparent without a protected request context", async () => {
  const value = {unchanged: true};
  countRentOpsTiming("db_calls");
  assert.equal(measureRentOps("map", () => value), value);
  assert.equal(await measureRentOpsAsync("db", async () => value), value);
  const failure = new Error("same error object");
  assert.throws(() => measureRentOps("derive", () => {throw failure;}), error => error === failure);
  await assert.rejects(measureRentOpsAsync("db", async () => {throw failure;}), error => error === failure);
});
