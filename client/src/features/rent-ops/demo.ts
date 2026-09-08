import type {
  AdminSnapshot,
  AdminSnapshotView,
  AdminApplicationView,
  AdminChargeDefinitionView,
  AdminPersonView,
  AdminHouseholdMembershipView,
  AdminApplicationHouseholdMemberView,
  AdminDocumentView,
  ReportColumn,
  ReportDefinition,
  ReportKey,
  ReportRow,
  TenantView,
} from "./types";
import { REPORT_KEYS, REPORT_LABELS } from "./types";

const demoDate = "2026-08-16";
const demoTimestamp = "2026-08-16T12:00:00.000Z";

const propertyA = {
  id: "demo-property-a",
  name: "Sample Grove",
  slug: "sample-grove",
  address: { line1: "100 Example Way", city: "Sampleton", state: "FL", postalCode: "00001" },
  propertyType: "multifamily",
  state: "active",
  operatingContact: "Demo Operations",
};

const propertyB = {
  id: "demo-property-b",
  name: "Cedar Test Homes",
  slug: "cedar-test-homes",
  address: { line1: "200 Example Way", city: "Sampleton", state: "FL", postalCode: "00002" },
  propertyType: "multifamily",
  state: "active",
  operatingContact: "Demo Operations",
};

const properties = [propertyA, propertyB];

