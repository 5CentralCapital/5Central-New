/**
 * Shared contracts for the QuickBooks Online Accounting boundary.
 *
 * These types deliberately describe the provider boundary only. They do not
 * import HTTP, OAuth SDKs, database clients, or application routes.
 */

export type QuickBooksEnvironment = "sandbox" | "production";

/**
 * The local scope is part of the identity of a QBO connection. A realm ID is
 * an Intuit company identifier, not a substitute for the local account or
 * legal-entity owner.
 */
export interface QuickBooksConnectionScope {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly realmId: string;
  readonly environment: QuickBooksEnvironment;
}

export interface QuickBooksConnectionKey {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly realmId: string;
  readonly environment: QuickBooksEnvironment;
}

export type QuickBooksTokenType = "bearer";

/** A token set as returned by Intuit, normalized to absolute expiry times. */
export interface QuickBooksOAuthTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: QuickBooksTokenType;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt?: string;
  /** Absolute five-year refresh-token lifetime reported by Intuit when opted in. */
  readonly refreshTokenHardExpiresAt?: string;
  readonly idToken?: string;
  /** Safe Intuit trace ID for support/audit correlation; never a credential. */
  readonly intuitTid?: string;
}

/**
 * A repository record. `version` is an optional optimistic-concurrency value
 * supplied by the persistence owner; a refresh must never silently overwrite
 * a newer rotated refresh token.
 */
export interface QuickBooksStoredToken extends QuickBooksOAuthTokenSet {
  readonly version?: number;
  readonly updatedAt?: string;
}

export interface QuickBooksTokenRepository {
  load(scope: QuickBooksConnectionKey): Promise<QuickBooksStoredToken | null | undefined>;
  save(
    scope: QuickBooksConnectionKey,
    token: QuickBooksOAuthTokenSet,
    expectedVersion?: number,
  ): Promise<QuickBooksStoredToken>;
  /** Explicit reconnect path. It may clear a revoked tombstone; refresh never calls it. */
  saveNewConnection?(scope: QuickBooksConnectionKey, token: QuickBooksOAuthTokenSet): Promise<QuickBooksStoredToken>;
  /** Refresh save fenced by the current database lease owner. */
  saveWithLease?(scope: QuickBooksConnectionKey, token: QuickBooksOAuthTokenSet, expectedVersion: number, leaseOwnerId: string): Promise<QuickBooksStoredToken>;
  /** Durably stop refreshes, disable scoped capabilities, and record a safe lifecycle event. */
  markNeedsReconnect(
    scope: QuickBooksConnectionKey,
    details: { readonly reason: "invalid_grant" | "refresh_token_expired" | "refresh_token_hard_expired"; readonly intuitTid?: string },
  ): Promise<void>;
  revoke(scope: QuickBooksConnectionKey): Promise<void>;
}

export interface QuickBooksTokenProvider {
  getAccessToken(scope: QuickBooksConnectionScope): Promise<string>;
}

/** A JSON object accepted by the QBO REST API or returned by it. */
export type QuickBooksJsonObject = Record<string, unknown>;

/**
 * QBO entity names are provider-defined strings. The server validates the
 * path grammar and blocks capabilities outside the Accounting REST surface;
 * keeping this branded string allows new Accounting entities to be used
 * without a shared-contract release.
 */
export type QuickBooksEntityName = string & { readonly __quickBooksEntityName?: never };

/**
 * The REST Accounting surface is intentionally explicit. Premium GraphQL
 * Projects, Payments, and money-movement capabilities are not enabled by
 * this adapter.
 */
export type QuickBooksCapability =
  | "accounting.read"
  | "accounting.create"
  | "accounting.update"
  | "payments"
  | "money_movement"
  | "projects.graphql";

/**
 * Adapter implementation flags only. `true` means this code knows how to
 * call the surface; it does not establish that a particular connected realm
 * or subscription has the capability. The root integration layer must keep a
 * capability disabled until it has current per-connection evidence.
 */
export const QUICKBOOKS_ADAPTER_CAPABILITIES: Readonly<Record<QuickBooksCapability, boolean>> = {
  "accounting.read": true,
  "accounting.create": true,
  "accounting.update": true,
  payments: false,
  money_movement: false,
  "projects.graphql": false,
};

