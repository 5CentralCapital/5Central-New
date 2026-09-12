import assert from "node:assert/strict";
import test from "node:test";
import type { DelinquencyRow, RentRollRow, ScheduledIncomeRow } from "../types";
import {
  buildPropertySubtotals,
  defaultReportOccupancy,
  formatReportCellValue,
  getReportConfig,
  filterReportLocalRows,
  groupReportRows,
  reportCellPersonId,
  filterRentRollRows,
  isOccupancyReport,
  occupancyReportStatusOptions,
  buildReportCsv,
  projectReportGridView,
  createReportViewModel,
  discoverOptionalReportColumns,
  filterReportRowsForDisplay,
  formatReportValue,
  reportQueryFilters,
  reportQueryKey,
  reportKeys,
  validateReportPeriod,
} from "./report-model";

test("curated report mappings keep drilldown IDs out of display columns", () => {
  const rows: RentRollRow[] = [{
    propertyId: "property:one",
    propertyName: "One",
    unitId: "unit:one",
    unitNumber: "101",
    currentPersonId: "person:one",
    currentTenantName: "Resident One",
    occupancy: "current",
    marketRentCents: 125000,
    balanceDueCents: 0,
  }];
  const view = createReportViewModel("rent-roll", rows);
  assert.deepEqual(view.curatedColumns.map(column => column.label), ["Unit", "Tenant", "Recurring rent", "Other recurring", "Monthly total", "Balance due"]);
  assert.equal(view.curatedColumns.some((column) => /id$/i.test(column.key)), false);
  assert.equal(view.displayRows[0].unitNumber, "101");
  assert.equal(view.displayRows[0].__source.unitId, "unit:one");
  assert.equal(formatReportValue(view.displayRows[0].marketRentCents, "currency"), "$1,250.00");
});

test("property subtotals sum complete amounts and withhold incomplete balance totals", () => {
  const rows: DelinquencyRow[] = [
    { propertyId: "property:one", propertyName: "One", unitId: "unit:one", rentOnlyBalanceCents: 15000, totalBalanceCents: 15000, balanceComplete: true },
    { propertyId: "property:one", propertyName: "One", unitId: "unit:two", rentOnlyBalanceCents: 25000, totalBalanceCents: null, balanceComplete: false },
    { propertyId: "property:two", propertyName: "Two", unitId: "unit:three", rentOnlyBalanceCents: 0, totalBalanceCents: 0, balanceComplete: true },
  ];
  const subtotals = buildPropertySubtotals("delinquency", rows);
  assert.deepEqual(subtotals.map((item) => [item.label, item.count]), [["One", 2], ["Two", 1]]);
  assert.equal(subtotals[0].amounts.rentOnlyBalanceCents, null);
  assert.equal(subtotals[0].amounts.totalBalanceCents, null);
  assert.equal(subtotals[1].amounts.rentOnlyBalanceCents, 0);
});

test("scheduled income subtotal does not turn an uncertain amount into a total", () => {
  const rows: ScheduledIncomeRow[] = [
    { propertyId: "property:one", propertyName: "One", amountCents: 100000, category: "base_rent", known: true },
    { propertyId: "property:one", propertyName: "One", amountCents: 50000, category: "base_rent", known: true, temporalUncertainty: true },
  ];
  const [subtotal] = buildPropertySubtotals("scheduled-income", rows);
  assert.equal(subtotal.amounts.amountCents, null);
});

test("optional positive fields are available while identity fields stay hidden", () => {
  const rows: RentRollRow[] = [{
    propertyId: "property:one",
    unitId: "unit:one",
    propertyName: "One",
    unitNumber: "101",
    balanceComplete: false,
    balanceUncertaintyCodes: ["history_incomplete"],
    exceptionCodes: ["missing_lease"],
  }];
  const optional = discoverOptionalReportColumns("rent-roll", rows);
  assert.ok(optional.some((column) => column.key === "balanceComplete"));
  assert.ok(optional.some((column) => column.key === "exceptionCodes"));
  assert.equal(optional.some((column) => /id$/i.test(column.key)), false);
});

