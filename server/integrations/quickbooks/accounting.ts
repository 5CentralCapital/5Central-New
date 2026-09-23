import type {
  QuickBooksAccountingClientConfig,
  QuickBooksApiResponse,
  QuickBooksEntityName,
  QuickBooksEntityEnvelope,
  QuickBooksJsonObject,
  QuickBooksQueryResponse,
  QuickBooksTransport,
  QuickBooksTransportResponse,
  QuickBooksUpdateInput,
} from "../../../shared/accounting/quickbooks";
import { randomUUID } from "node:crypto";
import { QuickBooksIntegrationError, isQuickBooksIntegrationError } from "./errors";
import { parseJsonLosslessNumbers } from "./json-lossless";

export const QUICKBOOKS_SANDBOX_ACCOUNTING_BASE_URL = "https://sandbox-quickbooks.api.intuit.com";
export const QUICKBOOKS_PRODUCTION_ACCOUNTING_BASE_URL = "https://quickbooks.api.intuit.com";
/** Intuit retired minor versions below 75 on 2025-08-01; requests pin the supported baseline. */
export const DEFAULT_QUICKBOOKS_MINOR_VERSION = "75";
/** Intuit asks clients to back off 60 seconds after HTTP 429 when no Retry-After is supplied. */
export const QUICKBOOKS_RATE_LIMIT_BACKOFF_MS = 60_000;
/** Intuit's stale-object (SyncToken mismatch) fault code, returned with HTTP 400. */
export const QUICKBOOKS_STALE_OBJECT_FAULT_CODE = "5010";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

/** Intuit's change data capture returns at most 1,000 objects per response. */
export const QUICKBOOKS_CDC_MAX_OBJECTS = 1_000;
/** Intuit's change data capture looks back at most 30 days. */
export const QUICKBOOKS_CDC_LOOKBACK_DAYS = 30;
const CDC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Parsed `/cdc` response. Deleted objects appear inside an entity list with
 * `status: "Deleted"` and only Id/MetaData. `truncated` is true when the
 * response reached Intuit's object cap, so the window may be incomplete and
 * the caller must fall back to a full replay.
 */
export interface QuickBooksCdcResponse {
  readonly entities: Readonly<Record<string, readonly QuickBooksJsonObject[]>>;
  readonly objectCount: number;
  readonly truncated: boolean;
  readonly time?: string;
  readonly intuitTid?: string;
  readonly status: number;
}

/** Options for a provider write. `requestId` must be reused verbatim when retrying the same logical write. */
export interface QuickBooksWriteOptions {
  readonly requestId?: string;
}

/**
 * Per-transport, per-realm 429 cooldown. The transport is shared by every
 * client the root layer creates for this process, so a throttled realm stops
 * sending requests until Intuit's back-off window has elapsed.
 */
const rateLimitCooldowns = new WeakMap<QuickBooksTransport, Map<string, number>>();

function cooldownKey(scope: QuickBooksAccountingClientConfig["scope"]): string {
  return `${scope.environment}:${scope.realmId}`;
}

const BLOCKED_CAPABILITY_NAMES = new Set([
  "Project",
  "ProjectItem",
  "ProjectUser",
  "ProjectTask",
  "ProjectTaskType",
]);

function assertScope(scope: QuickBooksAccountingClientConfig["scope"]): void {
  const nonEmpty = [scope.organizationId, scope.legalEntityId, scope.realmId].every(
    value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value),
  );
  // Realm IDs are numeric identifiers. Requiring this also prevents a caller
  // from smuggling a path or another company's realm into the API URL.
  if (!nonEmpty || !/^\d{1,32}$/.test(scope.realmId)) {
    throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks connection scope is invalid");
  }
  if (scope.environment !== "sandbox" && scope.environment !== "production") {
    throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks environment is invalid");
  }
}

