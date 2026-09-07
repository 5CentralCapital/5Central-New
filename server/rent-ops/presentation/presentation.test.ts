import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardSummary, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import {
  assertNoForbiddenKeys,
  isOpaqueTargetId,
  serializeAdminApplication,
  serializeAdminApplicationRequirement,
  serializeAdminChargeDefinition,
  serializeAdminDocument,
  serializeAdminHouseholdMembership,
  serializeAdminPerson,
  serializeAdminProperty,
  serializeAdminRecurringSchedule,
  serializeAdminSnapshot,
  serializeAdminTenantProfile,
  serializeAdminTenancy,
  serializeCsvRows,
  serializeError,
  serializePublicApplication,
  serializePublicListings,
  serializeReportEnvelope,
  serializeReportRows,
  serializeAdminDashboard,
  serializeAdminApplicationHistoryCase,
} from "./index";

const evil = {
  source: { sourceId: "provider-id", sourceSystem: "rm", sourceUpdatedAt: "2026-08-17T00:00:00.000Z" },
  sourceId: "provider-id",
  sourceSystem: "rm",
  sourceUpdatedAt: "2026-08-17T00:00:00.000Z",
  importRuns: [{ manifest: "secret", checkpoint: "secret", resume: "secret" }],
  token: "secret-token",
  hash: "secret-hash",
  digest: "secret-digest",
  raw: { restricted: { payload: "secret" } },
  storageKey: "private/path",
  storageKeyKnowledge: "source",
  checksum: "secret-checksum",
  backend: "private-store",
  bucket: "private-bucket",
  key: "private-key",
  generation: "1",
  version: "1",
  signedUrl: "https://private.example.test/signed",
};

function exactKeys(value: unknown, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value as object).sort(), [...expected].sort());
}

function baseSnapshot(): RentOpsSnapshot {
  return {
    properties: [],
    units: [],
    people: [],
    householdMemberships: [],
    tenancies: [],
    leaseTerms: [],
    recurringSchedules: [],
    ledgerTransactions: [],
    paymentAllocations: [],
    securityDeposits: [],
    subsidyContracts: [],
    applications: [],
    applicationHouseholdMembers: [],
    applicationRequirements: [],
    documents: [],
    activityEvents: [],
    sourceRecords: [evil as never],
    importRuns: [evil as never],
  } as RentOpsSnapshot;
}

test("admin entity serializers use exact positive allowlists at nested depth", () => {
  const property = serializeAdminProperty({
    ...evil,
    id: "property:1",
    name: "Example",
    slug: "example",
    address: { line1: "1 Main St", line2: "Unit 1", city: "Tampa", state: "FL", postalCode: "33601", ...evil },
    propertyType: "multifamily",
    state: "active",
    operatingContact: "ops@example.test",
  } as never);
  exactKeys(property, ["id", "name", "slug", "address", "propertyType", "state", "operatingContact"]);
  exactKeys(property.address, ["line1", "line2", "city", "state", "postalCode"]);
  assertNoForbiddenKeys(property);

  const schedule = serializeAdminRecurringSchedule({
    ...evil,
    id: "schedule:1",
    propertyId: "property:1",
    category: "recurring_fee",
    description: "Trash",
    amountCents: 1200,
    active: true,
    scopeType: "property",
    scopeId: "property:1",
    chargeDefinitionId: "rm-charge-id",
    chargeDefinitionKey: "rm-charge-key",
  } as never);
  exactKeys(schedule, ["id", "scopeType", "scopeId", "propertyId", "category", "description", "amountCents", "active"]);
  assertNoForbiddenKeys(schedule);

  const document = serializeAdminDocument({
    ...evil,
    id: "document:1",
    propertyId: "property:1",
    type: "lease",
    state: "verified",
    fileName: "lease.pdf",
    mimeType: "application/pdf",
    sizeBytes: 42,
    uploadedAt: "2026-08-17T00:00:00.000Z",
    verifiedAt: "2026-08-17T00:01:00.000Z",
    availability: "verified",
    storageKeyKnowledge: "source",
    checksumSha256: "a".repeat(64),
  } as never);
  exactKeys(document, ["id", "propertyId", "type", "state", "fileName", "mimeType", "sizeBytes", "uploadedAt", "verifiedAt", "availability", "downloadAvailable"]);
  assert.equal(document.downloadAvailable, true);
  assert.equal("storageKeyKnowledge" in document, false);
  assertNoForbiddenKeys(document);

  const uncertainDocument = serializeAdminDocument({
    id: "document:uncertain",
    type: "lease",
    state: "verified",
    fileName: "lease.pdf",
    mimeType: "application/pdf",
    storageKey: "private/path",
    checksumSha256: "a".repeat(64),
    uploadedAt: "2026-08-17T00:00:00.000Z",
    verifiedAt: "2026-08-17T00:01:00.000Z",
    storageKeyKnowledge: "ambiguous",
  } as never);
  assert.equal(uncertainDocument.downloadAvailable, false);
  assert.equal("storageKeyKnowledge" in uncertainDocument, false);
  assertNoForbiddenKeys(uncertainDocument);
});

