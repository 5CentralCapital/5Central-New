import { ALLOCATION_OVERLAY_COLLECTION, ALLOCATION_OVERLAY_FILE, verifyAllocationOverlay } from "../import/allocation-overlay";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertNoCredentialShapedFields, RestrictedCredentialFieldError } from "./collector";
import { canonicalJson, hashRecord, sha256 } from "./hash";
import type { ExportCheckpoint, ExportEnvelope, RedactedExportManifest } from "./types";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE = /^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9._/-]+$/;

export interface RestrictedExportArchiveAuditReport {
  version: "rm-export-archive-audit/v1";
  passed: boolean;
  blockingReasons: string[];
  envelopeSha256?: string;
  pageFileCount: number;
  binaryFileCount: number;
  recordsScanned: number;
  credentialRejectedRows: number;
  verifiedBinaryCount: number;
  verifiedBinaryBytes: number;
  manifestCounts: Record<string, number>;
}

interface ArchiveInventory {
  files: Map<string, { mode: number; size: number }>;
  directories: Set<string>;
  unsafe: string[];
}

function mode(value: number): number {
  return value & 0o777;
}

function addReason(reasons: Set<string>, reason: string): void {
  reasons.add(reason.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160));
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeRelativePath(value: unknown, prefix?: string): value is string {
  return typeof value === "string"
    && SAFE_RELATIVE.test(value)
    && !value.startsWith("/")
    && !value.includes("\\")
    && (!prefix || value.startsWith(prefix));
}

async function inventory(root: string): Promise<ArchiveInventory> {
  const files = new Map<string, { mode: number; size: number }>();
  const directories = new Set<string>();
  const unsafe: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      unsafe.push("unsafe_archive_directory");
      return;
    }
    if (mode(stats.mode) & 0o077) unsafe.push("archive_directory_permissions_not_private");
    directories.add(relative(root, directory) || ".");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (!contained(root, absolute)) {
        unsafe.push("archive_path_escape");
        continue;
      }
      const child = await lstat(absolute);
      if (child.isSymbolicLink()) {
        unsafe.push("archive_symlink_rejected");
      } else if (child.isDirectory()) {
        await visit(absolute);
      } else if (child.isFile()) {
        if (mode(child.mode) & 0o077) unsafe.push("archive_file_permissions_not_private");
        files.set(relative(root, absolute), { mode: mode(child.mode), size: child.size });
      } else {
        unsafe.push("archive_nonregular_entry");
      }
    }
  };
  await visit(root);
  return { files, directories, unsafe };
}