function assertEntity(entity: QuickBooksEntityName): void {
  if (typeof entity !== "string" || !/^[A-Z][A-Za-z0-9_]{0,79}$/.test(entity)) {
    throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks entity name is invalid");
  }
  if (BLOCKED_CAPABILITY_NAMES.has(entity)) {
    throw new QuickBooksIntegrationError("quickbooks_unsupported_capability", "QuickBooks Projects capability is disabled");
  }
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
    throw new QuickBooksIntegrationError("quickbooks_validation", `QuickBooks ${field} is invalid`);
  }
}

function header(response: QuickBooksTransportResponse, name: string): string | undefined {
  return response.headers
    ? Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.trim() || undefined
    : undefined;
}

function parseObject(body: string): QuickBooksJsonObject | undefined {
  try {
    const value: unknown = parseJsonLosslessNumbers(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value as QuickBooksJsonObject : undefined;
  } catch {
    return undefined;
  }
}

function safeString(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function retryAfterMs(response: QuickBooksTransportResponse): number | undefined {
  const value = header(response, "retry-after");
  let parsed: number | undefined;
  if (value && /^\d+(?:\.\d+)?$/.test(value)) parsed = Math.max(0, Number(value) * 1_000);
  else if (value && Number.isFinite(Date.parse(value))) parsed = Math.max(0, Date.parse(value) - Date.now());
  // A 429 without a usable Retry-After still requires Intuit's 60-second back-off.
  if (response.status === 429) return Math.max(parsed ?? 0, QUICKBOOKS_RATE_LIMIT_BACKOFF_MS);
  return parsed;
}

function providerFault(body: string): { isFault: boolean; code?: string } {
  const parsed = parseObject(body);
  const fault = parsed?.Fault;
  if (!fault || typeof fault !== "object" || Array.isArray(fault)) return { isFault: false };
  const errors = (fault as Record<string, unknown>).Error;
  const first = Array.isArray(errors) && errors[0] && typeof errors[0] === "object" ? errors[0] as Record<string, unknown> : undefined;
  const code = safeString(first?.code ?? first?.Code);
  return {
    isFault: true,
    ...(code ? { code } : {}),
  };
}

function responseError(response: QuickBooksTransportResponse, method: "GET" | "POST", requestId?: string): QuickBooksIntegrationError {
  const transient = response.status === 408 || response.status === 429 || response.status >= 500;
  const fault = providerFault(response.body);
  // Keep only the stable provider code. Free-form Message/Detail fields can
  // echo request values and must not cross this safe error boundary.
  const details = { providerCode: fault.code, ...(requestId ? { requestId } : {}) };
  if (method === "POST" && transient) {
    return new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks write outcome is unknown; reconcile before retrying", {
      status: response.status,
      ambiguous: true,
      retryable: false,
      intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid"),
      retryAfterMs: retryAfterMs(response),
      details,
    });
  }
  const code = response.status === 401
    ? "quickbooks_unauthorized"
    : response.status === 409 || fault.code === QUICKBOOKS_STALE_OBJECT_FAULT_CODE
      ? "quickbooks_conflict"
      : response.status === 429
        ? "quickbooks_rate_limited"
        : response.status >= 500
          ? "quickbooks_server"
          : "quickbooks_api";
  return new QuickBooksIntegrationError(code, "QuickBooks Accounting request failed", {
    status: response.status,
    retryable: method === "GET" && transient,
    intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid"),
    retryAfterMs: retryAfterMs(response),
    details,
  });
}

/** Converts a QBO Fault envelope into the same safe API error used for HTTP failures. */
export function quickBooksProviderFaultError(response: QuickBooksTransportResponse): QuickBooksIntegrationError | null {
  return providerFault(response.body).isFault ? responseError(response, "GET") : null;
}

