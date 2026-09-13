import assert from "node:assert/strict";
import test from "node:test";
import type { RentOpsActivityEvent, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { dashboardChartSeries, dashboardTrendPoints, defaultDashboardMeasure } from "../../../client/src/features/rent-ops/workspace/dashboard-model";
import { deriveDashboardTrends } from "./dashboard-trends";
import { deriveArchivedDashboardSnapshots } from "./historical-leasing-snapshot";

type Observation = {
  schema: "historical_leasing_snapshot_v1";
  propertyId: string;
  asOfDate: string;
  sourceReference: string;
  sourceSha256: string;
  sourceSystem: string;
  unitCount: number;
  occupied: number | null;
  vacant: number | null;
  preleased: number | null;
  unknown: number | null;
  monthlyBaseRentCents: number | null;
  evidence: {
    knowledge: string | { occupancy?: string; vacancy?: string; rent?: string };
    completeness: string | { occupancy?: string; vacancy?: string; rent?: string };
  };
};

const hash = "a".repeat(64);

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    schema: "historical_leasing_snapshot_v1",
    propertyId: "demo-property-a",
    asOfDate: "2026-07-20",
    sourceReference: "/private/archive/rent-roll.pdf",
    sourceSha256: hash,
    sourceSystem: "rent_manager",
    unitCount: 5,
    occupied: 4,
    vacant: 1,
    preleased: 0,
    unknown: 0,
    monthlyBaseRentCents: 460000,
    evidence: { knowledge: "source", completeness: "complete_property_snapshot" },
    ...overrides,
  };
}

function event(id: string, body: Observation, overrides: Partial<RentOpsActivityEvent> = {}): RentOpsActivityEvent {
  return {
    id,
    propertyId: body.propertyId,
    type: "system",
    occurredAt: `${body.asOfDate}T12:00:00.000Z`,
    actor: "system",
    summary: "Archived leasing snapshot",
    detail: JSON.stringify(body),
    source: { system: body.sourceSystem, entityType: "historical_leasing_snapshot", sourceId: id },
    ...overrides,
  };
}

function baseSnapshot(): RentOpsSnapshot {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.activityEvents = [];
  return snapshot;
}

test("field-specific evidence keeps charge rent while occupancy stays unknown", () => {
  const snapshot = baseSnapshot();
  snapshot.activityEvents.push(event("charge-only", observation({
    occupied: null, vacant: null, preleased: null, unknown: 5, monthlyBaseRentCents: 460000,
    evidence: {
      knowledge: { occupancy: "unknown", vacancy: "unknown", rent: "source" },
      completeness: { occupancy: "unknown", vacancy: "unknown", rent: "complete_charge_snapshot" },
    },
  })));
  const result = deriveArchivedDashboardSnapshots(snapshot, { propertyId: "demo-property-a" }, "2026-09-12");
  const point = result.snapshots[0].properties[0];
  assert.equal(point.unknownUnits, 5);
  assert.equal(point.occupancyRate, null);
  assert.equal(point.vacancyRate, null);
  assert.equal(point.baseRentCents, 460000);
  assert.equal(point.confirmedBaseRentCents, 460000);
  assert.equal(point.unconfirmedRentUnits, 0);
  const data = deriveDashboardTrends(snapshot, { propertyId: "demo-property-a", asOfDate: "2026-09-12" });
  assert.equal(dashboardChartSeries(data, "portfolio", "occupancy", "units", "recorded")[0].values[0], null);
});

test("vacancy evidence exposes vacancy rate without inventing occupied units or rent", () => {
  const snapshot = baseSnapshot();
  snapshot.activityEvents.push(event("vacancy-only", observation({
    occupied: null, vacant: 1, preleased: null, unknown: 4, monthlyBaseRentCents: null,
    evidence: {
      knowledge: { occupancy: "unknown", vacancy: "source", rent: "unknown" },
      completeness: { occupancy: "unknown", vacancy: "complete_vacancy_snapshot", rent: "unknown" },
    },
  })));
  const point = deriveArchivedDashboardSnapshots(snapshot, { propertyId: "demo-property-a" }, "2026-09-12").snapshots[0].properties[0];
  assert.equal(point.occupiedUnits, 0);
  assert.equal(point.unknownUnits, 4);
  assert.equal(point.occupancyRate, null);
  assert.equal(point.vacancyRate, 20);
  assert.equal(point.baseRentCents, null);
  const data = deriveDashboardTrends(snapshot, { propertyId: "demo-property-a", asOfDate: "2026-09-12" });
  assert.equal(dashboardChartSeries(data, "portfolio", "occupancy", "units", "recorded")[0].values[0], null);
  assert.equal(dashboardChartSeries(data, "portfolio", "vacancy", "units", "recorded")[0].values[0], 1);
  assert.equal(defaultDashboardMeasure(data, "recorded", "vacancy"), "rate");
});

