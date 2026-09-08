import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { storageError, isStorageError } from "./errors";
import { assertSha256Checksum, logicalKeyForChecksum, normalizeLogicalKey, checksumForLogicalKey, type LogicalObjectKey } from "./keys";
import type { Sha256Checksum } from "./keys";
import { assertExactVersion, exactVersion, hasExactVersion } from "./version";
import type {
  ContentAddressedObjectStore,
  ObjectStat,
  PrivateObjectStorePrivilegeProbe,
  PrivateObjectStorePrivilegeReport,
  PrivateVersionedObjectStoreClient,
  PutObjectInput,
  PutObjectResult,
  SourceBinaryBinding,
  StorageBackend,
  StorageByteStream,
  StorageReadAdapter,
  StorageVerificationRecord,
  VerifiedObjectOpen,
  VerificationOptions,
  StorageVersionOptions,
} from "./types";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MIN_BYTES = 1;

function expectedChecksum(input: PutObjectInput | VerificationOptions): string | undefined {
  const value = "expectedChecksumSha256" in input ? input.expectedChecksumSha256 : undefined;
  const alias = "checksumSha256" in input ? input.checksumSha256 : undefined;
  if (value !== undefined && alias !== undefined && value !== alias) throw storageError("storage_checksum_mismatch");
  return value === undefined && alias === undefined ? undefined : assertSha256Checksum(value ?? alias!);
}

function expectedSize(input: PutObjectInput | VerificationOptions): number | undefined {
  const value = "expectedSizeBytes" in input ? input.expectedSizeBytes : undefined;
  const alias = "sizeBytes" in input ? input.sizeBytes : undefined;
  if (value !== undefined && alias !== undefined && value !== alias) throw storageError("storage_size_mismatch");
  const size = value ?? alias;
  if (size === undefined) return undefined;
  if (!Number.isSafeInteger(size) || size < 0) throw storageError("storage_size_invalid");
  return size;
}

function bindingFor(input: PutObjectInput | VerificationOptions): SourceBinaryBinding | undefined {
  if (input.sourceBinaryBinding) return input.importRunId && !input.sourceBinaryBinding.importRunId
    ? { ...input.sourceBinaryBinding, importRunId: input.importRunId }
    : input.sourceBinaryBinding;
  return input.importRunId === undefined ? undefined : { importRunId: input.importRunId };
}

function makeRecord(
  backend: StorageBackend,
  logicalKey: LogicalObjectKey,
  checksumSha256: string,
  sizeBytes: number,
  state: StorageVerificationRecord["verificationState"],
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
    ...(state === "verified" ? { verifiedAt: new Date().toISOString() } : {}),
    ...(binding ? {
      sourceBinaryBinding: binding,
      sourceBinaryBindingId: binding.bindingId,
      importRunId: binding.importRunId,
    } : {}),
  };
}

async function materializeStream(stream: StorageByteStream, maxBytes: number, minBytes: number): Promise<{ bytes: Buffer; checksumSha256: string; sizeBytes: number }> {
  const hasher = createHash("sha256");
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const raw of stream) {
    if (!(raw instanceof Uint8Array) && typeof raw !== "string") throw storageError("storage_input_invalid");
    const chunk = Buffer.from(raw as Uint8Array | string);
    if (chunk.length === 0) continue;
    sizeBytes += chunk.length;
    if (sizeBytes > maxBytes) throw storageError("storage_too_large");
    hasher.update(chunk);
    chunks.push(chunk);
  }
  if (sizeBytes < minBytes) throw storageError("storage_empty");
  return { bytes: Buffer.concat(chunks, sizeBytes), checksumSha256: hasher.digest("hex"), sizeBytes };
}

function inputStream(input: PutObjectInput): StorageByteStream {
  const supplied = [input.bytes !== undefined, input.data !== undefined, input.stream !== undefined, input.sourcePath !== undefined].filter(Boolean).length;
  if (input.sourcePath !== undefined || supplied !== 1) throw storageError("storage_input_invalid");
  if (input.bytes !== undefined) return Readable.from([input.bytes]);
  if (input.data !== undefined) return Readable.from([input.data]);
  return input.stream!;
}

/**
 * Small in-memory implementation used by contract tests and callers that
 * need a deterministic fake. It intentionally accepts bytes/streams only;
 * source paths are a local-staging concern.
 */
export class InMemoryObjectStore implements ContentAddressedObjectStore {
  readonly backend: StorageBackend = "private-versioned-object-store";
  private readonly values = new Map<string, { bytes: Buffer; generation: string }>();
  private readonly maxBytes: number;
  private readonly minBytes: number;
  private generation = 0;

  constructor(options: { maxBytes?: number; minBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || !Number.isSafeInteger(this.minBytes) || this.minBytes < 1 || this.minBytes > this.maxBytes) {
      throw storageError("storage_size_invalid");
    }
  }

  async putIfAbsent(input: PutObjectInput): Promise<PutObjectResult> {
    const expected = expectedChecksum(input);
    const expectedBytes = expectedSize(input);
    const materialized = await materializeStream(inputStream(input), this.maxBytes, this.minBytes);
    if (expectedBytes !== undefined && expectedBytes !== materialized.sizeBytes) throw storageError("storage_size_mismatch");
    if (expected !== undefined && expected !== materialized.checksumSha256) throw storageError("storage_checksum_mismatch");
    const requestedKey = input.logicalKey === undefined ? undefined : normalizeLogicalKey(input.logicalKey);
    if (requestedKey && checksumForLogicalKey(requestedKey) !== materialized.checksumSha256) throw storageError("storage_checksum_mismatch");
    const logicalKey = logicalKeyForChecksum(materialized.checksumSha256);
    const existing = this.values.get(logicalKey);
    if (existing) {
      if (existing.bytes.length !== materialized.sizeBytes || !existing.bytes.equals(materialized.bytes)) throw storageError("storage_collision");
      return {
        ...makeRecord(this.backend, logicalKey, materialized.checksumSha256, materialized.sizeBytes, "verified", input),
        immutableGeneration: existing.generation,
        outcome: "already_present",
        created: false,
      };
    }
    const generation = `memory-${++this.generation}`;
    this.values.set(logicalKey, { bytes: Buffer.from(materialized.bytes), generation });
    return {
      ...makeRecord(this.backend, logicalKey, materialized.checksumSha256, materialized.sizeBytes, "verified", input, { immutableGeneration: generation }),
      outcome: "stored",
      created: true,
    };
  }

