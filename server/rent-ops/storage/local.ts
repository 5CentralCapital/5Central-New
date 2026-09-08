import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, basename, dirname, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { storageError, isStorageError, mapStorageSystemError, StorageError } from "./errors";
import {
  assertSha256Checksum,
  checksumForLogicalKey,
  logicalKeyForChecksum,
  normalizeLogicalKey,
  SHA256_HEX_PATTERN,
  type LogicalObjectKey,
} from "./keys";
import { assertExactVersion, exactVersion } from "./version";
import type {
  CompensatingCleanupPlan,
  LocalStagingStoreApi as LocalStagingStoreContract,
  LocalStagingStoreOptions,
  ObjectStat,
  OrphanInventory,
  OrphanInventoryEntry,
  PutObjectInput,
  PutObjectResult,
  RentManagerImporterStorageFacade,
  SafeStorageLogger,
  SourceBinaryBinding,
  StaleTempInventoryEntry,
  StorageBackend,
  StorageByteStream,
  StorageReadAdapter,
  StorageVerificationRecord,
  VerifiedObjectOpen,
  VerificationOptions,
  ImporterPutFileOptions,
  StorageVersionOptions,
} from "./types";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MIN_BYTES = 1;
const COPY_CHUNK_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const FILE_PERMISSION_MASK = 0o777;
const TEMP_NAME_PATTERN = /^\.object-[A-Za-z0-9-]+\.tmp$/;

const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const SOURCE_READ_NOFOLLOW = READ_NOFOLLOW;
const WRITE_EXCLUSIVE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const DIRECTORY_READ_NOFOLLOW = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

interface ValidatedRoot {
  input: string;
  resolved: string;
}

interface OpenSource {
  handle: FileHandle;
  initial: FileSnapshot;
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  nlink: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface SourceDescriptorOptions {
  allowedRoot?: ValidatedRoot;
}

function modeOf(mode: number): number {
  return mode & FILE_PERMISSION_MASK;
}

function isRegularMode(mode: number): boolean {
  // S_IFMT is not exposed consistently by the Node typings. `isFile()` on a
  // Stats object is used for the actual check; this helper only handles mode.
  return (mode & 0o170000) === 0o100000;
}

function assertAbsoluteNoTraversal(path: string, code: "storage_invalid_root" | "storage_path_invalid"): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.split(/[\\/]+/).includes("..")) {
    throw storageError(code);
  }
  return resolve(path);
}

function assertNotFilesystemRoot(path: string): void {
  if (resolve(path) === parse(path).root) throw storageError("storage_invalid_root");
}

function isContained(root: string, candidate: string, allowEqual = true): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  if (allowEqual && rootResolved === candidateResolved) return true;
  const child = relative(rootResolved, candidateResolved);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertContained(root: string, candidate: string, code: "storage_root_inside_repository" | "storage_path_invalid" = "storage_path_invalid"): void {
  if (!isContained(root, candidate)) throw storageError(code);
}

function snapshot(stats: { dev: number; ino: number; size: number; nlink: number; mode: number; mtimeMs: number; ctimeMs: number }): FileSnapshot {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, nlink: stats.nlink, mode: stats.mode, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameIdentity(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function localImmutableGeneration(value: FileSnapshot): string {
  // Device/inode identity is private filesystem metadata and is stable for
  // the immutable published object without exposing a pathname or filename.
  return `local:${value.dev.toString(16)}:${value.ino.toString(16)}`;
}

function validateLimit(value: number | undefined, fallback: number, code: "storage_size_invalid" = "storage_size_invalid"): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw storageError(code);
  return result;
}

function expectedChecksum(input: PutObjectInput | VerificationOptions): string | undefined {
  const value = "expectedChecksumSha256" in input ? input.expectedChecksumSha256 : undefined;
  const alias = "checksumSha256" in input ? input.checksumSha256 : undefined;
  if (value !== undefined && alias !== undefined && value !== alias) throw storageError("storage_checksum_mismatch");
  const checksum = value ?? alias;
  return checksum === undefined ? undefined : assertSha256Checksum(checksum);
}

function expectedSize(input: PutObjectInput | VerificationOptions): number | undefined {
  const value = "expectedSizeBytes" in input ? input.expectedSizeBytes : undefined;
  const alias = "sizeBytes" in input ? input.sizeBytes : undefined;
  if (value !== undefined && alias !== undefined && value !== alias) throw storageError("storage_size_mismatch");
  const size = value ?? alias;
  return size === undefined ? undefined : validateLimit(size, size);
}

function bindingFor(input: PutObjectInput | VerificationOptions): SourceBinaryBinding | undefined {
  const binding = input.sourceBinaryBinding;
  if (binding === undefined) return input.importRunId === undefined ? undefined : { importRunId: input.importRunId };
  return input.importRunId === undefined || binding.importRunId !== undefined
    ? binding
    : { ...binding, importRunId: input.importRunId };
}

function record(
  backend: StorageBackend,
  logicalKey: LogicalObjectKey,
  checksumSha256: string,
  sizeBytes: number,
  state: StorageVerificationRecord["verificationState"],
  now: () => Date,
  options?: VerificationOptions,
  version?: { immutableGeneration?: string; immutableVersion?: string },
): StorageVerificationRecord {
  const binding = options ? bindingFor(options) : undefined;
  return {
    backend,
    logicalKey,
    checksumSha256,
    sizeBytes,
    verificationState: state,
    ...(version ?? {}),
    ...(state === "verified" ? { verifiedAt: now().toISOString() } : {}),
    ...(binding ? {
      sourceBinaryBinding: binding,
      sourceBinaryBindingId: binding.bindingId,
      importRunId: binding.importRunId,
    } : {}),
  };
}

async function validatePrivateDirectory(path: string, code: "storage_root_missing" | "storage_directory_invalid" = "storage_directory_invalid"): Promise<string> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw storageError(code === "storage_root_missing" ? "storage_root_symlink" : "storage_directory_invalid");
    if (!stats.isDirectory()) throw storageError(code);
    if (modeOf(stats.mode) !== PRIVATE_DIRECTORY_MODE) {
      throw storageError(code === "storage_root_missing" ? "storage_root_permissions" : "storage_directory_permissions");
    }
    return await realpath(path);
  } catch (error) {
    if (isStorageError(error)) throw error;
    throw mapStorageSystemError(error, code, { notFound: code === "storage_root_missing" ? "storage_root_missing" : "storage_directory_invalid" });
  }
}