const units = [
  { id: "demo-unit-a101", propertyId: propertyA.id, unitNumber: "A-101", unitType: "1/1", bedrooms: 1, bathrooms: 1, squareFeet: 650, marketRentCents: 125000, defaultDepositCents: 125000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-a102", propertyId: propertyA.id, unitNumber: "A-102", unitType: "2/1", bedrooms: 2, bathrooms: 1, squareFeet: 810, marketRentCents: 140000, defaultDepositCents: 140000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-a103", propertyId: propertyA.id, unitNumber: "A-103", unitType: "1/1", bedrooms: 1, bathrooms: 1, squareFeet: 650, marketRentCents: 135000, defaultDepositCents: 135000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-b201", propertyId: propertyB.id, unitNumber: "B-201", unitType: "1/1", bedrooms: 1, bathrooms: 1, squareFeet: 690, marketRentCents: 120000, defaultDepositCents: 120000, readiness: "ready", listing: "unlisted" },
  { id: "demo-unit-b202", propertyId: propertyB.id, unitNumber: "B-202", unitType: "2/1", bedrooms: 2, bathrooms: 1, squareFeet: 820, marketRentCents: 130000, defaultDepositCents: 130000, readiness: "not_ready", listing: "unlisted", accessNotes: "Make-ready work remains." },
  { id: "demo-unit-b203", propertyId: propertyB.id, unitNumber: "B-203", unitType: "2/2", bedrooms: 2, bathrooms: 2, squareFeet: 940, marketRentCents: 150000, defaultDepositCents: 150000, readiness: "ready", listing: "listed" },
  { id: "demo-unit-b204", propertyId: propertyB.id, unitNumber: "B-204", unitType: "studio", bedrooms: 0, bathrooms: 1, squareFeet: 520, marketRentCents: undefined, defaultDepositCents: 110000, readiness: "off_market", listing: "off_market", accessNotes: "Held off market for planned capital work." },
];

const people: AdminPersonView[] = [
  { id: "demo-person-a", firstName: "Sample", lastName: "Resident A", email: "resident-a@example.test", phone: "555-0101", renterInsuranceExpiresOn: "2027-01-31" },
  { id: "demo-person-b", firstName: "Sample", lastName: "Resident B", email: "resident-b@example.test", phone: "555-0102", renterInsuranceExpiresOn: "2026-09-30" },
  { id: "demo-person-c", firstName: "Sample", lastName: "Resident C", email: "resident-c@example.test", phone: "555-0103" },
  { id: "demo-person-d", firstName: "Sample", lastName: "Resident D", email: "resident-d@example.test", phone: "555-0104", renterInsuranceExpiresOn: "2026-12-31" },
];

const householdMemberships: AdminHouseholdMembershipView[] = [
  { id: "demo-household-a", tenancyId: "demo-tenancy-a", personId: "demo-person-a", role: "primary", isFinanciallyResponsible: true },
  { id: "demo-household-b", tenancyId: "demo-tenancy-b", personId: "demo-person-b", role: "primary", isFinanciallyResponsible: true },
  { id: "demo-household-c", tenancyId: "demo-tenancy-c", personId: "demo-person-c", role: "primary", isFinanciallyResponsible: true },
  { id: "demo-household-d", tenancyId: "demo-tenancy-d", personId: "demo-person-d", role: "primary", isFinanciallyResponsible: true },
];

const tenancies = [
  { id: "demo-tenancy-a", propertyId: propertyA.id, unitId: "demo-unit-a101", primaryPersonId: "demo-person-a", status: "current", actualMoveInOn: "2025-09-01", createdAt: demoTimestamp },
  { id: "demo-tenancy-b", propertyId: propertyA.id, unitId: "demo-unit-a102", primaryPersonId: "demo-person-b", status: "current", actualMoveInOn: "2025-04-01", createdAt: demoTimestamp },
  { id: "demo-tenancy-c", propertyId: propertyA.id, unitId: "demo-unit-a103", primaryPersonId: "demo-person-c", status: "future", createdAt: demoTimestamp, applicationId: "demo-application-c" },
  { id: "demo-tenancy-d", propertyId: propertyB.id, unitId: "demo-unit-b201", primaryPersonId: "demo-person-d", status: "current", actualMoveInOn: "2024-11-15", createdAt: demoTimestamp },
];

const leaseTerms = [
  { id: "demo-lease-a", tenancyId: "demo-tenancy-a", status: "executed", contractStartOn: "2025-09-01", contractEndOn: "2026-08-31", monthToMonth: false, signedOn: "2025-08-27", executedDocumentId: "demo-doc-lease-a", createdAt: demoTimestamp },
  { id: "demo-lease-b", tenancyId: "demo-tenancy-b", status: "executed", contractStartOn: "2025-04-01", contractEndOn: "2026-10-31", monthToMonth: false, signedOn: "2025-03-27", executedDocumentId: "demo-doc-lease-b", createdAt: demoTimestamp },
  { id: "demo-lease-c", tenancyId: "demo-tenancy-c", status: "draft", contractStartOn: "2026-09-01", contractEndOn: "2027-08-31", monthToMonth: false, createdAt: demoTimestamp },
  { id: "demo-lease-d", tenancyId: "demo-tenancy-d", status: "month_to_month", contractStartOn: "2024-11-15", monthToMonth: true, createdAt: demoTimestamp },
];

const recurringSchedules = [
  { id: "demo-schedule-a-rent", tenancyId: "demo-tenancy-a", propertyId: propertyA.id, unitId: "demo-unit-a101", category: "base_rent", description: "Base rent", amountCents: 125000, effectiveFrom: "2025-09-01", active: true, sourceConfidence: "confirmed" },
  { id: "demo-schedule-a-water", tenancyId: "demo-tenancy-a", propertyId: propertyA.id, unitId: "demo-unit-a101", category: "recurring_fee", description: "Utility reimbursement", amountCents: 7500, effectiveFrom: "2025-09-01", active: true, sourceConfidence: "confirmed" },
  { id: "demo-schedule-b-rent", tenancyId: "demo-tenancy-b", propertyId: propertyA.id, unitId: "demo-unit-a102", category: "base_rent", description: "Base rent", amountCents: 140000, effectiveFrom: "2025-04-01", active: true, sourceConfidence: "confirmed" },
  { id: "demo-schedule-b-hap", tenancyId: "demo-tenancy-b", propertyId: propertyA.id, unitId: "demo-unit-a102", category: "subsidy", description: "Agency HAP obligation", amountCents: 45000, effectiveFrom: "2026-01-01", active: true, sourceConfidence: "confirmed" },
  { id: "demo-schedule-c-rent", tenancyId: "demo-tenancy-c", propertyId: propertyA.id, unitId: "demo-unit-a103", category: "base_rent", description: "Base rent", amountCents: 135000, effectiveFrom: "2026-09-01", active: true, sourceConfidence: "confirmed" },
  { id: "demo-schedule-d-rent", tenancyId: "demo-tenancy-d", propertyId: propertyB.id, unitId: "demo-unit-b201", category: "base_rent", description: "Base rent", amountCents: 120000, effectiveFrom: "2024-11-15", active: true, sourceConfidence: "confirmed" },
];

/** Synthetic operational catalog for the local-only demo. It contains only
 * positive fields an administrator may select; no source keys or artifact
 * metadata are carried into the browser fixture. */
const chargeDefinitions: AdminChargeDefinitionView[] = [
  { id: "demo-charge-base-rent", displayName: "Base rent", displayNameKnowledge: "manual", category: "base_rent", categoryKnowledge: "manual", active: true, activeKnowledge: "manual", recordRevision: 1 },
  { id: "demo-charge-recurring-fee", displayName: "Recurring fee", displayNameKnowledge: "manual", category: "recurring_fee", categoryKnowledge: "manual", active: true, activeKnowledge: "manual", recordRevision: 1 },
  { id: "demo-charge-subsidy", displayName: "Housing assistance", displayNameKnowledge: "manual", category: "subsidy", categoryKnowledge: "manual", active: true, activeKnowledge: "manual", recordRevision: 1 },
];

const ledgerTransactions = [
  { id: "demo-ledger-a-charge", propertyId: propertyA.id, unitId: "demo-unit-a101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", kind: "charge", category: "base_rent", status: "posted", amountCents: 125000, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "August base rent", payer: "tenant" },
  { id: "demo-ledger-a-payment", propertyId: propertyA.id, unitId: "demo-unit-a101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", kind: "payment", category: "base_rent", status: "posted", amountCents: 125000, postedOn: "2026-08-02", paymentMethod: "ach", description: "August payment", payer: "tenant" },
  { id: "demo-ledger-b-charge", propertyId: propertyA.id, unitId: "demo-unit-a102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", kind: "charge", category: "base_rent", status: "posted", amountCents: 140000, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "August base rent", payer: "tenant" },
  { id: "demo-ledger-b-payment", propertyId: propertyA.id, unitId: "demo-unit-a102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", kind: "payment", category: "base_rent", status: "posted", amountCents: 121500, postedOn: "2026-08-05", paymentMethod: "check", description: "August tenant and agency payment", payer: "tenant" },
  { id: "demo-ledger-b-credit", propertyId: propertyA.id, unitId: "demo-unit-a102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", kind: "credit", category: "other", status: "posted", amountCents: 5000, postedOn: "2026-08-05", description: "Approved service credit", payer: "owner" },
  { id: "demo-ledger-d-charge", propertyId: propertyB.id, unitId: "demo-unit-b201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", kind: "charge", category: "base_rent", status: "posted", amountCents: 120000, postedOn: "2026-08-01", dueOn: "2026-08-01", description: "August base rent", payer: "tenant" },
  { id: "demo-ledger-d-payment", propertyId: propertyB.id, unitId: "demo-unit-b201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", kind: "payment", category: "base_rent", status: "posted", amountCents: 120000, postedOn: "2026-08-01", paymentMethod: "ach", description: "August payment", payer: "tenant" },
];

const paymentAllocations = [
  { id: "demo-allocation-a", paymentTransactionId: "demo-ledger-a-payment", chargeTransactionId: "demo-ledger-a-charge", amountCents: 125000, allocatedOn: "2026-08-02" },
  { id: "demo-allocation-b", paymentTransactionId: "demo-ledger-b-payment", chargeTransactionId: "demo-ledger-b-charge", amountCents: 121500, allocatedOn: "2026-08-05" },
  { id: "demo-allocation-d", paymentTransactionId: "demo-ledger-d-payment", chargeTransactionId: "demo-ledger-d-charge", amountCents: 120000, allocatedOn: "2026-08-01" },
];

const securityDeposits = [
  { id: "demo-deposit-a", propertyId: propertyA.id, unitId: "demo-unit-a101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", type: "security", amountHeldCents: 125000, receivedOn: "2025-08-28", dispositionStatus: "held" },
  { id: "demo-deposit-b", propertyId: propertyA.id, unitId: "demo-unit-a102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", type: "security", amountHeldCents: 140000, receivedOn: "2025-03-28", dispositionStatus: "held" },
  { id: "demo-deposit-d", propertyId: propertyB.id, unitId: "demo-unit-b201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", type: "security", amountHeldCents: 120000, receivedOn: "2024-11-14", dispositionStatus: "held" },
];

const subsidyContracts = [
  { id: "demo-subsidy-b", propertyId: propertyA.id, unitId: "demo-unit-a102", tenancyId: "demo-tenancy-b", agencyName: "Sample Housing Agency", contractNumber: "DEMO-HAP-001", effectiveFrom: "2026-01-01", agencyObligationCents: 45000, tenantObligationCents: 95000, status: "active" },
];

const documents: AdminDocumentView[] = [
  { id: "demo-doc-lease-a", propertyId: propertyA.id, unitId: "demo-unit-a101", personId: "demo-person-a", tenancyId: "demo-tenancy-a", type: "lease", state: "executed", fileName: "sample-resident-a-lease.pdf", mimeType: "application/pdf", sizeBytes: 20124, uploadedAt: "2025-08-27T14:00:00.000Z", verifiedAt: "2025-08-27T14:00:00.000Z", downloadAvailable: false },
  { id: "demo-doc-lease-b", propertyId: propertyA.id, unitId: "demo-unit-a102", personId: "demo-person-b", tenancyId: "demo-tenancy-b", type: "lease", state: "executed", fileName: "sample-resident-b-lease.pdf", mimeType: "application/pdf", sizeBytes: 19888, uploadedAt: "2025-03-27T14:00:00.000Z", verifiedAt: "2025-03-27T14:00:00.000Z", downloadAvailable: false },
  { id: "demo-doc-insurance-b", propertyId: propertyA.id, personId: "demo-person-b", type: "insurance", state: "current", fileName: "sample-resident-b-insurance.pdf", mimeType: "application/pdf", sizeBytes: 12000, uploadedAt: "2026-01-10T14:00:00.000Z", downloadAvailable: false },
  { id: "demo-doc-hap-b", propertyId: propertyA.id, unitId: "demo-unit-a102", personId: "demo-person-b", tenancyId: "demo-tenancy-b", type: "housing_assistance", state: "filed", fileName: "sample-hap-contract.pdf", mimeType: "application/pdf", sizeBytes: 14000, uploadedAt: "2026-01-03T14:00:00.000Z", downloadAvailable: false },
];

const activityEvents = [
  { id: "demo-activity-a-note", propertyId: propertyA.id, unitId: "demo-unit-a101", personId: "demo-person-a", tenancyId: "demo-tenancy-a", type: "note", occurredAt: "2026-08-10T14:00:00.000Z", actor: "Demo Operations", summary: "Insurance expiration reviewed", detail: "Renewal reminder set for the next operating review." },
  { id: "demo-activity-b-hold", propertyId: propertyA.id, unitId: "demo-unit-a102", personId: "demo-person-b", tenancyId: "demo-tenancy-b", type: "hold", occurredAt: "2026-08-06T15:00:00.000Z", actor: "Demo Operations", summary: "Payment allocation exception noted", detail: "Confirm agency and tenant portions before posting the next receipt." },
  { id: "demo-activity-d-call", propertyId: propertyB.id, unitId: "demo-unit-b201", personId: "demo-person-d", tenancyId: "demo-tenancy-d", type: "call", occurredAt: "2026-08-01T16:30:00.000Z", actor: "Demo Operations", summary: "Renewal conversation logged" },
];

const applications: AdminApplicationView[] = [
  { id: "demo-application-a", sourceType: "public_portal", status: "under_review", email: "applicant-a@example.test", firstName: "Sample", lastName: "Applicant A", phone: "555-0201", propertyId: propertyA.id, unitId: "demo-unit-a103", submittedOn: "2026-08-12", certificationAcceptedOn: "2026-08-12", createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-12T12:00:00.000Z", householdSummary: { adults: 1, children: 0, totalOccupants: 1 }, employment: { employerName: "Sample Employer", jobTitle: "Coordinator", monthlyIncomeCents: 380000 } },
  { id: "demo-application-b", sourceType: "manual", status: "missing_information", email: "applicant-b@example.test", firstName: "Sample", lastName: "Applicant B", phone: "555-0202", propertyId: propertyB.id, unitId: "demo-unit-b203", submittedOn: "2026-08-08", createdAt: "2026-08-08T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z" },
  { id: "demo-application-c", sourceType: "public_portal", status: "converted", email: "applicant-c@example.test", firstName: "Sample", lastName: "Applicant C", phone: "555-0203", propertyId: propertyA.id, unitId: "demo-unit-a103", submittedOn: "2026-07-25", certificationAcceptedOn: "2026-07-25", convertedTenancyId: "demo-tenancy-c", createdAt: "2026-07-23T12:00:00.000Z", updatedAt: "2026-07-26T12:00:00.000Z" },
];

const applicationRequirements = [
  { id: "demo-requirement-b-income", applicationId: "demo-application-b", key: "income-proof", label: "Income verification", status: "requested", requestedOn: "2026-08-08" },
  { id: "demo-requirement-a-id", applicationId: "demo-application-a", key: "identity", label: "Identity document", status: "received", requestedOn: "2026-08-10", resolvedOn: "2026-08-11" },
];

const applicationHouseholdMembers: AdminApplicationHouseholdMemberView[] = [];

export function createDemoAdminSnapshotView(): AdminSnapshotView {
  return {
    properties,
    units,
    people: people.map(({ archived, ...person }) => ({ ...person, ...(archived == null ? {} : { archived }) })),
    householdMemberships: householdMemberships.map(({ role, relationship, isFinanciallyResponsible, ...membership }) => ({ ...membership, ...(role == null ? {} : { role }), ...(relationship == null ? {} : { relationship }), ...(isFinanciallyResponsible == null ? {} : { isFinanciallyResponsible }) })),
    tenancies,
    leaseTerms,
    recurringSchedules,
    ledgerTransactions,
    paymentAllocations,
    securityDeposits,
    subsidyContracts,
    applications,
    applicationHouseholdMembers,
    applicationRequirements,
    documents,
    activityEvents,
  };
}

export const DEMO_AS_OF_DATE = demoDate;
export const DEMO_GENERATED_AT = demoTimestamp;

/*
 * Demo views are intentionally written as server-shaped, precomputed rows.
 * They are not generated from source fixtures in the browser. This keeps the
 * development switch useful without creating a second financial engine.
 */
const demoRentRoll = [
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", bedrooms: 1, bathrooms: 1, marketRentCents: 125000, readiness: "ready", listing: "listed", occupancy: "current", currentPersonId: "demo-person-a", currentTenantName: "Sample Resident A", tenancyId: "demo-tenancy-a", actualMoveInOn: "2025-09-01", contractStartOn: "2025-09-01", contractEndOn: "2026-08-31", monthToMonth: false, baseRentCents: 125000, recurringFeesCents: 7500, totalScheduledCents: 132500, balanceDueCents: 0, exceptionCodes: [] },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", bedrooms: 2, bathrooms: 1, marketRentCents: 140000, readiness: "ready", listing: "listed", occupancy: "current", currentPersonId: "demo-person-b", currentTenantName: "Sample Resident B", tenancyId: "demo-tenancy-b", actualMoveInOn: "2025-04-01", contractStartOn: "2025-04-01", contractEndOn: "2026-10-31", monthToMonth: false, baseRentCents: 140000, recurringFeesCents: 0, totalScheduledCents: 140000, balanceDueCents: 13500, oldestUnpaidRentOn: "2026-08-01", exceptionCodes: ["balance_due"] },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a103", unitNumber: "A-103", bedrooms: 1, bathrooms: 1, marketRentCents: 135000, readiness: "ready", listing: "listed", occupancy: "future_preleased", futurePersonId: "demo-person-c", futureTenantName: "Sample Resident C", tenancyId: "demo-tenancy-c", contractStartOn: "2026-09-01", contractEndOn: "2027-08-31", monthToMonth: false, baseRentCents: 135000, recurringFeesCents: 0, totalScheduledCents: 135000, balanceDueCents: 0, exceptionCodes: [] },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b201", unitNumber: "B-201", bedrooms: 1, bathrooms: 1, marketRentCents: 120000, readiness: "ready", listing: "unlisted", occupancy: "current", currentPersonId: "demo-person-d", currentTenantName: "Sample Resident D", tenancyId: "demo-tenancy-d", actualMoveInOn: "2024-11-15", contractStartOn: "2024-11-15", monthToMonth: true, baseRentCents: 120000, recurringFeesCents: 0, totalScheduledCents: 120000, balanceDueCents: 0, exceptionCodes: ["month_to_month"] },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b202", unitNumber: "B-202", bedrooms: 2, bathrooms: 1, marketRentCents: 130000, readiness: "not_ready", listing: "unlisted", occupancy: "vacant", baseRentCents: undefined, recurringFeesCents: 0, totalScheduledCents: 0, balanceDueCents: 0, exceptionCodes: ["not_ready"] },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b203", unitNumber: "B-203", bedrooms: 2, bathrooms: 2, marketRentCents: 150000, readiness: "ready", listing: "listed", occupancy: "vacant", baseRentCents: undefined, recurringFeesCents: 0, totalScheduledCents: 0, balanceDueCents: 0, exceptionCodes: ["vacant_ready"] },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b204", unitNumber: "B-204", bedrooms: 0, bathrooms: 1, readiness: "off_market", listing: "off_market", occupancy: "vacant", baseRentCents: undefined, recurringFeesCents: 0, totalScheduledCents: 0, balanceDueCents: 0, exceptionCodes: ["off_market"] },
] as AdminSnapshot["rentRoll"];