test("display filtering matches a selected property and searchable visible values", () => {
  const rows: RentRollRow[] = [
    { propertyId: "property:one", propertyName: "One", unitNumber: "101", currentTenantName: "Alex Rivera" },
    { propertyId: "property:two", propertyName: "Two", unitNumber: "201", currentTenantName: "Jamie Lee" },
  ];
  const filtered = filterReportRowsForDisplay(rows, "rent-roll", { propertyId: "property:one", propertyScope: "all", status: "all", search: "alex" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].propertyId, "property:one");
});

test("period validation and query construction preserve report date boundaries", () => {
  assert.equal(validateReportPeriod("collected-income", "2026-09-12", "2026-09", "2026-09-01", "2026-09-12"), undefined);
  assert.match(validateReportPeriod("collected-income", "2026-09-12", "2026-09", "2026-09-12", "2026-09-01") ?? "", /start date/i);
  assert.match(validateReportPeriod("scheduled-income", "2026-09-12", "2026-10", "", "") ?? "", /after/i);
  const query = reportQueryFilters({ propertyScope: "active", propertyId: "property:one", asOfDate: "2026-09-12", status: "all", search: "" }, "collected-income", { asOfDate: "2026-09-12", fromDate: "2026-09-01", toDate: "2026-09-12" });
  assert.deepEqual(query, { propertyScope: "active", propertyId: "property:one", asOfDate: "2026-09-12", fromDate: "2026-09-01", toDate: "2026-09-12" });
});

test("missing base rent, uncertain deposits and HAP exceptions never display false totals", () => {
  const rent = createReportViewModel("rent-roll", [{ propertyId: "one", totalScheduledCents: 0 }]);
  assert.equal(rent.displayRows[0].totalScheduledCents, null);
  const deposits = createReportViewModel("security-deposit", [{ totalHeldCents: 10000, unknownHeldCount: 1 }]);
  assert.equal(deposits.displayRows[0].totalHeldCents, null);
  const hap = createReportViewModel("hap", [{ expectedTotalCents: 0, receivedAgencyCents: 5000, exception: true }]);
  assert.equal(hap.displayRows[0].expectedTotalCents, null);
  assert.equal(hap.displayRows[0].receivedAgencyCents, 5000);
});

test("all eleven reports have explicit columns and ledger running balance is not additive", () => {
  for (const key of reportKeys()) {
    const view = createReportViewModel(key, []);
    assert.ok(view.curatedColumns.length >= 5, key);
    assert.equal(view.curatedColumns.some(column => /Id$/.test(column.key)), false);
  }
  assert.equal(createReportViewModel("tenant-ledger", []).columns.find(column => column.key === "runningBalanceCents")?.subtotal, false);
});

test("report queries participate in workspace mutation invalidation", () => {
  assert.deepEqual(reportQueryKey("rent-roll", {asOfDate: "2026-09-12"}, "manager-a"), ["rent-ops-workspace", "report", "manager-a", "rent-roll", {asOfDate: "2026-09-12"}]);
});

test("export projection preserves every filtered row, current sort and visible column order", () => {
  const view = createReportViewModel("rent-roll", Array.from({length: 30}, (_, index) => ({unitId: `unit:${index}`, unitNumber: String(index), marketRentCents: index * 100})));
  const sorted = view.displayRows.slice(2).reverse();
  const projection = projectReportGridView(sorted, ["marketRentCents", "unitNumber"]);
  const columns = projection.columnKeys.map(key => view.columns.find(column => column.key === key)!);
  const csv = buildReportCsv(projection.rows, columns);
  assert.equal(csv.split("\n").length, 29);
  assert.equal(csv.split("\n")[0], "Market rent,Unit");
  assert.equal(csv.split("\n")[1], "$29.00,29");
  assert.equal(projection.signature, projectReportGridView([...sorted], [...projection.columnKeys]).signature);
  assert.notEqual(projection.signature, projectReportGridView([...sorted].reverse(), projection.columnKeys).signature);
});

