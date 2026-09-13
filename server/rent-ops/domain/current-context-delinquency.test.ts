import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { createBalanceReviewEvent, balanceReviewLedgerFingerprint } from "./balance-review";
import {
  deriveDashboardWorkspace,
  deriveDelinquency,
  deriveSharedPaymentApplications,
  deriveTenantProfile,
} from "./reports";
import { serializeDelinquencyRow } from "../presentation/reports";
import type { DelinquencyRow, RentOpsLedgerTransaction, RentOpsSnapshot, RentOpsTenancy } from "../../../shared/rent-ops-contracts";

function transferSnapshot(crossProperty = false): { snapshot: RentOpsSnapshot; prior: RentOpsTenancy; current: RentOpsTenancy } {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const prior = snapshot.tenancies[0]!;
  const destination = crossProperty ? snapshot.units.find(unit => unit.id === "demo-unit-b-2")! : snapshot.units.find(unit => unit.id === "demo-unit-a-3")!;
  prior.operationalEndConfirmedOn = "2026-08-10";
  prior.operationalEndConfirmationKnowledge = "manual";
  const current: RentOpsTenancy = {
    ...prior,
    id: "demo-transfer-current",
    propertyId: destination.propertyId,
    unitId: destination.id,
    actualMoveInOn: undefined,
    actualMoveInKnowledge: "unknown",
    occupancyConfirmedOn: "2026-08-10",
    occupancyConfirmationKnowledge: "manual",
    statusKnowledge: "manual",
    operationalEndConfirmedOn: undefined,
    operationalEndConfirmationKnowledge: undefined,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
  snapshot.tenancies.push(current);
  const existingCharge = snapshot.ledgerTransactions.find(transaction => transaction.id === "demo-charge-rent-1")!;
  snapshot.ledgerTransactions.push({
    ...existingCharge,
    id: "demo-transfer-charge",
    propertyId: current.propertyId,
    unitId: current.unitId,
    tenancyId: current.id,
    amountCents: 20000,
    postedOn: "2026-08-10",
    dueOn: "2026-08-10",
    description: "Transfer charge",
    propertyLinkKnowledge: "manual",
    unitLinkKnowledge: "manual",
    tenancyLinkKnowledge: "manual",
    personLinkKnowledge: "manual",
  });
  return { snapshot, prior, current };
}

function addCurrentZeroReview(snapshot: RentOpsSnapshot, current: RentOpsTenancy): void {
  snapshot.activityEvents.push(createBalanceReviewEvent({
    schema: "balance_review_v1",
    id: "demo-transfer-review",
    tenancyId: current.id,
    personId: current.primaryPersonId,
    propertyId: current.propertyId,
    unitId: current.unitId,
    asOfDate: "2026-08-16",
    reviewedAt: "2026-08-16T12:00:00.000Z",
    reviewedBy: "owner",
    ledgerFingerprint: balanceReviewLedgerFingerprint(snapshot, current.primaryPersonId),
    reviewedBalanceCents: 0,
    tenantBalanceCents: 0,
    agencyBalanceCents: 0,
    qualifications: ["Owner reviewed"],
    sourceRefs: ["owner-review:2026-08-16"],
  }));
}

function addSharedPaymentAndReversal(snapshot: RentOpsSnapshot, chargeTransactionId: string): void {
  const payment: RentOpsLedgerTransaction = {
    id: "demo-shared-payment",
    propertyId: null,
    unitId: null,
    tenancyId: "demo-tenancy-3",
    personId: null,
    kind: "payment",
    category: "other",
    status: "posted",
    amountCents: 10000,
    postedOn: "2026-08-11",
    description: "Shared agency receipt",
    allocationMode: "multi_property",
    tenancyLinkKnowledge: "manual",
    amountKnowledge: "known",
    postedOnKnowledge: "manual",
    statusKnowledge: "manual",
  };
  snapshot.ledgerTransactions.push(payment, {
    ...payment,
    id: "demo-shared-payment-reversal",
    kind: "reversal",
    reversalOfId: payment.id,
    postedOn: "2026-08-12",
    description: "Returned shared agency receipt",
  });
  snapshot.paymentAllocations.push({
    id: "demo-shared-payment-application",
    paymentTransactionId: payment.id,
    chargeTransactionId,
    amountCents: 5000,
    allocatedOn: "2026-08-11",
    paymentLinkKnowledge: "manual",
    chargeLinkKnowledge: "manual",
    amountKnowledge: "known",
    allocatedOnKnowledge: "manual",
  });
}

function balanceFields(row: DelinquencyRow): unknown[] {
  return [
    row.operationalBalanceCents,
    row.rentOnlyBalanceCents,
    row.nonRentBalanceCents,
    row.grossBalanceCents,
    row.totalBalanceCents,
    row.netAccountBalanceCents,
    row.unappliedCashCents,
    row.prepaidCents,
    row.balanceComplete,
    row.balanceUncertaintyCodes,
  ];
}

test("default dashboard matches the current account report and deduplicates a same-property transfer", () => {
  const { snapshot, prior, current } = transferSnapshot();
  const filters = { asOfDate: "2026-08-16" as const };
  const before = structuredClone(snapshot);
  const expected = deriveDelinquency(snapshot, { ...filters, tenantStatus: "current" });
  const dashboard = deriveDashboardWorkspace(snapshot, filters).delinquency;
  assert.deepEqual(dashboard, expected);

  const currentRows = dashboard.filter(row => row.personId === prior.primaryPersonId);
  assert.equal(currentRows.length, 1);
  assert.equal(currentRows[0]!.propertyId, prior.propertyId);
  assert.equal(currentRows[0]!.unitId, current.unitId);
  assert.equal(currentRows[0]!.unitNumber, "3A");
  assert.equal(currentRows[0]!.tenancyId, null);
  assert.equal(serializeDelinquencyRow(currentRows[0]!).unitId, current.unitId);

  const historical = deriveDashboardWorkspace(snapshot, { asOfDate: "2026-08-09" }).delinquency.filter(row => row.personId === prior.primaryPersonId);
  assert.equal(historical.length, 1);
  assert.equal(historical[0]!.propertyId, prior.propertyId);
  assert.equal(historical[0]!.unitId, prior.unitId);

  const explicitAll = deriveDashboardWorkspace(snapshot, { ...filters, tenantStatus: "all" }).delinquency;
  assert.deepEqual(explicitAll, deriveDelinquency(snapshot, { ...filters, tenantStatus: "all" }));
  const historyRows = explicitAll.filter(row => row.personId === prior.primaryPersonId);
  assert.equal(historyRows.length, 1);
  assert.deepEqual([historyRows[0]!.propertyId, historyRows[0]!.unitId], [prior.propertyId, current.unitId]);

  const line = deriveTenantProfile(snapshot, prior.primaryPersonId, filters)!.ledger.find(entry => entry.transaction.id === "demo-charge-rent-1")!;
  assert.equal(line.transaction.unitId, prior.unitId);
  assert.equal(line.transaction.postedOn, "2026-08-01");
  assert.deepEqual(snapshot, before);
});

test("a current zero review is excluded from default due rows while the current account remains inspectable", () => {
  const { snapshot, prior, current } = transferSnapshot();
  addCurrentZeroReview(snapshot, current);
  const filters = { asOfDate: "2026-08-16" as const };
  const reviewed = deriveDashboardWorkspace(snapshot, filters).delinquency.filter(row => row.personId === prior.primaryPersonId);
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0]!.unitId, current.unitId);
  assert.equal(reviewed[0]!.operationalBalanceCents, 0);
  assert.equal(reviewed[0]!.totalBalanceCents, 127500);
  assert.equal(reviewed[0]!.balanceReview?.reviewedBalanceCents, 0);

  const due = deriveDashboardWorkspace(snapshot, { ...filters, balanceStatus: "due" }).delinquency.filter(row => row.personId === prior.primaryPersonId);
  assert.deepEqual(due, []);
  const zero = deriveDashboardWorkspace(snapshot, { ...filters, balanceStatus: "zero" }).delinquency.filter(row => row.personId === prior.primaryPersonId);
  assert.deepEqual(zero, deriveDelinquency(snapshot, { ...filters, tenantStatus: "current", balanceStatus: "zero" }).filter(row => row.personId === prior.primaryPersonId));
  assert.equal(zero.length, 1);
  assert.equal(zero[0]!.unitId, current.unitId);
});

