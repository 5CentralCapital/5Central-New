import { legalEntityIdSchema, organizationIdSchema, propertyReferenceIdSchema } from "../../shared/company";
import { plannedPropertyPlanListSchema, type PlannedPropertyPlanList, type PropertyCommandKind } from "../../shared/company/property-contracts";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { executePropertyCommand, type PropertyCommandExecutionOptions } from "./property-commands";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "./authorization";
import { ForbiddenCommandError } from "./commands/errors";
import { dbDate, dbRevision, dbString, dbTimestamp } from "../projects/helpers";

/** Shared property setup adapter used by the web and Codex transports. */
export interface CompanyPropertyPort {
  execute(kind: PropertyCommandKind, envelope: unknown, options: PropertyCommandExecutionOptions): Promise<import("../../shared/company").OperationReceipt>;
  listPlanned(principal: AuthenticatedPrincipal, input: { organizationId: string; legalEntityId?: string }): Promise<PlannedPropertyPlanList>;
}

export function createCompanyPropertyPort(executor: RentOpsQueryExecutor): CompanyPropertyPort {
  return {
    execute: (kind, envelope, options) => executePropertyCommand(executor, kind, envelope, options),
    async listPlanned(principal, input) {
      const organizationId = organizationIdSchema.parse(input.organizationId);
      const legalEntityId = input.legalEntityId === undefined ? undefined : legalEntityIdSchema.parse(input.legalEntityId);
      authorizeCompanyRead(principal, { organizationId, ...(legalEntityId === undefined ? {} : { legalEntityId }) }, ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"]);
      const result = await executor.query<Record<string, unknown>>(
        `SELECT plan.id, plan.organization_id, plan.legal_entity_id, plan.property_id,
                p.name AS property_name, le.name AS legal_entity_name, le.currency,
                plan.assignment_start_on, plan.status, plan.notes, plan.record_revision,
                plan.created_at, plan.updated_at
           FROM company_project_property_plans plan
           JOIN company_organizations o ON o.id = plan.organization_id AND o.archived_at IS NULL
           JOIN company_legal_entities le ON le.organization_id = plan.organization_id AND le.id = plan.legal_entity_id AND le.archived_at IS NULL
           JOIN rent_ops_properties p ON p.id = plan.property_id AND p.state_status <> 'archived'
          WHERE plan.organization_id = $1
            AND plan.status = 'planned'
            AND ($2::uuid IS NULL OR plan.legal_entity_id = $2)
          ORDER BY p.name, p.id, plan.id`,
        [organizationId, legalEntityId ?? null],
      );
      const items = [];
      for (const row of result.rows) {
        const rowScope = { organizationId, legalEntityId: legalEntityIdSchema.parse(dbString(row.legal_entity_id, "planned_property_legal_entity_id")), propertyId: propertyReferenceIdSchema.parse(dbString(row.property_id, "planned_property_id")) };
        try {
          authorizeCompanyRead(principal, rowScope, ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"]);
        } catch (error) {
          if (error instanceof ForbiddenCommandError) continue;
          throw error;
        }
        items.push({
          id: dbString(row.id, "planned_property_plan_id"),
          organizationId,
          legalEntityId: rowScope.legalEntityId,
          propertyId: rowScope.propertyId,
          propertyName: dbString(row.property_name, "planned_property_name"),
          legalEntityName: dbString(row.legal_entity_name, "planned_property_legal_entity_name"),
          currency: dbString(row.currency, "planned_property_currency"),
          assignmentStartOn: dbDate(row.assignment_start_on, "planned_property_assignment_start_on"),
          status: dbString(row.status, "planned_property_status"),
          notes: row.notes === null || row.notes === undefined ? null : dbString(row.notes, "planned_property_notes"),
          recordRevision: dbRevision(row.record_revision, "planned_property_record_revision"),
          createdAt: dbTimestamp(row.created_at, "planned_property_created_at"),
          updatedAt: dbTimestamp(row.updated_at, "planned_property_updated_at"),
        });
      }
      return plannedPropertyPlanListSchema.parse({ items });
    },
  };
}
