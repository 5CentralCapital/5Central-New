import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveDashboardTrends } from "./dashboard-trends";
import { aggregateDashboardPoints, chartLineSegments, dashboardChartSeries } from "../../../client/src/features/rent-ops/workspace/dashboard-model";

function fixture() {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.units = snapshot.units.filter(unit => ["demo-unit-a-1", "demo-unit-a-3", "demo-unit-b-1"].includes(unit.id));
  Object.assign(snapshot.units.find(unit => unit.id === "demo-unit-a-3")!, { vacancyConfirmedOn: "2025-01-01", vacancyConfirmationKnowledge: "manual" });
  return snapshot;
}
test("twelve chronological month ends preserve partial current month and property scope", () => {
  const snapshot = fixture();
  const original = structuredClone(snapshot);
  const data = deriveDashboardTrends(snapshot, { propertyScope: "active", propertyId: "demo-property-a", asOfDate: "2026-08-15" });
  assert.equal(data.months.length, 12);
  assert.deepEqual(data.months.map(month => month.month), ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
  assert.equal(data.months[5].asOfDate, "2026-02-28");
  assert.equal(data.months[11].asOfDate, "2026-08-15");
  assert.ok(data.months.every(month => month.properties.length === 1 && month.properties[0].propertyId === "demo-property-a"));
  assert.deepEqual(snapshot, original);
});
test("portfolio uses weighted occupancy and occupied base rent without fees or duplicate HAP", () => {
  const data = deriveDashboardTrends(fixture(), { asOfDate: "2026-08-15" });
  const point = aggregateDashboardPoints(data.months[11].properties)!;
  assert.equal(point.occupiedUnits, 2);
  assert.equal(point.unitCount, 3);
  assert.equal(point.vacantUnits, 1);
  assert.equal(point.occupancyRate, 100 * 2 / 3);
  assert.equal(point.baseRentCents, 230000);
  assert.equal(dashboardChartSeries(data, "portfolio", "rent", "rate")[0].values[11], 2300);
  assert.equal(dashboardChartSeries(data, "compare", "occupancy", "units").length, 2);
});
test("unknown historical intervals and unknown rent cadence remain gaps", () => {
  const snapshot = fixture();
  let data = deriveDashboardTrends(snapshot, { asOfDate: "2026-08-15" });
  assert.equal(data.months[0].properties[0].unknownUnits, 1, "a later move-in does not prove previous vacancy");
  assert.equal(aggregateDashboardPoints(data.months[0].properties)!.baseRentCents, null);
  assert.equal(dashboardChartSeries(data, "portfolio", "occupancy", "rate")[0].values[0], null);
  snapshot.recurringSchedules.find(schedule => schedule.id === "demo-schedule-1")!.billingFrequency = null;
  data = deriveDashboardTrends(snapshot, { asOfDate: "2026-08-15" });
  assert.equal(data.months[11].properties[0].baseRentCents, null);
  assert.equal(data.months[11].properties[0].unconfirmedRentUnits, 1);
  assert.equal(data.months[11].properties[0].occupancyRate, 50);
  assert.equal(chartLineSegments([1, null, 3, 4], i => i, value => value), "M0,1  M2,3 L3,4");
});
test("actual move-out ends historical rent and occupancy; lease expiration alone does not", () => {
  const snapshot = fixture();
  const tenancy = snapshot.tenancies.find(tenancy => tenancy.id === "demo-tenancy-1")!;
  Object.assign(tenancy, { status: "past", actualMoveOutOn: "2026-07-10", actualMoveOutKnowledge: "manual" });
  const data = deriveDashboardTrends(snapshot, { propertyId: "demo-property-a", asOfDate: "2026-08-15" });
  assert.equal(data.months[9].properties[0].occupiedUnits, 1);
  assert.equal(data.months[10].properties[0].occupiedUnits, 0);
  assert.equal(data.months[10].properties[0].baseRentCents, 0);
  assert.equal(data.months[10].properties[0].vacantUnits, 2);
  Object.assign(tenancy, { status: "current", actualMoveOutOn: undefined });
  snapshot.leaseTerms.find(term => term.tenancyId === tenancy.id)!.contractEndOn = "2026-07-01";
  assert.equal(deriveDashboardTrends(snapshot, { asOfDate: "2026-08-15" }).months[11].properties[0].occupiedUnits, 1);
});
