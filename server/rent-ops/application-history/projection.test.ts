import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationHistoryCase,
  projectApplicationHistoryForImport,
  projectRentManagerApplicationHistory,
  type ApplicationHistoryProjectionInput,
  type ApplicationHistoryProjectionOptions,
} from "./projection";
import type { RentManagerRawRecord } from "../../../shared/rent-ops-contracts";

const ARTIFACT = "a".repeat(64);

function raw(values: Record<string, unknown>): RentManagerRawRecord {
  return { entityType: "synthetic", sourceId: String(values.sourceId ?? values.id ?? "synthetic"), ...values } as RentManagerRawRecord;
}

function input(overrides: Partial<ApplicationHistoryProjectionInput> = {}): ApplicationHistoryProjectionInput {
  return {
    prospects: [raw({ sourceId: "prospect-1" })],
    applications: [raw({ sourceId: "application-1", ProspectID: "prospect-1" })],
    ...overrides,
  };
}

function project(value: ApplicationHistoryProjectionInput, options: ApplicationHistoryProjectionOptions = {}) {
  return projectRentManagerApplicationHistory(value, options);
}

test("missing answer rows create a blocker, and complete coverage cannot expose answer values", () => {
  const templateRows = [
    raw({ sourceId: "template-1", sourceCollection: "ApplicationTemplates", TemplateID: "template-1", Name: "Synthetic template" }),
    raw({ sourceId: "field-1", sourceCollection: "ApplicationTemplateFields", FieldID: "field-1", TemplateID: "template-1", ValueType: "text", Sensitive: false }),
  ];

  const missing = project(input({ applicationTemplates: templateRows }));
  assert.deepEqual(missing.blockers.map((blocker) => blocker.code), ["application_answers_missing"]);

  const complete = project(input({
    applicationTemplates: templateRows,
    applicationAnswersCoverage: "complete",
    applicationAnswerRecords: [raw({ sourceId: "answer-1", ApplicationID: "application-1", FieldID: "field-1", Answer: "ANSWER_PII_CANARY" })],
  }), {
    artifactSha256: ARTIFACT,
    answerEvidence: {
      artifactSha256: ARTIFACT,
      rowSetSha256: "b".repeat(64),
      attestationSha256: "c".repeat(64),
      allowlistedFieldSourceIds: ["field-1"],
      rowSourceIds: ["answer-1"],
    },
  });
  assert.equal(complete.blockers.length, 0);
  assert.equal(complete.answers.length, 1);
  assert.equal("value" in complete.answers[0]!, false);
  assert.equal(complete.answers[0]!.valueKnowledge, "restricted");
  assert.equal(JSON.stringify(complete).includes("ANSWER_PII_CANARY"), false);
});

test("duplicate or conflicting application status mappings fail closed", () => {
  const snapshot = project(input({
    applications: [
      raw({ sourceId: "application-1", sourceCollection: "Applications", ProspectID: "prospect-1", Status: "submitted" }),
    ],
  }), {
    artifactSha256: ARTIFACT,
    statusCrosswalk: [
      { artifactSha256: ARTIFACT, sourceCollection: "Applications", sourceField: "Status", sourceValue: "submitted", targetStatus: "submitted" },
      { artifactSha256: ARTIFACT, sourceCollection: "Applications", sourceField: "Status", sourceValue: "submitted", targetStatus: "declined" },
    ],
  });
  assert.equal(snapshot.applications[0]!.status, null);
  assert.equal(snapshot.applications[0]!.statusKnowledge, "unknown");
});

