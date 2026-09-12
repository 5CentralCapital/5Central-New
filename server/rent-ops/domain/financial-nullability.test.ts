import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyRentOpsSnapshot,
  type RentOpsLedgerTransaction,
  type RentOpsPaymentAllocation,
  type RentOpsRecurringChargeSchedule,
  type RentOpsSnapshot,
} from "../../../shared/rent-ops-contracts";
import { validateAllocation } from "./invariants";
import { projectFinancialSchedules, resolveEffectiveScheduleVersions } from "./financial-projection";

const ARTIFACT_SHA256 = "a".repeat(64);
const MONTH = "2026-05" as const;

function financialSnapshot(): RentOpsSnapshot {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.modelVersion = 3;
  snapshot.properties.push({
    id: "property-1",
    name: "Synthetic property",
    slug: "synthetic-property",
    address: { line1: "1 Synthetic Way", city: "Synthetic", state: "FL", postalCode: "00000" },
    propertyType: "multifamily",
    state: "active",
  });
  snapshot.units.push({
    id: "unit-1",
    propertyId: "property-1",
    unitNumber: "1",
    readiness: "ready",
    listing: "listed",
    propertyLinkKnowledge: "exact",
  });
  snapshot.people.push({ id: "person-1", firstName: "Synthetic", lastName: "Resident" });
  snapshot.tenancies.push({
    id: "tenancy-1",
    propertyId: "property-1",
    unitId: "unit-1",
    primaryPersonId: "person-1",
    status: "current",
    actualMoveInOn: "2025-01-01",
    createdAt: "2025-01-01T00:00:00.000Z",
    propertyLinkKnowledge: "exact",
    unitLinkKnowledge: "exact",
    primaryPersonLinkKnowledge: "exact",
    statusKnowledge: "source",
    actualMoveInKnowledge: "source",
  });
  snapshot.leaseTerms.push({
    id: "lease-1",
    tenancyId: "tenancy-1",
    tenancyLinkKnowledge: "exact",
    status: "executed",
    statusKnowledge: "source",
    contractStartOn: "2025-01-01",
    contractStartKnowledge: "source",
    contractEndOn: "2026-12-31",
    contractEndKnowledge: "source",
    monthToMonth: false,
    monthToMonthKnowledge: "source",
    createdAt: "2025-01-01T00:00:00.000Z",
  });
  return snapshot;
}

function scheduleFixture(
  id: string,
  overrides: Partial<RentOpsRecurringChargeSchedule> = {},
): RentOpsRecurringChargeSchedule {
  return {
    id,
    billingFrequency: "monthly",
    scopeType: "unit",
    scopeId: "unit-1",
    scopeTypeKnowledge: "source",
    scopeLinkKnowledge: "exact",
    // A unit-scoped schedule owns the unit; v8 does not permit a copied
    // tenancy/person link to contradict that canonical scope.
    tenancyId: undefined,
    propertyId: "property-1",
    unitId: "unit-1",
    category: "base_rent",
    categoryKnowledge: "source",
    description: "Synthetic schedule",
    descriptionKnowledge: "source",
    amountCents: 2300,
    amountKnowledge: "known",
    effectiveFrom: "2025-01-01",
    effectiveFromKnowledge: "source",
    active: true,
    activeKnowledge: "source",
    chargeDefinitionId: `definition-${id}`,
    chargeDefinitionLinkKnowledge: "exact",
    source: { system: "rent_manager", entityType: "recurring_schedule", sourceId: `schedule:${id}` },
    sourceArtifactSha256: ARTIFACT_SHA256,
    artifactObservationOn: "2025-01-01",
    lineageRootId: id,
    lineageRootOrigin: "artifact",
    versionOrigin: "artifact",
    versionAction: "root",
    ...overrides,
  };
}

function unknownLedgerFixture(id = "ledger-unknown"): RentOpsLedgerTransaction {
  return {
    id,
    propertyId: "property-1",
    unitId: "unit-1",
    tenancyId: "tenancy-1",
    personId: "person-1",
    kind: "charge",
    category: null,
    categoryKnowledge: "unknown",
    status: null,
    statusKnowledge: "unknown",
    amountCents: null,
    amountKnowledge: "unknown",
    postedOn: null,
    postedOnKnowledge: "unknown",
    description: "Synthetic ledger fact",
    descriptionKnowledge: "manual",
    propertyLinkKnowledge: "exact",
    unitLinkKnowledge: "exact",
    tenancyLinkKnowledge: "exact",
    personLinkKnowledge: "exact",
  };
}

function unknownAllocationFixture(id = "allocation-unknown"): RentOpsPaymentAllocation {
  return {
    id,
    paymentTransactionId: null,
    paymentLinkKnowledge: "unknown",
    chargeTransactionId: null,
    chargeLinkKnowledge: "unknown",
    amountCents: null,
    amountKnowledge: "unknown",
    allocatedOn: null,
    allocatedOnKnowledge: "unknown",
  };
}