const demoOccupancy = [
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", occupancy: "current", readiness: "ready", listing: "listed", tenancyId: "demo-tenancy-a" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", occupancy: "current", readiness: "ready", listing: "listed", tenancyId: "demo-tenancy-b" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a103", unitNumber: "A-103", occupancy: "future_preleased", readiness: "ready", listing: "listed", tenancyId: "demo-tenancy-c" },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b201", unitNumber: "B-201", occupancy: "current", readiness: "ready", listing: "unlisted", tenancyId: "demo-tenancy-d" },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b202", unitNumber: "B-202", occupancy: "vacant", readiness: "not_ready", listing: "unlisted", daysVacant: 22 },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b203", unitNumber: "B-203", occupancy: "vacant", readiness: "ready", listing: "listed", daysVacant: 14 },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b204", unitNumber: "B-204", occupancy: "vacant", readiness: "off_market", listing: "off_market", daysVacant: 88 },
] as AdminSnapshot["occupancy"];

const demoScheduledIncome = [
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", tenantName: "Sample Resident A", month: "2026-08", category: "base_rent", description: "Base rent", amountCents: 125000, scheduleId: "demo-schedule-a-rent" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", tenantName: "Sample Resident A", month: "2026-08", category: "recurring_fee", description: "Utility reimbursement", amountCents: 7500, scheduleId: "demo-schedule-a-water" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", tenantName: "Sample Resident B", month: "2026-08", category: "base_rent", description: "Base rent", amountCents: 140000, scheduleId: "demo-schedule-b-rent" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", tenantName: "Sample Resident B", month: "2026-08", category: "subsidy", description: "Agency HAP obligation", amountCents: 45000, scheduleId: "demo-schedule-b-hap" },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b201", unitNumber: "B-201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", tenantName: "Sample Resident D", month: "2026-08", category: "base_rent", description: "Base rent", amountCents: 120000, scheduleId: "demo-schedule-d-rent" },
] as AdminSnapshot["scheduledIncome"];

