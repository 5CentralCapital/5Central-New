import assert from "node:assert/strict";
import test from "node:test";
import { emptyRentOpsSnapshot, type RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";
import { deriveSharedPaymentApplications, deriveTenantLedger, deriveCollectedIncome } from "./reports";

function fixture() {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.modelVersion = 3;
  const root: RentOpsLedgerTransaction = { id: "receipt", propertyId: null, unitId: null, tenancyId: null, personId: "payer", kind: "payment", category: "base_rent", status: "posted", amountCents: 10000, postedOn: "2026-07-30", description: "Original receipt", allocationMode: "multi_property", source: {system: "rent_manager", entityType: "payment", sourceId: "123"}, sourceArtifactSha256: "a".repeat(64) };
  snapshot.ledgerTransactions.push(root);
  for (const [propertyId, amountCents] of [["a", 6000], ["b", 4000]] as const) {
    snapshot.properties.push({id: propertyId, name: propertyId, slug: propertyId, address: {line1: "1 Main", city: "Tampa", state: "FL", postalCode: "33601"}, propertyType: "multifamily", state: "active"});
    snapshot.ledgerTransactions.push({...root, id: `charge-${propertyId}`, propertyId, unitId: `unit-${propertyId}`, tenancyId: `tenancy-${propertyId}`, kind: "charge", amountCents, postedOn: "2026-07-01", allocationMode: null});
    snapshot.paymentAllocations.push({id: `allocation-${propertyId}`, paymentTransactionId: root.id, chargeTransactionId: `charge-${propertyId}`, amountCents, allocatedOn: propertyId === "a" ? "2026-08-02" : "2026-08-05"});
  }
  return snapshot;
}

test("shared receipt remains one root with a single remainder through allocation lag", () => {
  const snapshot = fixture();
  const original = structuredClone(snapshot);
  assert.deepEqual(deriveSharedPaymentApplications(snapshot, {asOfDate: "2026-07-29"}), []);
  const early = deriveSharedPaymentApplications(snapshot, {asOfDate: "2026-07-31"});
  assert.equal(early.length, 1);
  assert.equal(early[0].receiptAmountCents, 10000);
  assert.equal(early[0].paymentOn, "2026-07-30");
  assert.equal(early[0].unappliedCents, 10000);
  assert.deepEqual(early[0].propertyApplications, []);
  const partial = deriveSharedPaymentApplications(snapshot, {asOfDate: "2026-08-03"})[0];
  assert.deepEqual(partial.propertyApplications, [{propertyId: "a", allocatedCents: 6000}]);
  assert.equal(partial.unappliedCents, 4000);
  const complete = deriveSharedPaymentApplications(snapshot, {asOfDate: "2026-08-06"})[0];
  assert.equal(complete.allocatedCents, 10000);
  assert.equal(complete.unappliedCents, 0);
  assert.deepEqual(snapshot, original);
});

test("scoped ledger applies only its share on allocation day without duplicating receipt", () => {
  const snapshot = fixture();
  const before = deriveTenantLedger(snapshot, "tenancy-a", {asOfDate: "2026-08-01"});
  assert.equal(before.length, 1);
  assert.equal(before[0].openCents, 6000);
  assert.equal(before[0].runningBalanceCents, 6000);
  const after = deriveTenantLedger(snapshot, "tenancy-a", {asOfDate: "2026-08-03"});
  assert.equal(after[0].openCents, 0);
  assert.equal(after[1].transaction.postedOn, "2026-08-02");
  assert.equal(after[1].transaction.amountCents, 6000);
  assert.equal(after[1].runningBalanceCents, 0);
  assert.equal(after.some(row => row.transaction.id === "receipt"), false);
  assert.equal(deriveTenantLedger(snapshot, "tenancy-b", {asOfDate: "2026-08-03"}).at(-1)?.runningBalanceCents, 4000);
});

test("collected attribution keeps receipt month but cannot precede application", () => {
  const snapshot = fixture();
  assert.equal(deriveCollectedIncome(snapshot, {month: "2026-07", asOfDate: "2026-07-31"}).length, 0);
  const partial = deriveCollectedIncome(snapshot, {month: "2026-07", asOfDate: "2026-08-03"});
  assert.equal(partial.length, 1);
  assert.equal(partial[0].amountCents, 6000);
  assert.equal(partial[0].paymentOn, "2026-07-30");
  assert.equal(deriveCollectedIncome(snapshot, {month: "2026-08", asOfDate: "2026-08-06"}).length, 0);
  assert.equal(deriveCollectedIncome(snapshot, {month: "2026-07", asOfDate: "2026-08-06"}).reduce((sum, row) => sum + (row.amountCents ?? 0), 0), 10000);
});

test("signed source allocation reversals restore remainder and scoped balance; transfers add no cash", () => {
  const snapshot = fixture();
  snapshot.paymentAllocations.push({ ...snapshot.paymentAllocations[0], id: "reverse-a", kind: "reversal", amountCents: -1000, allocatedOn: "2026-08-07", source: {system: "rent_manager", entityType: "allocation", sourceId: "reverse"}, sourceArtifactSha256: "b".repeat(64), artifactObservationOn: "2026-08-08", paymentLinkKnowledge: "exact", chargeLinkKnowledge: "exact", amountKnowledge: "known", allocatedOnKnowledge: "source" });
  snapshot.paymentAllocations.push({...snapshot.paymentAllocations[0], id: "transfer", kind: "transfer", amountCents: 2000, allocatedOn: "2026-08-07"});
  const receipt = deriveSharedPaymentApplications(snapshot, {asOfDate: "2026-08-08"})[0];
  assert.equal(receipt.allocatedCents, 9000);
  assert.equal(receipt.unappliedCents, 1000);
  const ledger = deriveTenantLedger(snapshot, "tenancy-a", {asOfDate: "2026-08-08"});
  assert.equal(ledger[0].openCents, 1000);
  assert.equal(ledger.at(-1)?.runningBalanceCents, 1000);
  assert.equal(deriveCollectedIncome(snapshot, {month: "2026-07", asOfDate: "2026-08-08"}).reduce((sum, row) => sum + (row.amountCents ?? 0), 0), 9000);
});
