import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRestrictedArchive } from "../export/archive";
import { syntheticFinancialSemanticCrosswalk } from "../export/fixtures";
import type { ExportEnvelope, RedactedExportManifest } from "../export/types";
import { canonicalJson, hashRecord, sha256 } from "../export/hash";
import {
  restrictedSupplementSourceSha256,
  type RestrictedSupplementOperatorAttestation,
  type RestrictedSupplementRequest,
} from "./restricted-supplement";
import {
  applyRestrictedSupplementPackage,
  binaryDescriptors,
  RESTRICTED_SUPPLEMENT_PACKAGE_VERSION,
  RESTRICTED_SUPPLEMENT_PROVENANCE_FILE,
  RestrictedSupplementDerivativeArchiveError,
  writeRestrictedSupplementDerivativeArchive,
} from "./restricted-supplement-archive";
import { readRestrictedMigrationArchive, runRestrictedMigrationArchive } from "./migration-runner";
import { buildRentManagerMigrationArtifact } from "./migration-artifact";
import { createKeyedTargetIdFactory } from "./rm-mapper";
import { runRestrictedMigrationArchiveOrchestration } from "./restricted-orchestration";

const HISTORY_TARGET_IDENTITY = { keyId: "history-test-key", keyVersion: "v3-history" } as const;
const HISTORY_TARGET_FACTORY = createKeyedTargetIdFactory("history-test-key-material", HISTORY_TARGET_IDENTITY).factory;

const RUN_ID = "synthetic-archive-run";
const OPERATOR = "operator:synthetic";
const VERIFIED_AT = "2026-08-17T12:00:00.000Z";

const externalVerifier = async (input: { sourceRunId: string; parentEnvelopeSha256: string; parentManifestSha256: string; supplementSha256: string; attestationSha256: string; rowSetSha256: string; derivativeEnvelopeSha256: string; derivativeManifestSha256: string }) => {
  assert.equal(input.sourceRunId, RUN_ID);
  for (const value of Object.values(input).slice(1)) assert.match(value, /^[a-f0-9]{64}$/u);
  return { verified: true as const, receiptId: "external-receipt-synthetic" };
};

const supplementReceiptVerifier = async (input: { sourceRunId: string; parentEnvelopeSha256: string; parentManifestSha256: string; supplementSha256: string; attestationSha256: string; rowSetSha256: string; derivativeEnvelopeSha256: string; derivativeManifestSha256: string }) => {
  assert.equal(input.sourceRunId, RUN_ID);
  for (const value of Object.values(input).slice(1)) assert.match(value, /^[a-f0-9]{64}$/u);
  return { verified: true as const, externalVerificationIdHash: sha256("external-receipt-synthetic") };
};

function envelope(): ExportEnvelope {
  return {
    version: "rm-export/v2",
    runId: RUN_ID,
    source: { system: "rent_manager", transport: "injected", readOnly: true },
    createdAt: "2026-08-17T11:00:00.000Z",
    payload: { properties: [{ entityType: "property", sourceId: "synthetic-property" }], applications: [], applicationTemplates: [], subsidies: [], documentBinaryDescriptors: [], documentBinaries: [] },
    documentBinaries: [],
  };
}

function manifestFor(value: ExportEnvelope): RedactedExportManifest {
  return {
    version: "rm-export-manifest/v2",
    runId: value.runId,
    source: "rent_manager",
    createdAt: value.createdAt,
    registryHash: "a".repeat(64),
    archiveEnvelopeSha256: sha256(canonicalJson(value)),
    complete: true,
    rawArchive: { relativePath: "export-envelope.json", mode: "0600", directoryMode: "0700" },
    counts: { properties: 1, applications: 0, applicationTemplates: 0, subsidies: 0, documentBinaryDescriptors: 0, documentBinaries: 0 },
    collections: [{ name: "properties", path: "/Properties", outputKey: "properties", kind: "collection", required: true, status: "complete", pages: 1, requested: 1, received: 1, expected: 1, recordHashes: [hashRecord({ entityType: "property", sourceId: "synthetic-property" })], errors: [], exceptions: [] }],
    errors: [],
    exceptions: [],
    documentBinarySummary: { metadataCount: 0, binaryAvailableCount: 0, descriptorOnlyCount: 0 },
  };
}

