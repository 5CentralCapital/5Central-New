import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { syntheticRentOpsSnapshot, createSyntheticRentOpsRepository } from "../fixtures/synthetic";
import { serializeWorkspaceBootstrap, serializeWorkspaceCollection } from "./workspace-read";
import { deriveFixedReport, deriveDashboardSummary, deriveTenantProfile } from "../domain/reports";
import { RentOpsService } from "../services/service";
import { createInMemoryObjectStore } from "../storage";

test("bootstrap excludes financial rows and history, preserving positive DTOs and revision", () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  Object.assign(source.people[0], { ssn: "SENSITIVE_SENTINEL", rawPayload: "SENSITIVE_SENTINEL" });
  const result = serializeWorkspaceBootstrap(source);
  assert.equal(result.snapshot.ledgerTransactions.length, 0);
  assert.ok(!result.loadedCollections.includes("ledgerTransactions" as never));
  assert.ok(!JSON.stringify(result).includes("SENSITIVE_SENTINEL"));
  assert.equal(result.snapshot.people.length, source.people.length);
  assert.equal("summary" in result, false);
  assert.equal("reports" in result, false);
  assert.equal("applicationHistory" in result.snapshot, false);
});

test("workspace collection retains nulls and allowed fields, excludes other collections", () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  const response = serializeWorkspaceCollection(source, "ledgerTransactions");
  assert.equal(response.collection, "ledgerTransactions");
  assert.equal(response.items.length, source.ledgerTransactions.length);
  assert.deepEqual(Object.keys(response), ["collection", "items"]);
});

test("operational reads preserve full financial derivations and avoid legacy repository read", async () => {
  const repository = createSyntheticRentOpsRepository();
  const source = await repository.getSnapshot();
  let reads = 0;
  Object.assign(repository, { getOperationalSnapshot: async () => { reads++; return source; }, getSnapshot: async () => { throw new Error("Legacy snapshot should not be loaded"); } });
  const service = new RentOpsService(repository, createInMemoryObjectStore());
  const filters = { asOfDate: "2026-08-15", month: "2026-08" };
  for (const name of ["rent-roll", "scheduled-income", "collected-income", "scheduled-vs-collected", "delinquency", "tenant-ledger", "security-deposit", "hap"] as const) {
    assert.deepEqual(await service.report(name, filters), deriveFixedReport(source, name, filters));
  }
  assert.deepEqual(await service.dashboard(filters), deriveDashboardSummary(source, filters));
  assert.deepEqual(await service.tenantProfile(source.people[0].id, filters), deriveTenantProfile(source, source.people[0].id, filters));
  assert.equal(reads, 10);
});

test("synthetic bootstrap stays within response budget at 1000 navigation contacts", () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  source.people = Array.from({length: 1000}, (_, index) => ({ ...source.people[0], id: `person-${index}`, firstName: `Contact ${index}` }));
  const start = performance.now();
  const bytes = Buffer.from(JSON.stringify(serializeWorkspaceBootstrap(source)));
  const compressed = gzipSync(bytes);
  assert.ok(compressed.length < 250 * 1024);
  console.log(JSON.stringify({ workspaceSyntheticContacts: 1000, decodedBytes: bytes.length, gzipBytes: compressed.length, serializeAndGzipMs: Math.round(performance.now() - start) }));
});

test("navigation matches profile selection and keeps account-only contacts separate", () => {
  const source = structuredClone(syntheticRentOpsSnapshot());
  source.householdMemberships.push({ id: "account-link", tenancyId: source.tenancies[0].id, personId: source.people[0].id, accountPersonId: source.people[3].id });
  const filters = { asOfDate: "2026-08-15" };
  const result = serializeWorkspaceBootstrap(source, filters);
  for (const entry of result.tenantIndex.filter(row => row.person.id !== source.people[3].id)) {
    assert.equal(entry.selectedTenancyId, deriveTenantProfile(source, entry.person.id!, filters)?.tenancy?.id);
  }
  const account = result.tenantIndex.find(row => row.person.id === source.people[3].id)!;
  assert.equal(account.accountContact, true);
  assert.equal(account.selectedTenancyId, undefined);
  assert.deepEqual(account.tenancyIds, []);
  assert.equal(result.tenantIndex.find(row => row.person.id === source.people[1].id)?.category, "future");
});

test("repository bootstrap reads seven navigation tables and operational read keeps all finance tables", async () => {
  const { createPostgresRentOpsRepository } = await import("../repositories/postgres");
  const { RENT_OPS_RUNTIME_REQUIRED_TABLES } = await import("../persistence");
  const queried: string[] = [];
  const executor = {
    async query<T>(sql: string, values?: unknown[]): Promise<{rows: T[]}> {
      if (sql.includes("information_schema.tables")) return { rows: RENT_OPS_RUNTIME_REQUIRED_TABLES.map(table_name => ({table_name})) as T[] };
      if (sql.includes("has_table_privilege")) return { rows: ((values?.[0] as string[]) ?? []).map(table_name => ({table_name, can_select: false, can_insert: false, can_update: false, can_delete: false})) as T[] };
      const table = sql.match(/^SELECT \* FROM (\w+)/)?.[1];
      if (table) queried.push(table);
      return {rows: []};
    },
  };
  const repository = createPostgresRentOpsRepository(executor);
  await repository.getWorkspaceSnapshot();
  assert.equal(queried.length, 7);
  assert.ok(!queried.includes("rent_ops_ledger_transactions"));
  queried.length = 0;
  await repository.getOperationalSnapshot();
  assert.equal(queried.length, 19);
  for (const table of ["rent_ops_ledger_transactions", "rent_ops_payment_allocations", "rent_ops_security_deposits", "rent_ops_subsidy_payments", "rent_ops_subsidy_tenants", "rent_ops_recurring_charge_schedules"]) assert.ok(queried.includes(table));
  assert.ok(!queried.includes("rent_ops_application_answer_occurrences"));
  queried.length = 0;
  await repository.getSnapshot();
  assert.equal(queried.length, 32);
});

test("workspace HTTP reads use existing admin guard and explicit collection envelope", async () => {
  const { default: express } = await import("express");
  const { registerRentOpsRoutes } = await import("../routes");
  const app = express();
  registerRentOpsRoutes(app, {
    repository: createSyntheticRentOpsRepository(),
    requireAdmin: (req, res, next) => { if (req.headers["x-test-admin"] !== "yes") { res.sendStatus(401); return; } next(); },
  });
  const server = await new Promise<import("node:http").Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/rent-ops`;
  try {
    assert.equal((await fetch(`${url}/workspace`)).status, 401);
    const headers = {"x-test-admin": "yes"};
    const response = await fetch(`${url}/workspace?asOfDate=2026-08-15`, {headers});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.workspaceVersion, 1);
    assert.equal(body.tenantIndex.find((row: {person: {id: string}}) => row.person.id === "demo-person-2").category, "future");
    assert.equal((await fetch(`${url}/workspace/collections/applicationHistory`, {headers})).status, 404);
    const collection = await (await fetch(`${url}/workspace/collections/documents`, {headers})).json();
    assert.deepEqual(collection, {collection: "documents", items: []});
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