async function ensurePrivateDirectory(path: string, code: "storage_root_missing" | "storage_directory_invalid"): Promise<string> {
  try {
    return await validatePrivateDirectory(path, code);
  } catch (error) {
    if (!isStorageError(error) || (error.code !== "storage_root_missing" && error.code !== "storage_directory_invalid")) throw error;
    // `validatePrivateDirectory` intentionally keeps its public code stable;
    // distinguish a missing child from an existing unsafe child here.
    try {
      await lstat(path);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      // It was absent when probed; this caller may provision it below.
      try {
        await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
        await chmod(path, PRIVATE_DIRECTORY_MODE);
        return await validatePrivateDirectory(path, code);
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException | undefined)?.code === "EEXIST") return validatePrivateDirectory(path, code);
        if (isStorageError(createError)) throw createError;
        throw mapStorageSystemError(createError, "storage_directory_invalid");
      }
    }
    // A concurrent writer provisioned the child between the first validation
    // and the probe. Revalidate its mode/type instead of reporting a race.
    return validatePrivateDirectory(path, code);
  }
}

async function validateRepositoryRoot(repositoryRoot: string): Promise<ValidatedRoot> {
  const input = assertAbsoluteNoTraversal(repositoryRoot, "storage_invalid_root");
  assertNotFilesystemRoot(input);
  try {
    return { input, resolved: await realpath(input) };
  } catch (error) {
    throw mapStorageSystemError(error, "storage_invalid_root", { notFound: "storage_invalid_root" });
  }
}

async function assertSecureObjectParent(path: string, objectsRoot: string): Promise<void> {
  if (!isContained(objectsRoot, path, false)) throw storageError("storage_path_invalid");
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw storageError("storage_destination_symlink");
    if (!stats.isDirectory()) throw storageError("storage_destination_nonregular");
    if (modeOf(stats.mode) !== PRIVATE_DIRECTORY_MODE) throw storageError("storage_destination_permissions");
    const resolvedPath = await realpath(path);
    // The parent is built from the already-canonical objects root. Any
    // changed intermediate symlink means the destination is no longer proven
    // to be inside that root.
    if (resolvedPath !== resolve(path) || !isContained(objectsRoot, resolvedPath, false)) throw storageError("storage_path_invalid");
  } catch (error) {
    if (isStorageError(error)) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw storageError("storage_destination_not_found");
    if (code === "ELOOP") throw storageError("storage_destination_symlink");
    throw mapStorageSystemError(error, "storage_destination_nonregular");
  }
}

async function assertNoSymlinkComponents(base: string, candidate: string): Promise<void> {
  const baseResolved = resolve(base);
  const candidateResolved = resolve(candidate);
  if (!isContained(baseResolved, candidateResolved)) throw storageError("storage_path_invalid");
  const remainder = relative(baseResolved, candidateResolved);
  let cursor = baseResolved;
  for (const component of remainder ? remainder.split(sep) : []) {
    cursor = resolve(cursor, component);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) throw storageError("storage_source_symlink");
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw sourcePathError(error);
    }
  }
}

export async function validateLocalStagingRoot(options: { root: string; repositoryRoot?: string; worktreeRoot?: string }): Promise<ValidatedRoot> {
  const input = assertAbsoluteNoTraversal(options.root, "storage_invalid_root");
  assertNotFilesystemRoot(input);
  let resolved: string;
  try {
    const stats = await lstat(input);
    if (stats.isSymbolicLink()) throw storageError("storage_root_symlink");
    if (!stats.isDirectory()) throw storageError("storage_invalid_root");
    if (modeOf(stats.mode) !== PRIVATE_DIRECTORY_MODE) throw storageError("storage_root_permissions");
    resolved = await realpath(input);
  } catch (error) {
    if (isStorageError(error)) throw error;
    throw mapStorageSystemError(error, "storage_invalid_root", { notFound: "storage_root_missing" });
  }
  const repositoryPath = options.repositoryRoot ?? options.worktreeRoot;
  if (repositoryPath !== undefined) {
    const repository = await validateRepositoryRoot(repositoryPath);
    if (isContained(repository.resolved, resolved)) throw storageError("storage_root_inside_repository");
  }
  return { input, resolved };
}

