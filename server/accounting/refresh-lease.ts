import { randomUUID } from "node:crypto";
import type { QuickBooksConnectionScope } from "../../shared/accounting/quickbooks";
import { financialSourceScopeKey, financialSourceScopeSchema } from "../../shared/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";

export interface QuickBooksRefreshLease {
  acquire(scope: QuickBooksConnectionScope, ownerId: string, ttlMs: number): Promise<boolean>;
  release(scope: QuickBooksConnectionScope, ownerId: string): Promise<void>;
}

function parsed(scope: QuickBooksConnectionScope) {
  return financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
}

function owner(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new AccountingError("accounting_validation", "QBO refresh lease owner is invalid");
  return value;
}

/** The lease is database-backed so separate workers coordinate refresh rotation. */
export class PostgresQuickBooksRefreshLease implements QuickBooksRefreshLease {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly now: () => Date = () => new Date()) {}

  async acquire(scope: QuickBooksConnectionScope, ownerId: string, ttlMs: number): Promise<boolean> {
    const p = parsed(scope);
    const leaseOwner = owner(ownerId);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) throw new AccountingError("accounting_validation", "QBO refresh lease TTL is invalid");
    const leaseUntil = new Date(this.now().getTime() + ttlMs).toISOString();
    const result = await this.executor.query(
      `INSERT INTO accounting_qbo_refresh_leases
        (organization_id, legal_entity_id, environment, realm_id, owner_id, lease_until, version)
       VALUES ($1,$2,$3,$4,$5,$6,1)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id)
       DO UPDATE SET owner_id = EXCLUDED.owner_id, lease_until = EXCLUDED.lease_until,
         version = accounting_qbo_refresh_leases.version + 1
       WHERE accounting_qbo_refresh_leases.lease_until <= $7
          OR accounting_qbo_refresh_leases.owner_id = $5
       RETURNING owner_id`,
      [p.organizationId, p.legalEntityId, p.environment, p.realmId, leaseOwner, leaseUntil, this.now().toISOString()],
    );
    return result.rows.length > 0;
  }

  async release(scope: QuickBooksConnectionScope, ownerId: string): Promise<void> {
    const p = parsed(scope);
    await this.executor.query(
      `DELETE FROM accounting_qbo_refresh_leases
        WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND owner_id = $5`,
      [p.organizationId, p.legalEntityId, p.environment, p.realmId, owner(ownerId)],
    );
  }
}

export function newQuickBooksRefreshLeaseOwner(prefix = "rops"): string {
  return `${prefix}:${randomUUID()}`;
}

export function refreshLeaseKey(scope: QuickBooksConnectionScope): string {
  return financialSourceScopeKey(parsed(scope));
}