function attestation(kinds: RestrictedSupplementOperatorAttestation["kinds"]): RestrictedSupplementOperatorAttestation {
  return { attestationId: "synthetic-attestation", sourceRunId: RUN_ID, sourceReference: "private/synthetic-attestation.json", sourceSha256: "e".repeat(64), verifiedAt: VERIFIED_AT, operatorReference: OPERATOR, evidenceType: "independent_evidence_attestation", kinds };
}

function supplementRow() {
  const row = {
    sourceCollection: "ApplicationAnswers",
    sourceId: "synthetic-answer",
    sourceUpdatedAt: VERIFIED_AT,
    sourceReference: "private/synthetic-answer.json",
    sourceSha256: "0".repeat(64),
    operatorReference: OPERATOR,
    parentSourceCollection: "Application",
    parentSourceId: "synthetic-application",
    record: { entityType: "application_answer", sourceId: "synthetic-answer", ApplicationID: "synthetic-application", Answer: "synthetic restricted value" },
  };
  row.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "application_answers",
    evidence: { sourceCollection: row.sourceCollection, sourceId: row.sourceId, sourceUpdatedAt: row.sourceUpdatedAt, sourceReference: row.sourceReference, operatorReference: row.operatorReference, parentSourceCollection: row.parentSourceCollection, parentSourceId: row.parentSourceId, sourceFileDescriptor: { reference: row.sourceReference } },
    payload: row.record,
    attestation: { attestationId: "synthetic-attestation", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
  });
  return row;
}

function packageFor(value: ExportEnvelope, manifest: RedactedExportManifest): unknown {
  return {
    version: RESTRICTED_SUPPLEMENT_PACKAGE_VERSION,
    envelope: value,
    manifest,
    operatorAttestation: attestation(["application_answers"]),
    applicationAnswers: [supplementRow()],
    approval: { approved: true, approvalId: "approval-synthetic", approvedAt: VERIFIED_AT, operatorReference: OPERATOR, gate: "restricted_supplement_apply", gateNonce: "nonce-synthetic", gateMetadata: { reason: "synthetic-test" } },
  };
}

function applicationStatusCrosswalk(artifactSha256 = "a".repeat(64)) {
  return [{ artifactSha256, sourceCollection: "prospectApplications", sourceField: "Status", sourceValue: "Submitted", targetStatus: "submitted" }];
}

function applicationHistorySupplementRow() {
  const record = {
    entityType: "application_answer",
    sourceCollection: "ApplicationAnswers",
    sourceId: "history-answer-1",
    ProspectApplicationID: 1801,
    ApplicationFieldID: "email",
    FieldName: "email",
    Answer: "tenant-201@example.test",
  };
  const row = {
    sourceCollection: "ApplicationAnswers",
    sourceId: "history-answer-1",
    sourceUpdatedAt: VERIFIED_AT,
    sourceReference: "private/synthetic-history-answer.json",
    sourceSha256: "0".repeat(64),
    operatorReference: OPERATOR,
    parentSourceCollection: "prospectApplications",
    parentSourceId: "1801",
    fieldIdentity: { id: "email" },
    record,
  };
  row.sourceSha256 = restrictedSupplementSourceSha256({
    kind: "application_answers",
    evidence: {
      sourceCollection: row.sourceCollection,
      sourceId: row.sourceId,
      sourceUpdatedAt: row.sourceUpdatedAt,
      sourceReference: row.sourceReference,
      operatorReference: row.operatorReference,
      parentSourceCollection: row.parentSourceCollection,
      parentSourceId: row.parentSourceId,
      fieldIdentity: row.fieldIdentity,
      sourceFileDescriptor: { reference: row.sourceReference },
    },
    payload: row.record,
    attestation: { attestationId: "synthetic-attestation", sourceSha256: "e".repeat(64), operatorReference: OPERATOR },
  });
  return row;
}