/** Explicit helper for provisioning a new dedicated private root. */
export async function createPrivateLocalStagingRoot(options: { root: string; repositoryRoot?: string; worktreeRoot?: string }): Promise<string> {
  const input = assertAbsoluteNoTraversal(options.root, "storage_invalid_root");
  assertNotFilesystemRoot(input);
  const repositoryPath = options.repositoryRoot ?? options.worktreeRoot;
  if (repositoryPath !== undefined) {
    const repository = await validateRepositoryRoot(repositoryPath);
    // A not-yet-created root can still be rejected lexically. Once created,
    // validateLocalStagingRoot repeats the realpath containment proof. Resolve
    // the existing parent first so a symlinked parent cannot redirect the new
    // directory into the repository after this check.
    let parentResolved: string;
    try {
      parentResolved = await realpath(dirname(input));
    } catch (error) {
      throw mapStorageSystemError(error, "storage_invalid_root", { notFound: "storage_invalid_root" });
    }
    if (isContained(repository.resolved, resolve(parentResolved, basename(input)))) throw storageError("storage_root_inside_repository");
  }
  try {
    await mkdir(input, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(input, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    throw mapStorageSystemError(error, "storage_invalid_root", { notFound: "storage_invalid_root" });
  }
  const validated = await validateLocalStagingRoot(options);
  return validated.resolved;
}

function sourcePathError(error: unknown): StorageError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return storageError("storage_source_not_found");
  if (code === "ELOOP") return storageError("storage_source_symlink");
  if (code === "EISDIR" || code === "ENOTDIR") return storageError("storage_source_nonregular");
  if (code === "EACCES" || code === "EPERM") return storageError("storage_source_permissions");
  return mapStorageSystemError(error, "storage_io_failed");
}

async function openSourceDescriptor(sourcePath: string, options: SourceDescriptorOptions): Promise<OpenSource> {
  const input = assertAbsoluteNoTraversal(sourcePath, "storage_path_invalid");
  const parent = dirname(input);
  let resolvedParent: string;
  try {
    resolvedParent = await realpath(parent);
  } catch (error) {
    throw sourcePathError(error);
  }
  if (options.allowedRoot) assertContained(options.allowedRoot.resolved, resolvedParent, "storage_path_invalid");
  if (options.allowedRoot) await assertNoSymlinkComponents(options.allowedRoot.input, parent);

  let handle: FileHandle;
  try {
    // The source final component is opened once with O_NOFOLLOW. All content
    // reads and the post-read fstat below use this same descriptor.
    handle = await open(input, SOURCE_READ_NOFOLLOW);
  } catch (error) {
    throw sourcePathError(error);
  }
  try {
    const stats = await handle.stat();
    const initial = snapshot(stats);
    if (!stats.isFile() || !isRegularMode(stats.mode)) throw storageError("storage_source_nonregular");
    if (initial.nlink !== 1) throw storageError("storage_source_hardlink");
    if ((modeOf(initial.mode) & 0o077) !== 0) throw storageError("storage_source_permissions");

    // Prove that the final path still resolves to the descriptor we opened.
    // This closes the common check/open replacement gap without trusting a
    // second descriptor for the actual read.
    let resolvedCandidate: string;
    try {
      if (options.allowedRoot) await assertNoSymlinkComponents(options.allowedRoot.input, parent);
      const lexicalStats = await lstat(input);
      if (lexicalStats.isSymbolicLink()) throw storageError("storage_source_symlink");
      resolvedCandidate = await realpath(input);
      if (options.allowedRoot) assertContained(options.allowedRoot.resolved, resolvedCandidate, "storage_path_invalid");
      const pathStats = await lstat(resolvedCandidate);
      if (pathStats.isSymbolicLink() || !pathStats.isFile()) throw storageError("storage_source_nonregular");
      if (pathStats.dev !== initial.dev || pathStats.ino !== initial.ino) throw storageError("storage_source_changed");
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw sourcePathError(error);
    }
    return { handle, initial };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (isStorageError(error)) throw error;
    throw sourcePathError(error);
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  await handle.close().catch(() => undefined);
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, DIRECTORY_READ_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    throw mapStorageSystemError(error, "storage_io_failed");
  } finally {
    await closeQuietly(handle);
  }
}

function toBufferChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk);
  throw storageError("storage_input_invalid");
}

async function copyAsyncStream(
  stream: StorageByteStream,
  destination: FileHandle,
  maxBytes: number,
  minBytes: number,
  hasher: ReturnType<typeof createHash>,
): Promise<number> {
  let total = 0;
  for await (const raw of stream) {
    const chunk = toBufferChunk(raw);
    if (chunk.byteLength === 0) continue;
    total += chunk.byteLength;
    if (total > maxBytes) throw storageError("storage_too_large");
    hasher.update(chunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const result = await destination.write(chunk, offset, chunk.byteLength - offset);
      if (result.bytesWritten <= 0) throw storageError("storage_io_failed");
      offset += result.bytesWritten;
    }
  }
  if (total < minBytes) throw storageError("storage_empty");
  return total;
}

async function copySourceDescriptor(
  source: FileHandle,
  destination: FileHandle,
  initial: FileSnapshot,
  maxBytes: number,
  minBytes: number,
  hasher: ReturnType<typeof createHash>,
): Promise<number> {
  if (initial.size > maxBytes) throw storageError("storage_too_large");
  if (initial.size < minBytes) throw storageError("storage_empty");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let total = 0;
  while (true) {
    const result = await source.read(buffer, 0, buffer.byteLength, null);
    if (result.bytesRead === 0) break;
    const chunk = buffer.subarray(0, result.bytesRead);
    total += result.bytesRead;
    if (total > maxBytes) throw storageError("storage_too_large");
    hasher.update(chunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const written = await destination.write(chunk, offset, chunk.byteLength - offset);
      if (written.bytesWritten <= 0) throw storageError("storage_io_failed");
      offset += written.bytesWritten;
    }
  }
  const finalStats = snapshot(await source.stat());
  if (!sameContentSnapshot(initial, finalStats)) throw storageError("storage_source_changed");
  if (total !== initial.size) throw storageError("storage_source_changed");
  if (total < minBytes) throw storageError("storage_empty");
  return total;
}

async function removeOwnTemp(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return true;
    return false;
  }
}

function opaqueTempToken(name: string): string {
  return `temp:${createHash("sha256").update(name).digest("hex")}`;
}

async function hasKnownPublishedTempLink(stagingRoot: string, targetSnapshot: FileSnapshot): Promise<boolean> {
  try {
    const resolvedStaging = await validatePrivateDirectory(stagingRoot, "storage_directory_invalid");
    if (resolvedStaging !== resolve(stagingRoot)) return false;
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    let matchingTemps = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !TEMP_NAME_PATTERN.test(entry.name)) continue;
      const candidate = resolve(stagingRoot, entry.name);
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats.mode) !== PRIVATE_FILE_MODE) continue;
      if (stats.dev === targetSnapshot.dev && stats.ino === targetSnapshot.ino) matchingTemps += 1;
    }
    // A published temp is exactly one extra private hard link to the target;
    // any additional hard links remain a hardlink-surprise rejection.
    return targetSnapshot.nlink === 2 && matchingTemps === 1;
  } catch {
    return false;
  }
}