test("historical application serializer admits only safe metadata and markers", () => {
  const serialized = serializeAdminApplicationHistoryCase({
    application: { ...evil, id: "demo-application-1", firstName: "Historical", status: "submitted", statusKnowledge: "source", submittedOn: "2026-08-10", submittedOnKnowledge: "source" },
    prospect: { ...evil, id: "history-prospect-1", firstName: "Historical", status: "active", statusKnowledge: "source" },
    interests: [{ ...evil, propertyId: "property:one", unitId: "unit:one", sourceOrder: 1, sourceRank: 1, preference: "first choice", preferenceKnowledge: "source", rentCents: 125000, rentKnowledge: "known", bedrooms: 2, bedroomsKnowledge: "source", status: "submitted", statusKnowledge: "source" }],
    participants: [{ ...evil, sourceOrder: 1, role: "applicant", roleKnowledge: "source", relationship: "self", relationshipKnowledge: "source", isMinor: false, minorKnowledge: "source", isFinanciallyResponsible: true, financialResponsibilityKnowledge: "source", personId: "person:secret" }],
    requirements: [{ ...evil, label: "Identity", status: "requested", statusKnowledge: "source", requestedOn: "2026-08-10", requestedOnKnowledge: "source", documentId: "document:secret", documentLinkKnowledge: "exact" }],
    answers: [{ ...evil, fieldId: "field:secret", value: "RAW_ANSWER_CANARY", valueType: "text", valueKnowledge: "restricted", fieldLinkKnowledge: "exact" }],
    documents: [{ ...evil, type: "identity", typeKnowledge: "source", state: "received", stateKnowledge: "source", fileName: "identity.pdf", mimeType: "application/pdf", metadataSizeBytes: 42, metadataChecksumSha256: "a".repeat(64), availability: "verified" }],
    activities: [{ ...evil, type: "email", occurredAt: "2026-08-10T12:00:00.000Z", occurredAtKnowledge: "source", actor: "secret actor", actorKnowledge: "source", summary: "Safe summary", summaryKnowledge: "source", detail: "RAW_DETAIL_CANARY", body: "RAW_BODY_CANARY" }],
    blockers: [{ ...evil, code: "application_answers_missing", occurrenceCount: 1, reason: "source_rows_unusable", applicationId: "demo-application-1", prospectId: "history-prospect-1" }],
    unknownRestricted: { restrictedAnswerCount: 1, unmappedAnswerCount: 0, missingAnswerApplications: 1, metadataOnlyDocumentCount: 1, unavailableDocumentCount: 0, unlinkedActivityCount: 0, unlinkedInterestCount: 0 },
  } as never);

  assertNoForbiddenKeys(serialized);
  exactKeys(serialized, ["application", "prospect", "interests", "participants", "requirements", "answers", "documents", "activities", "blockers", "unknownRestricted"]);
  exactKeys(serialized.application, ["id", "firstName", "status", "statusKnowledge", "submittedOn", "submittedOnKnowledge"]);
  exactKeys(serialized.interests[0], ["propertyId", "unitId", "sourceOrder", "sourceRank", "preference", "preferenceKnowledge", "rentCents", "rentKnowledge", "bedrooms", "bedroomsKnowledge", "status", "statusKnowledge"]);
  exactKeys(serialized.participants[0], ["sourceOrder", "role", "roleKnowledge", "relationship", "relationshipKnowledge", "isMinor", "minorKnowledge", "isFinanciallyResponsible", "financialResponsibilityKnowledge"]);
  exactKeys(serialized.requirements[0], ["label", "status", "statusKnowledge", "requestedOn", "requestedOnKnowledge", "hasDocument"]);
  exactKeys(serialized.answers[0], ["valueType", "valueKnowledge", "fieldLinkKnowledge"]);
  exactKeys(serialized.documents[0], ["type", "typeKnowledge", "state", "stateKnowledge", "fileName", "mimeType", "metadataSizeBytes", "availability"]);
  exactKeys(serialized.activities[0], ["type", "occurredAt", "occurredAtKnowledge", "summary", "summaryKnowledge"]);
  exactKeys(serialized.blockers[0], ["code", "occurrenceCount", "reason"]);
  assert.equal("value" in serialized.answers[0], false);
  assert.equal(serialized.documents[0].availability, "metadata");
  assert.equal("actor" in serialized.activities[0], false);
  assert.equal("detail" in serialized.activities[0], false);
});

