import type {
  QuickBooksConnectionScope,
  QuickBooksOAuthTokenSet,
  QuickBooksStoredToken,
  QuickBooksTokenRepository,
} from "../../shared/accounting/quickbooks";
import {
  financialSourceScopeSchema,
  type FinancialSourceEnvironment,
  type FinancialSourceScope,
} from "../../shared/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import type { EncryptedQboSecret, QboTokenCipher } from "./token-crypto";

interface QboConnectionRow {
  organization_id: unknown;
  legal_entity_id: unknown;
  environment: unknown;
  realm_id: unknown;
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
  version: unknown;
  updated_at: unknown;
}

export interface QuickBooksConnectionMetadata {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly environment: FinancialSourceEnvironment;
  readonly realmId: string;
  readonly version: number;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string | null;
  readonly intuitTid: string | null;
  readonly updatedAt: string;
}

export interface QuickBooksConnectionListFilter {
  readonly organizationId: string;
  readonly legalEntityId?: string;
  readonly environment?: FinancialSourceEnvironment;
}

function sourceScope(scope: QuickBooksConnectionScope): FinancialSourceScope {
  return financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
}

function text(value: unknown, field: string, max = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AccountingError("accounting_unavailable", `Stored QBO connection ${field} is invalid`);
  return value;
}

function nullableText(value: unknown, field: string, max = 16_384): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field, max);
}

function timestampText(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  return text(value, field, 80);
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AccountingError("accounting_unavailable", `Stored QBO connection ${field} is invalid`);
  return parsed;
}

function encrypted(row: QboConnectionRow, prefix: "access_token" | "refresh_token" | "id_token"): EncryptedQboSecret | null {
  const ciphertext = row[`encrypted_${prefix}`];
  const iv = row[`${prefix}_iv`];
  const authTag = row[`${prefix}_auth_tag`];
  if (ciphertext === null || ciphertext === undefined) return null;
  return { ciphertext: text(ciphertext, `${prefix} ciphertext`), iv: text(iv, `${prefix} iv`, 512), authTag: text(authTag, `${prefix} auth tag`, 512) };
}

function mapMetadata(row: QboConnectionRow): QuickBooksConnectionMetadata {
  const environment = financialSourceScopeSchema.shape.environment.parse(row.environment);
  return {
    organizationId: text(row.organization_id, "organization ID", 160),
    legalEntityId: text(row.legal_entity_id, "legal entity ID", 160),
    environment,
    realmId: text(row.realm_id, "realm ID", 32),
    version: integer(row.version, "version"),
    accessTokenExpiresAt: timestampText(row.access_token_expires_at, "access-token expiry"),
    refreshTokenExpiresAt: row.refresh_token_expires_at === null || row.refresh_token_expires_at === undefined ? null : timestampText(row.refresh_token_expires_at, "refresh-token expiry"),
    intuitTid: nullableText(row.intuit_tid, "Intuit trace ID", 255),
    updatedAt: timestampText(row.updated_at, "updatedAt"),
  };
}

function mapToken(row: QboConnectionRow, scope: QuickBooksConnectionScope, cipher: QboTokenCipher): QuickBooksStoredToken {
  const access = encrypted(row, "access_token");
  const refresh = encrypted(row, "refresh_token");
  if (!access || !refresh) throw new AccountingError("accounting_unavailable", "Stored QBO connection has no usable credentials");
  const source = sourceScope(scope);
  const accessToken = cipher.decrypt(source, access);
  const refreshToken = cipher.decrypt(source, refresh);
  const idTokenSecret = encrypted(row, "id_token");
  return {
    accessToken,
    refreshToken,
    tokenType: "bearer",
    accessTokenExpiresAt: timestampText(row.access_token_expires_at, "access-token expiry"),
    ...(row.refresh_token_expires_at !== null && row.refresh_token_expires_at !== undefined ? { refreshTokenExpiresAt: timestampText(row.refresh_token_expires_at, "refresh-token expiry") } : {}),
    ...(idTokenSecret ? { idToken: cipher.decrypt(source, idTokenSecret) } : {}),
    ...(nullableText(row.intuit_tid, "Intuit trace ID", 255) ? { intuitTid: nullableText(row.intuit_tid, "Intuit trace ID", 255)! } : {}),
    version: integer(row.version, "version"),
    updatedAt: timestampText(row.updated_at, "updatedAt"),
  };
}

const rowColumns = `organization_id, legal_entity_id, environment, realm_id,
  encrypted_access_token, access_token_iv, access_token_auth_tag,
  encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag,
  encrypted_id_token, id_token_iv, id_token_auth_tag,
  access_token_expires_at, refresh_token_expires_at, intuit_tid, version, updated_at`;