const demoCollectedIncome = [
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", tenantName: "Sample Resident A", paymentTransactionId: "demo-ledger-a-payment", chargeTransactionId: "demo-ledger-a-charge", paymentOn: "2026-08-02", category: "base_rent", amountCents: 125000, description: "August base rent" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", tenantName: "Sample Resident B", paymentTransactionId: "demo-ledger-b-payment", chargeTransactionId: "demo-ledger-b-charge", paymentOn: "2026-08-05", category: "base_rent", amountCents: 121500, description: "August base rent" },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b201", unitNumber: "B-201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", tenantName: "Sample Resident D", paymentTransactionId: "demo-ledger-d-payment", chargeTransactionId: "demo-ledger-d-charge", paymentOn: "2026-08-01", category: "base_rent", amountCents: 120000, description: "August base rent" },
] as AdminSnapshot["collectedIncome"];

const demoScheduledVsCollected = [
  { propertyId: propertyA.id, propertyName: propertyA.name, month: "2026-08", scheduledCents: 317500, collectedCents: 246500, varianceCents: -71000 },
  { propertyId: propertyB.id, propertyName: propertyB.name, month: "2026-08", scheduledCents: 120000, collectedCents: 120000, varianceCents: 0 },
] as AdminSnapshot["scheduledVsCollected"];

