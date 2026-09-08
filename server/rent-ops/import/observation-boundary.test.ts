import { writeFinancialMetadataArchive } from "./financial-metadata-archive";
import { FINANCIAL_METADATA_PROVENANCE_FILE } from "./financial-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRestrictedArchive } from "../export/archive";
import { canonicalJson, sha256 } from "../export/hash";
import type { ExportEnvelope, RedactedExportManifest } from "../export/types";
import { deriveObservationBoundary, verifyObservationBoundary, OBSERVATION_PROVENANCE_FILE } from "./observation-boundary";
import { writeObservationBoundaryArchive } from "./observation-boundary-archive";
import { readRestrictedMigrationArchive } from "./migration-runner";
function fixture() {
  const envelope: ExportEnvelope = { version: "rm-export/v2", runId: "observation-test", source: { system: "rent_manager", transport: "injected", readOnly: true }, createdAt: "2026-09-07T22:12:25.200Z", payload: {}, documentBinaries: [] };
  const manifest: RedactedExportManifest = { version: "rm-export-manifest/v2", runId: envelope.runId, source: "rent_manager", createdAt: envelope.createdAt, registryHash: "a".repeat(64), archiveEnvelopeSha256: sha256(canonicalJson(envelope)), complete: true, rawArchive: { relativePath: "export-envelope.json", mode: "0600", directoryMode: "0700" }, counts: {}, collections: [], errors: [], exceptions: [], documentBinarySummary: { metadataCount: 0, binaryAvailableCount: 0, descriptorOnlyCount: 0 } };
  const checkpoint = { version: 2 as const, runId: envelope.runId, registryHash: manifest.registryHash, startedAt: envelope.createdAt, updatedAt: "2026-09-07T22:43:42.170Z", requestCount: 0, complete: true, collections: {} };
  return { envelope, manifest, checkpoint, bytes: Buffer.from(canonicalJson(checkpoint)) };
}
test("capture date is deterministic, parent remains unchanged, and full interval is retained", () => {
  const f = fixture(), before = canonicalJson(f);
  const result = deriveObservationBoundary(f.envelope, f.manifest, f.bytes);
  assert.equal(result.envelope.artifactObservationOn, "2026-09-07");
  assert.equal(result.provenance.captureCompletedAt, f.checkpoint.updatedAt);
  assert.equal(canonicalJson(f), before);
  verifyObservationBoundary(result.envelope, result.manifest, f.bytes, result.provenance);
  assert.deepEqual(result, deriveObservationBoundary(f.envelope, f.manifest, f.bytes));
  assert.throws(() => verifyObservationBoundary({ ...result.envelope, artifactObservationOn: "2026-09-06" }, result.manifest, f.bytes, result.provenance));
  assert.throws(() => verifyObservationBoundary(result.envelope, result.manifest, f.bytes, { ...result.provenance, parentEnvelopeSha256: "b".repeat(64) }));
});
test("rejects incomplete, conflicting, cross-day, and preexisting observations", () => {
  const f = fixture();
  for (const change of [{ updatedAt: "2026-09-08T00:01:00.000Z" }, { updatedAt: "2026-09-07T00:01:00.000Z" }, { complete: false }, { startedAt: "2026-09-07T20:00:00.000Z" }]) {
    assert.throws(() => deriveObservationBoundary(f.envelope, f.manifest, Buffer.from(canonicalJson({ ...f.checkpoint, ...change }))));
  }
  assert.throws(() => deriveObservationBoundary({ ...f.envelope, artifactObservationOn: "2026-09-07" }, f.manifest, f.bytes));
});
test("private derivative roundtrip preserves sealed base and reader rejects tampered receipt", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "observation-test-")));
  try {
    const source = join(parent, "source"), target = join(parent, "derived"), f = fixture();
    const archive = await createRestrictedArchive(source);
    await archive.writeEnvelope(f.envelope); await archive.writeManifest(f.manifest);
    await archive.writeCheckpoint(f.checkpoint); await archive.writeCoverage([]);
    const before = await readRestrictedMigrationArchive(source);
    await writeObservationBoundaryArchive(source, target);
    assert.equal((await readRestrictedMigrationArchive(target)).envelope.artifactObservationOn, "2026-09-07");
    assert.equal((await readRestrictedMigrationArchive(source)).auditReceipt.fileSetSha256, before.auditReceipt.fileSetSha256);
    await assert.rejects(writeObservationBoundaryArchive(source, target), /destination_exists/);
    const receiptPath = join(target, OBSERVATION_PROVENANCE_FILE);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.captureCompletedAt = "2026-09-07T23:00:00.000Z";
    await writeFile(receiptPath, canonicalJson(receipt));
    await assert.rejects(readRestrictedMigrationArchive(target), /observation_boundary_provenance_invalid/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("financial derivative preserves and verifies observation chain and rejects crosswalk tampering", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "financial-metadata-test-")));
  try {
    const source = join(parent, "source"), observed = join(parent, "observed"), target = join(parent, "financial"), f = fixture();
    const archive = await createRestrictedArchive(source);
    await archive.writeEnvelope(f.envelope); await archive.writeManifest(f.manifest);
    await archive.writeCheckpoint(f.checkpoint); await archive.writeCoverage([]);
    await writeObservationBoundaryArchive(source, observed);
    const before = await readRestrictedMigrationArchive(observed);
    await writeFinancialMetadataArchive(observed, target);
    const derived = await readRestrictedMigrationArchive(target);
    assert.equal(derived.envelope.artifactObservationOn, "2026-09-07");
    assert.equal(derived.envelope.payload.artifactSha256, before.auditReceipt.canonicalEnvelopeSha256);
    assert.deepEqual(derived.envelope.payload.financialSemanticCrosswalk?.entries, []);
    assert.equal((await readRestrictedMigrationArchive(observed)).auditReceipt.fileSetSha256, before.auditReceipt.fileSetSha256);
    await assert.rejects(writeFinancialMetadataArchive(target, join(parent, "again")));
    const receiptPath = join(target, FINANCIAL_METADATA_PROVENANCE_FILE);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.crosswalkSha256 = "b".repeat(64);
    await writeFile(receiptPath, canonicalJson(receipt));
    await assert.rejects(readRestrictedMigrationArchive(target), /financial_metadata_provenance_invalid/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