test("raw note/body/communication prose and unbound activity types never enter the safe activity summary", () => {
  const snapshot = project(input({
    activities: [raw({
      sourceId: "activity-1",
      sourceCollection: "Communications",
      ApplicationID: "application-1",
      Type: "Email",
      Note: "RAW_NOTE_PII_CANARY",
      Body: "RAW_BODY_PII_CANARY",
      CommunicationBody: "RAW_COMMUNICATION_PII_CANARY",
      sourceKeyCanary: "RAW_SOURCE_KEY_CANARY",
    })],
  }));
  assert.equal(snapshot.activities.length, 1);
  // Exact allowlist normalization for a structural type is safe; free-text
  // body/note fields and actor identifiers remain restricted.
  assert.equal(snapshot.activities[0]!.type, "email");
  assert.equal(snapshot.activities[0]!.actor, null);
  assert.equal(snapshot.activities[0]!.summary, null);
  const safeJson = JSON.stringify(snapshot.activities);
  assert.equal(safeJson.includes("RAW_NOTE_PII_CANARY"), false);
  assert.equal(safeJson.includes("RAW_BODY_PII_CANARY"), false);
  assert.equal(safeJson.includes("RAW_COMMUNICATION_PII_CANARY"), false);
  assert.equal(safeJson.includes("RAW_SOURCE_KEY_CANARY"), false);
});

test("unlinked interests and answers stay out of parent-required arrays but remain counted", () => {
  const snapshot = project(input({
    interestedRentals: [
      raw({ sourceId: "interest-linked", ApplicationID: "application-1", SourceOrder: 1, Rent: "1250" }),
      raw({ sourceId: "interest-unlinked", SourceOrder: 2, Rent: "1250" }),
    ],
    applicationAnswerRecords: [
      raw({ sourceId: "answer-unlinked", FieldID: "field-unknown", Answer: "UNLINKED_ANSWER_CANARY" }),
    ],
  }));
  assert.equal(snapshot.interests.length, 1);
  assert.equal(snapshot.interests[0]!.source.sourceId.endsWith("interest-linked"), true);
  assert.notEqual(snapshot.interests[0]!.source.sourceId, "interest-linked");
  assert.equal(snapshot.unknownRestricted.unlinkedInterestCount, 1);
  assert.equal(snapshot.answers.length, 0);
  assert.equal(snapshot.unknownRestricted.unmappedAnswerCount, 1);
  assert.equal(JSON.stringify(snapshot).includes("UNLINKED_ANSWER_CANARY"), false);
  assert.equal(applicationHistoryCase(snapshot, snapshot.applications[0]!.id)!.interests.length, 1);
});

test("external links require both the injected target factory and matching source registry", () => {
  const source = input({
    prospects: [raw({ sourceId: "prospect-1", PersonID: "person-1", ContactID: "contact-1" })],
    applications: [raw({ sourceId: "application-1", ProspectID: "prospect-1", PersonID: "person-1" })],
    interestedRentals: [raw({ sourceId: "interest-1", ApplicationID: "application-1", PropertyID: "property-1", UnitID: "unit-1" })],
    applicationParticipants: [raw({ sourceId: "participant-1", ApplicationID: "application-1", PersonID: "person-1" })],
  });
  const factory = (entityType: string, sourceId: string) => `target:${entityType}:${sourceId}`;
  const registry = {
    person: new Map([["person-1", "target:person:person-1"]]),
    contact: new Map([["contact-1", "target:contact:contact-1"]]),
    property: new Map([["property-1", "target:property:property-1"]]),
    unit: new Map([["unit-1", "target:unit:unit-1"]]),
  } as const;

  const withoutEither = project(source);
  const withFactoryOnly = project(source, { targetIdFactory: factory });
  const withRegistryOnly = project(source, { targetSourceRegistry: registry });
  for (const candidate of [withoutEither, withFactoryOnly, withRegistryOnly]) {
    assert.equal(candidate.prospects[0]!.personId, undefined);
    assert.equal(candidate.interests[0]!.propertyId, undefined);
    assert.equal(candidate.participants[0]!.personId, undefined);
  }

  const exact = project(source, { targetIdFactory: factory, targetSourceRegistry: registry });
  assert.equal(exact.prospects[0]!.personId, "target:person:person-1");
  assert.equal(exact.prospects[0]!.contactId, "target:contact:contact-1");
  assert.equal(exact.interests[0]!.propertyId, "target:property:property-1");
  assert.equal(exact.interests[0]!.unitId, "target:unit:unit-1");
  assert.equal(exact.participants[0]!.personId, "target:person:person-1");
});

