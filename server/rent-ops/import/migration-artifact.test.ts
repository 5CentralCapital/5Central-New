import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryArchive } from "../export/archive";
import { RentManagerExportCollector } from "../export/collector";
import {
  createSyntheticRentManagerTransport,
  SYNTHETIC_HAP_ARTIFACT_SHA256,
  syntheticFinancialSemanticCrosswalk,
  syntheticHapStatusCrosswalk,
} from "../export/fixtures";
import { canonicalJson, sha256 } from "../export/hash";
import { RM_EXPORT_COLLECTIONS } from "../export/registry";
import type { ExportResult } from "../export/types";
import { validateSnapshot } from "../domain/invariants";
import { assertMigrationArtifactIntegrity, buildRentManagerMigrationArtifact, MigrationArtifactIntegrityError } from "./migration-artifact";

async function fixtureExport(includeDocuments = false, includeSchedules = true): Promise<ExportResult> {
  // Base artifact tests exercise the already-approved operational mapper.
  // Historical applications have a separate, fail-closed crosswalk and
  // externally verified answer-supplement gate below; do not make these
  // unrelated digest tests fabricate that evidence.
  const historyCollections = new Set([
    "prospects",
    "prospectApplications",
    "prospectApplicationTemplates",
    "prospectApplicationTemplateFields",
    "prospectApplicationTemplateMajorSections",
    "prospectApplicationTemplateMinorSections",
    "applicationTemplates",
    "interestedRentals",
    "applicationSettings",
    "prospectSubApplicantDetails",
    "applicationSummaries",
  ]);
  const baseRegistry = RM_EXPORT_COLLECTIONS.filter((definition) => !historyCollections.has(definition.name));
  const registry = includeDocuments
    ? baseRegistry
    : baseRegistry.filter((definition) => !["documentPackets", "signableDocumentPackets", "signableDocuments"].includes(definition.name));
  const filteredRegistry = includeSchedules ? registry : registry.filter((definition) => !["recurringSchedules", "recurringChargeSchedules"].includes(definition.name));
  return new RentManagerExportCollector({
    transport: createSyntheticRentManagerTransport(),
    archive: createMemoryArchive(),
    registry: filteredRegistry,
    sleep: async () => undefined,
    runId: includeDocuments ? "artifact-docs" : "artifact-clean",
  }).collect().then((result) => {
    // The collector intentionally does not invent an HAP status mapping. Bind
    // this synthetic envelope to an explicit external artifact identity so
    // artifact tests exercise the same exact-crosswalk gate as production.
    result.envelope.payload.artifactSha256 = SYNTHETIC_HAP_ARTIFACT_SHA256;
    result.envelope.payload.hapStatusCrosswalk = syntheticHapStatusCrosswalk();
    result.envelope.payload.financialSemanticCrosswalk = syntheticFinancialSemanticCrosswalk();
    result.envelope.artifactObservationOn = "2026-08-17";
    result.manifest.artifactObservationOn = "2026-08-17";
    result.manifest.counts.hapStatusCrosswalk = 3;
    result.manifest.archiveEnvelopeSha256 = sha256(canonicalJson(result.envelope));
    return result;
  });
}

test("collector to normalizer to mapper produces one provenance-bound approved artifact", async () => {
  // The synthetic RecurringCharges row is intentionally tenant-scoped by
  // EntityKeyID only; strict normalization correctly blocks that unresolved
  // relationship.  Keep this happy-path artifact test focused on the fully
  // supported collections and cover unresolved schedules in normalizer tests.
  const exported = await fixtureExport(false, false);
  const candidate = buildRentManagerMigrationArtifact(exported.envelope, exported.manifest, { now: new Date("2026-08-17T00:00:00.000Z"), mode: "apply" });
  assert.ok(candidate.artifact);
  assert.deepEqual(candidate.report.blockingReasons, []);
  assert.equal(candidate.report.normalizedRecordCounts.allocations, 1);
  assert.equal(candidate.report.normalizedRecordCounts.leaseTerms, 1);
  assert.deepEqual(validateSnapshot(candidate.normalizedResult.snapshot), []);
  assert.equal(candidate.artifact.provenance.archiveEnvelopeSha256, exported.manifest.archiveEnvelopeSha256);
  assert.equal(candidate.normalizedResult.importRun.sourceManifestHash, exported.manifest.archiveEnvelopeSha256);
  const renderedReport = JSON.stringify(candidate.report);
  assert.equal(renderedReport.includes("tenant-201@example.test"), false);
  assert.equal(renderedReport.includes("Example Test Apartments"), false);
});

test("tampered envelopes cannot produce an approved artifact", async () => {
  const exported = await fixtureExport();
  const tampered = structuredClone(exported.envelope);
  (tampered.payload.properties?.[0] as Record<string, unknown>).PropertyName = "Changed after archive";
  const candidate = buildRentManagerMigrationArtifact(tampered, exported.manifest);
  assert.equal(candidate.artifact, undefined);
  assert.ok(candidate.report.blockingReasons.includes("archive_envelope_hash_mismatch"));
});

