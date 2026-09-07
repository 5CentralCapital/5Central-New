import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExportEnvelope, RedactedExportManifest } from "../export/types";
import { canonicalJson, sha256 } from "../export/hash";
import {
  buildRestrictedSupplement,
  RestrictedSupplementIntegrityError,
  restrictedSupplementSourceSha256,
  type RestrictedSupplementOperatorAttestation,
  type RestrictedSupplementRequest,
  type RestrictedSupplementRow,
} from "./restricted-supplement";

const RUN_ID = "rm-full-test-1";
const OPERATOR = "operator:fixture";
const VERIFIED_AT = "2026-08-17T12:00:00.000Z";

function baseEnvelope(): ExportEnvelope {
  return {
    version: "rm-export/v2",
    runId: RUN_ID,
    source: { system: "rent_manager", transport: "injected", readOnly: true },
    createdAt: "2026-08-17T11:00:00.000Z",
    payload: {
      properties: [{ entityType: "property", sourceId: "property-1", PropertyName: "Synthetic Property" }],
      applications: [{ entityType: "application", sourceId: "application-1", Status: "Submitted" }],
      applicationTemplates: [{ entityType: "application_template_field", sourceId: "field-1" }],
      subsidies: [],
      documentBinaryDescriptors: [],
    },
    documentBinaries: [],
  };
}

function baseManifest(envelope: ExportEnvelope): RedactedExportManifest {
  return {
    version: "rm-export-manifest/v2",
    runId: envelope.runId,
    source: "rent_manager",
    createdAt: envelope.createdAt,
    registryHash: "a".repeat(64),
    archiveEnvelopeSha256: sha256(canonicalJson(envelope)),
    complete: true,
    rawArchive: { relativePath: "export-envelope.json", mode: "0600", directoryMode: "0700" },
    counts: { properties: 1, applications: 1, applicationTemplates: 1, subsidies: 0, documentBinaryDescriptors: 0, documentBinaries: 0 },
    collections: [
      { name: "properties", path: "/Properties", outputKey: "properties", kind: "collection", required: true, status: "complete", pages: 1, requested: 1, received: 1, expected: 1, recordHashes: ["p".repeat(64)], errors: [], exceptions: [] },
      { name: "applications", path: "/ProspectApplications", outputKey: "applications", kind: "collection", required: true, status: "complete", pages: 1, requested: 1, received: 1, expected: 1, recordHashes: ["a".repeat(64)], errors: [], exceptions: [] },
      { name: "subsidies", path: "/Subsidies", outputKey: "subsidies", kind: "collection", required: true, status: "empty", pages: 1, requested: 0, received: 0, expected: 0, recordHashes: [], errors: [], exceptions: [] },
      { name: "signableDocuments", path: "/SignableDocuments", outputKey: "documentBinaryDescriptors", kind: "collection", required: true, status: "empty", pages: 1, requested: 0, received: 0, expected: 0, recordHashes: [], errors: [], exceptions: [], documentMode: "binary_descriptor" },
    ],
    errors: [],
    exceptions: [],
    documentBinarySummary: { metadataCount: 0, binaryAvailableCount: 0, descriptorOnlyCount: 0 },
  };
}

function attestation(kinds: RestrictedSupplementOperatorAttestation["kinds"]): RestrictedSupplementOperatorAttestation {
  return {
    attestationId: "attestation-1",
    sourceRunId: RUN_ID,
    sourceReference: "private/evidence/operator-attestation.json",
    sourceSha256: "e".repeat(64),
    verifiedAt: VERIFIED_AT,
    operatorReference: OPERATOR,
    evidenceType: "independent_evidence_attestation",
    kinds,
  };
}

function applicationRow(sourceId = "answer-1"): RestrictedSupplementRow {
  const row = {
    sourceCollection: "ApplicationAnswers",
    sourceId,
    sourceUpdatedAt: VERIFIED_AT,
    sourceReference: `private/evidence/${sourceId}.json`,
    sourceSha256: "0".repeat(64),
    operatorReference: OPERATOR,
    parentSourceCollection: "Application",
    parentSourceId: "application-1",
    record: { entityType: "application_answer", sourceId, ApplicationID: "application-1", Answer: "sensitive applicant answer" },
  };
  row.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "application_answers",
    evidence: {
      sourceCollection: row.sourceCollection,
      sourceId: row.sourceId,
      sourceUpdatedAt: row.sourceUpdatedAt,
      sourceReference: row.sourceReference,
      operatorReference: row.operatorReference,
      parentSourceCollection: "Application",
      parentSourceId: "application-1",
      sourceFileDescriptor: { reference: row.sourceReference },
    },
    payload: row.record,
    attestation: { attestationId: "attestation-1", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
  });
  return row;
}

