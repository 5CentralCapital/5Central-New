import assert from "node:assert/strict";
import test from "node:test";
import type { AdminSnapshot, RentRollRow } from "../types";
import { brandedReportCsv, brandedReportHtml, exportPeriodLabel, exportPropertyOptions, initialExportPropertyScope, exportQueryFilters, exportSelectionError, prepareReportExport, type ReportExportSelection } from "./report-export";
const selection: ReportExportSelection = { propertyScope: "active", propertyIds: ["p2"], asOfDate: "2026-09-10", month: "2026-08", fromDate: "2026-08-01", toDate: "2026-08-31", tenantStatus: "current" };
const snapshot = { snapshot: { properties: [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }], people: [], units: [], tenancies: [] } } as AdminSnapshot;
test("export selection replaces stale property and date query scope while preserving report view", () => {
  const query = exportQueryFilters("rent-roll", { propertyScope: "active", propertyId: "p1", propertyIds: ["p1"], asOfDate: "2026-09-12", fromDate: "2025-01-01", month: "2025-01", occupancy: ["vacant"], balanceStatus: "unverified" }, selection);
  assert.deepEqual(query, { propertyScope: "active", propertyIds: ["p2"], asOfDate: "2026-09-10", occupancy: ["vacant"], balanceStatus: "unverified" });
  const all = exportQueryFilters("rent-roll", query, { ...selection, propertyIds: [] });
  assert.equal(all.propertyId, undefined); assert.equal(all.propertyIds, undefined); assert.equal(all.propertyScope, "active");
  assert.equal(exportQueryFilters("rent-roll", query, { ...selection, propertyScope: "all", propertyIds: [] }).propertyScope, "all");
  assert.equal(exportPeriodLabel("rent-roll", selection), "As of 2026-09-10");
});
test("activity export uses an inclusive server date range and explicit tenant selection", () => {
  const query = exportQueryFilters("collected-income", { month: "2025-01", tenantStatus: "former" }, selection);
  assert.equal(query.fromDate, "2026-08-01"); assert.equal(query.toDate, "2026-08-31"); assert.equal(query.month, undefined);
  assert.equal(exportPeriodLabel("collected-income", selection), "From 2026-08-01 through 2026-08-31 (inclusive)");
  assert.equal(exportQueryFilters("delinquency", { tenantStatus: "former" }, selection).tenantStatus, "current");
  assert.equal(exportQueryFilters("delinquency", {}, { ...selection, tenantStatus: "former" }).tenantStatus, "former");
  assert.match(exportSelectionError("collected-income", { ...selection, fromDate: "2026-09-01" })!, /start date/);
  assert.match(exportSelectionError("rent-roll", { ...selection, asOfDate: "2026-02-30" })!, /valid report date/);
});
test("exports rebuild property groups and totals from selected rows and retain unknown money", () => {
  const rows: RentRollRow[] = [
    { propertyId: "p1", unitId: "u1", unitNumber: "1", occupancy: "current", baseRentCents: 99900, operationalBalanceCents: 12300 },
    { propertyId: "p2", unitId: "u2", unitNumber: "2", occupancy: "current", baseRentCents: 120000, operationalBalanceCents: null },
    { propertyId: "p2", unitId: "u3", unitNumber: "3", occupancy: "vacant", baseRentCents: 90000, operationalBalanceCents: 0 },
  ];
  const result = prepareReportExport("rent-roll", rows, snapshot, selection, { localFilters: { propertyIds: ["p1"], occupancy: "current" } });
  assert.equal(result.rows.length, 1); assert.equal(result.groups.length, 1); assert.equal(result.groups[0].propertyId, "p2");
  assert.equal(result.rows[0].__source.operationalBalanceCents, null);
  const all = prepareReportExport("rent-roll", rows, snapshot, { ...selection, propertyIds: [] }, { localFilters: { propertyIds: ["p1"] } });
  assert.equal(all.rows.length, 3);
  const header = { title: "Rent Roll", properties: "Two <test>", period: exportPeriodLabel("rent-roll", selection) };
  const html = brandedReportHtml(header, result); const csv = brandedReportCsv(header, result);
  assert.match(html, /5Central Capital/); assert.match(html, /Two &lt;test&gt;/); assert.match(html, /As of 2026-09-10/); assert.doesNotMatch(html, /999\.00/);
  assert.match(csv, /^"5Central Capital"\n"Rent Roll"/); assert.doesNotMatch(csv, /999\.00/);
});
test("monthly exports send the selected month without stale activity range and validate cutoff", () => {
  for (const report of ["scheduled-income", "scheduled-vs-collected", "hap"] as const) {
    const query = exportQueryFilters(report, { month: "2026-09", fromDate: "2026-09-01", toDate: "2026-09-12" }, selection);
    assert.equal(query.month, "2026-08"); assert.equal(query.fromDate, undefined); assert.equal(query.toDate, undefined);
    assert.equal(exportPeriodLabel(report, selection), "Month 2026-08 · As of 2026-09-10");
    assert.match(exportSelectionError(report, { ...selection, month: "2026-10" })!, /cannot be after/);
  }
});

test("property picker defaults active, retains explicit inactive selection, and sorts active properties first", () => {
  const directory = { snapshot: { properties: [{ id: "old", name: "A old", state: "inactive" }, { id: "z", name: "Z active", state: "active" }, { id: "a", name: "A active", state: "active" }] } } as AdminSnapshot;
  assert.equal(initialExportPropertyScope({}, directory), "active");
  assert.equal(initialExportPropertyScope({ propertyScope: "active", propertyId: "old" }, directory), "all");
  assert.equal(initialExportPropertyScope({ propertyScope: "all" }, directory), "all");
  assert.deepEqual(exportPropertyOptions(directory, "active").map(property => property.id), ["a", "z"]);
  assert.deepEqual(exportPropertyOptions(directory, "all").map(property => property.id), ["a", "z", "old"]);
});

test("property-scoped ledger export retains person-level opening balances without assigning a property", () => {
  const opening = { rowType: "opening_balance", openingBalanceCents: 109000, transaction: { id: "opening:p", personId: "resident", postedOn: "2026-09-01", description: "Opening balance" }, runningBalanceCents: 109000 };
  const inScope = { rowType: "transaction", transaction: { id: "tx1", personId: "resident", propertyId: "p2", postedOn: "2026-09-02", description: "Payment", amountCents: 10000, kind: "payment" }, runningBalanceCents: 99000 };
  const elsewhere = { ...inScope, transaction: { ...inScope.transaction, id: "tx2", propertyId: "p1" } };
  const result = prepareReportExport("tenant-ledger", [opening, inScope, elsewhere] as any, snapshot, selection);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.some(row => row.__source === opening));
  assert.equal((opening.transaction as any).propertyId, undefined);
  assert.ok(result.groups.some(group => group.label === "Account opening balances · selected report scope"));
  assert.ok(!result.rows.some(row => row.__source === elsewhere));
});