test("v3 nullable and knowledge fields stay explicit without widening the browser shape", () => {
  const property = serializeAdminProperty({
    id: "property:knowledge",
    name: null,
    nameKnowledge: "unknown",
    address: null,
    addressKnowledge: "unknown",
    propertyType: null,
    propertyTypeKnowledge: "ambiguous",
    state: null,
    stateKnowledge: "unknown",
    operatingContact: null,
    operatingContactKnowledge: "unknown",
  } as never);
  exactKeys(property, ["id", "nameKnowledge", "addressKnowledge", "propertyTypeKnowledge", "stateKnowledge", "operatingContactKnowledge"]);
  assertNoForbiddenKeys(property);

  const person = serializeAdminPerson({
    id: "person:knowledge",
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    phoneMethods: [{ id: "phone:1", value: null, type: "mobile", isPrimary: null, isTextReady: true, ...evil }],
    firstNameKnowledge: "unknown",
    lastNameKnowledge: "unknown",
    emailKnowledge: "unknown",
    phoneKnowledge: "unknown",
  } as never);
  exactKeys(person, ["id", "phoneMethods", "firstNameKnowledge", "lastNameKnowledge", "emailKnowledge", "phoneKnowledge"]);
  exactKeys(person.phoneMethods?.[0], ["id", "type", "isTextReady"]);
  assertNoForbiddenKeys(person);

  const membership = serializeAdminHouseholdMembership({
    id: "membership:knowledge",
    tenancyId: "tenancy:1",
    personId: "person:knowledge",
    role: null,
    relationship: null,
    isFinanciallyResponsible: null,
    roleKnowledge: "unknown",
    relationshipKnowledge: "unknown",
    responsibilityKnowledge: "unknown",
  } as never);
  exactKeys(membership, ["id", "tenancyId", "personId", "roleKnowledge", "relationshipKnowledge", "responsibilityKnowledge"]);
  assertNoForbiddenKeys(membership);

  const tenancy = serializeAdminTenancy({
    id: "tenancy:knowledge",
    propertyId: "property:knowledge",
    unitId: "unit:knowledge",
    primaryPersonId: "person:knowledge",
    status: null,
    plannedMoveInOn: null,
    plannedMoveInKnowledge: "unknown",
    createdAt: "2026-08-17T00:00:00.000Z",
  } as never);
  exactKeys(tenancy, ["id", "propertyId", "unitId", "primaryPersonId", "createdAt", "plannedMoveInKnowledge"]);
  assertNoForbiddenKeys(tenancy);
});