test("template, section, field, requirement, and document links use actual source maps", () => {
  const snapshot = project(input({
    applicationTemplates: [
      raw({ sourceId: "template-1", sourceCollection: "ApplicationTemplates", TemplateID: "template-1", Name: "Synthetic template" }),
      raw({ sourceId: "section-1", sourceCollection: "ApplicationTemplateSections", SectionID: "section-1", TemplateID: "template-1", Name: "Identity" }),
      raw({ sourceId: "field-1", sourceCollection: "ApplicationTemplateFields", FieldID: "field-1", TemplateID: "template-1", SectionID: "section-1", ValueType: "text" }),
    ],
    documents: [raw({ sourceId: "doc-1", sourceCollection: "Documents", DocumentID: "doc-1", ApplicationID: "application-1", FileName: "identity.pdf", MetadataAvailable: true })],
    documentBinaries: [{ sourceId: "doc-1", metadataAvailable: false, binaryAvailable: false, descriptorOnly: true }],
    applicationRequirements: [raw({ sourceId: "requirement-1", ApplicationID: "application-1", DocumentID: "doc-1", Label: "Identity" })],
    applicationAnswersCoverage: "complete",
  }));
  assert.equal(snapshot.templates.length, 1);
  assert.equal(snapshot.templateSections.length, 1);
  assert.equal(snapshot.templateFields.length, 1);
  assert.equal(snapshot.templateSections[0]!.templateId, snapshot.templates[0]!.id);
  assert.equal(snapshot.templateFields[0]!.templateId, snapshot.templates[0]!.id);
  assert.equal(snapshot.templateFields[0]!.sectionId, snapshot.templateSections[0]!.id);
  assert.equal(snapshot.documents.length, 1);
  assert.equal(snapshot.documents[0]!.availability, "unavailable");
  assert.notEqual(snapshot.documents[0]!.availability, "verified");
  assert.equal(snapshot.requirements[0]!.documentId, snapshot.documents[0]!.id);
  assert.equal(snapshot.requirements[0]!.documentLinkKnowledge, "exact");
});

test("occurrence IDs are deterministic when source rows are reordered", () => {
  const first = project(input({
    interestedRentals: [
      raw({ sourceId: "interest-a", ApplicationID: "application-1", SourceOrder: 1 }),
      raw({ sourceId: "interest-b", ApplicationID: "application-1", SourceOrder: 2 }),
    ],
  }));
  const reordered = project(input({
    interestedRentals: [
      raw({ sourceId: "interest-b", ApplicationID: "application-1", SourceOrder: 2 }),
      raw({ sourceId: "interest-a", ApplicationID: "application-1", SourceOrder: 1 }),
    ],
  }));
  const idsBySource = (snapshot: ReturnType<typeof project>) => new Map(snapshot.interests.map((row) => [row.source.sourceId, row.id]));
  assert.deepEqual(idsBySource(first), idsBySource(reordered));
  assert.deepEqual(first.interests.map((row) => row.sourceOrder), [1, 2]);
  assert.deepEqual(reordered.interests.map((row) => row.sourceOrder), [2, 1]);
});

test("Rent and RentCents dollar representations normalize to cents", () => {
  const snapshot = project(input({
    interestedRentals: [
      raw({ sourceId: "rent-number", ApplicationID: "application-1", Rent: 1250 }),
      raw({ sourceId: "rent-string", ApplicationID: "application-1", Rent: "1250" }),
      raw({ sourceId: "rent-cents-number", ApplicationID: "application-1", RentCents: 125000 }),
      raw({ sourceId: "rent-cents-string", ApplicationID: "application-1", RentCents: "125000" }),
    ],
  }));
  assert.deepEqual(snapshot.interests.map((row) => row.rentCents), [125000, 125000, 125000, 125000]);
});

