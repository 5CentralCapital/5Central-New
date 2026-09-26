import { z } from "zod";
import {
  financialSourceEnvironmentSchema,
  financialSourceScopeSchema,
  type FinancialSourceEnvironment,
} from "../../shared/accounting";
import {
  tenantSourceResolutionSchema,
  type TenantSourceResolution,
} from "../../shared/accounting/tenant-source-resolution";
import { isoDateSchema } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";

const tenancyIdSchema = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);

export interface TenantSourceResolutionQuery {
  readonly organizationId: string;
  readonly tenancyId: string;
  readonly environment: FinancialSourceEnvironment;
  readonly asOf: string;
}

interface TenancyRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly property_id: unknown;
  readonly property_name: unknown;
  readonly unit_id: unknown;
  readonly start_on: unknown;
  readonly end_on: unknown;
  readonly ledger_entry_count: unknown;
}

interface PeriodRow {
  readonly id: unknown;
  readonly legal_entity_id: unknown;
  readonly legal_entity_name: unknown;
  readonly effective_from: unknown;
  readonly effective_until: unknown;
}

interface BindingRow {
  readonly realm_id: unknown;
  readonly provider_company_name: unknown;
}

interface ConnectionRow {
  readonly realm_id: unknown;
  readonly status: unknown;
  readonly revoked_at: unknown;
  readonly updated_at: unknown;
  readonly read_capability_enabled: unknown;
}

interface CustomerLinkRow {
  readonly external_id: unknown;
  readonly legal_entity_id: unknown;
}

export interface TenancyHistoryPeriod {
  readonly legalEntityId: string;
  readonly legalEntityName: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly overlapsTenancy: boolean;
}

/**
 * The tenancy interval and its historical property ownership, without any
 * QuickBooks lookup. Receivable reads and link writes use this same result so
 * a source cannot be selected for an interval different from the one shown to
 * the user.
 */
export interface TenancyHistoryResolution {
  readonly tenancy: {
    readonly status: string | null;
    readonly propertyId: string;
    readonly unitId: string;
    readonly startOn: string | null;
    readonly endOn: string | null;
  };
  readonly propertyName: string | null;
  readonly ledgerEntryCount: number;
  readonly periods: readonly TenancyHistoryPeriod[];
  readonly ownerIds: readonly string[];
  readonly coverageComplete: boolean;
  readonly effectiveLegalEntityId: string | null;
  readonly effectiveLegalEntityName: string | null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const result = String(value).trim();
  return result.length > 0 ? result : null;
}

function dateText(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  return valueText.slice(0, 10);
}

function date(value: unknown): string {
  return isoDateSchema.parse(dateText(value));
}