function mapDestinationError(error: unknown): StorageError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ELOOP") return storageError("storage_destination_symlink");
  if (code === "EISDIR" || code === "ENOTDIR") return storageError("storage_destination_nonregular");
  if (code === "EACCES" || code === "EPERM") return storageError("storage_destination_permissions");
  if (code === "EEXIST") return storageError("storage_collision");
  return mapStorageSystemError(error, "storage_atomic_publish_failed");
}

async function openObjectDescriptor(path: string, kind: "stat" | "open" | "verify", objectsRoot: string, stagingRoot: string): Promise<{ handle: FileHandle; initial: FileSnapshot }> {
  await assertSecureObjectParent(dirname(path), objectsRoot);
  let handle: FileHandle;
  try {
    handle = await open(path, READ_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw storageError("storage_object_not_found");
    if (code === "ELOOP") throw storageError("storage_destination_symlink");
    if (code === "EISDIR" || code === "ENOTDIR") throw storageError("storage_destination_nonregular");
    if (code === "EACCES" || code === "EPERM") throw storageError("storage_destination_permissions");
    throw mapStorageSystemError(error, kind === "stat" ? "storage_io_failed" : "storage_io_failed");
  }
  try {
    const stats = await handle.stat();
    const initial = snapshot(stats);
    if (!stats.isFile() || !isRegularMode(stats.mode)) throw storageError("storage_destination_nonregular");
    if (initial.nlink !== 1 && !(await hasKnownPublishedTempLink(stagingRoot, initial))) throw storageError("storage_destination_hardlink");
    if (modeOf(initial.mode) !== PRIVATE_FILE_MODE) throw storageError("storage_destination_permissions");
    const pathStats = await lstat(path);
    if (pathStats.isSymbolicLink()) throw storageError("storage_destination_symlink");
    if (!pathStats.isFile()) throw storageError("storage_destination_nonregular");
    if (pathStats.dev !== initial.dev || pathStats.ino !== initial.ino) throw storageError("storage_destination_nonregular");
    await assertSecureObjectParent(dirname(path), objectsRoot);
    return { handle, initial };
  } catch (error) {
    await closeQuietly(handle);
    if (isStorageError(error)) throw error;
    throw mapDestinationError(error);
  }
}

async function readAndHash(handle: FileHandle, initial: FileSnapshot, maxBytes: number): Promise<{ checksumSha256: string; sizeBytes: number }> {
  if (initial.size > maxBytes) throw storageError("storage_too_large");
  const hasher = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let total = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, null);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
    if (total > maxBytes) throw storageError("storage_too_large");
    hasher.update(buffer.subarray(0, result.bytesRead));
  }
  const final = snapshot(await handle.stat());
  if (!sameContentSnapshot(initial, final) || total !== initial.size) throw storageError("storage_integrity_mismatch");
  if (total === 0) throw storageError("storage_empty");
  return { checksumSha256: hasher.digest("hex"), sizeBytes: total };
}

function safeLog(logger: SafeStorageLogger | undefined, method: "info" | "warn", event: Parameters<NonNullable<SafeStorageLogger["info"]>>[0], fields: { outcome?: string; code?: string; retryable?: boolean }): void {
  try {
    logger?.[method]?.(event, fields);
  } catch {
    // A logger must never change storage semantics or surface unsafe fields.
  }
}

function resultFromRecord(recordValue: StorageVerificationRecord, outcome: PutObjectResult["outcome"]): PutObjectResult {
  return { ...recordValue, outcome, created: outcome === "stored" };
}

/**
 * Local content-addressed staging store. Objects are published through an
 * atomic no-replace hard-link operation followed by removal of the private
 * temp name. Node does not expose Linux renameat2(RENAME_NOREPLACE); link(2)
 * gives the same immutable publication guarantee while preserving the
 * required no-overwrite collision semantics across concurrent writers.
 */
export class LocalStagingStore implements LocalStagingStoreContract {
  readonly backend: StorageBackend;
  readonly root: string;

  private readonly objectsRoot: string;
  private readonly stagingRoot: string;
  private readonly maxBytes: number;
  private readonly minBytes: number;
  private readonly sourceRoot?: ValidatedRoot;
  private readonly now: () => Date;
  private readonly logger?: SafeStorageLogger;

  private constructor(
    root: string,
    objectsRoot: string,
    stagingRoot: string,
    options: LocalStagingStoreOptions,
    sourceRoot?: ValidatedRoot,
  ) {
    this.root = root;
    this.objectsRoot = objectsRoot;
    this.stagingRoot = stagingRoot;
    this.backend = options.backend ?? "local-staging";
    this.maxBytes = validateLimit(options.maxBytes, DEFAULT_MAX_BYTES);
    this.minBytes = validateLimit(options.minBytes, DEFAULT_MIN_BYTES);
    if (this.minBytes < 1 || this.minBytes > this.maxBytes) throw storageError("storage_size_invalid");
    this.sourceRoot = sourceRoot;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  static async create(options: LocalStagingStoreOptions): Promise<LocalStagingStore> {
    const root = await validateLocalStagingRoot(options);
    const objectsRoot = await ensurePrivateDirectory(resolve(root.resolved, "objects"), "storage_directory_invalid");
    const stagingRoot = await ensurePrivateDirectory(resolve(root.resolved, "staging"), "storage_directory_invalid");
    let sourceRoot: ValidatedRoot | undefined;
    if (options.sourceRoot !== undefined) {
      const sourceInput = assertAbsoluteNoTraversal(options.sourceRoot, "storage_path_invalid");
      try {
        const sourceStats = await lstat(sourceInput);
        if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) throw storageError("storage_path_invalid");
        if (modeOf(sourceStats.mode) !== PRIVATE_DIRECTORY_MODE) throw storageError("storage_directory_permissions");
        const resolved = await realpath(sourceInput);
        if (isContained(root.resolved, resolved) || isContained(resolved, root.resolved)) throw storageError("storage_roots_overlap");
        const repositoryPath = options.repositoryRoot ?? options.worktreeRoot;
        if (repositoryPath !== undefined) {
          const repository = await validateRepositoryRoot(repositoryPath);
          if (isContained(repository.resolved, resolved)) throw storageError("storage_root_inside_repository");
        }
        sourceRoot = { input: sourceInput, resolved };
      } catch (error) {
        if (isStorageError(error)) throw error;
        throw mapStorageSystemError(error, "storage_path_invalid", { notFound: "storage_path_invalid" });
      }
    }
    return new LocalStagingStore(root.resolved, objectsRoot, stagingRoot, options, sourceRoot);
  }

