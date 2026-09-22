import { createHash, randomBytes } from "node:crypto";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "../accounting/errors";
import { timeConnectionScopeSchema, timeConnectionSetupScopeSchema, type TimeConnectionScope, type TimeConnectionSetupScope } from "../../shared/time";
import type { QuickBooksTimeOAuthClient, QuickBooksTimeOAuthTokenSet } from "./provider";
import type { StoredTimeToken, TimeTokenRepository } from "./connection-store";

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1_000;

export interface TimeOAuthState {
  readonly stateHash: string;
  readonly actorId: string;
  readonly sessionBindingHash: string;
  readonly scope: TimeOAuthScope;
  readonly expiresAt: string;
}

export type TimeOAuthScope = Omit<TimeConnectionScope, "providerCompanyId"> & { readonly providerCompanyId: string | null };

export interface TimeOAuthStateStore {
  create(state: TimeOAuthState): Promise<void>;
  peek(stateHash: string): Promise<TimeOAuthState | null>;
  consume(stateHash: string): Promise<TimeOAuthState | null>;
}

function hashState(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AccountingError("accounting_validation", "QuickBooks Time OAuth state is invalid");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashSession(value: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AccountingError("accounting_validation", "QuickBooks Time OAuth session binding is invalid");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AccountingError("accounting_unavailable", `Stored QuickBooks Time OAuth ${field} is invalid`);
  return value;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : text(value, "expiry", 80);
}

function mapRow(row: Record<string, unknown>): TimeOAuthState {
  const setup = timeConnectionSetupScopeSchema.parse({
    organizationId: row.organization_id,
    legalEntityId: row.legal_entity_id,
    environment: row.environment,
    ...(row.provider_company_id === null || row.provider_company_id === undefined ? {} : { providerCompanyId: row.provider_company_id }),
  });
  const stateHash = text(row.state_hash, "state hash", 128);
  const sessionBindingHash = text(row.session_binding_hash, "session binding hash", 128);
  if (!/^[a-f0-9]{64}$/.test(stateHash) || !/^[a-f0-9]{64}$/.test(sessionBindingHash)) throw new AccountingError("accounting_unavailable", "Stored QuickBooks Time OAuth state is invalid");
  return { stateHash, actorId: text(row.actor_id, "actor", 255), sessionBindingHash, scope: { ...setup, providerCompanyId: setup.providerCompanyId ?? null }, expiresAt: timestamp(row.expires_at) };
}

export class PostgresTimeOAuthStateStore implements TimeOAuthStateStore {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  async create(state: TimeOAuthState): Promise<void> {
    await this.executor.query(
      `INSERT INTO time_oauth_states
        (id,state_hash,organization_id,legal_entity_id,environment,provider_company_id,actor_id,session_binding_hash,expires_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8)`,
      [state.stateHash, state.scope.organizationId, state.scope.legalEntityId, state.scope.environment, state.scope.providerCompanyId, state.actorId, state.sessionBindingHash, state.expiresAt],
    );
  }

  async peek(stateHash: string): Promise<TimeOAuthState | null> {
    if (typeof stateHash !== "string" || !/^[a-f0-9]{64}$/.test(stateHash)) throw new AccountingError("accounting_validation", "QuickBooks Time OAuth state hash is invalid");
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT state_hash,organization_id,legal_entity_id,environment,provider_company_id,actor_id,session_binding_hash,expires_at
         FROM time_oauth_states
        WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at > now()`,
      [stateHash],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async consume(stateHash: string): Promise<TimeOAuthState | null> {
    if (typeof stateHash !== "string" || !/^[a-f0-9]{64}$/.test(stateHash)) throw new AccountingError("accounting_validation", "QuickBooks Time OAuth state hash is invalid");
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE time_oauth_states SET consumed_at=now()
        WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING state_hash,organization_id,legal_entity_id,environment,provider_company_id,actor_id,session_binding_hash,expires_at`,
      [stateHash],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

export interface BeginTimeOAuthInput {
  readonly actorId: string;
  readonly sessionBinding: string;
  readonly scope: TimeConnectionSetupScope;
  readonly ttlMs?: number;
  readonly displayMode?: "login" | "create";
}

export interface BeginTimeOAuthResult {
  readonly state: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface CompleteTimeOAuthInput {
  readonly state: string;
  readonly actorId: string;
  readonly sessionBinding: string;
  readonly code?: string;
  readonly providerError?: string;
}

export interface CompleteTimeOAuthResult {
  readonly scope: TimeConnectionScope;
  readonly connection: {
    readonly accessTokenExpiresAt: string;
    readonly refreshTokenExpiresAt?: string;
    readonly version: number;
  };
}

export interface TimeOAuthConnectionService {
  begin(input: BeginTimeOAuthInput): Promise<BeginTimeOAuthResult>;
  peek(state: string): Promise<TimeOAuthState | null>;
  complete(input: CompleteTimeOAuthInput): Promise<CompleteTimeOAuthResult>;
}

export function createTimeOAuthConnectionService(options: {
  readonly oauth: Pick<QuickBooksTimeOAuthClient, "authorizationUrl" | "exchangeCode">;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly stateStore: TimeOAuthStateStore;
  readonly tokenRepository: Pick<TimeTokenRepository, "saveNewConnection">;
  readonly now?: () => Date;
}): TimeOAuthConnectionService {
  const now = options.now ?? (() => new Date());
  return {
    async begin(input) {
      const setup = timeConnectionSetupScopeSchema.parse(input.scope);
      const scope: TimeOAuthScope = { ...setup, providerCompanyId: setup.providerCompanyId ?? null };
      if (typeof input.actorId !== "string" || input.actorId.length === 0 || input.actorId.length > 255) throw new AccountingError("accounting_validation", "An authenticated actor is required to begin QuickBooks Time OAuth");
      const ttlMs = input.ttlMs ?? DEFAULT_STATE_TTL_MS;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 30 * 60_000) throw new AccountingError("accounting_validation", "QuickBooks Time OAuth state TTL is invalid");
      const state = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
      await options.stateStore.create({ stateHash: hashState(state), actorId: input.actorId, sessionBindingHash: hashSession(input.sessionBinding), scope, expiresAt });
      return {
        state,
        authorizationUrl: options.oauth.authorizationUrl({ clientId: options.clientId, redirectUri: options.redirectUri, state, displayMode: input.displayMode }),
        expiresAt,
      };
    },
    async peek(state) {
      return options.stateStore.peek(hashState(state));
    },
    async complete(input) {
      const pending = await options.stateStore.consume(hashState(input.state));
      if (!pending) throw new AccountingError("accounting_conflict", "QuickBooks Time OAuth state is invalid, expired, or already used");
      if (pending.actorId !== input.actorId) throw new AccountingError("accounting_conflict", "QuickBooks Time OAuth callback actor does not match the initiating session");
      if (pending.sessionBindingHash !== hashSession(input.sessionBinding)) throw new AccountingError("accounting_conflict", "QuickBooks Time OAuth callback session does not match the initiating session");
      if (input.providerError) throw new AccountingError("accounting_unavailable", "QuickBooks Time authorization was declined");
      if (!input.code || input.code.length > 8_000) throw new AccountingError("accounting_validation", "QuickBooks Time callback is missing an authorization code");
      const token = await options.oauth.exchangeCode({ clientId: options.clientId, clientSecret: options.clientSecret, redirectUri: options.redirectUri, code: input.code });
      if (!token.providerCompanyId || (pending.scope.providerCompanyId !== null && token.providerCompanyId !== pending.scope.providerCompanyId)) throw new AccountingError("accounting_conflict", "QuickBooks Time company identity could not be verified");
      const scope: TimeConnectionScope = timeConnectionScopeSchema.parse({ ...pending.scope, providerCompanyId: token.providerCompanyId });
      const saved = await options.tokenRepository.saveNewConnection(scope, token);
      return {
        scope,
        connection: {
          accessTokenExpiresAt: saved.accessTokenExpiresAt,
          ...(saved.refreshTokenExpiresAt ? { refreshTokenExpiresAt: saved.refreshTokenExpiresAt } : {}),
          version: saved.version,
        },
      };
    },
  };
}

export function hashTimeOAuthState(value: string): string { return hashState(value); }
export function hashTimeOAuthSession(value: string): string { return hashSession(value); }
