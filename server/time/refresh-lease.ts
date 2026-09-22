import { randomUUID } from "node:crypto";
import type { TimeConnectionScope } from "../../shared/time";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "../accounting/errors";

export interface TimeRefreshLease {
  acquire(scope: TimeConnectionScope, ownerId: string, ttlMs: number): Promise<boolean>;
  release(scope: TimeConnectionScope, ownerId: string): Promise<void>;
}

function owner(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new AccountingError("accounting_validation", "QuickBooks Time refresh lease owner is invalid");
  return value;
}

function scopeParts(scope: TimeConnectionScope): unknown[] {
  return [scope.organizationId, scope.legalEntityId, scope.environment, scope.providerCompanyId];
}

/** The lease is database-backed so separate workers coordinate refresh rotation. */
export class PostgresTimeRefreshLease implements TimeRefreshLease {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly now: () => Date = () => new Date()) {}

  async acquire(scope: TimeConnectionScope, ownerId: string, ttlMs: number): Promise<boolean> {
    const leaseOwner = owner(ownerId);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) throw new AccountingError("accounting_validation", "QuickBooks Time refresh lease TTL is invalid");
    const leaseUntil = new Date(this.now().getTime() + ttlMs).toISOString();
    const result = await this.executor.query(
      `INSERT INTO time_refresh_leases
        (organization_id, legal_entity_id, environment, provider_company_id, owner_id, lease_until, version)
       VALUES ($1,$2,$3,$4,$5,$6,1)
       ON CONFLICT (organization_id, legal_entity_id, environment, provider_company_id)
       DO UPDATE SET owner_id=EXCLUDED.owner_id, lease_until=EXCLUDED.lease_until,
         version=time_refresh_leases.version+1
       WHERE time_refresh_leases.lease_until <= $7
          OR time_refresh_leases.owner_id = $5
       RETURNING owner_id`,
      [...scopeParts(scope), leaseOwner, leaseUntil, this.now().toISOString()],
    );
    return result.rows.length > 0;
  }

  async release(scope: TimeConnectionScope, ownerId: string): Promise<void> {
    await this.executor.query(
      `DELETE FROM time_refresh_leases
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND provider_company_id=$4 AND owner_id=$5`,
      [...scopeParts(scope), owner(ownerId)],
    );
  }
}

export function newTimeRefreshLeaseOwner(prefix = "rops-time"): string {
  return `${prefix}:${randomUUID()}`;
}
