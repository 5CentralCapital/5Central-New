import assert from "node:assert/strict";
import test from "node:test";
import type { CompanyContextOrganization } from "@shared/company/context";
import { getReportingDefinitions, periodFilterNamesFor, type ReportEntry, type ReportingEngineContext } from "@shared/reporting";
import { createAuthenticatedPrincipal } from "../../../../server/company/authorization";
import { createReportingRegistry } from "../../../../server/reporting/registry";
import { ReportingService } from "../../../../server/reporting/service";
import { InMemoryReportingStore } from "../../../../server/reporting/store";
import {
  buildReportRunRequest, describeAppliedFilters, initialSetupState, normalizeForecastScenarios, runnableScenarios, visibleSetupFilters, withEntities, withProperties,
  type ReportSetupState,
} from "./setup-model";
import { packageItemFromRequest, packageRunSummary, runtimeStatusLabel } from "./workspace-model";

const organizationId = "10000000-0000-4000-8000-000000000001";
const entityA = "20000000-0000-4000-8000-000000000001";
const entityB = "20000000-0000-4000-8000-000000000002";
const organization: CompanyContextOrganization = {
  id: organizationId, name: "Example Company", role: "admin",
  entities: [
    { id: entityA, name: "Example Property LLC", currency: "USD", properties: [{ id: "property-a", name: "Demo property A", units: [{ id: "unit-a-1", unitNumber: "1A" }, { id: "unit-a-2", unitNumber: "2A" }] }] },
    { id: entityB, name: "Second Property LLC", currency: "USD", properties: [{ id: "property-b", name: "Demo property B", units: [{ id: "unit-b-1", unitNumber: "1B" }] }] },
  ],
};
const today = "2026-09-21";
const approvedSnapshotId = "91000000-0000-4000-8000-000000000004";
const scenarios = normalizeForecastScenarios({ items: [
  // The latest snapshot is a newer run; reports must still pin the approved snapshot.
  { id: "90000000-0000-4000-8000-000000000001", name: "Base case", state: "approved", currentAssumptionVersion: 4, latestSnapshot: { id: "91000000-0000-4000-8000-000000000005", modelVersion: "forecast.v2", assumptionVersion: 4 },
    approvedSnapshotId, approvedSnapshot: { id: approvedSnapshotId, modelVersion: "forecast.v1", assumptionVersion: 4 } },
  { id: "90000000-0000-4000-8000-000000000002", name: "Draft case", state: "draft", currentAssumptionVersion: 1, modelVersion: "forecast.v1" },
] });

function entries(): ReportEntry[] {
  return getReportingDefinitions().map(definition => ({ ...definition, executable: true, runtimeStatus: "available" as const, runtimeReason: null, runtimeDependency: null }));
}

function recordingService() {
  const seen: ReportingEngineContext[] = [];
  const registry = createReportingRegistry({ engines: [{
    key: "fixture.echo", reportIds: getReportingDefinitions().map(definition => definition.id), ready: true,
    async run(context) { seen.push(context); return { columns: [{ id: "value", label: "Value", type: "text", sortable: true, filterable: true, sensitive: false }], rows: [{ rowId: "row-1", values: { value: "ok" } }], coverage: [] }; },
  }] });
  const service = new ReportingService({ registry, store: new InMemoryReportingStore(), now: () => new Date(`${today}T12:00:00.000Z`) });
  const principal = createAuthenticatedPrincipal({ actorId: "setup-actor", organizationId, role: "admin", authorizedScopes: [{}] });
  const access = { principal, resolvePropertyLegalEntity: async (propertyId: string) => propertyId === "property-a" ? entityA : propertyId === "property-b" ? entityB : null };
  return { service, access, seen };
}

function stateFor(entry: ReportEntry): ReportSetupState {
  let state = initialSetupState(entry, organization, today);
  if (entry.setup.forecastScenario) state = { ...state, scenarioId: scenarios[0]!.scenarioId };
  if (entry.setup.consolidation) state = withEntities(state, organization, [entityA, entityB]);
  return state;
}

