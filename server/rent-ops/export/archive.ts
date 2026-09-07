import { chmod, constants, lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "./hash";
import type {
  CollectionCoverage,
  ExportArchive,
  ExportArchivePaths,
  ExportCheckpoint,
  ExportEnvelope,
  RedactedExportManifest,
  CheckpointStore,
} from "./types";
import type { RentManagerRawRecord } from "../../../shared/rent-ops-contracts";

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

function modeOf(stats: { mode: number }): number {
  return stats.mode & 0o777;
}

function assertNotRoot(path: string): void {
  if (resolve(path) === parse(path).root) throw new UnsafeArchiveError("archive root may not be a filesystem root");
}

function assertSafeRelativePath(path: string): void {
  if (!path || path.includes("\0") || isAbsolute(path)) throw new UnsafeArchiveError("archive path must be relative");
  const parts = path.split(/[\\/]+/);
  if (parts.some((part) => part === ".." || part === "" || part === ".")) throw new UnsafeArchiveError("archive path contains unsafe segments");
}

async function assertSafeDirectory(path: string, create = true): Promise<void> {
  assertNotRoot(path);
  const missing: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) throw new UnsafeArchiveError("archive directory may not be a symlink");
      if (!stats.isDirectory()) throw new UnsafeArchiveError("archive path is not a directory");
      if (cursor === resolve(path) && modeOf(stats) & 0o077) throw new UnsafeArchiveError("archive directory permissions are not restrictive");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new UnsafeArchiveError("archive directory parent cannot be resolved");
      cursor = parent;
    }
  }
  for (let index = missing.length - 1; index >= 0; index -= 1) {
    const directory = missing[index];
    await mkdir(directory, { mode: 0o700 });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) & 0o077) throw new UnsafeArchiveError("created archive directory is not restrictive");
    await chmod(directory, 0o700);
  }
}

