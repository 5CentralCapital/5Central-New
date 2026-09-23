import type { CollectedIncomeRow, DelinquencyRow, RentOpsFilters, RentOpsSnapshot, RentRollRow, ScheduledIncomeRow } from "../../shared/rent-ops-contracts";
import type { PropertyPerformance, PropertyPerformanceRow } from "../../shared/workspaces/contracts";
import { deriveFixedReport } from "../rent-ops/domain/reports";
import { centsOf } from "./period";
import type { ProjectFinanceReadPort } from "../../shared/projects";
import { authorizedPropertyMappings, centsValue, type PropertyEntityMapping, type WorkspaceReadContext } from "./access";
import { readProjectPostings, readWorkspaceProjects, type WorkspaceProject } from "./project-postings";

const ACTIVE_PROJECT_STATUSES = ["planning", "active", "on_hold"] as const;

/** Active project exposure on one property. Posted costs come from the project finance read port. */
export interface ProjectExposure { active: number; estimate: bigint | null; posted: bigint | null; postedComplete: boolean }

interface Sum { known: bigint; unknown: number }
const sum = (): Sum => ({ known: BigInt(0), unknown: 0 });
const addTo = (target: Sum | undefined, value: bigint | null) => { if (!target) return; if (value === null) target.unknown += 1; else target.known += value; };

export interface CompanyPerformanceRows {
  readonly mappings: ReadonlyMap<string, PropertyEntityMapping>;
  readonly workOrders: ReadonlyMap<string, number>;
  readonly projects: ReadonlyMap<string, ProjectExposure>;
}

/** Per-property operating summary for one month, from the same report derivations as the report pages. */
export function computePropertyPerformance(snapshot: RentOpsSnapshot, input: {
  month: string; asOf: string; propertyScope: "active" | "all"; propertyIds?: readonly string[];
}, company?: CompanyPerformanceRows): PropertyPerformance {
  const base: RentOpsFilters = { propertyScope: input.propertyScope, asOfDate: input.asOf as RentOpsFilters["asOfDate"], ...(input.propertyIds?.length ? { propertyIds: [...input.propertyIds] } : {}) };
  const monthly: RentOpsFilters = { ...base, month: input.month as RentOpsFilters["month"] };
  const properties = snapshot.properties.filter(property => (input.propertyScope === "all" || property.state === "active") && (!input.propertyIds?.length || input.propertyIds.includes(property.id)));
  const rows = new Map(properties.map(property => [property.id, {
    property, units: 0, occupied: 0, unknownOccupancy: 0, scheduled: sum(), collected: sum(), arrears: sum(),
  }]));
  for (const row of deriveFixedReport(snapshot, "rent-roll", base) as RentRollRow[]) {
    const target = rows.get(row.propertyId); if (!target) continue;
    target.units += 1;
    if (row.occupancy === "current") target.occupied += 1;
    else if (row.occupancy === "unknown") target.unknownOccupancy += 1;
  }
  for (const row of deriveFixedReport(snapshot, "scheduled-income", monthly) as ScheduledIncomeRow[]) {
    if (row.category !== "base_rent" || !row.propertyId) continue;
    addTo(rows.get(row.propertyId)?.scheduled, centsOf(row.amountCents));
  }
  for (const row of deriveFixedReport(snapshot, "collected-income", monthly) as CollectedIncomeRow[]) {
    if (!row.propertyId) continue;
    addTo(rows.get(row.propertyId)?.collected, centsOf(row.amountCents));
  }
  for (const row of deriveFixedReport(snapshot, "delinquency", base) as DelinquencyRow[]) {
    if (!row.propertyId) continue;
    const balance = row.operationalBalanceCents;
    if (typeof balance === "number" && balance <= 0) continue;
    addTo(rows.get(row.propertyId)?.arrears, centsOf(balance ?? null));
  }
  const text = (value: Sum) => value.unknown > 0 && value.known === BigInt(0) ? null : value.known.toString();
  const result: PropertyPerformanceRow[] = Array.from(rows.values()).map(entry => {
    const mapping = company?.mappings.get(entry.property.id);
    const projects = mapping ? company!.projects.get(entry.property.id) : undefined;
    return {
      propertyId: entry.property.id,
      propertyName: entry.property.name ?? "Unnamed property",
      state: entry.property.state ?? null,
      unitCount: entry.units,
      occupiedUnits: entry.occupied,
      unknownOccupancyUnits: entry.unknownOccupancy,
      scheduledRentCents: text(entry.scheduled), scheduledRentComplete: entry.scheduled.unknown === 0,
      collectedCents: text(entry.collected), collectedComplete: entry.collected.unknown === 0,
      arrearsCents: text(entry.arrears), arrearsComplete: entry.arrears.unknown === 0,
      openWorkOrders: mapping ? company!.workOrders.get(entry.property.id) ?? 0 : null,
      activeProjects: mapping ? projects?.active ?? 0 : null,
      projectEstimateCents: mapping ? (projects ? projects.estimate?.toString() ?? null : "0") : null,
      projectPostedCents: mapping ? (projects ? projects.posted?.toString() ?? null : "0") : null,
      projectPostedComplete: mapping ? (projects ? projects.posted !== null && projects.postedComplete : true) : false,
      legalEntityName: mapping?.legalEntityName ?? null,
    };
  }).sort((left, right) => left.propertyName.localeCompare(right.propertyName, undefined, { numeric: true, sensitivity: "base" }));
  return { period: { month: input.month, asOf: input.asOf }, companyAvailable: Boolean(company), rows: result };
}

