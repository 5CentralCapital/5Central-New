import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, sha256 } from '../export/hash';
import { allocationOverlayRows, deriveAllocationOverlay, verifyAllocationOverlay } from './allocation-overlay';
import type { ExportEnvelope, RedactedExportManifest } from '../export/types';
const encode = (x: unknown) => Buffer.from(canonicalJson(x)).toString('base64');
function fixture() {
 const a = { AllocationID: 1, ChargeID: 10, Amount: 100, AllocationType: 'DirectAllocation', PaymentID: 5 };
 const b = { AllocationID: 2, ChargeID: 10, Amount: -25, AllocationType: 'ReverseDirectAllocation', PaymentID: 5 };
 const charges = [{ ChargeID: 10, Allocations: [a, b] }]; const page = Buffer.from(canonicalJson(charges));
 const envelope = { version: 'rm-export/v2', runId: 'test-run', payload: { allocations: [{ ...a, sourceId: 'payment_allocation:1' }], charges: [{ ChargeID: 10 }] } } as unknown as ExportEnvelope;
 const manifest = { archiveEnvelopeSha256: sha256(canonicalJson(envelope)), collections: [], counts: { allocations: 1, charges: 1 } } as unknown as RedactedExportManifest;
 const checkpoint = Buffer.from(canonicalJson({ runId: 'test-run', collections: {} })); const coverage = Buffer.from('[]');
 const evidence = { snapshotManifestBase64: encode({ method: 'GET-Charges-embedded-Allocations/v1', readOnly: true, complete: true, pages: [{ file: 'charges-1.json', count: 1, sha256: sha256(page) }], received: 1, totalResults: 1 }), pages: [{ file: 'charges-1.json', bytesBase64: page.toString('base64') }], deltaBase64: encode({ sourceRunId: 'test-run', overlapMismatches: [], rows: [{ sourceIdentity: { collection: 'Charges.Allocations', idField: 'AllocationID', sourceId: '2' }, sourceReference: { file: 'charges-1.json', pointer: '/0/Allocations/1' }, record: b }] }) };
 return { envelope, manifest, checkpoint, coverage, evidence };
}
test('allocation overlay preserves baseline, raw negative delta and deterministic parent reconstruction', () => {
 const f = fixture(), before = canonicalJson(f); const d = deriveAllocationOverlay(f.envelope, f.manifest, f.checkpoint, f.coverage, f.evidence);
 assert.equal(canonicalJson(f), before); assert.equal(d.rows.length, 1); assert.equal(d.rows[0].Amount, -25); assert.equal(d.envelope.payload.allocations?.length, 2);
 const parent = verifyAllocationOverlay(d.envelope, d.manifest, Buffer.from(canonicalJson(d.checkpoint)), Buffer.from(canonicalJson(d.coverage)), d.provenance);
 assert.equal(canonicalJson(parent.envelope), canonicalJson(f.envelope)); assert.equal(parent.checkpointBytes.toString(), f.checkpoint.toString());
 assert.deepEqual(d, deriveAllocationOverlay(f.envelope, f.manifest, f.checkpoint, f.coverage, f.evidence));
});
test('allocation overlay rejects captured byte tampering, false delta and baseline conflicts', () => {
 for (const mutation of [(f: ReturnType<typeof fixture>) => { f.evidence.pages[0].bytesBase64 = encode([]); }, (f: ReturnType<typeof fixture>) => { const d = JSON.parse(Buffer.from(f.evidence.deltaBase64, 'base64').toString()); d.rows[0].record.Amount = 12; f.evidence.deltaBase64 = encode(d); }, (f: ReturnType<typeof fixture>) => { f.envelope.payload.allocations![0].Amount = 99; }]) {
  const f = fixture(); mutation(f); assert.throws(() => allocationOverlayRows(f.envelope, f.evidence));
 }
});
test('allocation overlay rejects derivative or control tampering', () => {
 const f = fixture(), d = deriveAllocationOverlay(f.envelope, f.manifest, f.checkpoint, f.coverage, f.evidence);
 d.envelope.payload.allocations![1].Amount = 0;
 assert.throws(() => verifyAllocationOverlay(d.envelope, d.manifest, Buffer.from(canonicalJson(d.checkpoint)), Buffer.from(canonicalJson(d.coverage)), d.provenance));
});

test('private archive overlay roundtrip retains parent and rejects changed evidence', async () => {
 const { mkdtemp, realpath, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { createRestrictedArchive } = await import('../export/archive');
 const { writeAllocationOverlayArchive } = await import('./allocation-overlay-archive');
 const { readRestrictedMigrationArchive } = await import('./migration-runner');
 const root = await realpath(await mkdtemp(join(tmpdir(), 'allocation-overlay-test-')));
 try {
  const f = fixture(), source = join(root, 'source'), target = join(root, 'target'), snapshot = join(root, 'snapshot');
  f.envelope.source = { system: 'rent_manager', transport: 'injected', readOnly: true }; f.envelope.createdAt = '2026-09-07T22:12:25.200Z'; f.envelope.documentBinaries = [];
  Object.assign(f.manifest, { version: 'rm-export-manifest/v2', runId: f.envelope.runId, source: 'rent_manager', createdAt: f.envelope.createdAt, registryHash: 'a'.repeat(64), archiveEnvelopeSha256: sha256(canonicalJson(f.envelope)), complete: true, rawArchive: { relativePath: 'export-envelope.json', mode: '0600', directoryMode: '0700' }, errors: [], exceptions: [], documentBinarySummary: { metadataCount: 0, binaryAvailableCount: 0, descriptorOnlyCount: 0 } });
  const checkpoint = { version: 2 as const, runId: f.envelope.runId, registryHash: f.manifest.registryHash, startedAt: f.envelope.createdAt, updatedAt: f.envelope.createdAt, requestCount: 0, complete: true, collections: {} };
  const archive = await createRestrictedArchive(source); await archive.writeEnvelope(f.envelope); await archive.writeManifest(f.manifest); await archive.writeCheckpoint(checkpoint); await archive.writeCoverage([]);
  await mkdir(snapshot, { mode: 0o700 });
  await writeFile(join(snapshot, 'manifest.json'), Buffer.from(f.evidence.snapshotManifestBase64, 'base64'), { mode: 0o600 });
  await writeFile(join(snapshot, 'charges-1.json'), Buffer.from(f.evidence.pages[0].bytesBase64, 'base64'), { mode: 0o600 });
  const delta = join(root, 'delta.json'); await writeFile(delta, Buffer.from(f.evidence.deltaBase64, 'base64'), { mode: 0o600 });
  const before = await readRestrictedMigrationArchive(source);
  const result = await writeAllocationOverlayArchive(source, target, snapshot, delta); assert.equal(result.fullCount, 2);
  const after = await readRestrictedMigrationArchive(target); assert.equal(after.parity.sourceChunks[0].rows.length, 1);
  assert.equal((await readRestrictedMigrationArchive(source)).auditReceipt.fileSetSha256, before.auditReceipt.fileSetSha256);
  await assert.rejects(writeAllocationOverlayArchive(source, target, snapshot, delta), /destination_exists/);
  const receiptPath = join(target, 'allocation-overlay-provenance.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.evidence.pages[0].bytesBase64 = encode([]); await writeFile(receiptPath, canonicalJson(receipt));
  await assert.rejects(readRestrictedMigrationArchive(target), /allocation_overlay_provenance_invalid/);
  await rm(receiptPath);
  await assert.rejects(readRestrictedMigrationArchive(target), /allocation_overlay_provenance_missing/);
 } finally { await rm(root, { recursive: true, force: true }); }
});
