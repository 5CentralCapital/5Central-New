import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRestrictedArchive } from "../export/archive";
import { RentManagerExportCollector } from "../export/collector";
import { createSyntheticRentManagerTransport, SYNTHETIC_HAP_ARTIFACT_SHA256, syntheticFinancialSemanticCrosswalk, syntheticHapStatusCrosswalk } from "../export/fixtures";
import { sha256 } from "../export/hash";
import { RM_EXPORT_COLLECTIONS } from "../export/registry";
import type { ExportEnvelope, RedactedExportManifest } from "../export/types";
import { assertRequiredFinancialReportControls, buildFinancialReportExpected, readRestrictedMigrationArchive, RestrictedMigrationArchiveError, runRestrictedMigrationArchive } from "./migration-runner";
import { buildRentManagerMigrationArtifact } from "./migration-artifact";
import { createKeyedTargetIdFactory } from "./rm-mapper";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";

const TEST_TARGET_IDENTITY = { keyId: "runner-test-key", keyVersion: "v3-test" } as const;
const TEST_TARGET_FACTORY = createKeyedTargetIdFactory("runner-test-target-key-material", TEST_TARGET_IDENTITY).factory;

async function archiveFixture(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "rent-ops-migration-runner-"));
  await chmod(parent, 0o700);
  const root = join(parent, "archive");
  const archive = await createRestrictedArchive(root);
  // The synthetic RecurringCharges row has only a polymorphic EntityKeyID;
  // strict normalization correctly blocks that unresolved relationship. Keep
  // this archive happy-path fixture on the supported collections.
  // These runner tests exercise the v1-v8 audit hand-off. Keep the v9
  // application-history source collections out of this fixture so its
  // separate external receipt/crosswalk gate is tested in the artifact and
  // supplement suites rather than silently bypassed here.
  const excludedCollections = new Set([
    "documentPackets", "signableDocumentPackets", "signableDocuments", "recurringSchedules", "recurringChargeSchedules",
    "prospects", "prospectApplications", "prospectApplicationTemplates", "prospectApplicationTemplateFields",
    "prospectApplicationTemplateMajorSections", "prospectApplicationTemplateMinorSections", "applicationTemplates",
    "interestedRentals", "applicationSettings", "prospectSubApplicantDetails", "applicationSummaries",
    "tenantHistory.current", "tenantHistory.future", "tenantHistory.former", "historyNotes", "historyEmails",
    "emailSentItems", "emailChains", "textMessagingConversations", "outgoingTexts", "incomingTexts",
  ]);
  const registry = RM_EXPORT_COLLECTIONS.filter((definition) => !excludedCollections.has(definition.name));
  const exported = await new RentManagerExportCollector({ transport: createSyntheticRentManagerTransport(), archive, registry, sleep: async () => undefined, runId: "runner-test" }).collect();
  // Bind the synthetic HAP statuses to an explicit external artifact. The
  // production runner must never infer these values from descriptions.
  exported.envelope.payload.artifactSha256 = SYNTHETIC_HAP_ARTIFACT_SHA256;
  exported.envelope.payload.hapStatusCrosswalk = syntheticHapStatusCrosswalk();
  exported.envelope.payload.financialSemanticCrosswalk = syntheticFinancialSemanticCrosswalk();
  // Deliberately differs from the runner clock below.  This is the approved
  // source observation boundary used for the financial audit month.
  exported.envelope.artifactObservationOn = "2026-08-01";
  exported.manifest.artifactObservationOn = "2026-08-01";
  exported.manifest.counts.hapStatusCrosswalk = 3;
  const envelopeHash = await archive.writeEnvelope(exported.envelope);
  exported.manifest.archiveEnvelopeSha256 = envelopeHash;
  await archive.writeManifest(exported.manifest);
  return { parent, root };
}

