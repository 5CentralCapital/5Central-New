import { ValidationCommandError } from "../company/commands/errors";
import type { CompanySettings, CostLibrary, EntityDirectory, PeopleDirectory, PropertyDocuments } from "../../shared/workspaces/contracts";
import { authorizedEntities, authorizedPropertyMappings, centsValue, dateText, grantCovers, organizationWide, timestampText, type WorkspaceReadContext } from "./access";

type QboBinding = EntityDirectory["entities"][number]["qbo"][number];

/** QBO state per entity/environment from the confirmed realm binding and connection rows; tokens are never selected. */
async function qboBindings(context: WorkspaceReadContext, entityIds: readonly string[]): Promise<Map<string, QboBinding[]>> {
  const result = new Map<string, QboBinding[]>();
  if (!entityIds.length) return result;
  const { rows } = await context.executor.query<{
    legal_entity_id: string; environment: "sandbox" | "production"; realm_id: string | null; company_name: string | null; confirmed_at: unknown; status: string | null; read_enabled: unknown;
  }>(
    `SELECT e.legal_entity_id, e.environment, coalesce(b.realm_id, c.realm_id) AS realm_id, b.provider_company_name AS company_name,
            b.confirmed_at, c.status,
            EXISTS (SELECT 1 FROM accounting_qbo_capabilities cap
                     WHERE cap.organization_id = e.organization_id AND cap.legal_entity_id = e.legal_entity_id AND cap.environment = e.environment
                       AND cap.realm_id = coalesce(b.realm_id, c.realm_id) AND cap.capability = 'accounting.read' AND cap.enabled = true) AS read_enabled
       FROM (SELECT DISTINCT organization_id, legal_entity_id, environment FROM (
               SELECT organization_id, legal_entity_id, environment FROM accounting_qbo_realm_bindings
               UNION ALL SELECT organization_id, legal_entity_id, environment FROM accounting_qbo_connections) scopes
              WHERE organization_id = $1 AND legal_entity_id = ANY($2::uuid[])) e
       LEFT JOIN accounting_qbo_realm_bindings b ON b.organization_id = e.organization_id AND b.legal_entity_id = e.legal_entity_id AND b.environment = e.environment
       LEFT JOIN LATERAL (SELECT realm_id, status FROM accounting_qbo_connections c
                           WHERE c.organization_id = e.organization_id AND c.legal_entity_id = e.legal_entity_id AND c.environment = e.environment
                           ORDER BY (c.status = 'active') DESC, c.updated_at DESC LIMIT 1) c ON true
      ORDER BY e.legal_entity_id, e.environment`,
    [context.principal.organizationId, entityIds],
  );
  for (const row of rows) {
    const status: QboBinding["status"] = row.status === "active" ? (row.read_enabled === true || row.read_enabled === "true" ? "ready" : "connected")
      : row.status === "needs_reconnect" ? "needs_reconnect" : row.status === "revoked" ? "revoked" : "not_connected";
    const list = result.get(row.legal_entity_id) ?? [];
    list.push({ environment: row.environment, status, companyName: row.company_name, realmId: row.realm_id, confirmedAt: row.confirmed_at ? timestampText(row.confirmed_at) : null });
    result.set(row.legal_entity_id, list);
  }
  return result;
}

export async function readEntityDirectory(context: WorkspaceReadContext, asOf: string): Promise<EntityDirectory> {
  const entities = await authorizedEntities(context);
  const qbo = await qboBindings(context, entities.map(entity => entity.id));
  const { rows } = await context.executor.query<{ legal_entity_id: string; property_id: string; property_name: string | null; effective_from: string; effective_until: string | null }>(
    `SELECT m.legal_entity_id, m.property_id, p.name AS property_name, m.effective_from::text AS effective_from, m.effective_until::text AS effective_until
       FROM company_property_entity_periods m LEFT JOIN rent_ops_properties p ON p.id = m.property_id
      WHERE m.organization_id = $1 ORDER BY lower(coalesce(p.name, m.property_id)), m.effective_from DESC`,
    [context.principal.organizationId],
  );
  const byEntity = new Map<string, EntityDirectory["entities"][number]["properties"]>();
  for (const row of rows) {
    if (!grantCovers(context.principal, row.legal_entity_id, row.property_id)) continue;
    const list = byEntity.get(row.legal_entity_id) ?? [];
    list.push({ propertyId: row.property_id, propertyName: row.property_name, effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
      current: row.effective_from <= asOf && (row.effective_until === null || row.effective_until > asOf) });
    byEntity.set(row.legal_entity_id, list);
  }
  // Rental properties with no current entity are visible only to organization-wide readers.
  const unmapped = organizationWide(context.principal) ? (await context.executor.query<{ id: string; name: string | null }>(
    `SELECT p.id, p.name FROM rent_ops_properties p
      WHERE NOT EXISTS (SELECT 1 FROM company_property_entity_periods m WHERE m.property_id = p.id AND m.organization_id = $1
                         AND m.effective_from <= $2::date AND (m.effective_until IS NULL OR m.effective_until > $2::date))
      ORDER BY lower(coalesce(p.name, p.id)) LIMIT 1000`, [context.principal.organizationId, asOf])).rows : [];
  return {
    entities: entities.map(entity => ({ ...entity, qbo: qbo.get(entity.id) ?? [], properties: byEntity.get(entity.id) ?? [] })),
    unmappedProperties: unmapped.map(row => ({ propertyId: row.id, propertyName: row.name })),
  };
}