test("v8 schedule projection preserves null facts and separates unknown counts from known cents", () => {
  const snapshot = financialSnapshot();
  snapshot.recurringSchedules.push(
    scheduleFixture("schedule-known", { amountCents: 2300, amountKnowledge: "known" }),
    scheduleFixture("schedule-category-unknown", {
      category: null,
      categoryKnowledge: "unknown",
      amountCents: 1700,
      amountKnowledge: "known",
    }),
    scheduleFixture("schedule-amount-unknown", {
      category: "recurring_fee",
      categoryKnowledge: "source",
      amountCents: null,
      amountKnowledge: "unknown",
    }),
  );

  let projection: ReturnType<typeof projectFinancialSchedules>;
  assert.doesNotThrow(() => {
    projection = projectFinancialSchedules(snapshot, MONTH);
  });

  const result = projection!;
  assert.equal(result.sourceRowCount, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.knownRowCount, 1);
  assert.equal(result.uncertainRowCount, 2);
  assert.equal(result.knownCents, 2300);
  // The known amount attached to an unknown category remains auditable, but
  // the null amount contributes no invented cents to any bucket.
  assert.equal(result.uncertainCents, 1700);
  assert.equal(result.unknownAmountCount, 1);

  const categoryUnknown = result.rows.find((row) => row.scheduleId === "schedule-category-unknown");
  const amountUnknown = result.rows.find((row) => row.scheduleId === "schedule-amount-unknown");
  const known = result.rows.find((row) => row.scheduleId === "schedule-known");
  assert.ok(categoryUnknown);
  assert.ok(amountUnknown);
  assert.ok(known);
  assert.equal(categoryUnknown.category, null);
  assert.equal(categoryUnknown.categoryKnowledge, "unknown");
  assert.equal(categoryUnknown.amountCents, 1700);
  assert.equal(categoryUnknown.amountKnowledge, "known");
  assert.equal(categoryUnknown.known, false);
  assert.equal(amountUnknown.category, "recurring_fee");
  assert.equal(amountUnknown.amountCents, null);
  assert.equal(amountUnknown.amountKnowledge, "unknown");
  assert.equal(amountUnknown.known, false);
  assert.equal(known.category, "base_rent");
  assert.equal(known.amountCents, 2300);
  assert.equal(known.known, true);
  assert.ok(result.exceptionCodes.includes("charge_category_unknown"));
  assert.ok(amountUnknown.exceptionCodes?.includes("amount_unknown"));

  for (const value of [result.knownCents, result.uncertainCents, result.unassignedCents, result.notApplicableCents]) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.equal(Number.isNaN(value), false);
  }
});

test("v8 strict lineage accepts explicit artifact and manual roots but rejects missing or mixed roots", () => {
  const artifactRoot = scheduleFixture("schedule-artifact-root");
  const manualRoot = scheduleFixture("schedule-manual-root", {
    scopeTypeKnowledge: "manual",
    scopeLinkKnowledge: "manual",
    category: "recurring_fee",
    categoryKnowledge: "manual",
    descriptionKnowledge: "manual",
    effectiveFromKnowledge: "manual",
    activeKnowledge: "manual",
    chargeDefinitionLinkKnowledge: "manual",
    sourceArtifactSha256: undefined,
    artifactObservationOn: undefined,
    lineageRootOrigin: "manual",
    versionOrigin: "manual",
    source: undefined,
  });
  const accepted = resolveEffectiveScheduleVersions([artifactRoot, manualRoot], MONTH, { strictLineage: true });
  assert.equal(accepted.invalidSchedules.length, 0);

  const missingRoot = scheduleFixture("schedule-missing-root", {
    lineageRootId: undefined,
    lineageRootOrigin: undefined,
    versionAction: undefined,
  });
  const missingRootResult = resolveEffectiveScheduleVersions([missingRoot], MONTH, { strictLineage: true });
  assert.equal(missingRootResult.invalidSchedules.length, 1);
  assert.ok(missingRootResult.exceptionCodes.includes("schedule_lineage_root_or_action_missing"));

  const mixedSuccessor = scheduleFixture("schedule-mixed-successor", {
    lineageRootId: artifactRoot.id,
    lineageRootOrigin: "manual",
    versionAction: "replace",
    supersedesId: artifactRoot.id,
    effectiveFrom: "2026-02-01",
    effectiveFromKnowledge: "manual",
    sourceArtifactSha256: undefined,
    artifactObservationOn: undefined,
    versionOrigin: "manual",
    source: undefined,
  });
  const mixedResult = resolveEffectiveScheduleVersions([artifactRoot, mixedSuccessor], MONTH, { strictLineage: true });
  assert.equal(mixedResult.invalidSchedules.length, 2);
  assert.ok(mixedResult.exceptionCodes.includes("schedule_lineage_origin_mismatch"));
  assert.ok(mixedResult.exceptionCodes.includes("schedule_lineage_artifact_boundary_mismatch"));
});

