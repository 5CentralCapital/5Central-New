import assert from "node:assert/strict";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { deriveApplicantPipeline, deriveCollectedIncome, deriveDashboardSummary, deriveDelinquency, deriveDepositLiability, deriveHap, deriveOccupancy, deriveRentRoll, deriveScheduledIncome, deriveScheduledVsCollected, deriveTenantLedger, deriveTenantProfile, financialReportControls } from "./reports";
import { RentOpsInvariantError } from "./invariants";
import { emptyRentOpsSnapshot, type RentOpsLedgerTransaction, type RentOpsRecurringChargeSchedule, type RentOpsSnapshot } from "../../../shared/rent-ops-contracts";

const asOfDate = "2026-08-16" as const;

function snapshot(): RentOpsSnapshot {
  return structuredClone(syntheticRentOpsSnapshot());
}

function reversal(original: RentOpsLedgerTransaction, id: string, postedOn = "2026-08-10"): RentOpsLedgerTransaction {
  return { ...original, id, kind: "reversal", reversalOfId: original.id, postedOn, description: `Reversal of ${original.id}` };
}

function truthSnapshot(): RentOpsSnapshot {
  const value = emptyRentOpsSnapshot();
  value.modelVersion = 3;
  value.properties.push({ id: "truth-property", name: "Truth Property", slug: "truth-property", address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: "active" });
  value.units.push(
    { id: "truth-unit-1", propertyId: "truth-property", unitNumber: "1", readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" },
    { id: "truth-unit-2", propertyId: "truth-property", unitNumber: "2", readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" },
  );
  value.people.push({ id: "truth-person-1", firstName: "Truth", lastName: "Tenant" });
  value.tenancies.push({ id: "truth-tenancy-1", propertyId: "truth-property", unitId: "truth-unit-1", primaryPersonId: "truth-person-1", status: "current", actualMoveInOn: "2026-01-15", createdAt: "2026-01-01T00:00:00.000Z", propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", primaryPersonLinkKnowledge: "exact", statusKnowledge: "source", actualMoveInKnowledge: "source" });
  value.leaseTerms.push({ id: "truth-lease-1", tenancyId: "truth-tenancy-1", status: "executed", contractStartOn: "2026-01-15", contractEndOn: "2026-12-31", monthToMonth: false, createdAt: "2026-01-01T00:00:00.000Z", tenancyLinkKnowledge: "exact", statusKnowledge: "source", contractStartKnowledge: "source", contractEndKnowledge: "source" });
  return value;
}

function truthSchedule(input: Partial<RentOpsRecurringChargeSchedule> & Pick<RentOpsRecurringChargeSchedule, "id">): RentOpsRecurringChargeSchedule {
  return {
    id: input.id,
    propertyId: "truth-property",
    scopeType: "tenant",
    scopeId: "truth-person-1",
    scopeTypeKnowledge: "source",
    scopeLinkKnowledge: "exact",
    tenancyId: "truth-tenancy-1",
    personId: "truth-person-1",
    unitId: "truth-unit-1",
    category: "base_rent",
    categoryKnowledge: "source",
    description: "Truth rent",
    descriptionKnowledge: "source",
    amountCents: 100000,
    amountKnowledge: "known",
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
  };
}

function activePortfolioScopeSnapshot(): RentOpsSnapshot {
  const value = snapshot();
  const activeProperties = ["active-extra-1", "active-extra-2"];
  for (const propertyId of activeProperties) {
    value.properties.push({ id: propertyId, name: propertyId, slug: propertyId, address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: "active" });
  }
  for (const index of Array.from({ length: 48 }, (_, offset) => offset)) {
    const propertyId = activeProperties[index < 24 ? 0 : 1]!;
    value.units.push({ id: `active-unit-${index + 1}`, propertyId, unitNumber: String(index + 1), readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  }
  for (const index of Array.from({ length: 13 }, (_, offset) => offset)) {
    const propertyId = `historical-${index + 1}`;
    value.properties.push({ id: propertyId, name: propertyId, slug: propertyId, address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: null });
    const unitCount = index < 5 ? 12 : 11;
    for (const unitIndex of Array.from({ length: unitCount }, (_, offset) => offset)) {
      value.units.push({ id: `${propertyId}-unit-${unitIndex + 1}`, propertyId, unitNumber: String(unitIndex + 1), readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
    }
  }
  const activeUnits = value.units.filter((unit) => value.properties.find((property) => property.id === unit.propertyId)?.state === "active");
  const usedUnitIds = new Set(value.tenancies.map((tenancy) => tenancy.unitId));
  for (const [index, unit] of activeUnits.filter((unit) => !usedUnitIds.has(unit.id)).slice(0, 35).entries()) {
    const personId = `scope-person-${index + 1}`;
    value.people.push({ id: personId, firstName: "Scope", lastName: `Tenant ${index + 1}` });
    value.tenancies.push({ id: `scope-tenancy-${index + 1}`, propertyId: unit.propertyId, unitId: unit.id, primaryPersonId: personId, status: "current", actualMoveInOn: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z", propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", primaryPersonLinkKnowledge: "exact", statusKnowledge: "source", actualMoveInKnowledge: "source" });
  }
  return value;
}

test("rent roll preserves one row per physical unit, half baths, future rent, readiness, and listing", () => {
  const rows = deriveRentRoll(snapshot(), { asOfDate });
  assert.equal(rows.length, 7);
  assert.equal(rows.filter((row) => row.occupancy === "current").length, 2);
  assert.equal(rows.filter((row) => row.occupancy === "future_preleased").length, 1);
  const halfBath = rows.find((row) => row.unitId === "demo-unit-a-1");
  assert.equal(halfBath?.bathrooms, 1.5);
  const future = rows.find((row) => row.unitId === "demo-unit-a-2");
  assert.equal(future?.occupancy, "future_preleased");
  assert.equal(future?.baseRentCents, 130000);
  assert.equal(rows.find((row) => row.unitId === "demo-unit-a-4")?.readiness, "not_ready");
  assert.equal(rows.find((row) => row.unitId === "demo-unit-a-5")?.listing, "off_market");
});

test("dashboard counts physical vacancy and not-ready units without charging stale occupied readiness", () => {
  const summary = deriveDashboardSummary(snapshot(), { asOfDate });
  assert.equal(summary.occupiedUnits, 2);
  assert.equal(summary.futurePreleasedUnits, 1);
  assert.equal(summary.genuineVacantUnits, 4);
  assert.equal(summary.notReadyUnits, 1);
  assert.equal(summary.offMarketUnits, 1);
});

test("active portfolio scope excludes unknown historical properties while omitted scope preserves source totals", () => {
  const current = activePortfolioScopeSnapshot();
  const active = deriveDashboardSummary(current, { asOfDate, propertyScope: "active" });
  assert.equal(active.propertyCount, 4);
  assert.equal(active.unitCount, 55);
  assert.equal(active.occupiedUnits, 37);
  assert.equal(deriveRentRoll(current, { asOfDate, propertyScope: "active" }).length, 55);

  const allImported = deriveDashboardSummary(current, { asOfDate, propertyScope: "all" });
  assert.equal(allImported.propertyCount, 17);
  assert.equal(allImported.unitCount, 203);
  assert.equal(allImported.occupiedUnits, 37);
  assert.equal(deriveRentRoll(current, { asOfDate }).length, 203);
});

test("scheduled, collected, deposit, HAP, and applicant reports use fixed semantics", () => {
  const current = snapshot();
  current.paymentAllocations.push({ id: "late-allocation", paymentTransactionId: "demo-payment-unapplied-1", chargeTransactionId: "demo-charge-other-1", amountCents: 1000, allocatedOn: "2026-09-01" });
  const scheduled = deriveScheduledIncome(current, { month: "2026-08", asOfDate });
  assert.equal(scheduled.filter((row) => row.category === "base_rent").reduce((sum, row) => sum + row.amountCents, 0), 230000);
  assert.equal(deriveCollectedIncome(current, { month: "2026-08" }).some((row) => row.paymentTransactionId === "demo-payment-unapplied-1" && row.amountCents === 1000), true);
  assert.equal(deriveCollectedIncome(current, { month: "2026-08", asOfDate: "2026-08-31" }).some((row) => row.paymentTransactionId === "demo-payment-unapplied-1" && row.amountCents === 1000), false);
  assert.equal(deriveDepositLiability(current, { asOfDate }).find((row) => row.tenancyId === "demo-tenancy-1")?.totalHeldCents, 145000);
  const hap = deriveHap(current, { month: "2026-08", asOfDate }).find((row) => row.tenancyId === "demo-tenancy-1");
  assert.equal(hap?.receivedAgencyCents, 35000);
  assert.equal(deriveApplicantPipeline(current, { asOfDate }).find((row) => row.id === "demo-application-1")?.displayName, "Applicant Four");
});

test("scheduled income keeps tenant precedence exact, preserves distinct fees, and emits property scope once", () => {
  const current = snapshot();
  current.tenancies.push({
    id: "former-tenancy-same-person",
    propertyId: "demo-property-a",
    unitId: "demo-unit-a-1",
    primaryPersonId: "demo-person-1",
    status: "past",
    actualMoveInOn: "2025-01-01",
    actualMoveOutOn: "2025-12-31",
    createdAt: "2025-01-01T00:00:00.000Z",
  });
  const schedule = (row: Partial<RentOpsRecurringChargeSchedule> & Pick<RentOpsRecurringChargeSchedule, "id" | "category" | "description" | "amountCents">): RentOpsRecurringChargeSchedule => ({
    propertyId: "demo-property-a",
    active: true,
    activeKnowledge: "manual",
    sourceConfidence: "confirmed",
    effectiveFrom: "2026-01-01",
    effectiveFromKnowledge: "manual",
    lineageRootId: row.id,
    lineageRootOrigin: "manual",
    versionAction: "root",
    scopeTypeKnowledge: "manual",
    scopeLinkKnowledge: "manual",
    categoryKnowledge: "manual",
    descriptionKnowledge: "manual",
    amountKnowledge: "known",
    chargeDefinitionLinkKnowledge: "manual",
    ...row,
  });
  current.recurringSchedules.push(
    schedule({ id: "property-fee", scopeType: "property", scopeId: "demo-property-a", category: "recurring_fee", chargeDefinitionId: "definition-property", description: "Property fee", amountCents: 7000 }),
    schedule({ id: "unit-fee", scopeType: "unit", scopeId: "demo-unit-a-1", unitId: "demo-unit-a-1", category: "recurring_fee", chargeDefinitionId: "definition-same", description: "Unit fee", amountCents: 1000 }),
    schedule({ id: "current-tenant-fee", scopeType: "tenant", scopeId: "demo-person-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", unitId: "demo-unit-a-1", category: "recurring_fee", chargeDefinitionId: "definition-same", description: "Tenant fee", amountCents: 2000 }),
    schedule({ id: "distinct-tenant-fee", scopeType: "tenant", scopeId: "demo-person-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", unitId: "demo-unit-a-1", category: "recurring_fee", chargeDefinitionId: "definition-distinct", description: "Distinct tenant fee", amountCents: 3000 }),
    schedule({ id: "former-tenant-fee", scopeType: "tenant", scopeId: "demo-person-1", tenancyId: "former-tenancy-same-person", personId: "demo-person-1", unitId: "demo-unit-a-1", category: "recurring_fee", chargeDefinitionId: "definition-former", description: "Former tenant fee", amountCents: 9000 }),
    schedule({ id: "person-only-former-fee", scopeType: "tenant", scopeId: "demo-person-1", personId: "demo-person-1", unitId: "demo-unit-a-1", category: "recurring_fee", chargeDefinitionId: "definition-person-only", description: "Person-only former fee", amountCents: 8000 }),
  );

  const rows = deriveScheduledIncome(current, { month: "2026-08", asOfDate });
  const unitRows = rows.filter((row) => row.tenancyId === "demo-tenancy-1");
  assert.equal(unitRows.find((row) => row.chargeDefinitionId === "definition-same")?.amountCents, 2000);
  assert.equal(unitRows.some((row) => row.scheduleId === "unit-fee"), false);
  assert.equal(unitRows.some((row) => row.scheduleId === "former-tenant-fee" || row.scheduleId === "person-only-former-fee"), false);
  assert.equal(unitRows.find((row) => row.scheduleId === "distinct-tenant-fee")?.amountCents, 3000);
  assert.equal(rows.filter((row) => row.scheduleId === "property-fee").length, 1);
  assert.equal(rows.find((row) => row.scheduleId === "property-fee")?.scopeType, "property");
  assert.equal(rows.find((row) => row.scheduleId === "property-fee")?.unitId, undefined);
});

test("v8 scheduled income uses month-effective truth and keeps historical, observation, and future boundaries explicit", () => {
  const current = truthSnapshot();
  current.recurringSchedules.push(truthSchedule({ id: "truth-current" }));
  const historical = { ...truthSchedule({ id: "truth-former", effectiveFrom: "2026-01-01" }), scopeId: "truth-former-person", tenancyId: "truth-former-tenancy", personId: "truth-former-person", unitId: "truth-unit-2" } as any;
  current.people.push({ id: "truth-former-person", firstName: "Former", lastName: "Tenant" });
  current.tenancies.push({ id: "truth-former-tenancy", propertyId: "truth-property", unitId: "truth-unit-2", primaryPersonId: "truth-former-person", status: "past", actualMoveInOn: "2026-01-01", actualMoveOutOn: "2026-02-10", createdAt: "2025-01-01T00:00:00.000Z", propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", primaryPersonLinkKnowledge: "exact", statusKnowledge: "source", actualMoveInKnowledge: "source", actualMoveOutKnowledge: "source" });
  current.leaseTerms.push({ id: "truth-former-lease", tenancyId: "truth-former-tenancy", status: "executed", contractStartOn: "2026-01-01", contractEndOn: "2026-02-10", monthToMonth: false, createdAt: "2025-01-01T00:00:00.000Z", tenancyLinkKnowledge: "exact", statusKnowledge: "source", contractStartKnowledge: "source", contractEndKnowledge: "source" });
  current.recurringSchedules.push(historical);
  const february = deriveScheduledIncome(current, { month: "2026-02", asOfDate: "2026-08-16" });
  const march = deriveScheduledIncome(current, { month: "2026-03", asOfDate: "2026-08-16" });
  assert.equal(february.some((row) => row.scheduleId === "truth-former"), true);
  assert.equal(march.some((row) => row.scheduleId === "truth-former"), false);

  const openStart = truthSchedule({ id: "truth-open", effectiveFrom: null, effectiveFromKnowledge: "unknown_open_start" });
  openStart.sourceArtifactSha256 = "b".repeat(64);
  current.recurringSchedules.push(openStart);
  const observed = deriveScheduledIncome(current, { month: "2026-08", asOfDate: "2026-08-16" });
  assert.equal(observed.some((row) => row.scheduleId === "truth-open"), true);
  assert.equal(observed.find((row) => row.scheduleId === "truth-open")?.uncertain, true);
  const observedControls = financialReportControls(observed)!;
  assert.equal(observedControls.sourceRowCount, 3);
  assert.ok(observedControls.uncertaintyCodes?.includes("schedule_open_start_not_observed") === false);

  const future = truthSchedule({ id: "truth-future", effectiveFrom: "2026-10-01" });
  current.recurringSchedules.push(future);
  assert.equal(deriveScheduledIncome(current, { month: "2026-09", asOfDate: "2026-08-16" }).some((row) => row.scheduleId === "truth-future"), false);
});

test("v8 scheduled-vs-collected returns nullable all-in variance when a source amount/category is incomplete", () => {
  const current = truthSnapshot();
  current.recurringSchedules.push(truthSchedule({ id: "truth-clean", amountCents: 100000 }));
  current.recurringSchedules.push(truthSchedule({ id: "truth-unknown", category: null, categoryKnowledge: "unknown", amountCents: null, amountKnowledge: "unknown", chargeDefinitionId: "truth-unknown-definition" }));
  current.ledgerTransactions.push(
    { id: "truth-charge", propertyId: "truth-property", unitId: "truth-unit-1", tenancyId: "truth-tenancy-1", personId: "truth-person-1", kind: "charge", category: "base_rent", categoryKnowledge: "source", status: "posted", statusKnowledge: "source", amountCents: 100000, amountKnowledge: "known", postedOn: "2026-08-01", postedOnKnowledge: "source", description: "August rent" },
    { id: "truth-payment", propertyId: "truth-property", unitId: "truth-unit-1", tenancyId: "truth-tenancy-1", personId: "truth-person-1", kind: "payment", category: "other", categoryKnowledge: "source", status: "posted", statusKnowledge: "source", amountCents: 100000, amountKnowledge: "known", postedOn: "2026-08-02", postedOnKnowledge: "source", description: "Payment", payer: "tenant", payerKnowledge: "source" },
  );
  current.paymentAllocations.push({ id: "truth-allocation", paymentTransactionId: "truth-payment", chargeTransactionId: "truth-charge", amountCents: 100000, amountKnowledge: "known", allocatedOn: "2026-08-02", allocatedOnKnowledge: "source", paymentLinkKnowledge: "exact", chargeLinkKnowledge: "exact" });
  const rows = deriveScheduledVsCollected(current, { month: "2026-08", asOfDate: "2026-08-16" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].varianceCents, null);
  assert.equal(rows[0].complete, false);
  assert.ok((rows[0].scheduledUnknownAmountCount ?? 0) >= 1);
  assert.ok((rows[0].uncertaintyCodes ?? []).length > 0);
});

test("direct occupancy report fails closed on ambiguous current tenancies", () => {
  const current = snapshot();
  current.tenancies.push({ ...current.tenancies[0], id: "ambiguous-tenancy", primaryPersonId: "demo-person-2" });
  assert.throws(() => deriveOccupancy(current, { asOfDate }), (error: unknown) => error instanceof RentOpsInvariantError && error.violations.some((violation) => violation.code === "overlapping_current_tenancies"));
});

test("reversed payments reopen allocations without creating unapplied cash, while reversed charges make valid payments unapplied", () => {
  const current = snapshot();
  const payment = current.ledgerTransactions.find((transaction) => transaction.id === "demo-payment-1")!;
  current.ledgerTransactions.push(reversal(payment, "reversal-payment"));
  const afterPaymentReversal = deriveDelinquency(current, { asOfDate });
  const first = afterPaymentReversal.find((row) => row.tenancyId === "demo-tenancy-1")!;
  assert.equal(first.unappliedCashCents, 20000);
  assert.equal(first.rentOnlyBalanceCents, 75000);
  // The reversed payment is excluded, while the fixture's other valid
  // unapplied payment remains the most recent payment event.
  assert.equal(first.lastPaymentOn, "2026-08-06");

  const charge = current.ledgerTransactions.find((transaction) => transaction.id === "demo-charge-rent-3")!;
  current.ledgerTransactions.push(reversal(charge, "reversal-charge"));
  const afterChargeReversal = deriveDelinquency(current, { asOfDate }).find((row) => row.tenancyId === "demo-tenancy-3")!;
  assert.equal(afterChargeReversal.grossBalanceCents, 0);
  assert.equal(afterChargeReversal.unappliedCashCents, 110000);
  assert.equal(afterChargeReversal.totalBalanceCents, -110000);
  const ledger = deriveTenantLedger(current, "demo-tenancy-3", { asOfDate });
  assert.equal(ledger.find((row) => row.transaction.id === "demo-payment-3")?.openCents, 110000);
});

test("as-of reports exclude allocations recorded after cutoff", () => {
  const current = snapshot();
  current.paymentAllocations.push({ id: "future-allocation", paymentTransactionId: "demo-payment-unapplied-1", chargeTransactionId: "demo-charge-other-1", amountCents: 1000, allocatedOn: "2026-08-20" });
  const before = deriveDelinquency(current, { asOfDate: "2026-08-16" }).find((row) => row.tenancyId === "demo-tenancy-1")!;
  const after = deriveDelinquency(current, { asOfDate: "2026-08-31" }).find((row) => row.tenancyId === "demo-tenancy-1")!;
  assert.equal(before.nonRentBalanceCents, 2500);
  assert.equal(after.nonRentBalanceCents, 1500);
});

test("future occupancy requires a move-in and selects the earliest valid upcoming term", () => {
  const current = snapshot();
  const futureTenancy = current.tenancies.find((tenancy) => tenancy.id === "demo-tenancy-2")!;
  futureTenancy.actualMoveInOn = undefined;
  assert.throws(() => deriveRentRoll(current, { asOfDate }), (error: unknown) => error instanceof RentOpsInvariantError && error.violations.some((violation) => violation.code === "future_move_in_missing"));

  futureTenancy.actualMoveInOn = "2026-09-01";
  current.leaseTerms = current.leaseTerms.filter((term) => term.tenancyId !== futureTenancy.id);
  current.leaseTerms.push(
    { id: "expired-future-term", tenancyId: futureTenancy.id, status: "expired", contractStartOn: "2025-01-01", contractEndOn: "2025-12-31", monthToMonth: false, createdAt: "2025-01-01T00:00:00.000Z" },
    { id: "next-future-term", tenancyId: futureTenancy.id, status: "executed", contractStartOn: "2026-09-01", contractEndOn: "2027-08-31", monthToMonth: false, createdAt: "2026-08-01T00:00:00.000Z" },
  );
  assert.equal(deriveRentRoll(current, { asOfDate }).find((row) => row.tenancyId === futureTenancy.id)?.contractStartOn, "2026-09-01");
});

test("deposit liability and tenant profile preserve historical pre-disposition state", () => {
  const current = snapshot();
  const security = current.securityDeposits.find((deposit) => deposit.id === "demo-deposit-1")!;
  security.dispositionStatus = "returned";
  security.disposedOn = "2026-08-15";
  assert.equal(deriveDepositLiability(current, { asOfDate: "2026-08-01" }).find((row) => row.tenancyId === security.tenancyId)?.totalHeldCents, 145000);
  assert.equal(deriveDepositLiability(current, { asOfDate: "2026-08-16" }).find((row) => row.tenancyId === security.tenancyId)?.totalHeldCents, 25000);
  const historical = deriveTenantProfile(current, security.personId, { asOfDate: "2026-08-01" });
  assert.equal(historical?.deposits.find((deposit) => deposit.id === security.id)?.dispositionStatus, "held");
});

test("tenant profiles follow household membership as well as primary-resident linkage", () => {
  const current = snapshot();
  current.people.push({ id: "household-member", firstName: "Household", lastName: "Member" });
  current.householdMemberships.push(
    { id: "household-primary", tenancyId: "demo-tenancy-1", personId: "demo-person-1", role: "primary", isFinanciallyResponsible: true },
    { id: "household-link", tenancyId: "demo-tenancy-1", personId: "household-member", role: "occupant", isFinanciallyResponsible: false },
  );
  const profile = deriveTenantProfile(current, "household-member", { asOfDate });
  assert.equal(profile?.tenancy?.id, "demo-tenancy-1");
  assert.equal(profile?.tenancies.length, 1);
  assert.ok((profile?.ledger.length ?? 0) > 0);
  assert.ok(profile?.household.some((membership) => membership.personId === "demo-person-1"));
});

test("primary tenant profiles retain account-scoped contacts without inventing a tenancy link", () => {
  const current = snapshot();
  current.people.push({ id: "account-contact", firstName: "Account", lastName: "Contact" });
  current.householdMemberships.push({
    id: "account-contact-link",
    accountPersonId: "demo-person-1",
    personId: "account-contact",
    role: null,
    relationship: null,
    isFinanciallyResponsible: null,
    roleKnowledge: "unknown",
    relationshipKnowledge: "unknown",
    responsibilityKnowledge: "unknown",
  });
  const profile = deriveTenantProfile(current, "demo-person-1", { asOfDate });
  const contact = profile?.household.find((membership) => membership.id === "account-contact-link");
  assert.equal(contact?.personId, "account-contact");
  assert.equal(contact?.accountPersonId, "demo-person-1");
  assert.equal(contact?.tenancyId, undefined);
});

test("HAP excludes pending contracts and agency cash posted after the audit cutoff", () => {
  const current = snapshot();
  const agencyPayment = current.ledgerTransactions.find((transaction) => transaction.id === "demo-payment-hap-1")!;
  agencyPayment.postedOn = "2026-08-20";
  current.paymentAllocations.find((allocation) => allocation.paymentTransactionId === agencyPayment.id)!.allocatedOn = "2026-08-20";
  assert.equal(deriveHap(current, { month: "2026-08", asOfDate: "2026-08-16" })[0]?.receivedAgencyCents, 0);
  current.subsidyContracts[0].status = "pending";
  assert.equal(deriveHap(current, { month: "2026-08", asOfDate: "2026-08-31" }).length, 0);
});

test("HAP treats ended contracts as effective only through their end date and honors status filters", () => {
  const current = snapshot();
  const contract = current.subsidyContracts[0];
  contract.status = "ended";
  contract.effectiveTo = "2026-07-31";
  assert.equal(deriveHap(current, { month: "2026-08", asOfDate }).length, 0);
  assert.equal(deriveHap(current, { month: "2026-07", asOfDate, status: ["ended"] }).length, 1);
  contract.effectiveTo = undefined;
  assert.equal(deriveHap(current, { month: "2026-07", asOfDate }).length, 0);
});

test("HAP child receipts are counted once, linked ledger allocations are not double-counted, and descriptions never infer payer", () => {
  const current = snapshot();
  current.subsidyPayments.push({
    id: "child-hap-receipt-1",
    subsidyContractId: "demo-subsidy-1",
    subsidyContractLinkKnowledge: "exact",
    tenancyId: "demo-tenancy-1",
    tenancyLinkKnowledge: "exact",
    propertyId: "demo-property-a",
    propertyLinkKnowledge: "exact",
    unitId: "demo-unit-a-1",
    unitLinkKnowledge: "exact",
    paymentTransactionId: "demo-payment-hap-1",
    paymentLinkKnowledge: "exact",
    paymentOn: "2026-08-05",
    paymentOnKnowledge: "source",
    amountCents: 40000,
    amountKnowledge: "known",
    payer: "agency",
    payerKnowledge: "source",
    status: "received",
    statusKnowledge: "source",
  });
  const child = deriveHap(current, { month: "2026-08", asOfDate }).find((row) => row.tenancyId === "demo-tenancy-1");
  assert.equal(child?.receivedAgencyCents, 40000);
  assert.equal(child?.receiptCount, 1);
  assert.equal(child?.knownReceiptCount, 1);
  assert.equal(child?.unknownReceiptCount, 0);
  assert.equal(child?.varianceCents, 0);

  const textualOnly = snapshot();
  const genericPayment = textualOnly.ledgerTransactions.find((transaction) => transaction.id === "demo-payment-hap-1")!;
  genericPayment.payer = "unknown";
  genericPayment.description = "Housing agency HAP payment";
  const inferred = deriveHap(textualOnly, { month: "2026-08", asOfDate }).find((row) => row.tenancyId === "demo-tenancy-1");
  assert.equal(inferred?.receivedAgencyCents, 0);
  assert.equal(inferred?.uncertainty, true);
  assert.ok(inferred?.uncertaintyCodes?.includes("generic_payment_payer_unknown"));
});

test("voided and pending ledger facts remain visible but have zero running-balance impact", () => {
  const current = snapshot();
  const baseline = deriveTenantLedger(current, "demo-tenancy-1", { asOfDate }).at(-1)?.runningBalanceCents;
  current.ledgerTransactions.push({ id: "pending-charge", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "charge", category: "base_rent", status: "pending", amountCents: 999999, postedOn: "2026-08-10", description: "Pending test" });
  const ledger = deriveTenantLedger(current, "demo-tenancy-1", { asOfDate });
  assert.equal(ledger.find((row) => row.transaction.id === "pending-charge")?.runningBalanceCents, baseline);
});

test("dashboard confirmed recurring total excludes unknown active state and raw uncertain amounts", () => {
  const value = truthSnapshot();
  value.recurringSchedules.push(truthSchedule({ id: "confirmed", category: "recurring_fee", amountCents: 12345 }), truthSchedule({ id: "unknown-active", category: "recurring_fee", amountCents: 98765, active: null, activeKnowledge: "unknown" }));
  const summary = deriveDashboardSummary(value, { asOfDate, month: "2026-08" });
  assert.equal(summary.scheduledRentConfirmedCents, 12345);
  assert.equal(summary.scheduledRentCents, 12345);
  assert.equal(summary.scheduledRentCadenceComplete, false);
  assert.equal(summary.scheduledRentUnresolvedCount, 1);
  assert.equal(summary.scheduledRentComplete, false);
});


test("dashboard cadence accepts confirmed manual monthly schedules and blocks mixed unknown imported cadence", () => {
  const value = truthSnapshot();
  const manual = truthSchedule({ id: "manual-monthly", category: "recurring_fee", amountCents: 12345,
    billingFrequency: "monthly", source: undefined, sourceArtifactSha256: undefined,
    artifactObservationOn: undefined, lineageRootOrigin: "manual", versionOrigin: "manual", effectiveFromKnowledge: "manual" });
  value.recurringSchedules.push(manual);
  const confirmed = deriveDashboardSummary(value, { asOfDate, month: "2026-08" });
  assert.equal(confirmed.scheduledRentConfirmedCents, 12345);
  assert.equal(confirmed.scheduledRentComplete, true);
  assert.equal(confirmed.scheduledRentCadenceComplete, true);
  value.recurringSchedules.push(truthSchedule({ id: "imported-unknown-cadence", category: "recurring_fee", amountCents: 5001, billingFrequency: null }));
  const mixed = deriveDashboardSummary(value, { asOfDate, month: "2026-08" });
  assert.equal(mixed.scheduledRentConfirmedCents, 17346);
  assert.equal(mixed.scheduledRentComplete, true);
  assert.equal(mixed.scheduledRentCadenceComplete, false);
  // An inactive imported row is outside the applicable schedule set.
  value.recurringSchedules[1].active = false;
  assert.equal(deriveDashboardSummary(value, { asOfDate, month: "2026-08" }).scheduledRentCadenceComplete, true);
});
