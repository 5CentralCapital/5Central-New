import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticRentOpsRepository, syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { RentOpsInvariantError } from "../domain/invariants";
import { RentOpsService, type ApplicationConversionFacts } from "./service";
import { createInMemoryObjectStore } from "../storage";
import type { RentOpsRepository } from "../../../shared/rent-ops-contracts";

const startInput = {
  email: "new.applicant@example.test",
  firstName: "New",
  lastName: "Applicant",
  phone: "+1-555-0199",
  currentAddress: "99 Example Street",
};
const adminContext = { actorSubject: "admin-subject-1", occurredAt: "2026-08-16T12:30:00.000Z" };

function clock() {
  let current = new Date("2026-08-16T12:00:00.000Z");
  return { now: () => current, advance: (milliseconds: number) => { current = new Date(current.getTime() + milliseconds); } };
}

function approvedFacts(propertyId = "demo-property-a", unitId = "demo-unit-a-3"): ApplicationConversionFacts {
  return {
    propertyId,
    unitId,
    plannedMoveInOn: "2026-09-15",
    leaseStatus: "executed",
    contractStartOn: "2026-09-15",
    contractEndOn: "2027-09-14",
    monthToMonth: false,
    baseRentCents: 110000,
    billingFrequency: "monthly",
    chargeDefinitionId: "definition:base-rent",
    category: "base_rent",
    scheduleDescription: "Monthly base rent",
    primaryFinanciallyResponsible: true,
    members: [{ applicationMemberId: "primary", role: "primary", isFinanciallyResponsible: true }],
  };
}

async function addBaseRentDefinition(repository: RentOpsRepository): Promise<void> {
  if (!repository.saveChargeDefinition) throw new Error("Synthetic repository must support charge definitions");
  await repository.saveChargeDefinition({ id: "definition:base-rent", displayName: "Base rent", displayNameKnowledge: "manual", category: "base_rent", categoryKnowledge: "manual", active: true, activeKnowledge: "manual" });
}

test("application start fails closed before persistence when delivery is unavailable", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));
  const before = (await repository.getSnapshot()).applications.length;
  await assert.rejects(() => service.startApplication(startInput), (error: unknown) => error instanceof RentOpsInvariantError && /delivery is not configured/i.test(error.message));
  assert.equal((await repository.getSnapshot()).applications.length, before);
});

test("notifier receives the opaque token but service response stays token-free unless explicitly exposed", async () => {
  const repository = createSyntheticRentOpsRepository();
  let delivered: { applicationId: string; email: string; token: string; expiresAt: string } | undefined;
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, async (message) => { delivered = message; }, false);
  const result = await service.startApplication(startInput);
  assert.equal(result.accepted, true);
  assert.equal(result.resumeToken, undefined);
  assert.equal(result.application.email, startInput.email);
  assert.equal(result.application.rentalHistory?.currentAddress, startInput.currentAddress);
  assert.equal(delivered?.applicationId, result.application.id);
  assert.ok(delivered?.token);
  assert.equal((result.application as Record<string, unknown>).resumeTokenHash, undefined);
});

test("failed magic-link delivery revokes the stored token and draft", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, async () => { throw new Error("synthetic delivery failure"); }, false);
  await assert.rejects(() => service.startApplication(startInput), /delivery failure/i);
  const created = (await repository.getSnapshot()).applications.find((application) => application.email === startInput.email)!;
  assert.equal(created.status, "withdrawn");
  assert.equal(created.resumeTokenHash, undefined);
  assert.equal(created.resumeTokenExpiresAt, undefined);
});

test("resume tokens are scoped to the application, expire, and reject malformed or unknown values generically", async () => {
  const repository = createSyntheticRentOpsRepository();
  const time = clock();
  const service = new RentOpsService(repository, time.now, 60_000, undefined, true);
  const result = await service.startApplication(startInput);
  assert.ok(result.resumeToken);
  assert.equal((await service.publicApplication(result.resumeToken!)).email, startInput.email);
  await assert.rejects(() => service.publicApplication("bad-token"), /resume token invalid or expired/i);
  await assert.rejects(() => service.publicApplication("A".repeat(48)), /resume token invalid or expired/i);
  time.advance(60_001);
  await assert.rejects(() => service.publicApplication(result.resumeToken!), /resume token invalid or expired/i);
});

test("household members remain token-scoped and metadata-only document writes fail closed", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true);
  const first = await service.startApplication({ ...startInput, email: "first@example.test" });
  const second = await service.startApplication({ ...startInput, email: "second@example.test" });
  await service.savePublicHouseholdMember(first.resumeToken!, { id: "same-client-id", firstName: "First", lastName: "Member", isMinor: false });
  await service.savePublicHouseholdMember(second.resumeToken!, { id: "same-client-id", firstName: "Second", lastName: "Member", isMinor: true });
  await assert.rejects(() => service.savePublicDocumentMetadata(first.resumeToken!, { type: "identity", fileName: "id.pdf", mimeType: "application/pdf" }), /verified upload required/i);
  const firstView = await service.publicApplication(first.resumeToken!);
  const secondView = await service.publicApplication(second.resumeToken!);
  assert.equal(firstView.householdMembers.length, 1);
  assert.equal(secondView.householdMembers.length, 1);
  assert.notEqual(firstView.householdMembers[0].id, secondView.householdMembers[0].id);
  assert.equal(firstView.documents.length, 0);
  assert.equal(secondView.documents.length, 0);
});