test("recorded points group only identical dates and portfolio totals gap when a scoped property is missing", () => {
  const snapshot = baseSnapshot();
  snapshot.activityEvents.push(
    event("a-july", observation({ asOfDate: "2026-07-20" })),
    event("b-july", observation({ propertyId: "demo-property-b", asOfDate: "2026-07-20", unitCount: 2, occupied: 2, vacant: 0, preleased: 0, unknown: 0, monthlyBaseRentCents: 210000 })),
    event("a-august", observation({ asOfDate: "2026-08-03", occupied: 3, vacant: 2, monthlyBaseRentCents: 400000 })),
  );
  const data = deriveDashboardTrends(snapshot, { asOfDate: "2026-09-12" });
  assert.deepEqual(data.archivedSnapshots?.map(point => point.asOfDate), ["2026-07-20", "2026-08-03"]);
  assert.equal(data.archivedSnapshots?.[0].properties.length, 2);
  assert.equal(data.archivedSnapshots?.[1].properties.length, 1);
  const points = dashboardTrendPoints(data, "recorded");
  assert.deepEqual(points.map(point => point.asOfDate), ["2026-07-20", "2026-08-03", "2026-09-12"]);
  const portfolio = dashboardChartSeries(data, "portfolio", "occupancy", "units", "recorded")[0];
  assert.deepEqual(portfolio.values.slice(0, 2), [6, null]);
});

test("future, foreign, malformed, and conflicting observations are excluded", () => {
  const snapshot = baseSnapshot();
  snapshot.activityEvents.push(
    event("future", observation({ asOfDate: "2026-10-01" })),
    event("foreign", observation({ propertyId: "property-not-in-snapshot" })),
    event("bad", observation({ sourceSha256: "not-a-hash" })),
    event("conflict-a", observation({ asOfDate: "2026-07-21" })),
    event("conflict-b", observation({ asOfDate: "2026-07-21", monthlyBaseRentCents: 999999 })),
  );
  const result = deriveArchivedDashboardSnapshots(snapshot, { propertyId: "demo-property-a" }, "2026-09-12");
  assert.deepEqual(result.snapshots, []);
  assert.ok(result.issues.some(issue => issue.code === "future_observation"));
  assert.ok(result.issues.some(issue => issue.code === "property_out_of_scope"));
  assert.ok(result.issues.some(issue => issue.code === "observation_invalid"));
  assert.ok(result.issues.some(issue => issue.code === "observation_conflict"));
});

test("exact duplicate activity events collapse and private source identity never enters the dashboard DTO", () => {
  const snapshot = baseSnapshot();
  const evidence = {
    knowledge: { occupancy: "source", vacancy: "source", rent: "source" },
    completeness: { occupancy: "complete_property_snapshot", vacancy: "complete_property_snapshot", rent: "complete_property_snapshot" },
  };
  snapshot.activityEvents.push(
    event("duplicate-a", observation({ evidence })),
    event("duplicate-b", observation({ evidence: structuredClone(evidence) })),
  );
  const data = deriveDashboardTrends(snapshot, { propertyId: "demo-property-a", asOfDate: "2026-09-12" });
  assert.equal(data.archivedSnapshots?.length, 1);
  assert.equal(data.archivedSnapshots?.[0].properties.length, 1);
  assert.equal(JSON.stringify(data).includes("/private/archive"), false);
  assert.equal(JSON.stringify(data).includes(hash), false);
});

test("ordinary activity details and nested wrappers are ignored, while direct unknown fields are rejected", () => {
  const snapshot = baseSnapshot();
  const body = observation();
  snapshot.activityEvents.push(
    event("ordinary-note", body, { type: "note", detail: JSON.stringify({ schema: "balance_review_v1", propertyId: body.propertyId }) }),
    event("nested-wrapper", body, { detail: JSON.stringify({ observation: body }) }),
    event("unknown-field", { ...body, unexpected: true } as Observation),
  );
  const result = deriveArchivedDashboardSnapshots(snapshot, { propertyId: "demo-property-a" }, "2026-09-12");
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.issues.filter(issue => issue.code === "observation_invalid").length, 1);
});

test("zero-unit observations are safely skipped as malformed", () => {
  const snapshot = baseSnapshot();
  snapshot.activityEvents.push(event("zero-units", observation({ unitCount: 0, occupied: 0, vacant: 0, preleased: 0, unknown: 0 } as Partial<Observation>)));
  const result = deriveArchivedDashboardSnapshots(snapshot, { propertyId: "demo-property-a" }, "2026-09-12");
  assert.equal(result.snapshots.length, 0);
  assert.ok(result.issues.some(issue => issue.code === "observation_invalid"));
});

test("no historical events preserve the legacy trend response shape", () => {
  const data = deriveDashboardTrends(baseSnapshot(), { asOfDate: "2026-09-12" });
  assert.equal(Object.prototype.hasOwnProperty.call(data, "archivedSnapshots"), false);
  assert.equal(data.months.length, 12);
});
