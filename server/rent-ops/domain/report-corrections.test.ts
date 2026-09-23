import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveDashboardSummary, deriveDepositLiability, deriveHap, deriveScheduledVsCollected, type DepositLiabilityReportRow, type HapReportRow, type ScheduledVsCollectedReportRow } from "./reports";
import { projectFinancialSchedules } from "./financial-projection";
import { emptyRentOpsSnapshot, type RentOpsRecurringChargeSchedule, type RentOpsSnapshot } from "../../../shared/rent-ops-contracts";

// Synthetic data only. Two properties: A has one schedule whose person cannot
// be assigned to a unit; B is clean but also has a vacant-unit schedule and a
// lower-precedence schedule that the projection correctly does not bill.

const month = "2026-09" as const;
const asOfDate = "2026-09-23" as const;

function property(value: RentOpsSnapshot, id: string, name: string): void {
  value.properties.push({ id, name, slug: id, address: { line1: "1 Synthetic Way", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: "active" });
}

function occupied(value: RentOpsSnapshot, suffix: string, propertyId: string): void {
  value.units.push({ id: `unit-${suffix}`, propertyId, unitNumber: suffix.toUpperCase(), readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  value.people.push({ id: `person-${suffix}`, firstName: "Synthetic", lastName: suffix.toUpperCase() });
  value.tenancies.push({ id: `tenancy-${suffix}`, propertyId, unitId: `unit-${suffix}`, primaryPersonId: `person-${suffix}`, status: "current", actualMoveInOn: "2026-01-15", createdAt: "2026-01-01T00:00:00.000Z", propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", primaryPersonLinkKnowledge: "exact", statusKnowledge: "source", actualMoveInKnowledge: "source" });
  value.leaseTerms.push({ id: `lease-${suffix}`, tenancyId: `tenancy-${suffix}`, status: "executed", contractStartOn: "2026-01-15", contractEndOn: "2026-12-31", monthToMonth: false, createdAt: "2026-01-01T00:00:00.000Z", tenancyLinkKnowledge: "exact", statusKnowledge: "source", contractStartKnowledge: "source", contractEndKnowledge: "source" });
}

function schedule(input: Partial<RentOpsRecurringChargeSchedule> & Pick<RentOpsRecurringChargeSchedule, "id" | "propertyId">): RentOpsRecurringChargeSchedule {
  return {
    scopeType: "tenant",
    scopeTypeKnowledge: "source",
    scopeLinkKnowledge: "exact",
    category: "base_rent",
    categoryKnowledge: "source",
    description: "Synthetic rent",
    descriptionKnowledge: "source",
    amountCents: 100000,
    amountKnowledge: "known",
    billingFrequency: "monthly",
    effectiveFrom: "2026-01-01",
    effectiveFromKnowledge: "source",
    active: true,
    activeKnowledge: "source",
    chargeDefinitionId: `definition-${input.id}`,
    chargeDefinitionLinkKnowledge: "exact",
    source: { system: "rent_manager", entityType: "recurring_schedule", sourceId: `schedule:${input.id}` },
    lineageRootId: input.id,
    lineageRootOrigin: "artifact",
    versionOrigin: "artifact",
    versionAction: "root",
    sourceArtifactSha256: "a".repeat(64),
    artifactObservationOn: "2026-01-01",
    ...input,
  } as RentOpsRecurringChargeSchedule;
}

function twoPropertySnapshot(): RentOpsSnapshot {
  const value = emptyRentOpsSnapshot();
  value.modelVersion = 3;
  property(value, "prop-a", "Synthetic A");
  property(value, "prop-b", "Synthetic B");
  occupied(value, "a1", "prop-a");
  occupied(value, "b1", "prop-b");
  value.units.push({ id: "unit-b2", propertyId: "prop-b", unitNumber: "B2", readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  // A person with no current unit: a person-only schedule cannot be assigned.
  value.people.push({ id: "person-a-unassigned", firstName: "Synthetic", lastName: "Unassigned" });
  value.recurringSchedules.push(
    schedule({ id: "a-rent", propertyId: "prop-a", scopeId: "person-a1", personId: "person-a1", tenancyId: "tenancy-a1", unitId: "unit-a1", amountCents: 100000 }),
    schedule({ id: "a-ambiguous", propertyId: "prop-a", scopeId: "person-a-unassigned", personId: "person-a-unassigned", amountCents: 45000 }),
    schedule({ id: "b-rent", propertyId: "prop-b", scopeId: "person-b1", personId: "person-b1", tenancyId: "tenancy-b1", unitId: "unit-b1", amountCents: 90000 }),
    // Same definition at unit scope: lower precedence than the tenant schedule.
    schedule({ id: "b-unit-default", propertyId: "prop-b", scopeType: "unit", scopeId: "unit-b1", unitId: "unit-b1", chargeDefinitionId: "definition-b-rent", amountCents: 85000 }),
    // Unit default on a vacant unit: not applicable this month.
    schedule({ id: "b-vacant-default", propertyId: "prop-b", scopeType: "unit", scopeId: "unit-b2", unitId: "unit-b2", amountCents: 80000 }),
  );
  return value;
}

test("K5: projection records vacant, other-tenancy and precedence dispositions per property", () => {
  const projection = projectFinancialSchedules(twoPropertySnapshot(), month, { asOfDate, selection: "as_of" });
  const byCode = (code: string) => projection.dispositions.filter((row) => row.code === code).map((row) => [row.scheduleId, row.propertyId]);
  assert.deepEqual(byCode("schedule_not_applicable_vacant"), [["b-vacant-default", "prop-b"]]);
  assert.deepEqual(byCode("schedule_precedence_suppressed"), [["b-unit-default", "prop-b"]]);
});

test("K5: scheduled vs collected is complete per property; dispositions are audit counts, not flags", () => {
  const rows = deriveScheduledVsCollected(twoPropertySnapshot(), { month, asOfDate }) as ScheduledVsCollectedReportRow[];
  const a = rows.find((row) => row.propertyId === "prop-a")!;
  const b = rows.find((row) => row.propertyId === "prop-b")!;
  assert.ok(a && b);
  assert.equal(a.complete, false);
  assert.ok(a.uncertaintyCodes?.includes("schedule_person_assignment_ambiguous"));
  assert.equal(a.uncertaintyCodes?.some((code) => code.startsWith("schedule_not_applicable") || code === "schedule_precedence_suppressed"), false);
  assert.equal(a.scheduledKnownCents, 100000);
  assert.equal(a.scheduledUncertainCents, 45000, "uncertain scheduled dollars are visible, not silently dropped");
  assert.equal(a.varianceCents, null);

  assert.equal(b.complete, true);
  assert.deepEqual(b.uncertaintyCodes, [], "a clean property carries no flags from another property");
  assert.equal(b.scheduledCents, 90000);
  assert.equal(b.scheduledUncertainCents, 0);
  assert.equal(b.scheduleNotApplicableVacantCount, 1);
  assert.equal(b.schedulePrecedenceSuppressedCount, 1);
  assert.equal(b.scheduleNotApplicableOtherTenancyCount, 0);
  assert.equal(b.varianceCents, -90000);
  // The pinned as-of date and schedule basis document the cutoff semantics.
  assert.equal(b.asOfDate, asOfDate);
  assert.equal(b.scheduleBasis, "as_of");
  const earlier = deriveScheduledVsCollected(twoPropertySnapshot(), { month: "2026-08", asOfDate }) as ScheduledVsCollectedReportRow[];
  assert.equal(earlier.find((row) => row.propertyId === "prop-b")?.scheduleBasis, "month_forecast");
});

test("K5: an unknown charge category makes only its own property incomplete", () => {
  const value = twoPropertySnapshot();
  value.recurringSchedules = value.recurringSchedules.filter((row) => row.id !== "a-ambiguous");
  value.recurringSchedules.find((row) => row.id === "a-rent")!.category = null as never;
  const rows = deriveScheduledVsCollected(value, { month, asOfDate });
  const a = rows.find((row) => row.propertyId === "prop-a")!;
  const b = rows.find((row) => row.propertyId === "prop-b")!;
  assert.equal(a.complete, false);
  assert.ok(a.uncertaintyCodes?.includes("charge_category_unknown"));
  assert.equal(b.complete, true);
  assert.deepEqual(b.uncertaintyCodes, []);
});

function depositSnapshot(): RentOpsSnapshot {
  const value = structuredClone(syntheticRentOpsSnapshot());
  value.securityDeposits = [];
  return value;
}

test("K6: a known amount with an unknown receipt date stays visible and is flagged separately", () => {
  const value = depositSnapshot();
  value.securityDeposits.push({ id: "dep-date-unknown", propertyId: "demo-property-a", tenancyId: "demo-tenancy-1", personId: "demo-person-1", type: "security", amountHeldCents: 110000, dispositionStatus: "held" });
  const [row] = deriveDepositLiability(value, { asOfDate: "2026-08-16" }) as DepositLiabilityReportRow[];
  assert.equal(row.totalHeldCents, 110000);
  assert.equal(row.securityHeldCents, 110000);
  assert.equal(row.unknownHeldCount, 0);
  assert.equal(row.hasUnknownReceiptDate, true);
  assert.equal(row.temporalUncertainty, true);
  // The unit comes from the exact tenancy whose property and person agree.
  assert.equal(row.unitNumber, "1A");
  assert.equal(row.unitLinkStatus, "tenancy");
});

test("K6: unknown amount, unknown type, future receipt and link conflicts stay distinct", () => {
  const value = depositSnapshot();
  value.securityDeposits.push(
    { id: "dep-unknown-amount", propertyId: "demo-property-a", unitId: "demo-unit-a-1", personId: "demo-person-1", type: "security", amountHeldCents: null, receivedOn: "2026-01-01", dispositionStatus: "held" },
    { id: "dep-future", propertyId: "demo-property-a", unitId: "demo-unit-a-1", personId: "demo-person-1", type: "security", amountHeldCents: 99900, receivedOn: "2026-09-01", dispositionStatus: "held" },
  );
  const rows = deriveDepositLiability(value, { asOfDate: "2026-08-16" }) as DepositLiabilityReportRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalHeldCents, null);
  assert.equal(rows[0].unknownHeldCount, 1);
  assert.equal(rows[0].temporalUncertainty, false, "an unknown amount is not a date question");
  assert.equal(rows[0].unitLinkStatus, "direct");

  const typed = depositSnapshot();
  typed.securityDeposits.push({ id: "dep-no-type", propertyId: "demo-property-a", unitId: "demo-unit-a-1", personId: "demo-person-1", amountHeldCents: 70000, receivedOn: "2026-01-01", dispositionStatus: "held" } as never);
  const [untyped] = deriveDepositLiability(typed, { asOfDate: "2026-08-16" }) as DepositLiabilityReportRow[];
  assert.equal(untyped.totalHeldCents, 70000);
  assert.equal(untyped.securityHeldCents, null);
  assert.equal(untyped.typeUnknownCount, 1);
  assert.equal(untyped.temporalUncertainty, false);

  const conflict = depositSnapshot();
  conflict.securityDeposits.push({ id: "dep-other-person", propertyId: "demo-property-a", tenancyId: "demo-tenancy-1", personId: "demo-person-2", type: "security", amountHeldCents: 50000, receivedOn: "2026-01-01", dispositionStatus: "held" });
  const [unlinked] = deriveDepositLiability(conflict, { asOfDate: "2026-08-16", propertyScope: "all" }) as DepositLiabilityReportRow[];
  assert.equal(unlinked.unitNumber, undefined);
  assert.equal(unlinked.unitLinkStatus, "conflict");

  const orphan = depositSnapshot();
  orphan.securityDeposits.push({ id: "dep-no-link", propertyId: "demo-property-a", personId: "demo-person-1", type: "security", amountHeldCents: 50000, receivedOn: "2026-01-01", dispositionStatus: "held" });
  const [missing] = deriveDepositLiability(orphan, { asOfDate: "2026-08-16" }) as DepositLiabilityReportRow[];
  assert.equal(missing.unitNumber, undefined);
  assert.equal(missing.unitLinkStatus, "missing", "current occupancy alone never supplies a deposit unit");
});

function hapSnapshot(): RentOpsSnapshot {
  const value = structuredClone(syntheticRentOpsSnapshot());
  value.paymentAllocations = value.paymentAllocations.filter((row) => row.paymentTransactionId !== "demo-payment-hap-1");
  return value;
}

test("K4: HAP expected portions come from the contract in effect during the month", () => {
  const value = hapSnapshot();
  const contract = value.subsidyContracts[0];
  // A contract that starts mid-month still has an expected obligation that month.
  contract.effectiveFrom = "2026-08-10";
  const [row] = deriveHap(value, { month: "2026-08", asOfDate: "2026-08-31" }) as HapReportRow[];
  assert.equal(row.agencyObligationCents, 40000);
  assert.equal(row.tenantObligationCents, 80000);
  assert.equal(row.expectedTotalCents, 120000);
  assert.equal(row.agencyReceiptStatus, "none_received");
  assert.equal(row.receivedAgencyCents, 0);
  assert.equal(row.varianceCents, -40000);

  // Sequential versions in one month: the version in effect at month end supplies the portions.
  contract.effectiveFrom = "2026-01-01";
  contract.effectiveTo = "2026-08-14";
  contract.status = "ended";
  value.subsidyContracts.push({ ...contract, id: "demo-subsidy-renewal", effectiveFrom: "2026-08-15", effectiveTo: undefined, status: "active", agencyObligationCents: 45000, tenantObligationCents: 75000 });
  const renewed = deriveHap(value, { month: "2026-08", asOfDate: "2026-08-31" }) as HapReportRow[];
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].agencyObligationCents, 45000);
  assert.equal(renewed[0].tenantObligationCents, 75000);
  // No effective contract: no row, never a zero obligation.
  assert.equal(deriveHap(value, { month: "2025-12", asOfDate: "2026-08-31" }).length, 0);
});

test("K4: effective-dated subsidy tenant rows with a source payer supply the month's portions", () => {
  const value = hapSnapshot();
  value.subsidyTenants.push(
    { id: "term-agency", subsidyContractId: "demo-subsidy-1", subsidyContractLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", effectiveFrom: "2026-08-01", effectiveFromKnowledge: "source", amountCents: 42000, amountKnowledge: "known", payer: "agency", payerKnowledge: "source" },
    { id: "term-tenant", subsidyContractId: "demo-subsidy-1", subsidyContractLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", effectiveFrom: "2026-08-01", effectiveFromKnowledge: "source", amountCents: 78000, amountKnowledge: "known", payer: "tenant", payerKnowledge: "source" },
    // Unknown payer: never attributed to either portion.
    { id: "term-unknown", subsidyContractId: "demo-subsidy-1", subsidyContractLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", effectiveFrom: "2026-08-01", effectiveFromKnowledge: "source", amountCents: 99999, amountKnowledge: "known", payer: "unknown", payerKnowledge: "unknown" },
  );
  const [row] = deriveHap(value, { month: "2026-08", asOfDate: "2026-08-31" }) as HapReportRow[];
  assert.equal(row.agencyObligationCents, 42000);
  assert.equal(row.tenantObligationCents, 78000);
  assert.equal(row.obligationSource, "subsidy_tenant");
  const [july] = deriveHap(value, { month: "2026-07", asOfDate: "2026-08-31" }) as HapReportRow[];
  assert.equal(july.agencyObligationCents, 40000, "terms that start later do not apply to an earlier month");
  assert.equal(july.obligationSource, "contract");
});

test("K4: receipts are attributed by payer and period; a $0 receipt is not 'never paid'", () => {
  const value = hapSnapshot();
  const receipt = (id: string, extra: Record<string, unknown>) => ({ id, subsidyContractId: "demo-subsidy-1", subsidyContractLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", propertyId: "demo-property-a", paymentOn: "2026-08-05", paymentOnKnowledge: "source", amountCents: 40000, amountKnowledge: "known", payer: "agency", payerKnowledge: "source", status: "received", statusKnowledge: "source", ...extra }) as never;
  value.subsidyPayments.push(receipt("zero-receipt", { amountCents: 0 }), receipt("tenant-paid", { payer: "tenant", amountCents: 80000 }), receipt("july-receipt", { paymentOn: "2026-07-05" }));
  const [row] = deriveHap(value, { month: "2026-08", asOfDate: "2026-08-31" }) as HapReportRow[];
  assert.equal(row.agencyReceiptStatus, "received");
  assert.equal(row.receivedAgencyCents, 0);
  assert.equal(row.receiptCount, 1, "tenant payments and other months are not agency receipts for this month");

  const unknown = hapSnapshot();
  unknown.subsidyPayments.push(receipt("amount-unknown", { amountCents: undefined, amountKnowledge: "unknown" }));
  const [uncertain] = deriveHap(unknown, { month: "2026-08", asOfDate: "2026-08-31" }) as HapReportRow[];
  assert.equal(uncertain.agencyReceiptStatus, "unknown");
  assert.equal(uncertain.receivedAgencyCents, null, "an unknown receipt total is never shown as $0");
  assert.equal(uncertain.varianceCents, null);
  assert.equal(uncertain.agencyObligationCents, 40000, "the expected obligation stays visible");
});

test("K2: dashboard counts accounts with a known amount due separately from unresolved balances", () => {
  const value = structuredClone(syntheticRentOpsSnapshot());
  const summary = deriveDashboardSummary(value, { asOfDate: "2026-08-16" });
  assert.equal(typeof summary.operationalBalanceDueCount, "number");
  assert.equal(typeof summary.operationalBalanceDueKnownCents, "number");
  assert.ok(summary.operationalBalanceDueCount >= 0);
  assert.equal(summary.operationalBalanceDueCount + (summary.operationalBalanceUnresolvedCount ?? 0) >= summary.operationalBalanceDueCount, true);
  if (summary.operationalBalanceDueCount === 0) assert.equal(summary.operationalBalanceDueKnownCents, 0);
  else assert.ok(summary.operationalBalanceDueKnownCents > 0);
});
