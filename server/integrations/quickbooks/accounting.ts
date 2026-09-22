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
import { QuickBooksIntegrationError, isQuickBooksIntegrationError } from "./errors";
import { parseJsonLosslessNumbers } from "./json-lossless";

export const QUICKBOOKS_SANDBOX_ACCOUNTING_BASE_URL = "https://sandbox-quickbooks.api.intuit.com";
export const QUICKBOOKS_PRODUCTION_ACCOUNTING_BASE_URL = "https://quickbooks.api.intuit.com";
/** Intuit retired minor versions below 75 on 2025-08-01; requests pin the supported baseline. */
export const DEFAULT_QUICKBOOKS_MINOR_VERSION = "75";

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
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
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

function responseError(response: QuickBooksTransportResponse, method: "GET" | "POST"): QuickBooksIntegrationError {
  const transient = response.status === 408 || response.status === 429 || response.status >= 500;
  const fault = providerFault(response.body);
  // Keep only the stable provider code. Free-form Message/Detail fields can
  // echo request values and must not cross this safe error boundary.
  const details = { providerCode: fault.code };
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
    : response.status === 409
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

function wrapUnknownWriteError(error: unknown): QuickBooksIntegrationError {
  if (isQuickBooksIntegrationError(error) && !["quickbooks_timeout", "quickbooks_transport"].includes(error.code)) return error;
  if (isQuickBooksIntegrationError(error) && error.code === "quickbooks_timeout") {
    return new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks write outcome is unknown; reconcile before retrying", {
      ambiguous: true,
      cause: error,
    });
  }
  return new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks write outcome is unknown; reconcile before retrying", {
    ambiguous: true,
    cause: error,
  });
}

export interface QuickBooksAccountingClient {
  read<T extends QuickBooksJsonObject = QuickBooksJsonObject>(entity: QuickBooksEntityName, id: string): Promise<QuickBooksApiResponse<T>>;
  query<T extends QuickBooksJsonObject = QuickBooksJsonObject>(query: string): Promise<QuickBooksQueryResponse<T>>;
  create<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(entity: QuickBooksEntityName, fields: TFields): Promise<QuickBooksApiResponse<TResult>>;
  update<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(input: QuickBooksUpdateInput<TFields>): Promise<QuickBooksApiResponse<TResult>>;
}

/** QBO REST resource paths are lowercase (`companyinfo`, `vendor`); entity names in bodies stay PascalCase. */
function entityPath(entity: string): string {
  return encodeURIComponent(entity.toLowerCase());
}

function baseUrl(environment: QuickBooksAccountingClientConfig["scope"]["environment"]): string {
  return environment === "sandbox" ? QUICKBOOKS_SANDBOX_ACCOUNTING_BASE_URL : QUICKBOOKS_PRODUCTION_ACCOUNTING_BASE_URL;
}

function apiPath(scope: QuickBooksAccountingClientConfig["scope"], path: string, minorVersion?: string): string {
  const url = new URL(`/v3/company/${encodeURIComponent(scope.realmId)}/${path.replace(/^\//, "")}`, baseUrl(scope.environment));
  if (minorVersion !== undefined) {
    if (!/^\d{1,4}$/.test(minorVersion)) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks minor version is invalid");
    url.searchParams.set("minorversion", minorVersion);
  }
  return url.toString();
}

export function createQuickBooksAccountingClient(config: QuickBooksAccountingClientConfig): QuickBooksAccountingClient {
  assertScope(config.scope);
  if (typeof config.getAccessToken !== "function") throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks access-token provider is required");
  if (typeof config.transport !== "function") throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks Accounting transport is required");
  const minorVersion = config.minorVersion ?? DEFAULT_QUICKBOOKS_MINOR_VERSION;

  async function call(method: "GET" | "POST", path: string, body?: QuickBooksJsonObject): Promise<QuickBooksTransportResponse> {
    const accessToken = await config.getAccessToken();
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks access token is unavailable");
    }
    try {
      const response = await config.transport({
        method,
        url: apiPath(config.scope, path, minorVersion),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status < 200 || response.status >= 300) throw responseError(response, method);
      return response;
    } catch (error) {
      if (method === "POST") throw wrapUnknownWriteError(error);
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

    async create<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(entity: QuickBooksEntityName, fields: TFields): Promise<QuickBooksApiResponse<TResult>> {
      assertEntity(entity);
      assertPlainObject(fields, "create fields");
      const response = await call("POST", entityPath(entity), fields);
      const parsed = entityFromEnvelope<TResult>(entity, response.body);
      if (!parsed) throw new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks create response could not be confirmed; reconcile before retrying", { ambiguous: true, status: response.status });
      return { ...parsed, status: response.status, intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") };
    },

    async update<TFields extends QuickBooksJsonObject = QuickBooksJsonObject, TResult extends QuickBooksJsonObject = QuickBooksJsonObject>(input: QuickBooksUpdateInput<TFields>): Promise<QuickBooksApiResponse<TResult>> {
      assertEntity(input.entity);
      assertIdentifier(input.id, "entity ID");
      assertIdentifier(input.syncToken, "SyncToken");
      assertPlainObject(input.fields, "update fields");
      const payload = { ...input.fields, Id: input.id, SyncToken: input.syncToken };
      const response = await call("POST", entityPath(input.entity), payload);
      const parsed = entityFromEnvelope<TResult>(input.entity, response.body);
      if (!parsed) throw new QuickBooksIntegrationError("quickbooks_ambiguous_write", "QuickBooks update response could not be confirmed; reconcile before retrying", { ambiguous: true, status: response.status });
      return { ...parsed, status: response.status, intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") };
    },
  };
}