async function assertSafeFile(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new UnsafeArchiveError("archive file is not a regular file");
    if (modeOf(stats) & 0o077) throw new UnsafeArchiveError("archive file permissions are not restrictive");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeRestrictedFile(path: string, contents: string | Uint8Array): Promise<void> {
  await assertSafeFile(path);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  await assertSafeFile(path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    await assertSafeFile(path);
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function archivePaths(root: string): ExportArchivePaths {
  return {
    root,
    envelope: resolve(root, "export-envelope.json"),
    manifest: resolve(root, "manifest.json"),
    checkpoint: resolve(root, "checkpoint.json"),
    coverage: resolve(root, "coverage.json"),
    pages: resolve(root, "pages"),
    binaries: resolve(root, "binaries"),
  };
}

function ensureContained(root: string, candidate: string): void {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new UnsafeArchiveError("archive path escapes root");
}

export async function createRestrictedArchive(rootInput: string): Promise<ExportArchive> {
  if (!isAbsolute(rootInput) || rootInput.split(/[\\/]+/).includes("..")) throw new UnsafeArchiveError("archive root must be an absolute path without traversal");
  const root = resolve(rootInput);
  assertNotRoot(root);
  // A symlink anywhere at the leaf is unsafe. The parent is resolved to prevent a
  // caller from silently redirecting a newly-created archive through a symlink.
  await assertSafeDirectory(root);
  await assertSafeDirectory(resolve(root, "pages"));
  await assertSafeDirectory(resolve(root, "binaries"));
  const paths = archivePaths(root);
  for (const path of [paths.envelope, paths.manifest, paths.checkpoint, paths.coverage]) ensureContained(root, path);
  const pageFile = (collection: string, pageNumber: number, pageKey?: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(collection) || !Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new UnsafeArchiveError("invalid page archive path");
    if (pageKey !== undefined && !/^[A-Za-z0-9._-]+$/.test(pageKey)) throw new UnsafeArchiveError("invalid page archive key");
    const prefix = pageKey ? `${collection}-${pageKey}` : collection;
    const path = resolve(paths.pages, `${prefix}-${pageNumber}.json`);
    ensureContained(paths.pages, path);
    return path;
  };
  return {
    paths,
    async writeEnvelope(envelope: ExportEnvelope): Promise<string> {
      const encoded = canonicalJson(envelope);
      await writeRestrictedFile(paths.envelope, encoded);
      return sha256(encoded);
    },
    async writeManifest(manifest: RedactedExportManifest): Promise<void> {
      await writeRestrictedFile(paths.manifest, canonicalJson(manifest));
    },
    async writeCoverage(coverage: CollectionCoverage[]): Promise<void> {
      await writeRestrictedFile(paths.coverage, canonicalJson(coverage));
    },
    async writeCheckpoint(checkpoint: ExportCheckpoint): Promise<void> {
      await writeRestrictedFile(paths.checkpoint, canonicalJson(checkpoint));
    },
    async readCheckpoint(): Promise<ExportCheckpoint | null> {
      return readJson<ExportCheckpoint>(paths.checkpoint);
    },
    async writePage(collection: string, pageNumber: number, records: RentManagerRawRecord[], pageKey?: string): Promise<string> {
      const path = pageFile(collection, pageNumber, pageKey);
      await writeRestrictedFile(path, canonicalJson(records));
      return relative(root, path);
    },
    async readPages(pageFiles: string[]): Promise<RentManagerRawRecord[]> {
      const result: RentManagerRawRecord[] = [];
      for (const pageFilePath of pageFiles) {
        assertSafeRelativePath(pageFilePath);
        const path = resolve(root, pageFilePath);
        ensureContained(root, path);
        const records = await readJson<RentManagerRawRecord[]>(path);
        if (!records) throw new UnsafeArchiveError("checkpoint references a missing page");
        if (!Array.isArray(records)) throw new UnsafeArchiveError("archive page is not an array");
        result.push(...records);
      }
      return result;
    },
    async writeBinary(relativePath: string, bytes: Uint8Array): Promise<{ sha256: string; relativePath: string }> {
      assertSafeRelativePath(relativePath);
      const path = resolve(root, relativePath);
      ensureContained(root, path);
      await assertSafeDirectory(dirname(path));
      await writeRestrictedFile(path, bytes);
      return { sha256: sha256(bytes), relativePath: relative(root, path) };
    },
  };
}

/** An in-memory adapter is useful for tests and never writes raw data to output. */
export function createMemoryArchive(): ExportArchive {
  const pages = new Map<string, RentManagerRawRecord[]>();
  let checkpoint: ExportCheckpoint | null = null;
  const envelopePath = "memory://export-envelope.json";
  const paths: ExportArchivePaths = {
    root: "memory://",
    envelope: envelopePath,
    manifest: "memory://manifest.json",
    checkpoint: "memory://checkpoint.json",
    coverage: "memory://coverage.json",
    pages: "memory://pages",
    binaries: "memory://binaries",
  };
  return {
    paths,
    async writeEnvelope(envelope) {
      return sha256(canonicalJson(envelope));
    },
    async writeManifest() {},
    async writeCoverage() {},
    async writeCheckpoint(value) {
      checkpoint = structuredClone(value);
    },
    async readCheckpoint() {
      return checkpoint ? structuredClone(checkpoint) : null;
    },
    async writePage(collection, pageNumber, records, pageKey) {
      if (!/^[A-Za-z0-9._-]+$/.test(collection) || (pageKey !== undefined && !/^[A-Za-z0-9._-]+$/.test(pageKey))) throw new UnsafeArchiveError("invalid page archive path");
      const relativePath = `pages/${collection}-${pageKey ? `${pageKey}-` : ""}${pageNumber}.json`;
      pages.set(relativePath, structuredClone(records));
      return relativePath;
    },
    async readPages(pageFiles) {
      return pageFiles.flatMap((path) => structuredClone(pages.get(path) ?? []));
    },
    async writeBinary(relativePath, bytes) {
      return { sha256: sha256(bytes), relativePath };
    },
  };
}

export class MemoryCheckpointStore implements CheckpointStore {
  private checkpoint: ExportCheckpoint | null = null;

  async load(): Promise<ExportCheckpoint | null> {
    return this.checkpoint ? structuredClone(this.checkpoint) : null;
  }

  async save(checkpoint: ExportCheckpoint): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }
}

export async function createFileCheckpointStore(path: string): Promise<import("./types").CheckpointStore> {
  if (!isAbsolute(path) || path.split(/[\\/]+/).includes("..")) throw new UnsafeArchiveError("checkpoint path must be absolute and without traversal");
  const parent = dirname(resolve(path));
  await assertSafeDirectory(parent);
  return {
    async load() {
      return readJson<ExportCheckpoint>(resolve(path));
    },
    async save(checkpoint) {
      await writeRestrictedFile(resolve(path), canonicalJson(checkpoint));
    },
  };
}
