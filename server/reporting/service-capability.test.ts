import assert from "node:assert/strict";
import test from "node:test";
import { reportEntrySchema, type ReportingEngineResult } from "../../shared/reporting";
import { createAuthenticatedPrincipal } from "../company/authorization";
import { createReportingDomainEngines, FORECAST_MISSING_REASON } from "./domain-engines";
import { createReportingRegistry, REPORT_NOT_IMPLEMENTED_REASON, type ReportingEngine } from "./registry";
import { InMemoryReportingStore } from "./store";
import { ReportingService } from "./service";
import { ReportingError } from "./errors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const entityA = "33333333-3333-4333-8333-333333333333";
const entityB = "44444444-4444-4444-8444-444444444444";
const principal = createAuthenticatedPrincipal({ actorId: "capability-actor", organizationId, role: "admin", authorizedScopes: [{}] });
const scope = { organizationId, legalEntityIds: [] as string[], propertyIds: [] as string[], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] };

function result(state: "complete" | "partial", missing = false): ReportingEngineResult {
  return {
    columns: [{ id: "value", label: "Value", type: "text", sortable: true, filterable: true, sensitive: false }],
    rows: [{ rowId: "r1", values: { value: "a" } }],
    coverage: [{ source: "fixture", state, evidence: "synthetic", basis: "operational", watermark: null, observedAt: "2026-09-21T00:00:00.000Z", coveredFrom: null, coveredThrough: null, rowCount: 1, reason: state === "complete" ? null : "Fixture is partial." }],
    missingData: missing ? [{ code: "fixture_gap", state: "unknown", message: "A fixture value is unknown." }] : [],
  };
}

test("catalog reports available, missing data with the exact reason, and not implemented", async () => {
  const engines: ReportingEngine[] = [
    { key: "fixture.ready", reportIds: ["rent-roll"], ready: true, async run() { return result("complete"); } },
    { key: "fixture.probe", reportIds: ["work-orders"], ready: true, async probe() { return { status: "missing_data", reason: "No work orders are recorded yet.", dependency: "company_work_orders" }; }, async run() { return result("complete"); } },
    { key: "fixture.failing-probe", reportIds: ["open-tasks"], ready: true, async probe() { throw new ReportingError("report_unavailable", "Project tasks could not be checked.", 409, { dependency: "company_project_tasks" }); }, async run() { return result("complete"); } },
    ...createReportingDomainEngines({}).filter(engine => engine.key === "combined.forecast"),
  ];
  const service = new ReportingService({ registry: createReportingRegistry({ engines }), store: new InMemoryReportingStore() });
  const entries = await service.catalog({ principal });
  assert.equal(entries.length, 53);
  for (const entry of entries) reportEntrySchema.parse(entry);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  assert.equal(byId.get("rent-roll")?.runtimeStatus, "available");
  assert.deepEqual([byId.get("work-orders")?.runtimeStatus, byId.get("work-orders")?.runtimeReason, byId.get("work-orders")?.runtimeDependency], ["missing_data", "No work orders are recorded yet.", "company_work_orders"]);
  assert.deepEqual([byId.get("open-tasks")?.runtimeStatus, byId.get("open-tasks")?.runtimeDependency], ["missing_data", "company_project_tasks"]);
  assert.deepEqual([byId.get("cash-forecast-13-week")?.runtimeStatus, byId.get("cash-forecast-13-week")?.runtimeReason], ["missing_data", FORECAST_MISSING_REASON]);
  assert.deepEqual([byId.get("delinquency")?.runtimeStatus, byId.get("delinquency")?.runtimeReason], ["not_implemented", REPORT_NOT_IMPLEMENTED_REASON]);
  assert.equal(entries.filter(entry => entry.executable).length, 1);
  await assert.rejects(() => service.run({ principal }, { reportId: "delinquency", definitionVersion: "1", scope, filters: {}, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null }), (error: unknown) => error instanceof ReportingError && error.details.runtimeStatus === "not_implemented");
});

