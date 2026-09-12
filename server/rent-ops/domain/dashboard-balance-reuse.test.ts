import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import type { RentOpsFilters, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { deriveDashboardSummary, deriveDelinquency, deriveRentRoll } from "./reports";

function fixtures(): RentOpsSnapshot[] {
  const base = structuredClone(syntheticRentOpsSnapshot());
  const variants = [base];
  for (const patch of [
    { tenancyId: null, tenancyLinkKnowledge: "unknown" },
    { tenancyId: "missing-tenancy", tenancyLinkKnowledge: "ambiguous", personId: null },
    { tenancyId: "demo-tenancy-1", personId: "demo-person-2", personLinkKnowledge: "exact" },
    { amountCents: null, amountKnowledge: "unknown" },
    { postedOn: null },
  ] as const) {
    const value = structuredClone(base);
    Object.assign(value.ledgerTransactions[0], patch);
    variants.push(value);
  }
  const reversal = structuredClone(base);
  reversal.ledgerTransactions.push({...reversal.ledgerTransactions[0], id: "synthetic-reversal", kind: "reversal", reversalOfId: reversal.ledgerTransactions[0].id, postedOn: "2026-08-10"});
  variants.push(reversal);
  return variants;
}

const filterCases: RentOpsFilters[] = [
  {}, {propertyId: "demo-property-a"}, {propertyId: "demo-property-b"},
  {unitId: "demo-unit-a-1"}, {unitId: "demo-unit-a-2"},
  {balanceStatus: "due"}, {balanceStatus: "credit"}, {balanceStatus: "zero"},
  {search: "no matching tenant"}, {occupancy: ["vacant"]},
];

function dashboardParityCases() {
  return fixtures().flatMap(snapshot => ["2026-07-15", "2026-08-05", "2026-08-16"].flatMap(asOfDate => filterCases.map(filters => ({snapshot, filters: {...filters, asOfDate}}))));
}

test("dashboard balance reuse preserves independent report totals and unknown/unlinked scopes", () => {
  for (const {snapshot, filters} of dashboardParityCases()) {
    const dashboard = deriveDashboardSummary(snapshot, filters);
    const rentRoll = deriveRentRoll(snapshot, filters);
    const delinquency = deriveDelinquency(snapshot, filters);
    const unknownOccupancy = rentRoll.filter(row => row.occupancy === "unknown");
    const unresolvedCount = delinquency.filter(row => row.balanceComplete === false).length + unknownOccupancy.length;
    assert.equal(dashboard.balanceUnresolvedCount, unresolvedCount);
    assert.equal(dashboard.balanceComplete, unresolvedCount === 0);
    assert.deepEqual(dashboard.balanceUncertaintyCodes, [...new Set([...delinquency.flatMap(row => row.balanceUncertaintyCodes ?? []), ...unknownOccupancy.flatMap(row => row.balanceUncertaintyCodes ?? ["tenancy_balance_scope_unknown"])])].sort());
    assert.equal(dashboard.rentOnlyDelinquencyCents, unresolvedCount ? null : delinquency.reduce((sum, row) => sum + Math.max(0, row.rentOnlyBalanceCents!), 0));
    assert.equal(dashboard.totalDelinquencyCents, unresolvedCount ? null : delinquency.reduce((sum, row) => sum + Math.max(0, row.totalBalanceCents!), 0));
    assert.equal(dashboard.unappliedCashCents, unresolvedCount ? null : delinquency.reduce((sum, row) => sum + row.unappliedCashCents!, 0));
  }
});

test("dashboard balance reuse cannot retain values across calls on the same snapshot", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.ledgerTransactions = [snapshot.ledgerTransactions[0]];
  snapshot.paymentAllocations = [];
  const filters = {asOfDate: "2026-08-16"};
  const before = deriveDashboardSummary(snapshot, filters);
  snapshot.ledgerTransactions[0].amountCents! += 12345;
  const after = deriveDashboardSummary(snapshot, filters);
  assert.equal(after.totalDelinquencyCents, before.totalDelinquencyCents! + 12345);
  Object.assign(snapshot.ledgerTransactions[0], {tenancyId: null, tenancyLinkKnowledge: "unknown"});
  assert.equal(deriveDashboardSummary(snapshot, filters).balanceComplete, false);
});
