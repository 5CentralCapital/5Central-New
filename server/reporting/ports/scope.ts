import { companyScopeSchema, legalEntityIdSchema, propertyReferenceIdSchema, type CompanyScope } from "../../../shared/company";
import type { ReportingEngineContext } from "../../../shared/reporting";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../../company/authorization";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import { ReportingError } from "../errors";
import { periodBounds } from "../source-engine-utils";

export const REPORT_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

export interface ReportingScopeDependencies {
  readonly executor: RentOpsQueryExecutor;
  readonly principal: AuthenticatedPrincipal;
}

interface MappingRow { property_id: string; legal_entity_id: string; covers_period: boolean }

async function mappingsFor(deps: ReportingScopeDependencies, context: ReportingEngineContext, from: string, through: string, legalEntityIds: readonly string[], propertyIds: readonly string[]): Promise<MappingRow[]> {
  const result = await deps.executor.query<MappingRow>(
    `SELECT property_id,legal_entity_id,
      effective_from <= $2::date AND (effective_until IS NULL OR effective_until > $3::date) AS covers_period
     FROM company_property_entity_periods
     WHERE organization_id=$1 AND effective_from <= $3::date
       AND (effective_until IS NULL OR effective_until > $2::date)
       AND (cardinality($4::uuid[])=0 OR legal_entity_id=ANY($4::uuid[]))
       AND (cardinality($5::varchar[])=0 OR property_id=ANY($5::varchar[]))`,
    [context.request.scope.organizationId, from, through, legalEntityIds, propertyIds],
  );
  return result.rows.map(row => ({ property_id: String(row.property_id), legal_entity_id: String(row.legal_entity_id), covers_period: row.covers_period === true }));
}

function bounded(context: ReportingEngineContext): { from: string; through: string } {
  const bounds = periodBounds(context);
  const through = bounds.through ?? context.now.slice(0, 10);
  return { from: bounds.from ?? through, through };
}

/** The principal's own grants for an organization-wide report. An empty
 * report scope never widens beyond them. */
export function principalScopes(principal: AuthenticatedPrincipal, organizationId: string): CompanyScope[] {
  if (principal.organizationId !== organizationId) throw new ReportingError("report_forbidden", "Report organization is outside the authenticated scope", 403);
  if (principal.authorizedScopes.some(grant => !grant.legalEntityId && !grant.propertyId)) return [companyScopeSchema.parse({ organizationId })];
  return principal.authorizedScopes.filter(grant => grant.legalEntityId).map(grant => companyScopeSchema.parse({ organizationId, legalEntityId: grant.legalEntityId, ...(grant.propertyId ? { propertyId: grant.propertyId } : {}) }));
}

/**
 * Resolve the request to dated entity/property scopes and authorize each.
 * A missing mapping produces an empty scope and never means "read everything".
 */
export async function resolveDatedScopes(deps: ReportingScopeDependencies, context: ReportingEngineContext): Promise<readonly CompanyScope[]> {
  const { from, through } = bounded(context);
  const organizationId = context.request.scope.organizationId;
  const requestedProperties = context.request.scope.propertyIds.map(String);
  const requestedEntities = context.request.scope.legalEntityIds.map(String);
  if (!requestedProperties.length && requestedEntities.length) {
    return requestedEntities.map(legalEntityId => {
      const parsedEntity = legalEntityIdSchema.parse(legalEntityId);
      authorizeCompanyRead(deps.principal, { organizationId, legalEntityId: parsedEntity }, REPORT_READ_ROLES);
      return companyScopeSchema.parse({ organizationId, legalEntityId: parsedEntity });
    });
  }
  if (!requestedProperties.length && !requestedEntities.length) {
    if (!REPORT_READ_ROLES.includes(deps.principal.role as (typeof REPORT_READ_ROLES)[number])) throw new ReportingError("report_forbidden", "The authenticated role cannot read reports", 403);
    return principalScopes(deps.principal, organizationId);
  }
  const rows = await mappingsFor(deps, context, from, through, requestedEntities, requestedProperties);
  if (rows.some(row => !row.covers_period)) throw new ReportingError("report_unavailable", "A selected property changed legal entities during the requested period. Choose a period within one ownership interval.", 409, { dependency: "effective_property_entity_mapping" });
  const pairs = new Map<string, CompanyScope>();
  for (const row of rows) {
    const legalEntityId = legalEntityIdSchema.parse(row.legal_entity_id);
    const propertyId = propertyReferenceIdSchema.parse(row.property_id);
    authorizeCompanyRead(deps.principal, { organizationId, legalEntityId, propertyId }, REPORT_READ_ROLES);
    pairs.set(`${legalEntityId}:${propertyId}`, companyScopeSchema.parse({ organizationId, legalEntityId, propertyId }));
  }
  if (requestedProperties.some(propertyId => !Array.from(pairs.values()).some(scope => scope.propertyId === propertyId))) {
    throw new ReportingError("report_forbidden", "A selected property is outside the company reporting period.", 403);
  }
  return Array.from(pairs.values());
}

/**
 * Dated rental property IDs for the request, authorized per entity/property
 * pair. With no selection, the principal's grants bound the result.
 */
export async function resolveRentalPropertyIds(deps: ReportingScopeDependencies, context: ReportingEngineContext): Promise<readonly string[]> {
  const { from, through } = bounded(context);
  const requestedProperties = context.request.scope.propertyIds.map(String);
  const rows = await mappingsFor(deps, context, from, through, context.request.scope.legalEntityIds.map(String), requestedProperties);
  if (rows.some(row => !row.covers_period)) throw new ReportingError("report_unavailable", "A property changed legal entities during the requested rental period.", 409, { dependency: "effective_property_entity_mapping" });
  const selectedOnly = requestedProperties.length > 0 || context.request.scope.legalEntityIds.length > 0;
  const propertyIds = new Set<string>();
  for (const row of rows) {
    const scope = { organizationId: context.request.scope.organizationId, legalEntityId: legalEntityIdSchema.parse(row.legal_entity_id), propertyId: propertyReferenceIdSchema.parse(row.property_id) };
    if (selectedOnly) {
      authorizeCompanyRead(deps.principal, scope, REPORT_READ_ROLES);
      propertyIds.add(row.property_id);
    } else {
      // Organization-wide: silently keep only properties this principal may read.
      try { authorizeCompanyRead(deps.principal, scope, REPORT_READ_ROLES); propertyIds.add(row.property_id); } catch { /* outside the principal's grants */ }
    }
  }
  if (requestedProperties.some(propertyId => !propertyIds.has(propertyId))) throw new ReportingError("report_forbidden", "A selected property is outside the company reporting period.", 403);
  return Array.from(propertyIds);
}

/** SQL predicate for a list of company scopes on (legal_entity_id, property_id) columns. */
export function scopePredicate(scopes: readonly CompanyScope[], values: unknown[], entityColumn: string, propertyColumn: string | null): string {
  if (!scopes.length) return "false";
  if (scopes.some(scope => !scope.legalEntityId && !scope.propertyId)) return "true";
  const clauses = scopes.map(scope => {
    values.push(scope.legalEntityId);
    const entity = `${entityColumn}=$${values.length}::uuid`;
    if (!scope.propertyId || !propertyColumn) return entity;
    values.push(scope.propertyId);
    return `(${entity} AND ${propertyColumn}=$${values.length})`;
  });
  return `(${clauses.join(" OR ")})`;
}