function encodeCursor(values: readonly string[]): string { return Buffer.from(JSON.stringify(values), "utf8").toString("base64url"); }
function decodeCursor(cursor: string | undefined, length: number): string[] | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === length && value.every(item => typeof item === "string")) return value;
  } catch { /* fall through */ }
  throw new ValidationCommandError("The page cursor is invalid. Reload the list.", { reason: "invalid_cursor" });
}

export async function readPeopleDirectory(context: WorkspaceReadContext, input: { search?: string; role?: string; limit: number; cursor?: string; asOf: string }): Promise<PeopleDirectory> {
  const organizationId = context.principal.organizationId;
  const after = decodeCursor(input.cursor, 2);
  const search = input.search?.trim() ? `%${input.search.trim().toLowerCase().replace(/[\\%_]/g, character => `\\${character}`)}%` : null;
  const orgWide = organizationWide(context.principal);
  const entityIds = (await authorizedEntities(context)).map(entity => entity.id);
  // A contact is visible when the reader is organization-wide or one of its roles is in a readable entity.
  const contacts = await context.executor.query<{ id: string; kind: "person" | "organization"; display_name: string; rent_ops_person_id: string | null }>(
    `SELECT c.id, c.kind, c.display_name, c.rent_ops_person_id FROM company_contacts c
      WHERE c.organization_id = $1 AND c.archived_at IS NULL
        AND ($2::text IS NULL OR lower(c.display_name) LIKE $2 ESCAPE '\\')
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM company_contact_roles r WHERE r.organization_id = c.organization_id AND r.contact_id = c.id AND r.role = $3
              AND r.effective_from <= $7::date AND (r.effective_until IS NULL OR r.effective_until > $7::date)))
        AND ($4::boolean OR EXISTS (SELECT 1 FROM company_contact_roles r WHERE r.organization_id = c.organization_id AND r.contact_id = c.id AND r.legal_entity_id = ANY($5::uuid[])))
        AND ($6::text IS NULL OR (lower(c.display_name), c.id::text) > ($6::text, $8::text))
      ORDER BY lower(c.display_name), c.id LIMIT $9`,
    [organizationId, search, input.role ?? null, orgWide, entityIds, after?.[0] ?? null, input.asOf, after?.[1] ?? null, input.limit + 1],
  );
  const page = contacts.rows.slice(0, input.limit);
  const roles = page.length ? await context.executor.query<{ contact_id: string; role: PeopleDirectory["contacts"][number]["roles"][number]["role"]; legal_entity_id: string | null; legal_entity_name: string | null; effective_from: string; effective_until: string | null }>(
    `SELECT r.contact_id, r.role, r.legal_entity_id, e.name AS legal_entity_name, r.effective_from::text AS effective_from, r.effective_until::text AS effective_until
       FROM company_contact_roles r LEFT JOIN company_legal_entities e ON e.organization_id = r.organization_id AND e.id = r.legal_entity_id
      WHERE r.organization_id = $1 AND r.contact_id = ANY($2::uuid[]) ORDER BY r.effective_from DESC, r.role`,
    [organizationId, page.map(row => row.id)],
  ) : { rows: [] };
  const vendorRows = await context.executor.query<{ legal_entity_id: string; legal_entity_name: string; object_id: string; display_name: string | null; active: string | null }>(
    `SELECT DISTINCT ON (o.legal_entity_id, o.object_id) o.legal_entity_id, e.name AS legal_entity_name, o.object_id,
            o.provider_body->>'DisplayName' AS display_name, o.provider_body->>'Active' AS active
       FROM accounting_qbo_source_objects o JOIN company_legal_entities e ON e.organization_id = o.organization_id AND e.id = o.legal_entity_id
      WHERE o.organization_id = $1 AND o.object_type = 'Vendor' AND o.legal_entity_id = ANY($2::uuid[]) AND o.deleted_at IS NULL
        AND ($3::text IS NULL OR lower(o.provider_body->>'DisplayName') LIKE $3 ESCAPE '\\')
      ORDER BY o.legal_entity_id, o.object_id, o.received_at DESC LIMIT 101`,
    [organizationId, entityIds, search],
  );
  const last = page.at(-1);
  return {
    contacts: page.map(contact => ({
      id: contact.id, kind: contact.kind, displayName: contact.display_name, rentOpsPersonId: contact.rent_ops_person_id,
      roles: roles.rows.filter(role => role.contact_id === contact.id && (orgWide || role.legal_entity_id === null || entityIds.includes(role.legal_entity_id)))
        .map(role => ({ role: role.role, legalEntityName: role.legal_entity_name, effectiveFrom: role.effective_from, effectiveUntil: role.effective_until })),
    })),
    nextCursor: contacts.rows.length > input.limit && last ? encodeCursor([last.display_name.toLowerCase(), last.id]) : null,
    vendors: vendorRows.rows.slice(0, 100).map(row => ({ legalEntityName: row.legal_entity_name, displayName: row.display_name ?? "Unnamed vendor", active: row.active !== "false", providerObjectId: row.object_id }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" })),
    vendorsTruncated: vendorRows.rows.length > 100,
  };
}

export async function readCompanySettings(context: WorkspaceReadContext): Promise<CompanySettings> {
  const organizationId = context.principal.organizationId;
  const organization = await context.executor.query<{ id: string; name: string }>("SELECT id, name FROM company_organizations WHERE id = $1", [organizationId]);
  const entities = await authorizedEntities(context);
  const entityNames = new Map(entities.map(entity => [entity.id, entity.name]));
  // Access lists are administration data: only organization-wide readers see every grant.
  const grants = organizationWide(context.principal) ? await context.executor.query<{ actor_id: string; role: string; legal_entity_name: string | null; property_name: string | null; created_at: unknown }>(
    `SELECT g.actor_id, g.role, e.name AS legal_entity_name, p.name AS property_name, g.created_at
       FROM company_access_grants g
       LEFT JOIN company_legal_entities e ON e.organization_id = g.organization_id AND e.id = g.legal_entity_id
       LEFT JOIN rent_ops_properties p ON p.id = g.property_id
      WHERE g.organization_id = $1 AND g.revoked_at IS NULL ORDER BY g.actor_id, g.role, e.name NULLS FIRST LIMIT 500`, [organizationId]) : { rows: [] };
  const qbo = await qboBindings(context, entities.map(entity => entity.id));
  const time = entities.length ? await context.executor.query<{ legal_entity_id: string; environment: "sandbox" | "production"; status: "active" | "revoked" | "needs_reconnect"; connected_at: unknown }>(
    `SELECT legal_entity_id, environment, status, connected_at FROM time_connections
      WHERE organization_id = $1 AND legal_entity_id = ANY($2::uuid[]) ORDER BY legal_entity_id, environment, updated_at DESC LIMIT 500`,
    [organizationId, entities.map(entity => entity.id)]) : { rows: [] };
  return {
    organization: { id: organizationId, name: organization.rows[0]?.name ?? "Company" },
    grants: grants.rows.map(row => ({ actorId: row.actor_id, role: row.role, legalEntityName: row.legal_entity_name, propertyName: row.property_name, createdAt: timestampText(row.created_at) })),
    qbo: Array.from(qbo.entries()).flatMap(([entityId, list]) => list.map(binding => ({ ...binding, legalEntityName: entityNames.get(entityId) ?? "Entity" }))),
    time: time.rows.map(row => ({ legalEntityName: entityNames.get(row.legal_entity_id) ?? "Entity", environment: row.environment, status: row.status, connectedAt: row.connected_at ? timestampText(row.connected_at) : null })),
  };
}

export async function readPropertyDocuments(context: WorkspaceReadContext, input: { asOf: string; propertyIds?: readonly string[] }): Promise<PropertyDocuments> {
  const organizationId = context.principal.organizationId;
  const { rows } = await context.executor.query<{ id: string; legal_entity_id: string | null; property_id: string; property_name: string | null; kind: string; title: string; document_date: string | null; file_name: string; uploaded_at: unknown }>(
    `SELECT d.id, d.legal_entity_id, d.property_id, p.name AS property_name, d.kind, d.title, d.document_date::text AS document_date, d.file_name, d.uploaded_at
       FROM company_documents d LEFT JOIN rent_ops_properties p ON p.id = d.property_id
      WHERE d.organization_id = $1 AND d.state <> 'archived' AND d.property_id IS NOT NULL
        AND ($2::text[] IS NULL OR d.property_id = ANY($2::text[]))
      ORDER BY lower(coalesce(p.name, d.property_id)), d.document_date DESC NULLS LAST, d.id LIMIT 501`,
    [organizationId, input.propertyIds?.length ? [...input.propertyIds] : null],
  );
  const visible = rows.filter(row => row.legal_entity_id !== null && grantCovers(context.principal, row.legal_entity_id, row.property_id));
  return {
    documents: visible.slice(0, 500).map(row => ({ id: row.id, propertyId: row.property_id, propertyName: row.property_name, kind: row.kind, title: row.title, documentDate: row.document_date, fileName: row.file_name, uploadedAt: timestampText(row.uploaded_at) })),
    truncated: rows.length > 500,
  };
}

/**
 * Unit costs from active project templates and from completed projects' scope
 * lines. Template and project reads are organization-scoped; project lines are
 * limited to properties the principal may read.
 */
export async function readCostLibrary(context: WorkspaceReadContext, input: { search?: string; limit: number; cursor?: string; asOf: string }): Promise<CostLibrary> {
  const organizationId = context.principal.organizationId;
  const search = input.search?.trim() ? `%${input.search.trim().toLowerCase().replace(/[\\%_]/g, character => `\\${character}`)}%` : null;
  const after = decodeCursor(input.cursor, 2);
  const templatesVisible = organizationWide(context.principal);
  const mappings = await authorizedPropertyMappings(context, input.asOf);
  const propertyIds = Array.from(mappings.keys());
  const { rows } = await context.executor.query<{
    sort_key: string; row_id: string; source: "template" | "completed_project"; source_id: string; source_name: string; project_type: string;
    description: string; category: string | null; unit_label: string | null; quantity: string; rate_cents: unknown; estimated_cents: unknown;
    currency: string; property_name: string | null; updated_on: string | null;
  }>(
    `SELECT * FROM (
       SELECT lower(i.description) AS sort_key, i.id::text AS row_id, 'template' AS source, t.id AS source_id, t.name AS source_name, t.project_type,
              i.description, i.category, i.unit_label, i.quantity::text AS quantity, i.rate_cents, NULL::bigint AS estimated_cents,
              coalesce(t.currency, 'USD') AS currency, NULL::text AS property_name, NULL::text AS updated_on
         FROM company_project_template_scope_items i
         JOIN company_project_templates t ON t.organization_id = i.organization_id AND t.id = i.template_id
        WHERE i.organization_id = $1 AND t.active AND $2::boolean
       UNION ALL
       SELECT lower(s.description), s.id::text, 'completed_project', p.id, p.name, p.project_type,
              s.description, s.category, s.unit_label, s.quantity::text, s.rate_cents, s.estimated_cents,
              p.currency, pr.name, to_char(p.updated_at, 'YYYY-MM-DD')
         FROM company_project_scope_items s
         JOIN company_projects p ON p.organization_id = s.organization_id AND p.id = s.project_id
         LEFT JOIN rent_ops_properties pr ON pr.id = p.property_id
        WHERE s.organization_id = $1 AND s.archived_at IS NULL AND p.status = 'completed' AND p.property_id = ANY($3::text[])
     ) library
     WHERE ($4::text IS NULL OR sort_key LIKE $4 ESCAPE '\\' OR lower(coalesce(category, '')) LIKE $4 ESCAPE '\\' OR lower(source_name) LIKE $4 ESCAPE '\\')
       AND ($5::text IS NULL OR (sort_key, row_id) > ($5::text, $6::text))
     ORDER BY sort_key, row_id LIMIT $7`,
    [organizationId, templatesVisible, propertyIds, search, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1],
  );
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map(row => ({
      source: row.source, sourceId: row.source_id, sourceName: row.source_name, projectType: row.project_type,
      description: row.description, category: row.category, unitLabel: row.unit_label, quantity: row.quantity,
      rateCents: centsValue(row.rate_cents)!.toString(), estimatedCents: centsValue(row.estimated_cents)?.toString() ?? null,
      currency: row.currency, propertyName: row.property_name, updatedOn: dateText(row.updated_on),
    })),
    nextCursor: rows.length > input.limit && last ? encodeCursor([last.sort_key, last.row_id]) : null,
  };
}

