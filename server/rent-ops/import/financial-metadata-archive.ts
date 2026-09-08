import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, sha256 } from "../export/hash";
import { readRestrictedMigrationArchive } from "./migration-runner";
import { OBSERVATION_PROVENANCE_FILE } from "./observation-boundary";
import { deriveFinancialMetadata, FINANCIAL_METADATA_PROVENANCE_FILE } from "./financial-metadata";

/** Local-only metadata repair. Never overwrites or mutates the sealed source. */
export async function writeFinancialMetadataArchive(archiveRoot: string, derivativeRoot: string) {
  if (![archiveRoot, derivativeRoot].every((path) => isAbsolute(path) && !path.split(/[\\/]/).includes(".."))) throw new Error("financial_metadata_archive_path_invalid");
  const source = await realpath(archiveRoot), destination = resolve(derivativeRoot);
  if (source === destination || !relative(source, destination).startsWith("..")) throw new Error("financial_metadata_archive_must_be_distinct");
  // Existing destination is always refused, including dangling symlinks.
  try { await lstat(destination); throw new Error("financial_metadata_archive_destination_exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = dirname(destination);
  if (await realpath(parent) !== parent) throw new Error("financial_metadata_archive_parent_symlink_rejected");
  const archive = await readRestrictedMigrationArchive(archiveRoot);
  if (archive.verifiedSupplementReceipt) throw new Error("financial_metadata_archive_requires_unsupplemented_parent");
  // Exact canonical parent bytes are reconstructible from the derivative.
  if (archive.auditReceipt.envelopeSha256 !== archive.auditReceipt.canonicalEnvelopeSha256 || archive.auditReceipt.manifestSha256 !== archive.auditReceipt.canonicalManifestSha256) throw new Error("financial_metadata_archive_parent_not_canonical");
  const handle = await open(join(source, "checkpoint.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let checkpoint: Buffer;
  try { checkpoint = await handle.readFile(); } finally { await handle.close(); }
  if (sha256(checkpoint) !== archive.auditReceipt.checkpointSha256) throw new Error("financial_metadata_archive_checkpoint_changed");
  const observationHandle = await open(join(source, OBSERVATION_PROVENANCE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  let observationBytes: Buffer;
  try { observationBytes = await observationHandle.readFile(); } finally { await observationHandle.close(); }
  const derived = deriveFinancialMetadata(archive.envelope, archive.manifest, checkpoint, observationBytes);
  const staging = await mkdtemp(join(parent, ".financial-metadata-"));
  await chmod(staging, 0o700);
  try {
    await cp(source, staging, { recursive: true, dereference: false, force: false });
    const copied = await readRestrictedMigrationArchive(staging);
    if (copied.auditReceipt.fileSetSha256 !== archive.auditReceipt.fileSetSha256) throw new Error("financial_metadata_archive_source_changed");
    await writeFile(join(staging, "export-envelope.json"), canonicalJson(derived.envelope), { mode: 0o600 });
    await writeFile(join(staging, "manifest.json"), canonicalJson(derived.manifest), { mode: 0o600 });
    await writeFile(join(staging, FINANCIAL_METADATA_PROVENANCE_FILE), canonicalJson(derived.provenance), { mode: 0o600, flag: "wx" });
    const verified = await readRestrictedMigrationArchive(staging);
    if (verified.auditReceipt.canonicalEnvelopeSha256 !== derived.provenance.derivativeEnvelopeSha256 || verified.auditReceipt.canonicalManifestSha256 !== derived.provenance.derivativeManifestSha256) throw new Error("financial_metadata_archive_derivative_changed");
    // Reserve the destination atomically so an existing file cannot be replaced.
    await mkdir(destination, { mode: 0o700 });
    try { await rename(staging, destination); } catch (error) { await rm(destination, { recursive: false }).catch(() => undefined); throw error; }
    await readRestrictedMigrationArchive(destination);
    const unchanged = await readRestrictedMigrationArchive(source);
    if (unchanged.auditReceipt.fileSetSha256 !== archive.auditReceipt.fileSetSha256) throw new Error("financial_metadata_archive_source_changed");
    return derived.provenance;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