const demoDelinquency = [
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", tenantName: "Sample Resident A", rentOnlyBalanceCents: 0, nonRentBalanceCents: 0, totalBalanceCents: 0, unappliedCashCents: 0, prepaidCents: 0, lastPaymentOn: "2026-08-02", hasPromiseOrHold: false },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", tenantName: "Sample Resident B", rentOnlyBalanceCents: 18500, nonRentBalanceCents: 0, totalBalanceCents: 18500, unappliedCashCents: 0, prepaidCents: 0, oldestUnpaidRentOn: "2026-08-01", lastPaymentOn: "2026-08-05", hasPromiseOrHold: true },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b201", unitNumber: "B-201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", tenantName: "Sample Resident D", rentOnlyBalanceCents: 0, nonRentBalanceCents: 0, totalBalanceCents: 0, unappliedCashCents: 0, prepaidCents: 0, lastPaymentOn: "2026-08-01", hasPromiseOrHold: false },
] as AdminSnapshot["delinquency"];

const demoLedger = [
  { transaction: ledgerTransactions[0], allocatedCents: 125000, openCents: 0, runningBalanceCents: 125000 },
  { transaction: ledgerTransactions[1], allocatedCents: 125000, openCents: 0, runningBalanceCents: 0 },
  { transaction: ledgerTransactions[2], allocatedCents: 121500, openCents: 18500, runningBalanceCents: 140000 },
  { transaction: ledgerTransactions[3], allocatedCents: 121500, openCents: 0, runningBalanceCents: 18500 },
  { transaction: ledgerTransactions[4], allocatedCents: 0, openCents: 0, runningBalanceCents: 13500 },
  { transaction: ledgerTransactions[5], allocatedCents: 120000, openCents: 0, runningBalanceCents: 120000 },
  { transaction: ledgerTransactions[6], allocatedCents: 120000, openCents: 0, runningBalanceCents: 0 },
] as AdminSnapshot["ledger"];

