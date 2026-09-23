import type {
  QuickBooksOAuthClientConfig,
  QuickBooksOAuthDiscoveryDocument,
  QuickBooksOAuthEndpoints,
  QuickBooksOAuthTokenSet,
  QuickBooksTransport,
  QuickBooksTransportResponse,
} from "../../../shared/accounting/quickbooks";
import { QuickBooksIntegrationError } from "./errors";

export const QUICKBOOKS_AUTHORIZATION_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
export const QUICKBOOKS_TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QUICKBOOKS_REVOKE_ENDPOINT = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QUICKBOOKS_PRODUCTION_DISCOVERY_ENDPOINT = "https://developer.api.intuit.com/.well-known/openid_configuration";
export const QUICKBOOKS_SANDBOX_DISCOVERY_ENDPOINT = "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration";
export const QUICKBOOKS_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";
export const QUICKBOOKS_ALLOWED_OAUTH_SCOPES = [
  QUICKBOOKS_ACCOUNTING_SCOPE,
  "openid",
  "profile",
  "email",
  "phone",
  "address",
] as const;
const REFRESH_TOKEN_HARD_EXPIRY_HEADER = "x-include-refresh-token-hard-expires-in";

const SAFE_OAUTH_VALUE = /^[A-Za-z0-9._:/+-]{1,240}$/;

function assertNonEmpty(value: string, field: string, max = 512): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new QuickBooksIntegrationError("quickbooks_validation", `${field} is invalid`);
  }
}

function header(response: QuickBooksTransportResponse, name: string): string | undefined {
  const value = response.headers
    ? Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    : undefined;
  return value?.trim() || undefined;
}

function parsedObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // The provider's body is intentionally not included in errors.
  }
  return undefined;
}

function safeString(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, max) : undefined;
}

