import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RentManagerFinancialSemanticCrosswalk } from "../../../shared/rent-ops-contracts";
import { serializeAdminRecurringSchedule } from "../presentation";
import { mapRentManagerExport, reconcileRentManagerImport, type RentOpsTargetIdFactory } from "./rm-mapper";

const deterministicTestTargetIdFactory: RentOpsTargetIdFactory = (entityType, sourceId) => `test:${entityType}:${createHash("sha256").update(`${entityType}\u0000${sourceId}`).digest("hex")}`;

function input() {
  return {
    properties: [{ entityType: "property", sourceId: "p1", name: "Synthetic Property", slug: "synthetic-property", address: "1 Example Way", city: "Sampleton", state: "ZZ", postalCode: "00001" }],
    units: [{ entityType: "unit", sourceId: "u1", propertyId: "p1", unitNumber: "1A", bathrooms: 1.5, readiness: "ready", listing: "listed", rent: 850 }],
    tenants: [{ entityType: "tenant", sourceId: "t1", name: "Synthetic Resident", email: "resident@example.test" }],
    contacts: [
      { entityType: "contact", sourceId: "contact-primary", ParentType: "Tenant", ParentID: "t1", LeaseID: "l1", IsPrimary: true, FirstName: "Synthetic", LastName: "Resident", Email: "resident@example.test" },
      { entityType: "contact", sourceId: "contact-secondary", ParentType: "Tenant", ParentID: "t1", LeaseID: "l1", IsPrimary: false, FirstName: "Secondary", LastName: "Contact", Email: "secondary@example.test" },
    ],
    leases: [{ entityType: "lease", sourceId: "l1", propertyId: "p1", unitId: "u1", tenantId: "t1", status: "current", moveInDate: "2026-01-01" }],
    leaseTerms: [{ entityType: "lease_term", sourceId: "term1", leaseId: "l1", startDate: "2026-01-01", endDate: "2026-12-31", signed: true }],
    recurringSchedules: [
      { entityType: "recurring_schedule", sourceId: "schedule1", leaseId: "l1", amount: 850, effectiveFrom: "2026-01-01", description: "Rent" },
      { entityType: "recurring_schedule", sourceId: "former1", unitId: "u1", amount: 10, effectiveFrom: "2026-01-01", description: "Former unit row" },
    ],
    charges: [
      { entityType: "charge", sourceId: "c1", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amount: 850, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "Rent" },
      { entityType: "charge", sourceId: "pet1", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amount: 250, postedOn: "2026-08-01", description: "Pet Security Deposit" },
    ],
    payments: [{ entityType: "payment", sourceId: "pay1", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amount: 850, postedOn: "2026-08-02", paymentMethod: "zelle", description: "Rent payment" }],
    credits: [{ entityType: "credit", sourceId: "credit1", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amount: 25, postedOn: "2026-08-03", description: "Rent credit" }],
    allocations: [{ entityType: "allocation", sourceId: "a1", paymentId: "pay1", chargeId: "c1", amount: 850, allocatedOn: "2026-08-02" }],
    documents: [{ entityType: "document", sourceId: "doc1", tenantId: "t1", fileName: "../identity document.pdf", mimeType: "application/pdf" }],
    activities: [{ entityType: "activity", sourceId: "act1", tenantId: "t1", type: "note", summary: "Synthetic note", updatedAt: "2026-08-03T12:00:00.000Z" }],
  };
}

test("RM mapper uses dollar semantics, semantic charge categories, safe metadata, links, and idempotent IDs/checksums", () => {
  const first = mapRentManagerExport(input(), { now: new Date("2026-08-16T12:00:00.000Z") });
  const second = mapRentManagerExport(input(), { now: new Date("2026-08-16T12:00:00.000Z") });
  assert.equal(first.snapshot.units[0].marketRentCents, 85000);
  assert.equal(first.snapshot.units[0].bathrooms, 1.5);
  assert.equal(first.snapshot.people.length, 2);
  assert.equal(first.snapshot.householdMemberships.length, 2);
  const secondaryPersonId = first.snapshot.people.find((row) => row.source?.sourceId?.endsWith("contact-secondary"))?.id;
  assert.equal(first.snapshot.householdMemberships.find((row) => row.role === "other_contact")?.personId, secondaryPersonId);
  assert.equal(first.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "c1")?.amountCents, 85000);
  assert.equal(first.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "pet1")?.category, "refundable_pet_deposit");
  assert.equal(first.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "credit1")?.kind, "credit");
  assert.equal(first.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "credit1")?.amountCents, 2500);
  assert.equal(first.snapshot.documents[0].state, "requested");
  assert.equal(first.snapshot.documents[0].fileName, "_identity_document.pdf");
  const tenantPersonId = first.snapshot.people.find((row) => row.source?.sourceId === "t1")?.id;
  assert.equal(first.snapshot.documents[0].personId, tenantPersonId);
  assert.equal(first.snapshot.activityEvents[0].personId, tenantPersonId);
  assert.equal(first.snapshot.recurringSchedules.length, 2);
  const tenantSchedule = first.snapshot.recurringSchedules.find((row) => row.source?.sourceId === "schedule1");
  const unitSchedule = first.snapshot.recurringSchedules.find((row) => row.source?.sourceId === "former1");
  assert.equal(tenantSchedule?.scopeType, "tenant");
  assert.equal(unitSchedule?.scopeType, "unit");
  assert.equal(unitSchedule?.tenancyId, undefined);
  assert.equal(unitSchedule?.personId, undefined);
  assert.deepEqual(first.snapshot.sourceRecords.map((record) => record.id), second.snapshot.sourceRecords.map((record) => record.id));
  assert.deepEqual(first.snapshot.sourceRecords.map((record) => record.checksum), second.snapshot.sourceRecords.map((record) => record.checksum));
  const changed = mapRentManagerExport({ ...input(), charges: [{ ...input().charges![0], amount: 900 }, input().charges![1]] });
  assert.notEqual(changed.snapshot.sourceRecords.find((record) => record.sourceId === "c1")?.checksum, first.snapshot.sourceRecords.find((record) => record.sourceId === "c1")?.checksum);
});

