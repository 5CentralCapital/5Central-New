import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { createRestrictedArchive, createMemoryArchive, createFileCheckpointStore, UnsafeArchiveError } from "./archive";
import { canonicalJson, hashRecord, hashRegistry, sha256 } from "./hash";
import { RM_EXPORT_COLLECTIONS } from "./registry";
import { redactIdentifier, redactedManifest, safeTransportError } from "./redaction";
import { normalizeRmRecord } from "./normalize";
import type {
  CheckpointStore,
  CollectionCheckpoint,
  CollectionCoverage,
  CollectionDefinition,
  DocumentBinaryDescriptor,
  ExportArchive,
  ExportCheckpoint,
  ExportCollectorOptions,
  ExportEnvelope,
  ExportException,
  ExportPayload,
  ExportResult,
  DocumentBinaryFetcher,
  RentManagerRequest,
  RentManagerResponse,
  RentManagerTransport,
} from "./types";
import type { RentManagerRawRecord } from "../../../shared/rent-ops-contracts";

export const DEFAULT_RM_PAGE_SIZE = 1000;
export const DEFAULT_RM_MIN_REQUEST_INTERVAL_MS = 350;
export const DEFAULT_RM_MAX_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_RM_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RM_MAX_RETRIES = 2;
export const DEFAULT_RM_MAX_BACKOFF_MS = 5_000;
export const DEFAULT_RM_MAX_PAGES = 100_000;

export class ReadOnlyRequestError extends Error {
  readonly code = "read_only_violation";

  constructor(method: string) {
    super(`Rent Manager export only permits GET requests (received ${String(method).toUpperCase()})`);
    this.name = "ReadOnlyRequestError";
  }
}

/**
 * Raw RM exports are a restricted business archive, not a credential vault.
 * This error deliberately contains no field path or value so it is safe to
 * cross the CLI/log boundary unchanged.
 */
export class RestrictedCredentialFieldError extends Error {
  readonly code = "credential_field_rejected";

  constructor() {
    super("credential_field_rejected");
    this.name = "RestrictedCredentialFieldError";
  }
}

/** Stable, value-free failure for inline file material that cannot be copied losslessly. */
export class InvalidInlineDocumentBinaryError extends Error {
  readonly code = "document_binary_encoding_rejected";

  constructor() {
    super("document_binary_encoding_rejected");
    this.name = "InvalidInlineDocumentBinaryError";
  }
}

const CREDENTIAL_SCAN_MAX_DEPTH = 64;
const CREDENTIAL_SCAN_MAX_NODES = 100_000;

function normalizedCredentialKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function isCredentialShapedKey(key: string): boolean {
  const normalized = normalizedCredentialKey(key);
  return /(?:^|_)(?:database_url|connection_string|password|passwd|pwd|secret|access_token|refresh_token|session_token|resume_token|private_key|client_secret|api_key|authorization|bearer_token)(?:$|_)/i.test(normalized);
}

/**
 * Fail closed before an RM record is hashed, written to a page, copied to a
 * binary object, or included in an envelope. SSN, DOB, and ordinary security
 * deposit fields are restricted business data but are not credentials and are
 * intentionally retained in the private archive.
 */
export function assertNoCredentialShapedFields(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > CREDENTIAL_SCAN_MAX_NODES || depth > CREDENTIAL_SCAN_MAX_DEPTH) throw new RestrictedCredentialFieldError();
    if (!candidate || typeof candidate !== "object") return;
    if (candidate instanceof Date || candidate instanceof ArrayBuffer || ArrayBuffer.isView(candidate)) return;
    const object = candidate as object;
    if (ancestors.has(object)) throw new RestrictedCredentialFieldError();
    ancestors.add(object);
    try {
      if (Array.isArray(candidate)) {
        for (const child of candidate) visit(child, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(candidate)) {
        if (isCredentialShapedKey(key)) throw new RestrictedCredentialFieldError();
        visit(child, depth + 1);
      }
    } finally {
      ancestors.delete(object);
    }
  };
  visit(value, 0);
}

class TransportFailure extends Error {
  constructor(readonly code: string, readonly status?: number, readonly retryable = false, readonly retryAfterMs?: number) {
    super(code);
    this.name = "TransportFailure";
  }
}

export function assertReadOnlyRequest(request: RentManagerRequest): void {
  if (String(request.method).toUpperCase() !== "GET") throw new ReadOnlyRequestError(String(request.method));
  if (!request.path.startsWith("/") || request.path.includes("..") || request.path.includes("\0")) throw new ReadOnlyRequestError("unsafe-path");
}

export const enforceReadOnlyRequest = assertReadOnlyRequest;

function callTransport(transport: RentManagerTransport, request: RentManagerRequest): Promise<RentManagerResponse> {
  return typeof transport === "function" ? transport(request) : transport.request(request);
}

function header(headers: Record<string, string | number | undefined> | undefined, name: string): string | undefined {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return value === undefined ? undefined : String(value);
}

function decodeBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TransportFailure("invalid_json");
  }
}

