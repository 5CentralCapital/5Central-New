import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { dashboardHistoricalSnapshot } from "./dashboard-history";
import { deriveDashboardTrends } from "./dashboard-trends";

function fixture() {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.units = snapshot.units.filter(unit => unit.id === "demo-unit-a-1");
  snapshot.tenancies = snapshot.tenancies.filter(tenancy => tenancy.id === "demo-tenancy-1");
  Object.assign(snapshot.tenancies[0], {
    source: { system: "rent_manager", entityType: "tenancy", sourceId: "historical-fixture" },
    status: null, statusKnowledge: "unknown", unitLinkKnowledge: "exact",
    actualMoveInOn: "2025-10-01", actualMoveOutOn: "2026-03-01",
    actualMoveInKnowledge: "source", actualMoveOutKnowledge: "source",
  });
  return snapshot;
}

test("RM actual intervals recover historical occupancy without rewriting source or current point", () => {
  const snapshot = fixture(), original = structuredClone(snapshot);
  const data = deriveDashboardTrends(snapshot, { asOfDate: "2026-08-15", propertyId: "demo-property-a" });
  assert.equal(data.months[0].properties[0].occupancyRate, null, "later arrival is not proof of earlier vacancy");
  assert.equal(data.months[1].properties[0].occupiedUnits, 1);
  assert.equal(data.months[1].properties[0].occupancyRate, 100);
  assert.equal(data.months[6].properties[0].vacancyRate, 100, "actual departure establishes vacancy");
  assert.equal(data.months[11].properties[0].occupancyRate, null, "current operational view stays unchanged");
  assert.deepEqual(snapshot, original);
});

test("contract expiration, expected departure, manual observations and uncertain actual facts cannot supply a historical interval", () => {
  for (const patch of [
    { actualMoveOutOn: undefined, expectedMoveOutOn: "2026-03-01" },
    { actualMoveOutKnowledge: "unknown" },
    { actualMoveInKnowledge: "manual" },
    { actualMoveOutOn: "2025-09-01" },
    { actualMoveOutOn: "2026-02-30" },
    { status: "cancelled", statusKnowledge: "manual" },
  ]) {
    const snapshot = fixture(); Object.assign(snapshot.tenancies[0], patch);
    assert.deepEqual(dashboardHistoricalSnapshot(snapshot, "2026-01-31").tenancies, snapshot.tenancies);
  }
});

test("unlinked completed intervals only stop contaminating other units outside their actual dates", () => {
  const snapshot = fixture(); Object.assign(snapshot.tenancies[0], { unitId: undefined, unitLinkKnowledge: "unknown" });
  assert.equal(dashboardHistoricalSnapshot(snapshot, "2025-09-30").tenancies.length, 0);
  assert.equal(dashboardHistoricalSnapshot(snapshot, "2026-01-31").tenancies.length, 1);
  assert.equal(dashboardHistoricalSnapshot(snapshot, "2026-03-01").tenancies.length, 0);
});

test("historical rent remains unknown when RM schedule cadence was not supplied", () => {
  const snapshot = fixture();
  for (const row of snapshot.recurringSchedules) row.billingFrequency = null;
  const point = deriveDashboardTrends(snapshot, { asOfDate: "2026-08-15", propertyId: "demo-property-a" }).months[1].properties[0];
  assert.equal(point.occupancyRate, 100);
  assert.equal(point.baseRentCents, null);
  assert.equal(point.unconfirmedRentUnits, 1);
});