  private objectPath(logicalKeyInput: LogicalObjectKey): { logicalKey: LogicalObjectKey; checksumSha256: string; shardRoot: string; path: string } {
    const logicalKey = normalizeLogicalKey(logicalKeyInput);
    const checksumSha256 = checksumForLogicalKey(logicalKey);
    const shardRoot = resolve(this.objectsRoot, checksumSha256.slice(0, 2));
    const path = resolve(shardRoot, checksumSha256);
    assertContained(this.objectsRoot, shardRoot);
    assertContained(this.objectsRoot, path);
    return { logicalKey, checksumSha256, shardRoot, path };
  }

  private async ensureShard(shardRoot: string): Promise<void> {
    await ensurePrivateDirectory(shardRoot, "storage_directory_invalid");
    assertContained(this.objectsRoot, shardRoot);
  }

  private async createTemp(): Promise<{ path: string; handle: FileHandle }> {
    await ensurePrivateDirectory(this.stagingRoot, "storage_directory_invalid");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const path = resolve(this.stagingRoot, `.object-${randomUUID()}.tmp`);
      assertContained(this.stagingRoot, path);
      try {
        const handle = await open(path, WRITE_EXCLUSIVE_NOFOLLOW, PRIVATE_FILE_MODE);
        await chmod(path, PRIVATE_FILE_MODE);
        return { path, handle };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "EEXIST") continue;
        throw mapStorageSystemError(error, "storage_io_failed", { symlink: "storage_destination_symlink" });
      }
    }
    throw storageError("storage_busy", true);
  }

  private async openInput(input: PutObjectInput): Promise<{ sourceHandle?: FileHandle; sourceSnapshot?: FileSnapshot; stream?: StorageByteStream }> {
    const supplied = [input.sourcePath !== undefined, input.bytes !== undefined, input.data !== undefined, input.stream !== undefined].filter(Boolean).length;
    if (supplied !== 1) throw storageError("storage_input_invalid");
    if (input.sourcePath !== undefined) {
      const allowedRoot = input.sourceRoot === undefined
        ? this.sourceRoot
        : await this.resolveAllowedSourceRoot(input.sourceRoot);
      const source = await openSourceDescriptor(input.sourcePath, { allowedRoot });
      return { sourceHandle: source.handle, sourceSnapshot: source.initial };
    }
    const bytes = input.bytes ?? input.data;
    if (bytes !== undefined) return { stream: Readable.from([bytes]) };
    return { stream: input.stream };
  }

  private async resolveAllowedSourceRoot(input: string): Promise<ValidatedRoot> {
    const sourceInput = assertAbsoluteNoTraversal(input, "storage_path_invalid");
    try {
      const stats = await lstat(sourceInput);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw storageError("storage_path_invalid");
      if (modeOf(stats.mode) !== PRIVATE_DIRECTORY_MODE) throw storageError("storage_directory_permissions");
      const resolved = await realpath(sourceInput);
      if (isContained(this.root, resolved) || isContained(resolved, this.root)) throw storageError("storage_roots_overlap");
      return { input: sourceInput, resolved };
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw mapStorageSystemError(error, "storage_path_invalid", { notFound: "storage_path_invalid" });
    }
  }

  /**
   * Import-only callers must prove that this store was configured with the
   * same private source root. This is intentionally public only as a guard;
   * it never returns the path or exposes a file-writing primitive.
   */
  async requireConfiguredSourceRoot(input: string): Promise<void> {
    if (!this.sourceRoot) throw storageError("storage_import_source_root_required");
    let requested: ValidatedRoot;
    try {
      requested = await this.resolveAllowedSourceRoot(input);
    } catch (error) {
      // A caller-provided root that overlaps the private store is also not
      // the configured import root. Preserve the stable facade mismatch code
      // without revealing either path.
      if (isStorageError(error) && error.code === "storage_roots_overlap") throw storageError("storage_import_source_root_mismatch");
      throw error;
    }
    if (requested.resolved !== this.sourceRoot.resolved) throw storageError("storage_import_source_root_mismatch");
  }

  private async verifyExisting(path: string, object: { logicalKey: LogicalObjectKey; checksumSha256: string }, options?: VerificationOptions): Promise<StorageVerificationRecord> {
    const expected = expectedChecksum(options ?? {}) ?? object.checksumSha256;
    const expectedBytes = expectedSize(options ?? {});
    if (expected !== object.checksumSha256) throw storageError("storage_logical_key_invalid");
    const opened = await openObjectDescriptor(path, "verify", this.objectsRoot, this.stagingRoot);
    try {
      const actual = await readAndHash(opened.handle, opened.initial, this.maxBytes);
      if (actual.checksumSha256 !== object.checksumSha256) throw storageError("storage_collision");
      if (expectedBytes !== undefined && actual.sizeBytes !== expectedBytes) throw storageError("storage_size_mismatch");
      const version = { immutableGeneration: localImmutableGeneration(opened.initial) };
      assertExactVersion(version, exactVersion(options));
      return record(this.backend, object.logicalKey, actual.checksumSha256, actual.sizeBytes, "verified", this.now, options, version);
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw storageError("storage_integrity_mismatch");
    } finally {
      await closeQuietly(opened.handle);
    }
  }

  /**
   * Verify and return a stream from the same no-follow descriptor. The
   * descriptor is hashed to EOF first, then rewound by the read-stream's
   * explicit start offset; no pathname is reopened between those operations.
   */
  private async openVerifiedExisting(path: string, object: { logicalKey: LogicalObjectKey; checksumSha256: string }, options?: VerificationOptions): Promise<VerifiedObjectOpen> {
    const expected = expectedChecksum(options ?? {}) ?? object.checksumSha256;
    const expectedBytes = expectedSize(options ?? {});
    if (expected !== object.checksumSha256) throw storageError("storage_logical_key_invalid");
    const opened = await openObjectDescriptor(path, "verify", this.objectsRoot, this.stagingRoot);
    let transferred = false;
    try {
      const actual = await readAndHash(opened.handle, opened.initial, this.maxBytes);
      if (actual.checksumSha256 !== object.checksumSha256) throw storageError("storage_collision");
      if (expectedBytes !== undefined && actual.sizeBytes !== expectedBytes) throw storageError("storage_size_mismatch");
      const version = { immutableGeneration: localImmutableGeneration(opened.initial) };
      assertExactVersion(version, exactVersion(options));
      const verification = record(this.backend, object.logicalKey, actual.checksumSha256, actual.sizeBytes, "verified", this.now, options, version);
      const stream = opened.handle.createReadStream({ autoClose: true, start: 0, end: actual.sizeBytes - 1 });
      transferred = true;
      return { stream, verification };
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw storageError("storage_integrity_mismatch");
    } finally {
      if (!transferred) await closeQuietly(opened.handle);
    }
  }

  async putIfAbsent(input: PutObjectInput): Promise<PutObjectResult> {
    const expected = expectedChecksum(input);
    const expectedBytes = expectedSize(input);
    const requestedKey = input.logicalKey === undefined ? undefined : normalizeLogicalKey(input.logicalKey);
    if (requestedKey && expected && checksumForLogicalKey(requestedKey) !== expected) throw storageError("storage_logical_key_invalid");
    if (expectedBytes !== undefined && expectedBytes < this.minBytes) throw storageError("storage_empty");
    if (expectedBytes !== undefined && expectedBytes > this.maxBytes) throw storageError("storage_too_large");

    let sourceHandle: FileHandle | undefined;
    let tempHandle: FileHandle | undefined;
    let tempPath: string | undefined;
    try {
      const source = await this.openInput(input);
      sourceHandle = source.sourceHandle;
      const temp = await this.createTemp();
      tempHandle = temp.handle;
      tempPath = temp.path;
      const hasher = createHash("sha256");
      const sizeBytes = sourceHandle && source.sourceSnapshot
        ? await copySourceDescriptor(sourceHandle, tempHandle, source.sourceSnapshot, this.maxBytes, this.minBytes, hasher)
        : await copyAsyncStream(source.stream as StorageByteStream, tempHandle, this.maxBytes, this.minBytes, hasher);
      const checksumSha256 = hasher.digest("hex");
      if (expectedBytes !== undefined && sizeBytes !== expectedBytes) throw storageError("storage_size_mismatch");
      if (expected !== undefined && checksumSha256 !== expected) throw storageError("storage_checksum_mismatch");
      if (requestedKey && checksumForLogicalKey(requestedKey) !== checksumSha256) throw storageError("storage_checksum_mismatch");
      const logicalKey = logicalKeyForChecksum(checksumSha256);
      const object = this.objectPath(logicalKey);

      await tempHandle.sync();
      await chmod(tempPath, PRIVATE_FILE_MODE);
      await closeQuietly(tempHandle);
      tempHandle = undefined;
      await this.ensureShard(object.shardRoot);
      await assertSecureObjectParent(object.shardRoot, this.objectsRoot);

      let outcome: PutObjectResult["outcome"] = "stored";
      try {
        // link(2) is atomic and fails with EEXIST instead of overwriting an
        // immutable object. The temp and target are on the same filesystem.
        await link(tempPath, object.path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "EEXIST") throw mapDestinationError(error);
        outcome = "already_present";
      }
      // A crash or transient filesystem error may leave this private temp
      // hard-linked to the accepted object. Keep the name tracked so the
      // inventory can prove that cleanup is safe on a later run.
      if (await removeOwnTemp(tempPath)) tempPath = undefined;
      await assertSecureObjectParent(object.shardRoot, this.objectsRoot);
      await syncDirectory(object.shardRoot);

      const verified = await this.verifyExisting(object.path, object, {
        expectedChecksumSha256: checksumSha256,
        expectedSizeBytes: sizeBytes,
        sourceBinaryBinding: input.sourceBinaryBinding,
        importRunId: input.importRunId,
      });
      safeLog(this.logger, "info", "storage_put", { outcome });
      return resultFromRecord(verified, outcome);
    } catch (error) {
      const publicError = isStorageError(error) ? error : mapStorageSystemError(error, "storage_io_failed");
      safeLog(this.logger, "warn", "storage_put", { code: publicError.code, retryable: publicError.retryable });
      throw publicError;
    } finally {
      await closeQuietly(sourceHandle);
      await closeQuietly(tempHandle);
      if (tempPath) await removeOwnTemp(tempPath);
    }
  }

  async putFile(sourcePath: string, options: Omit<PutObjectInput, "sourcePath" | "bytes" | "data" | "stream"> = {}): Promise<PutObjectResult> {
    return this.putIfAbsent({ ...options, sourcePath });
  }

  async putBytes(bytes: Uint8Array, options: Omit<PutObjectInput, "sourcePath" | "bytes" | "data" | "stream"> = {}): Promise<PutObjectResult> {
    return this.putIfAbsent({ ...options, bytes });
  }

  async stat(logicalKeyInput: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<ObjectStat | null> {
    const object = this.objectPath(logicalKeyInput);
    let opened: { handle: FileHandle; initial: FileSnapshot };
    try {
      opened = await openObjectDescriptor(object.path, "stat", this.objectsRoot, this.stagingRoot);
    } catch (error) {
      if (isStorageError(error) && error.code === "storage_object_not_found") return null;
      throw error;
    }
    try {
      safeLog(this.logger, "info", "storage_stat", { outcome: "present" });
      const version = { immutableGeneration: localImmutableGeneration(opened.initial) };
      assertExactVersion(version, exactVersion(options));
      return {
        backend: this.backend,
        logicalKey: object.logicalKey,
        checksumSha256: object.checksumSha256,
        sizeBytes: opened.initial.size,
        ...version,
      };
    } finally {
      await closeQuietly(opened.handle);
    }
  }

  async open(logicalKeyInput: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<Readable> {
    const object = this.objectPath(logicalKeyInput);
    const opened = await openObjectDescriptor(object.path, "open", this.objectsRoot, this.stagingRoot);
    try {
      assertExactVersion({ immutableGeneration: localImmutableGeneration(opened.initial) }, exactVersion(options));
    } catch (error) {
      await closeQuietly(opened.handle);
      throw error;
    }
    safeLog(this.logger, "info", "storage_open", { outcome: "opened" });
    // The stream owns and closes this descriptor. It does not expose the
    // local filename/path to callers.
    return opened.handle.createReadStream({ autoClose: true });
  }

  async openVerified(logicalKeyInput: LogicalObjectKey, options: VerificationOptions = {}): Promise<VerifiedObjectOpen> {
    const object = this.objectPath(logicalKeyInput);
    const opened = await this.openVerifiedExisting(object.path, object, options);
    safeLog(this.logger, "info", "storage_open", { outcome: "verified" });
    return opened;
  }

  async verify(logicalKeyInput: LogicalObjectKey, options: VerificationOptions = {}): Promise<StorageVerificationRecord> {
    const object = this.objectPath(logicalKeyInput);
    const verified = await this.verifyExisting(object.path, object, options);
    safeLog(this.logger, "info", "storage_verify", { outcome: verified.verificationState });
    return verified;
  }

  private async inventoryStagingTemps(): Promise<StaleTempInventoryEntry[]> {
    let tempEntries;
    try {
      tempEntries = await readdir(this.stagingRoot, { withFileTypes: true });
    } catch (error) {
      throw mapStorageSystemError(error, "storage_inventory_invalid");
    }
    const staleTemps: StaleTempInventoryEntry[] = [];
    for (const entry of tempEntries) {
      if (!TEMP_NAME_PATTERN.test(entry.name)) throw storageError("storage_inventory_invalid");
      if (entry.isSymbolicLink() || !entry.isFile()) throw storageError("storage_inventory_invalid");
      const tempPath = resolve(this.stagingRoot, entry.name);
      assertContained(this.stagingRoot, tempPath);
      let handle: FileHandle | undefined;
      try {
        handle = await open(tempPath, READ_NOFOLLOW);
        const stats = await handle.stat();
        const initial = snapshot(stats);
        if (!stats.isFile() || !isRegularMode(stats.mode) || modeOf(initial.mode) !== PRIVATE_FILE_MODE) {
          throw storageError("storage_inventory_invalid");
        }
        const tempToken = opaqueTempToken(entry.name);
        if (initial.size === 0) {
          staleTemps.push({
            backend: this.backend,
            tempToken,
            sizeBytes: 0,
            classification: "unverified_temp",
            verificationState: "unverified",
            sameObjectIdentity: false,
            safeToRemove: false,
          });
          continue;
        }
        let actual: { checksumSha256: string; sizeBytes: number };
        try {
          actual = await readAndHash(handle, initial, this.maxBytes);
        } catch (error) {
          if (isStorageError(error)) {
            staleTemps.push({
              backend: this.backend,
              tempToken,
              sizeBytes: initial.size,
              classification: "unverified_temp",
              verificationState: "mismatch",
              sameObjectIdentity: false,
              safeToRemove: false,
            });
            continue;
          }
          throw storageError("storage_inventory_invalid");
        }
        const logicalKey = logicalKeyForChecksum(actual.checksumSha256);
        const object = this.objectPath(logicalKey);
        let targetSnapshot: FileSnapshot | undefined;
        try {
          await assertSecureObjectParent(object.shardRoot, this.objectsRoot);
          const targetHandle = await open(object.path, READ_NOFOLLOW);
          try {
            const targetStats = await targetHandle.stat();
            const candidate = snapshot(targetStats);
            if (targetStats.isFile() && isRegularMode(targetStats.mode) && modeOf(candidate.mode) === PRIVATE_FILE_MODE) targetSnapshot = candidate;
          } finally {
            await closeQuietly(targetHandle);
          }
        } catch (error) {
          if (!(isStorageError(error) && error.code === "storage_object_not_found")) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (code !== "ENOENT" && !(isStorageError(error) && error.code === "storage_destination_not_found")) throw storageError("storage_inventory_invalid");
          }
        }
        const sameObjectIdentity = Boolean(targetSnapshot && sameIdentity(initial, targetSnapshot));
        const published = sameObjectIdentity && initial.nlink === 2 && targetSnapshot?.nlink === 2;
        staleTemps.push({
          backend: this.backend,
          tempToken,
          logicalKey,
          checksumSha256: actual.checksumSha256,
          sizeBytes: actual.sizeBytes,
          classification: published ? "published_linked_temp" : "unpublished_temp",
          verificationState: "verified",
          sameObjectIdentity,
          safeToRemove: published,
        });
      } catch (error) {
        if (isStorageError(error)) throw error;
        throw storageError("storage_inventory_invalid");
      } finally {
        await closeQuietly(handle);
      }
    }
    staleTemps.sort((left, right) => left.tempToken.localeCompare(right.tempToken));
    return staleTemps;
  }

  async inventoryOrphans(referencedLogicalKeys: Iterable<LogicalObjectKey>): Promise<OrphanInventory> {
    const referenced = new Set<string>();
    try {
      for (const key of Array.from(referencedLogicalKeys)) referenced.add(normalizeLogicalKey(key));
    } catch {
      throw storageError("storage_inventory_invalid");
    }
    const entries: OrphanInventoryEntry[] = [];
    let objectCount = 0;
    let shardEntries;
    try {
      shardEntries = await readdir(this.objectsRoot, { withFileTypes: true });
    } catch (error) {
      throw mapStorageSystemError(error, "storage_inventory_invalid");
    }
    for (const shard of shardEntries) {
      if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(shard.name)) throw storageError("storage_inventory_invalid");
      const shardPath = resolve(this.objectsRoot, shard.name);
      assertContained(this.objectsRoot, shardPath);
      const files = await readdir(shardPath, { withFileTypes: true });
      for (const file of files) {
        if (file.isSymbolicLink() || !file.isFile() || !SHA256_HEX_PATTERN.test(file.name) || !file.name.startsWith(shard.name)) {
          throw storageError("storage_inventory_invalid");
        }
        objectCount += 1;
        const logicalKey = logicalKeyForChecksum(file.name);
        if (referenced.has(logicalKey)) continue;
        const object = this.objectPath(logicalKey);
        try {
          const verified = await this.verify(object.logicalKey);
          entries.push({
            backend: this.backend,
            logicalKey: object.logicalKey,
            checksumSha256: verified.checksumSha256,
            sizeBytes: verified.sizeBytes,
            classification: "orphan",
            verificationState: "verified",
          });
        } catch (error) {
          if (!isStorageError(error)) throw storageError("storage_inventory_invalid");
          const stat = await this.stat(object.logicalKey);
          entries.push({
            backend: this.backend,
            logicalKey: object.logicalKey,
            checksumSha256: object.checksumSha256,
            sizeBytes: stat?.sizeBytes ?? 0,
            classification: "orphan",
            verificationState: "mismatch",
          });
        }
      }
    }
    entries.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
    const staleTemps = await this.inventoryStagingTemps();
    const inventory: OrphanInventory = {
      backend: this.backend,
      generatedAt: this.now().toISOString(),
      referencedCount: referenced.size,
      objectCount,
      orphanCount: entries.length,
      entries,
      staleTemps,
      staleTempCount: staleTemps.length,
    };
    safeLog(this.logger, "info", "storage_inventory", { outcome: `${entries.length + staleTemps.length}` });
    return inventory;
  }

  planCompensatingCleanup(inventory: OrphanInventory): CompensatingCleanupPlan {
    if (inventory.backend !== this.backend) throw storageError("storage_inventory_invalid");
    const objectActions = inventory.entries.map((entry) => ({
      logicalKey: entry.logicalKey,
      action: entry.verificationState === "verified" ? "quarantine_then_review" as const : "manual_review" as const,
      reason: entry.verificationState === "verified" ? "unreferenced_object" as const : "verification_failed" as const,
      requiresApproval: true as const,
    }));
    const tempActions = inventory.staleTemps.map((entry) => ({
      tempToken: entry.tempToken,
      logicalKey: entry.logicalKey,
      action: entry.safeToRemove ? "remove_stale_temp" as const : "manual_review" as const,
      reason: entry.classification === "published_linked_temp"
        ? "published_temp" as const
        : entry.classification === "unpublished_temp" ? "unpublished_temp" as const : "unverified_temp" as const,
      requiresApproval: true as const,
      safeToRemove: entry.safeToRemove,
    }));
    return {
      backend: this.backend,
      generatedAt: this.now().toISOString(),
      destructiveDeletionImplemented: false,
      actions: [...objectActions, ...tempActions],
    };
  }
}

