import test from "node:test";
import assert from "node:assert/strict";
import type { AdminSnapshot, AdminUnitView, ViewFilters } from "../rent-ops/types";
import {
  balancesDue, complianceRows, leaseRowsFor, listingRows, makeReadyRows, movesFor, obligationRemaining, occupancyPercent,
  packageRunSummary, qboStatusLabel, receiptsByPayment, scheduleGroups, workByUnit,
} from "./models";

const filters: ViewFilters = { propertyScope: "all", propertyId: "all", asOfDate: "2026-08-15", status: "all", search: "" };
const unit = (id: string, extra: Partial<AdminUnitView> = {}): AdminUnitView => ({ id, propertyId: "p1", unitNumber: id.toUpperCase(), ...extra });
const snapshot = (units: AdminUnitView[]) => ({ snapshot: { properties: [{ id: "p1", name: "Harbor", state: "active" }, { id: "p2", name: "Old", state: "inactive" }], units } } as unknown as AdminSnapshot);

test("arrears keep unknown balances and never count credits", () => {
  const rows = balancesDue([{ id: "a", operationalBalanceCents: 100 }, { id: "b", operationalBalanceCents: -50 }, { id: "c", operationalBalanceCents: null }, { id: "d", operationalBalanceCents: 0 }]);
  assert.deepEqual(rows.map(row => row.id), ["c", "a"], "unknown first, then largest; credits and zero excluded");
});

test("receipts group allocations exactly and an unknown part makes the receipt unknown", () => {
  const rows = receiptsByPayment([
    { paymentTransactionId: "p1", paymentOn: "2026-08-03", amountCents: 70000 },
    { paymentTransactionId: "p1", paymentOn: "2026-08-03", amountCents: 5000 },
    { paymentTransactionId: "p2", paymentOn: "2026-08-05", amountCents: null },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].receiptCents, null, "newest first; unknown amount stays unknown");
  assert.equal(rows[1].receiptCents, "75000");
});

test("lease views filter by action status and sort by end date", () => {
  const rows = [{ actionStatus: "expiring", contractEndOn: "2026-10-01" }, { actionStatus: "month_to_month" }, { actionStatus: "expiring", contractEndOn: "2026-09-01" }];
  assert.deepEqual(leaseRowsFor(rows, "expiring").map(row => row.contractEndOn), ["2026-09-01", "2026-10-01"]);
  assert.equal(leaseRowsFor(rows, "month_to_month").length, 1);
  assert.equal(leaseRowsFor(rows, "all").length, 3);
});

test("move views separate completed moves from planned ones", () => {
  const events = [
    { id: "1", date: "2026-08-01", movement: "Move in", state: "Completed", actual: true },
    { id: "2", date: "2026-09-01", movement: "Move in", state: "Planned", actual: false },
    { id: "3", date: "2026-08-10", movement: "Move out", state: "Completed", actual: true },
  ];
  assert.deepEqual(movesFor(events, "upcoming").map(event => event.id), ["2"]);
  assert.deepEqual(movesFor(events, "recent").map(event => event.id), ["3", "1"]);
  assert.equal(movesFor(events, "all").length, 3);
});

test("make-ready lists vacant, turning and not-ready units with work counts, never occupied settled units", () => {
  const units = [unit("u1"), unit("u2"), unit("u3", { readiness: "ready" }), unit("u4"), unit("u5", { propertyId: "p2" })];
  const occupancy = new Map([["u1", "vacant"], ["u2", "current"], ["u3", "future_preleased"], ["u4", "current"], ["u5", "vacant"]]);
  const openWork = workByUnit([
    { unitId: "u1", status: "scheduled", scheduledOn: "2026-08-20" },
    { unitId: "u1", status: "new", scheduledOn: null },
    { unitId: "u1", status: "completed", scheduledOn: "2026-08-30" },
  ]);
  const rows = makeReadyRows(snapshot(units), { ...filters, propertyScope: "active" }, {
    occupancy, daysVacant: new Map([["u1", 12]]), turning: new Set(["u4"]), openWork,
    readiness: value => ({ label: value.readiness === "ready" ? "Ready" : "Not recorded", ready: value.readiness === "ready" ? true : undefined }),
  });
  assert.deepEqual(rows.map(row => row.unit.id), ["u1", "u4"], "occupied u2 and ready preleased u3 excluded; inactive property excluded");
  assert.equal(rows[0].openWorkOrders, 2); assert.equal(rows[0].workScheduledThrough, "2026-08-20"); assert.equal(rows[0].daysVacant, 12);
  assert.equal(rows[1].occupancy, "turning");
  const withoutCompany = makeReadyRows(snapshot(units), filters, { occupancy, daysVacant: new Map(), turning: new Set(), openWork: null, readiness: () => ({ label: "Not recorded", ready: undefined }) });
  assert.equal(withoutCompany[0].openWorkOrders, null, "work is unknown, not zero, without company records");
});