test("RM reconciliation reports controls and missing source IDs instead of overwriting", () => {
  const mapped = mapRentManagerExport({ ...input(), units: [...input().units!, { entityType: "unit", propertyId: "p1", unitNumber: "missing-id" } as never] });
  assert.ok(mapped.exceptions.some((item) => item.code === "source_id_missing"));
  const report = reconcileRentManagerImport(mapped, input(), { counts: { property: 2 }, totalsCents: { charges: 110000, payments: 85000, credits: 2500 } });
  assert.equal(report.passed, false);
  assert.ok(report.mismatches.some((mismatch) => mismatch.code === "count_mismatch"));
});

test("recurring source confidence and actual move-out facts survive mapping", () => {
  const mapped = mapRentManagerExport({
    ...input(),
    leases: [{ ...input().leases![0], status: "Current", actualMoveOutOn: "2026-07-31" }],
    recurringSchedules: [{ ...input().recurringSchedules![0], sourceConfidence: "inferred" }],
  });
  assert.equal(mapped.snapshot.tenancies[0].status, "current");
  assert.equal(mapped.snapshot.recurringSchedules[0].sourceConfidence, "inferred");
  assert.ok(mapped.exceptions.some((item) => item.code === "recurring_schedule_source_inferred" && item.severity === "error"));
});

test("RM mapper rejects impossible calendar dates instead of inventing 1900 facts", () => {
  const mapped = mapRentManagerExport({
    ...input(),
    leaseTerms: [{ entityType: "lease_term", sourceId: "bad-term", leaseId: "l1", startDate: "2026-02-30", endDate: "2026-12-31" }],
  });
  assert.equal(mapped.snapshot.leaseTerms.length, 0);
  assert.ok(mapped.exceptions.some((item) => item.code === "invalid_date" && item.entityType === "lease_term"));
  assert.equal(mapped.snapshot.leaseTerms.some((term) => term.contractStartOn === "1900-01-01"), false);
  assert.equal(mapped.importRun.status, "failed");
});

test("RM mapper preserves exact dollars-versus-cents semantics and quarantines fractional cents", () => {
  const mapped = mapRentManagerExport({
    ...input(),
    charges: [
      { entityType: "charge", sourceId: "dollars", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amount: "850.55", postedOn: "2026-08-01", description: "Rent" },
      { entityType: "charge", sourceId: "cents", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amountCents: 85055, postedOn: "2026-08-01", description: "Rent" },
      { entityType: "charge", sourceId: "fractional-cents", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", amountCents: 85055.5, postedOn: "2026-08-01", description: "Rent" },
    ],
    payments: [],
    allocations: [],
  });
  assert.equal(mapped.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "dollars")?.amountCents, 85055);
  assert.equal(mapped.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "cents")?.amountCents, 85055);
  assert.equal(mapped.snapshot.ledgerTransactions.some((row) => row.source?.sourceId === "fractional-cents"), false);
  assert.ok(mapped.exceptions.some((item) => item.code === "amount_invalid" && item.sourceId === "fractional-cents"));
});

test("duplicate RM source IDs are quarantined before mapping or source-record insertion", () => {
  const mapped = mapRentManagerExport({
    ...input(),
    properties: [...input().properties!, { ...input().properties![0], name: "Duplicate property" }],
  });
  assert.equal(mapped.snapshot.properties.length, 1);
  assert.equal(mapped.sourceRecords.filter((record) => record.entityType === "property" && record.sourceId === "p1").length, 1);
  assert.ok(mapped.exceptions.some((item) => item.code === "duplicate_source_id" && item.sourceId === "p1"));
  assert.equal(mapped.importRun.status, "failed");
});