const demoLeaseExpiration = [
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", tenantName: "Sample Resident A", contractEndOn: "2026-08-31", monthToMonth: false, currentBaseRentCents: 125000, noticeDeadlineOn: "2026-07-02", actionStatus: "expiring" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", tenantName: "Sample Resident B", contractEndOn: "2026-10-31", monthToMonth: false, currentBaseRentCents: 140000, noticeDeadlineOn: "2026-09-01", actionStatus: "not_due" },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b201", unitNumber: "B-201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", tenantName: "Sample Resident D", monthToMonth: true, currentBaseRentCents: 120000, actionStatus: "month_to_month" },
] as AdminSnapshot["leaseExpiration"];

const demoDepositLiability = [
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a101", unitNumber: "A-101", tenancyId: "demo-tenancy-a", personId: "demo-person-a", tenantName: "Sample Resident A", securityHeldCents: 125000, refundablePetHeldCents: 0, otherRefundableHeldCents: 0, totalHeldCents: 125000, dispositionStatus: "held" },
  { propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", tenancyId: "demo-tenancy-b", personId: "demo-person-b", tenantName: "Sample Resident B", securityHeldCents: 140000, refundablePetHeldCents: 0, otherRefundableHeldCents: 0, totalHeldCents: 140000, dispositionStatus: "held" },
  { propertyId: propertyB.id, propertyName: propertyB.name, unitId: "demo-unit-b201", unitNumber: "B-201", tenancyId: "demo-tenancy-d", personId: "demo-person-d", tenantName: "Sample Resident D", securityHeldCents: 120000, refundablePetHeldCents: 0, otherRefundableHeldCents: 0, totalHeldCents: 120000, dispositionStatus: "held" },
] as AdminSnapshot["depositLiability"];

const demoHap = [{ propertyId: propertyA.id, propertyName: propertyA.name, unitId: "demo-unit-a102", unitNumber: "A-102", tenancyId: "demo-tenancy-b", tenantName: "Sample Resident B", agencyName: "Sample Housing Agency", month: "2026-08", agencyObligationCents: 45000, tenantObligationCents: 95000, expectedTotalCents: 140000, receivedAgencyCents: 45000, varianceCents: 0, exception: false }] as AdminSnapshot["hap"];

const demoTenantViews: TenantView[] = [
  { person: people[0], household: [householdMemberships[0]], tenancy: tenancies[0], tenancies: [tenancies[0]], leaseTerms: [leaseTerms[0]], schedules: recurringSchedules.filter((schedule) => schedule.tenancyId === tenancies[0].id), ledger: demoLedger.slice(0, 2), deposits: [securityDeposits[0]], subsidyContracts: [], documents: documents.filter((document) => document.personId === people[0].id), activity: activityEvents.filter((event) => event.personId === people[0].id), property: propertyA, unit: units[0], primaryLease: leaseTerms[0] },
  { person: people[1], household: [householdMemberships[1]], tenancy: tenancies[1], tenancies: [tenancies[1]], leaseTerms: [leaseTerms[1]], schedules: recurringSchedules.filter((schedule) => schedule.tenancyId === tenancies[1].id), ledger: demoLedger.slice(2, 5), deposits: [securityDeposits[1]], subsidyContracts: [subsidyContracts[0]], documents: documents.filter((document) => document.personId === people[1].id), activity: activityEvents.filter((event) => event.personId === people[1].id), property: propertyA, unit: units[1], primaryLease: leaseTerms[1] },
  { person: people[2], household: [householdMemberships[2]], tenancy: tenancies[2], tenancies: [tenancies[2]], leaseTerms: [leaseTerms[2]], schedules: recurringSchedules.filter((schedule) => schedule.tenancyId === tenancies[2].id), ledger: [], deposits: [], subsidyContracts: [], documents: [], activity: [], property: propertyA, unit: units[2], primaryLease: leaseTerms[2] },
  { person: people[3], household: [householdMemberships[3]], tenancy: tenancies[3], tenancies: [tenancies[3]], leaseTerms: [leaseTerms[3]], schedules: recurringSchedules.filter((schedule) => schedule.tenancyId === tenancies[3].id), ledger: demoLedger.slice(5), deposits: [securityDeposits[2]], subsidyContracts: [], documents: [], activity: activityEvents.filter((event) => event.personId === people[3].id), property: propertyB, unit: units[3], primaryLease: leaseTerms[3] },
];

const demoReportColumns: Record<ReportKey, ReportColumn[]> = {
  "rent-roll": [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "occupancy", label: "Occupancy", format: "status" }, { key: "readiness", label: "Readiness", format: "status" }, { key: "listing", label: "Listing", format: "status" }, { key: "currentTenantName", label: "Tenant" }, { key: "contractEndOn", label: "Contract end", format: "date" }, { key: "baseRentCents", label: "Base rent", format: "currency", align: "right" }, { key: "balanceDueCents", label: "Balance", format: "currency", align: "right" }],
  occupancy: [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "occupancy", label: "Occupancy", format: "status" }, { key: "readiness", label: "Readiness", format: "status" }, { key: "listing", label: "Listing", format: "status" }, { key: "daysVacant", label: "Days vacant", format: "integer", align: "right" }],
  "scheduled-income": [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "tenantName", label: "Tenant" }, { key: "month", label: "Month" }, { key: "category", label: "Category", format: "status" }, { key: "description", label: "Description" }, { key: "amountCents", label: "Amount", format: "currency", align: "right" }],
  "collected-income": [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "tenantName", label: "Tenant" }, { key: "paymentOn", label: "Payment date", format: "date" }, { key: "category", label: "Category", format: "status" }, { key: "amountCents", label: "Allocated", format: "currency", align: "right" }],
  "scheduled-vs-collected": [{ key: "propertyName", label: "Property" }, { key: "month", label: "Month" }, { key: "scheduledCents", label: "Scheduled", format: "currency", align: "right" }, { key: "collectedCents", label: "Collected", format: "currency", align: "right" }, { key: "varianceCents", label: "Variance", format: "currency", align: "right" }],
  delinquency: [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "tenantName", label: "Tenant" }, { key: "rentOnlyBalanceCents", label: "Rent only", format: "currency", align: "right" }, { key: "nonRentBalanceCents", label: "Non-rent", format: "currency", align: "right" }, { key: "totalBalanceCents", label: "Total", format: "currency", align: "right" }, { key: "oldestUnpaidRentOn", label: "Oldest rent", format: "date" }],
  "tenant-ledger": [{ key: "postedOn", label: "Posted", format: "date" }, { key: "kind", label: "Type", format: "status" }, { key: "category", label: "Category", format: "status" }, { key: "description", label: "Description" }, { key: "amountCents", label: "Amount", format: "currency", align: "right" }, { key: "allocatedCents", label: "Allocated", format: "currency", align: "right" }, { key: "openCents", label: "Open", format: "currency", align: "right" }],
  "lease-expiration": [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "tenantName", label: "Tenant" }, { key: "contractEndOn", label: "Contract end", format: "date" }, { key: "monthToMonth", label: "M2M" }, { key: "currentBaseRentCents", label: "Current rent", format: "currency", align: "right" }, { key: "actionStatus", label: "Action", format: "status" }],
  "security-deposit": [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "tenantName", label: "Tenant" }, { key: "securityHeldCents", label: "Security", format: "currency", align: "right" }, { key: "totalHeldCents", label: "Total held", format: "currency", align: "right" }, { key: "dispositionStatus", label: "Disposition", format: "status" }],
  "applicant-pipeline": [{ key: "displayName", label: "Applicant" }, { key: "status", label: "Status", format: "status" }, { key: "submittedOn", label: "Submitted", format: "date" }, { key: "propertyName", label: "Property" }, { key: "unitInterest", label: "Unit" }, { key: "missingItems", label: "Missing items" }],
  hap: [{ key: "propertyName", label: "Property" }, { key: "unitNumber", label: "Unit" }, { key: "tenantName", label: "Tenant" }, { key: "agencyName", label: "Agency" }, { key: "agencyObligationCents", label: "Agency due", format: "currency", align: "right" }, { key: "receivedAgencyCents", label: "Received", format: "currency", align: "right" }, { key: "exception", label: "Exception", format: "status" }],
};