test("direct authenticated user changes cannot reuse another user's report cache", () => {
  const filters = {asOfDate: "2026-09-12"};
  const cache = new Map<string, unknown>();
  cache.set(JSON.stringify(reportQueryKey("rent-roll", filters, "manager-a")), [{tenantName: "Private A resident"}]);
  assert.equal(cache.get(JSON.stringify(reportQueryKey("rent-roll", filters, "manager-b"))), undefined);
  assert.notDeepEqual(reportQueryKey("delinquency", filters, "manager-a"), reportQueryKey("delinquency", filters, "manager-b"));
});

test("rent roll text search leaves the scoped dated server query and cache key unchanged", () => {
  const filters = { propertyScope: "active" as const, propertyId: "property:one", asOfDate: "2026-09-12", status: "current", search: "" };
  const period = { asOfDate: "2026-09-12" };
  const original = reportQueryFilters(filters, "rent-roll", period);
  for (const search of ["a", "alex", "  alex  ", ""]) {
    const query = reportQueryFilters({ ...filters, search }, "rent-roll", period);
    assert.deepEqual(reportQueryKey("rent-roll", query, "operator"), reportQueryKey("rent-roll", original, "operator"));
    assert.equal(query.search, undefined);
    assert.equal(query.propertyId, "property:one"); assert.deepEqual(query.occupancy, ["current"]); assert.equal(query.status, undefined); assert.equal(query.asOfDate, period.asOfDate);
  }
  assert.equal(reportQueryFilters({ ...filters, search: " alex " }, "delinquency", period).search, "alex");
  assert.notDeepEqual(reportQueryFilters({ ...filters, propertyId: "property:two" }, "rent-roll", period), original);
});

test("local rent roll search matches property unit current and future names and uses identical export rows", () => {
  const rows: RentRollRow[] = [
    { propertyId: "p", propertyName: "Sun Cove", unitId: "u1", unitNumber: "D4", currentTenantName: "Alex Jones", occupancy: "current", baseRentCents: 100000 },
    { propertyId: "p", propertyName: "Sun Cove", unitId: "u2", unitNumber: "C7", futureTenantName: "Kim James", occupancy: "future", baseRentCents: 130000 },
    { propertyId: "other", propertyName: "Summit", unitId: "u3", unitNumber: "A1", currentTenantName: "Other Resident", occupancy: "current", baseRentCents: 90000 },
  ];
  for (const [query, expected] of [["sun cove", ["u1", "u2"]], [" d4 ", ["u1"]], ["ALEX", ["u1"]], ["kim james", ["u2"]], ["cove d4", ["u1"]], ["no match", []]] as const) {
    const filtered = filterRentRollRows(rows, query);
    assert.deepEqual(filtered.map(row => row.unitId), expected);
    const view = createReportViewModel("rent-roll", filtered);
    const grid = projectReportGridView(view.displayRows, view.curatedColumns.map(column => column.key));
    assert.deepEqual(grid.rows.map(row => row.__source), filtered);
    assert.equal(buildPropertySubtotals("rent-roll", grid.rows.map(row => row.__source)).reduce((sum, subtotal) => sum + subtotal.count, 0), filtered.length);
    const csv = buildReportCsv(grid.rows, view.curatedColumns);
    assert.equal(csv.split(/\r?\n/).length, filtered.length + 1);
  }
  assert.equal(filterRentRollRows(rows, ""), rows);
});