test("verified applicant upload binds one immutable object and satisfies an exact requirement", async () => {
  const repository = createSyntheticRentOpsRepository();
  const storage = createInMemoryObjectStore();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true, { documentStorage: storage });
  const started = await service.startApplication({ ...startInput, email: "document-upload@example.test" });
  const requirement = await service.saveApplicationRequirement(started.application.id, { key: "identity", label: "Identity document", status: "requested", requestedOn: "2026-08-16" });
  const bytes = Buffer.from("%PDF-1.7\nsynthetic verified document bytes");
  const view = await service.savePublicVerifiedDocument(started.resumeToken!, { type: "identity", fileName: "identity.pdf", mimeType: "application/pdf", bytes, requirementId: requirement.id });
  assert.equal(view.documents.length, 1);
  assert.equal(view.documents[0].state, "verified");
  assert.equal((await service.snapshot()).applicationRequirements.find((item) => item.id === requirement.id)?.documentId, view.documents[0].id);
  const opened = await service.openVerifiedDocument(view.documents[0].id);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await assert.rejects(() => service.savePublicVerifiedDocument(started.resumeToken!, { type: "identity", fileName: "../unsafe.pdf", mimeType: "application/pdf", bytes }), /filename is invalid/i);
  await service.certifyPublicApplication(started.resumeToken!);
  const submitted = await service.submitPublicApplication(started.resumeToken!);
  assert.equal(submitted.status, "submitted");
});

test("verified upload requires the exact application requirement and storage binding", async () => {
  const repository = createSyntheticRentOpsRepository();
  const storage = createInMemoryObjectStore();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true, { documentStorage: storage });
  const first = await service.startApplication({ ...startInput, email: "document-first@example.test" });
  const second = await service.startApplication({ ...startInput, email: "document-second@example.test" });
  const requirement = await service.saveApplicationRequirement(first.application.id, { key: "identity", label: "Identity document", status: "requested", requestedOn: "2026-08-16" });
  await assert.rejects(() => service.savePublicVerifiedDocument(second.resumeToken!, { type: "identity", fileName: "identity.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7\nbytes"), requirementId: requirement.id }), /requirement is not available/i);
  await assert.rejects(() => service.openVerifiedDocument("missing-document"), /document not found/i);
});

test("RM archive transfer requires an exact source binary/import binding before database binding", async () => {
  const repository = createSyntheticRentOpsRepository();
  const storage = createInMemoryObjectStore();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true, { documentStorage: storage });
  const bytes = Buffer.from("%PDF-1.7\narchive bytes");
  await assert.rejects(() => service.archiveVerifiedDocument({
    type: "lease", fileName: "archive.pdf", mimeType: "application/pdf", bytes, propertyId: "demo-property-a",
    sourceBinaryBinding: { bindingId: "source-binary-1", importRunId: "run-1" },
  }), /exact source binary, import run, system, and collection/i);
  const document = await service.archiveVerifiedDocument({
    type: "lease", fileName: "archive.pdf", mimeType: "application/pdf", bytes, propertyId: "demo-property-a",
    sourceBinaryBinding: { bindingId: "source-binary-1", importRunId: "run-1", sourceSystem: "rm", sourceCollection: "documents" },
  });
  assert.equal(document.state, "verified");
  assert.equal((await service.openVerifiedDocument(document.id)).document.id, document.id);
});

test("submitted applications are locked for public writes and admin conversion is idempotent with audit events", async () => {
  const repository = createSyntheticRentOpsRepository();
  await addBaseRentDefinition(repository);
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true);
  const started = await service.startApplication(startInput);
  const selected = await service.savePublicApplication(started.resumeToken!, { propertyId: "demo-property-a", unitId: "demo-unit-a-3", preferences: { desiredMoveInOn: "2026-09-15", desiredLeaseMonths: 12 } });
  await service.certifyPublicApplication(started.resumeToken!);
  const submitted = await service.submitPublicApplication(started.resumeToken!);
  assert.equal(submitted.status, "submitted");
  await assert.rejects(() => service.savePublicApplication(started.resumeToken!, { phone: "+1-555-0000" }), /no longer editable/i);
  const approved = await service.updateApplicationStatus(selected.id, "approved");
  assert.equal(approved.status, "approved");
  const facts = approvedFacts();
  await repository.saveChargeDefinition!({ id: "definition:untrusted-base-rent", displayName: "Untrusted base rent", displayNameKnowledge: "manual", category: "base_rent", categoryKnowledge: "unknown", active: true, activeKnowledge: "manual" });
  await assert.rejects(
    () => service.convertApplication(selected.id, { ...facts, chargeDefinitionId: "definition:untrusted-base-rent" }, adminContext),
    /charge definition is unavailable/i,
  );
  const firstConversion = await service.convertApplication(selected.id, facts, adminContext);
  const secondConversion = await service.convertApplication(selected.id, facts, adminContext);
  assert.equal(secondConversion.tenancy.id, firstConversion.tenancy.id);
  const after = await repository.getSnapshot();
  assert.equal(after.tenancies.filter((tenancy) => tenancy.applicationId === selected.id).length, 1);
  assert.equal(after.leaseTerms.filter((term) => term.tenancyId === firstConversion.tenancy.id).length, 1);
  assert.equal(after.recurringSchedules.filter((schedule) => schedule.tenancyId === firstConversion.tenancy.id && schedule.category === "base_rent").length, 1);
  assert.equal(after.householdMemberships.filter((membership) => membership.tenancyId === firstConversion.tenancy.id && membership.role === "primary").length, 1);
  assert.ok(after.activityEvents.filter((event) => event.applicationId === selected.id && event.actor === "admin").length >= 2);
  const conversionScheduleChange = (await repository.getRecordChanges!()).find((change) => change.targetId === `schedule:application:${selected.id}:base-rent`);
  assert.equal(conversionScheduleChange?.origin, "admin");
  assert.equal(conversionScheduleChange?.actorSubject, adminContext.actorSubject);
  assert.equal(conversionScheduleChange?.revision, 1);
});

