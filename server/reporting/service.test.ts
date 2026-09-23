import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticatedPrincipal } from "../company/authorization";
import { getReportingDefinition } from "../../shared/reporting";
import { createReportingRegistry } from "./registry";
import { InMemoryReportingStore } from "./store";
import { ReportingService } from "./service";

const organizationId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const principal = createAuthenticatedPrincipal({ actorId, organizationId, role: "admin", authorizedScopes: [{}] });
const scope = { organizationId, legalEntityIds: [], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] } as const;

function request() {
  return { reportId: "rent-roll", definitionVersion: "1", scope, filters: { propertyScope: "all" }, period: { mode: "as_of" as const, asOfDate: "2026-09-21" }, basis: "operational" as const, currency: null };
}

test("report runs convert legacy cents, page immutable snapshots, and export the same rows", async () => {
  const registry = createReportingRegistry({ engines: [{
    key: "test.rental", reportIds: ["rent-roll"], ready: true,
    async run() { return { columns: [{ id: "unitId", label: "Unit", type: "text", sortable: true, filterable: true, sensitive: false }, { id: "amountCents", label: "Amount", type: "money", sortable: true, filterable: true, sensitive: false }], rows: [{ rowId: "row-1", values: { unitId: "u-1", amountCents: "123" } }], coverage: [{ source: "fixture", state: "complete", evidence: "synthetic", basis: "operational", watermark: "fixture-1", observedAt: "2026-09-21T00:00:00.000Z", coveredFrom: null, coveredThrough: "2026-09-21", rowCount: 1, reason: null }], missingData: [] }; }
  }] });
  const service = new ReportingService({ registry, store: new InMemoryReportingStore(), now: () => new Date("2026-09-21T00:00:00.000Z") });
  const result = await service.run({ principal }, request());
  assert.equal(result.run.rows[0].values.amountCents, "123");
  assert.equal(result.page.rows.length, 1);
  const replayRequest = { ...request(), requestId: "replay-1234" };
  const replay = await service.run({ principal }, replayRequest);
  const replayed = await service.run({ principal }, replayRequest);
  assert.equal(replayed.run.id, replay.run.id);
  assert.equal((await service.page({ principal }, { runId: result.run.id, limit: 1 })).snapshotId, result.run.snapshotId);
  const exportJob = await service.createExport({ principal }, { runId: result.run.id, format: "csv" });
  assert.match(exportJob.content ?? "", /,1\.23\r\n/);
});