test("setup rules are enforced by the service, not just the form", async () => {
  const run = async () => result("complete");
  const service = new ReportingService({ registry: createReportingRegistry({ engines: [
    { key: "fixture.qbo", reportIds: ["balance-sheet"], ready: true, run },
    { key: "fixture.consolidated", reportIds: ["income-statement-consolidated"], ready: true, run },
    { key: "fixture.rental", reportIds: ["rent-roll", "current-tenants"], ready: true, run },
  ] }), store: new InMemoryReportingStore() });
  const access = { principal, resolvePropertyLegalEntity: async () => entityA };
  const qbo = { reportId: "balance-sheet", definitionVersion: "1", scope: { ...scope, legalEntityIds: [entityA] }, filters: { grouping: "month" }, period: { mode: "as_of" as const, asOfDate: "2026-08-31" }, basis: "accrual" as const, currency: "USD" };
  assert.equal((await service.run(access, qbo as never)).run.filters.grouping, "month");
  await assert.rejects(() => service.run(access, { ...qbo, scope: { ...qbo.scope, legalEntityIds: [entityA, entityB] } } as never), /exactly one legal entity/);
  await assert.rejects(() => service.run(access, { ...qbo, scope: { ...qbo.scope, propertyIds: ["property-a"] } } as never), /whole legal entities/);
  await assert.rejects(() => service.run(access, { ...qbo, basis: "operational", currency: null } as never), /supports cash or accrual/);
  await assert.rejects(() => service.run(access, { ...qbo, filters: { accountIds: ["1"], vendorIds: ["x"] } } as never), /unsupported fields/);
  const consolidated = { reportId: "income-statement-consolidated", definitionVersion: "1", scope: { ...scope, legalEntityIds: [entityA, entityB] }, filters: {}, period: { mode: "range" as const, fromDate: "2026-08-01", toDate: "2026-08-31" }, basis: "accrual" as const, currency: "USD", consolidation: { entityIds: [entityA, entityB], currency: "USD", ownershipPolicy: "full_control" as const, eliminationPolicy: "none" as const, translationPolicy: "none" as const } };
  assert.equal((await service.run(access, consolidated as never)).run.consolidation?.eliminationPolicy, "none");
  // Earlier clients repeated the period as filters; identical values are dropped, conflicting ones rejected.
  const rent = { reportId: "rent-roll", definitionVersion: "1", scope, filters: { propertyScope: "all", asOfDate: "2026-09-21" }, period: { mode: "as_of" as const, asOfDate: "2026-09-21" }, basis: "operational" as const, currency: null };
  const rentRun = await service.run(access, rent as never);
  assert.equal(rentRun.run.filters.propertyScope, "all");
  assert.equal("asOfDate" in rentRun.run.filters, false);
  await assert.rejects(() => service.run(access, { ...rent, filters: { asOfDate: "2026-01-01" } } as never), /period field/);
  await assert.rejects(() => service.run(access, { reportId: "current-tenants", definitionVersion: "1", scope, filters: { asOfDate: "2026-01-01" }, period: { mode: "as_of", asOfDate: "2026-09-21" }, basis: "operational", currency: null } as never), /period field/);
});

test("package runs label partial and failed constituents incomplete", async () => {
  const service = new ReportingService({ registry: createReportingRegistry({ engines: [
    { key: "fixture.complete", reportIds: ["rent-roll"], ready: true, async run() { return result("complete"); } },
    { key: "fixture.partial", reportIds: ["current-tenants"], ready: true, async run() { return result("partial"); } },
    { key: "fixture.unknown", reportIds: ["unit-listings"], ready: true, async run() { return result("complete", true); } },
    { key: "fixture.failed", reportIds: ["renters-insurance"], ready: true, async run() { throw new ReportingError("report_unavailable", "Renters insurance source is unavailable.", 409); } },
  ] }), store: new InMemoryReportingStore(), now: () => new Date("2026-09-21T00:00:00.000Z") });
  const item = (reportId: string) => ({ reportId, definitionVersion: "1", scope, filters: {}, period: { mode: "as_of" as const, asOfDate: "2026-09-21" }, basis: "operational" as const, currency: null, consolidation: null, forecast: null, columns: [], sort: [] });
  const complete = await service.savePackage({ principal }, { name: "Complete", items: [item("rent-roll")] });
  const completeRun = await service.runPackage({ principal }, complete.id);
  assert.equal(completeRun.completeness, "complete");
  assert.equal(completeRun.itemRuns[0]?.completeness, "complete");
  const mixed = await service.savePackage({ principal }, { name: "Mixed", items: [item("rent-roll"), item("current-tenants"), item("unit-listings"), item("renters-insurance")] });
  assert.equal(mixed.items.length, 4);
  const mixedRun = await service.runPackage({ principal }, mixed.id);
  assert.equal(mixedRun.state, "ready");
  assert.equal(mixedRun.completeness, "incomplete");
  assert.equal(mixedRun.packageRevision, 1);
  assert.deepEqual(mixedRun.itemRuns.map(run => [run.reportId, run.state, run.completeness]), [["rent-roll", "ready", "complete"], ["current-tenants", "ready", "incomplete"], ["unit-listings", "ready", "incomplete"], ["renters-insurance", "failed", "incomplete"]]);
  assert.equal(mixedRun.itemRuns[1]?.reason, "Fixture is partial.");
  assert.equal(mixedRun.itemRuns[2]?.reason, "A fixture value is unknown.");
  assert.equal(mixedRun.itemRuns[3]?.reason, "Renters insurance source is unavailable.");
  assert.deepEqual(await service.getPackageRun({ principal }, mixedRun.id), mixedRun);
  const failing = await service.savePackage({ principal }, { name: "Failing", items: [item("renters-insurance")] });
  assert.equal((await service.runPackage({ principal }, failing.id)).state, "failed");
  // Editing a package requires the current revision.
  await assert.rejects(() => service.savePackage({ principal }, { id: mixed.id, name: "Stale", items: [item("rent-roll")] }), /current revision/);
  const edited = await service.savePackage({ principal }, { id: mixed.id, expectedRevision: 1, name: "Mixed v2", items: [item("rent-roll"), item("unit-listings")] });
  assert.equal(edited.revision, 2);
  await assert.rejects(() => service.savePackage({ principal }, { id: mixed.id, expectedRevision: 1, name: "Stale", items: [item("rent-roll")] }), /Package changed/);
});

test("reference lookups require a report role and explain when no reader is connected", async () => {
  const service = new ReportingService({ registry: createReportingRegistry({ engines: [] }), store: new InMemoryReportingStore() });
  assert.equal((await service.references({ principal }, { kind: "project" })).reason, "Named selections are not connected for this company.");
  const outsider = createAuthenticatedPrincipal({ actorId: "field", organizationId, role: "restricted_vendor", authorizedScopes: [{}] });
  await assert.rejects(() => service.references({ principal: outsider }, { kind: "project" }), /cannot read reports/);
  await assert.rejects(() => service.catalog({ principal: outsider }), /cannot read reports/);
});