function entityFromEnvelope<T extends QuickBooksJsonObject>(entity: string, body: string): { entity: T; raw: QuickBooksEntityEnvelope<T> } | undefined {
  const parsed = parseObject(body);
  const value = parsed?.[entity];
  if (!parsed || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { entity: value as T, raw: parsed as QuickBooksEntityEnvelope<T> };
}

function queryFromEnvelope<T extends QuickBooksJsonObject>(body: string): QuickBooksQueryResponse<T> | undefined {
  const parsed = parseObject(body);
  const response = parsed?.QueryResponse;
  if (!parsed || !response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const query = response as Record<string, unknown>;
  const entities = Object.values(query).find(value => Array.isArray(value));
  if (entities !== undefined && (!Array.isArray(entities) || entities.some(item => !item || typeof item !== "object" || Array.isArray(item)))) return undefined;
  const startPosition = safeNumber(query.startPosition);
  const maxResults = safeNumber(query.maxResults);
  return {
    entities: (entities ?? []) as T[],
    ...(startPosition === undefined ? {} : { startPosition }),
    ...(maxResults === undefined ? {} : { maxResults }),
    raw: parsed,
    status: 200,
  };
}

function cdcFromEnvelope(body: string, requested: readonly string[]): Omit<QuickBooksCdcResponse, "status" | "intuitTid"> | undefined {
  const parsed = parseObject(body);
  const responses = parsed?.CDCResponse;
  if (!parsed || !Array.isArray(responses)) return undefined;
  const allowed = new Set(requested);
  const entities: Record<string, QuickBooksJsonObject[]> = Object.fromEntries(requested.map(name => [name, [] as QuickBooksJsonObject[]]));
  let objectCount = 0;
  for (const response of responses) {
    if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
    const queries = (response as Record<string, unknown>).QueryResponse;
    const list = Array.isArray(queries) ? queries : queries === undefined ? [] : [queries];
    for (const query of list) {
      if (!query || typeof query !== "object" || Array.isArray(query)) return undefined;
      for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        if (!allowed.has(key)) return undefined;
        if (value.some(item => !item || typeof item !== "object" || Array.isArray(item))) return undefined;
        entities[key]!.push(...value as QuickBooksJsonObject[]);
        objectCount += value.length;
      }
    }
  }
  const time = typeof parsed.time === "string" && Number.isFinite(Date.parse(parsed.time)) ? parsed.time : undefined;
  return { entities, objectCount, truncated: objectCount >= QUICKBOOKS_CDC_MAX_OBJECTS, ...(time ? { time } : {}) };
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  return undefined;
}

function assertPlainObject(value: unknown, field: string): asserts value is QuickBooksJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QuickBooksIntegrationError("quickbooks_validation", `QuickBooks ${field} must be a JSON object`);
  }
}

function wrapUnknownWriteError(error: unknown, requestId: string): QuickBooksIntegrationError {
  if (isQuickBooksIntegrationError(error) && !["quickbooks_timeout", "quickbooks_transport"].includes(error.code)) return error;
  // The request may have reached Intuit. The same requestid lets a reconciled
  // retry be de-duplicated by Intuit instead of creating a second object.
  return new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks write outcome is unknown; reconcile before retrying", {
    ambiguous: true,
    cause: error,
    details: { requestId },
  });
}

function writeRequestId(options: QuickBooksWriteOptions | undefined): string {
  if (options?.requestId === undefined) return randomUUID();
  if (typeof options.requestId !== "string" || !REQUEST_ID_PATTERN.test(options.requestId)) {
    throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks requestid is invalid");
  }
  return options.requestId;
}