function request(overrides: Partial<RestrictedSupplementRequest> = {}): RestrictedSupplementRequest {
  const envelope = baseEnvelope();
  return {
    envelope,
    manifest: baseManifest(envelope),
    operatorAttestation: attestation(["application_answers"]),
    applicationAnswers: [applicationRow()],
    ...overrides,
  };
}

function applicationStatusCrosswalk(artifactSha256 = "a".repeat(64)) {
  return [{
    artifactSha256,
    sourceCollection: "prospectApplications" as const,
    sourceField: "Status" as const,
    sourceValue: "Submitted",
    targetStatus: "submitted" as const,
  }];
}

function crosswalkRequest(overrides: Partial<RestrictedSupplementRequest> = {}): RestrictedSupplementRequest {
  const envelope = baseEnvelope();
  envelope.payload.artifactSha256 = "a".repeat(64);
  const manifest = baseManifest(envelope);
  return request({
    envelope,
    manifest,
    applicationHistoryStatusCrosswalk: applicationStatusCrosswalk(),
    ...overrides,
  });
}

function collectorCrosswalkRequest(): RestrictedSupplementRequest {
  const envelope = baseEnvelope();
  const manifest = baseManifest(envelope);
  return request({
    envelope,
    manifest,
    applicationHistoryStatusCrosswalk: applicationStatusCrosswalk(sha256(canonicalJson(envelope))),
  });
}

test("supplement binds the original run/digests and does not mutate the base objects", () => {
  const envelope = baseEnvelope();
  const manifest = baseManifest(envelope);
  const beforeEnvelope = structuredClone(envelope);
  const beforeManifest = structuredClone(manifest);
  const result = buildRestrictedSupplement(request({ envelope, manifest }));

  assert.deepEqual(envelope, beforeEnvelope);
  assert.deepEqual(manifest, beforeManifest);
  assert.equal(result.report.originalEnvelopeSha256, sha256(canonicalJson(envelope)));
  assert.equal(result.report.sourceRunId, RUN_ID);
  assert.equal(result.manifest.archiveEnvelopeSha256, result.report.derivativeEnvelopeSha256);
  assert.equal(result.envelope.payload.applicationAnswerRecords?.length, 1);
  assert.equal(result.manifest.counts.applicationAnswerRecords, 1);
  assert.equal(result.report.manifestComplete, true);
});

test("status crosswalk is exact, parent-artifact-bound, canonical, and kept out of aggregate report output", () => {
  const result = buildRestrictedSupplement(crosswalkRequest());
  assert.deepEqual(result.envelope.payload.applicationHistoryStatusCrosswalk, applicationStatusCrosswalk());
  assert.match(result.report.supplementSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.report.attestationSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.report.rowSetSha256 ?? "", /^[a-f0-9]{64}$/u);
  const reportText = JSON.stringify(result.report);
  assert.equal(reportText.includes("Submitted"), false);
  assert.equal(reportText.includes("prospectApplications"), false);
  assert.equal(reportText.includes("application-1"), false);

  const changed = buildRestrictedSupplement(crosswalkRequest({
    applicationHistoryStatusCrosswalk: [{ ...applicationStatusCrosswalk()[0]!, targetStatus: "declined" }],
  }));
  assert.notEqual(changed.report.rowSetSha256, result.report.rowSetSha256);
  assert.notEqual(changed.report.supplementSha256, result.report.supplementSha256);
  assert.notEqual(changed.report.attestationSha256, result.report.attestationSha256);

  const reordered = buildRestrictedSupplement(crosswalkRequest({
    applicationHistoryStatusCrosswalk: [...applicationStatusCrosswalk(), {
      artifactSha256: "a".repeat(64),
      sourceCollection: "prospectApplications",
      sourceField: "ApplicationStatus",
      sourceValue: "Under Review",
      targetStatus: "under_review",
    }],
  }));
  const reversed = buildRestrictedSupplement(crosswalkRequest({
    applicationHistoryStatusCrosswalk: [
      {
        artifactSha256: "a".repeat(64),
        sourceCollection: "prospectApplications",
        sourceField: "ApplicationStatus",
        sourceValue: "Under Review",
        targetStatus: "under_review",
      },
      ...applicationStatusCrosswalk(),
    ],
  }));
  assert.equal(canonicalJson(reordered.envelope), canonicalJson(reversed.envelope));
  assert.equal(canonicalJson(reordered.report), canonicalJson(reversed.report));
});