  async stat(logicalKeyInput: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<ObjectStat | null> {
    const logicalKey = normalizeLogicalKey(logicalKeyInput);
    const value = this.values.get(logicalKey);
    if (!value) return null;
    assertExactVersion({ immutableGeneration: value.generation }, exactVersion(options));
    const checksumSha256 = checksumForLogicalKey(logicalKey);
    return {
      backend: this.backend,
      logicalKey,
      checksumSha256,
      sizeBytes: value.bytes.length,
      immutableGeneration: value.generation,
    };
  }

  async open(logicalKeyInput: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<Readable> {
    const logicalKey = normalizeLogicalKey(logicalKeyInput);
    const value = this.values.get(logicalKey);
    if (!value) throw storageError("storage_object_not_found");
    assertExactVersion({ immutableGeneration: value.generation }, exactVersion(options));
    return Readable.from([Buffer.from(value.bytes)]);
  }

  async openVerified(logicalKeyInput: LogicalObjectKey, options: VerificationOptions = {}): Promise<VerifiedObjectOpen> {
    const logicalKey = normalizeLogicalKey(logicalKeyInput);
    const verification = await this.verify(logicalKey, options);
    const value = this.values.get(logicalKey);
    if (!value) throw storageError("storage_object_not_found");
    return { stream: Readable.from([Buffer.from(value.bytes)]), verification };
  }

  async verify(logicalKeyInput: LogicalObjectKey, options: VerificationOptions = {}): Promise<StorageVerificationRecord> {
    const logicalKey = normalizeLogicalKey(logicalKeyInput);
    const value = this.values.get(logicalKey);
    if (!value) throw storageError("storage_object_not_found");
    assertExactVersion({ immutableGeneration: value.generation }, exactVersion(options));
    const expected = expectedChecksum(options);
    const expectedBytes = expectedSize(options);
    const checksumSha256 = checksumForLogicalKey(logicalKey);
    if (expected !== undefined && expected !== checksumSha256) throw storageError("storage_logical_key_invalid");
    if (expectedBytes !== undefined && expectedBytes !== value.bytes.length) throw storageError("storage_size_mismatch");
    const actual = createHash("sha256").update(value.bytes).digest("hex");
    if (actual !== checksumSha256) throw storageError("storage_integrity_mismatch");
    return {
      ...makeRecord(this.backend, logicalKey, actual, value.bytes.length, "verified", options, { immutableGeneration: value.generation }),
    };
  }
}

export function createInMemoryObjectStore(options: { maxBytes?: number; minBytes?: number } = {}): InMemoryObjectStore {
  return new InMemoryObjectStore(options);
}

/**
 * Keep the future vendor adapter dependency-inverted. The transport owns
 * authentication, private-endpoint selection, conditional puts, and stream
 * reads; this wrapper only enforces the content-addressed request shape.
 */
export class PrivateVersionedObjectStoreAdapter implements ContentAddressedObjectStore {
  readonly backend: StorageBackend = "private-versioned-object-store";

  constructor(protected readonly client: PrivateVersionedObjectStoreClient) {}

  async putIfAbsent(input: PutObjectInput): Promise<PutObjectResult> {
    const materialized = await materializeStream(inputStream(input), DEFAULT_MAX_BYTES, DEFAULT_MIN_BYTES);
    const expected = expectedChecksum(input);
    const expectedBytes = expectedSize(input);
    if (expected !== undefined && expected !== materialized.checksumSha256) throw storageError("storage_checksum_mismatch");
    if (expectedBytes !== undefined && expectedBytes !== materialized.sizeBytes) throw storageError("storage_size_mismatch");
    const logicalKey = logicalKeyForChecksum(materialized.checksumSha256);
    const requested = input.logicalKey === undefined ? undefined : normalizeLogicalKey(input.logicalKey);
    if (requested && requested !== logicalKey) throw storageError("storage_logical_key_invalid");
    const response = await this.client.putIfAbsent({
      logicalKey,
      body: Readable.from([materialized.bytes]),
      checksumSha256: materialized.checksumSha256,
      sizeBytes: materialized.sizeBytes,
    });
    const responseVersion = exactVersion(response);
    if (!hasExactVersion(responseVersion)) throw storageError("storage_version_missing");
    const verified = await this.verify(logicalKey, {
      expectedChecksumSha256: materialized.checksumSha256,
      expectedSizeBytes: materialized.sizeBytes,
      sourceBinaryBinding: input.sourceBinaryBinding,
      importRunId: input.importRunId,
      immutableGeneration: responseVersion.immutableGeneration,
      immutableVersion: responseVersion.immutableVersion,
    });
    assertExactVersion(verified, responseVersion, true);
    return {
      ...verified,
      outcome: response.existed ? "already_present" : "stored",
      created: !response.existed,
    };
  }

  async stat(logicalKey: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<ObjectStat | null> {
    const normalized = normalizeLogicalKey(logicalKey);
    const expected = exactVersion(options);
    const value = await this.client.stat(normalized, expected);
    if (!value) return null;
    const actual = assertExactVersion(value, expected, true);
    if (!hasExactVersion(actual)) throw storageError("storage_version_missing");
    return { ...value, ...actual, backend: this.backend, logicalKey: normalized };
  }

  async open(logicalKey: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<Readable> {
    const expected = exactVersion(options);
    if (!hasExactVersion(expected)) throw storageError("storage_version_missing");
    return this.client.open(normalizeLogicalKey(logicalKey), expected);
  }

  async openVerified(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<VerifiedObjectOpen> {
    const normalized = normalizeLogicalKey(logicalKey);
    const expected = exactVersion(options);
    if (!hasExactVersion(expected)) throw storageError("storage_version_missing");
    const value = await this.client.openVerified(normalized, { ...options, ...expected });
    assertExactVersion(value.verification, expected, true);
    if (!hasExactVersion(value.verification)) throw storageError("storage_version_missing");
    return {
      ...value,
      verification: { ...value.verification, ...expected, backend: this.backend, logicalKey: normalized },
    };
  }

  async verify(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<StorageVerificationRecord> {
    const normalized = normalizeLogicalKey(logicalKey);
    const expected = exactVersion(options);
    const value = await this.client.verify(normalized, { ...options, ...expected });
    const actual = assertExactVersion(value, expected, true);
    if (!hasExactVersion(actual)) throw storageError("storage_version_missing");
    return { ...value, ...actual, backend: this.backend, logicalKey: normalized };
  }
}

interface PrivateSpool {
  path: string;
  directory: string;
  checksumSha256: string;
  sizeBytes: number;
}

const PRIVATE_SPOOL_DIRECTORY_MODE = 0o700;
const PRIVATE_SPOOL_FILE_MODE = 0o600;
const PRIVATE_SPOOL_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const PRIVATE_SPOOL_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function ensurePrivateSpoolRoot(root: string): Promise<void> {
  if (!isAbsolute(root) || root.includes("\0")) throw storageError("storage_invalid_root");
  await mkdir(root, { recursive: true, mode: PRIVATE_SPOOL_DIRECTORY_MODE });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw storageError("storage_invalid_root");
  await chmod(root, PRIVATE_SPOOL_DIRECTORY_MODE);
}

async function spoolStream(stream: StorageByteStream, root: string): Promise<PrivateSpool> {
  await ensurePrivateSpoolRoot(root);
  const directory = await mkdtemp(join(root, ".rent-ops-upload-"));
  await chmod(directory, PRIVATE_SPOOL_DIRECTORY_MODE);
  const path = join(directory, "body");
  const handle = await open(path, PRIVATE_SPOOL_WRITE_FLAGS, PRIVATE_SPOOL_FILE_MODE);
  const hasher = createHash("sha256");
  let sizeBytes = 0;
  let completed = false;
  try {
    for await (const raw of stream) {
      if (!(raw instanceof Uint8Array) && typeof raw !== "string") throw storageError("storage_input_invalid");
      const chunk = Buffer.from(raw as Uint8Array | string);
      if (chunk.length === 0) continue;
      sizeBytes += chunk.length;
      if (sizeBytes > DEFAULT_MAX_BYTES) throw storageError("storage_too_large");
      hasher.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written);
        written += result.bytesWritten;
      }
    }
    if (sizeBytes < DEFAULT_MIN_BYTES) throw storageError("storage_empty");
    await handle.sync();
    completed = true;
    return { path, directory, checksumSha256: hasher.digest("hex"), sizeBytes };
  } finally {
    await handle.close().catch(() => undefined);
    if (!completed) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Streaming provider adapter used by production identities. It spools each
 * bounded body to a private O_NOFOLLOW file, hashes it once, and then streams
 * that descriptor to the provider. No 50 MiB request is retained as a Buffer;
 * the bounded admission wrapper controls how many private spools are active.
 */
export class SpoolingPrivateVersionedObjectStoreAdapter extends PrivateVersionedObjectStoreAdapter {
  private readonly spoolRoot: string;

  constructor(client: PrivateVersionedObjectStoreClient, options: { spoolRoot?: string } = {}) {
    super(client);
    this.spoolRoot = options.spoolRoot ?? join(tmpdir(), "rent-ops-upload-spool");
  }

  override async putIfAbsent(input: PutObjectInput): Promise<PutObjectResult> {
    const expected = expectedChecksum(input);
    const expectedBytes = expectedSize(input);
    const requestedInput = inputStream(input);
    const spool = await spoolStream(requestedInput, this.spoolRoot);
    try {
      if (expectedBytes !== undefined && expectedBytes !== spool.sizeBytes) throw storageError("storage_size_mismatch");
      if (expected !== undefined && expected !== spool.checksumSha256) throw storageError("storage_checksum_mismatch");
      const logicalKey = logicalKeyForChecksum(spool.checksumSha256);
      const requested = input.logicalKey === undefined ? undefined : normalizeLogicalKey(input.logicalKey);
      if (requested && requested !== logicalKey) throw storageError("storage_logical_key_invalid");
      const handle = await open(spool.path, PRIVATE_SPOOL_READ_FLAGS);
      try {
        const response = await this.client.putIfAbsent({
          logicalKey,
          body: handle.createReadStream({ autoClose: true }),
          checksumSha256: spool.checksumSha256,
          sizeBytes: spool.sizeBytes,
        });
        const responseVersion = exactVersion(response);
        if (!hasExactVersion(responseVersion)) throw storageError("storage_version_missing");
        const verified = await this.verify(logicalKey, {
          expectedChecksumSha256: spool.checksumSha256,
          expectedSizeBytes: spool.sizeBytes,
          sourceBinaryBinding: input.sourceBinaryBinding,
          importRunId: input.importRunId,
          immutableGeneration: responseVersion.immutableGeneration,
          immutableVersion: responseVersion.immutableVersion,
        });
        assertExactVersion(verified, responseVersion, true);
        return { ...verified, outcome: response.existed ? "already_present" : "stored", created: !response.existed };
      } finally {
        await handle.close().catch(() => undefined);
      }
    } finally {
      await rm(spool.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function validPrivatePrefix(prefix: string): boolean {
  if (typeof prefix !== "string" || prefix.length === 0 || prefix.includes("\0") || prefix.startsWith("/")) return false;
  const parts = prefix.split(/[\\/]+/);
  while (parts[parts.length - 1] === "") parts.pop();
  return parts.length > 0 && !parts.some((part) => part === ".." || part === "." || part === "");
}

function comparablePrivatePrefix(prefix: string): string {
  return prefix.replace(/[\\/]+$/, "");
}

function validateIdentityPrivileges(
  identity: PrivateObjectStorePrivilegeReport["runtime"],
  kind: "runtime" | "uploadWriter" | "importer",
): void {
  if (typeof identity.identity !== "string" || identity.identity.trim().length === 0 || !validPrivatePrefix(identity.prefix)) {
    throw storageError("storage_privilege_probe_failed");
  }
  const privileges = identity.privileges as Record<string, unknown>;
  if (privileges.get !== true) throw storageError("storage_privilege_probe_failed");
  // A probe must attest the denied capabilities explicitly. Unknown/missing
  // list or delete state is not sufficient for a private production identity.
  if (privileges.list !== false || privileges.delete !== false || privileges.write === true) {
    throw storageError("storage_privilege_probe_failed");
  }
  if (kind === "runtime" && (privileges.head !== true || privileges.put !== false)) throw storageError("storage_privilege_probe_failed");
  if ((kind === "uploadWriter" || kind === "importer") && (privileges.head !== true || privileges.put !== true)) throw storageError("storage_privilege_probe_failed");
}

export async function probePrivateObjectStorePrivileges(probe: PrivateObjectStorePrivilegeProbe): Promise<PrivateObjectStorePrivilegeReport> {
  try {
    const report = await probe.probe();
    if (!report.privateOnly || !report.versioningEnabled) throw storageError("storage_privilege_probe_failed");
    validateIdentityPrivileges(report.runtime, "runtime");
    if (probe.requireUploadWriter && !report.uploadWriter) throw storageError("storage_privilege_probe_failed");
    if (report.uploadWriter) validateIdentityPrivileges(report.uploadWriter, "uploadWriter");
    validateIdentityPrivileges(report.importer, "importer");
    const identities = [report.runtime, report.uploadWriter, report.importer].filter((value): value is NonNullable<typeof value> => Boolean(value));
    if (new Set(identities.map((identity) => identity.identity)).size !== identities.length
      || new Set(identities.map((identity) => comparablePrivatePrefix(identity.prefix))).size !== 1) {
      throw storageError("storage_privilege_probe_failed");
    }
    return {
      privateOnly: report.privateOnly,
      versioningEnabled: report.versioningEnabled,
      runtime: {
        identity: report.runtime.identity,
        prefix: report.runtime.prefix,
        privileges: Object.freeze({ ...report.runtime.privileges }),
      },
      ...(report.uploadWriter ? {
        uploadWriter: {
          identity: report.uploadWriter.identity,
          prefix: report.uploadWriter.prefix,
          privileges: Object.freeze({ ...report.uploadWriter.privileges }),
        },
      } : {}),
      importer: {
        identity: report.importer.identity,
        prefix: report.importer.prefix,
        privileges: Object.freeze({ ...report.importer.privileges }),
      },
    };
  } catch (error) {
    if (isStorageError(error)) throw error;
    throw storageError("storage_privilege_probe_failed");
  }
}

/** Read-only adapter deliberately has no put/list/delete members. */
export function createReadOnlyObjectStoreAdapter(store: StorageReadAdapter): StorageReadAdapter {
  return Object.freeze({
    backend: store.backend,
    stat: (logicalKey: LogicalObjectKey, options?: StorageVersionOptions) => store.stat(logicalKey, options),
    open: (logicalKey: LogicalObjectKey, options?: StorageVersionOptions) => store.open(logicalKey, options),
    verify: (logicalKey: LogicalObjectKey, options?: VerificationOptions) => store.verify(logicalKey, options),
    openVerified: (logicalKey: LogicalObjectKey, options?: VerificationOptions) => store.openVerified(logicalKey, options),
  });
}

/**
 * Reject saturated applicant uploads before the wrapped store can consume or
 * materialize their body. Queuing is intentionally not used: a caller gets a
 * retryable `storage_busy` response and no object or database binding exists.
 */
export class BoundedUploadObjectStore implements ContentAddressedObjectStore {
  readonly backend: StorageBackend;
  private active = 0;
  private readonly maxConcurrent: number;

  constructor(private readonly store: ContentAddressedObjectStore, maxConcurrent = 4) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 256) throw storageError("storage_size_invalid");
    this.backend = store.backend;
    this.maxConcurrent = maxConcurrent;
  }

  get activeUploads(): number { return this.active; }
  get uploadLimit(): number { return this.maxConcurrent; }

  async putIfAbsent(input: PutObjectInput): Promise<PutObjectResult> {
    if (this.active >= this.maxConcurrent) throw storageError("storage_busy", true);
    this.active += 1;
    try {
      return await this.store.putIfAbsent(input);
    } finally {
      this.active -= 1;
    }
  }

  stat(logicalKey: LogicalObjectKey, options?: StorageVersionOptions): Promise<ObjectStat | null> { return this.store.stat(logicalKey, options); }
  open(logicalKey: LogicalObjectKey, options?: StorageVersionOptions): Promise<Readable> { return this.store.open(logicalKey, options); }
  verify(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<StorageVerificationRecord> { return this.store.verify(logicalKey, options); }
  openVerified(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<VerifiedObjectOpen> { return this.store.openVerified(logicalKey, options); }
}

export interface ProductionObjectStoreClients {
  /** Runtime identity: Head/Get only; wrapped as a read-only adapter below. */
  runtime: PrivateVersionedObjectStoreClient;
  /** Applicant identity: Put/Head/Get; bounded before stream materialization. */
  applicantUpload: PrivateVersionedObjectStoreClient;
  /** Restricted importer identity: Put/Head/Get; never exposed to web routes. */
  importer: PrivateVersionedObjectStoreClient;
}

export interface ProductionObjectStoreFactoryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  clients: ProductionObjectStoreClients;
  privilegeProbe: PrivateObjectStorePrivilegeProbe;
  maxUploadConcurrency?: number;
  /** Dedicated private transient spool; defaults to an OS temp subdirectory. */
  spoolRoot?: string;
}

export interface ProductionObjectStores {
  documentStorage: StorageReadAdapter;
  documentUploadStorage: ContentAddressedObjectStore;
  importerStorage: ContentAddressedObjectStore;
  privilegeReport: PrivateObjectStorePrivilegeReport;
}

function productionStoreConfigValue(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : undefined;
}

/**
 * Construct the three production identities only after a private/encrypted/
 * versioned provider has attested every permitted and forbidden operation.
 * This factory is provider-neutral: a deployment adapter supplies clients and
 * a no-network privilege probe, while this boundary enforces the roles.
 */
export async function createProductionRentOpsObjectStores(options: ProductionObjectStoreFactoryOptions): Promise<ProductionObjectStores> {
  const env = options.env ?? process.env;
  if (productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_BACKEND") !== "private-versioned"
    || productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_ENCRYPTION") !== "required"
    || productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_VERSIONING") !== "required") {
    throw storageError("storage_privilege_probe_failed");
  }
  const expectedIdentities = {
    runtime: productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY"),
    uploadWriter: productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY"),
    importer: productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY"),
  };
  if (!expectedIdentities.runtime || !expectedIdentities.uploadWriter || !expectedIdentities.importer) throw storageError("storage_privilege_probe_failed");
  const report = await probePrivateObjectStorePrivileges({
    probe: () => options.privilegeProbe.probe(),
    requireUploadWriter: true,
  });
  if (report.runtime.identity !== expectedIdentities.runtime
    || report.uploadWriter?.identity !== expectedIdentities.uploadWriter
    || report.importer.identity !== expectedIdentities.importer) throw storageError("storage_privilege_probe_failed");
  const runtime = new SpoolingPrivateVersionedObjectStoreAdapter(options.clients.runtime, { spoolRoot: options.spoolRoot });
  const applicantUpload = new BoundedUploadObjectStore(
    new SpoolingPrivateVersionedObjectStoreAdapter(options.clients.applicantUpload, { spoolRoot: options.spoolRoot }),
    options.maxUploadConcurrency ?? 4,
  );
  const importer = new SpoolingPrivateVersionedObjectStoreAdapter(options.clients.importer, { spoolRoot: options.spoolRoot });
  return {
    documentStorage: createReadOnlyObjectStoreAdapter(runtime),
    documentUploadStorage: applicantUpload,
    importerStorage: importer,
    privilegeReport: report,
  };
}

export interface S3CompatibleTransport {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface S3CompatiblePrivateObjectStoreClientOptions {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  transport?: S3CompatibleTransport;
  now?: () => Date;
}

export interface S3CompatibleProductionObjectStoreOptions {
  env?: Readonly<Record<string, string | undefined>>;
  transport?: S3CompatibleTransport;
  maxUploadConcurrency?: number;
  spoolRoot?: string;
}

const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");
const S3_PROBE_MISSING_VERSION = "rent-ops-probe-missing-version";

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[\s]+/g, " ");
}

function hmacSha256(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Uint8Array | string, value: string): string {
  return hmacSha256(key, value).toString("hex");
}

function amzDateParts(now: Date): { short: string; full: string } {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw storageError("storage_io_failed");
  const full = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { short: full.slice(0, 8), full };
}

function canonicalPath(url: URL): string {
  return url.pathname.split("/").map((segment) => {
    try {
      return awsUriEncode(decodeURIComponent(segment));
    } catch {
      throw storageError("storage_logical_key_invalid");
    }
  }).join("/") || "/";
}

function canonicalQuery(url: URL): string {
  const values = Array.from(url.searchParams.entries()).map(([key, value]) => [awsUriEncode(key), awsUriEncode(value)] as const);
  values.sort((left, right) => left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0]));
  return values.map(([key, value]) => `${key}=${value}`).join("&");
}

function requiredS3Version(response: Response): string {
  const version = response.headers.get("x-amz-version-id")?.trim();
  if (!version || version === "null" || version.length > 256 || /[\0\r\n]/.test(version)) throw storageError("storage_version_missing");
  return version;
}

function assertS3ExpectedVersion(actual: string, expected: ReturnType<typeof exactVersion>): void {
  if (expected.immutableGeneration !== undefined) throw storageError("storage_version_mismatch");
  if (expected.immutableVersion !== undefined && actual !== expected.immutableVersion) throw storageError("storage_version_mismatch");
}

function safeS3Endpoint(value: string): URL {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("invalid");
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
    return endpoint;
  } catch {
    throw storageError("storage_privilege_probe_failed");
  }
}

function safeS3Segment(value: string, maxLength: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\0\r\n]/.test(value);
}

function safeS3Prefix(value: string): boolean {
  if (!safeS3Segment(value, 160) || value.startsWith("/") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return parts.length > 0 && !parts.some((part) => !part || part === "." || part === "..");
}

function responseBodyStream(response: Response): Readable {
  if (!response.body) throw storageError("storage_io_failed");
  try {
    return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  } catch {
    throw storageError("storage_io_failed");
  }
}

async function discardResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* provider error bodies are never surfaced */ }
}

function providerResponseError(response: Response, fallback: "storage_io_failed" | "storage_object_not_found" = "storage_io_failed"): never {
  void discardResponse(response);
  if (response.status === 403) throw storageError("storage_permission_denied");
  if (response.status === 404 && fallback === "storage_object_not_found") throw storageError("storage_object_not_found");
  throw storageError(fallback, response.status >= 500);
}

/**
 * Minimal SigV4 S3-compatible client. It uses only Node's built-in crypto and
 * fetch APIs so credentials stay in the server process and never enter logs.
 * The client is path-style and HTTPS-only; provider-specific aliases are not
 * silently accepted.
 */
export class S3CompatiblePrivateVersionedObjectStoreClient implements PrivateVersionedObjectStoreClient {
  readonly identity: string;
  readonly prefix: string;
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly transport: S3CompatibleTransport;
  private readonly now: () => Date;

  constructor(options: S3CompatiblePrivateObjectStoreClientOptions) {
    this.endpoint = safeS3Endpoint(options.endpoint);
    if (!safeS3Segment(options.region, 64) || !/^[A-Za-z0-9._-]+$/.test(options.region)) throw storageError("storage_privilege_probe_failed");
    if (!safeS3Segment(options.bucket, 160) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(options.bucket)) throw storageError("storage_privilege_probe_failed");
    if (!safeS3Prefix(options.prefix)) throw storageError("storage_privilege_probe_failed");
    if (!safeS3Segment(options.accessKeyId, 256) || !safeS3Segment(options.secretAccessKey, 512)) throw storageError("storage_privilege_probe_failed");
    this.region = options.region;
    this.bucket = options.bucket;
    this.prefix = options.prefix;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.identity = options.accessKeyId;
    this.transport = options.transport ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  private objectPath(logicalKey: LogicalObjectKey): string {
    const normalized = normalizeLogicalKey(logicalKey);
    const checksum = normalized.slice("sha256:".length);
    return `${this.prefix}/sha256/${checksum}`;
  }

  private urlFor(path: string, query?: Array<[string, string | undefined]>): URL {
    const url = new URL(this.endpoint.toString());
    const base = url.pathname.replace(/\/+$/, "");
    const encodedPath = path.split("/").map(awsUriEncode).join("/");
    url.pathname = `${base}/${awsUriEncode(this.bucket)}${encodedPath ? `/${encodedPath}` : ""}`;
    url.search = "";
    for (const [key, value] of query ?? []) if (value !== undefined) url.searchParams.append(key, value);
    return url;
  }

  private bucketUrl(query?: string): URL {
    const url = new URL(this.endpoint.toString());
    const base = url.pathname.replace(/\/+$/, "");
    url.pathname = `${base}/${awsUriEncode(this.bucket)}`;
    url.search = query ? `?${query}` : "";
    return url;
  }

  private async send(method: string, url: URL, headers: Record<string, string> = {}, body?: StorageByteStream): Promise<Response> {
    const { short, full } = amzDateParts(this.now());
    const payloadHash = headers["x-amz-content-sha256"] ?? EMPTY_PAYLOAD_SHA256;
    const signed: Record<string, string> = { ...headers, host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": full };
    const headerNames = Object.keys(signed).map((key) => key.toLowerCase()).sort();
    const canonicalHeaders = headerNames.map((key) => `${key}:${canonicalHeaderValue(signed[key] ?? "")}`).join("\n") + "\n";
    const signedHeaders = headerNames.join(";");
    const canonicalRequest = [method, canonicalPath(url), canonicalQuery(url), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${short}/${this.region}/s3/aws4_request`;
    const signingKey = hmacSha256(hmacSha256(hmacSha256(hmacSha256(`AWS4${this.secretAccessKey}`, short), this.region), "s3"), "aws4_request");
    const canonicalRequestHash = createHash("sha256").update(canonicalRequest).digest("hex");
    const signature = hmacHex(signingKey, `${full}\n${scope}\n${canonicalRequestHash}`);
    const wireHeaders = new Headers(headers);
    wireHeaders.set("host", url.host);
    wireHeaders.set("x-amz-content-sha256", payloadHash);
    wireHeaders.set("x-amz-date", full);
    wireHeaders.set("Authorization", `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
    const requestInit: RequestInit & { duplex?: "half" } = { method, headers: wireHeaders, redirect: "error" };
    if (body !== undefined) {
      const stream = body instanceof Readable ? body : Readable.from(body as AsyncIterable<Uint8Array>);
      requestInit.body = stream as unknown as BodyInit;
      requestInit.duplex = "half";
    }
    try {
      return await this.transport(url.toString(), requestInit);
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw storageError("storage_io_failed", true);
    }
  }

  private async objectRequest(method: string, logicalKey: LogicalObjectKey, options: ReturnType<typeof exactVersion> = {}, headers: Record<string, string> = {}, body?: StorageByteStream): Promise<{ response: Response; version?: string }> {
    if (options.immutableGeneration !== undefined) throw storageError("storage_version_mismatch");
    const url = this.urlFor(this.objectPath(logicalKey), [["versionId", options.immutableVersion]]);
    const response = await this.send(method, url, headers, body);
    if (response.status === 404) return { response };
    if (!response.ok) providerResponseError(response);
    const version = requiredS3Version(response);
    assertS3ExpectedVersion(version, options);
    return { response, version };
  }

  async putIfAbsent(input: { logicalKey: LogicalObjectKey; body: StorageByteStream; checksumSha256: Sha256Checksum; sizeBytes: number }): Promise<{ existed: boolean; immutableVersion: string }> {
    const checksum = assertSha256Checksum(input.checksumSha256);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > DEFAULT_MAX_BYTES) throw storageError("storage_size_invalid");
    const url = this.urlFor(this.objectPath(input.logicalKey));
    const response = await this.send("PUT", url, {
      "content-length": String(input.sizeBytes),
      "content-type": "application/octet-stream",
      "if-none-match": "*",
      "x-amz-content-sha256": checksum,
    }, input.body);
    if (response.status === 404) providerResponseError(response);
    if (response.status === 409 || response.status === 412) {
      await discardResponse(response);
      const existing = await this.stat(input.logicalKey);
      if (!existing?.immutableVersion) throw storageError("storage_collision");
      return { existed: true, immutableVersion: existing.immutableVersion };
    }
    if (!response.ok) providerResponseError(response);
    const version = requiredS3Version(response);
    await discardResponse(response);
    return { existed: false, immutableVersion: version };
  }

  async stat(logicalKey: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<ObjectStat | null> {
    const expected = exactVersion(options);
    const result = await this.objectRequest("HEAD", logicalKey, expected);
    if (result.response.status === 404) { await discardResponse(result.response); return null; }
    if (!result.version) throw storageError("storage_version_missing");
    const sizeHeader = result.response.headers.get("content-length");
    const sizeBytes = Number(sizeHeader);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > DEFAULT_MAX_BYTES) throw storageError("storage_size_invalid");
    await discardResponse(result.response);
    const normalized = normalizeLogicalKey(logicalKey);
    return { backend: "private-versioned-object-store", logicalKey: normalized, checksumSha256: checksumForLogicalKey(normalized), sizeBytes, immutableVersion: result.version };
  }

  async open(logicalKey: LogicalObjectKey, options: StorageVersionOptions = {}): Promise<Readable> {
    const expected = exactVersion(options);
    if (!hasExactVersion(expected)) throw storageError("storage_version_missing");
    const result = await this.objectRequest("GET", logicalKey, expected);
    if (result.response.status === 404) providerResponseError(result.response, "storage_object_not_found");
    if (!result.version) throw storageError("storage_version_missing");
    return responseBodyStream(result.response);
  }

  async verify(logicalKey: LogicalObjectKey, options: VerificationOptions = {}): Promise<StorageVerificationRecord> {
    const expected = exactVersion(options);
    if (!hasExactVersion(expected)) throw storageError("storage_version_missing");
    const result = await this.objectRequest("GET", logicalKey, expected);
    if (result.response.status === 404) providerResponseError(result.response, "storage_object_not_found");
    if (!result.version) throw storageError("storage_version_missing");
    const stream = responseBodyStream(result.response);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const raw of stream) {
        const chunk = Buffer.from(raw as Uint8Array);
        sizeBytes += chunk.length;
        if (sizeBytes > DEFAULT_MAX_BYTES) throw storageError("storage_too_large");
        hash.update(chunk);
      }
    } catch (error) {
      if (isStorageError(error)) throw error;
      throw storageError("storage_io_failed");
    }
    if (sizeBytes < DEFAULT_MIN_BYTES) throw storageError("storage_empty");
    const normalized = normalizeLogicalKey(logicalKey);
    const checksumSha256 = hash.digest("hex");
    if (checksumSha256 !== checksumForLogicalKey(normalized)) throw storageError("storage_integrity_mismatch");
    const expectedDigest = expectedChecksum(options);
    const expectedSizeBytes = expectedSize(options);
    if (expectedDigest !== undefined && expectedDigest !== checksumSha256) throw storageError("storage_checksum_mismatch");
    if (expectedSizeBytes !== undefined && expectedSizeBytes !== sizeBytes) throw storageError("storage_size_mismatch");
    return {
      backend: "private-versioned-object-store",
      logicalKey: normalized,
      checksumSha256,
      sizeBytes,
      immutableVersion: result.version,
      verificationState: "verified",
      verifiedAt: new Date().toISOString(),
      ...(options.sourceBinaryBinding ? { sourceBinaryBinding: options.sourceBinaryBinding } : {}),
      ...(options.importRunId ? { importRunId: options.importRunId } : {}),
    };
  }

  async openVerified(logicalKey: LogicalObjectKey, options: VerificationOptions = {}): Promise<VerifiedObjectOpen> {
    const verification = await this.verify(logicalKey, options);
    return { stream: await this.open(logicalKey, verification), verification };
  }

  async probeOperation(operation: "get" | "head" | "put" | "list" | "delete", logicalKey: LogicalObjectKey): Promise<number> {
    const path = this.objectPath(logicalKey);
    if (operation === "list") {
      const url = this.bucketUrl();
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", path);
      const response = await this.send("GET", url);
      await discardResponse(response);
      return response.status;
    }
    if (operation === "delete") {
      const url = this.urlFor(path, [["versionId", S3_PROBE_MISSING_VERSION]]);
      const response = await this.send("DELETE", url);
      await discardResponse(response);
      return response.status;
    }
    const headers: Record<string, string> = operation === "put"
      ? { "content-length": "0", "if-none-match": "*", "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256 }
      : {};
    const response = await this.send(operation === "put" ? "PUT" : operation === "get" ? "GET" : "HEAD", this.urlFor(path), headers, operation === "put" ? Readable.from([]) : undefined);
    await discardResponse(response);
    return response.status;
  }

  async probeVersioning(): Promise<boolean> {
    const response = await this.send("GET", this.bucketUrl("versioning"));
    if (!response.ok || !response.body) { await discardResponse(response); return false; }
    const text = await response.text().catch(() => "");
    return /<Status>\s*Enabled\s*<\/Status>/i.test(text);
  }

  async probePrivate(): Promise<boolean> {
    try {
      const response = await this.transport(this.urlFor(this.objectPath("sha256:" + "0".repeat(64))).toString(), { method: "HEAD", redirect: "error" });
      await discardResponse(response);
      return response.status === 403 || response.status === 404;
    } catch {
      return false;
    }
  }
}

function probedPermission(status: number, allowedStatuses: readonly number[]): boolean {
  if (status === 403) return false;
  if (allowedStatuses.includes(status)) return true;
  // An unsupported operation, transient failure, or malformed request is not
  // evidence that the provider denied a capability.
  throw storageError("storage_privilege_probe_failed");
}

function probeIdentity(client: S3CompatiblePrivateVersionedObjectStoreClient, identity: string): Promise<{
  identity: string;
  prefix: string;
  privileges: Readonly<Record<string, boolean>>;
}> {
  const canary = `sha256:${"0".repeat(64)}`;
  return Promise.all([
    client.probeOperation("get", canary),
    client.probeOperation("head", canary),
    client.probeOperation("put", canary),
    client.probeOperation("list", canary),
    client.probeOperation("delete", canary),
  ]).then(([get, head, put, list, deletion]) => ({
    identity,
    prefix: client.prefix,
    privileges: Object.freeze({
      get: probedPermission(get, [200]),
      head: probedPermission(head, [200]),
      put: probedPermission(put, [409, 412]),
      list: probedPermission(list, [200]),
      delete: probedPermission(deletion, [200, 204]),
    }),
  }));
}

export class S3CompatiblePrivateObjectStorePrivilegeProbe implements PrivateObjectStorePrivilegeProbe {
  readonly requireUploadWriter = true;

  constructor(
    private readonly runtime: S3CompatiblePrivateVersionedObjectStoreClient,
    private readonly uploadWriter: S3CompatiblePrivateVersionedObjectStoreClient,
    private readonly importer: S3CompatiblePrivateVersionedObjectStoreClient,
  ) {}

  async probe(): Promise<PrivateObjectStorePrivilegeReport> {
    const [privateOnly, versioningEnabled, runtime, uploadWriter, importer] = await Promise.all([
      this.runtime.probePrivate(),
      this.runtime.probeVersioning(),
      probeIdentity(this.runtime, this.runtime.identity),
      probeIdentity(this.uploadWriter, this.uploadWriter.identity),
      probeIdentity(this.importer, this.importer.identity),
    ]);
    return { privateOnly, versioningEnabled, runtime, uploadWriter, importer };
  }
}

function requiredS3Environment(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = productionStoreConfigValue(env, key);
  if (!value) throw storageError("storage_privilege_probe_failed");
  return value;
}

export function createS3CompatibleProductionObjectStoreFactory(options: S3CompatibleProductionObjectStoreOptions = {}): {
  clients: ProductionObjectStoreClients;
  privilegeProbe: PrivateObjectStorePrivilegeProbe;
} {
  const env = options.env ?? process.env;
  const common = {
    endpoint: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_ENDPOINT"),
    region: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_REGION"),
    bucket: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_BUCKET"),
    prefix: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_PREFIX"),
    transport: options.transport,
  };
  const runtime = new S3CompatiblePrivateVersionedObjectStoreClient({ ...common, accessKeyId: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY"), secretAccessKey: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN") });
  const uploadWriter = new S3CompatiblePrivateVersionedObjectStoreClient({ ...common, accessKeyId: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY"), secretAccessKey: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN") });
  const importer = new S3CompatiblePrivateVersionedObjectStoreClient({ ...common, accessKeyId: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_IMPORTER_IDENTITY"), secretAccessKey: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN") });
  return { clients: { runtime, applicantUpload: uploadWriter, importer }, privilegeProbe: new S3CompatiblePrivateObjectStorePrivilegeProbe(runtime, uploadWriter, importer) };
}

export async function createProductionRentOpsObjectStoresFromEnv(options: S3CompatibleProductionObjectStoreOptions = {}): Promise<ProductionObjectStores> {
  const env = options.env ?? process.env;
  const configured = createS3CompatibleProductionObjectStoreFactory(options);
  return createProductionRentOpsObjectStores({ env, ...configured, maxUploadConcurrency: options.maxUploadConcurrency, spoolRoot: options.spoolRoot });
}

/** Web processes never receive or construct the restricted importer identity. */
export type WebObjectStorePrivilegeReport = Pick<PrivateObjectStorePrivilegeReport, "privateOnly" | "versioningEnabled" | "runtime"> & {
  uploadWriter: NonNullable<PrivateObjectStorePrivilegeReport["uploadWriter"]>;
};
export interface WebObjectStoreFactoryOptions {
  env?: Readonly<Record<string, string | undefined>>;
  clients: Pick<ProductionObjectStoreClients, "runtime" | "applicantUpload">;
  privilegeProbe: { probe(): Promise<WebObjectStorePrivilegeReport> };
  maxUploadConcurrency?: number;
  spoolRoot?: string;
}
export async function createProductionRentOpsWebObjectStores(options: WebObjectStoreFactoryOptions) {
  const env = options.env ?? process.env;
  if (env.RENT_OPS_DATABASE_URL || env.RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN
    || productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_BACKEND") !== "private-versioned"
    || productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_ENCRYPTION") !== "required"
    || productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_VERSIONING") !== "required") throw storageError("storage_privilege_probe_failed");
  const report = await options.privilegeProbe.probe();
  if (!report.privateOnly || !report.versioningEnabled) throw storageError("storage_privilege_probe_failed");
  validateIdentityPrivileges(report.runtime, "runtime");
  validateIdentityPrivileges(report.uploadWriter, "uploadWriter");
  if (report.runtime.identity !== productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY")
    || report.uploadWriter.identity !== productionStoreConfigValue(env, "RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY")
    || report.runtime.identity === report.uploadWriter.identity
    || comparablePrivatePrefix(report.runtime.prefix) !== comparablePrivatePrefix(report.uploadWriter.prefix)) throw storageError("storage_privilege_probe_failed");
  return {
    documentStorage: createReadOnlyObjectStoreAdapter(new SpoolingPrivateVersionedObjectStoreAdapter(options.clients.runtime, { spoolRoot: options.spoolRoot })),
    documentUploadStorage: new BoundedUploadObjectStore(new SpoolingPrivateVersionedObjectStoreAdapter(options.clients.applicantUpload, { spoolRoot: options.spoolRoot }), options.maxUploadConcurrency ?? 4),
    privilegeReport: report,
  };
}

export async function createProductionRentOpsWebObjectStoresFromEnv(options: S3CompatibleProductionObjectStoreOptions = {}) {
  const env = options.env ?? process.env;
  // Fail before creating any client or performing a provider request.
  if (env.RENT_OPS_DATABASE_URL || env.RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN) throw storageError("storage_privilege_probe_failed");
  const common = {
    endpoint: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_ENDPOINT"),
    region: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_REGION"),
    bucket: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_BUCKET"),
    prefix: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_PREFIX"),
    transport: options.transport,
  };
  const runtime = new S3CompatiblePrivateVersionedObjectStoreClient({ ...common, accessKeyId: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_RUNTIME_IDENTITY"), secretAccessKey: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_RUNTIME_TOKEN") });
  const uploadWriter = new S3CompatiblePrivateVersionedObjectStoreClient({ ...common, accessKeyId: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_UPLOAD_IDENTITY"), secretAccessKey: requiredS3Environment(env, "RENT_OPS_OBJECT_STORE_UPLOAD_TOKEN") });
  return createProductionRentOpsWebObjectStores({
    env, clients: { runtime, applicantUpload: uploadWriter }, maxUploadConcurrency: options.maxUploadConcurrency, spoolRoot: options.spoolRoot,
    privilegeProbe: { async probe() {
      const [privateOnly, versioningEnabled, runtimeReport, uploadReport] = await Promise.all([
        runtime.probePrivate(), runtime.probeVersioning(), probeIdentity(runtime, runtime.identity), probeIdentity(uploadWriter, uploadWriter.identity),
      ]);
      return { privateOnly, versioningEnabled, runtime: runtimeReport, uploadWriter: uploadReport };
    } },
  });
}