test("ledger writes reject malformed adjustments, reversal chains, and allocation chronology", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true);
  await assert.rejects(() => service.saveLedgerTransaction({ id: "bad-adjustment", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", kind: "adjustment", category: "base_rent", status: "posted", amountCents: 100, postedOn: "2026-08-10", description: "Missing direction" }), /explicit debit or credit/i);
  await assert.rejects(() => service.savePaymentAllocation({ id: "bad-chronology", paymentTransactionId: "demo-payment-1", chargeTransactionId: "demo-charge-rent-1", amountCents: 100, allocatedOn: "2026-07-31" }), (error: unknown) => error instanceof RentOpsInvariantError && error.violations.some((violation) => violation.code === "allocation_predates_payment"));
  const first = await service.reverseLedgerTransaction("demo-credit-1", { id: "credit-reversal", postedOn: "2026-08-12", description: "Correct credit", status: "posted" });
  await assert.rejects(() => service.reverseLedgerTransaction("demo-credit-1", { id: "second-credit-reversal", postedOn: "2026-08-13", description: "Duplicate correction", status: "posted" }), /already been reversed/i);
  await assert.rejects(() => service.reverseLedgerTransaction(first.id, { id: "reversal-chain", postedOn: "2026-08-14", description: "Invalid chain", status: "posted" }), /cannot reverse another reversal/i);
});

test("conversion rejects occupied units and incomplete lease setup", async () => {
  const repository = createSyntheticRentOpsRepository();
  await addBaseRentDefinition(repository);
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true);
  const started = await service.startApplication({ ...startInput, email: "conflict@example.test" });
  await assert.rejects(() => service.savePublicApplication(started.resumeToken!, { propertyId: "demo-property-a", unitId: "demo-unit-a-1" }), /unit is unavailable/i);
  await service.savePublicApplication(started.resumeToken!, { propertyId: "demo-property-a", unitId: "demo-unit-a-3" });
  await service.certifyPublicApplication(started.resumeToken!);
  const submitted = await service.submitPublicApplication(started.resumeToken!);
  await service.updateApplicationStatus(submitted.id, "approved");
  await assert.rejects(() => service.convertApplication(submitted.id), /explicit admin-approved conversion facts/i);
  const application = await repository.getApplicationById(submitted.id);
  await repository.saveApplication({ ...application!, unitId: "demo-unit-a-1", preferences: { desiredMoveInOn: "2026-09-01", desiredLeaseMonths: 12 }, updatedAt: "2026-08-16T12:00:00.000Z" });
  await assert.rejects(() => service.convertApplication(submitted.id, approvedFacts("demo-property-a", "demo-unit-a-1"), adminContext), /not available/i);
});

test("public inventory never treats uncertain tenancy coverage as vacancy", async () => {
  const cases: Array<Record<string, unknown>> = [
    { id: "uncertain-current", propertyId: "demo-property-a", unitId: "demo-unit-a-3", primaryPersonId: "demo-person-1", status: "current", createdAt: "2026-08-16T12:00:00.000Z" },
    { id: "uncertain-future", propertyId: "demo-property-a", unitId: "demo-unit-a-3", primaryPersonId: "demo-person-1", status: "future", createdAt: "2026-08-16T12:00:00.000Z" },
    { id: "uncertain-status", propertyId: "demo-property-a", unitId: "demo-unit-a-3", primaryPersonId: "demo-person-1", status: null, createdAt: "2026-08-16T12:00:00.000Z" },
    { id: "uncertain-link", propertyId: "demo-property-a", unitId: "demo-unit-a-3", primaryPersonId: "demo-person-1", status: "current", actualMoveInOn: "2026-01-01", unitLinkKnowledge: "unknown", createdAt: "2026-08-16T12:00:00.000Z" },
  ];
  for (const candidate of cases) {
    const snapshot = structuredClone(syntheticRentOpsSnapshot()) as never as { tenancies: Array<Record<string, unknown>> };
    snapshot.tenancies.push(candidate);
    const repository = new SyntheticRentOpsRepository(snapshot as never);
    const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true);
    const options = await service.publicApplicationOptions();
    assert.equal(options[0].units.some((unit) => unit.id === "demo-unit-a-3"), false, candidate.id);
    const started = await service.startApplication({ ...startInput, email: `${candidate.id}@example.test` });
    await assert.rejects(() => service.savePublicApplication(started.resumeToken!, { propertyId: "demo-property-a", unitId: "demo-unit-a-3" }), /unit is unavailable/i, candidate.id);
  }
});