test("occupancy status controls send the exact API field and filter report rows", async () => {
  const { syntheticRentOpsSnapshot } = await import("../../../../../server/rent-ops/fixtures/synthetic");
  const { deriveRentRoll, deriveOccupancy } = await import("../../../../../server/rent-ops/domain/reports");
  const { OCCUPANCY_STATES, rentOpsFiltersSchema } = await import("../../../../../shared/rent-ops-contracts");
  assert.deepEqual(occupancyReportStatusOptions.map(([value]) => value), ["all", ...OCCUPANCY_STATES]);
  const snapshot = syntheticRentOpsSnapshot();
  const filters = { propertyScope: "all" as const, propertyId: "all", asOfDate: "2026-08-15", status: "all", search: "" };
  for (const key of ["rent-roll", "occupancy"] as const) {
    assert.equal(isOccupancyReport(key), true);
    const derive = key === "rent-roll" ? deriveRentRoll : deriveOccupancy;
    const all = derive(snapshot, { asOfDate: filters.asOfDate, propertyScope: "all" });
    assert.ok(all.some(row => row.occupancy === "current") && all.some(row => row.occupancy !== "current"));
    for (const status of OCCUPANCY_STATES) {
      const query = reportQueryFilters({ ...filters, status }, key, { asOfDate: filters.asOfDate });
      assert.equal(query.status, undefined); assert.deepEqual(query.occupancy, [status]);
      const result = derive(snapshot, rentOpsFiltersSchema.parse(query));
      assert.deepEqual(result.map(row => row.unitId), all.filter(row => row.occupancy === status).map(row => row.unitId));
    }
    for (const status of ["all", "not_ready", "off_market"]) {
      const query = reportQueryFilters({ ...filters, status }, key, { asOfDate: filters.asOfDate });
      assert.equal(query.status, undefined); assert.equal(query.occupancy, undefined);
    }
  }
  assert.deepEqual(reportQueryFilters({ ...filters, status: "current" }, "lease-expiration", { asOfDate: filters.asOfDate }).status, ["current"]);
});


test("grouped rent roll uses natural unit order and full filtered subtotals", () => {
  const rows: RentRollRow[] = [
    { propertyId: "b", propertyName: "Second", unitNumber: "1", baseRentCents: 100, balanceDueCents: 0, balanceComplete: true },
    ...["10", "2", "1"].map(unitNumber => ({ propertyId: "a", propertyName: "First", unitNumber, baseRentCents: 10000, recurringFeesCents: 1000, totalScheduledCents: 11000, subsidyCents: 5000, balanceDueCents: 0, balanceComplete: true })),
  ];
  const view = createReportViewModel("rent-roll", rows);
  const groups = groupReportRows("rent-roll", view.displayRows);
  assert.deepEqual(groups.map(group => group.label), ["First", "Second"]);
  assert.deepEqual(groups[0].rows.map(row => row.unitNumber), ["1", "2", "10"]);
  assert.equal(groups[0].amounts.totalScheduledCents, 33000, "subsidy is never added to monthly recurring total");
  assert.equal(groups.flatMap(group => group.rows).length, rows.length);
});

test("balance filters separate known debt, zero, credit and unverified", () => {
  const rows = [
    { personId: "due", totalBalanceCents: 100, balanceComplete: true, tenancyStatus: "former" },
    { personId: "zero", totalBalanceCents: 0, balanceComplete: true, tenancyStatus: "current" },
    { personId: "credit", totalBalanceCents: -100, balanceComplete: true, tenancyStatus: "future" },
    { personId: "unknown", totalBalanceCents: 100, balanceComplete: false, tenancyStatus: "unknown" },
  ] as DelinquencyRow[];
  for (const balance of ["due", "zero", "credit", "unverified"] as const) assert.deepEqual(filterReportLocalRows(rows, "delinquency", { balance }).map(row => row.personId), [balance === "unverified" ? "unknown" : balance]);
  assert.deepEqual(filterReportLocalRows(rows, "delinquency", { tenancyStatus: "former" }).map(row => row.personId), ["due"]);
});

