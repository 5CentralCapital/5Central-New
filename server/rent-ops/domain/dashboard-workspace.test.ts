import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveDashboardWorkspace, deriveDashboardSummary, deriveRentRoll, deriveDelinquency } from "./reports";
import type { RentOpsFilters } from "../../../shared/rent-ops-contracts";

function capture(work: () => unknown) {try {return {value: work()};} catch (error) {const e = error as {message?: string; violations?: unknown}; return {error: e.message, violations: e.violations};}}

test("dashboard workspace retains exact standalone summary and ordered report rows", () => {
  const snapshots = [structuredClone(syntheticRentOpsSnapshot())];
  for (const patch of [{tenancyId: null, tenancyLinkKnowledge: "unknown"}, {amountCents: null, amountKnowledge: "unknown"}, {personId: "demo-person-2", personLinkKnowledge: "exact"}]) {
    const snapshot = structuredClone(syntheticRentOpsSnapshot());
    Object.assign(snapshot.ledgerTransactions[0], patch);
    snapshots.push(snapshot);
  }
  const reversed = structuredClone(syntheticRentOpsSnapshot());
  const payment = reversed.ledgerTransactions.find(row => row.kind === "payment")!;
  reversed.ledgerTransactions.push({...payment, id: "dashboard-workspace-reversal", kind: "reversal", reversalOfId: payment.id, postedOn: "2026-08-10"});
  snapshots.push(reversed);
  const scopes: RentOpsFilters[] = [{}, {propertyId: "demo-property-a"}, {propertyId: "demo-property-b"}, {unitId: "demo-unit-a-1"}, {balanceStatus: "due"}, {balanceStatus: "credit"}, {occupancy: ["vacant"]}, {search: "no matching person"}];
  for (const snapshot of snapshots) for (const asOfDate of ["2026-07-15", "2026-08-05", "2026-08-16", "2026-11-01"]) for (const scope of scopes) {
    const filters = {...scope, asOfDate, month: asOfDate.slice(0,7)};
    const before = structuredClone(snapshot);
    const result = capture(() => deriveDashboardWorkspace(snapshot, filters));
    assert.deepEqual(result, capture(() => ({
      summary: deriveDashboardSummary(snapshot, filters),
      rentRoll: deriveRentRoll(snapshot, filters),
      delinquency: deriveDelinquency(snapshot, { ...filters, tenantStatus: "current" }),
    })));
    assert.deepEqual(snapshot, before);
  }
});

test("dashboard workspace does not retain rows or summary between calls", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const filters = {asOfDate: "2026-08-16"};
  const before = deriveDashboardWorkspace(snapshot, filters);
  Object.assign(snapshot.ledgerTransactions[0], {amountCents: null, amountKnowledge: "unknown"});
  const after = deriveDashboardWorkspace(snapshot, filters);
  assert.notDeepEqual(after.rentRoll, before.rentRoll);
  assert.notDeepEqual(after.delinquency, before.delinquency);
  assert.equal(after.summary.balanceComplete, false);
});
