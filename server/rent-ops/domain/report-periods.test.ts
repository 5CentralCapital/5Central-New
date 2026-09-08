import assert from "node:assert/strict";
import test from "node:test";
import { emptyRentOpsSnapshot, type RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";
import { deriveCollectedIncome, deriveFixedReport, deriveTenantLedger, validateReportFilters } from "./reports";
import { serializeLedgerRow } from "../presentation/reports";

function fixture() {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.properties.push({ id: "p", name: "Property", slug: "p", state: "active", propertyType: "multifamily", address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" } });
  const txn = (id: string, kind: RentOpsLedgerTransaction["kind"], postedOn: string, amountCents: number): RentOpsLedgerTransaction => ({ id, kind, postedOn, amountCents, propertyId: "p", tenancyId: "lease", personId: "person", category: "base_rent", status: "posted", description: id });
  snapshot.ledgerTransactions.push(txn("charge", "charge", "2026-07-01", 10001), txn("payment1", "payment", "2026-08-01", 2001), txn("payment2", "payment", "2026-08-31", 3001), txn("payment3", "payment", "2026-09-01", 1000));
  snapshot.paymentAllocations.push(...snapshot.ledgerTransactions.slice(1).map(payment => ({ id: `allocation-${payment.id}`, paymentTransactionId: payment.id, chargeTransactionId: "charge", allocatedOn: payment.postedOn!, amountCents: payment.amountCents!, kind: "allocation" as const })));
  return snapshot;
}

test("inclusive receipt range preserves cents and excludes both outside boundaries", () => {
  const rows = deriveCollectedIncome(fixture(), { fromDate: "2026-08-01", toDate: "2026-08-31" });
  assert.deepEqual(rows.map(row => row.amountCents), [2001, 3001]);
  assert.equal(deriveCollectedIncome(fixture(), { fromDate: "2026-08-01", toDate: "2026-08-31", propertyId: "other" }).length, 0);
});

test("ledger range carries opening history and no-activity period survives serialization", () => {
  const rows = deriveTenantLedger(fixture(), "lease", { fromDate: "2026-08-01", toDate: "2026-08-31" });
  assert.equal(rows[0].rowType, "opening_balance");
  assert.equal(rows[0].openingBalanceCents, 10001);
  assert.deepEqual(rows.map(row => row.runningBalanceCents), [10001, 8000, 4999]);
  const empty = deriveTenantLedger(fixture(), "lease", { fromDate: "2026-08-10", toDate: "2026-08-20" });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].runningBalanceCents, 8000);
  assert.equal(empty[0].transaction.kind, null);
  assert.equal(empty[0].transaction.status, null);
  const serialized = serializeLedgerRow(empty[0]);
  assert.equal(serialized.rowType, "opening_balance");
  assert.equal(serialized.openingBalanceCents, 8000);
});

test("flow ranges reject ambiguous periods and as-of/balance reports", () => {
  for (const filters of [{ fromDate: "2026-09-02", toDate: "2026-09-01" }, { fromDate: "2026-09-01", month: "2026-09" }, { toDate: "2026-09-10", asOfDate: "2026-09-09" }]) assert.throws(() => validateReportFilters("collected-income", filters));
  assert.throws(() => deriveFixedReport(fixture(), "delinquency", { fromDate: "2026-08-01" }));
  assert.throws(() => deriveFixedReport(fixture(), "scheduled-vs-collected", { fromDate: "2026-08-01" }));
});


test("v3 collected flow honors range and selected person without rounding", () => {
  const snapshot = fixture();
  snapshot.modelVersion = 3;
  const rows = deriveCollectedIncome(snapshot, { fromDate: "2026-08-31", toDate: "2026-09-01", personId: "person" });
  assert.deepEqual(rows.map(row => row.amountCents), [3001, 1000]);
  assert.equal(deriveCollectedIncome(snapshot, { fromDate: "2026-08-31", toDate: "2026-09-01", personId: "different" }).length, 0);
});