export interface QuickBooksAccountingClient {
  read<T extends QuickBooksJsonObject = QuickBooksJsonObject>(entity: QuickBooksEntityName, id: string): Promise<QuickBooksApiResponse<T>>;
  query<T extends QuickBooksJsonObject = QuickBooksJsonObject>(query: string): Promise<QuickBooksQueryResponse<T>>;
  /** Every write carries a `requestid`; pass the same `requestId` when retrying the same logical write. */
  create<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(entity: QuickBooksEntityName, fields: TFields, options?: QuickBooksWriteOptions): Promise<QuickBooksApiResponse<TResult>>;
  update<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(input: QuickBooksUpdateInput<TFields>, options?: QuickBooksWriteOptions): Promise<QuickBooksApiResponse<TResult>>;
  /** Change data capture since `changedSince` (≤ 30 days ago), including deletions. */
  cdc(entities: readonly QuickBooksEntityName[], changedSince: string): Promise<QuickBooksCdcResponse>;
}

/** QBO REST resource paths are lowercase (`companyinfo`, `vendor`); entity names in bodies stay PascalCase. */
function entityPath(entity: string): string {
  return encodeURIComponent(entity.toLowerCase());
}

function baseUrl(environment: QuickBooksAccountingClientConfig["scope"]["environment"]): string {
  return environment === "sandbox" ? QUICKBOOKS_SANDBOX_ACCOUNTING_BASE_URL : QUICKBOOKS_PRODUCTION_ACCOUNTING_BASE_URL;
}

function apiPath(scope: QuickBooksAccountingClientConfig["scope"], path: string, minorVersion?: string, requestId?: string): string {
  const url = new URL(`/v3/company/${encodeURIComponent(scope.realmId)}/${path.replace(/^\//, "")}`, baseUrl(scope.environment));
  if (minorVersion !== undefined) {
    if (!/^\d{1,4}$/.test(minorVersion)) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks minor version is invalid");
    url.searchParams.set("minorversion", minorVersion);
  }
  if (requestId !== undefined) url.searchParams.set("requestid", requestId);
  return url.toString();
}