async function readNoFollow(root: string, relativePath: string): Promise<Uint8Array> {
  if (!safeRelativePath(relativePath)) throw new Error("unsafe_archive_relative_path");
  const path = resolve(root, relativePath);
  if (!contained(root, path)) throw new Error("unsafe_archive_relative_path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || mode(stats.mode) & 0o077) throw new Error("unsafe_archive_file");
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function readJson<T>(root: string, relativePath: string): Promise<{ bytes: Uint8Array; value: T }> {
  const bytes = await readNoFollow(root, relativePath);
  return { bytes, value: JSON.parse(Buffer.from(bytes).toString("utf8")) as T };
}

function scanCredentialBoundary(value: unknown): boolean {
  try {
    assertNoCredentialShapedFields(value);
    return true;
  } catch (error) {
    if (error instanceof RestrictedCredentialFieldError) return false;
    throw error;
  }
}

function equalStrings(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Independently verify a completed private RM export without returning raw
 * records, source IDs, paths, names, or filenames. This audit performs no RM
 * request and no database write.
 */
export async function auditRestrictedExportArchive(rootInput: string): Promise<RestrictedExportArchiveAuditReport> {
  const reasons = new Set<string>();
  const report: RestrictedExportArchiveAuditReport = {
    version: "rm-export-archive-audit/v1",
    passed: false,
    blockingReasons: [],
    pageFileCount: 0,
    binaryFileCount: 0,
    recordsScanned: 0,
    credentialRejectedRows: 0,
    verifiedBinaryCount: 0,
    verifiedBinaryBytes: 0,
    manifestCounts: {},
  };
  try {
    if (!isAbsolute(rootInput) || rootInput.split(/[\\/]+/).includes("..")) throw new Error("archive_root_invalid");
    const root = resolve(rootInput);
    // Resolve once so the path must exist. A system-owned ancestor such as
    // macOS `/var` may itself be a stable symlink; the archive root and every
    // descendant are still independently lstat/opened with no-follow below.
    await realpath(root);
    const entries = await inventory(root);
    entries.unsafe.forEach((reason) => addReason(reasons, reason));
    const required = ["export-envelope.json", "manifest.json", "checkpoint.json", "coverage.json"];
    for (const path of required) if (!entries.files.has(path)) addReason(reasons, "archive_required_file_missing");
    for (const path of Array.from(entries.files.keys())) {
      const allowed = required.includes(path)
        || path === "restricted-supplement-provenance.json"
        || path === "observation-boundary-provenance.json"
        || path === "financial-metadata-provenance.json"
        || path === ALLOCATION_OVERLAY_FILE
        || /^pages\/[A-Za-z0-9._-]+\.json$/.test(path)
        || /^binaries\/[a-f0-9]{64}\.bin$/.test(path);
      if (!allowed) addReason(reasons, "archive_unexpected_file");
    }
    for (const directory of Array.from(entries.directories)) if (![".", "pages", "binaries"].includes(directory)) addReason(reasons, "archive_unexpected_directory");

    const envelopeFile = await readJson<ExportEnvelope>(root, "export-envelope.json");
    const manifestFile = await readJson<RedactedExportManifest>(root, "manifest.json");
    const checkpointFile = await readJson<ExportCheckpoint>(root, "checkpoint.json");
    const coverageFile = await readJson<unknown[]>(root, "coverage.json");
    const envelope = envelopeFile.value;
    const manifest = manifestFile.value;
    const checkpoint = checkpointFile.value;
    report.envelopeSha256 = sha256(envelopeFile.bytes);
    report.manifestCounts = Object.fromEntries(Object.entries(manifest.counts ?? {}).map(([key, value]) => [key, Number(value)]));

    if (envelope.version !== "rm-export/v2" || envelope.source?.system !== "rent_manager" || envelope.source?.readOnly !== true) addReason(reasons, "archive_envelope_identity_invalid");
    if (manifest.version !== "rm-export-manifest/v2" || manifest.source !== "rent_manager") addReason(reasons, "archive_manifest_identity_invalid");
    if (!manifest.complete || !checkpoint.complete) addReason(reasons, "archive_not_complete");
    if (manifest.runId !== envelope.runId || checkpoint.runId !== envelope.runId) addReason(reasons, "archive_run_binding_mismatch");
    if (manifest.registryHash !== checkpoint.registryHash) addReason(reasons, "archive_registry_binding_mismatch");
    if (manifest.archiveEnvelopeSha256 !== report.envelopeSha256) addReason(reasons, "archive_envelope_hash_mismatch");
    if (canonicalJson(coverageFile.value) !== canonicalJson(manifest.collections)) addReason(reasons, "archive_coverage_manifest_mismatch");

    if (manifest.collections.some(row => row.name === ALLOCATION_OVERLAY_COLLECTION) && !entries.files.has(ALLOCATION_OVERLAY_FILE) && !entries.files.has("restricted-supplement-provenance.json")) addReason(reasons, "allocation_overlay_provenance_missing");
    if (entries.files.has(ALLOCATION_OVERLAY_FILE)) {
      const overlay = await readJson<unknown>(root, ALLOCATION_OVERLAY_FILE);
      const verified = verifyAllocationOverlay(envelope, manifest, checkpointFile.bytes, coverageFile.bytes, overlay.value);
      const overlayPage = await readJson<unknown>(root, "pages/charge-allocation-supplement.json");
      if (canonicalJson(overlayPage.value) !== canonicalJson(verified.rows)) addReason(reasons, "allocation_overlay_page_mismatch");
    }
    const payload = envelope.payload as Record<string, unknown>;
    for (const [key, expected] of Object.entries(manifest.counts ?? {})) {
      const value = payload[key];
      if (!Array.isArray(value) || value.length !== expected) addReason(reasons, "archive_manifest_count_mismatch");
    }
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value) && manifest.counts?.[key] !== value.length) addReason(reasons, "archive_payload_count_unmanifested");
      if (!Array.isArray(value)) continue;
      for (const row of value) {
        report.recordsScanned += 1;
        if (!scanCredentialBoundary(row)) report.credentialRejectedRows += 1;
      }
    }
    if (report.credentialRejectedRows > 0) addReason(reasons, "credential_shaped_field_detected");

    const referencedPages = new Set<string>();
    for (const [collectionName, state] of Object.entries(checkpoint.collections ?? {})) {
      const rowHashes: string[] = [];
      let received = 0;
      for (const pagePath of state.pageFiles ?? []) {
        if (!safeRelativePath(pagePath, "pages/") || referencedPages.has(pagePath)) {
          addReason(reasons, "archive_page_reference_invalid");
          continue;
        }
        referencedPages.add(pagePath);
        const page = await readJson<unknown[]>(root, pagePath);
        if (!Array.isArray(page.value)) {
          addReason(reasons, "archive_page_shape_invalid");
          continue;
        }
        received += page.value.length;
        for (const row of page.value) {
          rowHashes.push(hashRecord(row));
          if (!scanCredentialBoundary(row)) addReason(reasons, "credential_shaped_field_detected");
        }
      }
      if (received !== state.received || !equalStrings(rowHashes, state.hashes ?? [])) addReason(reasons, "archive_page_checkpoint_mismatch");
      const coverage = manifest.collections.find((entry) => entry.name === collectionName);
      if (!coverage || coverage.received !== state.received || !equalStrings(coverage.recordHashes ?? [], state.hashes ?? [])) addReason(reasons, "archive_collection_coverage_mismatch");
    }
    const diskPages = new Set(Array.from(entries.files.keys()).filter((path) => path.startsWith("pages/") && path.endsWith(".json")));
    report.pageFileCount = diskPages.size;
    if (diskPages.size !== referencedPages.size || Array.from(diskPages).some((path) => !referencedPages.has(path))) addReason(reasons, "archive_unreferenced_or_missing_page");

    const referencedBinaries = new Set<string>();
    const descriptors = Array.isArray(envelope.documentBinaries) ? envelope.documentBinaries : [];
    for (const descriptor of descriptors) {
      if (!descriptor.binaryAvailable) {
        if (descriptor.archivePath || descriptor.sha256 || descriptor.sizeBytes !== undefined) addReason(reasons, "archive_descriptor_state_invalid");
        continue;
      }
      if (!safeRelativePath(descriptor.archivePath, "binaries/") || !SHA256.test(descriptor.sha256 ?? "") || !Number.isSafeInteger(descriptor.sizeBytes) || Number(descriptor.sizeBytes) < 0) {
        addReason(reasons, "archive_binary_descriptor_invalid");
        continue;
      }
      referencedBinaries.add(descriptor.archivePath);
      const bytes = await readNoFollow(root, descriptor.archivePath);
      if (bytes.byteLength !== descriptor.sizeBytes || sha256(bytes) !== descriptor.sha256) addReason(reasons, "archive_binary_integrity_mismatch");
      else {
        report.verifiedBinaryCount += 1;
        report.verifiedBinaryBytes += bytes.byteLength;
      }
    }
    const diskBinaries = new Set(Array.from(entries.files.keys()).filter((path) => path.startsWith("binaries/")));
    report.binaryFileCount = diskBinaries.size;
    if (diskBinaries.size !== referencedBinaries.size || Array.from(diskBinaries).some((path) => !referencedBinaries.has(path))) addReason(reasons, "archive_unreferenced_or_missing_binary");
    if (manifest.documentBinarySummary?.binaryAvailableCount !== report.verifiedBinaryCount) addReason(reasons, "archive_binary_summary_mismatch");
  } catch (error) {
    const message = error instanceof Error && /^[A-Za-z0-9_.:-]{1,160}$/.test(error.message)
      ? error.message
      : "archive_audit_failed";
    addReason(reasons, message);
  }
  report.blockingReasons = Array.from(reasons).sort();
  report.passed = report.blockingReasons.length === 0;
  return report;
}
