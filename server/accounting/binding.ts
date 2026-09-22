import { randomUUID } from "node:crypto";
import type { QuickBooksConnectionScope, QuickBooksOAuthTokenSet } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema, type FinancialSourceEnvironment } from "../../shared/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { AccountingError } from "./errors";
import type { EncryptedQboSecret, QboTokenCipher } from "./token-crypto";

export interface QuickBooksRealmBindingProof {
  readonly providerCompanyId: string;
  readonly providerCompanyName: string | null;
  readonly providerLegalName: string | null;
  readonly homeCurrency: string | null;
  readonly evidenceVersion: string;
  readonly companyInfoHash: string;
  readonly existingBinding: boolean;
}

export interface PendingQuickBooksBinding {
  readonly pendingId: string;
  readonly actorId: string;
  readonly sessionBindingHash: string | null;
  readonly scope: QuickBooksConnectionScope;
  readonly proof: QuickBooksRealmBindingProof;
  readonly token: QuickBooksOAuthTokenSet;
  readonly expiresAt: string;
}

export interface QuickBooksPendingBindingPreview {
  readonly pendingId: string;
  readonly scope: QuickBooksConnectionScope;
  readonly proof: QuickBooksRealmBindingProof;
  readonly expiresAt: string;
}

export interface QuickBooksPendingBindingStore {
  create(input: {
    readonly actorId: string;
    readonly sessionBindingHash: string | null;
    readonly scope: QuickBooksConnectionScope;
    readonly proof: QuickBooksRealmBindingProof;
    readonly token: QuickBooksOAuthTokenSet;
    readonly expiresAt: string;
  }): Promise<{ readonly pendingId: string; readonly expiresAt: string }>;
  consume(pendingId: string, actorId: string, sessionBindingHash: string | null, expectedScope?: Pick<QuickBooksConnectionScope, "organizationId" | "legalEntityId">): Promise<PendingQuickBooksBinding | null>;
  preview?(pendingId: string, actorId: string, sessionBindingHash: string | null, expectedScope?: Pick<QuickBooksConnectionScope, "organizationId" | "legalEntityId">): Promise<QuickBooksPendingBindingPreview | null>;
  /**
   * Lock an unexpired pending handoff, perform the binding/token write in the
   * same transaction, and consume the handoff only after that work succeeds.
   * A failed action rolls back and leaves the encrypted handoff retryable.
   */
  confirm?(pendingId: string, actorId: string, sessionBindingHash: string | null, expectedScope: Pick<QuickBooksConnectionScope, "organizationId" | "legalEntityId"> | undefined, work: (pending: PendingQuickBooksBinding, executor: RentOpsQueryExecutor) => Promise<void>): Promise<PendingQuickBooksBinding | null>;
}

interface PendingBindingRow {
  pending_id: unknown;
  actor_id: unknown;
  session_binding_hash: unknown;
  organization_id: unknown;
  legal_entity_id: unknown;
  environment: unknown;
  realm_id: unknown;
  provider_company_id: unknown;
  provider_company_name: unknown;
  provider_legal_name: unknown;
  home_currency: unknown;
  evidence_version: unknown;
  company_info_hash: unknown;
  encrypted_access_token: unknown;
  access_token_iv: unknown;
  access_token_auth_tag: unknown;
  encrypted_refresh_token: unknown;
  refresh_token_iv: unknown;
  refresh_token_auth_tag: unknown;
  encrypted_id_token: unknown;
  id_token_iv: unknown;
  id_token_auth_tag: unknown;
  access_token_expires_at: unknown;
  refresh_token_expires_at: unknown;
  intuit_tid: unknown;
  expires_at: unknown;
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AccountingError("accounting_unavailable", `Stored pending QBO binding ${field} is invalid`);
  return value;
}

function optionalText(value: unknown, field: string, max = 512): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field, max);
}