test("artifact projection reuses exact mapped targets and returns aggregate-only blockers", () => {
  const factory = (entityType: string, sourceId: string) => `target:${entityType}:${sourceId}`;
  const payload = input({
    applications: [raw({ sourceId: "application-1", sourceCollection: "Applications", ProspectID: "prospect-1", Status: "Submitted" })],
    interestedRentals: [raw({ sourceId: "interest-1", ApplicationID: "application-1", PropertyID: "1" })],
    applicationTemplates: [raw({ sourceId: "field-1", sourceCollection: "ApplicationTemplateFields", FieldID: "field-1", ValueType: "text" })],
  });
  const sourceRecords = [{
    id: "source-property-1",
    system: "rent_manager",
    entityType: "property" as const,
    sourceId: "property:1",
    importedAt: "2026-08-17T00:00:00.000Z",
    targetId: factory("property", "property:1"),
  }, {
    id: "source-application-1",
    system: "rent_manager",
    entityType: "application" as const,
    sourceId: "application-1",
    importedAt: "2026-08-17T00:00:00.000Z",
    targetId: factory("application", "application-1"),
  }];
  const projected = projectApplicationHistoryForImport(payload, sourceRecords, {
    artifactSha256: ARTIFACT,
    targetIdFactory: factory,
    supplementApproved: false,
    statusCrosswalk: [{ artifactSha256: ARTIFACT, sourceCollection: "Applications", sourceField: "Status", sourceValue: "Submitted", targetStatus: "submitted" }],
  });
  assert.equal(projected.snapshot.interests[0]!.propertyId, factory("property", "property:1"));
  assert.equal(projected.snapshot.applications[0]!.id, factory("application", "application-1"));
  assert.equal(projected.snapshot.applications[0]!.status, "submitted");
  assert.deepEqual(projected.blockingCodes, ["application_answers_missing"]);
  assert.equal(JSON.stringify(projected.blockingCodes).includes("application-1"), false);
  assert.equal(JSON.stringify(projected.blockingCodes).includes("property:1"), false);
});

test("application cases never leak sibling application evidence through a shared prospect", () => {
  const snapshot = project(input({
    applications: [
      raw({ sourceId: "application-a", ProspectID: "prospect-1" }),
      raw({ sourceId: "application-b", ProspectID: "prospect-1" }),
    ],
    applicationRequirements: [
      raw({ sourceId: "requirement-a", ApplicationID: "application-a", ProspectID: "prospect-1", Label: "A only" }),
      raw({ sourceId: "requirement-b", ApplicationID: "application-b", ProspectID: "prospect-1", Label: "B only" }),
      raw({ sourceId: "requirement-prospect", ProspectID: "prospect-1", Label: "Prospect only" }),
    ],
  }));
  const applicationA = snapshot.applications.find((row) => row.source.sourceId.endsWith("application-a"));
  assert.ok(applicationA);
  const applicationCase = applicationHistoryCase(snapshot, applicationA.id);
  assert.ok(applicationCase);
  assert.deepEqual(applicationCase.requirements.map((row) => row.label), ["A only", "Prospect only"]);
});

test("template target identity stays collection-qualified when RM reuses a raw ID", () => {
  const snapshot = project(input({
    applicationTemplates: [
      raw({ sourceId: "1", sourceCollection: "ApplicationTemplateMajorSections", SectionID: "1", Name: "Major" }),
      raw({ sourceId: "1", sourceCollection: "ApplicationTemplateMinorSections", SectionID: "1", Name: "Minor" }),
    ],
  }));
  assert.equal(snapshot.templateSections.length, 2);
  assert.notEqual(snapshot.templateSections[0]!.id, snapshot.templateSections[1]!.id);
  assert.notEqual(snapshot.templateSections[0]!.source.sourceId, snapshot.templateSections[1]!.source.sourceId);
});