const demoReportRows: Record<ReportKey, ReportRow[]> = {
  "rent-roll": demoRentRoll.map((row) => ({ id: String(row.unitId), ...row, currentTenantName: String(row.currentTenantName ?? row.futureTenantName ?? "—") })),
  occupancy: demoOccupancy.map((row) => ({ id: String(row.unitId), ...row })),
  "scheduled-income": demoScheduledIncome.map((row) => ({ id: String(row.scheduleId), ...row })),
  "collected-income": demoCollectedIncome.map((row) => ({ id: `${String(row.paymentTransactionId)}:${String(row.chargeTransactionId)}`, ...row })),
  "scheduled-vs-collected": demoScheduledVsCollected.map((row) => ({ id: String(row.propertyId), ...row })),
  delinquency: demoDelinquency.map((row) => ({ id: String(row.tenancyId), ...row })),
  "tenant-ledger": demoLedger.map((row) => ({ id: String(row.transaction.id), postedOn: row.transaction.postedOn, kind: row.transaction.kind, category: row.transaction.category, description: row.transaction.description, amountCents: row.transaction.amountCents, allocatedCents: row.allocatedCents, openCents: row.openCents, tenant: row.transaction.personId })),
  "lease-expiration": demoLeaseExpiration.map((row) => ({ id: String(row.tenancyId), ...row })),
  "security-deposit": demoDepositLiability.map((row) => ({ id: String(row.tenancyId ?? `${row.personId}:${row.propertyId}:${row.unitId ?? "no-unit"}`), ...row })),
  "applicant-pipeline": applications.map((application) => ({ id: String(application.id), displayName: `${String(application.firstName)} ${String(application.lastName)}`, status: application.status, submittedOn: application.submittedOn, propertyName: application.propertyId === propertyA.id ? propertyA.name : propertyB.name, unitInterest: application.unitId === "demo-unit-a103" ? "A-103" : "B-203", missingItems: application.id === "demo-application-b" ? "Income verification" : "—" })),
  hap: demoHap.map((row) => ({ id: String(row.tenancyId), ...row })),
};

