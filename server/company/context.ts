import { authenticatedPrincipalIdSchema, commandRoleSchema, type CommandRole } from '../../shared/company';
import type { CompanyContext, CompanyContextOrganization, CompanyContextEntity, CompanyContextProperty } from '../../shared/company/context';
import type { RentOpsQueryExecutor } from '../rent-ops/repositories/postgres';

/** Directory data is returned only through active paired grants, never the legacy admin flag alone. */
export async function readCompanyContext(executor: RentOpsQueryExecutor, actorId: string, role: CommandRole): Promise<CompanyContext> {
  authenticatedPrincipalIdSchema.parse(actorId);
  commandRoleSchema.parse(role);
  const { rows } = await executor.query<{
    organization_id: string; organization_name: string;
    entity_id: string | null; entity_name: string | null; currency: string | null;
    property_id: string | null; property_name: string | null;
    unit_id: string | null; unit_number: string | null;
  }>(`SELECT DISTINCT o.id AS organization_id, o.name AS organization_name,
      e.id AS entity_id, e.name AS entity_name, e.currency,
      p.id AS property_id, p.name AS property_name, u.id AS unit_id, u.unit_number
    FROM company_organizations o
    JOIN company_access_grants g ON g.organization_id = o.id
      AND g.actor_id = $1 AND g.role = $2 AND g.revoked_at IS NULL
    LEFT JOIN company_legal_entities e ON e.organization_id = o.id AND e.archived_at IS NULL
      AND (g.legal_entity_id IS NULL OR g.legal_entity_id = e.id)
    LEFT JOIN company_property_entity_periods m ON m.organization_id = o.id AND m.legal_entity_id = e.id
      AND m.effective_from <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date AND (m.effective_until IS NULL OR m.effective_until > (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date)
      AND (g.property_id IS NULL OR g.property_id = m.property_id)
    LEFT JOIN rent_ops_properties p ON p.id = m.property_id
    LEFT JOIN rent_ops_units u ON u.property_id = p.id
    WHERE o.archived_at IS NULL
    ORDER BY o.name, o.id, e.name, e.id, p.name, p.id, u.unit_number, u.id`, [actorId, role]);
  const organizations = new Map<string, CompanyContextOrganization>();
  const entities = new Map<string, CompanyContextEntity>();
  const properties = new Map<string, CompanyContextProperty>();
  const units = new Set<string>();
  for (const row of rows) {
    let organization = organizations.get(row.organization_id);
    if (!organization) {
      organization = { id: row.organization_id, name: row.organization_name, role, entities: [] };
      organizations.set(organization.id, organization);
    }
    if (!row.entity_id) continue;
    let entity = entities.get(row.entity_id);
    if (!entity) {
      entity = { id: row.entity_id, name: row.entity_name!, currency: row.currency!, properties: [] };
      entities.set(entity.id, entity); organization.entities.push(entity);
    }
    if (!row.property_id) continue;
    const propertyKey = `${entity.id}:${row.property_id}`;
    let property = properties.get(propertyKey);
    if (!property) {
      property = { id: row.property_id, name: row.property_name!, units: [] };
      properties.set(propertyKey, property); entity.properties.push(property);
    }
    const unitKey = `${propertyKey}:${row.unit_id}`;
    if (row.unit_id && !units.has(unitKey)) {
      property.units.push({ id: row.unit_id, unitNumber: row.unit_number! }); units.add(unitKey);
    }
  }
  return { organizations: Array.from(organizations.values()) };
}