test("status crosswalk binds a collector-shaped parent envelope and rejects wrong artifact/domain/duplicate claims", () => {
  const collectorResult = buildRestrictedSupplement(collectorCrosswalkRequest());
  assert.equal(collectorResult.envelope.payload.artifactSha256, sha256(canonicalJson(collectorCrosswalkRequest().envelope)));
  const invalidCases: Array<{ entry: Record<string, unknown>; reason: string }> = [
    { entry: { ...applicationStatusCrosswalk()[0], artifactSha256: "b".repeat(64) }, reason: "application_status_crosswalk_artifact_mismatch" },
    { entry: { ...applicationStatusCrosswalk()[0], sourceCollection: "Applications" }, reason: "application_status_crosswalk_collection_unsupported" },
    { entry: { ...applicationStatusCrosswalk()[0], sourceField: "CreatedDate" }, reason: "application_status_crosswalk_field_unsupported" },
    { entry: { ...applicationStatusCrosswalk()[0], targetStatus: "unknown" }, reason: "application_status_crosswalk_target_unsupported" },
    { entry: { ...applicationStatusCrosswalk()[0], sourceValue: "*" }, reason: "application_status_crosswalk_source_value_pattern_invalid" },
  ];
  for (const { entry, reason } of invalidCases) {
    assert.throws(
      () => buildRestrictedSupplement(crosswalkRequest({ applicationHistoryStatusCrosswalk: [entry] as never })),
      (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes(reason),
    );
  }
  const duplicate = applicationStatusCrosswalk();
  assert.throws(
    () => buildRestrictedSupplement(crosswalkRequest({ applicationHistoryStatusCrosswalk: [...duplicate, ...duplicate] })),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("application_status_crosswalk_duplicate"),
  );
  const conflict = [...applicationStatusCrosswalk(), { ...applicationStatusCrosswalk()[0]!, targetStatus: "declined" as const }];
  assert.throws(
    () => buildRestrictedSupplement(crosswalkRequest({ applicationHistoryStatusCrosswalk: conflict })),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("application_status_crosswalk_conflict"),
  );
});

test("tampered envelope/manifest binding and source run are rejected with redacted reasons", () => {
  const original = request();
  const tamperedEnvelope = structuredClone(original.envelope);
  tamperedEnvelope.payload.properties![0].PropertyName = "private applicant name";
  assert.throws(
    () => buildRestrictedSupplement({ ...original, envelope: tamperedEnvelope }),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("base_envelope_digest_mismatch") && !error.message.includes("private applicant name"),
  );

  const tamperedManifest = structuredClone(original.manifest);
  tamperedManifest.runId = "different-run";
  assert.throws(
    () => buildRestrictedSupplement({ ...original, manifest: tamperedManifest }),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("source_run_binding_invalid"),
  );
});

test("application and HAP rows cannot be self-attested without a valid evidence attestation", () => {
  const invalid = request({ operatorAttestation: { verifiedSource: true } as unknown as RestrictedSupplementOperatorAttestation });
  assert.throws(
    () => buildRestrictedSupplement(invalid),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("evidence_attestation_unsupported_field"),
  );

  const hapRow = { ...applicationRow("hap-1"), sourceCollection: "Subsidies", record: { entityType: "subsidy", sourceId: "hap-1", AgencyName: "Housing Authority" } };
  hapRow.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "hap_subsidies",
    evidence: {
      sourceCollection: hapRow.sourceCollection,
      sourceId: hapRow.sourceId,
      sourceUpdatedAt: hapRow.sourceUpdatedAt,
      sourceReference: hapRow.sourceReference,
      operatorReference: hapRow.operatorReference,
      parentSourceCollection: hapRow.parentSourceCollection,
      parentSourceId: hapRow.parentSourceId,
      sourceFileDescriptor: { reference: hapRow.sourceReference },
    },
    payload: hapRow.record,
    attestation: { attestationId: "attestation-1", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
  });
  const hapRequest = request({
    applicationAnswers: undefined,
    hapSubsidies: [hapRow],
    operatorAttestation: attestation(["hap_subsidies"]),
  });
  const result = buildRestrictedSupplement(hapRequest);
  assert.equal(result.envelope.payload.subsidies?.length, 1);
  assert.equal(result.report.countsAdded.hap_subsidies, 1);
});