test("allocations and deposits require positive amounts, while subsidy obligations and dates are required", () => {
  const mapped = mapRentManagerExport({
    ...input(),
    allocations: [
      { entityType: "allocation", sourceId: "zero-allocation", paymentId: "pay1", chargeId: "c1", amount: 0, allocatedOn: "2026-08-02" },
      { entityType: "allocation", sourceId: "bad-allocation-date", paymentId: "pay1", chargeId: "c1", amount: 10, allocatedOn: "2026-02-30" },
    ],
    deposits: [{ entityType: "deposit", sourceId: "zero-deposit", tenancyId: "l1", tenantId: "t1", unitId: "u1", amount: 0, receivedOn: "2026-08-01" }],
    subsidies: [{ entityType: "subsidy", sourceId: "missing-subsidy-facts", tenancyId: "l1", unitId: "u1", agencyName: "Housing Agency" }],
  });
  assert.equal(mapped.snapshot.paymentAllocations.length, 0);
  assert.equal(mapped.snapshot.securityDeposits.length, 0);
  assert.equal(mapped.snapshot.subsidyContracts.length, 0);
  assert.ok(mapped.exceptions.some((item) => item.code === "amount_not_positive" && item.entityType === "payment_allocation"));
  assert.ok(mapped.exceptions.some((item) => item.code === "amount_not_positive" && item.entityType === "deposit"));
  assert.ok(mapped.exceptions.some((item) => item.code === "subsidy_fact_incomplete"));
});

test("payment payer is classified only from direct evidence and HAP-like unknowns block reconciliation", () => {
  const direct = mapRentManagerExport({
    ...input(),
    payments: [{ ...input().payments![0], sourceId: "agency-pay", description: "Housing assistance payment", payerType: "agency" }],
    allocations: [],
  });
  assert.equal(direct.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "agency-pay")?.payer, "agency");
  assert.equal(direct.exceptions.some((item) => item.code === "hap_payer_unknown"), false);

  const unknown = mapRentManagerExport({
    ...input(),
    payments: [{ ...input().payments![0], sourceId: "hap-pay", description: "Agency payment" }],
    allocations: [],
  });
  assert.equal(unknown.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "hap-pay")?.payer, "unknown");
  assert.ok(unknown.exceptions.some((item) => item.code === "hap_payer_unknown" && item.severity === "error"));

  const ownerClaim = mapRentManagerExport({
    ...input(),
    payments: [{ ...input().payments![0], sourceId: "owner-pay", description: "Owner reimbursement", payer: "owner" }],
    allocations: [],
  });
  assert.equal(ownerClaim.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "owner-pay")?.payer, "unknown");
  assert.ok(ownerClaim.exceptions.some((item) => item.code === "payment_payer_unknown"));
});

test("RM mapper preserves the normalized application profile allowlist without inventing absent answers", () => {
  const mapped = mapRentManagerExport({
    ...input(),
    applications: [{
      entityType: "application",
      sourceId: "application-1",
      status: "Submitted",
      email: "applicant@example.test",
      firstName: "Applicant",
      lastName: "One",
      rentalHistory: { currentAddress: "1 Current Way", landlordName: "Prior Landlord", unsupportedSecret: "must not survive" },
      employment: { employerName: "Synthetic Employer", jobTitle: "Manager", monthlyIncomeCents: 425000, employmentStartOn: "2024-02-01" },
      householdSummary: { adults: 2 },
      preferences: { desiredMoveInOn: "2026-09-01", desiredLeaseMonths: 12, maxRentCents: 150000, bedrooms: 2 },
      voucher: { hasVoucher: true, agencyName: "Housing Agency", caseNumber: "CASE-1", tenantPortionCents: 50000 },
      pets: [{ type: "cat", name: "Milo", weightLb: 12, unsupportedSecret: "must not survive" }],
      vehicles: [{ makeModel: "Synthetic Sedan", plateState: "FL", plateLastFour: "1234", vin: "must not survive" }],
      emergencyContact: { name: "Emergency One", phone: "555-0100", relationship: "Sibling" },
    }],
  });
  const application = mapped.snapshot.applications[0];
  assert.deepEqual(application.rentalHistory, { currentAddress: "1 Current Way", landlordName: "Prior Landlord" });
  assert.deepEqual(application.employment, { employerName: "Synthetic Employer", jobTitle: "Manager", monthlyIncomeCents: 425000, employmentStartOn: "2024-02-01" });
  assert.deepEqual(application.householdSummary, { adults: 2 });
  assert.deepEqual(application.preferences, { desiredMoveInOn: "2026-09-01", desiredLeaseMonths: 12, maxRentCents: 150000, bedrooms: 2 });
  assert.deepEqual(application.voucher, { hasVoucher: true, agencyName: "Housing Agency", caseNumber: "CASE-1", tenantPortionCents: 50000 });
  assert.deepEqual(application.pets, [{ type: "cat", name: "Milo", weightLb: 12 }]);
  assert.deepEqual(application.vehicles, [{ makeModel: "Synthetic Sedan", plateState: "FL", plateLastFour: "1234" }]);
  assert.deepEqual(application.emergencyContact, { name: "Emergency One", phone: "555-0100", relationship: "Sibling" });
  assert.equal((application as unknown as Record<string, unknown>).unsupportedSecret, undefined);
});