test("v8 artifact observation boundary is explicit, shared by envelope and manifest, and never clock-derived", async () => {
  const missing = await fixtureExport(false, false);
  delete missing.envelope.artifactObservationOn;
  delete missing.manifest.artifactObservationOn;
  const missingCandidate = buildRentManagerMigrationArtifact(missing.envelope, missing.manifest);
  assert.equal(missingCandidate.artifact, undefined);
  assert.ok(missingCandidate.report.blockingReasons.includes("artifact_observation_boundary_invalid"));

  const mismatched = await fixtureExport(false, false);
  mismatched.manifest.artifactObservationOn = "2026-08-18";
  const mismatchedCandidate = buildRentManagerMigrationArtifact(mismatched.envelope, mismatched.manifest);
  assert.equal(mismatchedCandidate.artifact, undefined);
  assert.ok(mismatchedCandidate.report.blockingReasons.includes("artifact_observation_boundary_invalid"));

  const approved = await fixtureExport(false, false);
  const candidate = buildRentManagerMigrationArtifact(approved.envelope, approved.manifest, { now: new Date("2030-01-01T00:00:00.000Z") });
  assert.ok(candidate.artifact);
  assert.equal(candidate.artifact.provenance.artifactObservationOn, "2026-08-17");
  const mutated = structuredClone(candidate.artifact);
  mutated.provenance.artifactObservationOn = "2026-08-18";
  assert.throws(
    () => assertMigrationArtifactIntegrity({ ...candidate, artifact: mutated }, approved.envelope, approved.manifest),
    (error: unknown) => error instanceof MigrationArtifactIntegrityError && error.reasons.includes("artifact_observation_boundary_mismatch"),
  );
});

test("approved artifact rejects post-build envelope or manifest mutation", async () => {
  const exported = await fixtureExport(false, false);
  const candidate = buildRentManagerMigrationArtifact(exported.envelope, exported.manifest);
  assert.ok(candidate.artifact);
  const tamperedEnvelope = structuredClone(exported.envelope);
  (tamperedEnvelope.payload.properties?.[0] as Record<string, unknown>).PropertyName = "mutated after approval";
  assert.throws(
    () => assertMigrationArtifactIntegrity(candidate, tamperedEnvelope, exported.manifest),
    (error: unknown) => error instanceof MigrationArtifactIntegrityError && error.reasons.includes("artifact_report_envelope_digest_mismatch"),
  );

  const tamperedManifest = structuredClone(exported.manifest);
  tamperedManifest.registryHash = "f".repeat(64);
  assert.throws(
    () => assertMigrationArtifactIntegrity(candidate, exported.envelope, tamperedManifest),
    (error: unknown) => error instanceof MigrationArtifactIntegrityError && error.reasons.includes("artifact_report_manifest_digest_mismatch"),
  );

  const mutatedArtifact = structuredClone(candidate.artifact);
  (mutatedArtifact.restrictedSourceInput.payload.properties?.[0] as Record<string, unknown>).PropertyName = "mutated artifact input";
  assert.throws(
    () => assertMigrationArtifactIntegrity({ ...candidate, artifact: mutatedArtifact }, exported.envelope, exported.manifest),
    (error: unknown) => error instanceof MigrationArtifactIntegrityError && error.reasons.includes("artifact_restricted_envelope_digest_mismatch"),
  );
});

test("approved artifact rejects mutation of every bound component", async () => {
  const exported = await fixtureExport(false, false);
  const candidate = buildRentManagerMigrationArtifact(exported.envelope, exported.manifest);
  assert.ok(candidate.artifact);

  const assertTamperRejected = (
    mutate: (artifact: NonNullable<typeof candidate.artifact>) => void,
    reason: string,
  ) => {
    const mutatedArtifact = structuredClone(candidate.artifact);
    mutate(mutatedArtifact);
    assert.throws(
      () => assertMigrationArtifactIntegrity({ ...candidate, artifact: mutatedArtifact }, exported.envelope, exported.manifest),
      (error: unknown) => error instanceof MigrationArtifactIntegrityError && error.reasons.includes(reason),
    );
  };

  assertTamperRejected((artifact) => {
    artifact.controls.totalsCents = { ...(artifact.controls.totalsCents ?? {}), charges: (artifact.controls.totalsCents?.charges ?? 0) + 1 };
  }, "artifact_controls_digest_mismatch");
  assertTamperRejected((artifact) => {
    artifact.normalizedResult.snapshot.properties[0].name = "mutated mapped row";
  }, "artifact_mapped_rows_digest_mismatch");
  assertTamperRejected((artifact) => {
    artifact.restrictedSourceInput.payload!.properties![0].name = "mutated restricted row";
  }, "artifact_restricted_rows_digest_mismatch");
  assertTamperRejected((artifact) => {
    artifact.provenance.normalizedRowsSha256 = "b".repeat(64);
  }, "artifact_normalized_rows_digest_mismatch");
});

test("application fields without answer records and unavailable document binaries remain explicit blockers", async () => {
  const exported = await fixtureExport();
  const applicationEnvelope = structuredClone(exported.envelope);
  applicationEnvelope.payload.applications = [{
    entityType: "application",
    sourceId: "prospect_application:1",
    sourceCollection: "prospectApplications",
    ProspectApplicationID: 1,
    Status: "Submitted",
  }];
  applicationEnvelope.payload.applicationTemplates = [{ entityType: "application", sourceId: "application_field:1", sourceCollection: "prospectApplicationTemplateFields" }];
  const applicationManifest = structuredClone(exported.manifest);
  applicationManifest.counts.applications = 1;
  applicationManifest.counts.applicationTemplates = 1;
  applicationManifest.archiveEnvelopeSha256 = sha256(canonicalJson(applicationEnvelope));
  const applicationCandidate = buildRentManagerMigrationArtifact(applicationEnvelope, applicationManifest);
  assert.equal(applicationCandidate.artifact, undefined);
  assert.ok(applicationCandidate.report.blockingReasons.includes("application_answers_not_exported"));

  const documents = await fixtureExport(true);
  const documentCandidate = buildRentManagerMigrationArtifact(documents.envelope, documents.manifest);
  assert.equal(documentCandidate.artifact, undefined);
  assert.ok(documentCandidate.report.blockingReasons.includes("document_binaries_not_fully_archived"));
});
