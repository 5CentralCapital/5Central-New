import type { Readable } from "node:stream";
import type { LogicalObjectKey, Sha256Checksum } from "./keys";

export type StorageBackend = "local-staging" | "private-versioned-object-store" | (string & {});

/** Exact object identity used to close a remote stat/verify/open replacement window. */
export interface StorageVersionOptions {
  immutableGeneration?: string;
  immutableVersion?: string;
  /** Explicit aliases accepted at adapter boundaries; never persisted. */
  expectedImmutableGeneration?: string;
  expectedImmutableVersion?: string;
  generation?: string;
  version?: string;
}

export type VerificationState = "verified" | "unverified" | "missing" | "mismatch" | "rejected";

/**
 * Metadata supplied by the import/persistence boundary. It is deliberately
 * optional and never participates in the opaque content-addressed key.
 * `sourceIdHash` is expected to be a one-way digest, not a raw RM identifier.
 */
export interface SourceBinaryBinding {
  bindingId?: string;
  sourceSystem?: string;
  sourceCollection?: string;
  sourceIdHash?: Sha256Checksum;
  importRunId?: string;
}

/** Local DTO; intentionally not imported by schema, routes, or repositories. */
export interface StorageVerificationRecord {
  backend: StorageBackend;
  logicalKey: LogicalObjectKey;
  checksumSha256: Sha256Checksum;
  sizeBytes: number;
  immutableGeneration?: string;
  immutableVersion?: string;
  verificationState: VerificationState;
  verifiedAt?: string;
  sourceBinaryBinding?: SourceBinaryBinding;
  /** Flat aliases make persistence mapping explicit without changing schema. */
  sourceBinaryBindingId?: string;
  importRunId?: string;
}

export interface ObjectStat {
  backend: StorageBackend;
  logicalKey: LogicalObjectKey;
  checksumSha256: Sha256Checksum;
  sizeBytes: number;
  immutableGeneration?: string;
  immutableVersion?: string;
}

/**
 * A verified read whose stream is backed by the same immutable object handle
 * used for verification. Local implementations must not reopen by pathname
 * after hashing; versioned remote implementations bind the stream to the
 * verified generation/version.
 */
export interface VerifiedObjectOpen {
  stream: Readable;
  verification: StorageVerificationRecord;
}

export type StorageByteStream = AsyncIterable<Uint8Array> | Readable;

export interface PutObjectInput {
  /** Exactly one of sourcePath, bytes, or stream must be supplied. */
  sourcePath?: string;
  bytes?: Uint8Array;
  stream?: StorageByteStream;
  /** Aliases are accepted for integration adapters; they are not persisted. */
  data?: Uint8Array;
  expectedChecksumSha256?: Sha256Checksum;
  checksumSha256?: Sha256Checksum;
  expectedSizeBytes?: number;
  sizeBytes?: number;
  logicalKey?: LogicalObjectKey;
  sourceRoot?: string;
  sourceBinaryBinding?: SourceBinaryBinding;
  importRunId?: string;
}

export interface PutObjectResult extends StorageVerificationRecord {
  outcome: "stored" | "already_present";
  created: boolean;
}

export interface VerificationOptions {
  expectedChecksumSha256?: Sha256Checksum;
  expectedSizeBytes?: number;
  sourceBinaryBinding?: SourceBinaryBinding;
  importRunId?: string;
  /** The exact immutable object identity expected by a follow-up read. */
  immutableGeneration?: string;
  immutableVersion?: string;
  expectedImmutableGeneration?: string;
  expectedImmutableVersion?: string;
  generation?: string;
  version?: string;
}