test("shared payments and reversals preserve current account balances and report parity", () => {
  const { snapshot, prior, current } = transferSnapshot();
  const filters = { asOfDate: "2026-08-16" as const };
  const baseline = deriveDelinquency(snapshot, { ...filters, tenantStatus: "current" }).filter(row => row.personId === prior.primaryPersonId);
  addSharedPaymentAndReversal(snapshot, "demo-transfer-charge");
  const before = structuredClone(snapshot);
  const report = deriveDelinquency(snapshot, { ...filters, tenantStatus: "current" }).filter(row => row.personId === prior.primaryPersonId);
  const dashboard = deriveDashboardWorkspace(snapshot, filters).delinquency.filter(row => row.personId === prior.primaryPersonId);
  assert.deepEqual(dashboard, report);
  assert.deepEqual(report.map(balanceFields), baseline.map(balanceFields));
  assert.equal(report[0]!.unitId, current.unitId);

  const during = deriveSharedPaymentApplications(snapshot, { asOfDate: "2026-08-11" });
  assert.equal(during.length, 1);
  assert.equal(during[0]!.allocatedCents, 5000);
  assert.equal(during[0]!.unappliedCents, 5000);
  assert.deepEqual(deriveSharedPaymentApplications(snapshot, filters), []);
  assert.deepEqual(snapshot, before);
});

test("cross-property transfer scopes current account to its current property and retains historical attribution", () => {
  const { snapshot, prior, current } = transferSnapshot(true);
  const filters = { asOfDate: "2026-08-16" as const };
  const before = structuredClone(snapshot);
  const dashboard = deriveDashboardWorkspace(snapshot, filters).delinquency.filter(row => row.personId === prior.primaryPersonId);
  const currentReport = deriveDelinquency(snapshot, { ...filters, tenantStatus: "current" }).filter(row => row.personId === prior.primaryPersonId);
  assert.deepEqual(dashboard, currentReport);
  assert.deepEqual(dashboard.map(row => [row.propertyId, row.unitId]), [[current.propertyId, current.unitId]]);
  assert.equal(dashboard[0]!.totalBalanceCents, 20000);

  const historical = deriveDashboardWorkspace(snapshot, { ...filters, tenantStatus: "all" }).delinquency.filter(row => row.personId === prior.primaryPersonId);
  assert.deepEqual(historical.map(row => [row.propertyId, row.unitId]).sort(), [[current.propertyId, current.unitId], [prior.propertyId, prior.unitId]].sort());
  assert.equal(historical.find(row => row.propertyId === prior.propertyId)!.totalBalanceCents, 107500);
  assert.equal(historical.find(row => row.propertyId === current.propertyId)!.totalBalanceCents, 20000);

  const priorScope = deriveDashboardWorkspace(snapshot, { ...filters, propertyId: prior.propertyId, tenantStatus: "all" }).delinquency.filter(row => row.personId === prior.primaryPersonId);
  assert.deepEqual(priorScope.map(row => [row.propertyId, row.unitId]), [[prior.propertyId, prior.unitId]]);
  assert.deepEqual(snapshot, before);
});