test("supplement order is canonical and report never contains raw PII", () => {
  const first = applicationRow("answer-a");
  const second = applicationRow("answer-b");
  first.record.Answer = "FIRST SECRET SSN 111-22-3333";
  second.record.Answer = "SECOND SECRET EMAIL private@example.test";
  first.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "application_answers",
    evidence: { sourceCollection: first.sourceCollection, sourceId: first.sourceId, sourceUpdatedAt: first.sourceUpdatedAt, sourceReference: first.sourceReference, operatorReference: first.operatorReference, parentSourceCollection: first.parentSourceCollection, parentSourceId: first.parentSourceId, sourceFileDescriptor: { reference: first.sourceReference } },
    payload: first.record,
    attestation: { attestationId: "attestation-1", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
  });
  second.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "application_answers",
    evidence: { sourceCollection: second.sourceCollection, sourceId: second.sourceId, sourceUpdatedAt: second.sourceUpdatedAt, sourceReference: second.sourceReference, operatorReference: second.operatorReference, parentSourceCollection: second.parentSourceCollection, parentSourceId: second.parentSourceId, sourceFileDescriptor: { reference: second.sourceReference } },
    payload: second.record,
    attestation: { attestationId: "attestation-1", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
  });
  const left = request({ applicationAnswers: [second, first] });
  const right = request({ applicationAnswers: [first, second] });
  const resultLeft = buildRestrictedSupplement(left);
  const resultRight = buildRestrictedSupplement(right);

  assert.equal(canonicalJson(resultLeft.envelope), canonicalJson(resultRight.envelope));
  assert.equal(canonicalJson(resultLeft.manifest), canonicalJson(resultRight.manifest));
  assert.equal(canonicalJson(resultLeft.report), canonicalJson(resultRight.report));
  const reportText = JSON.stringify(resultLeft.report);
  assert.equal(reportText.includes("FIRST SECRET"), false);
  assert.equal(reportText.includes("private@example.test"), false);
  assert.equal(reportText.includes("111-22-3333"), false);
});

test("binary supplements require a private archive path and matching bytes hash/size", () => {
  const bytes = new TextEncoder().encode("private pdf bytes");
  const checksum = sha256(bytes);
  const binary = {
    sourceCollection: "SignableDocuments",
    sourceId: "document-1",
    sourceUpdatedAt: VERIFIED_AT,
    sourceReference: "private/evidence/document-1.json",
    sourceSha256: "0".repeat(64),
    operatorReference: OPERATOR,
    descriptor: {
      sourceId: "document-1",
      metadataAvailable: true,
      binaryAvailable: true,
      descriptorOnly: false,
      contentType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256: checksum,
      archivePath: `binaries/${checksum}.bin`,
      availabilityReason: "archived" as const,
    },
    bytes,
  };
  binary.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "document_binaries",
    evidence: {
      sourceCollection: binary.sourceCollection,
      sourceId: binary.sourceId,
      sourceUpdatedAt: binary.sourceUpdatedAt,
      sourceReference: binary.sourceReference,
      operatorReference: binary.operatorReference,
      sourceFileDescriptor: { reference: binary.sourceReference, path: binary.descriptor.archivePath, sha256: checksum, sizeBytes: bytes.byteLength, contentType: "application/pdf" },
    },
    payload: binary.descriptor,
    attestation: { attestationId: "attestation-1", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
    bytes: { sha256: checksum, sizeBytes: bytes.byteLength },
  });
  const result = buildRestrictedSupplement(request({ applicationAnswers: undefined, documentBinaries: [binary], operatorAttestation: attestation(["document_binaries"]) }));
  assert.equal(result.envelope.documentBinaries.length, 1);
  assert.equal(result.manifest.documentBinarySummary.binaryAvailableCount, 1);

  const bad = structuredClone(binary);
  bad.descriptor.sha256 = "c".repeat(64);
  assert.throws(
    () => buildRestrictedSupplement(request({ applicationAnswers: undefined, documentBinaries: [bad], operatorAttestation: attestation(["document_binaries"]) })),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("supplement_binary_content_mismatch"),
  );
});

test("duplicate and unsupported supplement fields fail closed", () => {
  assert.throws(
    () => buildRestrictedSupplement(request({ applicationAnswers: [applicationRow(), applicationRow()] })),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("supplement_duplicate_row"),
  );
  assert.throws(
    () => buildRestrictedSupplement({ ...request(), unsupported: "nope" } as unknown as RestrictedSupplementRequest),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("supplement_request_unsupported_field"),
  );
});

