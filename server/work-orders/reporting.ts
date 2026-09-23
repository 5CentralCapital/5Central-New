import { companyScopeSchema, isoDateSchema, type CompanyScope } from "../../shared/company";
import {
  workOrderReference,
  workOrderReportPageSchema,
  workOrderReportQuerySchema,
  workOrderAgingDays,
  workOrderTargetOn,
  type WorkOrderPriority,
  type WorkOrderReportPage,
  type WorkOrderReportQuery,
} from "../../shared/work-orders";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { dbDate, dbNullableCents, dbNullableDate, dbNullableString, dbString } from "../projects/helpers";
import { DERIVED_JOINS, TARGET_ON_SQL, WORK_ORDER_READ_ROLES, actualCostFrom, mapVendor, operatingDate } from "./service";

/** The read the reporting engine uses; it never mutates and never bypasses grants. */
export interface WorkOrderReportingReadPort {
  listForReporting(principal: AuthenticatedPrincipal, query: WorkOrderReportQuery): Promise<WorkOrderReportPage>;
}

interface ReportCursor { readonly reportedOn: string; readonly id: string }

function encodeCursor(value: ReportCursor): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeCursor(value: string | undefined): ReportCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/.test(parsed.id)) throw new Error("id");
    return { reportedOn: isoDateSchema.parse(parsed.reportedOn), id: parsed.id };
  } catch {
    throw new ValidationCommandError("Work order report cursor is invalid", { reason: "invalid_work_order_report_cursor" });
  }
}

/**
 * Bounded report rows with aging, target date, estimated and actual cost and
 * completion. Filters: property, status, assignee (free text or vendor name),
 * vendor, priority, category (type), target-date and reported-date windows.
 */
export async function listWorkOrdersForReporting(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: WorkOrderReportQuery, today: () => string = () => operatingDate()): Promise<WorkOrderReportPage> {
  const query = workOrderReportQuerySchema.parse(input);
  const scope: CompanyScope = companyScopeSchema.parse(query.scope);
  authorizeCompanyRead(principal, scope, WORK_ORDER_READ_ROLES);
  if (scope.propertyId && query.propertyIds?.some(propertyId => propertyId !== scope.propertyId)) throw new ForbiddenCommandError("Report properties are outside the requested scope", { reason: "work_order_property_scope" });
  const asOf = query.asOf ?? today();
  const values: unknown[] = [scope.organizationId, scope.legalEntityId ?? null, scope.propertyId ?? null];
  const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const where = ["w.organization_id = $1", "($2::uuid IS NULL OR w.legal_entity_id = $2)", "($3::varchar IS NULL OR w.property_id = $3)"];
  if (query.propertyIds) where.push(`w.property_id = ANY(${add(query.propertyIds)}::varchar[])`);
  if (query.statuses) where.push(`w.status = ANY(${add(query.statuses)}::text[])`);
  if (query.priorities) where.push(`w.priority = ANY(${add(query.priorities)}::text[])`);
  if (query.categories) where.push(`w.category = ANY(${add(query.categories)}::text[])`);
  if (query.assignee) { const term = add(query.assignee); where.push(`(w.assigned_to ILIKE '%' || ${term} || '%' OR va.vendor->>'name' ILIKE '%' || ${term} || '%')`); }
  if (query.vendorId) where.push(`va.vendor->>'id' = ${add(query.vendorId)}`);
  if (query.dueFrom) where.push(`${TARGET_ON_SQL} >= ${add(query.dueFrom)}::date`);
  if (query.dueThrough) where.push(`${TARGET_ON_SQL} <= ${add(query.dueThrough)}::date`);
  if (query.reportedFrom) where.push(`w.reported_on >= ${add(query.reportedFrom)}::date`);
  if (query.reportedThrough) where.push(`w.reported_on <= ${add(query.reportedThrough)}::date`);
  const cursor = decodeCursor(query.cursor);
  if (cursor) where.push(`(w.reported_on, w.id) < (${add(cursor.reportedOn)}::date, ${add(cursor.id)}::uuid)`);
  const limit = add(query.limit + 1);
  const result = await executor.query<Record<string, unknown>>(
    `SELECT w.id, w.legal_entity_id, w.property_id, p.name AS property_name, w.unit_id, u.unit_number, w.project_id, w.title, w.category, w.priority, w.status,
            w.reported_on, w.scheduled_on, w.completed_on, w.assigned_to, w.currency, w.estimated_cost_cents::text AS estimated_cost_cents,
            va.vendor, ma.manual, wa.linked_cents, wa.linked_count
       FROM company_work_orders w
       JOIN rent_ops_properties p ON p.id = w.property_id
       LEFT JOIN rent_ops_units u ON u.id = w.unit_id
       ${DERIVED_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY w.reported_on DESC, w.id DESC
      LIMIT ${limit}`,
    values,
  );
  const rows = result.rows.slice(0, query.limit);
  const items = rows.map(row => {
    const id = dbString(row.id, "id");
    const reportedOn = dbDate(row.reported_on, "reported_on");
    const completedOn = dbNullableDate(row.completed_on, "completed_on");
    const status = dbString(row.status, "status");
    const priority = dbString(row.priority, "priority") as WorkOrderPriority;
    const cost = actualCostFrom(row);
    const targetOn = workOrderTargetOn(reportedOn, priority);
    const completed = status === "completed";
    return {
      id, reference: workOrderReference(id), legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"), propertyId: dbString(row.property_id, "property_id"),
      propertyName: dbNullableString(row.property_name, "property_name"), unitId: dbNullableString(row.unit_id, "unit_id"), unitNumber: dbNullableString(row.unit_number, "unit_number"),
      projectId: dbNullableString(row.project_id, "project_id"), title: dbString(row.title, "title"), category: dbString(row.category, "category"), priority, status,
      reportedOn, scheduledOn: dbNullableDate(row.scheduled_on, "scheduled_on"), targetOn, completedOn,
      agingDays: workOrderAgingDays({ reportedOn, completedOn, status }, asOf),
      overdue: !completed && status !== "canceled" && targetOn < asOf,
      assignedTo: dbNullableString(row.assigned_to, "assigned_to"), vendor: mapVendor(row.vendor), currency: dbString(row.currency, "currency"),
      estimatedCostCents: dbNullableCents(row.estimated_cost_cents, "estimated_cost_cents"), linkedActualCents: cost.linkedCents, manualActualCents: cost.manualCents, actualCostState: cost.state,
      completed, daysToComplete: completed && completedOn ? workOrderAgingDays({ reportedOn, completedOn, status }, asOf) : null,
    };
  });
  const last = rows.at(-1);
  return workOrderReportPageSchema.parse({ asOf, items, nextCursor: result.rows.length > query.limit && last ? encodeCursor({ reportedOn: dbDate(last.reported_on, "reported_on"), id: dbString(last.id, "id") }) : null });
}