test("application status changes follow the explicit lifecycle and conversion rechecks listed inventory", async () => {
  const repository = createSyntheticRentOpsRepository();
  await addBaseRentDefinition(repository);
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true);
  const started = await service.startApplication({ ...startInput, email: "lifecycle@example.test" });
  const selected = await service.savePublicApplication(started.resumeToken!, { propertyId: "demo-property-a", unitId: "demo-unit-a-3", preferences: { desiredMoveInOn: "2026-09-15", desiredLeaseMonths: 12 } });
  await service.certifyPublicApplication(started.resumeToken!);
  await service.submitPublicApplication(started.resumeToken!);
  await assert.rejects(() => service.updateApplicationStatus(selected.id, "converted"), /cannot change|conversion action/i);
  await service.updateApplicationStatus(selected.id, "under_review");
  await service.updateApplicationStatus(selected.id, "approved");
  const unit = (await repository.getSnapshot()).units.find((candidate) => candidate.id === "demo-unit-a-3")!;
  await repository.saveUnit({ ...unit, readiness: "not_ready" });
  await assert.rejects(() => service.convertApplication(selected.id, approvedFacts(), adminContext), /ready and listed/i);
  await repository.saveUnit({ ...unit, readiness: "ready", listing: "unlisted" });
  await assert.rejects(() => service.convertApplication(selected.id, approvedFacts(), adminContext), /ready and listed/i);
});