test("RM mapper marks documents verified only when exporter bytes are archived with path, checksum, and size", () => {
  const checksum = "a".repeat(64);
  const mapped = mapRentManagerExport({
    ...input(),
    documents: [
      ...input().documents!,
      { entityType: "document", sourceId: "doc-archived", tenantId: "t1", fileName: "lease.pdf", mimeType: "application/pdf", binaryAvailable: true, sha256: checksum, archivePath: "binaries/" + checksum + ".bin", sizeBytes: 6 },
      { entityType: "document", sourceId: "doc-unverified", tenantId: "t1", fileName: "other.pdf", mimeType: "application/pdf", binaryAvailable: true, sha256: checksum, archivePath: "../outside.pdf", sizeBytes: 6 },
    ],
  }, { now: new Date("2026-08-16T12:00:00.000Z") });
  const archived = mapped.snapshot.documents.find((document) => document.source?.sourceId === "doc-archived");
  const unverified = mapped.snapshot.documents.find((document) => document.source?.sourceId === "doc-unverified");
  assert.equal(archived?.state, "verified");
  assert.equal(archived?.storageKey, `binaries/${checksum}.bin`);
  assert.equal(archived?.checksumSha256, checksum);
  assert.equal(archived?.sizeBytes, 6);
  assert.equal(archived?.verifiedAt, "2026-08-16T12:00:00.000Z");
  assert.equal(unverified?.state, "requested");
  assert.equal(unverified?.checksumSha256, undefined);
  assert.equal(unverified?.sizeBytes, undefined);
  assert.ok(mapped.exceptions.some((item) => item.code === "document_storage_key_invalid" && item.sourceId === "doc-unverified"));
});

test("v3 financial categories require exact ChargeTypeID evidence and never parse rent-like prose", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [
      { artifactSha256, sourceCollection: "chargeTypes", sourceField: "ChargeTypeID", semanticKind: "charge_category", normalization: "trim_lower_unicode_v1", normalizedValue: "type-rent", targetValue: "base_rent" },
      { artifactSha256, sourceCollection: "chargeTypes", sourceField: "IsActive", semanticKind: "charge_definition_active", normalization: "trim_lower_unicode_v1", normalizedValue: "false", targetValue: "false" },
    ],
  };
  const mapped = mapRentManagerExport({
    ...input(),
    recurringSchedules: [],
    chargeTypes: [{ sourceId: "type-rent", name: "Rent (inactive)", active: false }],
    leaseTerms: [{ entityType: "lease_term", sourceId: "term-unsigned", leaseId: "l1", startDate: "2026-01-01", endDate: "2026-12-31", status: "unsigned", signed: false }],
    charges: [
      { entityType: "charge", sourceId: "exact-charge", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", ChargeTypeID: "type-rent", Name: "CHG-001", Description: "Monthly Rent", status: "unposted", amount: 850, postedOn: "2026-08-01" },
      { entityType: "charge", sourceId: "prose-only-charge", propertyId: "p1", unitId: "u1", leaseId: "l1", tenantId: "t1", Name: "CHG-002", Description: "Monthly Rent", status: "unposted", amount: 850, postedOn: "2026-08-01" },
    ],
    payments: [{ ...input().payments![0], sourceId: "rent-like-payment", ChargeTypeID: "type-rent", Description: "Rent payment", PaymentMethod: "cash", Payer: "tenant" }],
    allocations: [],
  }, { fidelityVersion: 3, artifactSha256, financialSemanticCrosswalk, targetIdFactory: deterministicTestTargetIdFactory });
  const exactCharge = mapped.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "exact-charge");
  const proseOnlyCharge = mapped.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "prose-only-charge");
  const payment = mapped.snapshot.ledgerTransactions.find((row) => row.source?.sourceId === "rent-like-payment");
  assert.equal(exactCharge?.category, "base_rent");
  assert.equal(exactCharge?.categoryKnowledge, "source");
  assert.equal(proseOnlyCharge?.category, null);
  assert.equal(proseOnlyCharge?.categoryKnowledge, "unknown");
  assert.equal(exactCharge?.status, null);
  assert.equal(payment?.category, null);
  assert.equal(payment?.status, null);
  assert.equal(payment?.paymentMethod, null);
  assert.equal(payment?.payer, null);
  assert.equal(mapped.snapshot.chargeDefinitions[0]?.active, false);
  assert.equal(mapped.snapshot.chargeDefinitions[0]?.category, "base_rent");
  assert.equal(mapped.snapshot.leaseTerms[0]?.status, null);
});

test("v3 deposits keep adversarial type and disposition prose unknown", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [{ artifactSha256, sourceCollection: "chargeTypes", sourceField: "ChargeTypeID", semanticKind: "charge_category", normalization: "trim_lower_unicode_v1", normalizedValue: "unused", targetValue: "other" }],
  };
  const mapped = mapRentManagerExport({
    ...input(),
    deposits: [{ entityType: "deposit", sourceId: "adversarial-deposit", tenantId: "t1", propertyId: "p1", unitId: "u1", leaseId: "l1", amount: 500, receivedOn: "2026-01-01", type: "not held", dispositionStatus: "undisposed", disposedOn: undefined }],
  }, { fidelityVersion: 3, artifactSha256, financialSemanticCrosswalk, targetIdFactory: deterministicTestTargetIdFactory });
  const deposit = mapped.snapshot.securityDeposits.find((row) => row.source?.sourceId === "adversarial-deposit");
  assert.equal(deposit?.type, undefined);
  assert.equal(deposit?.typeKnowledge, "unknown");
  assert.equal(deposit?.dispositionStatus, undefined);
  assert.equal(deposit?.dispositionStatusKnowledge, "unknown");
  assert.equal(deposit?.receivedOn, "2026-01-01");
  assert.ok(mapped.exceptions.some((item) => item.code === "deposit_type_unknown" && item.sourceId === "adversarial-deposit"));
  assert.ok(mapped.exceptions.some((item) => item.code === "deposit_disposition_unknown" && item.sourceId === "adversarial-deposit"));
});