test("every report's default setup builds a request the reporting service accepts", async () => {
  const { service, access, seen } = recordingService();
  const all = entries();
  assert.equal(all.length, 53);
  for (const entry of all) {
    const built = buildReportRunRequest(entry, organization, stateFor(entry), scenarios);
    assert.ok(built.ok, `${entry.id}: ${built.ok ? "" : JSON.stringify(built.errors)}`);
    const response = await service.run(access, built.request);
    assert.equal(response.run.reportId, entry.id);
    const context = seen.at(-1)!;
    for (const name of [...periodFilterNamesFor(entry.period), "scenarioId", "inputVersion", "modelVersion", "basis", "currency"]) assert.equal(name in context.request.filters, false, `${entry.id} repeated ${name} as a filter`);
    if (entry.period !== "custom") assert.equal(context.request.period.mode, entry.period, entry.id);
    if (entry.setup.forecastScenario) assert.deepEqual(context.request.forecast, { scenarioId: scenarios[0]!.scenarioId, inputVersion: approvedSnapshotId, modelVersion: "forecast.v1" });
    if (entry.setup.forecastScenario) assert.deepEqual([context.request.scope.legalEntityIds, context.request.scope.propertyIds], [[], []], `${entry.id} is company-wide`);
    else assert.equal(context.request.forecast ?? null, null, entry.id);
    if (entry.setup.consolidation) assert.deepEqual(context.request.consolidation?.entityIds, [entityA, entityB]);
    if (entry.setup.entityScope === "exactly_one") assert.equal(context.request.scope.legalEntityIds.length, 1, entry.id);
  }
});

test("the chosen period populates the request for the reports the old form broke", async () => {
  const { service, access, seen } = recordingService();
  const byId = new Map(entries().map(entry => [entry.id, entry]));
  const balanceSheet = byId.get("balance-sheet")!;
  const state = { ...initialSetupState(balanceSheet, organization, today), asOf: "2026-06-30", basis: "accrual" as const, filters: { accountIds: ["35"], grouping: "quarter" } };
  const built = buildReportRunRequest(balanceSheet, organization, state);
  assert.ok(built.ok);
  await service.run(access, built.request);
  assert.deepEqual(seen.at(-1)!.request.period, { mode: "as_of", asOfDate: "2026-06-30" });
  assert.deepEqual(seen.at(-1)!.request.filters, { accountIds: ["35"], grouping: "quarter" });
  const statement = byId.get("rental-owner-statement")!;
  const range = buildReportRunRequest(statement, organization, { ...initialSetupState(statement, organization, today), from: "2026-07-01", through: "2026-07-31" });
  assert.ok(range.ok);
  await service.run(access, range.request);
  assert.deepEqual(seen.at(-1)!.request.period, { mode: "range", fromDate: "2026-07-01", toDate: "2026-07-31" });
  const workOrders = byId.get("work-orders")!;
  const openAsOf = buildReportRunRequest(workOrders, organization, { ...initialSetupState(workOrders, organization, today), asOf: "2026-09-01", filters: { status: ["new", "scheduled"], priority: [], category: [], assignedTo: "  Example Plumbing ", search: "" } });
  assert.ok(openAsOf.ok);
  await service.run(access, openAsOf.request);
  assert.deepEqual(seen.at(-1)!.request.period, { mode: "custom", asOfDate: "2026-09-01" });
  assert.deepEqual(seen.at(-1)!.request.filters, { status: ["new", "scheduled"], assignedTo: "Example Plumbing" });
  const scheduled = byId.get("scheduled-income")!;
  assert.deepEqual(visibleSetupFilters(scheduled).find(filter => filter.name === "asOfDate")?.label, "Status as of", "a month report keeps its secondary status date");
  const month = buildReportRunRequest(scheduled, organization, { ...initialSetupState(scheduled, organization, today), month: "2026-08" });
  assert.ok(month.ok);
  await service.run(access, month.request);
  assert.deepEqual(seen.at(-1)!.request.period, { mode: "month", month: "2026-08" });
  assert.equal("asOfDate" in seen.at(-1)!.request.filters, false, "an empty secondary date is omitted");
  const statusDated = buildReportRunRequest(scheduled, organization, { ...initialSetupState(scheduled, organization, today), month: "2026-08", filters: { ...initialSetupState(scheduled, organization, today).filters, asOfDate: "2026-08-15" } });
  assert.ok(statusDated.ok);
  await service.run(access, statusDated.request);
  assert.equal(seen.at(-1)!.request.filters.asOfDate, "2026-08-15");
});