const demoReportDescriptions: Record<ReportKey, string> = {
  "rent-roll": "One physical-unit row; current, future/preleased, genuine vacancy, readiness, listing, and off-market are separate.",
  occupancy: "Physical occupancy and vacancy context without collapsing readiness or listing state.",
  "scheduled-income": "Effective recurring schedules for the selected month.",
  "collected-income": "Allocated collections only; deposits and unapplied cash are excluded.",
  "scheduled-vs-collected": "Operating comparison, not spendable bank cash.",
  delinquency: "Rent-only and total balance remain separate.",
  "tenant-ledger": "Append-only ledger with allocation and open-balance context.",
  "lease-expiration": "Contractual term end, not physical move-out.",
  "security-deposit": "Liability report, not a bank-deposit batch.",
  "applicant-pipeline": "Manual review only; no automated scoring or decisions.",
  hap: "Agency and tenant obligations remain separate.",
};

function demoReport(key: ReportKey): ReportDefinition {
  return { key, label: REPORT_LABELS[key], description: demoReportDescriptions[key], sourceNote: "Synthetic precomputed view fixture.", columns: demoReportColumns[key], rows: demoReportRows[key] };
}

export function createDemoAdminSnapshot(): AdminSnapshot {
  const summary: AdminSnapshot["summary"] = {
    asOfDate: DEMO_AS_OF_DATE,
    propertyCount: 2,
    unitCount: 7,
    occupiedUnits: 3,
    futurePreleasedUnits: 1,
    genuineVacantUnits: 3,
    readyVacantUnits: 1,
    notReadyUnits: 1,
    offMarketUnits: 1,
    physicalOccupancyPercent: 0.429,
    scheduledRentCents: 437500,
    collectedRentCents: 366500,
    rentOnlyDelinquencyCents: 18500,
    totalDelinquencyCents: 18500,
    unappliedCashCents: 0,
    expiringIn30Days: 1,
    expiringIn60Days: 1,
    expiringIn90Days: 1,
    monthToMonthCount: 1,
    applicationsSubmitted: 2,
    applicationsMissingInformation: 1,
    securityDepositLiabilityCents: 385000,
    drilldowns: {
      occupiedUnits: { report: "occupancy", filters: { occupancy: ["current"] } },
      futurePreleasedUnits: { report: "rent-roll", filters: { occupancy: ["future_preleased"] } },
      genuineVacantUnits: { report: "occupancy", filters: { occupancy: ["vacant"] } },
      rentOnlyDelinquencyCents: { report: "delinquency", filters: { balanceStatus: "due" } },
      securityDepositLiabilityCents: { report: "security-deposit", filters: {} },
    },
  };
  const reports = Object.fromEntries(REPORT_KEYS.map((key) => [key, demoReport(key)])) as Record<ReportKey, ReportDefinition>;
  return {
    generatedAt: DEMO_GENERATED_AT,
    snapshot: createDemoAdminSnapshotView(),
    summary,
    rentRoll: demoRentRoll,
    occupancy: demoOccupancy,
    scheduledIncome: demoScheduledIncome,
    collectedIncome: demoCollectedIncome,
    scheduledVsCollected: demoScheduledVsCollected,
    delinquency: demoDelinquency,
    ledger: demoLedger,
    leaseExpiration: demoLeaseExpiration,
    depositLiability: demoDepositLiability,
    hap: demoHap,
    tenants: demoTenantViews,
    applicants: applications,
    documents,
    activities: activityEvents,
    reports,
    chargeDefinitions,
  };
}