test("v3 HAP child payer prose and boolean flags remain unknown without an approved crosswalk", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [{ artifactSha256, sourceCollection: "chargeTypes", sourceField: "ChargeTypeID", semanticKind: "charge_category", normalization: "trim_lower_unicode_v1", normalizedValue: "unused", targetValue: "other" }],
  };
  const mapped = mapRentManagerExport({
    ...input(),
    subsidyTenants: [{ entityType: "subsidy_tenant", sourceId: "hap-tenant-payer", tenantId: "t1", amount: 100, payer: "agency payment", isAgencyPayment: true }],
    subsidyPayments: [{ entityType: "subsidy_payment", sourceId: "hap-payment-payer", tenantId: "t1", amount: 100, paymentOn: "2026-01-02", payer: "tenant payment", isTenantPayment: true }],
  }, { fidelityVersion: 3, artifactSha256, financialSemanticCrosswalk, targetIdFactory: deterministicTestTargetIdFactory });
  const tenant = mapped.snapshot.subsidyTenants.find((row) => row.source?.sourceId === "hap-tenant-payer");
  const payment = mapped.snapshot.subsidyPayments.find((row) => row.source?.sourceId === "hap-payment-payer");
  assert.equal(tenant?.payer, "unknown");
  assert.equal(tenant?.payerKnowledge, "unknown");
  assert.equal(payment?.payer, "unknown");
  assert.equal(payment?.payerKnowledge, "unknown");
});

test("v3 generic move-in dates stay unknown when the lease carries only misleading status prose", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [{ artifactSha256, sourceCollection: "tenants.current", sourceField: "$partition", semanticKind: "tenancy_status", normalization: "trim_lower_unicode_v1", normalizedValue: "current", targetValue: "current" }],
  };
  const mapped = mapRentManagerExport({
    ...input(),
    leases: [{ ...input().leases![0], sourceCollection: "leases", status: "inactive", moveInDate: "2026-02-01" }],
  }, { fidelityVersion: 3, artifactSha256, financialSemanticCrosswalk, targetIdFactory: deterministicTestTargetIdFactory });
  const tenancy = mapped.snapshot.tenancies[0];
  assert.equal(tenancy.plannedMoveInOn, undefined);
  assert.equal(tenancy.actualMoveInOn, undefined);
  assert.ok(mapped.exceptions.some((item) => item.code === "tenancy_status_unknown"));
});