test("setup validation names the missing field instead of sending an invalid request", () => {
  const byId = new Map(entries().map(entry => [entry.id, entry]));
  const balanceSheet = byId.get("balance-sheet")!;
  const noEntity = buildReportRunRequest(balanceSheet, organization, { ...initialSetupState(balanceSheet, organization, today), entityIds: [] });
  assert.deepEqual(noEntity.ok ? [] : noEntity.errors.map(error => error.field), ["legalEntityIds"]);
  const forecast = byId.get("cash-forecast-13-week")!;
  const noScenario = buildReportRunRequest(forecast, organization, initialSetupState(forecast, organization, today), scenarios);
  assert.deepEqual(noScenario.ok ? [] : noScenario.errors, [{ field: "forecast", message: "Choose an approved forecast scenario." }]);
  const draftScenario = buildReportRunRequest(forecast, organization, { ...initialSetupState(forecast, organization, today), scenarioId: scenarios[1]!.scenarioId }, scenarios);
  assert.equal(draftScenario.ok, false, "a draft scenario is not runnable");
  const statement = byId.get("rental-owner-statement")!;
  const backwards = buildReportRunRequest(statement, organization, { ...initialSetupState(statement, organization, today), from: "2026-08-01", through: "2026-07-01" });
  assert.deepEqual(backwards.ok ? [] : backwards.errors.map(error => error.field), ["period"]);
  const t12 = byId.get("property-t12")!;
  const badCurrency = buildReportRunRequest(t12, organization, { ...initialSetupState(t12, organization, today), currency: "US" });
  assert.deepEqual(badCurrency.ok ? [] : badCurrency.errors.map(error => error.field), ["currency"]);
});

test("forecast and consolidation are setup sections, never generic filter fields", () => {
  for (const entry of entries()) {
    const names = visibleSetupFilters(entry).map(filter => filter.name);
    for (const name of ["scenarioId", "inputVersion", "modelVersion", ...periodFilterNamesFor(entry.period), "basis", "currency", "legalEntityIds", "propertyIds"]) assert.ok(!names.includes(name), `${entry.id} exposes ${name}`);
    if (entry.source !== "rental" || entry.engineKey !== "rental.operational") assert.ok(!names.some(name => ["asOfDate", "fromDate", "toDate", "month"].includes(name)), `${entry.id} has no secondary dates`);
    const grouping = entry.filters.some(filter => filter.name === "grouping");
    assert.equal(grouping, ["balance-sheet", "cash-flow-statement", "income-statement", "income-statement-detailed"].includes(entry.id), `${entry.id} grouping`);
  }
  const byId = new Map(entries().map(entry => [entry.id, entry]));
  assert.ok(!byId.get("cash-flow-statement")!.filters.some(filter => filter.name === "accountIds"));
  for (const id of ["completed-tasks", "open-tasks", "tasks-performance", "vendor-details", "work-sessions", "contractor-exposure", "project-performance", "rehab-benchmark"]) assert.ok(!byId.get(id)!.filters.some(filter => filter.name === "vendorIds" || filter.name === "staffIds"), id);
  assert.deepEqual(byId.get("investor-owner-activity")!.filters.map(filter => filter.name), ["investorIds", "status"]);
  const consolidated = byId.get("balance-sheet-consolidated")!;
  const built = buildReportRunRequest(consolidated, organization, { ...withEntities(initialSetupState(consolidated, organization, today), organization, [entityA, entityB]), eliminationVersion: "elim-2026-q3" });
  assert.ok(built.ok);
  assert.deepEqual(built.request.consolidation, { entityIds: [entityA, entityB], currency: "USD", ownershipPolicy: "full_control", eliminationPolicy: "approved_version", eliminationVersion: "elim-2026-q3", translationPolicy: "none" });
});

test("changing entities or properties clears selections that no longer apply", () => {
  const byId = new Map(entries().map(entry => [entry.id, entry]));
  const unit = byId.get("income-statement-by-unit")!;
  let state = withProperties(withEntities(initialSetupState(unit, organization, today), organization, [entityA, entityB]), organization, ["property-a", "property-b"]);
  state = { ...state, filters: { ...state.filters, unitIds: ["unit-a-1", "unit-b-1"] } };
  const narrowed = withEntities(state, organization, [entityB]);
  assert.deepEqual(narrowed.propertyIds, ["property-b"]);
  assert.deepEqual(narrowed.filters.unitIds, ["unit-b-1"]);
  const built = buildReportRunRequest(unit, organization, narrowed);
  assert.ok(built.ok);
  assert.deepEqual(built.request.scope.propertyIds, ["property-b"]);
  assert.deepEqual(built.request.filters.unitIds, ["unit-b-1"]);
  const labels = describeAppliedFilters(unit, built.request, organization, { "unitIds:unit-b-1": "Demo property B · 1B" });
  assert.deepEqual(labels, ["Second Property LLC", "Demo property B · Second Property LLC", "Cash basis", "Units: Demo property B · 1B"]);
});

