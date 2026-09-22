import { createHash, randomBytes } from "node:crypto";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { QuickBooksOAuthClient } from "../integrations/quickbooks/oauth";
import type { QuickBooksOAuthTokenSet } from "../../shared/accounting/quickbooks";
import type { QuickBooksTokenManager } from "../integrations/quickbooks/token-manager";
import {
  financialSourceEnvironmentSchema,
  financialSourceScopeSchema,
  type FinancialSourceEnvironment,
} from "../../shared/accounting";
import type { QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import { AccountingError } from "./errors";
import type { QuickBooksPendingBindingStore, QuickBooksRealmBindingProof } from "./binding";

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1_000;

export interface QuickBooksOAuthState {
  readonly stateHash: string;
  readonly actorId: string;
  readonly sessionBindingHash: string | null;
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly environment: FinancialSourceEnvironment;
  readonly expectedRealmId: string | null;
  readonly expiresAt: string;
}

export interface QuickBooksOAuthStateStore {
  create(state: QuickBooksOAuthState): Promise<void>;
  /** Read an unconsumed state without changing its one-use marker. */
  peek(stateHash: string): Promise<QuickBooksOAuthState | null>;
  /** Consume is atomic. A consumed, expired, or missing state returns null. */
  consume(stateHash: string): Promise<QuickBooksOAuthState | null>;
}

interface OAuthStateRow {
  state_hash: unknown;
  actor_id: unknown;
  session_binding_hash: unknown;
  organization_id: unknown;
  legal_entity_id: unknown;
  environment: unknown;
  expected_realm_id: unknown;
  expires_at: unknown;
}

function hashState(state: string): string {
  if (typeof state !== "string" || state.length < 32 || state.length > 512 || !/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new AccountingError("accounting_validation", "QuickBooks OAuth state is invalid");
  }
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function hashQuickBooksSessionBinding(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new AccountingError("accounting_validation", "QuickBooks OAuth session binding is invalid");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AccountingError("accounting_unavailable", `Stored OAuth state ${field} is invalid`);
  return value;
}

function timestampText(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  return text(value, field, 80);
}

function mapRow(row: OAuthStateRow): QuickBooksOAuthState {
  return {
    stateHash: text(row.state_hash, "hash", 128),
    actorId: text(row.actor_id, "actor", 160),
    sessionBindingHash: row.session_binding_hash === null || row.session_binding_hash === undefined ? null : text(row.session_binding_hash, "session binding", 128),
    organizationId: text(row.organization_id, "organization ID", 160),
    legalEntityId: text(row.legal_entity_id, "legal entity ID", 160),
    environment: financialSourceEnvironmentSchema.parse(row.environment),
    expectedRealmId: row.expected_realm_id === null || row.expected_realm_id === undefined ? null : text(row.expected_realm_id, "expected realm", 32),
    expiresAt: timestampText(row.expires_at, "expiry"),
  };
}

export class PostgresQuickBooksOAuthStateStore implements QuickBooksOAuthStateStore {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  async create(state: QuickBooksOAuthState): Promise<void> {
    const parsed = financialSourceScopeSchema.parse({
      provider: "qbo",
      organizationId: state.organizationId,
      legalEntityId: state.legalEntityId,
      environment: state.environment,
      realmId: state.expectedRealmId ?? "00000000000000000000000000000000",
    });
    if (!/^[a-f0-9]{64}$/.test(state.stateHash)) throw new AccountingError("accounting_validation", "OAuth state hash is invalid");
    await this.executor.query(
      `INSERT INTO accounting_qbo_oauth_states
        (state_hash, actor_id, session_binding_hash, organization_id, legal_entity_id, environment, expected_realm_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [state.stateHash, state.actorId, state.sessionBindingHash, parsed.organizationId, parsed.legalEntityId, parsed.environment, state.expectedRealmId, state.expiresAt],
    );
  }

  async peek(stateHash: string): Promise<QuickBooksOAuthState | null> {
    if (typeof stateHash !== "string" || !/^[a-f0-9]{64}$/.test(stateHash)) throw new AccountingError("accounting_validation", "OAuth state hash is invalid");
    const result = await this.executor.query<OAuthStateRow>(
      `SELECT state_hash, actor_id, session_binding_hash, organization_id, legal_entity_id, environment, expected_realm_id, expires_at
         FROM accounting_qbo_oauth_states
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [stateHash],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async consume(stateHash: string): Promise<QuickBooksOAuthState | null> {
    if (typeof stateHash !== "string" || !/^[a-f0-9]{64}$/.test(stateHash)) throw new AccountingError("accounting_validation", "OAuth state hash is invalid");
    const result = await this.executor.query<OAuthStateRow>(
      `UPDATE accounting_qbo_oauth_states
          SET consumed_at = now()
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING state_hash, actor_id, session_binding_hash, organization_id, legal_entity_id, environment, expected_realm_id, expires_at`,
      [stateHash],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }
}

export interface BeginQuickBooksOAuthInput {
  readonly actorId: string;
  /** The authenticated browser session ID. Device flow is not implemented. */
  readonly sessionBinding: string;
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly environment: FinancialSourceEnvironment;
  readonly expectedRealmId?: string;
  /**
   * Retained for transport compatibility. The binding confirmation happens
   * only after the callback has persisted and displayed CompanyInfo; a caller
   * supplied realm ID or pre-OAuth checkbox is not identity proof.
   */
  readonly realmBindingConfirmed?: boolean;
  readonly scopes?: readonly string[];
  readonly ttlMs?: number;
}

export interface BeginQuickBooksOAuthResult {
  readonly state: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface CompleteQuickBooksOAuthInput {
  readonly state: string;
  readonly actorId: string;
  /** The same authenticated browser session ID that initiated the flow. */
  readonly sessionBinding: string;
  readonly code?: string;
  readonly callbackRealmId?: string;
  readonly providerError?: string;
}

export interface CompleteQuickBooksOAuthConnectedResult {
  readonly status: "connected";
  readonly scope: QuickBooksConnectionScope;
  readonly connection: {
    readonly accessTokenExpiresAt: string;
    readonly refreshTokenExpiresAt?: string;
    readonly intuitTid?: string;
    readonly version?: number;
  };
}

export interface CompleteQuickBooksOAuthPendingResult {
  readonly status: "pending_confirmation";
  readonly scope: QuickBooksConnectionScope;
  readonly pendingId: string;
  readonly providerCompanyId: string;
  readonly providerCompanyName: string | null;
  readonly providerLegalName: string | null;
  readonly homeCurrency: string | null;
  readonly companyInfoHash: string;
  readonly expiresAt: string;
}

export type CompleteQuickBooksOAuthResult = CompleteQuickBooksOAuthConnectedResult | CompleteQuickBooksOAuthPendingResult;

export interface ConfirmQuickBooksOAuthInput {
  readonly pendingId: string;
  readonly actorId: string;
  readonly sessionBinding: string;
  readonly organizationId?: string;
  readonly legalEntityId?: string;
}

export interface QuickBooksOAuthConnectionService {
  begin(input: BeginQuickBooksOAuthInput): Promise<BeginQuickBooksOAuthResult>;
  peek(state: string): Promise<QuickBooksOAuthState | null>;
  complete(input: CompleteQuickBooksOAuthInput): Promise<CompleteQuickBooksOAuthResult>;
  confirm(input: ConfirmQuickBooksOAuthInput): Promise<CompleteQuickBooksOAuthConnectedResult>;
}

/**
 * State is opaque, stored hashed, bound to the selected legal entity and
 * consumed once before any code exchange. Callback realm is checked against
 * the realm selected at connect time when one already exists.
 */
export function createQuickBooksOAuthConnectionService(options: {
  readonly oauth: Pick<QuickBooksOAuthClient, "getAuthorizationUrl" | "exchangeAuthorizationCode">;
  readonly stateStore: QuickBooksOAuthStateStore;
  readonly tokenManager: Pick<QuickBooksTokenManager, "saveTokens"> & Partial<Pick<QuickBooksTokenManager, "saveNewConnection">>;
  readonly pendingBindingStore?: QuickBooksPendingBindingStore;
  /**
   * Optional configured adapter for the first-connection confirmation. It is
   * responsible for binding the verified CompanyInfo, saving the encrypted
   * tokens, writing the audit row, and consuming the pending handoff in one
   * database transaction.
   */
  readonly confirmPendingBinding?: (input: ConfirmQuickBooksOAuthInput & { readonly sessionBindingHash: string }) => Promise<CompleteQuickBooksOAuthConnectedResult>;
  /** Persist the provider identity only after the administrator confirms the
   * CompanyInfo shown by the callback. */
  readonly persistRealmBinding?: (input: { readonly actorId: string; readonly pendingId: string; readonly scope: QuickBooksConnectionScope; readonly proof: QuickBooksRealmBindingProof }) => Promise<void>;
  /** The root adapter must re-resolve the active entity grant and, on a first
   * connection, verify CompanyInfo identity before persisting the realm. */
  readonly verifyRealmBinding?: (input: { readonly actorId: string; readonly organizationId: string; readonly legalEntityId: string; readonly environment: FinancialSourceEnvironment; readonly realmId: string; readonly expectedRealmId: string | null; readonly token: QuickBooksOAuthTokenSet }) => Promise<QuickBooksRealmBindingProof | void>;
  readonly now?: () => Date;
}): QuickBooksOAuthConnectionService {
  const now = options.now ?? (() => new Date());
  return {
    async begin(input) {
      if (typeof input.sessionBinding !== "string" || input.sessionBinding.length < 8) throw new AccountingError("accounting_validation", "An authenticated browser session is required to begin QuickBooks OAuth");
      const parsed = financialSourceScopeSchema.parse({
        provider: "qbo",
        organizationId: input.organizationId,
        legalEntityId: input.legalEntityId,
        environment: input.environment,
        realmId: input.expectedRealmId ?? "00000000000000000000000000000000",
      });
      const ttlMs = input.ttlMs ?? DEFAULT_STATE_TTL_MS;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 30 * 60 * 1_000) throw new AccountingError("accounting_validation", "OAuth state TTL is invalid");
      const state = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
      await options.stateStore.create({
        stateHash: hashState(state),
        actorId: input.actorId,
        sessionBindingHash: hashQuickBooksSessionBinding(input.sessionBinding),
        organizationId: parsed.organizationId,
        legalEntityId: parsed.legalEntityId,
        environment: parsed.environment,
        expectedRealmId: input.expectedRealmId ?? null,
        expiresAt,
      });
      return { state, authorizationUrl: options.oauth.getAuthorizationUrl(state, input.scopes), expiresAt };
    },
    async peek(state) {
      return options.stateStore.peek(hashState(state));
    },
    async complete(input) {
      const stateHash = hashState(input.state);
      const pending = await options.stateStore.consume(stateHash);
      if (!pending) throw new AccountingError("accounting_conflict", "QuickBooks OAuth state is invalid, expired, or already used");
      if (pending.actorId !== input.actorId) throw new AccountingError("accounting_conflict", "QuickBooks OAuth callback actor does not match the initiating session");
      if (typeof input.sessionBinding !== "string" || input.sessionBinding.length < 8 || pending.sessionBindingHash !== hashQuickBooksSessionBinding(input.sessionBinding)) throw new AccountingError("accounting_conflict", "QuickBooks OAuth callback session does not match the initiating session");
      if (input.providerError) throw new AccountingError("accounting_unavailable", "QuickBooks authorization was declined");
      if (!input.code || !input.callbackRealmId || !/^\d{1,32}$/.test(input.callbackRealmId)) throw new AccountingError("accounting_validation", "QuickBooks callback is missing a valid realm");
      if (pending.expectedRealmId !== null && pending.expectedRealmId !== input.callbackRealmId) {
        throw new AccountingError("accounting_conflict", "QuickBooks callback realm does not match the selected legal entity");
      }
      const token = await options.oauth.exchangeAuthorizationCode(input.code);
      if (!options.verifyRealmBinding) throw new AccountingError("accounting_conflict", "QuickBooks CompanyInfo identity proof is required before connecting a realm");
      // The verifier may use this short-lived token for a read-only CompanyInfo
      // identity check. It must never persist or return the credential.
      const proof = await options.verifyRealmBinding({ actorId: pending.actorId, organizationId: pending.organizationId, legalEntityId: pending.legalEntityId, environment: pending.environment, realmId: input.callbackRealmId, expectedRealmId: pending.expectedRealmId, token });
      const scope: QuickBooksConnectionScope = {
        organizationId: pending.organizationId,
        legalEntityId: pending.legalEntityId,
        environment: pending.environment,
        realmId: input.callbackRealmId,
      };
      if (proof) {
        if (!options.pendingBindingStore) throw new AccountingError("accounting_configuration", "Durable QuickBooks binding confirmation storage is not configured");
        const pendingBinding = await options.pendingBindingStore.create({
          actorId: pending.actorId,
          sessionBindingHash: pending.sessionBindingHash,
          scope,
          proof,
          token,
          expiresAt: new Date(now().getTime() + DEFAULT_STATE_TTL_MS).toISOString(),
        });
        return { status: "pending_confirmation", scope, pendingId: pendingBinding.pendingId, providerCompanyId: proof.providerCompanyId, providerCompanyName: proof.providerCompanyName, providerLegalName: proof.providerLegalName, homeCurrency: proof.homeCurrency, companyInfoHash: proof.companyInfoHash, expiresAt: pendingBinding.expiresAt };
      }
      const saved = options.tokenManager.saveNewConnection
        ? await options.tokenManager.saveNewConnection(scope, token)
        : await options.tokenManager.saveTokens(scope, token);
      return {
        scope,
        connection: {
          accessTokenExpiresAt: saved.accessTokenExpiresAt,
          ...(saved.refreshTokenExpiresAt ? { refreshTokenExpiresAt: saved.refreshTokenExpiresAt } : {}),
          ...(saved.intuitTid ? { intuitTid: saved.intuitTid } : {}),
          ...(saved.version === undefined ? {} : { version: saved.version }),
        },
        status: "connected",
      };
    },
    async confirm(input) {
      if (!options.pendingBindingStore) throw new AccountingError("accounting_configuration", "Durable QuickBooks binding confirmation storage is not configured");
      if (typeof input.sessionBinding !== "string" || input.sessionBinding.length < 8) throw new AccountingError("accounting_validation", "An authenticated browser session is required to confirm QuickBooks binding");
      const sessionBindingHash = hashQuickBooksSessionBinding(input.sessionBinding);
      if (!sessionBindingHash) throw new AccountingError("accounting_validation", "QuickBooks OAuth session binding is invalid");
      if (!options.confirmPendingBinding) throw new AccountingError("accounting_configuration", "Atomic QuickBooks binding confirmation is not configured");
      return options.confirmPendingBinding({ ...input, sessionBindingHash });
    },
  };
}

export { hashState as hashQuickBooksOAuthState };
