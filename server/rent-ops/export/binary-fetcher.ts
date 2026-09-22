import type {
  CollectionDefinition,
  DocumentBinaryFetchInput,
  DocumentBinaryFetcher,
  DocumentBinaryHttpFetch,
  DocumentBinaryHttpResponse,
  RentManagerDocumentBinaryFetcherOptions,
  RentManagerRequest,
  RentManagerResponse,
  RentManagerTransport,
} from "./types";

const DEFAULT_FILE_READER_HOST = "rm12filereader.rentmanager.com";
const DEFAULT_DETAIL_INTERVAL_MS = 1_050;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_BACKOFF_MS = 5_000;

/** A sanitized failure which never includes the signed file URL or response body. */
export class DocumentBinaryFetchError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: string, options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(code);
    this.name = "DocumentBinaryFetchError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function callTransport(transport: RentManagerTransport, request: RentManagerRequest): Promise<RentManagerResponse> {
  return typeof transport === "function" ? transport(request) : transport.request(request);
}

function headerValue(headers: Headers | Record<string, string | number | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] === undefined ? undefined : String(entry[1]);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function retryAfterMs(response: RentManagerResponse): number | undefined {
  const raw = headerValue(response.headers, "retry-after");
  if (raw === undefined || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

function primitiveField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return undefined;
}

function detailSourceId(input: DocumentBinaryFetchInput): string {
  const record = input.record as Record<string, unknown>;
  const id = primitiveField(record, [
    ...input.definition.idFields ?? [],
    "SignableDocumentID",
    "DocumentID",
    "signableDocumentId",
    "documentId",
  ]);
  if (!id) throw new DocumentBinaryFetchError("binary_detail_source_id_missing");
  return id;
}

function detailPath(definition: CollectionDefinition, id: string): string {
  const collectionPath = definition.path ?? "/SignableDocuments";
  // This fetcher is intentionally limited to the verified detail resource. A
  // caller cannot turn a source field into an arbitrary path or endpoint.
  if (!/^\/[A-Za-z0-9._~-]+$/.test(collectionPath)) throw new DocumentBinaryFetchError("binary_detail_path_invalid");
  return `${collectionPath}/${encodeURIComponent(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function detailObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.CurrentFile) || isRecord(body.currentFile)) return body;
  for (const key of ["Data", "data", "Results", "results"]) {
    const value = body[key];
    if (Array.isArray(value) && value.length === 1 && isRecord(value[0])) {
      const row = value[0] as Record<string, unknown>;
      if (isRecord(row.CurrentFile) || isRecord(row.currentFile)) return row;
    }
  }
  return body;
}

function currentFile(body: unknown): Record<string, unknown> | undefined {
  const detail = detailObject(body);
  if (!detail) return undefined;
  const value = detail.CurrentFile ?? detail.currentFile;
  return isRecord(value) ? value : undefined;
}

function downloadUrl(file: Record<string, unknown>): string {
  const value = primitiveField(file, ["DownloadURL", "downloadUrl", "downloadURL"]);
  if (!value) throw new DocumentBinaryFetchError("binary_download_url_missing");
  return value;
}

function validateSignedDownloadUrl(candidate: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new DocumentBinaryFetchError("binary_download_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== DEFAULT_FILE_READER_HOST || parsed.port || parsed.username || parsed.password || parsed.hash) {
    throw new DocumentBinaryFetchError("binary_download_url_not_allowlisted");
  }
  const keys = Array.from(parsed.searchParams.keys());
  const uniqueKeys = new Set(keys);
  if (keys.length !== 2 || uniqueKeys.size !== 2 || !uniqueKeys.has("EID") || !uniqueKeys.has("FKey")) {
    throw new DocumentBinaryFetchError("binary_download_url_query_invalid");
  }
  if (!parsed.searchParams.get("EID") || !parsed.searchParams.get("FKey")) throw new DocumentBinaryFetchError("binary_download_url_query_invalid");
  return parsed;
}

function signature(bytes: Uint8Array, expected: readonly number[]): boolean {
  return bytes.length >= expected.length && expected.every((value, index) => bytes[index] === value);
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.slice(0, 256)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<head") || prefix.startsWith("<body");
}

function validateFileBytes(bytes: Uint8Array, contentType: string | undefined): void {
  if (bytes.byteLength === 0) throw new DocumentBinaryFetchError("binary_empty");
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (type === "application/json" || type === "text/html" || looksLikeHtml(bytes)) throw new DocumentBinaryFetchError("binary_malformed");
  if (type === "application/pdf" && !signature(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new DocumentBinaryFetchError("binary_malformed");
  if ((type === "application/zip" || type?.includes("officedocument")) && !signature(bytes, [0x50, 0x4b, 0x03, 0x04])) throw new DocumentBinaryFetchError("binary_malformed");
  if (type === "image/png" && !signature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw new DocumentBinaryFetchError("binary_malformed");
  if (type === "image/jpeg" && !signature(bytes, [0xff, 0xd8, 0xff])) throw new DocumentBinaryFetchError("binary_malformed");
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, code: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = work(controller.signal);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DocumentBinaryFetchError(code, { retryable: true }));
      }, timeoutMs);
    });
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the verified follow-up fetcher for SignableDocuments. The detail
 * request is routed through the injected RM GET transport; the signed file
 * request deliberately has no RM auth headers and accepts only the exact
 * allowlisted reader host/query shape.
 */
export function createRentManagerDocumentBinaryFetcher(options: RentManagerDocumentBinaryFetcherOptions): DocumentBinaryFetcher {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as DocumentBinaryHttpFetch);
  const minIntervalMs = Math.max(DEFAULT_DETAIL_INTERVAL_MS, options.minDetailIntervalMs ?? DEFAULT_DETAIL_INTERVAL_MS);
  const maxPerMinute = Math.min(60, Math.max(1, Math.floor(options.maxDetailRequestsPerMinute ?? 60)));
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxRetries = Math.min(DEFAULT_MAX_RETRIES, Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES)));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => Date.now());
  let logicalNow = now();
  let lastDetailRequest = -Infinity;
  let detailRequestTimes: number[] = [];

  const paceDetailRequest = async (): Promise<void> => {
    logicalNow = Math.max(logicalNow, now());
    const intervalWait = Number.isFinite(lastDetailRequest) ? lastDetailRequest + minIntervalMs - logicalNow : 0;
    if (intervalWait > 0) {
      await sleep(intervalWait);
      logicalNow += intervalWait;
    }
    detailRequestTimes = detailRequestTimes.filter((time) => logicalNow - time < 60_000);
    if (detailRequestTimes.length >= maxPerMinute) {
      const rollingWait = detailRequestTimes[0] + 60_000 - logicalNow;
      if (rollingWait > 0) {
        await sleep(rollingWait);
        logicalNow += rollingWait;
      }
      detailRequestTimes = detailRequestTimes.filter((time) => logicalNow - time < 60_000);
    }
    lastDetailRequest = logicalNow;
    detailRequestTimes.push(logicalNow);
  };

  const detailRequest = async (input: DocumentBinaryFetchInput): Promise<RentManagerResponse> => {
    const id = detailSourceId(input);
    const request: RentManagerRequest = { method: "GET", path: detailPath(input.definition, id), query: { embeds: "CurrentFile" } };
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await paceDetailRequest();
      let response: RentManagerResponse;
      try {
        response = await withTimeout((signal) => callTransport(options.transport, { ...request, signal }), timeoutMs, "binary_detail_timeout");
      } catch (error) {
        if (error instanceof DocumentBinaryFetchError && error.retryable && attempt < maxRetries) {
          await sleep(Math.min(DEFAULT_MAX_BACKOFF_MS, error.retryAfterMs ?? 250 * 2 ** attempt));
          continue;
        }
        if (error instanceof DocumentBinaryFetchError) throw error;
        if (attempt < maxRetries) {
          await sleep(Math.min(DEFAULT_MAX_BACKOFF_MS, 250 * 2 ** attempt));
          continue;
        }
        throw new DocumentBinaryFetchError("binary_detail_request_failed");
      }
      if (response.status >= 200 && response.status < 300) return response;
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(Math.min(DEFAULT_MAX_BACKOFF_MS, retryAfterMs(response) ?? 250 * 2 ** attempt));
        continue;
      }
      throw new DocumentBinaryFetchError(response.status === 404 ? "binary_detail_not_found" : "binary_detail_http_error", { status: response.status, retryable: isRetryableStatus(response.status) });
    }
    throw new DocumentBinaryFetchError("binary_detail_request_failed");
  };

  const signedFileRequest = async (url: URL, contentTypeHint?: string): Promise<Uint8Array> => {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response: DocumentBinaryHttpResponse;
      try {
        response = await withTimeout((signal) => fetchImpl(url.toString(), { method: "GET", redirect: "error", signal }), timeoutMs, "binary_file_timeout");
      } catch (error) {
        if (error instanceof DocumentBinaryFetchError && error.retryable && attempt < maxRetries) {
          await sleep(Math.min(DEFAULT_MAX_BACKOFF_MS, error.retryAfterMs ?? 250 * 2 ** attempt));
          continue;
        }
        if (error instanceof DocumentBinaryFetchError) throw error;
        if (attempt < maxRetries) {
          await sleep(Math.min(DEFAULT_MAX_BACKOFF_MS, 250 * 2 ** attempt));
          continue;
        }
        throw new DocumentBinaryFetchError("binary_file_request_failed");
      }
      if (response.redirected) throw new DocumentBinaryFetchError("binary_redirect_rejected");
      if (response.url) validateSignedDownloadUrl(response.url);
      if (response.status < 200 || response.status >= 300) {
        if (isRetryableStatus(response.status) && attempt < maxRetries) {
          await sleep(Math.min(DEFAULT_MAX_BACKOFF_MS, 250 * 2 ** attempt));
          continue;
        }
        throw new DocumentBinaryFetchError("binary_file_http_error", { status: response.status, retryable: isRetryableStatus(response.status) });
      }
      const advertisedLength = positiveInteger(headerValue(response.headers, "content-length"));
      if (advertisedLength !== undefined && advertisedLength > maxBytes) throw new DocumentBinaryFetchError("binary_too_large");
      const bytes = new Uint8Array(await withTimeout(() => response.arrayBuffer(), timeoutMs, "binary_file_timeout"));
      if (bytes.byteLength > maxBytes) throw new DocumentBinaryFetchError("binary_too_large");
      validateFileBytes(bytes, headerValue(response.headers, "content-type") ?? contentTypeHint);
      return bytes;
    }
    throw new DocumentBinaryFetchError("binary_file_request_failed");
  };

  return async (input: DocumentBinaryFetchInput): Promise<Uint8Array | undefined> => {
    if (input.definition.documentMode !== "binary_descriptor") throw new DocumentBinaryFetchError("binary_definition_not_descriptor");
    const response = await detailRequest(input);
    const file = currentFile(response.body);
    if (!file) throw new DocumentBinaryFetchError("binary_current_file_missing");
    const signedUrl = validateSignedDownloadUrl(downloadUrl(file));
    const contentType = primitiveField(file, ["ContentType", "contentType", "MimeType", "mimeType"]);
    return signedFileRequest(signedUrl, contentType);
  };
}