export async function createLocalStagingStore(options: LocalStagingStoreOptions): Promise<LocalStagingStore> {
  return LocalStagingStore.create(options);
}

export const createLocalDocumentStore = createLocalStagingStore;
export const createPrivateLocalStagingStore = createLocalStagingStore;

/**
 * Strict RM-import seam. It exposes only `putFile`, binds every call to the
 * store's configured source root, and cannot be constructed around a store
 * that accepts arbitrary absolute private files.
 */
export async function createImporterStorageFacade(
  store: LocalStagingStore,
  options: { sourceRoot: string },
): Promise<RentManagerImporterStorageFacade> {
  await store.requireConfiguredSourceRoot(options.sourceRoot);
  return Object.freeze({
    putFile: async (sourcePath: string, input: ImporterPutFileOptions = {}) => {
      if (input.sourceRoot !== undefined) await store.requireConfiguredSourceRoot(input.sourceRoot);
      const { sourceRoot: _ignoredSourceRoot, ...putOptions } = input;
      return store.putFile(sourcePath, { ...putOptions, sourceRoot: options.sourceRoot });
    },
  });
}

export const createRentManagerImportStorageFacade = createImporterStorageFacade;
export const createRmImporterStorageFacade = createImporterStorageFacade;

/** Read-only adapter intentionally omits put, inventory, and any delete/list surface. */
export function createRuntimeReadAdapter(store: StorageReadAdapter): StorageReadAdapter {
  return Object.freeze({
    backend: store.backend,
    stat: (logicalKey: LogicalObjectKey, options?: StorageVersionOptions) => store.stat(logicalKey, options),
    open: (logicalKey: LogicalObjectKey, options?: StorageVersionOptions) => store.open(logicalKey, options),
    verify: (logicalKey: LogicalObjectKey, options?: VerificationOptions) => store.verify(logicalKey, options),
    openVerified: (logicalKey: LogicalObjectKey, options?: VerificationOptions) => store.openVerified(logicalKey, options),
  });
}