function positiveSeconds(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** OAuth error codes are short machine tokens; anything else is dropped so provider text never crosses the error boundary. */
function oauthErrorCode(value: unknown): string | undefined {
  const code = safeString(value, 64);
  return code && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

function oauthFailure(response: QuickBooksTransportResponse, operation: string): QuickBooksIntegrationError {
  const body = parsedObject(response.body);
  const code = oauthErrorCode(body?.error) ?? oauthErrorCode(body?.errorCode);
  const transient = response.status === 408 || response.status === 429 || response.status >= 500;
  return new QuickBooksIntegrationError("quickbooks_oauth", `QuickBooks OAuth ${operation} failed`, {
    status: response.status,
    retryable: transient,
    intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid"),
    // Keep the stable OAuth error code; provider descriptions can echo input
    // values and must not cross the safe error boundary.
    details: { error: code },
  });
}

function tokenSetFromResponse(
  response: QuickBooksTransportResponse,
  now: Date,
  fallbackRefreshToken?: string,
  fallbackRefreshTokenExpiresAt?: string,
  fallbackRefreshTokenHardExpiresAt?: string,
): QuickBooksOAuthTokenSet {
  const body = parsedObject(response.body);
  const accessToken = safeString(body?.access_token, 4096);
  const refreshToken = safeString(body?.refresh_token, 4096) ?? fallbackRefreshToken;
  const accessSeconds = positiveSeconds(body?.expires_in);
  if (!accessToken || !refreshToken || !accessSeconds) {
    throw new QuickBooksIntegrationError("quickbooks_oauth", "QuickBooks OAuth returned an invalid token response", {
      status: response.status,
      intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid"),
    });
  }
  const refreshSeconds = positiveSeconds(body?.x_refresh_token_expires_in);
  const refreshHardSeconds = positiveSeconds(body?.x_refresh_token_hard_expires_in);
  return {
    accessToken,
    refreshToken,
    tokenType: "bearer",
    accessTokenExpiresAt: new Date(now.getTime() + accessSeconds * 1_000).toISOString(),
    ...(refreshSeconds
      ? { refreshTokenExpiresAt: new Date(now.getTime() + refreshSeconds * 1_000).toISOString() }
      : fallbackRefreshTokenExpiresAt
        ? { refreshTokenExpiresAt: fallbackRefreshTokenExpiresAt }
        : {}),
    ...(refreshHardSeconds
      ? { refreshTokenHardExpiresAt: new Date(now.getTime() + refreshHardSeconds * 1_000).toISOString() }
      : fallbackRefreshTokenHardExpiresAt
        ? { refreshTokenHardExpiresAt: fallbackRefreshTokenHardExpiresAt }
        : {}),
    ...(safeString(body?.id_token, 8192) ? { idToken: safeString(body?.id_token, 8192) } : {}),
    ...(header(response, "intuit_tid") ?? header(response, "intuit-tid")
      ? { intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") }
      : {}),
  };
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function discoveryEndpoint(environment: QuickBooksOAuthClientConfig["environment"]): string {
  return environment === "sandbox" ? QUICKBOOKS_SANDBOX_DISCOVERY_ENDPOINT : QUICKBOOKS_PRODUCTION_DISCOVERY_ENDPOINT;
}

function requiredHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string") throw new QuickBooksIntegrationError("quickbooks_oauth", `QuickBooks discovery response is missing ${field}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QuickBooksIntegrationError("quickbooks_oauth", `QuickBooks discovery response has an invalid ${field}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new QuickBooksIntegrationError("quickbooks_oauth", `QuickBooks discovery response has an invalid ${field}`);
  }
  return url.toString();
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * Intuit matches redirect URIs exactly. Production URIs must be HTTPS on a
 * DNS host (no IP literal, no localhost); only sandbox may use localhost.
 */
function assertRedirectUriPolicy(value: string, environment: QuickBooksOAuthClientConfig["environment"]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks redirect URI is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  const localhost = hostname === "localhost" || hostname.endsWith(".localhost");
  const invalid = url.username || url.password || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && environment === "sandbox" && localhost))
    || (environment === "production" && (localhost || isIpLiteral(hostname)))
    || (environment === "sandbox" && isIpLiteral(hostname));
  if (invalid) {
    throw new QuickBooksIntegrationError("quickbooks_configuration", `QuickBooks redirect URI is not allowed for the ${environment === "production" ? "production" : "sandbox"} environment`);
  }
}

function defaultTransport(): QuickBooksTransport {
  throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks OAuth requires an injected transport");
}

export interface QuickBooksOAuthClient {
  getAuthorizationUrl(state: string, scopes?: readonly string[]): string;
  getDiscoveryDocument(): Promise<QuickBooksOAuthDiscoveryDocument>;
  /**
   * Endpoints this client will use for the next OAuth call. With discovery
   * enabled this resolves (and caches) the discovery document first; call it
   * before building an authorization URL so the authorize endpoint is current.
   */
  resolveEndpoints(): Promise<QuickBooksOAuthEndpoints>;
  exchangeAuthorizationCode(code: string): Promise<QuickBooksOAuthTokenSet>;
  refreshToken(refreshToken: string, previousRefreshTokenExpiresAt?: string, previousRefreshTokenHardExpiresAt?: string): Promise<QuickBooksOAuthTokenSet>;
  revokeToken(token: string): Promise<{ intuitTid?: string }>;
}

/**
 * OAuth 2.0 client with no hidden retries and no token logging. All network
 * calls use the injected transport so tests remain offline and deterministic.
 */
export function createQuickBooksOAuthClient(config: QuickBooksOAuthClientConfig): QuickBooksOAuthClient {
  assertNonEmpty(config.clientId, "QuickBooks client ID");
  assertNonEmpty(config.clientSecret, "QuickBooks client secret");
  assertNonEmpty(config.redirectUri, "QuickBooks redirect URI");
  if (config.redirectUri.length > 2048) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks redirect URI is too long");
  if (config.environment !== "sandbox" && config.environment !== "production") throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks environment is invalid");
  assertRedirectUriPolicy(config.redirectUri, config.environment);
  if (typeof config.transport !== "function") throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks OAuth transport is required");
  const transport = config.transport ?? defaultTransport();
  const now = config.now ?? (() => new Date());
  const documented: QuickBooksOAuthEndpoints = {
    authorizationEndpoint: config.authorizationEndpoint ?? QUICKBOOKS_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: config.tokenEndpoint ?? QUICKBOOKS_TOKEN_ENDPOINT,
    revokeEndpoint: config.revokeEndpoint ?? QUICKBOOKS_REVOKE_ENDPOINT,
  };
  const discoveryEnabled = config.discovery?.enabled === true;
  const discoveryTtlMs = config.discovery?.ttlMs ?? 24 * 60 * 60 * 1_000;
  const discoveryFailureTtlMs = config.discovery?.failureTtlMs ?? 5 * 60 * 1_000;
  let cachedEndpoints: { readonly endpoints: QuickBooksOAuthEndpoints; readonly expiresAt: number } | null = null;
  let discoveryInFlight: Promise<QuickBooksOAuthEndpoints> | null = null;

  // Explicit overrides win over discovery so tests and pinned deployments stay deterministic.
  const withOverrides = (discovered: QuickBooksOAuthDiscoveryDocument): QuickBooksOAuthEndpoints => ({
    authorizationEndpoint: config.authorizationEndpoint ?? discovered.authorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint ?? discovered.tokenEndpoint,
    revokeEndpoint: config.revokeEndpoint ?? discovered.revokeEndpoint,
  });

  const resolveEndpoints = async (): Promise<QuickBooksOAuthEndpoints> => {
    if (!discoveryEnabled) return documented;
    const at = now().getTime();
    if (cachedEndpoints && cachedEndpoints.expiresAt > at) return cachedEndpoints.endpoints;
    if (discoveryInFlight) return discoveryInFlight;
    discoveryInFlight = (async () => {
      try {
        // One discovery request; a failure falls back to the documented
        // endpoints for a short window rather than retrying the same call.
        const discovered = await client.getDiscoveryDocument();
        cachedEndpoints = { endpoints: withOverrides(discovered), expiresAt: at + discoveryTtlMs };
      } catch {
        cachedEndpoints = { endpoints: documented, expiresAt: at + discoveryFailureTtlMs };
      } finally {
        discoveryInFlight = null;
      }
      return cachedEndpoints.endpoints;
    })();
    return discoveryInFlight;
  };

  const client: QuickBooksOAuthClient = {
    resolveEndpoints,

    getAuthorizationUrl(state: string, scopes = [QUICKBOOKS_ACCOUNTING_SCOPE]): string {
      assertNonEmpty(state, "QuickBooks OAuth state");
      if (scopes.length === 0 || scopes.some(scope => typeof scope !== "string" || !SAFE_OAUTH_VALUE.test(scope) || !(QUICKBOOKS_ALLOWED_OAUTH_SCOPES as readonly string[]).includes(scope))) {
        throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks OAuth scopes are invalid");
      }
      // Synchronous by contract: use the cached discovery result when
      // resolveEndpoints() has run, otherwise the documented endpoint.
      const at = now().getTime();
      const url = new URL(cachedEndpoints && cachedEndpoints.expiresAt > at ? cachedEndpoints.endpoints.authorizationEndpoint : documented.authorizationEndpoint);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async getDiscoveryDocument(): Promise<QuickBooksOAuthDiscoveryDocument> {
      const response = await transport({
        method: "GET",
        url: discoveryEndpoint(config.environment),
        headers: { Accept: "application/json" },
      });
      if (response.status < 200 || response.status >= 300) throw oauthFailure(response, "discovery");
      const body = parsedObject(response.body);
      return {
        authorizationEndpoint: requiredHttpsUrl(body?.authorization_endpoint, "authorization_endpoint"),
        tokenEndpoint: requiredHttpsUrl(body?.token_endpoint, "token_endpoint"),
        revokeEndpoint: requiredHttpsUrl(body?.revocation_endpoint, "revocation_endpoint"),
        ...(header(response, "intuit_tid") ?? header(response, "intuit-tid")
          ? { intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") }
          : {}),
      };
    },

    async exchangeAuthorizationCode(code: string): Promise<QuickBooksOAuthTokenSet> {
      assertNonEmpty(code, "QuickBooks authorization code");
      const { tokenEndpoint } = await resolveEndpoints();
      const response = await transport({
        method: "POST",
        url: tokenEndpoint,
        headers: {
          Accept: "application/json",
          Authorization: basicAuthorization(config.clientId, config.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
          [REFRESH_TOKEN_HARD_EXPIRY_HEADER]: "true",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
        }).toString(),
      });
      if (response.status < 200 || response.status >= 300) throw oauthFailure(response, "code exchange");
      return tokenSetFromResponse(response, now());
    },

    async refreshToken(refreshToken: string, previousRefreshTokenExpiresAt?: string, previousRefreshTokenHardExpiresAt?: string): Promise<QuickBooksOAuthTokenSet> {
      assertNonEmpty(refreshToken, "QuickBooks refresh token", 8192);
      const { tokenEndpoint } = await resolveEndpoints();
      const response = await transport({
        method: "POST",
        url: tokenEndpoint,
        headers: {
          Accept: "application/json",
          Authorization: basicAuthorization(config.clientId, config.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
          [REFRESH_TOKEN_HARD_EXPIRY_HEADER]: "true",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
      if (response.status < 200 || response.status >= 300) throw oauthFailure(response, "token refresh");
      return tokenSetFromResponse(response, now(), refreshToken, previousRefreshTokenExpiresAt, previousRefreshTokenHardExpiresAt);
    },

    async revokeToken(token: string): Promise<{ intuitTid?: string }> {
      assertNonEmpty(token, "QuickBooks token", 8192);
      const { revokeEndpoint } = await resolveEndpoints();
      const response = await transport({
        method: "POST",
        url: revokeEndpoint,
        headers: {
          Accept: "application/json",
          Authorization: basicAuthorization(config.clientId, config.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token }).toString(),
      });
      if (response.status < 200 || response.status >= 300) throw oauthFailure(response, "token revocation");
      const intuitTid = header(response, "intuit_tid") ?? header(response, "intuit-tid");
      return intuitTid ? { intuitTid } : {};
    },
  };
  return client;
}