test("runtime money minima match the SQL migration and document parents remain private and linked", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"), undefined, undefined, true);
  await assert.rejects(() => service.saveRecurringSchedule({ billingFrequency: "monthly", id: "zero-schedule", tenancyId: "demo-tenancy-1", propertyId: "demo-property-a", unitId: "demo-unit-a-1", category: "recurring_fee", description: "Zero", amountCents: 0, effectiveFrom: "2026-08-01", active: true }, adminContext), /greater than zero/i);
  await assert.rejects(() => service.saveSecurityDeposit({ id: "zero-deposit", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", type: "security", amountHeldCents: 0, receivedOn: "2026-08-01", dispositionStatus: "held" }), /greater than zero/i);
  await assert.rejects(() => service.saveSubsidyContract({ id: "zero-subsidy", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", agencyName: "Agency", effectiveFrom: "2026-08-01", agencyObligationCents: 0, tenantObligationCents: 0, status: "active" }), /total more than zero/i);
  await assert.rejects(() => service.saveDocument({ id: "public-doc", propertyId: "demo-property-a", type: "other", state: "requested", fileName: "x.pdf", mimeType: "application/pdf", storageKey: "https://public.example/x.pdf", uploadedAt: "2026-08-16T12:00:00.000Z" }), /private relative key/i);
  await assert.rejects(() => service.saveDocument({ id: "orphan-doc", type: "other", state: "requested", fileName: "x.pdf", mimeType: "application/pdf", storageKey: "private/orphan", uploadedAt: "2026-08-16T12:00:00.000Z" }), /Document references are invalid/i);
});

test("manual sparse patches preserve imported provenance, mark changed facts manual, and audit only field names", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot()) as never as {
    properties: Array<Record<string, unknown>>;
    securityDeposits: Array<Record<string, unknown>>;
  };
  const property = snapshot.properties[0];
  property.source = { system: "rm", sourceId: "property-source-1" };
  property.nameKnowledge = "source";
  property.addressKnowledge = "source";
  const deposit = snapshot.securityDeposits[0];
  deposit.source = { system: "rm", sourceId: "deposit-source-1" };
  deposit.receivedOn = undefined;
  deposit.receivedOnKnowledge = "unknown";
  const repository = new SyntheticRentOpsRepository(snapshot as never);
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));

  const updated = await service.patchRecord("property", "demo-property-a", 1, { name: "Operator Harbor Homes" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:00:00.000Z" }) as Record<string, unknown>;
  assert.equal(updated.name, "Operator Harbor Homes");
  assert.equal(updated.recordRevision, 2);
  assert.equal(updated.nameKnowledge, "manual");
  assert.equal(updated.addressKnowledge, "source");
  const after = await repository.getSnapshot();
  const afterProperty = after.properties.find((candidate) => candidate.id === "demo-property-a") as unknown as Record<string, unknown>;
  assert.deepEqual(afterProperty.source, { system: "rm", sourceId: "property-source-1" });
  assert.equal(afterProperty.addressKnowledge, "source");

  const noOp = await service.patchRecord("property", "demo-property-a", 2, { name: "Operator Harbor Homes" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:01:00.000Z" }) as Record<string, unknown>;
  assert.equal(noOp.recordRevision, 2);
  const changes = await repository.getRecordChanges!();
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    id: changes[0].id,
    entityType: "property",
    targetId: "demo-property-a",
    revision: 2,
    origin: "admin",
    actorSubject: "admin-1",
    occurredAt: "2026-08-16T12:00:00.000Z",
    changedFields: ["name"],
  });

  await assert.rejects(
    () => service.patchRecord("property", "demo-property-a", 1, { slug: "stale" }, { actorSubject: "admin-2", occurredAt: "2026-08-16T12:02:00.000Z" }),
    /revision is stale/i,
  );
  await assert.rejects(
    () => service.patchRecord("property", "demo-property-a", 2, { nameKnowledge: "manual" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:03:00.000Z" }),
    /positive allowlist/i,
  );
  await assert.rejects(
    () => service.patchRecord("application", "demo-application-1", 1, { profileAnswers: { source: "forged" } }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:04:00.000Z" }),
    /provenance|server-controlled/i,
  );
  await assert.rejects(
    () => service.patchRecord("recurring_schedule", "demo-schedule-1", 1, { description: "forged" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:05:00.000Z" }),
    /versioned_schedule_required/i,
  );

  const depositUpdated = await service.patchRecord("security_deposit", "demo-deposit-1", 1, { dispositionNotes: "Manual receipt follow-up" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:06:00.000Z" }) as Record<string, unknown>;
  assert.equal(depositUpdated.recordRevision, 2);
  assert.equal(depositUpdated.dispositionNotes, "Manual receipt follow-up");
  assert.equal(depositUpdated.receivedOn, undefined);
  assert.equal(depositUpdated.receivedOnKnowledge, "unknown");
});

test("sparse nested edits preserve address leaves and phone methods; null clears become unknown", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot()) as never as {
    properties: Array<Record<string, unknown>>;
    people: Array<Record<string, unknown>>;
    securityDeposits: Array<Record<string, unknown>>;
  };
  const property = snapshot.properties[0];
  property.source = { system: "rm", sourceId: "property-address-source" };
  property.addressKnowledge = "source";
  property.address = { line1: "100 Example Way", line2: "Unit office", city: "Sampleton", state: "ZZ", postalCode: "00001" };
  const person = snapshot.people[0];
  person.source = { system: "rm", sourceId: "person-phone-source" };
  person.phoneMethods = [{ id: "phone:mobile", value: "+1-555-0101", type: "mobile", isPrimary: true, isTextReady: true }, { id: "phone:home", value: "+1-555-0102", type: "home" }];
  person.phoneKnowledge = "source";
  const deposit = snapshot.securityDeposits[0];
  deposit.receivedOn = "2026-01-01";
  deposit.receivedOnKnowledge = "source";
  const repository = new SyntheticRentOpsRepository(snapshot as never);
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));

  const addressUpdate = await service.patchRecord("property", String(property.id), 1, { address: { city: "Changedtown" } }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:00:00.000Z" }) as Record<string, unknown>;
  assert.deepEqual(addressUpdate.address, { line1: "100 Example Way", line2: "Unit office", city: "Changedtown", state: "ZZ", postalCode: "00001" });
  assert.equal(addressUpdate.addressKnowledge, "manual");

  const personUpdate = await service.patchRecord("person", String(person.id), 1, { phone: "+1-555-0199" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:01:00.000Z" }) as Record<string, unknown>;
  assert.deepEqual(personUpdate.phoneMethods, person.phoneMethods);
  assert.equal(personUpdate.phoneKnowledge, "manual");

  const untouched = await service.patchRecord("security_deposit", String(deposit.id), 1, { dispositionNotes: "Follow up" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:02:00.000Z" }) as Record<string, unknown>;
  assert.equal(untouched.receivedOn, "2026-01-01");
  assert.equal(untouched.receivedOnKnowledge, "source");
  const cleared = await service.patchRecord("security_deposit", String(deposit.id), 2, { receivedOn: null }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:03:00.000Z" }) as Record<string, unknown>;
  assert.equal(cleared.receivedOn, null);
  assert.equal(cleared.receivedOnKnowledge, "unknown");
});

test("a failed change-ledger insert rolls back the row revision and values", async () => {
  const base = createSyntheticRentOpsRepository();
  const failing = new Proxy(base as unknown as object, {
    get(target, property) {
      if (property === "transaction") {
        return (work: (repository: RentOpsRepository) => Promise<unknown>, options?: unknown) => base.transaction(async (inner) => {
          const intercepted = new Proxy(inner as unknown as object, {
            get(innerTarget, innerProperty) {
              if (innerProperty === "saveRecordChange") return async () => { throw new Error("change ledger unavailable"); };
              const value = Reflect.get(innerTarget, innerProperty, innerTarget);
              return typeof value === "function" ? value.bind(innerTarget) : value;
            },
          }) as unknown as RentOpsRepository;
          return work(intercepted);
        }, options as never);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as RentOpsRepository;
  const service = new RentOpsService(failing, () => new Date("2026-08-16T12:00:00.000Z"));
  await assert.rejects(
    () => service.patchRecord("property", "demo-property-a", 1, { name: "Should roll back" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:00:00.000Z" }),
    /change ledger unavailable/i,
  );
  const after = await base.getSnapshot();
  assert.equal(after.properties.find((property) => property.id === "demo-property-a")?.name, "Demo Harbor Homes");
  assert.equal(after.properties.find((property) => property.id === "demo-property-a")?.recordRevision, undefined);
  assert.equal((await base.getRecordChanges!()).length, 0);

  await base.saveChargeDefinition!({ id: "definition:rollback-fee", displayName: "Rollback fee", displayNameKnowledge: "manual", category: "recurring_fee", categoryKnowledge: "manual", active: true, activeKnowledge: "manual" });
  await assert.rejects(
    () => service.saveRecurringSchedule({ billingFrequency: "monthly", id: "rollback-schedule", scopeType: "unit", scopeId: "demo-unit-a-1", chargeDefinitionId: "definition:rollback-fee", propertyId: "demo-property-a", unitId: "demo-unit-a-1", category: "recurring_fee", description: "Rollback fee", amountCents: 1000, effectiveFrom: "2026-08-16", active: true, lineageRootId: "rollback-schedule", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root" }, adminContext),
    /change ledger unavailable/i,
  );
  assert.equal((await base.getSnapshot()).recurringSchedules.some((schedule) => schedule.id === "rollback-schedule"), false);
  assert.equal((await base.getRecordChanges!()).length, 0);
});

test("native operator dates and links cannot claim source knowledge", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));
  const deposit = await service.saveSecurityDeposit({ id: "native-deposit-knowledge", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", type: "security", amountHeldCents: 50000, receivedOn: "2026-08-16", receivedOnKnowledge: "source", unitLinkKnowledge: "exact", dispositionStatus: "held" });
  assert.equal(deposit.receivedOnKnowledge, "manual");
  assert.equal(deposit.unitLinkKnowledge, "manual");
  const unknownDeposit = await service.saveSecurityDeposit({ id: "native-deposit-unknown", propertyId: "demo-property-a", personId: "demo-person-1", type: "security", amountHeldCents: 50000, receivedOnKnowledge: "source", unitLinkKnowledge: "exact", dispositionStatus: "held" });
  assert.equal(unknownDeposit.receivedOnKnowledge, "unknown");
  assert.equal(unknownDeposit.unitLinkKnowledge, "unknown");
  await repository.saveChargeDefinition!({ id: "definition:operator-fee", displayName: "Operator fee", displayNameKnowledge: "manual", category: "recurring_fee", categoryKnowledge: "manual", active: true, activeKnowledge: "manual" });
  const schedule = await service.saveRecurringSchedule({ billingFrequency: "monthly", id: "native-schedule-knowledge", scopeType: "tenant", scopeId: "demo-person-1", scopeTypeKnowledge: "source", scopeLinkKnowledge: "exact", chargeDefinitionId: "definition:operator-fee", chargeDefinitionLinkKnowledge: "exact", tenancyId: "demo-tenancy-1", personId: "demo-person-1", propertyId: "demo-property-a", unitId: "demo-unit-a-1", category: "recurring_fee", categoryKnowledge: "source", description: "Operator fee", descriptionKnowledge: "source", amountCents: 5000, amountKnowledge: "known", effectiveFrom: "2026-08-16", effectiveFromKnowledge: "source", active: true, activeKnowledge: "source", lineageRootId: "native-schedule-knowledge", lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root" }, adminContext);
  assert.equal(schedule.effectiveFromKnowledge, "manual");
  assert.equal(schedule.scopeTypeKnowledge, "manual");
  assert.equal(schedule.scopeLinkKnowledge, "manual");
  assert.equal(schedule.chargeDefinitionLinkKnowledge, "manual");
  assert.equal(schedule.categoryKnowledge, "manual");
  assert.equal(schedule.descriptionKnowledge, "manual");
  assert.equal(schedule.activeKnowledge, "manual");
  assert.equal(schedule.source, undefined);
  assert.equal(schedule.sourceArtifactSha256, null);
  const rootChange = (await repository.getRecordChanges!()).find((change) => change.targetId === schedule.id);
  assert.equal(rootChange?.origin, "admin");
  assert.equal(rootChange?.actorSubject, adminContext.actorSubject);
  assert.equal(rootChange?.revision, 1);
  assert.ok(rootChange?.changedFields.includes("amountCents"));
  assert.ok(rootChange?.changedFields.includes("chargeDefinitionId"));
  await assert.rejects(
    () => service.saveRecurringSchedule({ ...schedule, id: "forged-source-schedule", lineageRootId: "forged-source-schedule", source: { system: "rm", sourceId: "forged" } }, adminContext),
    /cannot claim imported source evidence/i,
  );
  await assert.rejects(
    () => service.saveRecurringSchedule({ ...schedule, id: "wrong-category-schedule", lineageRootId: "wrong-category-schedule", category: "base_rent" }, adminContext),
    /category must match an exact charge definition/i,
  );
  await repository.saveChargeDefinition!({ id: "definition:unknown-category", displayName: "Unknown category", displayNameKnowledge: "manual", category: "recurring_fee", categoryKnowledge: "unknown", active: true, activeKnowledge: "manual" });
  await assert.rejects(
    () => service.saveRecurringSchedule({ ...schedule, id: "untrusted-category-schedule", lineageRootId: "untrusted-category-schedule", chargeDefinitionId: "definition:unknown-category" }, adminContext),
    /category must match an exact charge definition/i,
  );
});

test("recurring replacements and ends are immutable, revisioned, retry-safe, and audit-linked", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));
  const context = { actorSubject: "admin-subject-1", occurredAt: "2026-08-16T12:30:00.000Z" };
  const replacementInput = { id: "demo-schedule-1-v2", expectedRevision: 1, action: "replace" as const, effectiveFrom: "2026-08-20", amountCents: 125000 };
  const replacement = await service.saveRecurringScheduleSuccessor("demo-schedule-1", replacementInput, context);
  assert.equal(replacement.versionAction, "replace");
  assert.equal(replacement.versionOrigin, "manual");
  assert.equal(replacement.supersedesId, "demo-schedule-1");
  assert.equal(replacement.lineageRootId, "demo-schedule-1");
  assert.equal(replacement.amountCents, 125000);
  assert.equal(replacement.effectiveFromKnowledge, "manual");
  assert.equal(replacement.recordRevision, 2);
  assert.equal(replacement.source, undefined);
  const retried = await service.saveRecurringScheduleSuccessor("demo-schedule-1", replacementInput, context);
  assert.deepEqual(retried, replacement);
  assert.equal((await repository.getRecordChanges!()).filter((change) => change.entityType === "recurring_schedule" && change.targetId === replacement.id).length, 1);

  const ended = await service.saveRecurringScheduleSuccessor(replacement.id, { id: "demo-schedule-1-v3", expectedRevision: 2, action: "end", effectiveFrom: "2026-09-01" }, { ...context, occurredAt: "2026-08-16T12:31:00.000Z" });
  assert.equal(ended.versionAction, "end");
  assert.equal(ended.amountCents, null);
  assert.equal(ended.amountKnowledge, "unknown");
  assert.equal(ended.active, false);
  assert.equal(ended.activeKnowledge, "manual");
  assert.equal(ended.recordRevision, 3);
  await assert.rejects(
    () => service.saveRecurringScheduleSuccessor(ended.id, { id: "demo-schedule-1-v4", expectedRevision: 3, action: "replace", effectiveFrom: "2026-10-01", amountCents: 130000 }, context),
    /terminal/i,
  );
  await assert.rejects(
    () => service.saveRecurringScheduleSuccessor("demo-schedule-2", { id: "demo-schedule-2-v2", expectedRevision: 99, action: "replace", effectiveFrom: "2026-08-20", amountCents: 6000 }, context),
    /revision is stale/i,
  );
  await assert.rejects(
    () => service.saveRecurringScheduleSuccessor("demo-schedule-2", { id: "demo-schedule-2-v2", expectedRevision: 1, action: "end", effectiveFrom: "2026-08-20", amountCents: 1 }, context),
    /cannot carry an amount/i,
  );
});

test("a new base-rent root can follow an ended lineage without hiding historical overlap", async () => {
  const repository = createSyntheticRentOpsRepository();
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));
  const context = { actorSubject: "admin-subject-1", occurredAt: "2026-08-16T12:30:00.000Z" };
  await service.saveRecurringScheduleSuccessor("demo-schedule-1", { id: "demo-schedule-1-end-for-root-test", expectedRevision: 1, action: "end", effectiveFrom: "2026-09-01" }, context);

  const predecessor = (await repository.getSnapshot()).recurringSchedules.find((schedule) => schedule.id === "demo-schedule-1")!;
  const rootInput = {
    ...predecessor,
    id: "demo-schedule-1-after-end-root",
    chargeDefinitionKey: null,
    source: undefined,
    sourceArtifactSha256: null,
    artifactObservationOn: null,
    description: "Replacement root after ended rent",
    personId: "demo-person-1",
    amountCents: 1000,
    effectiveFrom: "2026-10-01",
    effectiveFromKnowledge: "manual" as const,
    effectiveTo: "2027-12-31",
    active: true,
    activeKnowledge: "manual" as const,
    lineageRootId: "demo-schedule-1-after-end-root",
    lineageRootOrigin: "manual" as const,
    versionOrigin: "manual" as const,
    versionAction: "root" as const,
    supersedesId: null,
    billingFrequency: "monthly" as const,
  };
  const saved = await service.saveRecurringSchedule(rootInput, context);
  assert.equal(saved.id, rootInput.id);

  await assert.rejects(
    () => service.saveRecurringSchedule({ ...rootInput, id: "demo-schedule-1-historical-root", lineageRootId: "demo-schedule-1-historical-root", description: "Historical overlap", effectiveFrom: "2026-08-01", effectiveTo: "2026-08-31" }, context),
    (error: unknown) => error instanceof RentOpsInvariantError
      && /overlap an effective base-rent schedule/i.test(error.message)
      && error.violations.some((violation) => violation.entityId === "demo-schedule-1-historical-root"),
  );
});

test("an imported open-start recurring root accepts a manual successor without forging source identity", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const imported = snapshot.recurringSchedules.find((schedule) => schedule.id === "demo-schedule-2")!;
  Object.assign(imported, {
    source: { system: "rm", sourceId: "restricted-source-id" },
    scopeTypeKnowledge: "source",
    scopeLinkKnowledge: "exact",
    categoryKnowledge: "source",
    descriptionKnowledge: "source",
    activeKnowledge: "source",
    chargeDefinitionLinkKnowledge: "exact",
    effectiveFrom: null,
    effectiveFromKnowledge: "unknown_open_start",
    sourceArtifactSha256: "a".repeat(64),
    artifactObservationOn: "2026-08-01",
    lineageRootOrigin: "artifact",
    versionOrigin: "artifact",
  });
  const repository = new SyntheticRentOpsRepository(snapshot);
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));
  const successor = await service.saveRecurringScheduleSuccessor(imported.id, {
    id: "demo-schedule-2-manual-v2",
    expectedRevision: 1,
    action: "replace",
    effectiveFrom: "2026-08-01",
    amountCents: 6000,
  }, { actorSubject: "admin-subject-1", occurredAt: "2026-08-16T12:32:00.000Z" });
  assert.equal(successor.versionOrigin, "manual");
  assert.equal(successor.lineageRootOrigin, "artifact");
  assert.equal(successor.source, undefined);
  assert.equal(successor.sourceArtifactSha256, imported.sourceArtifactSha256);
  assert.equal(successor.artifactObservationOn, imported.artifactObservationOn);
  await assert.rejects(
    () => service.saveRecurringScheduleSuccessor(imported.id, { id: "demo-schedule-2-too-early", expectedRevision: 1, action: "replace", effectiveFrom: "2026-07-31", amountCents: 6000 }, { actorSubject: "admin-subject-1", occurredAt: "2026-08-16T12:33:00.000Z" }),
    /artifact boundary/i,
  );
});

test("patch candidate snapshots reject mismatched relationships and overlapping lease siblings", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.leaseTerms.push({ ...snapshot.leaseTerms[0], id: "demo-term-sibling", contractStartOn: "2026-09-16", contractEndOn: "2027-09-15" });
  const repository = new SyntheticRentOpsRepository(snapshot);
  const service = new RentOpsService(repository, () => new Date("2026-08-16T12:00:00.000Z"));
  const property = snapshot.properties[0];
  const secondProperty = { ...property, id: "property:other", name: "Other property", slug: "other" };
  const unit = snapshot.units[0];
  const tenancy = snapshot.tenancies[0];
  const lease = snapshot.leaseTerms[0];
  const secondLease = snapshot.leaseTerms.find((candidate) => candidate.tenancyId === lease.tenancyId && candidate.id !== lease.id);
  await repository.saveProperty(secondProperty);
  await assert.rejects(
    () => service.patchRecord("unit", unit.id, unit.recordRevision ?? 1, { propertyId: "property:missing" }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:10:00.000Z" }),
    /relationship|property|invariant/i,
  );
  await assert.rejects(
    () => service.patchRecord("tenancy", tenancy.id, tenancy.recordRevision ?? 1, { propertyId: secondProperty.id }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:10:30.000Z" }),
    /relationship|property|invariant/i,
  );
  if (secondLease) {
    await assert.rejects(
      () => service.patchRecord("lease_term", lease.id, lease.recordRevision ?? 1, { contractEndOn: secondLease.contractStartOn }, { actorSubject: "admin-1", occurredAt: "2026-08-16T12:11:00.000Z" }),
      /overlap|sibling|invariant/i,
    );
  }
});

test('admin allocation can reuse charge capacity released by an immutable payment reversal', async () => {
  const snapshot=syntheticRentOpsSnapshot(), tenancy=snapshot.tenancies[0];
  const base={propertyId:tenancy.propertyId,unitId:tenancy.unitId,tenancyId:tenancy.id,personId:tenancy.primaryPersonId,category:'base_rent' as const,status:'posted' as const,amountCents:10000,postedOn:'2026-08-01',description:'Test'};
  snapshot.ledgerTransactions=[{...base,id:'charge',kind:'charge'},{...base,id:'old',kind:'payment'},{...base,id:'reverse',kind:'reversal',reversalOfId:'old',postedOn:'2026-08-02'},{...base,id:'new',kind:'payment',postedOn:'2026-08-02'}];
  snapshot.paymentAllocations=[{id:'old-allocation',paymentTransactionId:'old',chargeTransactionId:'charge',amountCents:10000,allocatedOn:'2026-08-01'}];
  const repository=new SyntheticRentOpsRepository(snapshot),service=new RentOpsService(repository,()=>new Date('2026-08-16T12:00:00Z'),undefined,undefined,true);
  await service.savePaymentAllocation({id:'new-allocation',paymentTransactionId:'new',chargeTransactionId:'charge',amountCents:10000,allocatedOn:'2026-08-02'});
  assert.equal((await repository.getSnapshot()).paymentAllocations.length,2);
  await assert.rejects(service.savePaymentAllocation({id:'excess',paymentTransactionId:'new',chargeTransactionId:'charge',amountCents:1,allocatedOn:'2026-08-02'}),/exceed/);
  await assert.rejects(service.savePaymentAllocation({id:'reversed-target',paymentTransactionId:'old',chargeTransactionId:'charge',amountCents:1,allocatedOn:'2026-08-02'}),/validation/);
});
