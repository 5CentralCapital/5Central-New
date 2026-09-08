import { constants } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalJson, sha256 } from '../export/hash';
import { readRestrictedMigrationArchive } from './migration-runner';
import { ALLOCATION_OVERLAY_FILE, ALLOCATION_OVERLAY_PAGE, deriveAllocationOverlay, type AllocationOverlayEvidence } from './allocation-overlay';
async function bytes(path: string) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('allocation_overlay_evidence_file_invalid'); const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const current = await h.stat(); if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('allocation_overlay_evidence_changed'); return await h.readFile(); } finally { await h.close(); } }
/** Writes a separate local archive, preserving the sealed source byte-for-byte. */
export async function writeAllocationOverlayArchive(archiveRoot: string, derivativeRoot: string, snapshotRoot: string, deltaPath: string) {
  if (![archiveRoot, derivativeRoot, snapshotRoot, deltaPath].every(p => isAbsolute(p) && !p.split(/[\\/]/).includes('..'))) throw new Error('allocation_overlay_path_invalid');
  const source = await realpath(archiveRoot), destination = resolve(derivativeRoot);
  if (source === destination || !relative(source, destination).startsWith('..')) throw new Error('allocation_overlay_requires_distinct_destination');
  if (await realpath(snapshotRoot) !== snapshotRoot || await realpath(deltaPath) !== deltaPath) throw new Error('allocation_overlay_evidence_symlink_rejected');
  try { await lstat(destination); throw new Error('allocation_overlay_destination_exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = dirname(destination); if (await realpath(parent) !== parent) throw new Error('allocation_overlay_parent_symlink_rejected');
  const archive = await readRestrictedMigrationArchive(source);
  if (archive.verifiedSupplementReceipt || archive.auditReceipt.envelopeSha256 !== archive.auditReceipt.canonicalEnvelopeSha256 || archive.auditReceipt.manifestSha256 !== archive.auditReceipt.canonicalManifestSha256) throw new Error('allocation_overlay_parent_invalid');
  const checkpoint = await bytes(join(source, 'checkpoint.json')), coverage = await bytes(join(source, 'coverage.json'));
  if (sha256(checkpoint) !== archive.auditReceipt.checkpointSha256 || sha256(coverage) !== archive.auditReceipt.coverageSha256) throw new Error('allocation_overlay_source_changed');
  const snapshotManifest = await bytes(join(snapshotRoot, 'manifest.json'));
  const manifest = JSON.parse(snapshotManifest.toString('utf8')); if (!Array.isArray(manifest.pages) || manifest.pages.length > 100) throw new Error('allocation_overlay_snapshot_invalid');
  const evidence: AllocationOverlayEvidence = { snapshotManifestBase64: snapshotManifest.toString('base64'), pages: [], deltaBase64: (await bytes(deltaPath)).toString('base64') };
  for (const descriptor of manifest.pages) { if (!/^charges-[1-9][0-9]*\.json$/.test(descriptor.file)) throw new Error('allocation_overlay_snapshot_path_invalid'); evidence.pages.push({ file: descriptor.file, bytesBase64: (await bytes(join(snapshotRoot, descriptor.file))).toString('base64') }); }
  const derived = deriveAllocationOverlay(archive.envelope, archive.manifest, checkpoint, coverage, evidence);
  const staging = await mkdtemp(join(parent, '.allocation-overlay-')); await chmod(staging, 0o700);
  try {
    await cp(source, staging, { recursive: true, dereference: false, force: false });
    if ((await readRestrictedMigrationArchive(staging)).auditReceipt.fileSetSha256 !== archive.auditReceipt.fileSetSha256) throw new Error('allocation_overlay_source_changed');
    for (const [file, value] of Object.entries({ 'export-envelope.json': derived.envelope, 'manifest.json': derived.manifest, 'checkpoint.json': derived.checkpoint, 'coverage.json': derived.coverage })) await writeFile(join(staging, file), canonicalJson(value), { mode: 0o600 });
    await writeFile(join(staging, ALLOCATION_OVERLAY_PAGE), canonicalJson(derived.rows), { mode: 0o600, flag: 'wx' });
    await writeFile(join(staging, ALLOCATION_OVERLAY_FILE), canonicalJson(derived.provenance), { mode: 0o600, flag: 'wx' });
    await readRestrictedMigrationArchive(staging);
    await mkdir(destination, { mode: 0o700 });
    try { await rename(staging, destination); } catch (error) { await rm(destination, { recursive: false }).catch(() => undefined); throw error; }
    const verified = await readRestrictedMigrationArchive(destination);
    if ((await readRestrictedMigrationArchive(source)).auditReceipt.fileSetSha256 !== archive.auditReceipt.fileSetSha256) throw new Error('allocation_overlay_source_changed');
    return { baselineCount: derived.provenance.baselineCount, fullCount: derived.provenance.fullCount, addedCount: derived.provenance.addedCount, auditReceipt: verified.auditReceipt };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