test("scenario payloads normalize without exposing raw versions and unknown shapes yield nothing", () => {
  assert.deepEqual(runnableScenarios(scenarios).map(item => item.name), ["Base case"]);
  assert.deepEqual(normalizeForecastScenarios([{ scenarioId: "s1", name: "Plain", status: "approved", approvedSnapshotId: "snap-7", modelVersion: "m2" }]), [{ scenarioId: "s1", name: "Plain", state: "approved", inputVersion: "snap-7", modelVersion: "m2" }]);
  // Without an approved snapshot a scenario is not runnable, even with a latest snapshot or version.
  const unapproved = normalizeForecastScenarios([{ id: "s3", name: "Latest only", state: "approved", currentAssumptionVersion: 2, latestSnapshot: { id: "snap-9", modelVersion: "m2" }, approvedSnapshotId: null }]);
  assert.deepEqual(unapproved, [{ scenarioId: "s3", name: "Latest only", state: "approved", inputVersion: null, modelVersion: null }]);
  assert.equal(runnableScenarios(unapproved).length, 0);
  assert.deepEqual(normalizeForecastScenarios({ unexpected: true }), []);
  assert.deepEqual(normalizeForecastScenarios(null), []);
  assert.equal(runnableScenarios(normalizeForecastScenarios([{ id: "s2", name: "No run", state: "approved", currentAssumptionVersion: 0 }])).length, 0);
});

test("package helpers freeze the executed request and label incomplete runs", () => {
  const entry = entries().find(item => item.id === "rent-roll")!;
  const built = buildReportRunRequest(entry, organization, initialSetupState(entry, organization, today));
  assert.ok(built.ok);
  const first = packageItemFromRequest(built.request, "Rent roll", []);
  const second = packageItemFromRequest(built.request, "Rent roll", [first]);
  assert.deepEqual([first.id, second.id], ["rent-roll-1", "rent-roll-2"]);
  assert.deepEqual(first.period, built.request.period);
  const base = { id: "a0000000-0000-4000-8000-000000000001", packageId: "a0000000-0000-4000-8000-000000000002", organizationId, actorId: "setup-actor", permissionFingerprint: "0".repeat(64), state: "ready" as const, createdAt: "2026-09-21T00:00:00.000Z", readyAt: null, expiresAt: null };
  assert.deepEqual(packageRunSummary({ ...base, completeness: "complete", itemRuns: [{ itemId: "rent-roll-1", runId: null, state: "ready", errorCode: null, completeness: "complete" }] }), { complete: true, label: "All 1 reports complete" });
  assert.deepEqual(packageRunSummary({ ...base, completeness: "incomplete", itemRuns: [{ itemId: "rent-roll-1", runId: null, state: "ready", errorCode: null, completeness: "incomplete" }, { itemId: "rent-roll-2", runId: null, state: "failed", errorCode: "report_unavailable" }] }), { complete: false, label: "Package incomplete: 1 failed, 1 incomplete" });
  // A stored run without completeness is never presented as complete.
  assert.equal(packageRunSummary({ ...base, itemRuns: [{ itemId: "rent-roll-1", runId: null, state: "ready", errorCode: null }] }).complete, false);
  assert.deepEqual(["available", "missing_data", "not_implemented"].map(status => runtimeStatusLabel(status as never)), ["Available", "Needs data", "Not implemented"]);
});

test("a saved preset keeps its pinned forecast input and forecast reports drop entity and property choices", () => {
  const forecast = entries().find(entry => entry.id === "cash-forecast-13-week")!;
  assert.deepEqual(forecast.scopes, ["organization"]);
  assert.equal(forecast.setup.propertyScope, false);
  const pinned = { scenarioId: scenarios[0]!.scenarioId, inputVersion: "91000000-0000-4000-8000-000000000003", modelVersion: "forecast.v0" };
  const seeded = buildReportRunRequest(forecast, organization, { ...initialSetupState(forecast, organization, today), scenarioId: scenarios[0]!.scenarioId }, scenarios);
  assert.ok(seeded.ok);
  const preset = { ...seeded.request, forecast: pinned };
  const state = initialSetupState(forecast, organization, today, preset);
  const rebuilt = buildReportRunRequest(forecast, organization, state, scenarios);
  assert.ok(rebuilt.ok);
  assert.deepEqual(rebuilt.request.forecast, pinned, "the preset's pinned input is kept");
  // Choosing another scenario drops the pin; an entity chosen earlier never reaches a company-wide report.
  const other = buildReportRunRequest(forecast, organization, { ...withEntities(state, organization, [entityA]), scenarioId: scenarios[0]!.scenarioId, forecastPin: { ...pinned, scenarioId: "90000000-0000-4000-8000-000000000009" } }, scenarios);
  assert.ok(other.ok);
  assert.deepEqual(other.request.forecast, { scenarioId: scenarios[0]!.scenarioId, inputVersion: approvedSnapshotId, modelVersion: "forecast.v1" });
  assert.deepEqual(other.request.scope.legalEntityIds, []);
});