test("application, documents, and snapshot arrays never carry server-only fields", () => {
  const application = serializeAdminApplication({
    ...evil,
    id: "application:1",
    sourceType: "public_portal",
    status: "draft",
    email: "applicant@example.test",
    firstName: "Sample",
    lastName: "Applicant",
    phone: "555-0001",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    rentalHistory: { currentAddress: "1 Main St", ...evil },
    employment: { employerName: "Example", monthlyIncomeCents: 1000, ...evil },
    householdSummary: { adults: 1, children: 0, totalOccupants: 1, ...evil },
    preferences: { bedrooms: 1, ...evil },
    voucher: { hasVoucher: false, ...evil },
    pets: [{ type: "cat", ...evil }],
    vehicles: [{ makeModel: "Car", ...evil }],
    emergencyContact: { name: "Contact", phone: "555-0002", ...evil },
    resumeTokenHash: "secret",
    resumeTokenExpiresAt: "2026-08-18T00:00:00.000Z",
  } as never);
  exactKeys(application, ["id", "sourceType", "status", "email", "firstName", "lastName", "phone", "createdAt", "updatedAt", "rentalHistory", "employment", "householdSummary", "preferences", "voucher", "pets", "vehicles", "emergencyContact"]);
  exactKeys(application.rentalHistory, ["currentAddress"]);
  exactKeys(application.pets?.[0], ["type"]);
  assertNoForbiddenKeys(application);

  const snapshot = serializeAdminSnapshot({
    ...baseSnapshot(),
    properties: [{ id: "property:1", name: "Example", slug: "example", address: { line1: "1 Main", city: "Tampa", state: "FL", postalCode: "33601" }, propertyType: "multifamily", state: "active", ...evil }],
    recurringSchedules: [{ id: "schedule:1", propertyId: "property:1", category: "recurring_fee", description: "Fee", amountCents: 1, active: true, chargeDefinitionId: "source-definition", chargeDefinitionKey: "source-definition-key", ...evil }],
  } as never);
  exactKeys(snapshot, ["properties", "units", "people", "householdMemberships", "tenancies", "leaseTerms", "recurringSchedules", "ledgerTransactions", "paymentAllocations", "securityDeposits", "subsidyContracts", "applications", "applicationHouseholdMembers", "applicationRequirements", "documents", "activityEvents"]);
  assert.equal("sourceRecords" in snapshot, false);
  assert.equal("importRuns" in snapshot, false);
  assert.equal("chargeDefinitionId" in snapshot.recurringSchedules[0], false);
  assert.equal("chargeDefinitionKey" in snapshot.recurringSchedules[0], false);
  assertNoForbiddenKeys(snapshot);
});

test("reports and CSV rows redact nested ledger/source-definition canaries", () => {
  const ledger = {
    transaction: {
      id: "transaction:1",
      propertyId: "property:1",
      kind: "charge",
      category: "base_rent",
      status: "posted",
      amountCents: 100,
      postedOn: "2026-08-01",
      description: "Rent",
      ...evil,
    },
    allocatedCents: 0,
    openCents: 100,
    runningBalanceCents: 100,
    ...evil,
  };
  const reportRow = serializeReportRows("tenant-ledger", [ledger])[0];
  exactKeys(reportRow, ["transaction", "allocatedCents", "openCents", "runningBalanceCents"]);
  exactKeys(reportRow.transaction, ["id", "propertyId", "kind", "category", "status", "amountCents", "postedOn", "description"]);
  assertNoForbiddenKeys(reportRow);
  const csvRows = serializeCsvRows("tenant-ledger", [ledger]);
  assert.deepEqual(csvRows, [reportRow]);
  assertNoForbiddenKeys(csvRows);

  const scheduled = serializeReportRows("scheduled-income", [{
    propertyId: "property:1",
    propertyName: "Example",
    amountCents: 100,
    scheduleId: "schedule:1",
    description: "Rent",
    chargeDefinitionId: "rm-charge-id",
    chargeDefinitionKey: "rm-charge-key",
    ...evil,
  }])[0];
  assert.equal("chargeDefinitionId" in scheduled, false);
  assert.equal("chargeDefinitionKey" in scheduled, false);
  assertNoForbiddenKeys(scheduled);

  const envelope = serializeReportEnvelope({ report: "tenant-ledger", filters: { propertyId: "property:1", ...evil }, rows: [ledger] });
  exactKeys(envelope, ["report", "filters", "rows"]);
  assertNoForbiddenKeys(envelope);
});

