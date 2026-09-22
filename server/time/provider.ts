import { parseJsonLosslessNumbers } from "../integrations/quickbooks/json-lossless";
import { AccountingError } from "../accounting/errors";
import type { TimeConnectionScope, TimeEnvironment } from "../../shared/time";

export const QUICKBOOKS_TIME_BASE_URL = "https://rest.tsheets.com/api/v1";
export const QUICKBOOKS_TIME_AUTHORIZATION_URL = `${QUICKBOOKS_TIME_BASE_URL}/authorize`;
export const QUICKBOOKS_TIME_GRANT_URL = `${QUICKBOOKS_TIME_BASE_URL}/grant`;

export interface TimeTransportRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}
export interface TimeTransportResponse { readonly status: number; readonly headers?: Readonly<Record<string, string | undefined>>; readonly body: string; }
export type TimeTransport = (request: TimeTransportRequest) => Promise<TimeTransportResponse>;

function header(response: TimeTransportResponse, name: string): string | undefined {
  return response.headers ? Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.trim() || undefined : undefined;
}

function assertTimeUrl(urlText: string): void {
  let url: URL;
  try { url = new URL(urlText); } catch { throw new AccountingError("accounting_configuration", "QuickBooks Time endpoint URL is invalid"); }
  if (url.protocol !== "https:" || url.origin !== new URL(QUICKBOOKS_TIME_BASE_URL).origin || url.username || url.password || url.hash) {
    throw new AccountingError("accounting_configuration", "QuickBooks Time endpoint URL is not allowed");
  }
}

export function createQuickBooksTimeFetchTransport(options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {}): TimeTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new AccountingError("accounting_configuration", "QuickBooks Time timeout is invalid");
  return async request => {
    assertTimeUrl(request.url);
    if (request.signal?.aborted) throw new AccountingError("accounting_validation", "QuickBooks Time request was cancelled");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const relay = (): void => controller.abort();
    request.signal?.addEventListener("abort", relay, { once: true });
    try {
      const response = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal, redirect: "error" });
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
    } catch {
      throw new AccountingError("accounting_unavailable", controller.signal.aborted ? "QuickBooks Time request timed out" : "QuickBooks Time request failed");
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", relay);
    }
  };
}

export interface QuickBooksTimeOAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "bearer";
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt?: string;
  readonly providerUserId?: string;
  readonly providerCompanyId?: string;
}

export interface QuickBooksTimeOAuthClient {
  authorizationUrl(input: { readonly clientId: string; readonly redirectUri: string; readonly state: string; readonly displayMode?: "login" | "create" }): string;
  exchangeCode(input: { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string; readonly code: string }): Promise<QuickBooksTimeOAuthTokenSet>;
  refresh(input: { readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string }): Promise<QuickBooksTimeOAuthTokenSet>;
}