async function createApplicationHistoryFixture(): Promise<{ parent: string; source: string; derivative: string; envelope: ExportEnvelope; manifest: RedactedExportManifest }> {
  const parent = await mkdtemp(join(tmpdir(), "restricted-supplement-history-"));
  const source = join(parent, "source");
  const derivative = join(parent, "derivative");
  const archive = await createRestrictedArchive(source);
  const property = { entityType: "property", sourceId: "history-property", sourceCollection: "properties", PropertyID: 1, PropertyName: "History Test Property", Address: { Line1: "1 Example St", City: "Exampleville", State: "FL", Zip: "00001" }, Status: "Active", IsArchived: false };
  const application = { entityType: "application", sourceId: "prospect_application:1801", sourceCollection: "prospectApplications", ProspectApplicationID: 1801, FirstName: "Synthetic", LastName: "Applicant", Email: "tenant-201@example.test", Status: "Submitted", CreatedDate: "2026-08-01T12:00:00.000Z", UpdatedDate: "2026-08-02T12:00:00.000Z" };
  const templateField = { entityType: "application_template_field", sourceId: "email", sourceCollection: "prospectApplicationTemplateFields", ApplicationTemplateFieldID: "email", FieldName: "email", FieldType: "text", Sensitive: false };
  const envelope: ExportEnvelope = {
    version: "rm-export/v2",
    runId: "history-archive-run",
    source: { system: "rent_manager", transport: "injected", readOnly: true },
    createdAt: "2026-08-17T11:00:00.000Z",
    artifactObservationOn: "2026-08-17",
    payload: { properties: [property], applications: [application], applicationTemplates: [templateField], subsidies: [], subsidyTenants: [], subsidyPayments: [], artifactSha256: "a".repeat(64), financialSemanticCrosswalk: syntheticFinancialSemanticCrosswalk() },
    documentBinaries: [],
  };
  const propertyPage = await archive.writePage("properties", 1, [property]);
  const applicationPage = await archive.writePage("prospectApplications", 1, [application]);
  const templateFieldPage = await archive.writePage("prospectApplicationTemplateFields", 1, [templateField]);
  const registryHash = "b".repeat(64);
  const manifest: RedactedExportManifest = {
    version: "rm-export-manifest/v2",
    runId: envelope.runId,
    source: "rent_manager",
    createdAt: envelope.createdAt,
    registryHash,
    archiveEnvelopeSha256: sha256(canonicalJson(envelope)),
    artifactObservationOn: "2026-08-17",
    complete: true,
    rawArchive: { relativePath: "export-envelope.json", mode: "0600", directoryMode: "0700" },
    counts: { properties: 1, applications: 1, applicationTemplates: 1, subsidies: 0, subsidyTenants: 0, subsidyPayments: 0 },
    collections: [
      { name: "properties", path: "/Properties", outputKey: "properties", kind: "collection", required: true, status: "complete", pages: 1, requested: 1, received: 1, expected: 1, recordHashes: [hashRecord(property)], errors: [], exceptions: [] },
      { name: "prospectApplications", path: "/ProspectApplications", outputKey: "applications", kind: "collection", required: true, status: "complete", pages: 1, requested: 1, received: 1, expected: 1, recordHashes: [hashRecord(application)], errors: [], exceptions: [] },
      { name: "prospectApplicationTemplateFields", path: "/ProspectApplicationTemplateFields", outputKey: "applicationTemplates", kind: "collection", required: true, status: "complete", pages: 1, requested: 1, received: 1, expected: 1, recordHashes: [hashRecord(templateField)], errors: [], exceptions: [] },
      { name: "subsidies", path: "/Subsidies", outputKey: "subsidies", kind: "collection", required: true, status: "empty", pages: 0, requested: 0, received: 0, expected: 0, recordHashes: [], errors: [], exceptions: [] },
      { name: "subsidyTenants", path: "/SubsidyTenants", outputKey: "subsidyTenants", kind: "collection", required: true, status: "empty", pages: 0, requested: 0, received: 0, expected: 0, recordHashes: [], errors: [], exceptions: [] },
      { name: "subsidyPayments", path: "/SubsidyPayments", outputKey: "subsidyPayments", kind: "collection", required: true, status: "empty", pages: 0, requested: 0, received: 0, expected: 0, recordHashes: [], errors: [], exceptions: [] },
    ],
    errors: [],
    exceptions: [],
    documentBinarySummary: { metadataCount: 0, binaryAvailableCount: 0, descriptorOnlyCount: 0 },
  };
  await archive.writeEnvelope(envelope);
  await archive.writeManifest(manifest);
  await archive.writeCheckpoint({
    version: 2,
    runId: envelope.runId,
    registryHash,
    startedAt: envelope.createdAt,
    updatedAt: envelope.createdAt,
    requestCount: 3,
    complete: true,
    collections: {
      properties: { nextPage: 2, nextParentIndex: 0, parentIds: [], pageSize: 100, pages: 1, received: 1, hashes: [hashRecord(property)], pageFiles: [propertyPage], status: "complete", errors: [], exceptions: [] },
      prospectApplications: { nextPage: 2, nextParentIndex: 0, parentIds: [], pageSize: 100, pages: 1, received: 1, hashes: [hashRecord(application)], pageFiles: [applicationPage], status: "complete", errors: [], exceptions: [] },
      prospectApplicationTemplateFields: { nextPage: 2, nextParentIndex: 0, parentIds: [], pageSize: 100, pages: 1, received: 1, hashes: [hashRecord(templateField)], pageFiles: [templateFieldPage], status: "complete", errors: [], exceptions: [] },
      subsidies: { nextPage: 1, nextParentIndex: 0, parentIds: [], pageSize: 100, pages: 0, received: 0, hashes: [], pageFiles: [], status: "complete", errors: [], exceptions: [] },
      subsidyTenants: { nextPage: 1, nextParentIndex: 0, parentIds: [], pageSize: 100, pages: 0, received: 0, hashes: [], pageFiles: [], status: "complete", errors: [], exceptions: [] },
      subsidyPayments: { nextPage: 1, nextParentIndex: 0, parentIds: [], pageSize: 100, pages: 0, received: 0, hashes: [], pageFiles: [], status: "complete", errors: [], exceptions: [] },
    },
  });
  await archive.writeCoverage(manifest.collections);
  return { parent, source, derivative, envelope, manifest };
}

