import assert from "node:assert/strict";
import test from "node:test";
import { eligibleCharges } from "../payments/model";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveDashboardSummary, deriveDelinquency, deriveRentRoll, deriveTenantLedger, deriveTenantProfile } from "./reports";
import { serializeDashboardSummary, serializeAdminTenantProfile } from "../presentation/entities";
import { serializeDelinquencyRow, serializeLedgerRow, serializeRentRollRow } from "../presentation/reports";
import type { RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";

const filters = { asOfDate: "2026-08-16" };
function fixture() {
  const snapshot = syntheticRentOpsSnapshot();
  snapshot.ledgerTransactions = []; snapshot.paymentAllocations = [];
  snapshot.people.forEach(row => { row.source = undefined; });
  snapshot.tenancies.forEach(row => { row.source = undefined; });
  const tenancy = snapshot.tenancies.find(row => row.status === "current")!;
  const person = snapshot.people.find(row => row.id === tenancy.primaryPersonId)!;
  const charge = (patch: Partial<RentOpsLedgerTransaction> = {}): RentOpsLedgerTransaction => ({ id: "synthetic-charge", propertyId: tenancy.propertyId, unitId: tenancy.unitId, tenancyId: tenancy.id, personId: person.id, kind: "charge", category: "base_rent", status: "posted", amountCents: 12345, postedOn: "2026-08-01", description: "Synthetic", ...patch });
  return { snapshot, tenancy, person, charge };
}

test("account debt spanning leases never becomes lease zero or gets duplicated into a lease", () => {
  const { snapshot, tenancy, person, charge } = fixture();
  person.source = { system: "rent_manager", sourceId: "tenant:123" };
  snapshot.tenancies.push({ ...tenancy, id: "synthetic-prior-lease", status: "past" });
  snapshot.ledgerTransactions.push(charge({ tenancyId: null, unitId: null, personLinkKnowledge: "exact", source: { system: "rent_manager", sourceId: "entry:123", entityType: "ledger_transaction" }, sourceArtifactSha256: "a".repeat(64) }));
  const before = structuredClone(snapshot);
  const roll = deriveRentRoll(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
  const due = deriveDelinquency(snapshot, { ...filters, balanceStatus: "due" }).find(row => row.tenancyId === tenancy.id)!;
  const summary = deriveDashboardSummary(snapshot, filters);
  assert.equal(roll.balanceDueCents, null); assert.equal(roll.balanceComplete, false);
  assert.equal(due.rentOnlyBalanceCents, null); assert.equal(due.totalBalanceCents, null);
  // The dashboard summary is account-scoped: this exact person-linked,
  // property-scoped ledger row is known for the account even though it cannot
  // be attributed to either lease row, so the tenancy reports stay unknown.
  assert.equal(summary.rentOnlyDelinquencyCents, 12345); assert.equal(summary.balanceComplete, true);
  assert.equal(serializeRentRollRow(roll).balanceDueCents, null);
  assert.equal(serializeDelinquencyRow(due).totalBalanceCents, null);
  assert.equal(serializeDashboardSummary(summary).rentOnlyDelinquencyCents, 12345);
  const ledger = deriveTenantProfile(snapshot, person.id, filters)!.ledger;
  assert.equal(ledger.length, 1); assert.equal(ledger[0].transaction.tenancyId, null);
  assert.equal(ledger[0].runningBalanceCents, 12345);
  assert.deepEqual(snapshot, before);
});

test("unknown amounts and dates stay visible but cannot establish balances or carry-forward zero", () => {
  for (const patch of [{ amountCents: null }, { postedOn: null }] as Partial<RentOpsLedgerTransaction>[]) {
    const { snapshot, tenancy, person, charge } = fixture();
    snapshot.ledgerTransactions.push(charge(patch));
    assert.equal(deriveRentRoll(snapshot, filters).find(row => row.tenancyId === tenancy.id)!.balanceDueCents, null);
    const rows = deriveTenantLedger(snapshot, tenancy.id, { ...filters, fromDate: "2026-08-10" });
    assert.equal(rows[0].openingBalanceCents, null);
    assert.equal(rows[0].balanceComplete, false);
    const profile = deriveTenantProfile(snapshot, person.id, filters)!;
    assert.equal(profile.ledger.length, 1);
    assert.equal(profile.ledger[0].runningBalanceCents, null);
    assert.equal(serializeLedgerRow(profile.ledger[0]).runningBalanceCents, null);
    assert.equal(serializeAdminTenantProfile(profile).ledger[0].runningBalanceCents, null);
  }
});

test("known native zero remains numeric while imported missing history remains unavailable", () => {
  const { snapshot, tenancy, person } = fixture();
  let row = deriveRentRoll(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
  assert.equal(row.balanceDueCents, 0); assert.equal(row.balanceComplete, true);
  assert.equal(deriveDashboardSummary(snapshot, filters).rentOnlyDelinquencyCents, 0);
  person.source = { system: "rent_manager", sourceId: "tenant:123" };
  row = deriveRentRoll(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
  assert.equal(row.balanceDueCents, null);
  assert.ok(row.balanceUncertaintyCodes?.includes("imported_account_history_unverified"));
});

test("known unrelated person/property/lease evidence does not poison a native zero", () => {
  const { snapshot, tenancy, charge } = fixture();
  snapshot.tenancies.push({ ...tenancy, id: "different-lease", status: "past" });
  snapshot.ledgerTransactions.push(charge({ tenancyId: null, personId: "different-person", amountCents: null }), charge({ id: "other-property", tenancyId: null, propertyId: "different-property", amountCents: null }), charge({ id: "other-lease", tenancyId: "different-lease", amountCents: null }));
  const row = deriveRentRoll(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
  assert.equal(row.balanceDueCents, 0); assert.equal(row.balanceComplete, true);
  snapshot.ledgerTransactions.push(charge({ id: "conflicting-scope", personId: "different-person", propertyId: "different-property" }));
  const conflict = deriveRentRoll(snapshot, filters).find(row => row.tenancyId === tenancy.id)!;
  assert.equal(conflict.balanceDueCents, null);
  assert.ok(conflict.balanceUncertaintyCodes?.includes("ledger_scope_conflict"));
});

test("unknown occupancy cannot disappear from portfolio balance completeness", () => {
  const { snapshot, tenancy } = fixture();
  tenancy.status = null as never;
  const row = deriveRentRoll(snapshot, filters).find(row => row.unitId === tenancy.unitId)!;
  assert.equal(row.occupancy, "unknown"); assert.equal(row.balanceDueCents, null);
  const summary = deriveDashboardSummary(snapshot, filters);
  assert.equal(summary.rentOnlyDelinquencyCents, null); assert.equal(summary.balanceComplete, false);
  assert.ok((summary.balanceUnresolvedCount ?? 0) > 0);
});


test("eligible payment charges require known derived amounts, preserving the native known-charge path", () => {
  const { snapshot, tenancy, charge } = fixture();
  snapshot.ledgerTransactions.push(charge());
  assert.equal(eligibleCharges(snapshot, tenancy.id, filters.asOfDate)[0]?.openCents, 12345);
  snapshot.ledgerTransactions.push(charge({ id: "unknown-amount", amountCents: null }));
  assert.deepEqual(eligibleCharges(snapshot, tenancy.id, filters.asOfDate), []);
});