test("paging fallback and drilldowns continue from the immutable snapshot", async () => {
  const registry = createReportingRegistry({ engines: [{
    key: "test.rental", reportIds: ["rent-roll"], ready: true,
    async run() {
      return {
        columns: [{ id: "value", label: "Value", type: "text", sortable: true, filterable: true, sensitive: false }],
        rows: ["a", "b", "c"].map(value => ({ rowId: `row-${value}`, values: { value } })),
        coverage: [],
        missingData: [],
        drilldowns: [{ rowId: "row-b", items: [{ id: "source-b", kind: "source", values: { value: "source" } }], nextCursor: null, coverage: [], missingData: [] }],
      };
    },
  }] });
  const service = new ReportingService({ registry, store: new InMemoryReportingStore(), now: () => new Date("2026-09-21T00:00:00.000Z") });
  const result = await service.run({ principal }, request());
  const first = await service.page({ principal }, { runId: result.run.id, limit: 1 });
  assert.deepEqual(first.rows.map(row => row.rowId), ["row-a"]);
  const second = await service.page({ principal }, { runId: result.run.id, cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second.rows.map(row => row.rowId), ["row-b"]);
  const drilldown = await service.drilldown({ principal }, { runId: result.run.id, rowId: "row-b", limit: 1 });
  assert.deepEqual(drilldown.items.map(item => item.id), ["source-b"]);
});

test("private preset revisions and package constituent filters are scoped and durable", async () => {
  const definition = getReportingDefinition("rent-roll")!;
  const registry = createReportingRegistry();
  const service = new ReportingService({ registry, store: new InMemoryReportingStore(), now: () => new Date("2026-09-21T00:00:00.000Z") });
  const access = { principal };
  const preset = await service.savePreset(access, { name: "Portfolio rent roll", reportId: definition.id, scope, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null });
  assert.equal(preset.revision, 1);
  const revised = await service.savePreset(access, { id: preset.id, expectedRevision: 1, name: "Portfolio rent roll v2", reportId: definition.id, scope, filters: { propertyScope: "active" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null });
  assert.equal(revised.revision, 2);
  await assert.rejects(() => service.savePreset(access, { id: preset.id, expectedRevision: 1, name: "stale", reportId: definition.id, scope, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null }), /Preset changed/);
  const pkg = await service.savePackage(access, { name: "Monthly package", items: [{ reportId: definition.id, definitionVersion: "1", scope, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null }] });
  assert.equal(pkg.items[0].filters.propertyScope, "all");
});

test("shared presets and packages are rechecked against every contained grant", async () => {
  const entityA = "33333333-3333-4333-8333-333333333333";
  const propertyA = "44444444-4444-4444-8444-444444444444";
  const entityB = "55555555-5555-4555-8555-555555555555";
  const propertyB = "66666666-6666-4666-8666-666666666666";
  const owner = createAuthenticatedPrincipal({ actorId, organizationId, role: "admin", authorizedScopes: [{ legalEntityId: entityA, propertyId: propertyA }] });
  const outside = createAuthenticatedPrincipal({ actorId: "77777777-7777-4777-8777-777777777777", organizationId, role: "admin", authorizedScopes: [{ legalEntityId: entityB, propertyId: propertyB }] });
  const scoped = { ...scope, legalEntityIds: [entityA], propertyIds: [propertyA] } as const;
  const registry = createReportingRegistry();
  const service = new ReportingService({ registry, store: new InMemoryReportingStore() });
  const resolvePropertyLegalEntity = async (propertyId: string) => propertyId === propertyA ? entityA : null;
  const ownerAccess = { principal: owner, resolvePropertyLegalEntity };
  const outsideAccess = { principal: outside, resolvePropertyLegalEntity };
  const preset = await service.savePreset(ownerAccess, { name: "Scoped rent roll", visibility: "shared", reportId: "rent-roll", scope: scoped, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null });
  const pkg = await service.savePackage(ownerAccess, { name: "Scoped package", visibility: "shared", items: [{ reportId: "rent-roll", definitionVersion: "1", scope: scoped, filters: { propertyScope: "all" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null }] });

  assert.equal((await service.listPresets(outsideAccess)).length, 0);
  await assert.rejects(() => service.getPreset(outsideAccess, preset.id), /not authorized|outside/);
  assert.equal((await service.listPackages(outsideAccess)).length, 0);
  await assert.rejects(() => service.getPackage(outsideAccess, pkg.id), /not authorized|outside/);
});

test("runs keep the engine's presentation order unless a sort is requested, and money sorts numerically", async () => {
  // Row IDs are content hashes in most engines; ordering by them scrambles
  // statements, T12 months and rental reports.
  const rows = [
    { rowId: "zz-income", values: { line: "Income", amountCents: "-5" } },
    { rowId: "aa-expense", values: { line: "Expense", amountCents: "-100" } },
    { rowId: "mm-net", values: { line: "Net", amountCents: "20" } },
    { rowId: "bb-other", values: { line: "Other", amountCents: "3" } },
  ];
  const registry = createReportingRegistry({ engines: [{
    key: "test.rental", reportIds: ["rent-roll"], ready: true,
    async run() {
      return { columns: [{ id: "line", label: "Line", type: "text", sortable: true, filterable: true, sensitive: false }, { id: "amountCents", label: "Amount", type: "money", sortable: true, filterable: true, sensitive: false }], rows, coverage: [], missingData: [] };
    },
  }] });
  const service = new ReportingService({ registry, store: new InMemoryReportingStore(), now: () => new Date("2026-09-21T00:00:00.000Z") });
  const unsorted = await service.run({ principal }, request());
  assert.deepEqual(unsorted.page.rows.map(row => row.rowId), ["zz-income", "aa-expense", "mm-net", "bb-other"]);
  const byAmount = await service.run({ principal }, { ...request(), sort: [{ field: "amountCents", direction: "asc" }] });
  assert.deepEqual(byAmount.page.rows.map(row => row.values.amountCents), ["-100", "-5", "3", "20"]);
  const byAmountDesc = await service.run({ principal }, { ...request(), sort: [{ field: "amountCents", direction: "desc" }] });
  assert.deepEqual(byAmountDesc.page.rows.map(row => row.values.amountCents), ["20", "3", "-5", "-100"]);
});

test("a replayed request ID cannot return an expired run, and a forged drilldown cursor is rejected", async () => {
  let now = new Date("2026-09-21T00:00:00.000Z");
  const registry = createReportingRegistry({ engines: [{
    key: "test.rental", reportIds: ["rent-roll"], ready: true,
    async run() {
      return {
        columns: [{ id: "value", label: "Value", type: "text", sortable: true, filterable: true, sensitive: false }],
        rows: [{ rowId: "row-a", values: { value: "a" } }], coverage: [], missingData: [],
        drilldowns: [{ rowId: "row-a", items: ["x", "y", "z"].map(id => ({ id, kind: "source" as const, values: { value: id } })), nextCursor: null, coverage: [], missingData: [] }],
      };
    },
  }] });
  const service = new ReportingService({ registry, store: new InMemoryReportingStore(), now: () => now, runTtlMs: 60_000 });
  const replayRequest = { ...request(), requestId: "replay-expiry-1" };
  const first = await service.run({ principal }, replayRequest);
  const forged = Buffer.from(JSON.stringify({ offset: -2, rowId: "row-a", runId: first.run.id }), "utf8").toString("base64url");
  await assert.rejects(() => service.drilldown({ principal }, { runId: first.run.id, rowId: "row-a", cursor: forged, limit: 1 }), /cursor is invalid/);
  now = new Date("2026-09-21T00:02:00.000Z");
  await assert.rejects(() => service.run({ principal }, replayRequest), /expired/);
});