/** PostgreSQL-backed token repository. Secrets never enter JSON or log output. */
export class PostgresQuickBooksTokenRepository implements QuickBooksTokenRepository {
  constructor(
    private readonly executor: RentOpsQueryExecutor,
    private readonly cipher: QboTokenCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(scope: QuickBooksConnectionScope): Promise<QuickBooksStoredToken | null> {
    const parsed = sourceScope(scope);
    const result = await this.executor.query<QboConnectionRow>(
      `SELECT ${rowColumns} FROM accounting_qbo_connections
       WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND revoked_at IS NULL`,
      [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId],
    );
    const row = result.rows[0];
    return row ? mapToken(row, scope, this.cipher) : null;
  }

  async save(scope: QuickBooksConnectionScope, token: QuickBooksOAuthTokenSet, expectedVersion?: number): Promise<QuickBooksStoredToken> {
    return this.saveInternal(scope, token, expectedVersion, false);
  }

  async saveWithLease(scope: QuickBooksConnectionScope, token: QuickBooksOAuthTokenSet, expectedVersion: number, leaseOwnerId: string): Promise<QuickBooksStoredToken> {
    if (typeof leaseOwnerId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(leaseOwnerId)) throw new AccountingError("accounting_validation", "QBO refresh lease owner is invalid");
    return this.saveInternal(scope, token, expectedVersion, false, leaseOwnerId);
  }

  private async saveInternal(scope: QuickBooksConnectionScope, token: QuickBooksOAuthTokenSet, expectedVersion?: number, allowRevokedReconnect = false, leaseOwnerId?: string): Promise<QuickBooksStoredToken> {
    const parsed = sourceScope(scope);
    if (typeof token.accessToken !== "string" || token.accessToken.length === 0 || typeof token.refreshToken !== "string" || token.refreshToken.length === 0) {
      throw new AccountingError("accounting_validation", "QBO token set is invalid");
    }
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new AccountingError("accounting_validation", "QBO token version is invalid");
    }
    const access = this.cipher.encrypt(parsed, token.accessToken);
    const refresh = this.cipher.encrypt(parsed, token.refreshToken);
    const idToken = token.idToken ? this.cipher.encrypt(parsed, token.idToken) : null;
    const now = this.now().toISOString();
    const values: unknown[] = [
      parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId,
      access.ciphertext, access.iv, access.authTag,
      refresh.ciphertext, refresh.iv, refresh.authTag,
      idToken?.ciphertext ?? null, idToken?.iv ?? null, idToken?.authTag ?? null,
      token.accessTokenExpiresAt, token.refreshTokenExpiresAt ?? null, token.intuitTid ?? null,
      now,
    ];
    let result;
    try {
      if (expectedVersion !== undefined) {
        // Refresh rotation is an update-only compare-and-save. A missing row or
        // revoked row must never be inserted or resurrected by a stale worker.
        values.push(expectedVersion);
        if (leaseOwnerId) values.push(leaseOwnerId, this.now().toISOString());
        const leasePredicate = leaseOwnerId ? " AND EXISTS (SELECT 1 FROM accounting_qbo_refresh_leases lease WHERE lease.organization_id=$1 AND lease.legal_entity_id=$2 AND lease.environment=$3 AND lease.realm_id=$4 AND lease.owner_id=$19 AND lease.lease_until > $20)" : "";
        result = await this.executor.query<QboConnectionRow>(
        `UPDATE accounting_qbo_connections SET
          encrypted_access_token = $5, access_token_iv = $6, access_token_auth_tag = $7,
          encrypted_refresh_token = $8, refresh_token_iv = $9, refresh_token_auth_tag = $10,
          encrypted_id_token = $11, id_token_iv = $12, id_token_auth_tag = $13,
          access_token_expires_at = $14, refresh_token_expires_at = $15, intuit_tid = $16,
          version = version + 1, updated_at = $17${allowRevokedReconnect ? ", revoked_at = NULL" : ""}
         WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4
           AND version = $18${allowRevokedReconnect ? "" : " AND revoked_at IS NULL"}${leasePredicate}
         RETURNING ${rowColumns}`,
          values,
        );
      } else {
        // OAuth's initial save may replace an active row, but the active-row
        // predicate prevents an ordinary save from reviving a revoke.
        result = await this.executor.query<QboConnectionRow>(
        `INSERT INTO accounting_qbo_connections (
          organization_id, legal_entity_id, environment, realm_id,
          encrypted_access_token, access_token_iv, access_token_auth_tag,
          encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag,
          encrypted_id_token, id_token_iv, id_token_auth_tag,
          access_token_expires_at, refresh_token_expires_at, intuit_tid, version, updated_at, revoked_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17,NULL)
        ON CONFLICT (organization_id, legal_entity_id, environment, realm_id)
        DO UPDATE SET
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          access_token_iv = EXCLUDED.access_token_iv,
          access_token_auth_tag = EXCLUDED.access_token_auth_tag,
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          refresh_token_iv = EXCLUDED.refresh_token_iv,
          refresh_token_auth_tag = EXCLUDED.refresh_token_auth_tag,
          encrypted_id_token = EXCLUDED.encrypted_id_token,
          id_token_iv = EXCLUDED.id_token_iv,
          id_token_auth_tag = EXCLUDED.id_token_auth_tag,
          access_token_expires_at = EXCLUDED.access_token_expires_at,
          refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
          intuit_tid = EXCLUDED.intuit_tid,
          version = accounting_qbo_connections.version + 1,
          updated_at = EXCLUDED.updated_at
        WHERE accounting_qbo_connections.revoked_at IS NULL
        RETURNING ${rowColumns}`,
          values,
        );
      }
    } catch (error) {
      if (error instanceof AccountingError) throw error;
      throw new AccountingError("accounting_conflict", "QBO connection could not be saved because its identity is already bound");
    }
    const row = result.rows[0];
    if (!row) throw new AccountingError("accounting_conflict", "QBO connection changed during token rotation");
    return mapToken(row, scope, this.cipher);
  }

