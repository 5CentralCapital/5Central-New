import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { buildQboCustomerPlan, type PlanCustomerLink, type PlanEntity, type PlanEntityPeriod, type PlanMirrorName, type PlanTenancy, type QboCustomerPlan } from "./qbo-customer-plan";

/*
 * Loads the QuickBooks customer plan inputs from 5Central Ops and the
 * verified mirror, then builds the plan. Read-only: it never calls
 * QuickBooks and never writes. Run it inside the caller's read-only,
 * authorized transaction.
 */

export interface QboCustomerPlanQuery {
  readonly organizationId: string;
  readonly environment: "sandbox" | "production";
  /** Business date (YYYY-MM-DD) that decides former tenants and open tenancies. */
  readonly asOf: string;
  /** Limit the result to one legal entity's group. */
  readonly legalEntityId?: string;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);

export async function readQboCustomerPlan(executor: RentOpsQueryExecutor, query: QboCustomerPlanQuery): Promise<QboCustomerPlan> {
  const { organizationId, environment, asOf } = query;
  const entityRows = await executor.query<{ id: unknown; name: unknown }>("SELECT id, name FROM company_legal_entities WHERE organization_id=$1 ORDER BY id", [organizationId]);
  const bindingRows = await executor.query<{ legal_entity_id: unknown; realm_id: unknown }>(
    "SELECT legal_entity_id, realm_id FROM accounting_qbo_realm_bindings WHERE organization_id=$1 AND environment=$2",
    [organizationId, environment],
  );
  const realmByEntity = new Map(bindingRows.rows.map(row => [String(row.legal_entity_id), String(row.realm_id)]));

  const periodRows = await executor.query<{ property_id: unknown; legal_entity_id: unknown; effective_from: unknown; effective_until: unknown }>(
    `SELECT property_id, legal_entity_id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_until, 'YYYY-MM-DD') AS effective_until
       FROM company_property_entity_periods WHERE organization_id=$1`,
    [organizationId],
  );
  const periods: PlanEntityPeriod[] = periodRows.rows.map(row => ({ propertyId: String(row.property_id), legalEntityId: String(row.legal_entity_id), from: String(row.effective_from), until: text(row.effective_until) }));

  // Tenancies on this organization's properties, plus those on properties no organization owns yet (shown as unassigned).
  const tenancyRows = await executor.query<Record<string, unknown>>(
    `SELECT t.id, t.status, t.source_id, t.property_id, p.name AS property_name, p.address_line1, u.unit_number, pe.first_name, pe.last_name,
            to_char(COALESCE(t.actual_move_in_on, t.planned_move_in_on, (t.created_at AT TIME ZONE 'America/New_York')::date), 'YYYY-MM-DD') AS start_on,
            to_char(COALESCE(t.actual_move_out_on, (t.ended_at AT TIME ZONE 'America/New_York')::date), 'YYYY-MM-DD') AS end_on
       FROM rent_ops_tenancies t
       LEFT JOIN rent_ops_properties p ON p.id = t.property_id
       LEFT JOIN rent_ops_units u ON u.id = t.unit_id
       LEFT JOIN rent_ops_people pe ON pe.id = t.primary_person_id
      WHERE EXISTS (SELECT 1 FROM company_property_entity_periods m WHERE m.property_id = t.property_id AND m.organization_id = $1)
         OR NOT EXISTS (SELECT 1 FROM company_property_entity_periods m WHERE m.property_id = t.property_id)
      ORDER BY t.id`,
    [organizationId],
  );
  const tenancies: PlanTenancy[] = tenancyRows.rows.map(row => ({
    tenancyId: String(row.id),
    sourceId: text(row.source_id),
    status: text(row.status),
    tenantName: [text(row.first_name), text(row.last_name)].filter(Boolean).join(" ") || null,
    propertyId: text(row.property_id),
    propertyName: text(row.property_name) ?? text(row.address_line1),
    unitNumber: text(row.unit_number),
    startOn: text(row.start_on),
    endOn: text(row.end_on),
  }));

  const linkRows = await executor.query<{ local_id: unknown; external_id: unknown; legal_entity_id: unknown; source_scope: unknown }>(
    `SELECT local_id, external_id, legal_entity_id, source_scope FROM company_external_identities
      WHERE organization_id=$1 AND provider='qbo' AND record_kind='Customer' AND local_kind='tenancy' AND source_scope LIKE $2`,
    [organizationId, `qbo:${environment}:%`],
  );
  const links: PlanCustomerLink[] = linkRows.rows.map(row => ({
    tenancyId: String(row.local_id), customerObjectId: String(row.external_id),
    legalEntityId: text(row.legal_entity_id), realmId: String(row.source_scope).split(":")[2] ?? "",
  }));

  const mirror = createQboAccountingMirrorStore(executor);
  const entities: PlanEntity[] = [];
  for (const row of entityRows.rows) {
    const legalEntityId = String(row.id);
    const realmId = realmByEntity.get(legalEntityId) ?? null;
    let names: PlanMirrorName[] = [];
    let mirrorRead = false;
    if (realmId) {
      const scope = { organizationId, legalEntityId, environment, realmId };
      const coverage = await mirror.readCoverage({ provider: "qbo", ...scope }, "customers");
      mirrorRead = coverage.status !== "unavailable";
      for (const kind of ["customers", "vendors", "employees"] as const) {
        const items = await mirror.listProviderMirrors(scope, kind);
        names = names.concat(items.map(item => ({ objectType: item.objectType as PlanMirrorName["objectType"], objectId: item.providerObjectId, displayName: item.displayName })));
      }
    }
    entities.push({ legalEntityId, name: text(row.name) ?? legalEntityId, realmId, mirrorRead, names });
  }

  const plan = buildQboCustomerPlan({ environment, asOf, tenancies, periods, entities, links });
  if (!query.legalEntityId) return plan;
  // One entity's view carries only that entity's rows, counts and digest.
  const group = plan.entities.find(item => item.legalEntityId === query.legalEntityId);
  if (!group) throw new AccountingError("accounting_not_found", "Legal entity was not found");
  return { ...plan, planSha256: group.planSha256, counts: group.counts, entities: [group] };
}