export interface StorageReadAdapter {
  readonly backend: StorageBackend;
  stat(logicalKey: LogicalObjectKey, options?: StorageVersionOptions): Promise<ObjectStat | null>;
  open(logicalKey: LogicalObjectKey, options?: StorageVersionOptions): Promise<Readable>;
  verify(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<StorageVerificationRecord>;
  openVerified(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<VerifiedObjectOpen>;
}

export interface ContentAddressedObjectStore extends StorageReadAdapter {
  putIfAbsent(input: PutObjectInput): Promise<PutObjectResult>;
}

export interface OrphanInventoryEntry extends ObjectStat {
  classification: "orphan";
  verificationState: VerificationState;
}

export type StaleTempClassification = "published_linked_temp" | "unpublished_temp" | "unverified_temp";

/**
 * A staging entry is identified by an opaque token rather than a local
 * filename. `sameObjectIdentity` is the descriptor-level proof used to mark
 * a crash-window temp safe to remove in a later, separately approved cleanup.
 */
export interface StaleTempInventoryEntry {
  backend: StorageBackend;
  tempToken: string;
  logicalKey?: LogicalObjectKey;
  checksumSha256?: Sha256Checksum;
  sizeBytes: number;
  classification: StaleTempClassification;
  verificationState: VerificationState;
  sameObjectIdentity: boolean;
  safeToRemove: boolean;
}

export interface OrphanInventory {
  backend: StorageBackend;
  generatedAt: string;
  referencedCount: number;
  objectCount: number;
  orphanCount: number;
  entries: readonly OrphanInventoryEntry[];
  staleTemps: readonly StaleTempInventoryEntry[];
  staleTempCount: number;
}

export interface CompensatingObjectCleanupAction {
  logicalKey: LogicalObjectKey;
  tempToken?: never;
  action: "manual_review" | "quarantine_then_review";
  reason: "unreferenced_object" | "verification_failed";
  requiresApproval: true;
  safeToRemove?: false;
}

export interface CompensatingTempCleanupAction {
  tempToken: string;
  logicalKey?: LogicalObjectKey;
  action: "remove_stale_temp" | "manual_review";
  reason: "published_temp" | "unpublished_temp" | "unverified_temp";
  requiresApproval: true;
  safeToRemove: boolean;
}

export type CompensatingCleanupAction = CompensatingObjectCleanupAction | CompensatingTempCleanupAction;

export interface CompensatingCleanupPlan {
  backend: StorageBackend;
  generatedAt: string;
  destructiveDeletionImplemented: false;
  actions: readonly CompensatingCleanupAction[];
}

export interface LocalStagingStoreApi extends ContentAddressedObjectStore {
  inventoryOrphans(referencedLogicalKeys: Iterable<LogicalObjectKey>): Promise<OrphanInventory>;
  planCompensatingCleanup(inventory: OrphanInventory): CompensatingCleanupPlan;
}

export interface ImporterPutFileOptions extends Omit<PutObjectInput, "sourcePath" | "bytes" | "data" | "stream" | "sourceRoot"> {
  /** A facade rejects this field unless it matches its configured root. */
  sourceRoot?: string;
}

/** RM import may write only a file proven to live under its configured root. */
export interface RentManagerImporterStorageFacade {
  putFile(sourcePath: string, options?: ImporterPutFileOptions): Promise<PutObjectResult>;
}

export interface LocalStagingStoreOptions {
  /** Existing, dedicated, absolute private directory. */
  root: string;
  /** Pass the repository/worktree root so accidental in-repo storage is rejected. */
  repositoryRoot?: string;
  /** Alias accepted for callers that call the repository a worktree. */
  worktreeRoot?: string;
  /** Optional root containing allowed source files. */
  sourceRoot?: string;
  maxBytes?: number;
  minBytes?: number;
  backend?: StorageBackend;
  now?: () => Date;
  logger?: SafeStorageLogger;
}

export interface SafeStorageLogger {
  info?(event: "storage_put" | "storage_stat" | "storage_open" | "storage_verify" | "storage_inventory", fields: { outcome?: string; code?: string; retryable?: boolean }): void;
  warn?(event: "storage_put" | "storage_stat" | "storage_open" | "storage_verify" | "storage_inventory", fields: { outcome?: string; code?: string; retryable?: boolean }): void;
}

export interface PrivateVersionedObjectStore extends ContentAddressedObjectStore {
  readonly backend: "private-versioned-object-store" | StorageBackend;
  /** Version/generation is immutable and returned by `stat`/`putIfAbsent`. */
}

/** Vendor-neutral contract for a future private object-store implementation. */
export interface PrivateVersionedObjectStoreClient {
  putIfAbsent(input: {
    logicalKey: LogicalObjectKey;
    body: StorageByteStream;
    checksumSha256: Sha256Checksum;
    sizeBytes: number;
  }): Promise<{ existed: boolean; immutableGeneration?: string; immutableVersion?: string }>;
  stat(logicalKey: LogicalObjectKey, options?: StorageVersionOptions): Promise<ObjectStat | null>;
  open(logicalKey: LogicalObjectKey, options?: StorageVersionOptions): Promise<Readable>;
  verify(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<StorageVerificationRecord>;
  /** Open the exact immutable generation/version that was verified. */
  openVerified(logicalKey: LogicalObjectKey, options?: VerificationOptions): Promise<VerifiedObjectOpen>;
}

export type ObjectStorePrivilege = "read" | "write" | "list" | "delete";

export type PrivateObjectStoreOperation = "get" | "head" | "put" | "write" | "list" | "delete";

export interface PrivateObjectStoreIdentityPrivileges {
  /** Distinct runtime and importer identities are required. */
  identity: string;
  /** All operations in this report must be scoped to this non-empty prefix. */
  prefix: string;
  privileges: Readonly<Partial<Record<PrivateObjectStoreOperation, boolean>>>;
}

export interface PrivateObjectStorePrivilegeReport {
  privateOnly: boolean;
  versioningEnabled: boolean;
  runtime: PrivateObjectStoreIdentityPrivileges;
  /** Optional dedicated web upload writer; never reuse the runtime identity. */
  uploadWriter?: PrivateObjectStoreIdentityPrivileges;
  importer: PrivateObjectStoreIdentityPrivileges;
}

/** A caller-supplied probe; no vendor SDK or network behavior is embedded. */
export interface PrivateObjectStorePrivilegeProbe {
  probe(): Promise<PrivateObjectStorePrivilegeReport>;
  /** Production startup sets this to require the dedicated upload identity. */
  requireUploadWriter?: boolean;
}