async function binaryArchiveFixture(): Promise<{ parent: string; root: string; binaryPath: string }> {
  const parent = await mkdtemp(join(tmpdir(), "rent-ops-binary-runner-"));
  await chmod(parent, 0o700);
  const root = join(parent, "archive");
  const archive = await createRestrictedArchive(root);
  const bytes = new TextEncoder().encode("synthetic restricted binary");
  const binary = await archive.writeBinary(`binaries/${sha256(bytes)}.bin`, bytes);
  const descriptor = { sourceId: "document:synthetic", metadataAvailable: true, binaryAvailable: true, descriptorOnly: false, contentType: "application/octet-stream", sizeBytes: bytes.byteLength, sha256: binary.sha256, archivePath: binary.relativePath, availabilityReason: "archived" as const };
  const envelope: ExportEnvelope = {
    version: "rm-export/v2",
    runId: "binary-runner-test",
    source: { system: "rent_manager", transport: "injected", readOnly: true },
    createdAt: "2026-08-17T00:00:00.000Z",
    payload: { documentBinaries: [descriptor] },
    documentBinaries: [descriptor],
  };
  const envelopeHash = await archive.writeEnvelope(envelope);
  const manifest: RedactedExportManifest = {
    version: "rm-export-manifest/v2",
    runId: envelope.runId,
    source: "rent_manager",
    createdAt: envelope.createdAt,
    registryHash: "a".repeat(64),
    archiveEnvelopeSha256: envelopeHash,
    complete: true,
    rawArchive: { relativePath: "export-envelope.json", mode: "0600", directoryMode: "0700" },
    counts: { documentBinaries: 1 },
    collections: [],
    errors: [],
    exceptions: [],
    documentBinarySummary: { metadataCount: 1, binaryAvailableCount: 1, descriptorOnlyCount: 0 },
  };
  await archive.writeManifest(manifest);
  await archive.writeCheckpoint({
    version: 2,
    runId: envelope.runId,
    registryHash: manifest.registryHash,
    startedAt: envelope.createdAt,
    updatedAt: envelope.createdAt,
    requestCount: 0,
    complete: true,
    collections: {},
  });
  await archive.writeCoverage([]);
  return { parent, root, binaryPath: join(root, binary.relativePath) };
}