function timestamp(value: unknown, field: string): string {
  return value instanceof Date ? value.toISOString() : text(value, field, 80);
}

function encrypted(row: PendingBindingRow, prefix: "access_token" | "refresh_token" | "id_token"): EncryptedQboSecret | null {
  const ciphertext = row[`encrypted_${prefix}`];
  if (ciphertext === null || ciphertext === undefined) return null;
  return {
    ciphertext: text(ciphertext, `${prefix} ciphertext`, 16_384),
    iv: text(row[`${prefix}_iv`], `${prefix} iv`, 512),
    authTag: text(row[`${prefix}_auth_tag`], `${prefix} auth tag`, 512),
  };
}

function mapPending(row: PendingBindingRow, cipher: QboTokenCipher): PendingQuickBooksBinding {
  const scope = financialSourceScopeSchema.parse({ provider: "qbo", organizationId: row.organization_id, legalEntityId: row.legal_entity_id, environment: row.environment, realmId: row.realm_id });
  const access = encrypted(row, "access_token");
  const refresh = encrypted(row, "refresh_token");
  if (!access || !refresh) throw new AccountingError("accounting_unavailable", "Pending QBO binding has no usable credentials");
  const idToken = encrypted(row, "id_token");
  const token: QuickBooksOAuthTokenSet = {
    accessToken: cipher.decrypt(scope, access),
    refreshToken: cipher.decrypt(scope, refresh),
    tokenType: "bearer",
    accessTokenExpiresAt: timestamp(row.access_token_expires_at, "access-token expiry"),
    ...(row.refresh_token_expires_at === null || row.refresh_token_expires_at === undefined ? {} : { refreshTokenExpiresAt: timestamp(row.refresh_token_expires_at, "refresh-token expiry") }),
    ...(idToken ? { idToken: cipher.decrypt(scope, idToken) } : {}),
    ...(row.intuit_tid === null || row.intuit_tid === undefined ? {} : { intuitTid: text(row.intuit_tid, "Intuit trace ID", 255) }),
  };
  return {
    pendingId: text(row.pending_id, "pending ID", 80),
    actorId: text(row.actor_id, "actor ID", 160),
    sessionBindingHash: optionalText(row.session_binding_hash, "session binding hash", 128),
    scope,
    proof: {
      providerCompanyId: text(row.provider_company_id, "provider company ID", 255),
      providerCompanyName: optionalText(row.provider_company_name, "provider company name", 255),
      providerLegalName: optionalText(row.provider_legal_name, "provider legal name", 255),
      homeCurrency: optionalText(row.home_currency, "home currency", 3),
      evidenceVersion: text(row.evidence_version, "evidence version", 255),
      companyInfoHash: text(row.company_info_hash, "CompanyInfo hash", 64),
      existingBinding: false,
    },
    token,
    expiresAt: timestamp(row.expires_at, "expiry"),
  };
}

function mapPreview(row: Pick<PendingBindingRow, "pending_id" | "organization_id" | "legal_entity_id" | "environment" | "realm_id" | "provider_company_id" | "provider_company_name" | "provider_legal_name" | "home_currency" | "evidence_version" | "company_info_hash" | "expires_at">): QuickBooksPendingBindingPreview {
  const scope = financialSourceScopeSchema.parse({ provider: "qbo", organizationId: row.organization_id, legalEntityId: row.legal_entity_id, environment: row.environment, realmId: row.realm_id });
  return {
    pendingId: text(row.pending_id, "pending ID", 80),
    scope,
    proof: {
      providerCompanyId: text(row.provider_company_id, "provider company ID", 255),
      providerCompanyName: optionalText(row.provider_company_name, "provider company name", 255),
      providerLegalName: optionalText(row.provider_legal_name, "provider legal name", 255),
      homeCurrency: optionalText(row.home_currency, "home currency", 3),
      evidenceVersion: text(row.evidence_version, "evidence version", 255),
      companyInfoHash: text(row.company_info_hash, "CompanyInfo hash", 64),
      existingBinding: false,
    },
    expiresAt: timestamp(row.expires_at, "expiry"),
  };
}