test("report cell navigation resolves current and future names independently", () => {
  const row: RentRollRow = { currentPersonId: "current", currentTenantName: "Current tenant", futurePersonId: "future", futureTenantName: "Future tenant" };
  assert.equal(reportCellPersonId(row, "currentTenantName"), "current");
  assert.equal(reportCellPersonId(row, "futureTenantName"), "future");
  assert.equal(reportCellPersonId(row, "baseRentCents"), "current");
  assert.equal(createReportViewModel("rent-roll", [{ currentPersonId: "current", occupancy: "current", futureTenantName: "Future name", futurePersonId: "future" }]).displayRows[0].currentTenantName, undefined);
  assert.equal(reportCellPersonId({ futurePersonId: "future", futureTenantName: "Future tenant" }, "currentTenantName"), "future");
  assert.equal(reportCellPersonId({ currentTenantName: "Missing identity", futurePersonId: "future" }, "currentTenantName"), undefined);
  assert.equal(reportCellPersonId({ currentTenantName: "Missing identity", futurePersonId: "future" }, "baseRentCents"), undefined);
});

test("multi property and account filters are part of the server query", () => {
  const query = reportQueryFilters({ propertyScope: "active", propertyId: "ignored", propertyIds: ["b", "a"], asOfDate: "2026-09-12", status: "all", search: "", balanceStatus: "unverified", tenantStatus: "all" }, "delinquency", { asOfDate: "2026-09-12" });
  assert.deepEqual(query.propertyIds, ["a", "b"]);
  assert.equal(query.propertyId, undefined);
  assert.equal(query.balanceStatus, "unverified");
  assert.equal(query.tenantStatus, "all");
});


test("grouping retains accounts with blank or missing property identity", () => {
  const view = createReportViewModel("delinquency", [{ propertyName: "", personId: "one" }, { personId: "two" }]);
  const groups = groupReportRows("delinquency", view.displayRows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Needs review");
  assert.equal(groups[0].rows.length, 2);
});


test("rent roll defaults occupied while vacancies defaults vacant", () => {
  assert.equal(defaultReportOccupancy("rent-roll"), "current");
  assert.equal(defaultReportOccupancy("occupancy"), "vacant");
  assert.equal(defaultReportOccupancy("rent-roll", "future_preleased"), "future_preleased");
  assert.equal(getReportConfig("rent-roll").label, "Rent roll");
});

test("all units includes confirmed zero-obligation vacancy without contaminating rent subtotals", () => {
  const rows: RentRollRow[] = [
    { propertyId: "p", propertyName: "Property", unitNumber: "1", occupancy: "current", currentPersonId: "tenant", baseRentCents: 100000, recurringFeesCents: 1000, totalScheduledCents: 101000 },
    { propertyId: "p", propertyName: "Property", unitNumber: "2", occupancy: "vacant", recurringFeesCents: 0, totalScheduledCents: 0 },
  ];
  const all = filterReportLocalRows(rows, "rent-roll", { occupancy: "all" });
  const view = createReportViewModel("rent-roll", all);
  const [group] = groupReportRows("rent-roll", view.displayRows);
  assert.equal(group.rows.length, 2);
  assert.equal(group.amounts.baseRentCents, 100000);
  assert.equal(group.amounts.totalScheduledCents, 101000);
  assert.equal(view.displayRows[1].baseRentCents, 0);
  const rentColumn = view.columns.find(column => column.key === "baseRentCents")!;
  assert.equal(formatReportCellValue(view.displayRows[1], rentColumn), "—");
  assert.equal(buildReportCsv(group.rows, [rentColumn]).split("\n")[2], "—");
  assert.equal(filterReportLocalRows(rows, "rent-roll", { occupancy: defaultReportOccupancy("rent-roll") }).length, 1);
  const unknown = createReportViewModel("rent-roll", [{ ...rows[1], occupancy: "unknown" }]);
  assert.equal(unknown.displayRows[0].baseRentCents, undefined);
  assert.equal(unknown.displayRows[0].totalScheduledCents, null);
  assert.equal(buildPropertySubtotals("rent-roll", [{ ...rows[1], occupancy: "unknown" }])[0].amounts.baseRentCents, null);
});