test("public listings and application views are isolated from admin/persistence shape", () => {
  const listings = serializePublicListings([{
    id: "property:1",
    name: "Example",
    slug: "example",
    address: { line1: "private", city: "Tampa", state: "FL", postalCode: "33601", ...evil },
    state: "active",
    trustedNative: true,
    units: [{ id: "unit:1", unitNumber: "1", readiness: "ready", listing: "listed", marketRentCents: 1000, storageKey: "no", chargeDefinitionId: "source-definition", chargeDefinitionKey: "source-definition-key", trustedNative: true, ...evil }],
    ...evil,
  }]);
  exactKeys(listings[0], ["id", "name", "slug", "units"]);
  exactKeys(listings[0].units[0], ["id", "unitNumber", "marketRentCents"]);
  assert.equal("chargeDefinitionId" in listings[0].units[0], false);
  assert.equal("chargeDefinitionKey" in listings[0].units[0], false);
  assertNoForbiddenKeys(listings);

  const application = serializePublicApplication({
    ...evil,
    id: "application:1",
    sourceType: "public_portal",
    status: "draft",
    email: "applicant@example.test",
    firstName: "Sample",
    lastName: "Applicant",
    phone: "555-0001",
    rentalHistory: { currentAddress: "1 Main", ...evil },
    householdMembers: [{ id: "member:1", applicationId: "application:1", firstName: "Household", lastName: "Member", isMinor: false, ...evil }],
    requirements: [{ id: "requirement:1", applicationId: "application:1", key: "id", label: "ID", status: "requested", requestedOn: "2026-08-17", ...evil }],
    documents: [{ id: "document:1", type: "identity", state: "requested", fileName: "id.pdf", mimeType: "application/pdf", storageKey: "pending/id", checksumSha256: "secret", ...evil }],
    resumeTokenHash: "secret",
  });
  exactKeys(application, ["id", "status", "email", "firstName", "lastName", "phone", "rentalHistory", "householdMembers", "requirements", "documents"]);
  exactKeys(application.householdMembers[0], ["id", "firstName", "lastName", "isMinor"]);
  exactKeys(application.requirements[0], ["id", "label", "status", "requestedOn"]);
  exactKeys(application.documents[0], ["id", "type", "state", "fileName", "mimeType", "downloadAvailable"]);
  assert.equal(application.documents[0].downloadAvailable, false);
  assertNoForbiddenKeys(application);

  const unknownListings = serializePublicListings([
    { id: "property:unknown-name", name: null, slug: "unknown-name", state: "active", units: [] },
    { id: "property:unknown-state", name: "Unknown", slug: "unknown-state", state: null, units: [] },
    { id: "property:unknown-address", name: "Unknown address", slug: "unknown-address", address: null, units: [] },
    { id: "property:known", name: "Known", slug: "known", address: { line1: "1 Main", city: "Tampa", state: "FL", postalCode: "33601" }, state: "active", trustedNative: true, units: [{ id: "unit:unknown", unitNumber: "1", readiness: null, listing: "listed", trustedNative: true }, { id: "unit:known", unitNumber: "2", readiness: "ready", listing: "listed", trustedNative: true }] },
  ]);
  assert.deepEqual(unknownListings.map((listing) => listing.id), ["property:known"]);
  assert.deepEqual(unknownListings[0].units.map((unit) => unit.id), ["unit:known"]);
  assertNoForbiddenKeys(unknownListings);
});

test("dashboard serializes snapshot, nested reports, and tenant views as one safe boundary", () => {
  const summary = {
    asOfDate: "2026-08-17",
    propertyCount: 0,
    unitCount: 0,
    occupiedUnits: 0,
    futurePreleasedUnits: 0,
    genuineVacantUnits: 0,
    readyVacantUnits: 0,
    notReadyUnits: 0,
    offMarketUnits: 0,
    physicalOccupancyPercent: 0,
    scheduledRentCents: 0,
    collectedRentCents: 0,
    rentOnlyDelinquencyCents: 0,
    totalDelinquencyCents: 0,
    unappliedCashCents: 0,
    expiringIn30Days: 0,
    expiringIn60Days: 0,
    expiringIn90Days: 0,
    monthToMonthCount: 0,
    applicationsSubmitted: 0,
    applicationsMissingInformation: 0,
    securityDepositLiabilityCents: 0,
    drilldowns: { occupiedUnits: { report: "occupancy", filters: { ...evil } } },
  } as DashboardSummary;
  const dashboard = serializeAdminDashboard({
    generatedAt: "2026-08-17T00:00:00.000Z",
    summary,
    snapshot: baseSnapshot(),
    reports: {
      "tenant-ledger": [{ transaction: { id: "transaction:1", ...evil }, ...evil }],
      raw: [{ ...evil }],
    },
    tenants: [{ person: { id: "person:1", firstName: "A", lastName: "B", ...evil }, household: [], leaseTerms: [], schedules: [], ledger: [], deposits: [], subsidyContracts: [], documents: [], activity: [], ...evil }],
    applicants: [],
    documents: [],
    activities: [],
  });
  assert.equal("raw" in dashboard, false);
  assert.equal("source" in dashboard, false);
  assert.equal(dashboard.ledger.length, 1);
  assertNoForbiddenKeys(dashboard);
});

