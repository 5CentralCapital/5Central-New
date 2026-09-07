import type { IsoDate, RentManagerApplicationStatusCrosswalkEntry, RentManagerImportInput, RentManagerRawRecord } from "../../../shared/rent-ops-contracts";

/** A request understood by the injected RM adapter. It deliberately has no credentials. */
export interface RentManagerRequest {
  method: "GET" | string;
  path: string;
  query: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RentManagerResponse {
  status: number;
  headers?: Record<string, string | number | undefined>;
  /** The adapter may return decoded JSON or a JSON string. */
  body: unknown;
}

export type RentManagerTransport =
  | { request(request: RentManagerRequest): Promise<RentManagerResponse> }
  | ((request: RentManagerRequest) => Promise<RentManagerResponse>);

export interface ExportPayload extends RentManagerImportInput {
  /** Hash of the exact immutable export artifact used by an HAP crosswalk. */
  artifactSha256?: string;
  archiveEnvelopeSha256?: string;
  contacts?: RentManagerRawRecord[];
  phoneNumbers?: RentManagerRawRecord[];
  households?: RentManagerRawRecord[];
  leaseRenewals?: RentManagerRawRecord[];
  credits?: RentManagerRawRecord[];
  prospects?: RentManagerRawRecord[];
  applicationTemplates?: RentManagerRawRecord[];
  webUsers?: RentManagerRawRecord[];
  webUserAccounts?: RentManagerRawRecord[];
  histories?: RentManagerRawRecord[];
  communications?: RentManagerRawRecord[];
  /** Import-compatible aliases retained for callers that use the v1 keys. */
  notes?: RentManagerRawRecord[];
  activities?: RentManagerRawRecord[];
  hap?: RentManagerRawRecord[];
  documentBinaryDescriptors?: RentManagerRawRecord[];
  paymentTypes?: RentManagerRawRecord[];
  creditTypes?: RentManagerRawRecord[];
  /** Account-wide lookup resources that are not part of the import snapshot yet. */
  lookups?: RentManagerRawRecord[];
  unitTypeRecords?: RentManagerRawRecord[];
  leaseTermDefinitions?: RentManagerRawRecord[];
  chargeTypeRecords?: RentManagerRawRecord[];
  securityDepositTypeRecords?: RentManagerRawRecord[];
  /**
   * Verified application answer rows supplied by an approved source
   * collection or a restricted manual supplement. The exporter never
   * discovers or invents an answer endpoint; callers must inject these rows
   * explicitly when they have independently verified them.
   */
  applicationAnswerRecords?: RentManagerRawRecord[];
  /**
   * Exact, externally approved historical-application status mapping.  It is
   * accepted only from a derivative archive whose independent supplement
   * receipt is verified at import; row prose and substrings are never used.
   */
  applicationHistoryStatusCrosswalk?: RentManagerApplicationStatusCrosswalkEntry[];
  /** Application structure/link resources retained for verified later joins. */
  interestedRentals?: RentManagerRawRecord[];
  applicationSettings?: RentManagerRawRecord[];
  /** Binary bytes never belong in the JSON payload; this is a descriptor list only. */
  documentBinaries?: DocumentBinaryDescriptor[];
}

export interface DocumentBinaryDescriptor {
  sourceId: string;
  metadataAvailable: boolean;
  binaryAvailable: boolean;
  descriptorOnly: boolean;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
  archivePath?: string;
  /** Restricted-only reconstruction metadata for inline bytes removed from JSON. */
  inlineSources?: Array<{ field: string; encoding: "bytes" | "base64" }>;
  availabilityReason?: "binary_not_exposed" | "binary_not_returned" | "archived";
}

export type CollectionKind = "collection" | "per_parent" | "known_unavailable";

export interface CollectionDefinition {
  /** Stable, redacted collection name used by checkpoint and manifest. */
  name: string;
  /** Actual RM v3 resource path, including casing. */
  path?: string;
  /** A template for a documented RM subresource. `{sourceId}` is URL encoded. */
  pathTemplate?: string;
  query?: Record<string, string | number | boolean>;
  /** Import-compatible destination key. Several partitions can share one key. */
  outputKey: keyof ExportPayload;
  /** collection or one documented subresource call per parent record. */
  kind?: CollectionKind;
  /** Parent collection name for a pathTemplate. */
  parentCollection?: string;
  /** Source field used to identify parent records. */
  parentIdField?: string;
  /** RM's entity-specific stable identifier fields, in preference order. */
  idFields?: string[];
  /** Canonical import entity label added alongside the untouched RM fields. */
  entityType?: string;
  /** Prefix used where independent RM resources reuse numeric IDs. */
  sourceIdNamespace?: string;
  /** A status/type field used only for redacted partition counts. */
  partitionBy?: string;
  /** A source query is known to be unreliable and must be validated client-side. */
  clientSideValidation?: string;
  required?: boolean;
  /** Metadata-only endpoints are never treated as binary downloads. */
  documentMode?: "metadata" | "binary_descriptor";
  /** Embedded child field (Payments -> Allocations). */
  embeddedField?: string;
  embeddedOutputKey?: keyof ExportPayload;
  /** Entity label used for records extracted from an embedded RM field. */
  embeddedEntityType?: string;
  /** Known documented resource exception; no request is made. */
  unsupportedReason?: string;
}

export interface CollectionCheckpoint {
  nextPage: number;
  nextParentIndex: number;
  parentIds: string[];
  pageSize: number;
  pages: number;
  received: number;
  hashes: string[];
  pageFiles: string[];
  status: "pending" | "running" | "complete" | "partial" | "failed" | "not_available";
  sourceTotal?: number;
  errors: string[];
  exceptions: ExportException[];
}

export interface ExportCheckpoint {
  version: 2;
  runId: string;
  registryHash: string;
  startedAt: string;
  updatedAt: string;
  currentCollection?: string;
  requestCount: number;
  complete: boolean;
  documentBinaries?: DocumentBinaryDescriptor[];
  collections: Record<string, CollectionCheckpoint>;
}

export interface CollectionCoverage {
  name: string;
  path: string;
  outputKey: string;
  kind: CollectionKind;
  required: boolean;
  status: "complete" | "partial" | "failed" | "not_available" | "empty";
  pages: number;
  requested: number;
  received: number;
  expected?: number;
  recordHashes: string[];
  errors: string[];
  exceptions: ExportException[];
  parentCount?: number;
  partitionCounts?: Record<string, number>;
  clientSideValidation?: string;
  documentMode?: "metadata" | "binary_descriptor";
  unsupportedReason?: string;
}

export type ExportExceptionCode =
  | "missing_endpoint"
  | "endpoint_not_available"
  | "known_unsupported_endpoint"
  | "request_failed"
  | "request_timeout"
  | "pagination_incomplete"
  | "missing_source_id"
  | "duplicate_source_id"
  /** A stable ID was derived from explicit source fields; never from row order. */
  | "derived_identity"
  | "missing_relationship"
  | "binary_unavailable"
  | "unsafe_archive"
  | "incomplete_coverage"
  /** RM explicitly returned an empty optional source structure. */
  | "source_empty"
  | "invalid_page";

export interface ExportException {
  code: ExportExceptionCode;
  collection: string;
  /** A one-way identifier only; no source name or raw ID is emitted. */
  sourceIdHash?: string;
  detail: string;
}

export interface ExportError {
  collection?: string;
  code: string;
  status?: number;
  retryable?: boolean;
}

export interface RedactedExportManifest {
  version: "rm-export-manifest/v2";
  runId: string;
  source: "rent_manager";
  createdAt: string;
  /** Explicit source observation/configuration boundary approved for v8. */
  artifactObservationOn?: IsoDate;
  registryHash: string;
  archiveEnvelopeSha256?: string;
  complete: boolean;
  rawArchive: {
    relativePath: string;
    mode: "0600";
    directoryMode: "0700";
  };
  counts: Record<string, number>;
  collections: CollectionCoverage[];
  errors: ExportError[];
  exceptions: ExportException[];
  documentBinarySummary: {
    metadataCount: number;
    binaryAvailableCount: number;
    descriptorOnlyCount: number;
    /** Number of metadata-bearing RM document rows that expose file bytes. */
    fileDescriptorCount?: number;
    /** Packet/signature-container metadata rows; never a binary completeness gate. */
    packetMetadataCount?: number;
  };
}

export interface ExportEnvelope {
  version: "rm-export/v2";
  runId: string;
  source: { system: "rent_manager"; transport: "injected"; readOnly: true };
  createdAt: string;
  /** Explicit source observation/configuration boundary approved for v8. */
  artifactObservationOn?: IsoDate;
  payload: ExportPayload;
  documentBinaries: DocumentBinaryDescriptor[];
  /**
   * Restricted-supplement provenance is an envelope binding, not an
   * application-answer row claim.  It contains no source values or key
   * material and is only emitted by the verified supplement builder.
   */
  supplementEvidence?: {
    version: "rm-restricted-supplement/v1";
    sourceRunId: string;
    supplementSha256: string;
    attestationSha256: string;
    kinds: string[];
    /** SHA-256 values of the exact supplemented answer rows, not row values. */
    rowHashes: string[];
    rowSetSha256: string;
  };
}

export interface ExportArchivePaths {
  root: string;
  envelope: string;
  manifest: string;
  checkpoint: string;
  coverage: string;
  pages: string;
  binaries: string;
}

export interface ExportArchive {
  paths: ExportArchivePaths;
  writeEnvelope(envelope: ExportEnvelope): Promise<string>;
  writeManifest(manifest: RedactedExportManifest): Promise<void>;
  writeCoverage(coverage: CollectionCoverage[]): Promise<void>;
  writeCheckpoint(checkpoint: ExportCheckpoint): Promise<void>;
  readCheckpoint(): Promise<ExportCheckpoint | null>;
  writePage(collection: string, pageNumber: number, records: RentManagerRawRecord[], pageKey?: string): Promise<string>;
  readPages(pageFiles: string[]): Promise<RentManagerRawRecord[]>;
  writeBinary(relativePath: string, bytes: Uint8Array): Promise<{ sha256: string; relativePath: string }>;
}

export interface ExportLogger {
  info?(event: string, fields: Record<string, string | number | boolean | undefined>): void;
  warn?(event: string, fields: Record<string, string | number | boolean | undefined>): void;
}

export interface ExportCollectorOptions {
  transport: RentManagerTransport;
  archive?: ExportArchive;
  archiveRoot?: string;
  checkpointStore?: CheckpointStore;
  checkpointPath?: string;
  runId?: string;
  pageSize?: number;
  minRequestIntervalMs?: number;
  maxRequestsPerMinute?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
  maxPages?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: ExportLogger;
  registry?: readonly CollectionDefinition[];
  /**
   * Optional follow-up seam for callers that can independently fetch bytes
   * for a verified document descriptor. The collector itself does not infer
   * an RM binary endpoint and does not perform this call unless injected.
   */
  binaryFetcher?: DocumentBinaryFetcher;
  resume?: boolean;
}

/**
 * A restricted file-reader response used by the production binary seam. The
 * collector never receives a URL or credentials; it receives only bytes.
 */
export interface DocumentBinaryHttpResponse {
  status: number;
  headers?: Headers;
  url?: string;
  redirected?: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type DocumentBinaryHttpFetch = (input: string, init?: RequestInit) => Promise<DocumentBinaryHttpResponse>;

export interface RentManagerDocumentBinaryFetcherOptions {
  /** The GET-only RM API transport used for the documented detail request. */
  transport: RentManagerTransport;
  /** Injected for deterministic tests; production defaults to global fetch. */
  fetchImpl?: DocumentBinaryHttpFetch;
  /** Minimum gap between RM detail requests, floored at 1050ms. */
  minDetailIntervalMs?: number;
  /** Rolling cap for RM detail requests, never above 60/minute. */
  maxDetailRequestsPerMinute?: number;
  /** Timeout for each detail/file attempt. */
  timeoutMs?: number;
  /** Retry count for 429/5xx, capped at two retries. */
  maxRetries?: number;
  /** Defensive file-size ceiling. */
  maxBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface DocumentBinaryFetchInput {
  sourceId: string;
  record: RentManagerRawRecord;
  definition: CollectionDefinition;
}

export type DocumentBinaryFetcher = (input: DocumentBinaryFetchInput) => Promise<Uint8Array | undefined>;

export interface CheckpointStore {
  load(): Promise<ExportCheckpoint | null>;
  save(checkpoint: ExportCheckpoint): Promise<void>;
}

export interface ExportResult {
  envelope: ExportEnvelope;
  manifest: RedactedExportManifest;
  checkpoint: ExportCheckpoint;
  coverage: CollectionCoverage[];
  /** The archive has redacted paths and no payload copies. */
  archive?: ExportArchivePaths;
}