test("restricted migration runner loads owner-only files and dry-runs with zero database access", async () => {
  const fixture = await archiveFixture();
  try {
    const result = await runRestrictedMigrationArchive({ archiveRoot: fixture.root, now: new Date("2026-08-17T00:00:00.000Z"), importerOptions: { targetIdFactory: TEST_TARGET_FACTORY, targetIdentity: TEST_TARGET_IDENTITY } });
    assert.deepEqual(result.report.blockingReasons, []);
    assert.equal((await readRestrictedMigrationArchive(fixture.root)).verifiedSupplementReceipt, undefined);
    assert.equal(result.summary?.mode, "dry_run");
    assert.equal(result.summary?.wouldWrite, false);
    assert.equal(result.summary?.committed, false);
    assert.equal(result.databaseAuditContext?.asOfDate, "2026-08-01");
    assert.equal(result.databaseAuditContext?.asOfDate === "2026-08-17", false);
    const financialReport = result.databaseAuditContext?.expected.financialReport;
    assert.ok(financialReport?.portfolio);
    assert.ok(financialReport?.perProperty);
    assert.equal(financialReport.perProperty.length, 1);
    assert.equal(financialReport.portfolio.unknownAmountCents, 0);
    assert.equal(financialReport.portfolio.formerTenancyLeakageCount, 0);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("restricted runner rejects missing or tampered financial expected controls", async () => {
  const fixture = await archiveFixture();
  try {
    const result = await runRestrictedMigrationArchive({ archiveRoot: fixture.root, now: new Date("2026-08-17T00:00:00.000Z"), importerOptions: { targetIdFactory: TEST_TARGET_FACTORY, targetIdentity: TEST_TARGET_IDENTITY } });
    const archive = await readRestrictedMigrationArchive(fixture.root);
    const candidate = buildRentManagerMigrationArtifact(archive.envelope, archive.manifest, {
      mode: "dry_run",
      now: new Date("2026-08-17T00:00:00.000Z"),
      targetIdFactory: TEST_TARGET_FACTORY,
      targetIdentity: TEST_TARGET_IDENTITY,
      fidelityVersion: 3,
    });
    assert.ok(candidate.artifact);
    assert.ok(result.databaseAuditContext);

    const missing = structuredClone(result.databaseAuditContext.expected) as typeof result.databaseAuditContext.expected;
    delete (missing as { financialReport?: unknown }).financialReport;
    assert.throws(
      () => assertRequiredFinancialReportControls(candidate.artifact!.normalizedResult.snapshot, result.databaseAuditContext!.asOfDate, missing),
      (error: unknown) => error instanceof RestrictedMigrationArchiveError && error.reasons.includes("financial_report_expected_controls_missing"),
    );

    const tampered = structuredClone(result.databaseAuditContext.expected) as typeof result.databaseAuditContext.expected;
    tampered.financialReport.portfolio.knownCount += 1;
    assert.throws(
      () => assertRequiredFinancialReportControls(candidate.artifact!.normalizedResult.snapshot, result.databaseAuditContext!.asOfDate, tampered),
      (error: unknown) => error instanceof RestrictedMigrationArchiveError && error.reasons.includes("financial_report_expected_controls_mismatch"),
    );
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("financial expected controls keep emitted uncertainty disjoint from unassigned and invalid rows", () => {
  const snapshot = syntheticRentOpsSnapshot();
  const unassigned = {
    ...snapshot.recurringSchedules[0],
    id: "runner-unassigned",
    scopeType: null,
    scopeId: null,
    scopeTypeKnowledge: "unknown",
    scopeLinkKnowledge: "unknown",
    lineageRootId: "runner-unassigned",
  } as typeof snapshot.recurringSchedules[number];
  const invalid = {
    ...snapshot.recurringSchedules[1],
    id: "runner-invalid",
    lineageRootId: "runner-missing-root",
    versionAction: "replace",
    versionOrigin: "manual",
    supersedesId: "runner-missing-predecessor",
    effectiveFrom: "2026-08-01",
    effectiveFromKnowledge: "manual",
  } as typeof snapshot.recurringSchedules[number];
  snapshot.recurringSchedules = [unassigned, invalid];
  const expected = buildFinancialReportExpected(snapshot, "2026-08-17").portfolio;
  assert.equal(expected.sourceRowCount, 2);
  assert.equal(expected.uncertainCount, 0);
  assert.equal(expected.uncertainCents, 0);
  assert.equal(expected.unassignedCount, 1);
  assert.equal(expected.invalidCount, 1);
  assert.equal(
    expected.knownCount + expected.uncertainCount + expected.unassignedCount + expected.notApplicableCount
      + expected.suppressedCount + expected.endedCount + expected.inactiveCount + expected.futureCount + expected.invalidCount,
    expected.sourceRowCount,
  );
});

test("restricted migration runner rejects permissive files before parsing", async () => {
  const fixture = await archiveFixture();
  try {
    await chmod(join(fixture.root, "manifest.json"), 0o644);
    await assert.rejects(() => readRestrictedMigrationArchive(fixture.root), (error: unknown) => {
      assert.ok(error instanceof RestrictedMigrationArchiveError);
      assert.ok(error.reasons.includes("restricted_archive_permissions_invalid"));
      return true;
    });
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("restricted migration runner reads and rehashes every archived binary before approval", async () => {
  const fixture = await binaryArchiveFixture();
  try {
    const archive = await readRestrictedMigrationArchive(fixture.root);
    assert.equal(archive.envelope.documentBinaries[0].binaryAvailable, true);

    await writeFile(fixture.binaryPath, new TextEncoder().encode("X".repeat("synthetic restricted binary".length)));
    await chmod(fixture.binaryPath, 0o600);
    await assert.rejects(() => readRestrictedMigrationArchive(fixture.root), (error: unknown) => {
      assert.ok(error instanceof RestrictedMigrationArchiveError);
      assert.ok(error.reasons.includes("restricted_archive_binary_checksum_mismatch"));
      assert.equal(String(error).includes("synthetic.bin"), false);
      return true;
    });
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("restricted migration runner rejects binary symlinks and permissive binary modes", async () => {
  const fixture = await binaryArchiveFixture();
  try {
    const outsidePath = join(fixture.parent, "outside.bin");
    await writeFile(outsidePath, new TextEncoder().encode("synthetic restricted binary"), { mode: 0o600 });
    await rm(fixture.binaryPath);
    await symlink(outsidePath, fixture.binaryPath);
    await assert.rejects(() => readRestrictedMigrationArchive(fixture.root), (error: unknown) => {
      assert.ok(error instanceof RestrictedMigrationArchiveError);
      assert.ok(error.reasons.includes("restricted_archive_symlink_rejected"));
      assert.equal(String(error).includes("outside.bin"), false);
      return true;
    });
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }

  const modeFixture = await binaryArchiveFixture();
  try {
    await chmod(modeFixture.binaryPath, 0o644);
    await assert.rejects(() => readRestrictedMigrationArchive(modeFixture.root), (error: unknown) => {
      assert.ok(error instanceof RestrictedMigrationArchiveError);
      assert.ok(error.reasons.includes("restricted_archive_permissions_invalid"));
      return true;
    });
  } finally {
    await rm(modeFixture.parent, { recursive: true, force: true });
  }
});

test("apply mode fails closed before opening a database executor", async () => {
  const fixture = await archiveFixture();
  try {
    await assert.rejects(() => runRestrictedMigrationArchive({ archiveRoot: fixture.root, mode: "apply" }), (error: unknown) => error instanceof RestrictedMigrationArchiveError && error.reasons.includes("restricted_apply_executor_required"));
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
