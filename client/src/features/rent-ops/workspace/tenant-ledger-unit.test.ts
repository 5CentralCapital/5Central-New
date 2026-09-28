import assert from "node:assert/strict";
import test from "node:test";
import { buildLedgerRows } from "./tenant-model";

const unit = { id: "unit-d4", propertyId: "prop-1", unitNumber: "D4" };
const snapshot = { snapshot: { properties: [{ id: "prop-1", name: "Sun Cove Apartments" }], units: [unit], tenancies: [] }, summary: { asOfDate: "2026-09-27" } } as any;
const payment = { id: "pay-1", propertyId: "prop-1", kind: "payment", status: "posted", amountCents: 50000, postedOn: "2026-07-07" };

function tenantWith(tenancies: Array<{ id: string; unitId?: string }>) {
  return { person: { id: "person-1" }, tenancy: tenancies[0] ? { ...tenancies[0], propertyId: "prop-1" } : undefined, tenancies: tenancies.map(t => ({ ...t, propertyId: "prop-1" })), unit, ledger: [{ transaction: payment, runningBalanceCents: 0, balanceComplete: true }], schedules: [], deposits: [], documents: [] } as any;
}

test("a payment with no unit shows the resident's only unit", () => {
  const [row] = buildLedgerRows(tenantWith([{ id: "ten-1", unitId: "unit-d4" }]), snapshot);
  assert.equal(row.unitLabel, "D4");
});

test("a payment with no unit stays flagged when the resident has lived in two units", () => {
  const snap = { ...snapshot, snapshot: { ...snapshot.snapshot, units: [unit, { id: "unit-c1", propertyId: "prop-1", unitNumber: "C1" }] } };
  const [row] = buildLedgerRows(tenantWith([{ id: "ten-1", unitId: "unit-d4" }, { id: "ten-0", unitId: "unit-c1" }]), snap);
  assert.equal(row.unitLabel, "Unit missing");
});