/** @deprecated Use QUICKBOOKS_ADAPTER_CAPABILITIES; these are implementation flags, not connection entitlements. */
export const QUICKBOOKS_CAPABILITIES = QUICKBOOKS_ADAPTER_CAPABILITIES;

export function isQuickBooksAdapterCapabilityImplemented(capability: QuickBooksCapability): boolean {
  return QUICKBOOKS_ADAPTER_CAPABILITIES[capability];
}

/**
 * Per-connection capability evidence is intentionally required by callers.
 * No evidence is accepted by default, so an unknown realm stays disabled.
 */
export function isQuickBooksCapabilityEnabled(capability: QuickBooksCapability, verifiedForConnection = false): boolean {
  return verifiedForConnection && QUICKBOOKS_ADAPTER_CAPABILITIES[capability];
}

export interface QuickBooksTransportRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface QuickBooksTransportResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export type QuickBooksTransport = (
  request: QuickBooksTransportRequest,
) => Promise<QuickBooksTransportResponse>;

export interface QuickBooksEntityEnvelope<T extends QuickBooksJsonObject = QuickBooksJsonObject> {
  readonly [entity: string]: T | unknown;
}

export interface QuickBooksApiResponse<T extends QuickBooksJsonObject = QuickBooksJsonObject> {
  readonly entity: T;
  readonly raw: QuickBooksEntityEnvelope<T>;
  readonly status: number;
  readonly intuitTid?: string;
}

export interface QuickBooksQueryResponse<T extends QuickBooksJsonObject = QuickBooksJsonObject> {
  readonly entities: readonly T[];
  readonly startPosition?: number;
  readonly maxResults?: number;
  readonly raw: QuickBooksJsonObject;
  readonly status: number;
  readonly intuitTid?: string;
}

export interface QuickBooksOAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly environment: QuickBooksEnvironment;
  readonly tokenEndpoint?: string;
  readonly revokeEndpoint?: string;
  readonly authorizationEndpoint?: string;
  readonly transport: QuickBooksTransport;
  readonly now?: () => Date;
  /**
   * Resolve the authorization, token and revocation endpoints from Intuit's
   * OpenID discovery document instead of the documented constants. Explicit
   * endpoint overrides above always win. Discovery is attempted once per TTL
   * and falls back to the documented endpoints when it is unavailable.
   */
  readonly discovery?: QuickBooksOAuthDiscoveryOptions;
}

export interface QuickBooksOAuthDiscoveryOptions {
  readonly enabled: boolean;
  /** Cache lifetime for a successful discovery. Default 24 hours. */
  readonly ttlMs?: number;
  /** Cache lifetime for the fallback after a failed discovery. Default 5 minutes. */
  readonly failureTtlMs?: number;
}

export interface QuickBooksOAuthEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revokeEndpoint: string;
}

export interface QuickBooksOAuthDiscoveryDocument {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revokeEndpoint: string;
  readonly intuitTid?: string;
}

export interface QuickBooksOAuthErrorDetails {
  readonly code?: string;
  readonly description?: string;
}

export interface QuickBooksAccountingClientConfig {
  readonly scope: QuickBooksConnectionScope;
  readonly getAccessToken: () => Promise<string>;
  readonly transport: QuickBooksTransport;
  readonly minorVersion?: string;
}

export interface QuickBooksUpdateInput<T extends QuickBooksJsonObject = QuickBooksJsonObject> {
  readonly entity: QuickBooksEntityName;
  readonly id: string;
  readonly syncToken: string;
  readonly fields: T;
}

/** Safe fields for a root-owned reconciliation/outbox event. */
export type QuickBooksOutboxOperation = "create" | "update" | "reconcile";

export interface QuickBooksOutboxPayload {
  readonly connection: QuickBooksConnectionKey;
  readonly entity: QuickBooksEntityName;
  readonly operation: QuickBooksOutboxOperation;
  readonly localOperationId: string;
  readonly idempotencyKey: string;
  readonly providerTraceId?: string;
  readonly providerEntityId?: string;
}

export interface QuickBooksWebhookEvent {
  readonly id?: string;
  readonly source?: string;
  readonly type?: string;
  readonly intuitAccountId?: string;
  readonly intuitEntityId?: string;
  readonly time?: string;
  readonly data?: unknown;
}

export function quickBooksConnectionKey(scope: QuickBooksConnectionKey): string {
  return [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId].join("\u0000");
}
