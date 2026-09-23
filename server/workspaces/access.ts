import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../company/authorization";
import { ForbiddenCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { CommandRole } from "../../shared/company";

/** Roles that may read manager workspace summaries. Writers keep their own command policies. */
export const WORKSPACE_READ_ROLES: readonly CommandRole[] = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"];

export interface WorkspaceReadContext {
  readonly executor: RentOpsQueryExecutor;
  readonly principal: AuthenticatedPrincipal;
}

/**
 * Run a read inside one read-only snapshot, reloading grants there so a
 * revoked grant cannot keep reading (the work-order port uses the same rule).
 */
export async function readAsPrincipal<T>(
  executor: RentOpsQueryExecutor,
  input: { actorId: string; organizationId: string; role: CommandRole },
  work: (context: WorkspaceReadContext) => Promise<T>,
): Promise<T> {
  const run = async (transaction: RentOpsQueryExecutor) => {
    const principal = await loadAuthenticatedPrincipal(transaction, input);
    // Grants may be entity- or property-level; each read filters rows by grantCovers.
    if (!WORKSPACE_READ_ROLES.includes(principal.role)) throw new ForbiddenCommandError("Requested company records are not authorized", { reason: "read_role" });
    return work({ executor: transaction, principal });
  };
  return executor.transaction ? executor.transaction(run, { readOnly: true }) : run(executor);
}

/** True when a paired grant covers this entity (and property, when given). */
export function grantCovers(principal: AuthenticatedPrincipal, legalEntityId: string, propertyId?: string): boolean {
  return principal.authorizedScopes.some(grant => grant.legalEntityId === undefined
    || (grant.legalEntityId === legalEntityId && (grant.propertyId === undefined || (propertyId !== undefined && grant.propertyId === propertyId))));
}

/** True when a grant covers the whole entity (entity- or organization-level). */
export function grantCoversEntity(principal: AuthenticatedPrincipal, legalEntityId: string): boolean {
  return principal.authorizedScopes.some(grant => grant.legalEntityId === undefined || (grant.legalEntityId === legalEntityId && grant.propertyId === undefined));
}

export function organizationWide(principal: AuthenticatedPrincipal): boolean {
  return principal.authorizedScopes.some(grant => grant.legalEntityId === undefined);
}

export interface PropertyEntityMapping {
  readonly propertyId: string;
  readonly legalEntityId: string;
  readonly legalEntityName: string;
}

/** Property → legal entity on a date, limited to what the principal's grants cover. */
export async function authorizedPropertyMappings(context: WorkspaceReadContext, onDate: string): Promise<Map<string, PropertyEntityMapping>> {
  const { rows } = await context.executor.query<{ property_id: string; legal_entity_id: string; legal_entity_name: string }>(
    `SELECT m.property_id, m.legal_entity_id, e.name AS legal_entity_name
       FROM company_property_entity_periods m
       JOIN company_legal_entities e ON e.organization_id = m.organization_id AND e.id = m.legal_entity_id AND e.archived_at IS NULL
      WHERE m.organization_id = $1 AND m.effective_from <= $2::date AND (m.effective_until IS NULL OR m.effective_until > $2::date)`,
    [context.principal.organizationId, onDate],
  );
  const result = new Map<string, PropertyEntityMapping>();
  for (const row of rows) {
    if (!grantCovers(context.principal, row.legal_entity_id, row.property_id)) continue;
    result.set(row.property_id, { propertyId: row.property_id, legalEntityId: row.legal_entity_id, legalEntityName: row.legal_entity_name });
  }
  return result;
}

/** Legal entities readable in full by the principal. */
export async function authorizedEntities(context: WorkspaceReadContext): Promise<Array<{ id: string; name: string; entityType: string; currency: string }>> {
  const { rows } = await context.executor.query<{ id: string; name: string; entity_type: string; currency: string }>(
    `SELECT id, name, entity_type, currency FROM company_legal_entities
      WHERE organization_id = $1 AND archived_at IS NULL ORDER BY lower(name), id`,
    [context.principal.organizationId],
  );
  return rows.filter(row => grantCoversEntity(context.principal, row.id)).map(row => ({ id: row.id, name: row.name, entityType: row.entity_type, currency: row.currency }));
}

/** Exact cents from a PostgreSQL BIGINT value (driver string, bigint or safe integer). */
export function centsValue(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("Unsafe integer cents from storage");
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d{1,19}$/.test(value)) return BigInt(value);
  throw new TypeError("Invalid cents value from storage");
}

export function centsText(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

export function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function timestampText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