  async saveNewConnection(scope: QuickBooksConnectionScope, token: QuickBooksOAuthTokenSet): Promise<QuickBooksStoredToken> {
    const parsed = sourceScope(scope);
    const revoked = await this.executor.query<{ version: unknown }>(
      `SELECT version FROM accounting_qbo_connections
       WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND revoked_at IS NOT NULL`,
      [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId],
    );
    if (revoked.rows[0]) {
      const expected = integer(revoked.rows[0].version, "version");
      return this.saveInternal(scope, token, expected, true);
    }
    return this.save(scope, token);
  }

  async revoke(scope: QuickBooksConnectionScope): Promise<void> {
    const parsed = sourceScope(scope);
    await this.executor.query(
      `UPDATE accounting_qbo_connections
          SET revoked_at = $5,
              encrypted_access_token = NULL, access_token_iv = NULL, access_token_auth_tag = NULL,
              encrypted_refresh_token = NULL, refresh_token_iv = NULL, refresh_token_auth_tag = NULL,
              encrypted_id_token = NULL, id_token_iv = NULL, id_token_auth_tag = NULL,
              version = version + 1, updated_at = $5
        WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND revoked_at IS NULL`,
      [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId, this.now().toISOString()],
    );
  }

  async readMetadata(scope: QuickBooksConnectionScope): Promise<QuickBooksConnectionMetadata | null> {
    const parsed = sourceScope(scope);
    const result = await this.executor.query<QboConnectionRow>(
      `SELECT ${rowColumns} FROM accounting_qbo_connections
       WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND revoked_at IS NULL`,
      [parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId],
    );
    const row = result.rows[0];
    return row ? mapMetadata(row) : null;
  }

  /** Returns safe connection metadata only; encrypted credentials never leave
   * the repository and revoked rows are intentionally omitted. */
  async listMetadata(filter: QuickBooksConnectionListFilter): Promise<readonly QuickBooksConnectionMetadata[]> {
    if (typeof filter.organizationId !== "string" || filter.organizationId.length === 0) throw new AccountingError("accounting_validation", "QBO organization ID is invalid");
    const values: unknown[] = [filter.organizationId];
    const clauses = ["organization_id=$1", "revoked_at IS NULL"];
    if (filter.legalEntityId !== undefined) { values.push(filter.legalEntityId); clauses.push(`legal_entity_id=$${values.length}`); }
    if (filter.environment !== undefined) { values.push(financialSourceScopeSchema.shape.environment.parse(filter.environment)); clauses.push(`environment=$${values.length}`); }
    const result = await this.executor.query<QboConnectionRow>(
      `SELECT ${rowColumns} FROM accounting_qbo_connections WHERE ${clauses.join(" AND ")} ORDER BY legal_entity_id, environment, realm_id`,
      values,
    );
    return result.rows.map(mapMetadata);
  }
}

export function createQuickBooksTokenRepository(executor: RentOpsQueryExecutor, cipher: QboTokenCipher): PostgresQuickBooksTokenRepository {
  return new PostgresQuickBooksTokenRepository(executor, cipher);
}