test("opaque target IDs and presentation errors have explicit seams", () => {
  assert.equal(isOpaqueTargetId("application:123"), true);
  assert.equal(isOpaqueTargetId(""), false);
  assert.equal(isOpaqueTargetId("application/../secret"), true);
  assert.equal(isOpaqueTargetId(" application:123"), false);
  assert.deepEqual(serializeError(new Error("provider secret: do not expose")), { code: "request_failed" });
  assert.deepEqual(serializeError(new Error("Application not found: internal id")), { code: "not_found" });
});

test("admin tenant profile canaries are removed below every nested collection", () => {
  const profile = serializeAdminTenantProfile({
    person: { id: "person:1", firstName: "A", lastName: "B", ...evil },
    household: [{ id: "membership:1", personId: "person:1", role: "primary", isFinanciallyResponsible: true, ...evil }],
    leaseTerms: [],
    schedules: [{ id: "schedule:1", propertyId: "property:1", category: "recurring_fee", description: "Fee", amountCents: 1, active: true, chargeDefinitionId: "source-definition", ...evil }],
    ledger: [{ transaction: { id: "transaction:1", ...evil }, allocatedCents: 0, openCents: 1, runningBalanceCents: 1, ...evil }],
    deposits: [],
    subsidyContracts: [],
    documents: [],
    activity: [],
    ...evil,
  });
  exactKeys(profile.person, ["id", "firstName", "lastName"]);
  exactKeys(profile.household[0], ["id", "personId", "role", "isFinanciallyResponsible"]);
  exactKeys(profile.schedules[0], ["id", "propertyId", "category", "description", "amountCents", "active"]);
  exactKeys(profile.ledger[0], ["transaction", "allocatedCents", "openCents", "runningBalanceCents"]);
  exactKeys(profile.ledger[0].transaction, ["id"]);
  assertNoForbiddenKeys(profile);
});

test("application requirements omit the forbidden internal requirement key", () => {
  const requirement = serializeAdminApplicationRequirement({ id: "requirement:1", applicationId: "application:1", key: "identity", label: "Identity", status: "requested", requestedOn: "2026-08-17", ...evil } as never);
  exactKeys(requirement, ["id", "applicationId", "label", "status", "requestedOn"]);
  assertNoForbiddenKeys(requirement);
});

test("v8 nullable financial fields remain explicit and charge definitions stay positive", () => {
  const schedule = serializeAdminRecurringSchedule({ id: "schedule:null", propertyId: null, scopeType: null, scopeId: null, category: null, description: null, amountCents: null, effectiveFrom: null, effectiveTo: null, active: null, chargeDefinitionId: "source-id" } as never);
  assert.equal(schedule.category, null);
  assert.equal(schedule.amountCents, null);
  assert.equal(schedule.effectiveFrom, null);
  assert.equal(schedule.active, null);
  assert.equal("chargeDefinitionId" in schedule, false);
  const definition = serializeAdminChargeDefinition({ id: "charge-definition:rent", displayName: null, displayNameKnowledge: "unknown", category: "base_rent", categoryKnowledge: "source", active: true, activeKnowledge: "source", source: { sourceId: "provider" } } as never);
  assert.deepEqual(definition, { id: "charge-definition:rent", displayName: null, displayNameKnowledge: "unknown", category: "base_rent", categoryKnowledge: "source", active: true, activeKnowledge: "source" });
  assert.equal("source" in definition, false);
});