async function createFixture(): Promise<{ parent: string; derivative: string; envelope: ExportEnvelope; manifest: RedactedExportManifest; packageValue: unknown }> {
  const parent = await mkdtemp(join(tmpdir(), "restricted-supplement-parent-"));
  const derivative = join(parent, "derivative");
  const root = join(parent, "source");
  const value = envelope();
  const manifest = manifestFor(value);
  const archive = await createRestrictedArchive(root);
  await archive.writeEnvelope(value);
  await archive.writeManifest(manifest);
  const page = [{ entityType: "property", sourceId: "synthetic-property" }];
  const pageFile = await archive.writePage("properties", 1, page);
  await archive.writeCheckpoint({
    version: 2,
    runId: RUN_ID,
    registryHash: manifest.registryHash,
    startedAt: value.createdAt,
    updatedAt: value.createdAt,
    requestCount: 1,
    complete: true,
    collections: {
      properties: {
        nextPage: 2,
        nextParentIndex: 0,
        parentIds: [],
        pageSize: 100,
        pages: 1,
        received: 1,
        hashes: [hashRecord(page[0])],
        pageFiles: [pageFile],
        status: "complete",
        errors: [],
        exceptions: [],
      },
    },
  });
  await archive.writeCoverage(manifest.collections);
  return { parent, derivative, envelope: value, manifest, packageValue: packageFor(value, manifest) };
}