test("nullable ledger and allocation contracts retain null values with explicit unknown knowledge", () => {
  const snapshot = financialSnapshot();
  const ledger = unknownLedgerFixture();
  const allocation = unknownAllocationFixture();
  const sourceLedger: RentOpsLedgerTransaction = {
    ...unknownLedgerFixture("ledger-source"),
    category: "base_rent",
    categoryKnowledge: "source",
    status: "posted",
    statusKnowledge: "source",
    amountCents: 1700,
    amountKnowledge: "known",
    postedOn: "2026-05-01",
    postedOnKnowledge: "source",
  };
  const manualAllocation: RentOpsPaymentAllocation = {
    ...unknownAllocationFixture("allocation-manual"),
    paymentTransactionId: "ledger-source",
    paymentLinkKnowledge: "manual",
    chargeTransactionId: "ledger-source",
    chargeLinkKnowledge: "manual",
    amountCents: 1700,
    amountKnowledge: "known",
    allocatedOn: "2026-05-02",
    allocatedOnKnowledge: "manual",
  };
  snapshot.ledgerTransactions.push(ledger);
  snapshot.ledgerTransactions.push(sourceLedger);
  snapshot.paymentAllocations.push(allocation);
  snapshot.paymentAllocations.push(manualAllocation);

  assert.equal(snapshot.ledgerTransactions[0].category, null);
  assert.equal(snapshot.ledgerTransactions[0].categoryKnowledge, "unknown");
  assert.equal(snapshot.ledgerTransactions[0].status, null);
  assert.equal(snapshot.ledgerTransactions[0].statusKnowledge, "unknown");
  assert.equal(snapshot.ledgerTransactions[0].amountCents, null);
  assert.equal(snapshot.ledgerTransactions[0].amountKnowledge, "unknown");
  assert.equal(snapshot.ledgerTransactions[0].postedOn, null);
  assert.equal(snapshot.ledgerTransactions[0].postedOnKnowledge, "unknown");
  assert.equal(snapshot.paymentAllocations[0].paymentTransactionId, null);
  assert.equal(snapshot.paymentAllocations[0].paymentLinkKnowledge, "unknown");
  assert.equal(snapshot.paymentAllocations[0].chargeTransactionId, null);
  assert.equal(snapshot.paymentAllocations[0].chargeLinkKnowledge, "unknown");
  assert.equal(snapshot.paymentAllocations[0].amountCents, null);
  assert.equal(snapshot.paymentAllocations[0].amountKnowledge, "unknown");
  assert.equal(snapshot.paymentAllocations[0].allocatedOn, null);
  assert.equal(snapshot.paymentAllocations[0].allocatedOnKnowledge, "unknown");
  assert.equal(sourceLedger.category, "base_rent");
  assert.equal(sourceLedger.categoryKnowledge, "source");
  assert.equal(sourceLedger.status, "posted");
  assert.equal(sourceLedger.statusKnowledge, "source");
  assert.equal(sourceLedger.amountCents, 1700);
  assert.equal(sourceLedger.amountKnowledge, "known");
  assert.equal(sourceLedger.postedOn, "2026-05-01");
  assert.equal(sourceLedger.postedOnKnowledge, "source");
  assert.equal(manualAllocation.paymentTransactionId, "ledger-source");
  assert.equal(manualAllocation.paymentLinkKnowledge, "manual");
  assert.equal(manualAllocation.chargeTransactionId, "ledger-source");
  assert.equal(manualAllocation.chargeLinkKnowledge, "manual");
  assert.equal(manualAllocation.amountCents, 1700);
  assert.equal(manualAllocation.amountKnowledge, "known");
  assert.equal(manualAllocation.allocatedOn, "2026-05-02");
  assert.equal(manualAllocation.allocatedOnKnowledge, "manual");

  const unknownAmountCount = [ledger.amountCents, allocation.amountCents, sourceLedger.amountCents, manualAllocation.amountCents].filter((value) => value === null).length;
  const knownCents = [ledger.amountCents, allocation.amountCents, sourceLedger.amountCents, manualAllocation.amountCents]
    .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value))
    .reduce((sum, value) => sum + value, 0);
  assert.equal(unknownAmountCount, 2);
  assert.equal(knownCents, 3400);
  assert.equal(Number.isNaN(knownCents), false);

  // There is intentionally no ledger/allocation financial projection adapter
  // in Phase 1. Keep this check at the contract/invariant boundary rather than
  // routing nullable facts through the legacy reports.
  assert.doesNotThrow(() => validateAllocation(allocation, undefined, undefined, [ledger]));
});

test("unknown allocation links and null dates do not become a known allocation", () => {
  const allocation = unknownAllocationFixture("allocation-links-unknown");
  const violations = validateAllocation(allocation, undefined, undefined);
  assert.deepEqual(violations, []);
  assert.equal(allocation.paymentTransactionId, null);
  assert.equal(allocation.chargeTransactionId, null);
  assert.equal(allocation.amountCents, null);
  assert.equal(allocation.allocatedOn, null);
  assert.equal(allocation.paymentLinkKnowledge, "unknown");
  assert.equal(allocation.chargeLinkKnowledge, "unknown");
  assert.equal(allocation.amountKnowledge, "unknown");
  assert.equal(allocation.allocatedOnKnowledge, "unknown");
});