test("v3 crosswalk selection is exactly-one, artifact-bound, and definition links require an observed row", () => {
  const artifactSha256 = "a".repeat(64);
  const crosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [
      { artifactSha256, sourceCollection: "chargeTypes", sourceField: "ChargeTypeID", semanticKind: "charge_category", normalization: "trim_lower_unicode_v1", normalizedValue: "type-rent", targetValue: "base_rent" },
      { artifactSha256, sourceCollection: "recurringSchedules", sourceField: "EntityType", semanticKind: "recurring_scope", normalization: "trim_lower_unicode_v1", normalizedValue: "tenant", targetValue: "tenant" },
    ],
  };
  const source = {
    ...input(),
    chargeTypes: [{ sourceId: "type-rent", name: "Rent", active: null }],
    recurringSchedules: [{ entityType: "recurring_schedule", sourceId: "schedule-exact", scopeType: "tenant", scopeId: "t1", leaseId: "l1", ChargeTypeID: "type-rent", amount: 850, effectiveFrom: "2026-01-01" }],
    financialSemanticCrosswalk: crosswalk,
  };
  const exact = mapRentManagerExport(source, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  const exactSchedule = exact.snapshot.recurringSchedules[0];
  assert.equal(exactSchedule?.chargeDefinitionId, exact.snapshot.chargeDefinitions[0]?.id);
  assert.equal(exactSchedule?.chargeDefinitionLinkKnowledge, "exact");

  const missingDefinition = mapRentManagerExport({ ...source, chargeTypes: [] }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  const missingSchedule = missingDefinition.snapshot.recurringSchedules[0];
  assert.equal(missingSchedule?.chargeDefinitionId, null);
  assert.equal(missingSchedule?.chargeDefinitionKey, null);
  assert.equal(missingSchedule?.chargeDefinitionLinkKnowledge, "unknown");

  const empty = mapRentManagerExport({ ...source, financialSemanticCrosswalk: [] }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.ok(empty.exceptions.some((item) => item.code === "financial_semantic_crosswalk_invalid"));
  const multiple = mapRentManagerExport({ ...source, financialSemanticCrosswalk: [crosswalk, crosswalk] }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.ok(multiple.exceptions.some((item) => item.code === "financial_semantic_crosswalk_invalid"));
  const stale = mapRentManagerExport({ ...source, financialSemanticCrosswalk: { ...crosswalk, artifactSha256: "b".repeat(64), entries: crosswalk.entries.map((entry) => ({ ...entry, artifactSha256: "b".repeat(64) })) } }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.ok(stale.exceptions.some((item) => item.code === "financial_semantic_crosswalk_invalid"));
});

test("unresolved v3 recurring scope keys stay restricted and never reach the browser DTO", () => {
  const artifactSha256 = "a".repeat(64);
  const rawEntityKey = "rm-entity-key-987654";
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [
      { artifactSha256, sourceCollection: "chargeTypes", sourceField: "ChargeTypeID", semanticKind: "charge_category", normalization: "trim_lower_unicode_v1", normalizedValue: "type-rent", targetValue: "base_rent" },
      { artifactSha256, sourceCollection: "recurringSchedules", sourceField: "EntityType", semanticKind: "recurring_scope", normalization: "trim_lower_unicode_v1", normalizedValue: "tenant", targetValue: "tenant" },
    ],
  };
  const mapped = mapRentManagerExport({
    ...input(),
    chargeTypes: [{ sourceId: "type-rent", name: "Rent", active: true }],
    recurringSchedules: [{
      entityType: "recurring_schedule",
      sourceId: "schedule-unresolved-scope",
      EntityType: "Tenant",
      EntityKeyID: rawEntityKey,
      ChargeTypeID: "type-rent",
      amount: 850,
      effectiveFrom: "2026-01-01",
    }],
  }, { fidelityVersion: 3, artifactSha256, financialSemanticCrosswalk, targetIdFactory: deterministicTestTargetIdFactory });

  const schedule = mapped.snapshot.recurringSchedules[0];
  assert.ok(schedule);
  assert.equal(schedule.scopeType, null);
  assert.equal(schedule.scopeId, null);
  assert.equal(schedule.scopeTypeKnowledge, "unknown");
  assert.equal(schedule.scopeLinkKnowledge, "unknown");
  assert.equal(JSON.stringify(schedule).includes(rawEntityKey), false);
  assert.equal(JSON.stringify(serializeAdminRecurringSchedule(schedule)).includes(rawEntityKey), false);
  assert.ok(mapped.exceptions.some((item) => item.code === "recurring_schedule_unmapped"));
});

test("target IDs are injected, stable, and do not embed source IDs", () => {
  const first = mapRentManagerExport(input(), { targetIdFactory: deterministicTestTargetIdFactory });
  const second = mapRentManagerExport(input(), { targetIdFactory: deterministicTestTargetIdFactory });
  assert.deepEqual(first.snapshot.people.map((row) => row.id), second.snapshot.people.map((row) => row.id));
  assert.ok(first.snapshot.people.every((row) => !row.id.includes("t1") && !row.id.includes("contact-secondary")));
  assert.ok(first.snapshot.tenancies.every((row) => !row.id.includes("l1")));
  assert.equal(first.snapshot.tenancies[0]?.primaryPersonId, first.snapshot.people.find((row) => row.source?.sourceId === "t1")?.id);
});

test("v3 application status requires the exact artifact-bound status crosswalk", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [{ artifactSha256, sourceCollection: "tenants.current", sourceField: "$partition", semanticKind: "tenancy_status", normalization: "trim_lower_unicode_v1", normalizedValue: "current", targetValue: "current" }],
  };
  const application = {
    entityType: "application",
    sourceId: "application-status-1",
    sourceCollection: "prospectApplications",
    ProspectApplicationID: "application-status-1",
    Status: "incomplete",
  };
  const unknown = mapRentManagerExport({
    ...input(),
    applications: [application],
    financialSemanticCrosswalk,
  }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.equal(unknown.snapshot.applications[0]?.status, null);
  assert.equal(unknown.snapshot.applications[0]?.statusKnowledge, "unknown");
  assert.ok(unknown.exceptions.some((item) => item.code === "application_status_unknown"));

  const exact = mapRentManagerExport({
    ...input(),
    applications: [application],
    applicationHistoryStatusCrosswalk: [{
      artifactSha256,
      sourceCollection: "prospectApplications",
      sourceField: "Status",
      sourceValue: "incomplete",
      targetStatus: "draft",
    }],
    financialSemanticCrosswalk,
  }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.equal(exact.snapshot.applications[0]?.status, "draft");
  assert.equal(exact.snapshot.applications[0]?.statusKnowledge, "source");
});

test("unknown recurring definitions retain distinct schedule identities without inventing definition rows", () => {
  const source = input();
  source.recurringSchedules = [
    { entityType: "recurring_schedule", sourceId: "schedule-unknown-a", scopeType: "tenant", scopeId: "t1", leaseId: "l1", amount: 10, effectiveFrom: "2026-01-01", category: "recurring_fee" },
    { entityType: "recurring_schedule", sourceId: "schedule-unknown-b", scopeType: "tenant", scopeId: "t1", leaseId: "l1", amount: 15, effectiveFrom: "2026-02-01", category: "recurring_fee" },
  ];
  const mapped = mapRentManagerExport(source, { fidelityVersion: 3, targetIdFactory: deterministicTestTargetIdFactory });
  const schedules = mapped.snapshot.recurringSchedules;
  assert.equal(schedules.length, 2);
  assert.notEqual(schedules[0]?.id, schedules[1]?.id);
  assert.ok(schedules.every((schedule) => schedule.chargeDefinitionId === null));
  assert.ok(schedules.every((schedule) => schedule.chargeDefinitionKey === null));
  assert.ok(schedules.every((schedule) => schedule.chargeDefinitionKnowledge === "unknown"));
  assert.ok(schedules.every((schedule) => schedule.chargeDefinitionLinkKnowledge === "unknown"));
  assert.ok(mapped.exceptions.some((item) => item.code === "recurring_charge_definition_unknown"));
});

test("RM progress states remain exact and never imply application approval", () => {
  const artifactSha256 = "a".repeat(64);
  const states = [["Complete", "complete"], ["InProgress", "in_progress"], ["AwaitingPayment", "awaiting_payment"]] as const;
  const applications = states.map(([ApplicationStatus], index) => ({ entityType: "application", sourceId: `progress-${index}`, sourceCollection: "prospectApplications", ApplicationStatus }));
  const mapped = mapRentManagerExport({
    ...input(), applications,
    applicationHistoryStatusCrosswalk: states.map(([sourceValue, targetStatus]) => ({ artifactSha256, sourceCollection: "prospectApplications", sourceField: "ApplicationStatus", sourceValue, targetStatus })),
  }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.deepEqual(mapped.snapshot.applications.map((row) => row.status), states.map(([, status]) => status));
  assert.ok(mapped.snapshot.applications.every((row) => row.statusKnowledge === "source" && row.status !== "approved"));
  const unknown = mapRentManagerExport({ ...input(), applications }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.ok(unknown.snapshot.applications.every((row) => row.status === null));
});

test('explicit RM NSF fields retain original receipt and allocations plus a deterministic dated reversal', () => {
  const data=input();const original=data.payments![0];
  Object.assign(original,{ReversalType:'NSF',ReversalDate:'2026-08-05T00:00:00'});
  data.payments!.push({...original,sourceId:'replacement',ReversalType:undefined,ReversalDate:undefined,postedOn:'2026-08-06'});
  data.allocations!.push({...data.allocations![0],sourceId:'replacement-allocation',paymentId:'replacement',allocatedOn:'2026-08-06'});
  const first=mapRentManagerExport(data),second=mapRentManagerExport(data);
  const payment=first.snapshot.ledgerTransactions.find(row=>row.source?.sourceId==='pay1')!;
  const reversal=first.snapshot.ledgerTransactions.find(row=>row.reversalOfId===payment.id)!;
  assert.equal(payment.kind,'payment');assert.equal(payment.postedOn,'2026-08-02');
  assert.equal(reversal.postedOn,'2026-08-05');assert.equal(reversal.amountCents,85000);assert.equal(reversal.status,'posted');
  assert.equal(reversal.id,second.snapshot.ledgerTransactions.find(row=>row.kind==='reversal')?.id);
  assert.equal(first.snapshot.paymentAllocations.length,2);
  assert.equal(first.sourceRecords.filter(row=>row.entityType==='ledger_transaction').length,5);
  assert.equal(first.exceptions.some(row=>row.code==='snapshot_invariant_failed'),false);
});

test('unsupported or incomplete reversal evidence never invents an NSF or erases a payment', () => {
  for(const fields of [{ReversalType:'Unsupported',ReversalDate:'2026-08-05'}, {ReversalType:'NSF'}, {ReversalType:'NSF',ReversalDate:'2026-07-01'}, {ReversalDate:'2026-08-05'}]) {
    const data=input();Object.assign(data.payments![0],fields);const result=mapRentManagerExport(data);
    assert.equal(result.snapshot.ledgerTransactions.filter(row=>row.kind==='reversal').length,0);
    assert.equal(result.snapshot.ledgerTransactions.filter(row=>row.kind==='payment').length,1);
    assert.ok(result.exceptions.some(row=>row.code==='payment_reversal_unresolved'&&row.severity==='error'));
  }
});

test('source reverse allocation is signed, dated, artifact-bound and does not double reverse an NSF', async () => {
  const { deriveTenantLedger }=await import('../domain/reports');
  const data=input();data.artifactSha256='a'.repeat(64);data.artifactObservationOn='2026-08-16';
  Object.assign(data.payments![0],{ReversalType:'NSF',ReversalDate:'2026-08-05'});
  data.allocations!.push({entityType:'allocation',sourceId:'reverse-a1',paymentId:'pay1',chargeId:'c1',amount:-850,allocatedOn:'2026-08-05',AllocationType:'ReverseDirectAllocation'});
  const result=mapRentManagerExport(data),negative=result.snapshot.paymentAllocations.find(row=>row.amountCents!<0)!;
  assert.equal(negative.amountCents,-85000);assert.equal(negative.kind,'reversal');assert.equal(negative.sourceArtifactSha256,'a'.repeat(64));
  assert.equal(result.exceptions.some(row=>row.code==='snapshot_invariant_failed'),false);
  const tenancy=result.snapshot.tenancies[0].id,charge=result.snapshot.ledgerTransactions.find(row=>row.source?.sourceId==='c1')!;
  assert.equal(deriveTenantLedger(result.snapshot,tenancy,{asOfDate:'2026-08-04'}).find(row=>row.transaction.id===charge.id)?.openCents,0);
  assert.equal(deriveTenantLedger(result.snapshot,tenancy,{asOfDate:'2026-08-06'}).find(row=>row.transaction.id===charge.id)?.openCents,85000);
});

test('EntityTransfer remains source history while only EntityTransferAllocation applies to the charge', async () => {
  const { deriveTenantLedger }=await import('../domain/reports');
  const data=input();data.artifactSha256='a'.repeat(64);data.artifactObservationOn='2026-08-16';
  Object.assign(data.allocations![0],{AllocationType:'EntityTransferAllocation'});
  data.allocations!.push({...data.allocations![0],sourceId:'transfer-side',AllocationType:'EntityTransfer'});
  const result=mapRentManagerExport(data),transfer=result.snapshot.paymentAllocations.find(row=>row.kind==='transfer')!;
  assert.equal(transfer.amountCents,85000);assert.equal(result.snapshot.paymentAllocations.length,2);
  assert.equal(result.exceptions.some(row=>row.code==='snapshot_invariant_failed'),false);
  const charge=result.snapshot.ledgerTransactions.find(row=>row.source?.sourceId==='c1')!;
  assert.equal(deriveTenantLedger(result.snapshot,result.snapshot.tenancies[0].id,{asOfDate:'2026-08-16'}).find(row=>row.transaction.id===charge.id)?.openCents,0);
});

test('exact ePay and Void source reversal enums retain dated reversal and source reason without NSF relabeling',()=>{
 for(const type of ['ePay','Void']){
  const data=input();Object.assign(data.payments![0],{ReversalType:type,ReversalDate:'2026-08-05',ReversalReason:'Overpaid'});
  const result=mapRentManagerExport(data),reversal=result.snapshot.ledgerTransactions.find(row=>row.kind==='reversal')!;
  assert.ok(reversal.source?.sourceId.endsWith(`:ReversalType:${type}`));assert.equal(reversal.description,'Overpaid');assert.equal(reversal.descriptionKnowledge,'source');assert.equal(reversal.postedOn,'2026-08-05');assert.equal(reversal.amountCents,85000);
  assert.equal(result.snapshot.ledgerTransactions.filter(row=>row.kind==='payment').length,1);
  assert.equal(result.exceptions.some(row=>row.code==='payment_reversal_unresolved'),false);
 }
});

test("v3 source-absent recurring amount remains retained unknown; invalid and nonpositive amounts block", () => {
  const artifactSha256 = "a".repeat(64);
  const financialSemanticCrosswalk: RentManagerFinancialSemanticCrosswalk = { artifactSha256, normalization: "exact_v1", entries: [{ artifactSha256, sourceCollection: "recurringSchedules", sourceField: "EntityType", semanticKind: "recurring_scope", normalization: "exact_v1", normalizedValue: "Tenant", targetValue: "tenant" }] };
  const base = { ...input(), financialSemanticCrosswalk, recurringSchedules: [{ sourceId: "absent-amount", EntityType: "Tenant", EntityKeyID: "t1", tenantId: "t1" }] };
  const mapped = mapRentManagerExport(base, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
  assert.equal(mapped.snapshot.recurringSchedules.length, 1);
  assert.equal(mapped.snapshot.recurringSchedules[0].amountCents, null);
  assert.equal(mapped.snapshot.recurringSchedules[0].amountKnowledge, "unknown");
  assert.equal(mapped.snapshot.recurringSchedules[0].active, null);
  assert.ok(mapped.exceptions.some((x) => x.code === "recurring_schedule_amount_unknown" && x.severity === "warning"));
  for (const amount of [0, -1, "not-money"]) {
    const result = mapRentManagerExport({ ...base, recurringSchedules: [{ ...base.recurringSchedules[0], amount }] }, { fidelityVersion: 3, artifactSha256, targetIdFactory: deterministicTestTargetIdFactory });
    assert.ok(result.exceptions.some((x) => x.code === "recurring_schedule_fact_incomplete" && x.severity === "error"));
  }
});

test('exact CreditAllocation applies an existing credit and never invents a payment',()=>{
 const data=input();
 Object.assign(data,{artifactSha256:'a'.repeat(64),artifactObservationOn:'2026-08-16'});
 data.allocations.push({entityType:'allocation',sourceId:'credit-application',paymentId:'',chargeId:'c1',amount:25,allocatedOn:'2026-08-04',AllocationType:'CreditAllocation',creditId:'credit1'} as any);
 // Leave room for the credit application in the original charge.
 data.allocations[0].amount=825;
 const result=mapRentManagerExport(data),row=result.snapshot.paymentAllocations.find(a=>a.kind==='credit_allocation')!;
 assert.ok(row);assert.equal(row.paymentTransactionId,null);assert.equal(row.creditTransactionId,result.snapshot.ledgerTransactions.find(t=>t.source?.sourceId==='credit1')?.id);
 assert.equal(result.snapshot.ledgerTransactions.filter(t=>t.kind==='payment').length,1);
 assert.equal(result.exceptions.some(e=>e.code==='snapshot_invariant_failed'),false);
});