test("listings show unverified listing state as not recorded and asking rent as exact cents", () => {
  const rows = listingRows(snapshot([unit("u1", { listing: "listed", marketRentCents: 125000 }), unit("u2", { listing: "listed", listingKnowledge: "inferred" })]), filters, new Map([["u1", "vacant"]]), () => "Ready");
  assert.deepEqual(rows.map(row => [row.listing, row.askingRentCents, row.occupancy]), [["listed", "125000", "vacant"], ["not_recorded", null, "unknown"]]);
});

test("work agenda groups overdue, dated and unscheduled open work", () => {
  const item = (id: string, scheduledOn: string | null, status = "scheduled", priority = "normal") => ({ id, scheduledOn, status, priority, reportedOn: "2026-08-01" });
  const groups = scheduleGroups([item("a", "2026-08-10"), item("b", "2026-08-15"), item("c", "2026-08-16"), item("d", null, "new", "low"), item("e", null, "new", "emergency"), item("f", "2026-08-15", "completed")], "2026-08-15", date => date);
  assert.deepEqual(groups.map(group => [group.key, group.items.map(entry => entry.id)]), [["overdue", ["a"]], ["2026-08-15", ["b"]], ["2026-08-16", ["c"]], ["unscheduled", ["e", "d"]]]);
  assert.match(groups[1].label, /^Today/); assert.match(groups[2].label, /^Tomorrow/);
});

test("obligations show remaining amounts with certainty", () => {
  const base = { obligationId: "o", accountId: "a", accountName: "A", instrumentName: "Note", dueOn: "2026-09-01", currency: "USD", paidCents: "2500" };
  assert.equal(obligationRemaining({ ...base, expectedCents: "10000", knownMinimumCents: "10000", amountComplete: true }), "$75.00");
  assert.equal(obligationRemaining({ ...base, expectedCents: null, knownMinimumCents: "4000", amountComplete: false }), "At least $15.00");
  assert.equal(obligationRemaining({ ...base, expectedCents: "1000", knownMinimumCents: "1000", amountComplete: true }), "$0.00", "overpaid never shows a negative remaining");
});

test("compliance rows flag missing or old insurance documents by date only", () => {
  const document = (propertyId: string, kind: string, documentDate: string | null) => ({ id: `${propertyId}:${kind}:${documentDate}`, propertyId, propertyName: null, kind, title: "Doc", documentDate, fileName: "doc.pdf", uploadedAt: "2026-01-01T00:00:00Z" });
  const rows = complianceRows([document("p1", "insurance", "2025-06-01"), document("p1", "insurance", "2024-06-01"), document("p1", "loan", "2026-01-01")], [{ id: "p1", name: "Harbor" }, { id: "p2", name: "Grove" }], "2026-08-15");
  assert.deepEqual(rows.map(row => [row.propertyId, row.documentCount, row.insuranceDated, row.insuranceAgeDays]), [["p1", 3, "2025-06-01", 440], ["p2", 0, null, null]]);
});

test("package runs are complete only when every report is ready", () => {
  assert.equal(packageRunSummary({ state: "ready", itemRuns: [{ itemId: "a", runId: null, state: "ready", errorCode: null }] }), "Complete · 1 report");
  assert.equal(packageRunSummary({ state: "ready", itemRuns: [{ itemId: "a", runId: null, state: "ready", errorCode: null }, { itemId: "b", runId: null, state: "failed", errorCode: "x" }] }), "Incomplete · 2 reports · 1 not ready");
  assert.equal(packageRunSummary({ state: "running", itemRuns: [] }), "Running");
});

test("QuickBooks status labels distinguish connected from read-verified", () => {
  assert.equal(qboStatusLabel(undefined).label, "Not connected");
  assert.equal(qboStatusLabel({ status: "ready", environment: "production" }).label, "Connected");
  assert.equal(qboStatusLabel({ status: "connected", environment: "sandbox" }).label, "Connected, not yet read · Sandbox");
  assert.equal(qboStatusLabel({ status: "needs_reconnect", environment: "production" }).tone, "warning");
});

test("occupancy percent is unknown when any unit's occupancy is unknown", () => {
  assert.equal(occupancyPercent({ unitCount: 3, occupiedUnits: 2, unknownOccupancyUnits: 0 }), "66.7%");
  assert.equal(occupancyPercent({ unitCount: 3, occupiedUnits: 2, unknownOccupancyUnits: 1 }), "Unknown");
  assert.equal(occupancyPercent({ unitCount: 0, occupiedUnits: 0, unknownOccupancyUnits: 0 }), "—");
});