function recordsFromBody(body: unknown, status?: number): RentManagerRawRecord[] {
  const decoded = decodeBody(body);
  if (status === 204 && decoded == null) return [];
  if (Array.isArray(decoded)) {
    if (decoded.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new TransportFailure("invalid_page");
    return decoded as RentManagerRawRecord[];
  }
  if (!decoded || typeof decoded !== "object") throw new TransportFailure("invalid_page");
  const object = decoded as Record<string, unknown>;
  for (const key of ["items", "data", "results", "records", "Items", "Data", "Results", "Records"]) {
    const value = object[key];
    if (Array.isArray(value)) {
      if (value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new TransportFailure("invalid_page");
      return value as RentManagerRawRecord[];
    }
  }
  throw new TransportFailure("invalid_page");
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function totalFromBody(body: unknown): number | undefined {
  const decoded = decodeBody(body);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
  const object = decoded as Record<string, unknown>;
  for (const key of ["total", "totalResults", "totalCount", "count", "Total", "TotalResults", "TotalCount", "Count"]) {
    const value = numberValue(object[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function sourceId(record: RentManagerRawRecord, definition?: CollectionDefinition): string | undefined {
  const object = record as Record<string, unknown>;
  // A normalized sourceId may be a documented composite identity (for
  // example history:<tenant>:<HistoryID>). Prefer it over the numeric RM
  // field so global exact-once checks do not collapse valid parent-scoped
  // rows.
  const keys = ["sourceId", ...(definition?.idFields ?? []), "id", "ID", "Id"];
  const value = keys.map((key) => object[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  const raw = typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
  if (!raw) return undefined;
  if (definition?.sourceIdNamespace && !raw.startsWith(`${definition.sourceIdNamespace}:`)) return `${definition.sourceIdNamespace}:${raw}`;
  return raw;
}

function packetDocumentDefinition(definition: CollectionDefinition): boolean {
  return definition.documentMode === "metadata"
    && (definition.name.toLowerCase().includes("packet") || String(definition.sourceIdNamespace ?? "").toLowerCase().includes("packet"));
}

function packetDocumentSourceId(sourceIdValue: string): boolean {
  return /^(?:document_packet|signable_document_packet):/i.test(sourceIdValue);
}

function normalizeRecord(record: RentManagerRawRecord, definition: CollectionDefinition, parentSourceId?: string, index?: number): RentManagerRawRecord {
  const object = record as Record<string, unknown>;
  const storedParent = typeof object.parentSourceId === "string" ? object.parentSourceId : undefined;
  return normalizeRmRecord(definition, record, { parentSourceId: parentSourceId ?? storedParent, index });
}

type InlineBinarySource = { field: string; encoding: "bytes" | "base64" };

function stripBinary(record: RentManagerRawRecord, sources: readonly InlineBinarySource[]): RentManagerRawRecord {
  const copy = structuredClone(record) as Record<string, unknown>;
  for (const source of sources) delete copy[source.field];
  return copy as RentManagerRawRecord;
}

function strictBase64Bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new InvalidInlineDocumentBinaryError();
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) throw new InvalidInlineDocumentBinaryError();
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function inlineBinary(record: RentManagerRawRecord): { bytes: Uint8Array; sources: InlineBinarySource[] } | undefined {
  const object = record as Record<string, unknown>;
  const candidates: Array<{ bytes: Uint8Array; source: InlineBinarySource }> = [];
  for (const key of ["binary", "bytes", "contentBytes", "fileBytes", "content"]) {
    if (!(key in object) || object[key] === undefined || object[key] === null) continue;
    const value = object[key];
    // Generic text/object `content` is metadata and must survive untouched.
    if (key === "content" && !(value instanceof Uint8Array) && !Buffer.isBuffer(value)) continue;
    if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) throw new InvalidInlineDocumentBinaryError();
    candidates.push({ bytes: new Uint8Array(value), source: { field: key, encoding: "bytes" } });
  }
  for (const key of ["contentBase64", "binaryBase64", "base64"]) {
    if (!(key in object) || object[key] === undefined || object[key] === null || object[key] === "") continue;
    candidates.push({ bytes: strictBase64Bytes(object[key]), source: { field: key, encoding: "base64" } });
  }
  if (candidates.length === 0) return undefined;
  const bytes = candidates[0].bytes;
  if (candidates.some((candidate) => !sameBytes(bytes, candidate.bytes))) throw new InvalidInlineDocumentBinaryError();
  return { bytes, sources: candidates.map((candidate) => candidate.source) };
}

function isFatalRecordBoundaryError(error: unknown): error is RestrictedCredentialFieldError | InvalidInlineDocumentBinaryError {
  return error instanceof RestrictedCredentialFieldError || error instanceof InvalidInlineDocumentBinaryError;
}

function checkpointState(pageSize: number): CollectionCheckpoint {
  return { nextPage: 1, nextParentIndex: 0, parentIds: [], pageSize, pages: 0, received: 0, hashes: [], pageFiles: [], status: "pending", errors: [], exceptions: [] };
}

function collectionKind(definition: CollectionDefinition): "collection" | "per_parent" | "known_unavailable" {
  return definition.kind ?? (definition.pathTemplate ? "per_parent" : definition.path ? "collection" : "known_unavailable");
}

function embeddedDefinition(definition: CollectionDefinition): CollectionDefinition {
  const isAllocation = definition.embeddedEntityType === "payment_allocation";
  const isPhone = definition.embeddedEntityType === "phone_number" || definition.embeddedEntityType === "phone";
  return {
    ...definition,
    name: `${definition.name}.${definition.embeddedField ?? "embedded"}`,
    path: undefined,
    pathTemplate: undefined,
    kind: "collection",
    outputKey: definition.embeddedOutputKey ?? definition.outputKey,
    idFields: isAllocation ? ["PaymentAllocationID", "AllocationID", "PaymentAllocationId"] : isPhone ? ["PhoneNumberID", "PhoneID"] : ["sourceId", "id", "ID"],
    entityType: definition.embeddedEntityType ?? "embedded",
    sourceIdNamespace: isAllocation ? "payment_allocation" : isPhone ? "phone_number" : `${definition.name}_embedded`,
    embeddedField: undefined,
    embeddedOutputKey: undefined,
    embeddedEntityType: isAllocation ? "payment_allocation" : isPhone ? "phone_number" : undefined,
  };
}

function coverageFor(definition: CollectionDefinition): CollectionCoverage {
  return {
    name: definition.name,
    path: definition.path ?? definition.pathTemplate ?? "UNSUPPORTED",
    outputKey: String(definition.outputKey),
    kind: collectionKind(definition),
    required: definition.required !== false,
    status: "failed",
    pages: 0,
    requested: 0,
    received: 0,
    recordHashes: [],
    errors: [],
    exceptions: [],
    ...(definition.unsupportedReason ? { unsupportedReason: definition.unsupportedReason } : {}),
    ...(definition.clientSideValidation ? { clientSideValidation: definition.clientSideValidation } : {}),
    ...(definition.documentMode ? { documentMode: definition.documentMode } : {}),
  };
}

function checkpointStoreFromArchive(archive: ExportArchive): CheckpointStore {
  return { load: () => archive.readCheckpoint(), save: (checkpoint) => archive.writeCheckpoint(checkpoint) };
}

export class RentManagerExportCollector {
  private readonly archive: ExportArchive;
  private readonly checkpointStore: CheckpointStore;
  private readonly registry: readonly CollectionDefinition[];
  private readonly pageSize: number;
  private readonly minInterval: number;
  private readonly maxPerMinute: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private readonly maxPages: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: NonNullable<ExportCollectorOptions["logger"]>;
  private readonly transport: RentManagerTransport;
  private readonly resume: boolean;
  private readonly requestedRunId?: string;
  private readonly binaryFetcher?: DocumentBinaryFetcher;
  private checkpoint!: ExportCheckpoint;
  private logicalNow = Date.now();
  private lastRequest = -Infinity;
  private requestTimes: number[] = [];
  private readonly coverage = new Map<string, CollectionCoverage>();
  private readonly definitions = new Map<string, CollectionDefinition>();
  private readonly documentBinaries = new Map<string, DocumentBinaryDescriptor>();

  constructor(options: Omit<ExportCollectorOptions, "archiveRoot" | "checkpointPath"> & { archive: ExportArchive }) {
    this.archive = options.archive;
    this.checkpointStore = options.checkpointStore ?? checkpointStoreFromArchive(options.archive);
    this.registry = options.registry ?? RM_EXPORT_COLLECTIONS;
    this.pageSize = Math.min(1000, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_RM_PAGE_SIZE)));
    this.minInterval = Math.max(DEFAULT_RM_MIN_REQUEST_INTERVAL_MS, options.minRequestIntervalMs ?? DEFAULT_RM_MIN_REQUEST_INTERVAL_MS);
    this.maxPerMinute = Math.min(DEFAULT_RM_MAX_REQUESTS_PER_MINUTE, Math.max(1, Math.floor(options.maxRequestsPerMinute ?? DEFAULT_RM_MAX_REQUESTS_PER_MINUTE)));
    this.timeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_RM_REQUEST_TIMEOUT_MS);
    this.maxRetries = Math.min(DEFAULT_RM_MAX_RETRIES, Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_RM_MAX_RETRIES)));
    this.maxBackoffMs = Math.min(DEFAULT_RM_MAX_BACKOFF_MS, Math.max(0, options.maxBackoffMs ?? DEFAULT_RM_MAX_BACKOFF_MS));
    this.maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_RM_MAX_PAGES));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.logger = options.logger ?? {};
    this.transport = options.transport;
    this.binaryFetcher = options.binaryFetcher;
    this.resume = options.resume !== false;
    this.requestedRunId = options.runId;
    for (const definition of this.registry) {
      this.definitions.set(definition.name, definition);
      this.coverage.set(definition.name, coverageFor(definition));
    }
  }

  private purgePacketDocumentDescriptors(): void {
    for (const sourceIdValue of Array.from(this.documentBinaries.keys())) {
      if (packetDocumentSourceId(sourceIdValue)) this.documentBinaries.delete(sourceIdValue);
    }
  }

  async collect(): Promise<ExportResult> {
    const registryHash = hashRegistry(this.registry);
    const previous = this.resume ? await this.checkpointStore.load() : null;
    this.checkpoint = previous ? this.resumeCheckpoint(previous, registryHash) : this.newCheckpoint(registryHash);
    if (this.checkpoint.documentBinaries) for (const descriptor of this.checkpoint.documentBinaries) this.documentBinaries.set(descriptor.sourceId, descriptor);
    // Older completed runs stored packet metadata in documentBinaries. Those
    // rows remain represented by their packet collections and must not enter
    // the file-descriptor gate or binary summary as file objects.
    this.purgePacketDocumentDescriptors();
    for (const definition of this.registry) {
      this.checkpoint.currentCollection = definition.name;
      const state = this.checkpoint.collections[definition.name] ?? checkpointState(this.pageSize);
      this.checkpoint.collections[definition.name] = state;
      if (state.status === "complete" || state.status === "not_available") continue;
      await this.collectCollection(definition, state);
    }
    this.checkpoint.currentCollection = undefined;
    this.checkpoint.updatedAt = this.now().toISOString();
    await this.checkpointStore.save(this.checkpoint);
    return this.finish();
  }

  private newCheckpoint(registryHash: string): ExportCheckpoint {
    const timestamp = this.now().toISOString();
    return {
      version: 2,
      runId: this.requestedRunId ?? randomUUID(),
      registryHash,
      startedAt: timestamp,
      updatedAt: timestamp,
      requestCount: 0,
      complete: false,
      collections: Object.fromEntries(this.registry.map((definition) => [definition.name, checkpointState(this.pageSize)])),
    };
  }

  private resumeCheckpoint(previous: ExportCheckpoint, registryHash: string): ExportCheckpoint {
    if (previous.version !== 2 || previous.registryHash !== registryHash) throw new Error("checkpoint version or registry hash does not match");
    if (this.requestedRunId && this.requestedRunId !== previous.runId) throw new Error("requested run ID does not match checkpoint");
    const checkpoint = structuredClone(previous);
    for (const definition of this.registry) {
      const state = checkpoint.collections[definition.name] ?? checkpointState(this.pageSize);
      state.nextParentIndex ??= 0;
      state.parentIds ??= [];
      state.exceptions ??= [];
      state.errors ??= [];
      state.hashes ??= [];
      state.pageFiles ??= [];
      checkpoint.collections[definition.name] = state;
    }
    return checkpoint;
  }

  private async throttle(): Promise<void> {
    this.logicalNow = Math.max(this.logicalNow, Date.now());
    const gap = Number.isFinite(this.lastRequest) ? this.lastRequest + this.minInterval - this.logicalNow : 0;
    if (gap > 0) {
      await this.sleep(gap);
      this.logicalNow += gap;
    }
    this.requestTimes = this.requestTimes.filter((time) => this.logicalNow - time < 60_000);
    if (this.requestTimes.length >= this.maxPerMinute) {
      const wait = this.requestTimes[0] + 60_000 - this.logicalNow;
      if (wait > 0) {
        await this.sleep(wait);
        this.logicalNow += wait;
      }
      this.requestTimes = this.requestTimes.filter((time) => this.logicalNow - time < 60_000);
    }
    this.lastRequest = this.logicalNow;
    this.requestTimes.push(this.logicalNow);
  }

  private async request(request: RentManagerRequest, definition: CollectionDefinition, page: number): Promise<RentManagerResponse> {
    assertReadOnlyRequest(request);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.throttle();
      this.checkpoint.requestCount += 1;
      this.logger.info?.("rm_export_request", { collection: definition.name, page, attempt: attempt + 1 });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = callTransport(this.transport, { ...request, signal: controller.signal });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new TransportFailure("request_timeout", undefined, true));
          }, this.timeoutMs);
        });
        const response = await Promise.race([pending, timeout]);
        if (!response || !Number.isInteger(response.status)) throw new TransportFailure("invalid_response");
        if (response.status < 200 || response.status >= 300) {
          const retryable = response.status === 429 || response.status >= 500;
          const retryAfter = numberValue(header(response.headers, "retry-after"));
          throw new TransportFailure(response.status === 404 ? "endpoint_not_available" : "http_error", response.status, retryable, retryAfter === undefined ? undefined : retryAfter * 1000);
        }
        this.logger.info?.("rm_export_response", { collection: definition.name, page, attempt: attempt + 1, status: response.status });
        return response;
      } catch (error) {
        if (!(error instanceof TransportFailure) || !error.retryable || attempt >= this.maxRetries) throw error;
        const wait = Math.min(this.maxBackoffMs, error.retryAfterMs ?? Math.min(this.maxBackoffMs, 250 * 2 ** attempt));
        this.logger.warn?.("rm_export_retry", { collection: definition.name, page, attempt: attempt + 1, delayMs: wait, status: error.status });
        if (wait > 0) await this.sleep(wait);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new TransportFailure("request_failed");
  }

  private addException(definition: CollectionDefinition, state: CollectionCheckpoint, exception: ExportException): void {
    state.exceptions.push(exception);
    this.coverage.get(definition.name)!.exceptions.push(exception);
  }

  private addError(definition: CollectionDefinition, state: CollectionCheckpoint, code: string): void {
    state.errors.push(code);
    this.coverage.get(definition.name)!.errors.push(code);
  }

  private clearResolvedCollectionErrors(state: CollectionCheckpoint): void {
    const retryableHistory = new Set(["request_failed", "request_timeout", "endpoint_not_available", "pagination_incomplete", "pagination_limit", "invalid_page"]);
    state.errors = state.errors.filter((code) => !retryableHistory.has(code));
    state.exceptions = state.exceptions.filter((exception) => !retryableHistory.has(exception.code));
  }

  private updateCheckpoint(): Promise<void> {
    this.checkpoint.updatedAt = this.now().toISOString();
    this.checkpoint.documentBinaries = Array.from(this.documentBinaries.values());
    return this.checkpointStore.save(this.checkpoint);
  }

  private async collectCollection(definition: CollectionDefinition, state: CollectionCheckpoint): Promise<void> {
    const coverage = this.coverage.get(definition.name)!;
    if (collectionKind(definition) === "known_unavailable") {
      state.status = "not_available";
      coverage.status = "not_available";
      this.addException(definition, state, { code: "known_unsupported_endpoint", collection: definition.name, detail: definition.unsupportedReason ?? "documented_endpoint_unavailable" });
      await this.updateCheckpoint();
      return;
    }
    if (definition.pathTemplate && definition.parentCollection) {
      await this.collectPerParent(definition, state);
      return;
    }
    if (!definition.path) {
      state.status = "not_available";
      coverage.status = "not_available";
      this.addException(definition, state, { code: "missing_endpoint", collection: definition.name, detail: "endpoint_not_registered" });
      await this.updateCheckpoint();
      return;
    }
    state.status = "running";
    coverage.status = "partial";
    let page = state.nextPage;
    let expected = state.sourceTotal;
    try {
      for (; page <= this.maxPages; page += 1) {
        const response = await this.request({ method: "GET", path: definition.path, query: { ...(definition.query ?? {}), pagenumber: page, pagesize: this.pageSize } }, definition, page);
        const body = decodeBody(response.body);
        const items = recordsFromBody(body, response.status);
        expected = numberValue(header(response.headers, "x-total-results")) ?? totalFromBody(body) ?? expected;
        if (expected !== undefined) state.sourceTotal = expected;
        coverage.expected = expected;
        const prepared: RentManagerRawRecord[] = [];
        for (let index = 0; index < items.length; index += 1) prepared.push(await this.prepareRecord(items[index], definition, state, undefined, index));
        coverage.pages += 1;
        state.pages += 1;
        coverage.requested += items.length;
        coverage.received += items.length;
        state.received += items.length;
        const pageFile = await this.archive.writePage(definition.name, page, prepared);
        state.pageFiles.push(pageFile);
        state.nextPage = page + 1;
        await this.updateCheckpoint();
        const reachedTotal = expected !== undefined && state.received >= expected;
        const exhausted = items.length === 0 || reachedTotal || (expected === undefined && items.length < this.pageSize);
        if (exhausted) {
          if (expected !== undefined && state.received < expected) {
            this.addError(definition, state, "pagination_incomplete");
            this.addException(definition, state, { code: "pagination_incomplete", collection: definition.name, detail: "source_total_exceeds_received" });
            state.status = "partial";
            coverage.status = "partial";
          } else {
            this.clearResolvedCollectionErrors(state);
            state.status = "complete";
            coverage.status = state.received === 0 ? "empty" : "complete";
          }
          await this.updateCheckpoint();
          return;
        }
      }
      this.addError(definition, state, "pagination_limit");
      this.addException(definition, state, { code: "pagination_incomplete", collection: definition.name, detail: "maximum_page_limit_reached" });
      state.status = "partial";
    } catch (error) {
      if (isFatalRecordBoundaryError(error)) throw error;
      const safe = safeTransportError(error);
      this.addError(definition, state, safe.code);
      this.addException(definition, state, { code: safe.code === "endpoint_not_available" ? "endpoint_not_available" : safe.code === "request_timeout" ? "request_timeout" : safe.code === "invalid_page" ? "invalid_page" : "request_failed", collection: definition.name, detail: safe.status ? `transport_status_${safe.status}` : safe.code });
      state.status = safe.code === "endpoint_not_available" ? "not_available" : "partial";
      coverage.status = state.status === "not_available" ? "not_available" : "failed";
      this.logger.warn?.("rm_export_collection_error", { collection: definition.name, page, code: safe.code, status: safe.status });
      await this.updateCheckpoint();
    }
  }

  private async prepareRecord(item: RentManagerRawRecord, definition: CollectionDefinition, state: CollectionCheckpoint, parentSourceId?: string, index?: number): Promise<RentManagerRawRecord> {
    assertNoCredentialShapedFields(item);
    const normalized = normalizeRecord(item, definition, parentSourceId, index);
    assertNoCredentialShapedFields(normalized);
    const id = sourceId(normalized, definition);
    const hash = hashRecord(normalized);
    state.hashes.push(hash);
    this.coverage.get(definition.name)!.recordHashes.push(hash);
    if (!id) this.addException(definition, state, { code: "missing_source_id", collection: definition.name, detail: "record_source_id_missing" });
    if (definition.partitionBy) {
      const partitionValue = (normalized as Record<string, unknown>)[definition.partitionBy];
      if (partitionValue !== undefined && partitionValue !== null) {
        const coverage = this.coverage.get(definition.name)!;
        coverage.partitionCounts ??= {};
        const key = String(partitionValue);
        coverage.partitionCounts[key] = (coverage.partitionCounts[key] ?? 0) + 1;
      }
    }
    let prepared = normalized;
    if (definition.documentMode) {
      // Packet rows are metadata containers. Only a collection explicitly
      // classified as a binary descriptor (currently SignableDocuments) is
      // a request for file bytes or a binary completeness gate. Never turn a
      // packet's metadata into a fabricated/missing file descriptor.
      const requiresBinary = definition.documentMode === "binary_descriptor";
      const inline = inlineBinary(normalized);
      if (!requiresBinary && inline) throw new InvalidInlineDocumentBinaryError();
      const metadataRecord = stripBinary(normalized, inline?.sources ?? []);
      let bytes = requiresBinary ? inline?.bytes : undefined;
      if (requiresBinary && !bytes && id && this.binaryFetcher) {
        try {
          bytes = await this.binaryFetcher({ sourceId: id, record: metadataRecord, definition });
          if (bytes !== undefined && !(bytes instanceof Uint8Array)) throw new Error("binary_fetcher_invalid_bytes");
        } catch {
          // A follow-up binary source is intentionally best-effort at the
          // collection boundary. The descriptor remains strict and the
          // redacted manifest records binary_unavailable; a malformed file or
          // signed URL must not discard the rest of the RM export.
          bytes = undefined;
        }
      }
      let binary: { sha256: string; relativePath: string } | undefined;
      if (requiresBinary && bytes) binary = await this.archive.writeBinary(`binaries/${sha256(bytes)}.bin`, bytes);
      prepared = metadataRecord;
      if (id && requiresBinary) {
        const object = prepared as Record<string, unknown>;
        const descriptor: DocumentBinaryDescriptor = {
          sourceId: id,
          metadataAvailable: true,
          binaryAvailable: Boolean(binary),
          descriptorOnly: !binary,
          ...(typeof object.ContentType === "string" ? { contentType: object.ContentType } : typeof object.contentType === "string" ? { contentType: object.contentType } : {}),
          ...(inline?.sources.length ? { inlineSources: inline.sources } : {}),
          ...(binary ? { sha256: binary.sha256, archivePath: binary.relativePath, sizeBytes: bytes!.byteLength, availabilityReason: "archived" as const } : { availabilityReason: "binary_not_returned" as const }),
        };
        this.documentBinaries.set(id, descriptor);
        if (!binary) this.addException(definition, state, { code: "binary_unavailable", collection: definition.name, sourceIdHash: redactIdentifier(id), detail: "binary_descriptor_without_archived_binary" });
      }
    }
    return prepared;
  }

  private async parentIds(definition: CollectionDefinition, state: CollectionCheckpoint): Promise<string[]> {
    if (state.parentIds.length > 0) return state.parentIds;
    const parentDefinition = this.definitions.get(definition.parentCollection!);
    const parentState = parentDefinition ? this.checkpoint.collections[parentDefinition.name] : undefined;
    if (!parentDefinition || !parentState?.pageFiles.length) return [];
    const ids = new Set<string>();
    for (const record of await this.archive.readPages(parentState.pageFiles)) {
      const id = sourceId(record, parentDefinition);
      if (id) ids.add(id);
    }
    state.parentIds = Array.from(ids).sort((left, right) => left.localeCompare(right));
    return state.parentIds;
  }

  private async collectPerParent(definition: CollectionDefinition, state: CollectionCheckpoint): Promise<void> {
    const coverage = this.coverage.get(definition.name)!;
    const parents = await this.parentIds(definition, state);
    coverage.parentCount = parents.length;
    if (parents.length === 0) {
      const parentState = definition.parentCollection ? this.checkpoint.collections[definition.parentCollection] : undefined;
      // An exhausted, empty parent partition is valid coverage (for example,
      // an account with no Future tenants). It is different from a parent
      // collection that failed before producing any page files.
      if (parentState?.status === "complete") {
        state.status = "complete";
        coverage.status = "empty";
        await this.updateCheckpoint();
        return;
      }
      state.status = "partial";
      coverage.status = "partial";
      this.addError(definition, state, "missing_relationship");
      this.addException(definition, state, { code: "missing_relationship", collection: definition.name, detail: "parent_records_unavailable" });
      await this.updateCheckpoint();
      return;
    }
    state.status = "running";
    try {
      for (let parentIndex = state.nextParentIndex; parentIndex < parents.length; parentIndex += 1) {
        const parentId = parents[parentIndex];
        const pageKey = sha256(parentId).slice(0, 16);
        let page = state.nextPage;
        let parentExpected: number | undefined;
        let parentReceived = 0;
        const previousParentFiles = state.pageFiles.filter((file) => file.includes(`-${pageKey}-`));
        if (previousParentFiles.length > 0) parentReceived = (await this.archive.readPages(previousParentFiles)).length;
        for (; page <= this.maxPages; page += 1) {
          const path = definition.pathTemplate!.replace("{sourceId}", encodeURIComponent(parentId));
          const response = await this.request({ method: "GET", path, query: { ...(definition.query ?? {}), pagenumber: page, pagesize: this.pageSize } }, definition, page);
          const body = decodeBody(response.body);
          const items = recordsFromBody(body, response.status);
          parentExpected = numberValue(header(response.headers, "x-total-results")) ?? totalFromBody(body) ?? parentExpected;
          const prepared: RentManagerRawRecord[] = [];
          for (let index = 0; index < items.length; index += 1) prepared.push(await this.prepareRecord(items[index], definition, state, parentId, index));
          coverage.pages += 1;
          state.pages += 1;
          coverage.requested += items.length;
          coverage.received += items.length;
          state.received += items.length;
          parentReceived += items.length;
          const pageFile = await this.archive.writePage(definition.name, page, prepared, pageKey);
          state.pageFiles.push(pageFile);
          state.nextPage = page + 1;
          state.nextParentIndex = parentIndex;
          await this.updateCheckpoint();
          const exhausted = items.length === 0 || (parentExpected !== undefined && parentReceived >= parentExpected) || (parentExpected === undefined && items.length < this.pageSize);
          if (exhausted) {
            if (parentExpected !== undefined && parentReceived < parentExpected) {
              this.addError(definition, state, "pagination_incomplete");
              this.addException(definition, state, { code: "pagination_incomplete", collection: definition.name, detail: "parent_source_total_exceeds_received" });
              state.status = "partial";
              coverage.status = "partial";
              await this.updateCheckpoint();
              return;
            }
            if (parentExpected !== undefined) coverage.expected = (coverage.expected ?? 0) + parentExpected;
            state.nextParentIndex = parentIndex + 1;
            state.nextPage = 1;
            await this.updateCheckpoint();
            break;
          }
        }
        if (page > this.maxPages) {
          this.addError(definition, state, "pagination_limit");
          this.addException(definition, state, { code: "pagination_incomplete", collection: definition.name, detail: "maximum_page_limit_reached" });
          state.status = "partial";
          coverage.status = "partial";
          await this.updateCheckpoint();
          return;
        }
      }
      state.status = "complete";
      this.clearResolvedCollectionErrors(state);
      coverage.status = state.received === 0 ? "empty" : "complete";
      await this.updateCheckpoint();
    } catch (error) {
      if (isFatalRecordBoundaryError(error)) throw error;
      const safe = safeTransportError(error);
      this.addError(definition, state, safe.code);
      this.addException(definition, state, { code: safe.code === "endpoint_not_available" ? "endpoint_not_available" : safe.code === "request_timeout" ? "request_timeout" : safe.code === "invalid_page" ? "invalid_page" : "request_failed", collection: definition.name, detail: safe.status ? `transport_status_${safe.status}` : safe.code });
      state.status = safe.code === "endpoint_not_available" ? "not_available" : "partial";
      coverage.status = state.status === "not_available" ? "not_available" : "failed";
      await this.updateCheckpoint();
    }
  }

  private finalCoverage(definition: CollectionDefinition): CollectionCoverage {
    const coverage = this.coverage.get(definition.name)!;
    const state = this.checkpoint.collections[definition.name];
    if (state) {
      coverage.pages = state.pages;
      coverage.received = state.received;
      coverage.requested = state.received;
      coverage.recordHashes = [...state.hashes];
      coverage.errors = Array.from(new Set([...state.errors, ...coverage.errors]));
      const allExceptions = [...state.exceptions, ...coverage.exceptions];
      coverage.exceptions = allExceptions.filter((item, index) => allExceptions.findIndex((other) => canonicalJson(other) === canonicalJson(item)) === index);
      if (state.sourceTotal !== undefined && coverage.expected === undefined) coverage.expected = state.sourceTotal;
      if (state.status === "complete" && coverage.status !== "not_available") coverage.status = state.received === 0 ? "empty" : "complete";
      if (state.status === "not_available") coverage.status = "not_available";
    }
    return coverage;
  }

  private async finish(): Promise<ExportResult> {
    const payload: ExportPayload = {};
    const payloadRecord = payload as Record<string, unknown>;
    const seen = new Map<string, Set<string>>();
    for (const definition of this.registry) {
      const state = this.checkpoint.collections[definition.name];
      if (!state?.pageFiles.length) continue;
      const rows = await this.archive.readPages(state.pageFiles);
      // A completed checkpoint can predate a source-identity rule added after
      // the original read. Re-run the same restricted normalization against
      // archived rows before deciding whether an old missing_source_id gate
      // is still real. We only clear identity gates when every archived row
      // now has a unique validated ID. Transport, pagination, and other
      // exceptions are never cleared here.
      const normalizedRows = rows.map((row) => {
        assertNoCredentialShapedFields(row);
        const normalized = normalizeRecord(row, definition);
        assertNoCredentialShapedFields(normalized);
        return normalized;
      });
      const idCounts = new Map<string, number>();
      let unresolvedIds = 0;
      for (const record of normalizedRows) {
        const id = sourceId(record, definition);
        if (!id) unresolvedIds += 1;
        else idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      }
      const output = (payloadRecord[String(definition.outputKey)] ?? []) as RentManagerRawRecord[];
      payloadRecord[String(definition.outputKey)] = output;
      const ids = seen.get(String(definition.outputKey)) ?? new Set<string>();
      seen.set(String(definition.outputKey), ids);
      const crossPartitionCollision = normalizedRows.some((record) => {
        const id = sourceId(record, definition);
        return Boolean(id && ids.has(id));
      });
      const allRowsHaveUniqueValidatedIds = normalizedRows.length > 0
        && unresolvedIds === 0
        && idCounts.size === normalizedRows.length
        && !crossPartitionCollision;
      const coverageEntry = this.coverage.get(definition.name);
      if (allRowsHaveUniqueValidatedIds) {
        // A legacy checkpoint may contain identity exceptions generated before
        // a deterministic source rule was added. Remove only those identity
        // gates after proving the complete archived collection is now unique;
        // transport, pagination, and other exceptions remain untouched.
        state.exceptions = state.exceptions.filter((exception) => exception.code !== "missing_source_id" && exception.code !== "duplicate_source_id");
        if (coverageEntry) coverageEntry.exceptions = coverageEntry.exceptions.filter((exception) => exception.code !== "missing_source_id" && exception.code !== "duplicate_source_id");
      }
      if (packetDocumentDefinition(definition)) {
        // Packet/signature-container metadata is retained in its source
        // collection, but it is not a file descriptor and never creates a
        // binary-unavailable gate.
        state.exceptions = state.exceptions.filter((exception) => exception.code !== "binary_unavailable");
        if (coverageEntry) coverageEntry.exceptions = coverageEntry.exceptions.filter((exception) => exception.code !== "binary_unavailable");
        for (const record of normalizedRows) {
          if (inlineBinary(record)) throw new InvalidInlineDocumentBinaryError();
          const id = sourceId(record, definition);
          if (id) this.documentBinaries.delete(id);
        }
      }
      if (definition.documentMode === "binary_descriptor") {
        // A completed checkpoint may contain metadata pages from before the
        // binary seam was configured. Revisit every descriptor during finish
        // so a resumed run can archive bytes without refetching RM pages.
        for (const record of normalizedRows) {
          const id = sourceId(record, definition);
          const existing = id ? this.documentBinaries.get(id) : undefined;
          if (!id || existing?.binaryAvailable) continue;
          const inline = inlineBinary(record);
          let bytes = inline?.bytes;
          if (!bytes && this.binaryFetcher) {
            try {
              bytes = await this.binaryFetcher({ sourceId: id, record: stripBinary(record, []), definition });
              if (bytes !== undefined && !(bytes instanceof Uint8Array)) throw new Error("binary_fetcher_invalid_bytes");
            } catch {
              bytes = undefined;
            }
          }
          if (bytes && bytes.byteLength > 0) {
            const binary = await this.archive.writeBinary(`binaries/${sha256(bytes)}.bin`, bytes);
            const object = record as Record<string, unknown>;
            this.documentBinaries.set(id, {
              sourceId: id,
              metadataAvailable: true,
              binaryAvailable: true,
              descriptorOnly: false,
              ...(typeof object.ContentType === "string" ? { contentType: object.ContentType } : typeof object.contentType === "string" ? { contentType: object.contentType } : {}),
              ...(inline?.sources.length ? { inlineSources: inline.sources } : {}),
              sha256: binary.sha256,
              archivePath: binary.relativePath,
              sizeBytes: bytes.byteLength,
              availabilityReason: "archived",
            });
          } else if (!state.exceptions.some((exception) => exception.code === "binary_unavailable" && exception.sourceIdHash === redactIdentifier(id))) {
            this.addException(definition, state, { code: "binary_unavailable", collection: definition.name, sourceIdHash: redactIdentifier(id), detail: "binary_descriptor_without_archived_binary" });
          }
        }
        // When a resumed binary follow-up has archived bytes, clear only the
        // matching stale exception. Missing/descriptor-only rows stay strict.
        const archivedIds = new Set<string>();
        for (const record of normalizedRows) {
          const id = sourceId(record, definition);
          if (id && this.documentBinaries.get(id)?.binaryAvailable) archivedIds.add(redactIdentifier(id));
        }
        if (archivedIds.size > 0) {
          state.exceptions = state.exceptions.filter((exception) => exception.code !== "binary_unavailable" || !exception.sourceIdHash || !archivedIds.has(exception.sourceIdHash));
          if (coverageEntry) coverageEntry.exceptions = coverageEntry.exceptions.filter((exception) => exception.code !== "binary_unavailable" || !exception.sourceIdHash || !archivedIds.has(exception.sourceIdHash));
        }
      }
      for (const record of normalizedRows) {
        const id = sourceId(record, definition);
        if (id && ids.has(id)) {
          this.addException(definition, state, { code: "duplicate_source_id", collection: definition.name, sourceIdHash: redactIdentifier(id), detail: "duplicate_source_id_across_partitions" });
          continue;
        }
        if (id) ids.add(id);
        output.push(record);
      }
      if (definition.embeddedField && definition.embeddedOutputKey) {
        const childDefinition = embeddedDefinition(definition);
        const embedded = (payloadRecord[String(definition.embeddedOutputKey)] ?? []) as RentManagerRawRecord[];
        for (const parent of output) {
          const parentId = sourceId(parent, definition);
          const children = (parent as Record<string, unknown>)[definition.embeddedField];
          if (!Array.isArray(children)) continue;
          for (let index = 0; index < children.length; index += 1) {
            const child = children[index];
            if (child && typeof child === "object" && !Array.isArray(child)) embedded.push(normalizeRecord(child as RentManagerRawRecord, childDefinition, parentId, index));
          }
        }
        payloadRecord[String(definition.embeddedOutputKey)] = embedded;
      }
    }
    // Keep source classes separate in the lossless envelope. The normalizer
    // performs the single, deterministic activity union; concatenating here
    // would duplicate history and communication facts on the second pass.
    this.purgePacketDocumentDescriptors();
    payload.documentBinaries = Array.from(this.documentBinaries.values()).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const envelope: ExportEnvelope = { version: "rm-export/v2", runId: this.checkpoint.runId, source: { system: "rent_manager", transport: "injected", readOnly: true }, createdAt: this.checkpoint.startedAt, payload, documentBinaries: payload.documentBinaries };
    const envelopeHash = await this.archive.writeEnvelope(envelope);
    const coverage = this.registry.map((definition) => this.finalCoverage(definition));
    const exceptions = coverage.flatMap((entry) => entry.exceptions);
    const errors = coverage.flatMap((entry) => entry.errors.map((code) => ({ collection: entry.name, code })));
    const complete = coverage.every((entry) => (entry.required ? entry.status === "complete" || entry.status === "empty" : entry.status === "complete" || entry.status === "empty" || entry.status === "not_available")) && coverage.filter((entry) => entry.required).every((entry) => entry.errors.length === 0 && entry.exceptions.length === 0);
    this.checkpoint.complete = complete;
    this.checkpoint.documentBinaries = payload.documentBinaries;
    await this.updateCheckpoint();
    const fileDescriptorCount = payload.documentBinaries.length;
    const packetMetadataCount = this.registry
      .filter((definition) => packetDocumentDefinition(definition))
      .reduce((total, definition) => total + (this.checkpoint.collections[definition.name]?.received ?? 0), 0);
    const binaryAvailableCount = payload.documentBinaries.filter((descriptor) => descriptor.binaryAvailable).length;
    const manifest = redactedManifest({ version: "rm-export-manifest/v2", runId: this.checkpoint.runId, source: "rent_manager", createdAt: envelope.createdAt, registryHash: this.checkpoint.registryHash, archiveEnvelopeSha256: envelopeHash, complete, rawArchive: { relativePath: "export-envelope.json", mode: "0600", directoryMode: "0700" }, counts: Object.fromEntries(Object.entries(payload).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length])), collections: coverage, errors, exceptions, documentBinarySummary: { metadataCount: fileDescriptorCount + packetMetadataCount, fileDescriptorCount, packetMetadataCount, binaryAvailableCount, descriptorOnlyCount: fileDescriptorCount - binaryAvailableCount } });
    await this.archive.writeManifest(manifest);
    await this.archive.writeCoverage(coverage);
    return { envelope, manifest, checkpoint: structuredClone(this.checkpoint), coverage, archive: this.archive.paths };
  }
}

export async function collectRentManagerExport(options: ExportCollectorOptions): Promise<ExportResult> {
  const archive = options.archive ?? (options.archiveRoot ? await createRestrictedArchive(options.archiveRoot) : createMemoryArchive());
  const checkpointStore = options.checkpointStore ?? (options.checkpointPath ? await createFileCheckpointStore(options.checkpointPath) : undefined);
  return new RentManagerExportCollector({ ...options, archive, ...(checkpointStore ? { checkpointStore } : {}) }).collect();
}

export { UnsafeArchiveError };
