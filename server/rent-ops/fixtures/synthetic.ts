import type {
  RentOpsActivityEvent,
  RentOpsChargeDefinition,
  RentOpsApplication,
  RentOpsApplicationRequirement,
  RentOpsLeaseTerm,
  RentOpsLedgerTransaction,
  RentOpsPaymentAllocation,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsSubsidyContract,
  RentOpsTenancy,
  RentOpsUnit,
} from "../../../shared/rent-ops-contracts";
import { emptyRentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";

const createdAt = "2026-01-01T12:00:00.000Z";
const propertyA: RentOpsProperty = {
  id: "demo-property-a",
  name: "Demo Harbor Homes",
  slug: "demo-harbor",
  address: { line1: "100 Example Way", city: "Sampleton", state: "ZZ", postalCode: "00001" },
  propertyType: "multifamily",
  state: "active",
  operatingContact: "Demo Operations",
};
const propertyB: RentOpsProperty = {
  id: "demo-property-b",
  name: "Demo Grove Flats",
  slug: "demo-grove",
  address: { line1: "200 Fiction Road", city: "Sampleton", state: "ZZ", postalCode: "00002" },
  propertyType: "multifamily",
  state: "active",
  operatingContact: "Demo Operations",
};

const units: RentOpsUnit[] = [
  { id: "demo-unit-a-1", propertyId: propertyA.id, unitNumber: "1A", unitType: "flat", bedrooms: 2, bathrooms: 1.5, squareFeet: 900, marketRentCents: 125000, defaultDepositCents: 125000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-a-2", propertyId: propertyA.id, unitNumber: "2A", unitType: "flat", bedrooms: 2, bathrooms: 1, squareFeet: 850, marketRentCents: 130000, defaultDepositCents: 130000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-a-3", propertyId: propertyA.id, unitNumber: "3A", unitType: "flat", bedrooms: 1, bathrooms: 1, squareFeet: 700, marketRentCents: 110000, defaultDepositCents: 110000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-a-4", propertyId: propertyA.id, unitNumber: "4A", unitType: "flat", bedrooms: 1, bathrooms: 1, squareFeet: 700, marketRentCents: 105000, defaultDepositCents: 105000, readiness: "not_ready", listing: "unlisted" },
  { id: "demo-unit-a-5", propertyId: propertyA.id, unitNumber: "5A", unitType: "flat", bedrooms: 3, bathrooms: 2, squareFeet: 1200, marketRentCents: undefined, defaultDepositCents: 150000, readiness: "off_market", listing: "off_market" },
  { id: "demo-unit-b-1", propertyId: propertyB.id, unitNumber: "1B", unitType: "flat", bedrooms: 2, bathrooms: 1, squareFeet: 860, marketRentCents: 115000, defaultDepositCents: 115000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-b-2", propertyId: propertyB.id, unitNumber: "2B", unitType: "flat", bedrooms: 2, bathrooms: 1, squareFeet: 860, marketRentCents: 115000, defaultDepositCents: 115000, readiness: "ready", listing: "unlisted" },
];

const people: RentOpsPerson[] = [
  { id: "demo-person-1", firstName: "Tenant", lastName: "One", email: "tenant.one@example.test", phone: "+1-555-0101", renterInsuranceExpiresOn: "2027-01-31" },
  { id: "demo-person-2", firstName: "Tenant", lastName: "Two", email: "tenant.two@example.test", phone: "+1-555-0102" },
  { id: "demo-person-3", firstName: "Tenant", lastName: "Three", email: "tenant.three@example.test", phone: "+1-555-0103" },
  { id: "demo-person-4", firstName: "Applicant", lastName: "Four", email: "applicant.four@example.test", phone: "+1-555-0104" },
];

const tenancies: RentOpsTenancy[] = [
  { id: "demo-tenancy-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", primaryPersonId: "demo-person-1", status: "current", actualMoveInOn: "2026-01-01", createdAt },
  { id: "demo-tenancy-2", propertyId: propertyA.id, unitId: "demo-unit-a-2", primaryPersonId: "demo-person-2", status: "future", actualMoveInOn: "2026-09-01", createdAt },
  { id: "demo-tenancy-3", propertyId: propertyB.id, unitId: "demo-unit-b-1", primaryPersonId: "demo-person-3", status: "current", actualMoveInOn: "2025-06-01", createdAt },
];

const leaseTerms: RentOpsLeaseTerm[] = [
  { id: "demo-term-1", tenancyId: "demo-tenancy-1", status: "executed", contractStartOn: "2026-01-01", contractEndOn: "2026-09-15", monthToMonth: false, signedOn: "2025-12-20", createdAt },
  { id: "demo-term-2", tenancyId: "demo-tenancy-2", status: "executed", contractStartOn: "2026-09-01", contractEndOn: "2027-08-31", monthToMonth: false, signedOn: "2026-08-10", createdAt },
  { id: "demo-term-3", tenancyId: "demo-tenancy-3", status: "month_to_month", contractStartOn: "2025-06-01", monthToMonth: true, createdAt },
];

const chargeDefinitions: RentOpsChargeDefinition[] = [
  { id: "demo-charge-definition-base-rent", displayName: "Monthly base rent", displayNameKnowledge: "manual", category: "base_rent", categoryKnowledge: "manual", active: true, activeKnowledge: "manual", recordRevision: 1 },
  { id: "demo-charge-definition-utility-fee", displayName: "Utility administration fee", displayNameKnowledge: "manual", category: "recurring_fee", categoryKnowledge: "manual", active: true, activeKnowledge: "manual", recordRevision: 1 },
  { id: "demo-charge-definition-subsidy", displayName: "Agency scheduled assistance", displayNameKnowledge: "manual", category: "subsidy", categoryKnowledge: "manual", active: true, activeKnowledge: "manual", recordRevision: 1 },
  { id: "demo-charge-definition-security-deposit", displayName: "Security deposit", displayNameKnowledge: "manual", category: "security_deposit", categoryKnowledge: "manual", active: true, activeKnowledge: "manual", recordRevision: 1 },
];

const recurringSchedules: RentOpsRecurringChargeSchedule[] = [
  { id: "demo-schedule-1", billingFrequency: "monthly", scopeType: "tenant", scopeId: "demo-person-1", scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual", chargeDefinitionId: "demo-charge-definition-base-rent", chargeDefinitionKey: "base_rent", chargeDefinitionKnowledge: "manual", chargeDefinitionLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", category: "base_rent", categoryKnowledge: "manual", description: "Monthly base rent", descriptionKnowledge: "manual", amountCents: 120000, amountKnowledge: "known", effectiveFrom: "2026-01-01", effectiveFromKnowledge: "manual", active: true, activeKnowledge: "manual", sourceConfidence: "confirmed", lineageRootId: "demo-schedule-1", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root", recordRevision: 1 },
  { id: "demo-schedule-2", billingFrequency: "monthly", scopeType: "tenant", scopeId: "demo-person-1", scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual", chargeDefinitionId: "demo-charge-definition-utility-fee", chargeDefinitionKey: "recurring_fee", chargeDefinitionKnowledge: "manual", chargeDefinitionLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", category: "recurring_fee", categoryKnowledge: "manual", description: "Utility administration fee", descriptionKnowledge: "manual", amountCents: 5000, amountKnowledge: "known", effectiveFrom: "2026-01-01", effectiveFromKnowledge: "manual", active: true, activeKnowledge: "manual", sourceConfidence: "confirmed", lineageRootId: "demo-schedule-2", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root", recordRevision: 1 },
  { id: "demo-schedule-3", billingFrequency: "monthly", scopeType: "tenant", scopeId: "demo-person-1", scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual", chargeDefinitionId: "demo-charge-definition-subsidy", chargeDefinitionKey: "subsidy", chargeDefinitionKnowledge: "manual", chargeDefinitionLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", category: "subsidy", categoryKnowledge: "manual", description: "Agency scheduled assistance", descriptionKnowledge: "manual", amountCents: 40000, amountKnowledge: "known", effectiveFrom: "2026-01-01", effectiveFromKnowledge: "manual", active: true, activeKnowledge: "manual", sourceConfidence: "confirmed", lineageRootId: "demo-schedule-3", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root", recordRevision: 1 },
  { id: "demo-schedule-4", billingFrequency: "monthly", scopeType: "tenant", scopeId: "demo-person-2", scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual", chargeDefinitionId: "demo-charge-definition-base-rent", chargeDefinitionKey: "base_rent", chargeDefinitionKnowledge: "manual", chargeDefinitionLinkKnowledge: "exact", tenancyId: "demo-tenancy-2", propertyId: propertyA.id, unitId: "demo-unit-a-2", category: "base_rent", categoryKnowledge: "manual", description: "Monthly base rent", descriptionKnowledge: "manual", amountCents: 130000, amountKnowledge: "known", effectiveFrom: "2026-09-01", effectiveFromKnowledge: "manual", active: true, activeKnowledge: "manual", sourceConfidence: "confirmed", lineageRootId: "demo-schedule-4", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root", recordRevision: 1 },
  { id: "demo-schedule-5", billingFrequency: "monthly", scopeType: "tenant", scopeId: "demo-person-3", scopeTypeKnowledge: "manual", scopeLinkKnowledge: "manual", chargeDefinitionId: "demo-charge-definition-base-rent", chargeDefinitionKey: "base_rent", chargeDefinitionKnowledge: "manual", chargeDefinitionLinkKnowledge: "exact", tenancyId: "demo-tenancy-3", propertyId: propertyB.id, unitId: "demo-unit-b-1", category: "base_rent", categoryKnowledge: "manual", description: "Monthly base rent", descriptionKnowledge: "manual", amountCents: 110000, amountKnowledge: "known", effectiveFrom: "2025-06-01", effectiveFromKnowledge: "manual", active: true, activeKnowledge: "manual", sourceConfidence: "confirmed", lineageRootId: "demo-schedule-5", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root", recordRevision: 1 },
];

const ledgerTransactionRows: RentOpsLedgerTransaction[] = [
  { id: "demo-charge-rent-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "charge", category: "base_rent", status: "posted", amountCents: 120000, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "August base rent", payer: "tenant" },
  { id: "demo-charge-fee-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "charge", category: "recurring_fee", status: "posted", amountCents: 5000, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "August utility administration fee", payer: "tenant" },
  { id: "demo-charge-other-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "charge", category: "one_time_fee", status: "posted", amountCents: 2500, postedOn: "2026-08-03", dueOn: "2026-08-03", description: "Replacement key fee", payer: "tenant" },
  { id: "demo-charge-deposit-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "charge", category: "security_deposit", status: "posted", amountCents: 120000, postedOn: "2026-01-01", dueOn: "2026-01-01", description: "Security deposit receipt", payer: "tenant" },
  { id: "demo-payment-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "payment", category: "other", status: "posted", amountCents: 75000, postedOn: "2026-08-03", description: "Tenant payment", paymentMethod: "zelle", payer: "tenant" },
  { id: "demo-payment-hap-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "payment", category: "other", status: "posted", amountCents: 35000, postedOn: "2026-08-05", description: "Agency payment", paymentMethod: "ach", payer: "agency" },
  { id: "demo-payment-unapplied-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "payment", category: "unapplied_cash", status: "posted", amountCents: 20000, postedOn: "2026-08-06", description: "Unapplied tenant funds", paymentMethod: "cash", payer: "tenant" },
  { id: "demo-credit-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "credit", category: "base_rent", status: "posted", amountCents: 10000, postedOn: "2026-08-06", description: "Courtesy rent credit", payer: "owner" },
  { id: "demo-charge-rent-3", propertyId: propertyB.id, unitId: "demo-unit-b-1", tenancyId: "demo-tenancy-3", personId: "demo-person-3", kind: "charge", category: "base_rent", status: "posted", amountCents: 110000, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "August base rent", payer: "tenant" },
  { id: "demo-payment-3", propertyId: propertyB.id, unitId: "demo-unit-b-1", tenancyId: "demo-tenancy-3", personId: "demo-person-3", kind: "payment", category: "other", status: "posted", amountCents: 110000, postedOn: "2026-08-02", description: "Tenant payment", paymentMethod: "check", payer: "tenant" },
];

const manualDefinitionByCategory: Partial<Record<NonNullable<RentOpsLedgerTransaction["category"]>, string>> = {
  base_rent: "demo-charge-definition-base-rent",
  recurring_fee: "demo-charge-definition-utility-fee",
  subsidy: "demo-charge-definition-subsidy",
  security_deposit: "demo-charge-definition-security-deposit",
};

const ledgerTransactions: RentOpsLedgerTransaction[] = ledgerTransactionRows.map((row) => {
  const chargeDefinitionId = row.kind === "charge" || row.kind === "credit"
    ? row.category ? manualDefinitionByCategory[row.category] ?? null : null
    : null;
  return {
    ...row,
    categoryKnowledge: row.category ? "manual" : "unknown",
    statusKnowledge: row.status ? "manual" : "unknown",
    amountKnowledge: row.amountCents === null ? "unknown" : "known",
    postedOnKnowledge: row.postedOn ? "manual" : "unknown",
    dueOnKnowledge: row.dueOn ? "manual" : "unknown",
    paymentMethodKnowledge: row.paymentMethod ? "manual" : "unknown",
    descriptionKnowledge: row.description ? "manual" : "unknown",
    payerKnowledge: row.payer ? "manual" : "unknown",
    propertyLinkKnowledge: row.propertyId ? "manual" : "unknown",
    unitLinkKnowledge: row.unitId ? "manual" : "unknown",
    tenancyLinkKnowledge: row.tenancyId ? "manual" : "unknown",
    personLinkKnowledge: row.personId ? "manual" : "unknown",
    allocationMode: row.kind === "payment" ? "unknown" : null,
    chargeDefinitionId,
    chargeDefinitionLinkKnowledge: chargeDefinitionId ? "manual" : "unknown",
  };
});

const paymentAllocationRows: RentOpsPaymentAllocation[] = [
  { id: "demo-allocation-1", paymentTransactionId: "demo-payment-1", chargeTransactionId: "demo-charge-rent-1", amountCents: 70000, allocatedOn: "2026-08-03" },
  { id: "demo-allocation-2", paymentTransactionId: "demo-payment-1", chargeTransactionId: "demo-charge-fee-1", amountCents: 5000, allocatedOn: "2026-08-03" },
  { id: "demo-allocation-3", paymentTransactionId: "demo-payment-hap-1", chargeTransactionId: "demo-charge-rent-1", amountCents: 35000, allocatedOn: "2026-08-05" },
  { id: "demo-allocation-4", paymentTransactionId: "demo-payment-3", chargeTransactionId: "demo-charge-rent-3", amountCents: 110000, allocatedOn: "2026-08-02" },
];

const paymentAllocations: RentOpsPaymentAllocation[] = paymentAllocationRows.map((row) => ({
  ...row,
  paymentLinkKnowledge: row.paymentTransactionId ? "manual" : "unknown",
  chargeLinkKnowledge: row.chargeTransactionId ? "manual" : "unknown",
  amountKnowledge: row.amountCents === null ? "unknown" : "known",
  allocatedOnKnowledge: row.allocatedOn ? "manual" : "unknown",
}));

const securityDeposits: RentOpsSecurityDeposit[] = [
  { id: "demo-deposit-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", type: "security", amountHeldCents: 120000, receivedOn: "2026-01-01", dispositionStatus: "held" },
  { id: "demo-deposit-2", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", type: "refundable_pet", amountHeldCents: 25000, receivedOn: "2026-01-01", dispositionStatus: "held" },
];

const subsidyContracts: RentOpsSubsidyContract[] = [
  { id: "demo-subsidy-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", agencyName: "Demo Housing Agency", contractNumber: "DEMO-001", effectiveFrom: "2026-01-01", agencyObligationCents: 40000, tenantObligationCents: 80000, status: "active" },
];

const applications: RentOpsApplication[] = [
  { id: "demo-application-1", sourceType: "public_portal", status: "submitted", email: "applicant.four@example.test", firstName: "Applicant", lastName: "Four", phone: "+1-555-0104", propertyId: propertyA.id, createdAt, updatedAt: "2026-08-10T12:00:00.000Z", submittedOn: "2026-08-10", certificationAcceptedOn: "2026-08-10", householdSummary: { adults: 1, children: 0, totalOccupants: 1 }, preferences: { desiredMoveInOn: "2026-09-01", desiredLeaseMonths: 12, bedrooms: 2 } },
  { id: "demo-application-2", sourceType: "manual", status: "missing_information", email: "applicant.five@example.test", firstName: "Applicant", lastName: "Five", propertyId: propertyB.id, createdAt, updatedAt: "2026-08-11T12:00:00.000Z" },
];

const applicationRequirements: RentOpsApplicationRequirement[] = [
  { id: "demo-requirement-1", applicationId: "demo-application-1", key: "identity_document", label: "Identity document", status: "received", requestedOn: "2026-08-10", resolvedOn: "2026-08-10" },
  { id: "demo-requirement-2", applicationId: "demo-application-2", key: "income_document", label: "Income document", status: "requested", requestedOn: "2026-08-11" },
];

const activityEvents: RentOpsActivityEvent[] = [
  { id: "demo-activity-1", propertyId: propertyA.id, unitId: "demo-unit-a-1", personId: "demo-person-1", tenancyId: "demo-tenancy-1", type: "promise_to_pay", occurredAt: "2026-08-08T12:00:00.000Z", actor: "Demo Admin", summary: "Tenant promised a payment by next Friday" },
];

export function syntheticRentOpsSnapshot(): RentOpsSnapshot {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.properties = [propertyA, propertyB];
  snapshot.units = units;
  snapshot.people = people;
  snapshot.tenancies = tenancies;
  snapshot.householdMemberships = tenancies.map((tenancy) => ({
    id: `demo-household:${tenancy.id}:primary`,
    tenancyId: tenancy.id,
    personId: tenancy.primaryPersonId,
    role: "primary",
    isFinanciallyResponsible: true,
  }));
  snapshot.leaseTerms = leaseTerms;
  snapshot.chargeDefinitions = chargeDefinitions;
  snapshot.recurringSchedules = recurringSchedules;
  snapshot.ledgerTransactions = ledgerTransactions;
  snapshot.paymentAllocations = paymentAllocations;
  snapshot.securityDeposits = securityDeposits;
  snapshot.subsidyContracts = subsidyContracts;
  snapshot.applications = applications;
  snapshot.applicationRequirements = applicationRequirements;
  snapshot.activityEvents = activityEvents;
  return snapshot;
}

export function createSyntheticRentOpsRepository(): SyntheticRentOpsRepository {
  return new SyntheticRentOpsRepository(syntheticRentOpsSnapshot());
}