test("derivative archive is atomic, private, provenance-bound, and leaves parent bytes unchanged", async () => {
  const fixture = await createFixture();
  try {
    const sourceEnvelopeBytes = await readFile(join(fixture.parent, "source", "export-envelope.json"));
    const sourceManifestBytes = await readFile(join(fixture.parent, "source", "manifest.json"));
    const result = await writeRestrictedSupplementDerivativeArchive({ archiveRoot: join(fixture.parent, "source"), derivativeRoot: fixture.derivative, supplementPackage: fixture.packageValue, now: () => new Date(VERIFIED_AT), externalVerifier });
    assert.equal(result.status, "written");
    assert.equal(result.report.countsAdded.application_answers, 1);
    assert.match(result.provenance.rowSetSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await readFile(join(fixture.parent, "source", "export-envelope.json")), sourceEnvelopeBytes);
    assert.deepEqual(await readFile(join(fixture.parent, "source", "manifest.json")), sourceManifestBytes);
    assert.equal((await lstat(fixture.derivative)).mode & 0o777, 0o700);
    for (const file of ["export-envelope.json", "manifest.json", RESTRICTED_SUPPLEMENT_PROVENANCE_FILE]) assert.equal((await lstat(join(fixture.derivative, file))).mode & 0o777, 0o600);
    const provenance = JSON.parse(await readFile(join(fixture.derivative, RESTRICTED_SUPPLEMENT_PROVENANCE_FILE), "utf8")) as Record<string, unknown>;
    assert.equal(provenance.parentEnvelopeSha256, sha256(sourceEnvelopeBytes.toString("utf8")));
    assert.equal(JSON.stringify(provenance).includes("synthetic restricted value"), false);
    const archive = await readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier });
    assert.ok(archive.verifiedSupplementReceipt);
    assert.equal(archive.verifiedSupplementReceipt?.sourceRunId, RUN_ID);
    assert.equal(archive.verifiedSupplementReceipt?.rowSetSha256, result.provenance.rowSetSha256);
    assert.equal(archive.verifiedSupplementReceipt?.externalVerificationIdHash, sha256("external-receipt-synthetic"));
    assert.equal(archive.verifiedSupplementReceipt?.provenanceSha256, result.provenanceSha256);
    await assert.rejects(
      () => readRestrictedMigrationArchive(fixture.derivative),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_external_verifier_missing"),
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("receipt validation rejects sidecar recomputation, verifier mismatch, and filesystem indirection", async () => {
  const fixture = await createFixture();
  try {
    const result = await writeRestrictedSupplementDerivativeArchive({ archiveRoot: join(fixture.parent, "source"), derivativeRoot: fixture.derivative, supplementPackage: fixture.packageValue, now: () => new Date(VERIFIED_AT), externalVerifier });
    const provenancePath = join(fixture.derivative, RESTRICTED_SUPPLEMENT_PROVENANCE_FILE);
    const original = JSON.parse(await readFile(provenancePath, "utf8")) as Record<string, unknown>;

    const recomputed = { ...original, rowSetSha256: "f".repeat(64) };
    await writeFile(provenancePath, canonicalJson(recomputed), { mode: 0o600 });
    await chmod(provenancePath, 0o600);
    await assert.rejects(
      () => readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier }),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_row_set_hash_mismatch"),
    );

    await writeFile(provenancePath, canonicalJson(original), { mode: 0o600 });
    await chmod(provenancePath, 0o600);
    await assert.rejects(
      () => readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier: async () => ({ verified: true as const, externalVerificationIdHash: sha256("wrong-receipt") }) }),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_external_receipt_mismatch"),
    );

    const outside = join(fixture.parent, "outside-provenance.json");
    await writeFile(outside, canonicalJson(original), { mode: 0o600 });
    await rm(provenancePath);
    await symlink(outside, provenancePath);
    await assert.rejects(
      () => readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier }),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_provenance_symlink_rejected"),
    );

    await rm(provenancePath);
    await link(outside, provenancePath);
    await assert.rejects(
      () => readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier }),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_provenance_hardlink_rejected"),
    );
    assert.equal(result.provenance.rowSetSha256, original.rowSetSha256);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("exact package retry is a deterministic no-op", async () => {
  const fixture = await createFixture();
  try {
    const first = await writeRestrictedSupplementDerivativeArchive({ archiveRoot: join(fixture.parent, "source"), derivativeRoot: fixture.derivative, supplementPackage: fixture.packageValue, now: () => new Date(VERIFIED_AT), externalVerifier });
    const second = await writeRestrictedSupplementDerivativeArchive({ archiveRoot: join(fixture.parent, "source"), derivativeRoot: fixture.derivative, supplementPackage: fixture.packageValue, now: () => new Date("2026-08-18T12:00:00.000Z"), externalVerifier });
    assert.equal(first.status, "written");
    assert.equal(second.status, "no_op");
    assert.equal(second.provenanceSha256, first.provenanceSha256);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("interrupted write leaves no accepted derivative", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      () => writeRestrictedSupplementDerivativeArchive({ archiveRoot: join(fixture.parent, "source"), derivativeRoot: fixture.derivative, supplementPackage: fixture.packageValue, externalVerifier, runtime: { beforeCommit: () => { throw new Error("synthetic interrupt"); } } }),
      (error: unknown) => error instanceof RestrictedSupplementDerivativeArchiveError && error.reasons.includes("restricted_derivative_write_failed"),
    );
    await assert.rejects(() => lstat(fixture.derivative));
    const entries = await readdir(fixture.parent);
    assert.equal(entries.some((entry) => entry.startsWith(".restricted-supplement-")), false);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("symlink output and traversal are rejected", async () => {
  const fixture = await createFixture();
  try {
    const outside = join(fixture.parent, "outside");
    await symlink(outside, fixture.derivative);
    await assert.rejects(
      () => writeRestrictedSupplementDerivativeArchive({ archiveRoot: join(fixture.parent, "source"), derivativeRoot: fixture.derivative, supplementPackage: fixture.packageValue, externalVerifier }),
      (error: unknown) => error instanceof RestrictedSupplementDerivativeArchiveError && error.reasons.includes("restricted_derivative_symlink_rejected"),
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("package file loader accepts private package and emits only hashes/counts", async () => {
  const fixture = await createFixture();
  try {
    const packagePath = join(fixture.parent, "supplement.json");
    const { writeFile, chmod: chmodFile } = await import("node:fs/promises");
    await writeFile(packagePath, JSON.stringify(fixture.packageValue), { mode: 0o600 });
    await chmodFile(packagePath, 0o600);
    const result = await applyRestrictedSupplementPackage({ archiveRoot: join(fixture.parent, "source"), derivativeRoot: fixture.derivative, supplementPackagePath: packagePath, now: () => new Date(VERIFIED_AT), externalVerifier });
    assert.equal(result.status, "written");
    assert.equal(result.report.countsAdded.application_answers, 1);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("valid status crosswalk survives the derivative envelope and restricted archive parser", async () => {
  const fixture = await createFixture();
  try {
    const sourceRoot = join(fixture.parent, "source");
    const artifactEnvelope = structuredClone(fixture.envelope);
    artifactEnvelope.payload.artifactSha256 = "a".repeat(64);
    const artifactManifest = structuredClone(fixture.manifest);
    artifactManifest.archiveEnvelopeSha256 = sha256(canonicalJson(artifactEnvelope));
    const archive = await createRestrictedArchive(sourceRoot);
    await archive.writeEnvelope(artifactEnvelope);
    await archive.writeManifest(artifactManifest);
    const packageValue = {
      ...(packageFor(artifactEnvelope, artifactManifest) as Record<string, unknown>),
      applicationHistoryStatusCrosswalk: applicationStatusCrosswalk(),
    };
    const result = await writeRestrictedSupplementDerivativeArchive({
      archiveRoot: sourceRoot,
      derivativeRoot: fixture.derivative,
      supplementPackage: packageValue,
      now: () => new Date(VERIFIED_AT),
      externalVerifier,
      supplementReceiptVerifier,
    });
    assert.equal(result.status, "written");
    const parsed = await readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier });
    assert.deepEqual(parsed.envelope.payload.applicationHistoryStatusCrosswalk, applicationStatusCrosswalk());
    assert.ok(parsed.verifiedSupplementReceipt);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("verified application-history derivative reaches artifact projection and wrapper fail-closed path", async () => {
  const fixture = await createApplicationHistoryFixture();
  const historyExternalVerifier = async (input: Parameters<typeof externalVerifier>[0]) => {
    assert.equal(input.sourceRunId, "history-archive-run");
    for (const value of Object.values(input).slice(1)) assert.match(value, /^[a-f0-9]{64}$/u);
    return { verified: true as const, receiptId: "history-external-receipt" };
  };
  const historyReceiptVerifier = async (input: Parameters<typeof supplementReceiptVerifier>[0]) => {
    assert.equal(input.sourceRunId, "history-archive-run");
    for (const value of Object.values(input).slice(1)) assert.match(value, /^[a-f0-9]{64}$/u);
    return { verified: true as const, externalVerificationIdHash: sha256("history-external-receipt") };
  };
  try {
    const crosswalk = applicationStatusCrosswalk();
    const packageValue = {
      version: RESTRICTED_SUPPLEMENT_PACKAGE_VERSION,
      envelope: fixture.envelope,
      manifest: fixture.manifest,
      operatorAttestation: { ...attestation(["application_answers"]), sourceRunId: "history-archive-run" },
      applicationAnswers: [applicationHistorySupplementRow()],
      applicationHistoryStatusCrosswalk: crosswalk,
      approval: { approved: true, approvalId: "history-approval", approvedAt: VERIFIED_AT, operatorReference: OPERATOR, gate: "restricted_supplement_apply", gateNonce: "history-nonce", gateMetadata: { reason: "synthetic-history" } },
    };
    await writeRestrictedSupplementDerivativeArchive({
      archiveRoot: fixture.source,
      derivativeRoot: fixture.derivative,
      supplementPackage: packageValue,
      now: () => new Date(VERIFIED_AT),
      externalVerifier: historyExternalVerifier,
      supplementReceiptVerifier: historyReceiptVerifier,
    });
    const parsed = await readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier: historyReceiptVerifier });
    const candidate = buildRentManagerMigrationArtifact(parsed.envelope, parsed.manifest, {
      mode: "dry_run",
      now: new Date(VERIFIED_AT),
      verifiedSupplementReceipt: parsed.verifiedSupplementReceipt,
      targetIdFactory: HISTORY_TARGET_FACTORY,
      targetIdentity: HISTORY_TARGET_IDENTITY,
    });
    assert.ok(candidate.artifact, candidate.report.blockingReasons.join(", "));
    assert.deepEqual(candidate.artifact?.restrictedSourceInput.payload.applicationHistoryStatusCrosswalk, crosswalk);
    assert.ok(candidate.verifiedSupplementReceipt);

    await assert.rejects(
      () => runRestrictedMigrationArchive({
        archiveRoot: fixture.derivative,
        mode: "dry_run",
        now: new Date(VERIFIED_AT),
        importerOptions: { targetIdFactory: HISTORY_TARGET_FACTORY, targetIdentity: HISTORY_TARGET_IDENTITY },
      }),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_external_verifier_missing"),
    );
    await assert.rejects(
      () => runRestrictedMigrationArchive({
        archiveRoot: fixture.derivative,
        mode: "dry_run",
        now: new Date(VERIFIED_AT),
        importerOptions: { targetIdFactory: HISTORY_TARGET_FACTORY, targetIdentity: HISTORY_TARGET_IDENTITY },
        supplementReceiptVerifier: async () => ({ verified: false as const, externalVerificationIdHash: sha256("history-external-receipt") }),
      }),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_external_verification_invalid"),
    );
    const replay = await runRestrictedMigrationArchive({
      archiveRoot: fixture.derivative,
      mode: "dry_run",
      now: new Date(VERIFIED_AT),
      importerOptions: { targetIdFactory: HISTORY_TARGET_FACTORY, targetIdentity: HISTORY_TARGET_IDENTITY },
      supplementReceiptVerifier: historyReceiptVerifier,
    });
    assert.deepEqual(replay.report.blockingReasons, []);
    assert.equal(replay.summary?.mode, "dry_run");
    assert.deepEqual(replay.summary?.blockedReasons, []);
    assert.equal(candidate.normalizedResult.snapshot.applicationHistory?.applications[0]?.status, "submitted");
    assert.equal(candidate.normalizedResult.snapshot.applicationHistory?.answers.length, 1);
    await assert.rejects(
      () => runRestrictedMigrationArchiveOrchestration({
        archiveRoot: fixture.derivative,
        firstApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "history-wrapper-first" },
        secondApplyGate: { phrase: "APPLY_RENT_OPS_STAGING_ONCE", nonce: "history-wrapper-second" },
      }),
      (error: unknown) => error instanceof Error && String(error).includes("restricted_supplement_external_verifier_missing"),
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("derivative page reconstruction keeps distinct registry partitions sharing an endpoint", async () => {
  const fixture = await createFixture();
  try {
    const source = join(fixture.parent, "source");
    fixture.manifest.collections.push({ ...fixture.manifest.collections[0], name: "properties.empty", status: "empty", pages: 0, requested: 0, received: 0, expected: 0, recordHashes: [] });
    const checkpoint = JSON.parse(await readFile(join(source, "checkpoint.json"), "utf8"));
    checkpoint.collections["properties.empty"] = { ...checkpoint.collections.properties, pages: 0, received: 0, hashes: [], pageFiles: [], nextPage: 1 };
    await writeFile(join(source, "manifest.json"), canonicalJson(fixture.manifest), { mode: 0o600 });
    await writeFile(join(source, "coverage.json"), canonicalJson(fixture.manifest.collections), { mode: 0o600 });
    await writeFile(join(source, "checkpoint.json"), canonicalJson(checkpoint), { mode: 0o600 });
    const result = await writeRestrictedSupplementDerivativeArchive({ archiveRoot: source, derivativeRoot: fixture.derivative, supplementPackage: packageFor(fixture.envelope, fixture.manifest), externalVerifier });
    assert.equal(result.status, "written");
    const readback = await readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier });
    assert.equal(readback.manifest.collections.find((collection) => collection.name === "properties")?.received, 1);
    assert.equal(readback.manifest.collections.find((collection) => collection.name === "properties.empty")?.received, 0);
  } finally { await rm(fixture.parent, { recursive: true, force: true }); }
});

test("manual derivative page retains only manifest-bound added rows from a shared parent output array", async () => {
  const fixture = await createFixture();
  try {
    const source = join(fixture.parent, "source");
    const retained = { entityType: "application_answer", sourceId: "retained-answer", sourceCollection: "ApplicationAnswers", ApplicationID: "retained-application", Answer: "retained value" };
    fixture.envelope.payload.applicationAnswerRecords = [retained];
    fixture.manifest.counts.applicationAnswerRecords = 1;
    fixture.manifest.archiveEnvelopeSha256 = sha256(canonicalJson(fixture.envelope));
    const collection = { ...fixture.manifest.collections[0], name: "retained.answers", path: "/ApplicationAnswers", outputKey: "applicationAnswerRecords", recordHashes: [hashRecord(retained)] };
    fixture.manifest.collections.push(collection);
    const checkpoint = JSON.parse(await readFile(join(source, "checkpoint.json"), "utf8"));
    checkpoint.collections[collection.name] = { ...checkpoint.collections.properties, hashes: collection.recordHashes, pageFiles: ["pages/retained-answers.json"] };
    await writeFile(join(source, "pages/retained-answers.json"), canonicalJson([retained]), { mode: 0o600 });
    await writeFile(join(source, "export-envelope.json"), canonicalJson(fixture.envelope), { mode: 0o600 });
    await writeFile(join(source, "manifest.json"), canonicalJson(fixture.manifest), { mode: 0o600 });
    await writeFile(join(source, "coverage.json"), canonicalJson(fixture.manifest.collections), { mode: 0o600 });
    await writeFile(join(source, "checkpoint.json"), canonicalJson(checkpoint), { mode: 0o600 });
    const before = await readRestrictedMigrationArchive(source);
    await writeRestrictedSupplementDerivativeArchive({ archiveRoot: source, derivativeRoot: fixture.derivative, supplementPackage: packageFor(fixture.envelope, fixture.manifest), externalVerifier });
    const after = await readRestrictedMigrationArchive(fixture.derivative, { supplementReceiptVerifier });
    assert.equal(after.envelope.payload.applicationAnswerRecords?.length, 2);
    assert.equal(after.parity.sourceChunks.filter(chunk => chunk.collectionName === "retained.answers").flatMap(chunk => Array.from(chunk.rows)).length, 1);
    const manual = after.parity.sourceChunks.filter(chunk => chunk.path === "manual://applicationAnswerRecords").flatMap(chunk => Array.from(chunk.rows));
    assert.equal(manual.length, 1);
    assert.equal(JSON.parse(manual[0].canonicalPayload).sourceId, "synthetic-answer");
    assert.equal((await readRestrictedMigrationArchive(source)).auditReceipt.fileSetSha256, before.auditReceipt.fileSetSha256);
  } finally { await rm(fixture.parent, { recursive: true, force: true }); }
});


test("distinct source file identities share content-addressed bytes without losing metadata", () => {
  const first = {sourceId: "Files:1", fileName: "original.pdf", metadataAvailable: true, binaryAvailable: true, descriptorOnly: false, sha256: "a".repeat(64), sizeBytes: 12, archivePath: `binaries/${"a".repeat(64)}.bin`, contentType: "application/pdf"};
  const second = {...first, sourceId: "Files:2", fileName: "current.pdf"};
  const envelope = {documentBinaries: [first, second], payload: {documentBinaries: [first, second]}} as unknown as ExportEnvelope;
  assert.equal(binaryDescriptors(envelope).length, 1);
  assert.equal(envelope.documentBinaries.length, 2);
  assert.equal(envelope.documentBinaries[1].fileName, "current.pdf");
  for (const conflicting of [{...second, sha256: "b".repeat(64)}, {...second, sizeBytes: 13}, {...second, sourceId: first.sourceId}]) {
    assert.throws(() => binaryDescriptors({...envelope, documentBinaries: [first, conflicting]}), RestrictedSupplementDerivativeArchiveError);
  }
});