function tokenResult(body: string, now = new Date()): QuickBooksTimeOAuthTokenSet {
  let parsed: unknown;
  try { parsed = parseJsonLosslessNumbers(body); } catch { throw new AccountingError("accounting_unavailable", "QuickBooks Time token response could not be confirmed"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AccountingError("accounting_unavailable", "QuickBooks Time token response is invalid");
  const value = parsed as Record<string, unknown>;
  const accessToken = typeof value.access_token === "string" && value.access_token.length > 0 ? value.access_token : null;
  const refreshToken = typeof value.refresh_token === "string" && value.refresh_token.length > 0 ? value.refresh_token : null;
  const expiresIn = typeof value.expires_in === "string" && /^\d+$/.test(value.expires_in) ? Number(value.expires_in) : typeof value.expires_in === "number" && Number.isSafeInteger(value.expires_in) ? value.expires_in : null;
  if (!accessToken || !refreshToken || expiresIn === null || expiresIn < 1 || expiresIn > 31_536_000) throw new AccountingError("accounting_unavailable", "QuickBooks Time token response is incomplete");
  const providerUserId = value.user_id === undefined ? undefined : String(value.user_id);
  const providerCompanyId = value.company_id === undefined ? undefined : String(value.company_id);
  if (providerUserId !== undefined && !/^[A-Za-z0-9_.:-]{1,160}$/.test(providerUserId)) throw new AccountingError("accounting_unavailable", "QuickBooks Time token identity could not be confirmed");
  if (providerCompanyId !== undefined && !/^[A-Za-z0-9_.:-]{1,160}$/.test(providerCompanyId)) throw new AccountingError("accounting_unavailable", "QuickBooks Time token identity could not be confirmed");
  const refreshExpires = typeof value.refresh_expires_in === "string" && /^\d+$/.test(value.refresh_expires_in) ? Number(value.refresh_expires_in) : typeof value.refresh_expires_in === "number" && Number.isSafeInteger(value.refresh_expires_in) ? value.refresh_expires_in : undefined;
  return {
    accessToken, refreshToken, tokenType: "bearer",
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    ...(refreshExpires === undefined ? {} : { refreshTokenExpiresAt: new Date(now.getTime() + refreshExpires * 1000).toISOString() }),
    ...(providerUserId === undefined ? {} : { providerUserId }),
    ...(providerCompanyId === undefined ? {} : { providerCompanyId }),
  };
}

export function createQuickBooksTimeOAuthClient(transport: TimeTransport, now: () => Date = () => new Date()): QuickBooksTimeOAuthClient {
  async function grant(fields: Record<string, string>): Promise<QuickBooksTimeOAuthTokenSet> {
    const response = await transport({ method: "POST", url: QUICKBOOKS_TIME_GRANT_URL, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    if (response.status < 200 || response.status >= 300) throw new AccountingError(response.status === 401 ? "accounting_conflict" : "accounting_unavailable", "QuickBooks Time authorization failed", { status: response.status, traceId: header(response, "intuit_tid") });
    return tokenResult(response.body, now());
  }
  return {
    authorizationUrl({ clientId, redirectUri, state, displayMode = "login" }) {
      const url = new URL(QUICKBOOKS_TIME_AUTHORIZATION_URL);
      url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", clientId); url.searchParams.set("redirect_uri", redirectUri); url.searchParams.set("state", state); url.searchParams.set("display_mode", displayMode);
      return url.toString();
    },
    exchangeCode: input => grant({ grant_type: "authorization_code", client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri }),
    refresh: input => grant({ grant_type: "refresh_token", client_id: input.clientId, client_secret: input.clientSecret, refresh_token: input.refreshToken }),
  };
}

export interface TimeProviderPage { readonly results: Record<string, Record<string, unknown>>; readonly more: boolean; readonly supplementalData?: Record<string, unknown>; }

function parsePage(body: string): TimeProviderPage {
  let parsed: unknown;
  try { parsed = parseJsonLosslessNumbers(body); } catch { throw new AccountingError("accounting_unavailable", "QuickBooks Time response was not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AccountingError("accounting_unavailable", "QuickBooks Time response is not an object");
  const root = parsed as Record<string, unknown>;
  const results = root.results;
  if (!results || typeof results !== "object" || Array.isArray(results)) throw new AccountingError("accounting_unavailable", "QuickBooks Time response has no results");
  const resource = Object.values(results as Record<string, unknown>).find(value => value && typeof value === "object" && !Array.isArray(value));
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) throw new AccountingError("accounting_unavailable", "QuickBooks Time response has no resource results");
  const more = root.more === true || root.more === "true";
  const supplemental = root.supplemental_data;
  return { results: resource as Record<string, Record<string, unknown>>, more, ...(supplemental && typeof supplemental === "object" && !Array.isArray(supplemental) ? { supplementalData: supplemental as Record<string, unknown> } : {}) };
}

export interface QuickBooksTimeClient {
  getPage(resource: "users" | "jobcodes" | "timesheets" | "timesheets_deleted", input: { readonly accessToken: string; readonly page?: number; readonly limit?: number; readonly modifiedSince?: string; readonly startDate?: string; readonly endDate?: string }): Promise<TimeProviderPage>;
}

export function createQuickBooksTimeClient(transport: TimeTransport): QuickBooksTimeClient {
  return {
    async getPage(resource, input) {
      const page = input.page ?? 1; const limit = input.limit ?? 200;
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AccountingError("accounting_validation", "QuickBooks Time pagination is invalid");
      const url = new URL(`${QUICKBOOKS_TIME_BASE_URL}/${resource}`);
      url.searchParams.set("page", String(page)); url.searchParams.set("limit", String(limit));
      if (input.modifiedSince) url.searchParams.set("modified_since", input.modifiedSince);
      if (input.startDate) url.searchParams.set("start_date", input.startDate);
      if (input.endDate) url.searchParams.set("end_date", input.endDate);
      const response = await transport({ method: "GET", url: url.toString(), headers: { Accept: "application/json", Authorization: `Bearer ${input.accessToken}` } });
      if (response.status < 200 || response.status >= 300) throw new AccountingError(response.status === 401 ? "accounting_conflict" : "accounting_unavailable", "QuickBooks Time read failed", { status: response.status, traceId: header(response, "intuit_tid") });
      return parsePage(response.body);
    },
  };
}

export function connectionKey(scope: TimeConnectionScope): string {
  return [scope.organizationId, scope.legalEntityId, scope.environment, scope.providerCompanyId].join("\u0000");
}

export type QuickBooksTimeEnvironment = TimeEnvironment;
