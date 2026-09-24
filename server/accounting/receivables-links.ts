import { randomUUID } from "node:crypto";
import { z } from "zod";
import { financialSourceScopeSchema, type FinancialSourceScope } from "../../shared/accounting";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";

/*
 * Links a 5Central Ops tenancy to the QuickBooks Customer (or sub-customer)
 * that carries its posted history. The link lives in the immutable external
 * identity map: one QuickBooks customer belongs to at most one tenancy (a
 * database constraint), and a tenancy may hold one customer per environment.
 * Renewals keep the tenancy and therefore the customer; a transfer to another
 * unit is a new tenancy and needs its own customer, so successive occupants
 * of a unit never share a history.
 */

const tenancyIdSchema = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const customerIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);

export interface TenancyCustomerLinkInput {
  readonly scope: FinancialSourceScope;
  readonly tenancyId: string;
  readonly customerObjectId: string;
}

export type TenancyCustomerLinkResult = { readonly status: "linked" | "already_linked"; readonly tenancyId: string; readonly customerObjectId: string };

/** Must run in the caller's transaction, after authorization for the scope's legal entity. */
export async function linkTenancyToQboCustomer(executor: RentOpsQueryExecutor, input: TenancyCustomerLinkInput): Promise<TenancyCustomerLinkResult> {
  const scope = financialSourceScopeSchema.parse(input.scope);
  const tenancyId = tenancyIdSchema.parse(input.tenancyId);
  const customerObjectId = customerIdSchema.parse(input.customerObjectId);
  const sourceScope = `qbo:${scope.environment}:${scope.realmId}`;

  const binding = await executor.query(
    `SELECT 1 FROM company_external_identities
      WHERE organization_id=$1 AND legal_entity_id=$2 AND provider='qbo' AND source_scope=$3 AND record_kind='CompanyInfo' AND local_kind='legal_entity'`,
    [scope.organizationId, scope.legalEntityId, sourceScope],
  );
  if (binding.rows.length === 0) throw new AccountingError("accounting_conflict", "This QuickBooks company is not bound to the legal entity");

  // Tenancy ids are globally unique in Rent Ops, so existence alone is not an
  // authorization boundary. A tenancy may be linked only when its property's
  // legal-entity assignment overlaps the tenancy interval. This mirrors the
  // customer-plan historical ownership policy: [effective_from,effective_until)
  // overlaps [start_on,max(end_on,start_on)].
  const tenancy = await executor.query(
    `WITH tenancy AS (
       SELECT id, property_id,
              COALESCE(actual_move_in_on, planned_move_in_on, (created_at AT TIME ZONE 'America/New_York')::date) AS start_on,
              COALESCE(actual_move_out_on, (ended_at AT TIME ZONE 'America/New_York')::date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date) AS end_on
         FROM rent_ops_tenancies
        WHERE id=$3
     )
     SELECT t.id
       FROM tenancy t
      WHERE EXISTS (
        SELECT 1
          FROM company_property_entity_periods m
         WHERE m.organization_id=$1 AND m.legal_entity_id=$2 AND m.property_id=t.property_id
           AND m.effective_from <= GREATEST(t.start_on, t.end_on)
           AND (m.effective_until IS NULL OR m.effective_until > t.start_on)
      )`,
    [scope.organizationId, scope.legalEntityId, tenancyId],
  );
  if (tenancy.rows.length === 0) throw new AccountingError("accounting_not_found", "Tenancy was not found");

  const customer = await executor.query<{ active: string | null }>(
    `SELECT provider_body->>'Active' AS active FROM accounting_qbo_source_objects
      WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND object_type='Customer' AND object_id=$5 AND deleted_at IS NULL
      ORDER BY provider_updated_at DESC NULLS LAST, received_at DESC LIMIT 1`,
    [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId, customerObjectId],
  );
  if (customer.rows.length === 0) throw new AccountingError("accounting_not_found", "The QuickBooks customer has not been mirrored; sync QuickBooks first");

  const existing = await executor.query<{ external_id: string; local_id: string; source_scope: string }>(
    `SELECT external_id, local_id, source_scope FROM company_external_identities
      WHERE organization_id=$1 AND provider='qbo' AND record_kind='Customer'
        AND ((source_scope=$2 AND external_id=$3) OR (local_kind='tenancy' AND local_id=$4 AND source_scope LIKE $5))`,
    [scope.organizationId, sourceScope, customerObjectId, tenancyId, `qbo:${scope.environment}:%`],
  );
  for (const row of existing.rows) {
    if (row.source_scope === sourceScope && row.external_id === customerObjectId && row.local_id === tenancyId) {
      return { status: "already_linked", tenancyId, customerObjectId };
    }
  }
  if (existing.rows.some(row => row.source_scope === sourceScope && row.external_id === customerObjectId)) {
    throw new AccountingError("accounting_conflict", "This QuickBooks customer is already linked to another tenancy");
  }
  if (existing.rows.some(row => row.local_id === tenancyId)) {
    throw new AccountingError("accounting_conflict", "This tenancy is already linked to a different QuickBooks customer in this environment");
  }
  const inserted = await executor.query(
    `INSERT INTO company_external_identities (id, organization_id, legal_entity_id, provider, source_scope, record_kind, external_id, local_kind, local_id)
     VALUES ($1,$2,$3,'qbo',$4,'Customer',$5,'tenancy',$6)
     ON CONFLICT (organization_id, provider, source_scope, record_kind, external_id) DO NOTHING RETURNING id`,
    [randomUUID(), scope.organizationId, scope.legalEntityId, sourceScope, customerObjectId, tenancyId],
  );
  if (inserted.rows.length === 0) throw new AccountingError("accounting_conflict", "This QuickBooks customer was linked concurrently; reload and check the mapping");
  return { status: "linked", tenancyId, customerObjectId };
}