function optionalDate(value: unknown): string | null {
  const valueText = dateText(value);
  return valueText === null ? null : isoDateSchema.parse(valueText);
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function timestamp(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  const parsed = new Date(valueText);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function connectionState(status: unknown, revokedAt: unknown): "active" | "needs_reconnect" | "revoked" {
  if (text(status) === "active" && revokedAt === null) return "active";
  if (text(status) === "needs_reconnect") return "needs_reconnect";
  return "revoked";
}

function intervalEnd(startOn: string, endOn: string | null, asOf: string, status: string | null): string | null {
  // An explicitly active tenancy is open through the requested as-of date,
  // including a holdover whose last signed lease has expired. Historical or
  // unknown statuses need an evidenced termination/lease end; using as-of for
  // them would invent ongoing occupancy from an import snapshot.
  const end = endOn ?? (status === "current" || status === "notice" || status === "future" ? asOf : null);
  if (end === null) return null;
  return end < startOn ? startOn : end;
}

/** Business date used when a caller does not supply an explicit as-of date. */
export function currentBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map(part => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function coverageComplete(
  periods: readonly { effectiveFrom: string; effectiveUntil: string | null; overlapsTenancy: boolean }[],
  startOn: string | null,
  endOn: string | null,
): boolean {
  if (startOn === null || endOn === null) return false;
  const relevant = periods.filter(period => period.overlapsTenancy).sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  if (relevant.length === 0) return false;
  let coveredThrough = startOn;
  for (const period of relevant) {
    if (period.effectiveFrom > coveredThrough) return false;
    // An open-ended ownership period covers the remainder of the interval.
    // Comparing it to the finite as-of date would otherwise make every
    // current tenancy look only partially covered.
    if (period.effectiveUntil === null) return true;
    if (period.effectiveUntil > coveredThrough) {
      coveredThrough = period.effectiveUntil;
      if (coveredThrough > endOn) return true;
    }
  }
  return coveredThrough > endOn;
}

function overlaps(period: { effectiveFrom: string; effectiveUntil: string | null }, startOn: string, endOn: string): boolean {
  return period.effectiveFrom <= endOn && (period.effectiveUntil === null || period.effectiveUntil > startOn);
}

/** Resolve one tenancy's historical interval and property ownership. */
export async function resolveTenancyHistory(
  executor: RentOpsQueryExecutor,
  input: { readonly organizationId: string; readonly tenancyId: string; readonly asOf: string },
): Promise<TenancyHistoryResolution | null> {
  const organizationId = input.organizationId;
  const tenancyId = tenancyIdSchema.parse(input.tenancyId);
  const asOf = isoDateSchema.parse(input.asOf);

  // A tenancy has no organization column. The historical company property
  // mapping is the boundary that proves this tenancy belongs to the company.
  const tenancyResult = await executor.query<TenancyRow>(
    `SELECT t.id, t.status, t.property_id, p.name AS property_name, t.unit_id,
            to_char(COALESCE(t.actual_move_in_on, t.planned_move_in_on, lease_dates.first_start_on), 'YYYY-MM-DD') AS start_on,
            to_char(CASE WHEN t.status IN ('current', 'notice', 'future')
              AND t.actual_move_out_on IS NULL AND t.ended_at IS NULL THEN NULL
              ELSE COALESCE(t.actual_move_out_on,
                (t.ended_at AT TIME ZONE 'America/New_York')::date, lease_dates.last_end_on)
              END, 'YYYY-MM-DD') AS end_on,
            (SELECT COUNT(*)::int FROM rent_ops_ledger_transactions l WHERE l.tenancy_id=t.id) AS ledger_entry_count
       FROM rent_ops_tenancies t
       JOIN rent_ops_properties p ON p.id=t.property_id
       LEFT JOIN LATERAL (
         SELECT MIN(l.contract_start_on) AS first_start_on, MAX(l.contract_end_on) AS last_end_on
           FROM rent_ops_lease_terms l
          WHERE l.tenancy_id=t.id AND l.status IS DISTINCT FROM 'cancelled'
       ) lease_dates ON true
      WHERE t.id=$2
        AND EXISTS (
          SELECT 1 FROM company_property_entity_periods mapped
           WHERE mapped.organization_id=$1 AND mapped.property_id=t.property_id
        )
      LIMIT 1`,
    [organizationId, tenancyId],
  );
  const tenancy = tenancyResult.rows[0];
  if (!tenancy) return null;

  const startOn = optionalDate(tenancy.start_on);
  const endOn = optionalDate(tenancy.end_on);
  const propertyId = text(tenancy.property_id);
  const unitId = text(tenancy.unit_id);
  const status = text(tenancy.status);
  const intervalThrough = startOn === null ? null : intervalEnd(startOn, endOn, asOf, status);
  const propertyName = text(tenancy.property_name);
  if (!propertyId || !unitId) throw new AccountingError("accounting_unavailable", "The tenancy source record is incomplete");

  const periodResult = await executor.query<PeriodRow>(
    `SELECT m.id, m.legal_entity_id, e.name AS legal_entity_name,
            m.effective_from::text AS effective_from, m.effective_until::text AS effective_until
       FROM company_property_entity_periods m
       JOIN company_legal_entities e ON e.organization_id=m.organization_id AND e.id=m.legal_entity_id
      WHERE m.organization_id=$1 AND m.property_id=$2
      ORDER BY m.effective_from, m.id`,
    [organizationId, propertyId],
  );
  const periods: TenancyHistoryPeriod[] = periodResult.rows.map(row => {
    const effectiveFrom = date(row.effective_from);
    const effectiveUntil = optionalDate(row.effective_until);
    return {
      legalEntityId: String(row.legal_entity_id),
      legalEntityName: text(row.legal_entity_name) ?? String(row.legal_entity_id),
      effectiveFrom,
      effectiveUntil,
      overlapsTenancy: intervalThrough !== null && overlaps({ effectiveFrom, effectiveUntil }, startOn!, intervalThrough),
    };
  });
  const overlappingPeriods = periods.filter(period => period.overlapsTenancy);
  const ownerIds = Array.from(new Set(overlappingPeriods.map(period => period.legalEntityId)));
  const completeCoverage = coverageComplete(periods, startOn, intervalThrough);
  const ownershipResolved = ownerIds.length === 1 && completeCoverage;
  const effectiveLegalEntityId = ownershipResolved ? ownerIds[0]! : null;
  const effectiveOwner = ownershipResolved ? overlappingPeriods.find(period => period.legalEntityId === effectiveLegalEntityId) : undefined;

  return {
    tenancy: { status, propertyId, unitId, startOn, endOn },
    propertyName,
    ledgerEntryCount: count(tenancy.ledger_entry_count),
    periods: overlappingPeriods,
    ownerIds,
    coverageComplete: completeCoverage,
    effectiveLegalEntityId,
    effectiveLegalEntityName: effectiveOwner?.legalEntityName ?? null,
  };
}

/**
 * Resolve one tenancy's source scope. All queries are bounded by the supplied
 * tenancy and its property; this intentionally does not load a customer plan
 * or any other tenancy. The function is read-only and never calls QuickBooks.
 */
export async function resolveTenancySource(
  executor: RentOpsQueryExecutor,
  input: TenantSourceResolutionQuery,
): Promise<TenantSourceResolution | null> {
  const organizationId = input.organizationId;
  const tenancyId = tenancyIdSchema.parse(input.tenancyId);
  const environment = financialSourceEnvironmentSchema.parse(input.environment);
  const asOf = isoDateSchema.parse(input.asOf);
  const history = await resolveTenancyHistory(executor, { organizationId, tenancyId, asOf });
  if (!history) return null;
  const { tenancy, propertyName, periods: overlappingPeriods, ownerIds, coverageComplete: completeCoverage } = history;
  const { status, propertyId, unitId, startOn, endOn } = tenancy;
  const ownershipResolved = history.effectiveLegalEntityId !== null;
  const effectiveLegalEntityId = history.effectiveLegalEntityId;

  let binding: BindingRow | null = null;
  let connection: ConnectionRow | null = null;
  let customerLink: CustomerLinkRow | null = null;
  if (effectiveLegalEntityId) {
    const bindingResult = await executor.query<BindingRow>(
      `SELECT realm_id, provider_company_name
         FROM accounting_qbo_realm_bindings
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3
        LIMIT 1`,
      [organizationId, effectiveLegalEntityId, environment],
    );
    binding = bindingResult.rows[0] ?? null;

    const connectionResult = await executor.query<ConnectionRow>(
      `SELECT c.realm_id, c.status, c.revoked_at, c.updated_at,
              EXISTS (
                SELECT 1 FROM accounting_qbo_capabilities cap
                 WHERE cap.organization_id=c.organization_id AND cap.legal_entity_id=c.legal_entity_id
                   AND cap.environment=c.environment AND cap.realm_id=c.realm_id
                   AND cap.capability='accounting.read' AND cap.enabled=true
                   AND cap.evidence='live_provider_readback'
              ) AS read_capability_enabled
         FROM accounting_qbo_connections c
        WHERE c.organization_id=$1 AND c.legal_entity_id=$2 AND c.environment=$3
        ORDER BY (c.status='active' AND c.revoked_at IS NULL) DESC, c.updated_at DESC, c.realm_id
        LIMIT 1`,
      [organizationId, effectiveLegalEntityId, environment],
    );
    connection = connectionResult.rows[0] ?? null;

    if (binding) {
      const linkResult = await executor.query<CustomerLinkRow>(
        `SELECT external_id, legal_entity_id
           FROM company_external_identities
          WHERE organization_id=$1 AND provider='qbo' AND record_kind='Customer' AND local_kind='tenancy'
            AND local_id=$2 AND source_scope=$3
          ORDER BY created_at, id`,
        [organizationId, tenancyId, `qbo:${environment}:${String(binding.realm_id)}`],
      );
      if (linkResult.rows.length > 1) {
        throw new AccountingError("accounting_conflict", "This tenancy is linked to more than one QuickBooks customer in the resolved company");
      }
      customerLink = linkResult.rows[0] ?? null;
    }
  }

  const bindingRealmId = binding ? String(binding.realm_id) : null;
  const connectionRealmId = connection ? String(connection.realm_id) : null;
  const activeBindingConnection = Boolean(
    bindingRealmId && connectionRealmId === bindingRealmId
      && text(connection?.status) === "active" && connection?.revoked_at === null,
  );
  const linkMatchesOwner = Boolean(customerLink && String(customerLink.legal_entity_id) === effectiveLegalEntityId);
  const ownershipReview = !ownershipResolved || (customerLink !== null && !linkMatchesOwner);

  let qboState: "linked" | "unlinked" | "not_connected" | "ownership_review";
  if (ownershipReview) qboState = "ownership_review";
  else if (!activeBindingConnection) qboState = "not_connected";
  else qboState = linkMatchesOwner ? "linked" : "unlinked";

  const ledgerEntryCount = history.ledgerEntryCount;
  const localState = ledgerEntryCount > 0 ? "local_history_available" : "local_history_unavailable";
  const currentState = qboState === "ownership_review"
    ? "ownership_review"
    : qboState === "linked" || qboState === "unlinked"
      ? qboState
      : localState === "local_history_available" ? "local_history_available" : "not_connected";

  const reasons: string[] = [];
  if (startOn === null) reasons.push("The tenancy has no verified move-in or lease start date; review the historical interval before selecting a QuickBooks company.");
  else if (endOn === null && status !== "current" && status !== "notice" && status !== "future") reasons.push("The tenancy has no verified move-out, termination, or lease end date; review the historical interval before selecting a QuickBooks company.");
  else if (!completeCoverage) reasons.push("The historical legal-entity assignment does not cover the full tenancy interval; review ownership before selecting a QuickBooks company.");
  if (ownerIds.length === 0) reasons.push("No historical legal-entity assignment overlaps this tenancy interval; review ownership before selecting a QuickBooks company.");
  else if (ownerIds.length > 1) reasons.push("More than one legal entity owned this property during the tenancy interval; review ownership before selecting a QuickBooks company.");
  if (customerLink && !linkMatchesOwner) reasons.push("The existing QuickBooks customer link belongs to a different legal entity than the historical owner; review the mapping.");
  if (!activeBindingConnection && qboState !== "ownership_review") reasons.push("No active QuickBooks binding connection is available for the historical owner.");
  if (localState === "local_history_available" && qboState === "not_connected") reasons.push("Local Rent Ops history is available; this does not establish a QuickBooks connection or customer link.");
  if (activeBindingConnection && qboState === "unlinked") reasons.push("QuickBooks is connected for the historical owner, but this tenancy has no customer link.");

  const result = {
    kind: "tenant_source_resolution" as const,
    organizationId,
    tenancyId,
    asOf,
    tenancy: {
      status,
      propertyId,
      unitId,
      startOn,
      endOn,
    },
    local: {
      state: localState,
      sourceSystem: "rent_ops" as const,
      ledgerEntryCount,
    },
    ownership: {
      state: ownershipResolved && !ownershipReview ? "resolved" as const : "review" as const,
      coverageComplete: completeCoverage,
      propertyName,
      // Keep the response tenancy-scoped: future or otherwise unrelated
      // property assignments are not source candidates for this tenancy.
      periods: overlappingPeriods,
      effectiveLegalEntityId,
      effectiveLegalEntityName: history.effectiveLegalEntityName,
    },
    qbo: {
      environment,
      state: qboState,
      scope: bindingRealmId && effectiveLegalEntityId
        ? financialSourceScopeSchema.parse({ provider: "qbo", organizationId, legalEntityId: effectiveLegalEntityId, environment, realmId: bindingRealmId })
        : null,
      binding: bindingRealmId ? { realmId: bindingRealmId, providerCompanyName: text(binding?.provider_company_name) } : null,
      connection: connection && connectionRealmId ? {
        state: connectionState(connection.status, connection.revoked_at),
        realmId: connectionRealmId,
        readCapabilityEnabled: connection.read_capability_enabled === true || connection.read_capability_enabled === "true",
        updatedAt: timestamp(connection.updated_at),
      } : null,
      customerLink: customerLink ? { customerObjectId: String(customerLink.external_id), legalEntityId: String(customerLink.legal_entity_id) } : null,
    },
    currentState,
    reasons: reasons.slice(0, 10),
  };
  return tenantSourceResolutionSchema.parse(result);
}