export function createQuickBooksAccountingClient(config: QuickBooksAccountingClientConfig): QuickBooksAccountingClient {
  assertScope(config.scope);
  if (typeof config.getAccessToken !== "function") throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks access-token provider is required");
  if (typeof config.transport !== "function") throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks Accounting transport is required");
  const minorVersion = config.minorVersion ?? DEFAULT_QUICKBOOKS_MINOR_VERSION;
  const cooldowns = rateLimitCooldowns.get(config.transport) ?? new Map<string, number>();
  rateLimitCooldowns.set(config.transport, cooldowns);
  const realmKey = cooldownKey(config.scope);

  function assertNotCoolingDown(): void {
    const until = cooldowns.get(realmKey);
    if (until === undefined) return;
    const remaining = until - Date.now();
    if (remaining <= 0) {
      cooldowns.delete(realmKey);
      return;
    }
    // Nothing was sent, so this is definitive for reads and writes alike.
    throw new QuickBooksIntegrationError("quickbooks_rate_limited", "QuickBooks rate limit back-off is in effect for this company", {
      status: 429,
      retryable: true,
      retryAfterMs: remaining,
    });
  }

  async function call(method: "GET" | "POST", path: string, body?: QuickBooksJsonObject, requestId?: string): Promise<QuickBooksTransportResponse> {
    assertNotCoolingDown();
    const accessToken = await config.getAccessToken();
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks access token is unavailable");
    }
    try {
      const response = await config.transport({
        method,
        url: apiPath(config.scope, path, minorVersion, requestId),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 429) cooldowns.set(realmKey, Date.now() + (retryAfterMs(response) ?? QUICKBOOKS_RATE_LIMIT_BACKOFF_MS));
      if (response.status < 200 || response.status >= 300) throw responseError(response, method, requestId);
      return response;
    } catch (error) {
      if (method === "POST") throw wrapUnknownWriteError(error, requestId ?? "");
      throw error;
    }
  }

  return {
    async read<T extends QuickBooksJsonObject = QuickBooksJsonObject>(entity: QuickBooksEntityName, id: string): Promise<QuickBooksApiResponse<T>> {
      assertEntity(entity);
      assertIdentifier(id, "entity ID");
      const response = await call("GET", `${entityPath(entity)}/${encodeURIComponent(id)}`);
      const fault = quickBooksProviderFaultError(response);
      if (fault) throw fault;
      const parsed = entityFromEnvelope<T>(entity, response.body);
      if (!parsed) throw new QuickBooksIntegrationError("quickbooks_api", "QuickBooks read response could not be confirmed", { status: response.status });
      return { ...parsed, status: response.status, intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") };
    },

    async query<T extends QuickBooksJsonObject = QuickBooksJsonObject>(query: string): Promise<QuickBooksQueryResponse<T>> {
      if (typeof query !== "string" || query.length === 0 || query.length > 8_000 || /[\u0000-\u001f\u007f]/.test(query)) {
        throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks query is invalid");
      }
      const response = await call("GET", `query?query=${encodeURIComponent(query)}`);
      const fault = quickBooksProviderFaultError(response);
      if (fault) throw fault;
      const parsed = queryFromEnvelope<T>(response.body);
      if (!parsed) throw new QuickBooksIntegrationError("quickbooks_api", "QuickBooks query response could not be confirmed", { status: response.status });
      return { ...parsed, status: response.status, intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") };
    },

    async cdc(entities: readonly QuickBooksEntityName[], changedSince: string): Promise<QuickBooksCdcResponse> {
      if (!Array.isArray(entities) || entities.length === 0 || entities.length > 30 || new Set(entities).size !== entities.length) {
        throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks change data capture entities are invalid");
      }
      for (const entity of entities) assertEntity(entity);
      if (typeof changedSince !== "string" || !CDC_TIMESTAMP.test(changedSince) || !Number.isFinite(Date.parse(changedSince))) {
        throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks change data capture timestamp is invalid");
      }
      const oldest = Date.now() - QUICKBOOKS_CDC_LOOKBACK_DAYS * 86_400_000;
      if (Date.parse(changedSince) < oldest) {
        throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks change data capture cannot look back more than 30 days");
      }
      const params = new URLSearchParams({ entities: entities.join(","), changedSince });
      const response = await call("GET", `cdc?${params.toString()}`);
      const fault = quickBooksProviderFaultError(response);
      if (fault) throw fault;
      const parsed = cdcFromEnvelope(response.body, entities);
      if (!parsed) throw new QuickBooksIntegrationError("quickbooks_api", "QuickBooks change data capture response could not be confirmed", { status: response.status });
      return { ...parsed, status: response.status, intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") };
    },

    async create<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(entity: QuickBooksEntityName, fields: TFields, options?: QuickBooksWriteOptions): Promise<QuickBooksApiResponse<TResult>> {
      assertEntity(entity);
      assertPlainObject(fields, "create fields");
      const requestId = writeRequestId(options);
      const response = await call("POST", entityPath(entity), fields, requestId);
      const parsed = entityFromEnvelope<TResult>(entity, response.body);
      if (!parsed) throw new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks create response could not be confirmed; reconcile before retrying", { ambiguous: true, status: response.status, details: { requestId } });
      return { ...parsed, status: response.status, intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") };
    },

    async update<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(input: QuickBooksUpdateInput<TFields>, options?: QuickBooksWriteOptions): Promise<QuickBooksApiResponse<TResult>> {
      assertEntity(input.entity);
      assertIdentifier(input.id, "entity ID");
      assertIdentifier(input.syncToken, "SyncToken");
      assertPlainObject(input.fields, "update fields");
      const requestId = writeRequestId(options);
      const payload = { ...input.fields, Id: input.id, SyncToken: input.syncToken };
      const response = await call("POST", entityPath(input.entity), payload, requestId);
      const parsed = entityFromEnvelope<TResult>(input.entity, response.body);
      if (!parsed) throw new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks update response could not be confirmed; reconcile before retrying", { ambiguous: true, status: response.status, details: { requestId } });
      return { ...parsed, status: response.status, intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") };
    },
  };
}