test("supplement reuses the recursive credential boundary while retaining restricted SSN/DOB facts", () => {
  const credentialRow = applicationRow("credential-answer");
  (credentialRow.record as Record<string, unknown>).nestedProfile = { credentials: { password: "synthetic-secret" } };
  assert.throws(
    () => buildRestrictedSupplement(request({ applicationAnswers: [credentialRow] })),
    (error: unknown) => error instanceof RestrictedSupplementIntegrityError
      && error.reasons.includes("credential_field_rejected")
      && !error.message.includes("synthetic-secret"),
  );

  const restrictedRow = applicationRow("restricted-answer");
  (restrictedRow.record as Record<string, unknown>).SSN = "000-00-0000";
  (restrictedRow.record as Record<string, unknown>).DOB = "2000-01-01";
  restrictedRow.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "application_answers",
    evidence: {
      sourceCollection: restrictedRow.sourceCollection,
      sourceId: restrictedRow.sourceId,
      sourceUpdatedAt: restrictedRow.sourceUpdatedAt,
      sourceReference: restrictedRow.sourceReference,
      operatorReference: restrictedRow.operatorReference,
      parentSourceCollection: restrictedRow.parentSourceCollection,
      parentSourceId: restrictedRow.parentSourceId,
      sourceFileDescriptor: { reference: restrictedRow.sourceReference },
    },
    payload: restrictedRow.record,
    attestation: { attestationId: "attestation-1", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
  });
  const result = buildRestrictedSupplement(request({ applicationAnswers: [restrictedRow] }));
  assert.equal(result.report.countsAdded.application_answers, 1);
});

test("source binding rejects value, parent, field, and file-descriptor mutations", () => {
  const original = applicationRow("bound-answer");
  const cases = [
    (row: RestrictedSupplementRow) => { row.record.Answer = "changed answer"; },
    (row: RestrictedSupplementRow) => { row.parentSourceId = "different-parent"; },
    (row: RestrictedSupplementRow) => { row.fieldIdentity = { id: "different-field" }; },
    (row: RestrictedSupplementRow) => { row.sourceFileDescriptor = { reference: "private/evidence/other.json" }; },
    (row: RestrictedSupplementRow) => { row.sourceSha256 = "f".repeat(64); },
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.throws(
      () => buildRestrictedSupplement(request({ applicationAnswers: [candidate] })),
      (error: unknown) => error instanceof RestrictedSupplementIntegrityError && error.reasons.includes("supplement_source_hash_mismatch"),
    );
  }
});

test("only the exact bound missing-source exception is removed", () => {
  const row = applicationRow("exception-answer");
  const exactHash = `id_${sha256(row.sourceId).slice(0, 16)}`;
  const manifest = baseManifest(baseEnvelope());
  manifest.collections[0]!.name = "ApplicationAnswers";
  manifest.collections[0]!.errors = ["unsupported_endpoint_notice"];
  manifest.collections[0]!.exceptions = [
    { code: "missing_source_id", collection: row.sourceCollection, sourceIdHash: exactHash, detail: "record_source_id_missing" },
    { code: "binary_unavailable", collection: row.sourceCollection, sourceIdHash: exactHash, detail: "binary_descriptor_without_archived_binary" },
    { code: "missing_source_id", collection: row.sourceCollection, sourceIdHash: `id_${sha256("other").slice(0, 16)}`, detail: "record_source_id_missing" },
    { code: "missing_source_id", collection: "ApplicationAnswersLegacy", sourceIdHash: exactHash, detail: "record_source_id_missing" },
  ];
  manifest.exceptions = [
    { code: "missing_source_id", collection: row.sourceCollection, sourceIdHash: exactHash, detail: "record_source_id_missing" },
    { code: "incomplete_coverage", collection: row.sourceCollection, detail: "count_mismatch" },
  ];
  const result = buildRestrictedSupplement({ ...request({ manifest, applicationAnswers: [row] }) });
  const collectionExceptions = result.manifest.collections[0]!.exceptions;
  assert.equal(collectionExceptions.some((item) => item.code === "missing_source_id" && item.collection === row.sourceCollection && item.sourceIdHash === exactHash && item.detail === "record_source_id_missing"), false);
  assert.equal(collectionExceptions.some((item) => item.code === "binary_unavailable"), true);
  assert.equal(collectionExceptions.some((item) => item.sourceIdHash === `id_${sha256("other").slice(0, 16)}`), true);
  assert.equal(collectionExceptions.some((item) => item.collection === "ApplicationAnswersLegacy" && item.sourceIdHash === exactHash), true);
  assert.equal(result.manifest.collections[0]!.errors.includes("unsupported_endpoint_notice"), true);
  assert.equal(result.manifest.exceptions.some((item) => item.code === "missing_source_id"), false);
  assert.equal(result.manifest.exceptions.some((item) => item.code === "incomplete_coverage"), true);
  assert.equal(result.report.exceptionsRemoved, 2);
});
