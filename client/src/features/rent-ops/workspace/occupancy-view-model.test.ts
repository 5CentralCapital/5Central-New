import assert from "node:assert/strict";
import test from "node:test";
import type { AdminSnapshot, AdminSnapshotView, RentRollRow } from "../types";
import { occupancyRowsForFilter, occupancyViewForUnits } from "./occupancy-view-model";
const units = [{ id: "u1", unitNumber: "1" }, { id: "u2", unitNumber: "2" }];
function snapshot(input: Partial<AdminSnapshotView> = {}): AdminSnapshot {
  return { snapshot: { units, people: [], tenancies: [], leaseTerms: [], ...input } } as unknown as AdminSnapshot;
}
const current: RentRollRow = { unitId: "u1", occupancy: "current", tenancyId: "new", currentPersonId: "p", actualMoveInOn: "2026-06-01" };
test("current tenancy matches report and renewals produce one row with retained terms", () => {
  const s = snapshot({ tenancies: [{ id: "new", unitId: "u1", statusKnowledge: "unknown" }], leaseTerms: [
    { id: "original", tenancyId: "new", status: "executed", contractStartOn: "2025-06-01", contractEndOn: "2026-05-31" },
    { id: "renewal", tenancyId: "new", status: "executed", contractStartOn: "2026-06-01", contractEndOn: "2027-05-31" },
    { id: "future", tenancyId: "new", status: "executed", contractStartOn: "2027-06-01" },
  ] });
  const before = JSON.stringify(s);
  const rows = occupancyRowsForFilter(occupancyViewForUnits(s, units, [current], "2026-09-12"));
  assert.deepEqual(rows.map(r => r.tenancy?.id), ["new"]);
  assert.equal(rows[0].lease?.id, "renewal");
  assert.equal(rows[0].leaseHistory.length, 3);
  assert.equal(JSON.stringify(s), before);
});
test("moveout is inclusive; lease expiry alone never proves past or current", () => {
  const s = snapshot({ tenancies: [{ id: "old", unitId: "u1", actualMoveOutOn: "2026-09-12", statusKnowledge: "unknown" }], leaseTerms: [{ id: "l", tenancyId: "old", contractEndOn: "2025-01-01" }] });
  assert.equal(occupancyRowsForFilter(occupancyViewForUnits(s, units, [], "2026-09-11"), "past").length, 0);
  assert.equal(occupancyRowsForFilter(occupancyViewForUnits(s, units, [], "2026-09-12"), "past").length, 1);
  s.snapshot.tenancies[0].actualMoveOutKnowledge = "unknown";
  assert.equal(occupancyRowsForFilter(occupancyViewForUnits(s, units, [], "2026-09-12"), "past").length, 0);
});
test("replacement and transfer require ordered dates and exact identities, never a shared name", () => {
  const s = snapshot({ tenancies: [
    { id: "old", unitId: "u1", actualMoveInOn: "2025-01-01", statusKnowledge: "unknown" },
    { id: "transfer", unitId: "u2", primaryPersonId: "p", actualMoveInOn: "2025-01-01", statusKnowledge: "unknown" },
    { id: "other", unitId: "u2", primaryPersonId: "other", actualMoveInOn: "2025-01-01", statusKnowledge: "unknown" },
    { id: "undated", unitId: "u1", statusKnowledge: "unknown" },
    { id: "later", unitId: "u1", actualMoveInOn: "2026-10-01", statusKnowledge: "unknown" },
  ] });
  const rows = occupancyViewForUnits(s, units, [current], "2026-09-12");
  assert.deepEqual(occupancyRowsForFilter(rows, "past").map(r => r.tenancy?.id).sort(), ["old", "transfer"]);
  assert.equal(rows.find(r => r.tenancy?.id === "undated")?.displayStatus, "unknown");
  assert.equal(rows.find(r => r.tenancy?.id === "other")?.displayStatus, "unknown");
  assert.equal(rows.find(r => r.tenancy?.id === "later")?.displayStatus, "future");
});
test("vacant and unknown units are explicit but excluded from tenant filters", () => {
  const rows = occupancyViewForUnits(snapshot(), units, [{ unitId: "u1", occupancy: "vacant" }], "2026-09-12");
  assert.deepEqual(rows.map(r => r.displayStatus), ["vacant", "unknown"]);
  for (const filter of ["current", "past", "all"] as const) assert.equal(occupancyRowsForFilter(rows, filter).length, 0);
});
test("current selection changes only with report as-of identity, and past status cannot override historical report", () => {
  const s = snapshot({ tenancies: [{ id: "old", unitId: "u1", status: "past", actualMoveInOn: "2025-01-01", actualMoveOutOn: "2026-06-01" }, { id: "new", unitId: "u1", actualMoveInOn: "2026-06-01" }] });
  const prior = occupancyViewForUnits(s, units, [{ ...current, tenancyId: "old", actualMoveInOn: "2025-01-01" }], "2026-05-31");
  assert.deepEqual(occupancyRowsForFilter(prior).map(r => r.tenancy?.id), ["old"]);
  assert.deepEqual(occupancyRowsForFilter(occupancyViewForUnits(s, units, [current], "2026-09-12")).map(r => r.tenancy?.id), ["new"]);
});
test("recorded imported renewal dates stay visible without confirming execution", () => {
  const s = snapshot({ tenancies: [{ id: "new", unitId: "u1" }], leaseTerms: [
    { id: "old", tenancyId: "new", status: "executed", contractStartOn: "2025-06-01", contractEndOn: "2026-05-31" },
    { id: "recorded", tenancyId: "new", status: "unknown", statusKnowledge: "unknown", contractStartOn: "2026-06-01", contractEndOn: "2027-05-31", contractStartKnowledge: "source" },
    { id: "next", tenancyId: "new", status: "unknown", statusKnowledge: "unknown", contractStartOn: "2027-06-01" },
  ] });
  const row = occupancyRowsForFilter(occupancyViewForUnits(s, units, [current], "2026-09-12"))[0];
  assert.equal(row.lease?.id, "recorded");
  assert.equal(row.lease?.statusKnowledge, "unknown");
  assert.equal(row.lease?.contractStartOn, "2026-06-01");
});