/** Open work and project exposure for the mapped properties the principal may read. */
export async function readCompanyPerformanceRows(context: WorkspaceReadContext, asOf: string, finance: ProjectFinanceReadPort): Promise<CompanyPerformanceRows> {
  const mappings = await authorizedPropertyMappings(context, asOf);
  const organizationId = context.principal.organizationId;
  const ids = Array.from(mappings.keys());
  const workOrders = new Map<string, number>();
  const projects = new Map<string, ProjectExposure>();
  if (!ids.length) return { mappings, workOrders, projects };
  const open = await context.executor.query<{ property_id: string; count: unknown }>(
    `SELECT property_id, count(*) AS count FROM company_work_orders
      WHERE organization_id = $1 AND property_id = ANY($2::text[]) AND status NOT IN ('completed','canceled')
      GROUP BY property_id`, [organizationId, ids]);
  for (const row of open.rows) workOrders.set(row.property_id, Number(row.count));
  const exposure = await context.executor.query<{ property_id: string; active: unknown; estimate: unknown; foreign_currency: unknown }>(
    `SELECT p.property_id, count(*) AS active,
            coalesce(sum(scope.estimate) FILTER (WHERE p.currency = 'USD'), 0)::text AS estimate,
            count(*) FILTER (WHERE p.currency <> 'USD') AS foreign_currency
       FROM company_projects p
       LEFT JOIN LATERAL (SELECT sum(estimated_cents) AS estimate FROM company_project_scope_items s
                           WHERE s.organization_id = p.organization_id AND s.project_id = p.id AND s.archived_at IS NULL) scope ON true
      WHERE p.organization_id = $1 AND p.property_id = ANY($2::text[]) AND p.status IN (${ACTIVE_PROJECT_STATUSES.map(status => `'${status}'`).join(",")})
      GROUP BY p.property_id`, [organizationId, ids]);
  // Posted costs: the bound QuickBooks lines the project pages read, never the legacy importer table.
  const active = await readWorkspaceProjects(context, ids, ACTIVE_PROJECT_STATUSES);
  const byProperty = new Map<string, WorkspaceProject[]>();
  for (const project of active.projects) byProperty.set(project.propertyId, [...(byProperty.get(project.propertyId) ?? []), project]);
  for (const row of exposure.rows) {
    // Amounts in another currency cannot be added to USD; the total is then unknown.
    const foreign = Number(row.foreign_currency) > 0;
    const postings = await readProjectPostings(context, finance, byProperty.get(row.property_id) ?? [], { through: asOf, incomplete: active.truncated || active.uncovered > 0 });
    let posted: bigint | null = null;
    if (!foreign && postings.coverage !== "unavailable") {
      posted = BigInt(0);
      for (const { actual } of postings.actuals) {
        if (actual.currency !== "USD") { posted = null; break; }
        posted += BigInt(actual.amountCents);
      }
    }
    projects.set(row.property_id, {
      active: Number(row.active), estimate: foreign ? null : centsValue(row.estimate),
      posted, postedComplete: posted !== null && postings.coverage === "complete",
    });
  }
  return { mappings, workOrders, projects };
}
