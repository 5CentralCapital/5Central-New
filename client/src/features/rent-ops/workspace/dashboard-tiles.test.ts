import test from "node:test";
import assert from "node:assert/strict";
import { recentOnlineApplications, dashboardMovements } from "./dashboard-tiles";
import type { AdminSnapshot, AdminApplicationView, ViewFilters } from "../types";
const filters: ViewFilters = { propertyScope: "active", propertyId: "all", asOfDate: "2026-09-12", status: "all", search: "" };
const snapshot = { snapshot: { properties: [{ id: "p", name: "Russell", state: "active" }], units: [{ id: "lot2", propertyId: "p", unitNumber: "Lot 2" }, { id: "lot3", propertyId: "p", unitNumber: "Lot 3" }], people: [{ id: "person", firstName: "Tenant" }], tenancies: [] } } as unknown as AdminSnapshot;
test("online submissions exclude imports, drafts and uncertain dates, retain real case IDs newest first", () => {
  const applications = [
    { id: "application:old", sourceType: "public_portal", submittedOn: "2026-09-01" },
    { id: "rm-import", sourceType: "rm_import", submittedOn: "2026-09-12" },
    { id: "application:new", sourceType: "public_portal", submittedOn: "2026-09-12" },
    { id: "application:draft", sourceType: "public_portal", status: "draft", createdAt: "2026-09-12T12:00:00Z" },
    { id: "application:unknown", sourceType: "public_portal", submittedOn: "2026-09-11", submittedOnKnowledge: "unknown" },
    { id: "application:future", sourceType: "public_portal", submittedOn: "2026-09-13" },
  ] satisfies AdminApplicationView[];
  assert.deepEqual(recentOnlineApplications(applications, snapshot, filters).map(row => row.id), ["application:new", "application:old"]);
  assert.equal(recentOnlineApplications(applications, snapshot, { ...filters, propertyId: "p" }).length, 0);
});
test("month movements retain completed former moves and month-end expected dates with exact unit links", () => {
  const data = structuredClone(snapshot);
  data.snapshot.tenancies = [
    { id: "former", propertyId: "p", unitId: "lot2", primaryPersonId: "person", status: "past", actualMoveInOn: "2026-09-01", actualMoveOutOn: "2026-09-05" },
    { id: "notice", propertyId: "p", unitId: "lot2", primaryPersonId: "person", status: "notice", actualMoveInOn: "2025-01-01", expectedMoveOutOn: "2026-09-30" },
    { id: "future", propertyId: "p", unitId: "lot3", primaryPersonId: "person", status: "future", plannedMoveInOn: "2026-10-01" },
    { id: "unknown", propertyId: "p", unitId: "lot3", primaryPersonId: "person", status: "current", actualMoveInOn: "2026-09-01", actualMoveInKnowledge: "unknown" },
  ];
  const rows = dashboardMovements(data, filters);
  assert.deepEqual(rows.map(row => [row.date, row.state, row.unitNumber]), [["2026-09-01", "Completed", "Lot 2"], ["2026-09-05", "Completed", "Lot 2"], ["2026-09-30", "Expected", "Lot 2"]]);
  assert.equal(dashboardMovements(data, { ...filters, asOfDate: "2026-10-01" })[0]?.state, "Planned");
});

test("manual cancellation and contradictory former dates cannot appear as completed move-ins", () => {
  const data = structuredClone(snapshot);
  const common = { propertyId: "p", unitId: "lot2", primaryPersonId: "person", actualMoveInOn: "2026-09-01", actualMoveInKnowledge: "source" };
  data.snapshot.tenancies = [
    { ...common, id: "cancelled-import", status: "cancelled", statusKnowledge: "manual" },
    { ...common, id: "future-intent", status: "future", statusKnowledge: "source" },
    { ...common, id: "contradiction", status: "past", actualMoveOutOn: "2026-05-01", actualMoveOutKnowledge: "source" },
    { ...common, id: "former-no-interval", status: "past", statusKnowledge: "manual" },
    { ...common, id: "unknown-status", status: "current", statusKnowledge: "unknown" },
    { ...common, id: "manual-expected", status: "current", statusKnowledge: "source", actualMoveInOn: "2025-03-06", expectedMoveOutOn: "2026-09-24", expectedMoveOutKnowledge: "manual" },
  ];
  assert.deepEqual(dashboardMovements(data, filters).map(row => [row.tenancyId, row.date, row.state]), [["manual-expected", "2026-09-24", "Expected"]]);
});