const columns = `pending_id, actor_id, session_binding_hash, organization_id, legal_entity_id, environment, realm_id,
  provider_company_id, provider_company_name, provider_legal_name, home_currency, evidence_version, company_info_hash,
  encrypted_access_token, access_token_iv, access_token_auth_tag,
  encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag,
  encrypted_id_token, id_token_iv, id_token_auth_tag,
  access_token_expires_at, refresh_token_expires_at, intuit_tid, expires_at`;

/** Durable, encrypted handoff between OAuth callback and administrator binding confirmation. */
export class PostgresQuickBooksPendingBindingStore implements QuickBooksPendingBindingStore {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly cipher: QboTokenCipher) {}

  async create(input: { readonly actorId: string; readonly sessionBindingHash: string | null; readonly scope: QuickBooksConnectionScope; readonly proof: QuickBooksRealmBindingProof; readonly token: QuickBooksOAuthTokenSet; readonly expiresAt: string }): Promise<{ readonly pendingId: string; readonly expiresAt: string }> {
    const scope = financialSourceScopeSchema.parse({ provider: "qbo", ...input.scope });
    const pendingId = randomUUID();
    const access = this.cipher.encrypt(scope, input.token.accessToken);
    const refresh = this.cipher.encrypt(scope, input.token.refreshToken);
    const idToken = input.token.idToken ? this.cipher.encrypt(scope, input.token.idToken) : null;
    await this.executor.query(
      `INSERT INTO accounting_qbo_pending_bindings
        (${columns})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [pendingId, input.actorId, input.sessionBindingHash, scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId,
        input.proof.providerCompanyId, input.proof.providerCompanyName, input.proof.providerLegalName, input.proof.homeCurrency, input.proof.evidenceVersion, input.proof.companyInfoHash,
        access.ciphertext, access.iv, access.authTag, refresh.ciphertext, refresh.iv, refresh.authTag, idToken?.ciphertext ?? null, idToken?.iv ?? null, idToken?.authTag ?? null,
        input.token.accessTokenExpiresAt, input.token.refreshTokenExpiresAt ?? null, input.token.intuitTid ?? null, input.expiresAt],
    );
    return { pendingId, expiresAt: input.expiresAt };
  }

  async consume(pendingId: string, actorId: string, sessionBindingHash: string | null, expectedScope?: Pick<QuickBooksConnectionScope, "organizationId" | "legalEntityId">): Promise<PendingQuickBooksBinding | null> {
    if (!/^[0-9a-f-]{36}$/.test(pendingId)) throw new AccountingError("accounting_validation", "Pending QuickBooks binding ID is invalid");
    const scope = expectedScope ? financialSourceScopeSchema.pick({ organizationId: true, legalEntityId: true }).parse(expectedScope) : null;
    const result = await this.executor.query<PendingBindingRow>(
      `UPDATE accounting_qbo_pending_bindings
          SET consumed_at=now(), confirmed_at=now(), confirmed_by=$2
        WHERE pending_id=$1 AND actor_id=$2 AND (session_binding_hash IS NOT DISTINCT FROM $3)
          AND ($4::uuid IS NULL OR organization_id=$4) AND ($5::uuid IS NULL OR legal_entity_id=$5)
          AND consumed_at IS NULL AND expires_at > now()
      RETURNING ${columns}`,
      [pendingId, actorId, sessionBindingHash, scope?.organizationId ?? null, scope?.legalEntityId ?? null],
    );
    const row = result.rows[0];
    return row ? mapPending(row, this.cipher) : null;
  }

  /** Read only safe CompanyInfo metadata for the confirmation screen. */
  async preview(pendingId: string, actorId: string, sessionBindingHash: string | null, expectedScope?: Pick<QuickBooksConnectionScope, "organizationId" | "legalEntityId">): Promise<QuickBooksPendingBindingPreview | null> {
    if (!/^[0-9a-f-]{36}$/.test(pendingId)) throw new AccountingError("accounting_validation", "Pending QuickBooks binding ID is invalid");
    const scope = expectedScope ? financialSourceScopeSchema.pick({ organizationId: true, legalEntityId: true }).parse(expectedScope) : null;
    const result = await this.executor.query<Pick<PendingBindingRow, "pending_id" | "organization_id" | "legal_entity_id" | "environment" | "realm_id" | "provider_company_id" | "provider_company_name" | "provider_legal_name" | "home_currency" | "evidence_version" | "company_info_hash" | "expires_at">>(
      `SELECT pending_id, organization_id, legal_entity_id, environment, realm_id,
              provider_company_id, provider_company_name, provider_legal_name,
              home_currency, evidence_version, company_info_hash, expires_at
         FROM accounting_qbo_pending_bindings
        WHERE pending_id=$1 AND actor_id=$2 AND (session_binding_hash IS NOT DISTINCT FROM $3)
          AND ($4::uuid IS NULL OR organization_id=$4) AND ($5::uuid IS NULL OR legal_entity_id=$5)
          AND consumed_at IS NULL AND expires_at > now()`,
      [pendingId, actorId, sessionBindingHash, scope?.organizationId ?? null, scope?.legalEntityId ?? null],
    );
    const row = result.rows[0];
    return row ? mapPreview(row) : null;
  }

  async confirm(
    pendingId: string,
    actorId: string,
    sessionBindingHash: string | null,
    expectedScope: Pick<QuickBooksConnectionScope, "organizationId" | "legalEntityId"> | undefined,
    work: (pending: PendingQuickBooksBinding, executor: RentOpsQueryExecutor) => Promise<void>,
  ): Promise<PendingQuickBooksBinding | null> {
    if (!/^[0-9a-f-]{36}$/.test(pendingId)) throw new AccountingError("accounting_validation", "Pending QuickBooks binding ID is invalid");
    if (!this.executor.transaction) throw new AccountingError("accounting_configuration", "QuickBooks binding confirmation requires an atomic company database transaction");
    const scope = expectedScope ? financialSourceScopeSchema.pick({ organizationId: true, legalEntityId: true }).parse(expectedScope) : null;
    return this.executor.transaction(async transaction => {
      const result = await transaction.query<PendingBindingRow>(
        `SELECT ${columns}
           FROM accounting_qbo_pending_bindings
          WHERE pending_id=$1 AND actor_id=$2 AND (session_binding_hash IS NOT DISTINCT FROM $3)
            AND ($4::uuid IS NULL OR organization_id=$4) AND ($5::uuid IS NULL OR legal_entity_id=$5)
            AND consumed_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [pendingId, actorId, sessionBindingHash, scope?.organizationId ?? null, scope?.legalEntityId ?? null],
      );
      const row = result.rows[0];
      if (!row) return null;
      const pending = mapPending(row, this.cipher);
      await work(pending, transaction);
      const consumed = await transaction.query<{ pending_id: unknown }>(
        `UPDATE accounting_qbo_pending_bindings
            SET consumed_at=now(), confirmed_at=now(), confirmed_by=$2
          WHERE pending_id=$1 AND actor_id=$2 AND consumed_at IS NULL
        RETURNING pending_id`,
        [pendingId, actorId],
      );
      if (consumed.rows.length !== 1) throw new AccountingError("accounting_conflict", "QuickBooks binding confirmation was consumed by another request");
      return pending;
    }, { readOnly: false });
  }
}

export function companyInfoHash(body: Record<string, unknown>): string {
  return canonicalJsonSha256(body);
}

export type QuickBooksBindingEnvironment = FinancialSourceEnvironment;
