import { companyScopeSchema, type CompanyScope } from "../../../shared/company";
import { reportReferencePageSchema, type ReportReferenceKind, type ReportReferencePage } from "../../../shared/reporting";
import type { AuthenticatedPrincipal } from "../../company/authorization";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import { ReportingError } from "../errors";
import type { ReportingReferenceReader } from "../service";
import { decodeCursor, encodeCursor } from "../utils";
import { principalScopes, scopePredicate } from "./scope";
import type { ConsolidationMappingReadPort } from "./mirror-financial";

interface ReferenceRow { value: unknown; label: unknown; detail: unknown }

/**
 * Searchable, grant-bounded reference choices for report setup. Every list
 * is limited to the principal's authorized entity/property scopes and, when
 * given, to the legal entities selected in setup.
 */
export function createPostgresReportReferenceReader(deps: { readonly executor: RentOpsQueryExecutor; readonly environment: "sandbox" | "production" | null; readonly consolidation?: ConsolidationMappingReadPort }): ReportingReferenceReader {
  return {
    async list(principal: AuthenticatedPrincipal, query): Promise<ReportReferencePage> {
      const organizationId = principal.organizationId;
      if (query.kind === "elimination_version") {
        const versions = deps.consolidation?.listEliminationVersions ? await deps.consolidation.listEliminationVersions(organizationId) : [];
        const search = query.search?.trim().toLocaleLowerCase() ?? "";
        const items = versions.filter(item => !search || item.label.toLocaleLowerCase().includes(search)).slice(0, query.limit).map(item => ({ value: item.version, label: item.label, detail: item.approvedOn ? `Approved ${item.approvedOn}` : null }));
        return reportReferencePageSchema.parse({ kind: query.kind, items, nextCursor: null, reason: items.length ? null : "No approved elimination versions yet." });
      }
      let scopes: CompanyScope[] = principalScopes(principal, organizationId);
      if (query.legalEntityIds.length) {
        const allowed = new Set(query.legalEntityIds.map(String));
        scopes = scopes.some(scope => !scope.legalEntityId)
          ? query.legalEntityIds.map(legalEntityId => companyScopeSchema.parse({ organizationId, legalEntityId }))
          : scopes.filter(scope => scope.legalEntityId && allowed.has(scope.legalEntityId));
      }
      const cursor = decodeCursor<{ kind: string; search: string; offset: number }>(query.cursor);
      const search = query.search?.trim() ?? "";
      if (query.cursor && (!cursor || cursor.kind !== query.kind || cursor.search !== search || !Number.isInteger(cursor.offset) || cursor.offset < 0)) throw new ReportingError("report_validation", "Reference cursor is invalid", 400);
      const offset = cursor?.offset ?? 0;
      const values: unknown[] = [organizationId, search || null];
      let sql: string;
      let reason: string | null = null;
      const entityProperty = (entityColumn: string, propertyColumn: string | null) => scopePredicate(scopes, values, entityColumn, propertyColumn);
      // Staff, investors and accounts belong to a whole legal entity, so a
      // property-limited grant never lists them.
      const entityScopes = scopes.filter(scope => !scope.propertyId);
      const entityOnly = (entityColumn: string) => scopePredicate(entityScopes, values, entityColumn, null);
      const organizationWide = scopes.some(scope => !scope.legalEntityId);
      const entityLevelKinds: readonly ReportReferenceKind[] = ["investor", "owner", "staff", "account"];
      if (entityLevelKinds.includes(query.kind as ReportReferenceKind) && scopes.length && !entityScopes.length) reason = "This list needs access to a whole legal entity.";
      switch (query.kind as ReportReferenceKind) {
        case "project":
          sql = `SELECT p.id::text AS value, p.name AS label, rp.name AS detail FROM company_projects p JOIN rent_ops_properties rp ON rp.id=p.property_id
                  WHERE p.organization_id=$1 AND p.archived_at IS NULL AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%') AND ${entityProperty("p.legal_entity_id", "p.property_id")}
                  ORDER BY lower(p.name), p.id`;
          break;
        case "vendor":
          sql = `SELECT v.id::text AS value, v.name AS label, v.status AS detail FROM company_project_vendors v
                  WHERE v.organization_id=$1 AND ($2::text IS NULL OR v.name ILIKE '%' || $2 || '%')
                    AND (${organizationWide ? "true" : `EXISTS (SELECT 1 FROM company_projects p
                          WHERE p.organization_id=v.organization_id AND ${entityProperty("p.legal_entity_id", "p.property_id")}
                            AND (EXISTS (SELECT 1 FROM company_project_commitments c WHERE c.organization_id=p.organization_id AND c.project_id=p.id AND c.vendor_id=v.id)
                              OR EXISTS (SELECT 1 FROM company_project_bids b WHERE b.organization_id=p.organization_id AND b.project_id=p.id AND b.vendor_id=v.id)))`})
                  ORDER BY lower(v.name), v.id`;
          break;
        case "investor":
        case "owner":
          sql = `SELECT a.id::text AS value, a.display_name AS label, a.status AS detail FROM company_investor_accounts a
                  WHERE a.organization_id=$1 AND a.archived_at IS NULL AND ($2::text IS NULL OR a.display_name ILIKE '%' || $2 || '%')
                    AND (${organizationWide ? "true" : `EXISTS (SELECT 1 FROM company_investor_instruments i WHERE i.organization_id=a.organization_id AND i.account_id=a.id AND i.archived_at IS NULL AND ${entityOnly("i.legal_entity_id")})`})
                  ORDER BY lower(a.display_name), a.id`;
          break;
        case "staff":
          sql = `SELECT u.provider_user_id AS value, u.display_name AS label, CASE WHEN u.active THEN NULL ELSE 'Inactive' END AS detail FROM time_source_users u
                  WHERE u.organization_id=$1 AND u.deleted_at IS NULL AND ($2::text IS NULL OR u.display_name ILIKE '%' || $2 || '%') AND ${entityOnly("u.legal_entity_id")}
                  ORDER BY lower(u.display_name), u.provider_user_id`;
          break;
        case "account":
          if (deps.environment === null) return reportReferencePageSchema.parse({ kind: query.kind, items: [], nextCursor: null, reason: "Connect QuickBooks to choose accounts." });
          values.push(deps.environment);
          sql = `SELECT DISTINCT ON (o.object_id) o.object_id AS value,
                        COALESCE(o.provider_body->>'FullyQualifiedName', o.provider_body->>'Name', 'Account ' || o.object_id) AS label, e.name AS detail
                   FROM accounting_qbo_source_objects o JOIN company_legal_entities e ON e.organization_id=o.organization_id AND e.id=o.legal_entity_id
                  WHERE o.organization_id=$1 AND o.object_type='Account' AND o.deleted_at IS NULL AND o.environment=$${values.length}
                    AND ($2::text IS NULL OR COALESCE(o.provider_body->>'FullyQualifiedName', o.provider_body->>'Name', '') ILIKE '%' || $2 || '%')
                    AND ${entityOnly("o.legal_entity_id")}
                  ORDER BY o.object_id, o.provider_updated_at DESC NULLS LAST, o.received_at DESC`;
          sql = `SELECT * FROM (${sql}) accounts ORDER BY lower(label), value`;
          break;
        case "tenant":
        case "tenancy": {
          const mapped = `EXISTS (SELECT 1 FROM company_property_entity_periods m WHERE m.organization_id=$1 AND m.property_id=t.property_id AND ${entityProperty("m.legal_entity_id", "m.property_id")})`;
          sql = query.kind === "tenant"
            ? `SELECT DISTINCT pe.id AS value, NULLIF(btrim(concat_ws(' ', pe.first_name, pe.last_name)), '') AS label, NULL::text AS detail
                 FROM rent_ops_tenancies t JOIN rent_ops_people pe ON pe.id=t.primary_person_id
                WHERE t.status <> 'cancelled' AND ($2::text IS NULL OR concat_ws(' ', pe.first_name, pe.last_name) ILIKE '%' || $2 || '%') AND ${mapped}`
            : `SELECT t.id AS value, NULLIF(btrim(concat_ws(' ', pe.first_name, pe.last_name)), '') AS label, concat_ws(' · ', rp.name, u.unit_number, t.status) AS detail
                 FROM rent_ops_tenancies t JOIN rent_ops_people pe ON pe.id=t.primary_person_id JOIN rent_ops_properties rp ON rp.id=t.property_id LEFT JOIN rent_ops_units u ON u.id=t.unit_id
                WHERE t.status <> 'cancelled' AND ($2::text IS NULL OR concat_ws(' ', pe.first_name, pe.last_name, rp.name, u.unit_number) ILIKE '%' || $2 || '%') AND ${mapped}`;
          sql = `SELECT * FROM (${sql}) people WHERE label IS NOT NULL ORDER BY lower(label), value`;
          break;
        }
        default:
          throw new ReportingError("report_validation", "Reference kind is not supported", 400);
      }
      if (!scopes.length) reason = "No authorized records for this selection.";
      values.push(offset, query.limit + 1);
      const result = await deps.executor.query<ReferenceRow>(`${sql} OFFSET $${values.length - 1} LIMIT $${values.length}`, values);
      const rows = result.rows.slice(0, query.limit);
      return reportReferencePageSchema.parse({
        kind: query.kind,
        items: rows.map(row => ({ value: String(row.value), label: String(row.label ?? row.value).slice(0, 240), detail: row.detail === null || row.detail === undefined || row.detail === "" ? null : String(row.detail).slice(0, 240) })),
        nextCursor: result.rows.length > query.limit ? encodeCursor({ kind: query.kind, search, offset: offset + rows.length }) : null,
        reason,
      });
    },
  };
}
