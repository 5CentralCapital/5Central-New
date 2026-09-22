import { companyScopeSchema, isoDateSchema, type CompanyScope } from "../../shared/company";
import {
  WORK_ORDER_OPEN_STATUSES,
  allowedWorkOrderTransitions,
  workOrderDetailSchema,
  workOrderEventSchema,
  workOrderIdSchema,
  workOrderListQuerySchema,
  workOrderListResponseSchema,
  workOrderReference,
  workOrderSummarySchema,
  workOrderTenantOptionsResponseSchema,
  type WorkOrderDetail,
  type WorkOrderListQuery,
  type WorkOrderListResponse,
  type WorkOrderStatus,
  type WorkOrderSummary,
  type WorkOrderTenantOptionsResponse,
} from "../../shared/work-orders";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { dbDate, dbNullableCents, dbNullableDate, dbNullableString, dbRevision, dbString, dbTimestamp } from "../projects/helpers";

export const WORK_ORDER_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

const PRIORITY_RANK = `CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

const summarySelect = `
  SELECT w.id, w.organization_id, w.legal_entity_id, w.property_id, p.name AS property_name,
         w.unit_id, u.unit_number, w.tenancy_id, w.person_id,
         NULLIF(btrim(concat_ws(' ', pe.first_name, pe.last_name)), '') AS person_name,
         w.project_id, pr.name AS project_name, w.title, w.description, w.category, w.priority, w.status,
         w.reported_on, w.scheduled_on, w.completed_on, w.assigned_to, w.entry_permitted, w.currency,
         w.estimated_cost_cents::text AS estimated_cost_cents, w.chargeback_amount_cents::text AS chargeback_amount_cents,
         w.chargeback_description, w.chargeback_ledger_transaction_id,
         w.record_revision, w.created_by, w.updated_by, w.created_at, w.updated_at,
         ${PRIORITY_RANK} AS priority_rank
    FROM company_work_orders w
    JOIN rent_ops_properties p ON p.id = w.property_id
    LEFT JOIN rent_ops_units u ON u.id = w.unit_id
    LEFT JOIN rent_ops_people pe ON pe.id = w.person_id
    LEFT JOIN company_projects pr ON pr.organization_id = w.organization_id AND pr.id = w.project_id`;

function mapSummary(row: Record<string, unknown>): WorkOrderSummary {
  const id = dbString(row.id, "id");
  const chargebackAmount = dbNullableCents(row.chargeback_amount_cents, "chargeback_amount_cents");
  const ledgerTransactionId = dbNullableString(row.chargeback_ledger_transaction_id, "chargeback_ledger_transaction_id");
  return workOrderSummarySchema.parse({
    id,
    reference: workOrderReference(id),
    organizationId: dbString(row.organization_id, "organization_id"),
    legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"),
    propertyId: dbString(row.property_id, "property_id"),
    propertyName: dbNullableString(row.property_name, "property_name"),
    unitId: dbNullableString(row.unit_id, "unit_id"),
    unitNumber: dbNullableString(row.unit_number, "unit_number"),
    tenancyId: dbNullableString(row.tenancy_id, "tenancy_id"),
    personId: dbNullableString(row.person_id, "person_id"),
    personName: dbNullableString(row.person_name, "person_name"),
    projectId: dbNullableString(row.project_id, "project_id"),
    projectName: dbNullableString(row.project_name, "project_name"),
    title: dbString(row.title, "title"),
    category: dbString(row.category, "category"),
    priority: dbString(row.priority, "priority"),
    status: dbString(row.status, "status"),
    reportedOn: dbDate(row.reported_on, "reported_on"),
    scheduledOn: dbNullableDate(row.scheduled_on, "scheduled_on"),
    completedOn: dbNullableDate(row.completed_on, "completed_on"),
    assignedTo: dbNullableString(row.assigned_to, "assigned_to"),
    entryPermitted: row.entry_permitted === true,
    currency: dbString(row.currency, "currency"),
    estimatedCostCents: dbNullableCents(row.estimated_cost_cents, "estimated_cost_cents"),
    chargeback: chargebackAmount === null ? null : {
      amountCents: chargebackAmount,
      description: dbString(row.chargeback_description, "chargeback_description"),
      ledgerTransactionId,
      state: ledgerTransactionId ? "charge_linked" : "intent_only",
    },
    recordRevision: dbRevision(row.record_revision),
    createdBy: dbString(row.created_by, "created_by"),
    updatedBy: dbString(row.updated_by, "updated_by"),
    createdAt: dbTimestamp(row.created_at, "created_at"),
    updatedAt: dbTimestamp(row.updated_at, "updated_at"),
  });
}

interface Cursor { rank: number; reportedOn: string; id: string }

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.rank !== "number" || !Number.isInteger(parsed.rank) || parsed.rank < 0 || parsed.rank > 3) throw new Error("rank");
    return { rank: parsed.rank, reportedOn: isoDateSchema.parse(parsed.reportedOn), id: workOrderIdSchema.parse(parsed.id) };
  } catch {
    throw new ValidationCommandError("Work order cursor is invalid", { reason: "invalid_work_order_cursor" });
  }
}

function scopePredicates(scope: CompanyScope, values: unknown[]): string[] {
  values.push(scope.organizationId, scope.legalEntityId ?? null, scope.propertyId ?? null);
  return [`w.organization_id = $1`, `($2::uuid IS NULL OR w.legal_entity_id = $2)`, `($3::varchar IS NULL OR w.property_id = $3)`];
}

/** Scoped work order reads; grants are checked exactly as project reads are. */
export class WorkOrderReadService {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  async list(principal: AuthenticatedPrincipal, input: WorkOrderListQuery): Promise<WorkOrderListResponse> {
    const query = workOrderListQuerySchema.parse(input);
    authorizeCompanyRead(principal, query.scope, WORK_ORDER_READ_ROLES);
    const cursor = decodeCursor(query.cursor);
    const values: unknown[] = [];
    const where = scopePredicates(query.scope, values);
    const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    const statuses: readonly WorkOrderStatus[] | undefined = query.statuses ?? (query.openOnly ? WORK_ORDER_OPEN_STATUSES : undefined);
    if (statuses) where.push(`w.status = ANY(${add([...statuses])}::text[])`);
    if (query.priorities) where.push(`w.priority = ANY(${add([...query.priorities])}::text[])`);
    if (query.categories) where.push(`w.category = ANY(${add([...query.categories])}::text[])`);
    if (query.unitId) where.push(`w.unit_id = ${add(query.unitId)}`);
    if (query.assignedTo) where.push(`w.assigned_to ILIKE '%' || ${add(query.assignedTo)} || '%'`);
    if (query.search) {
      const term = add(query.search);
      const reference = add(query.search.replace(/^wo-?/i, "").replace(/-/g, "").toLowerCase());
      where.push(`(w.title ILIKE '%' || ${term} || '%' OR w.description ILIKE '%' || ${term} || '%'
        OR w.assigned_to ILIKE '%' || ${term} || '%' OR p.name ILIKE '%' || ${term} || '%'
        OR u.unit_number ILIKE '%' || ${term} || '%' OR concat_ws(' ', pe.first_name, pe.last_name) ILIKE '%' || ${term} || '%'
        OR (length(${reference}) >= 4 AND replace(w.id::text, '-', '') LIKE ${reference} || '%'))`);
    }
    if (cursor) {
      const rank = add(cursor.rank); const reported = add(cursor.reportedOn); const id = add(cursor.id);
      where.push(`(${PRIORITY_RANK} > ${rank} OR (${PRIORITY_RANK} = ${rank} AND (w.reported_on < ${reported}::date OR (w.reported_on = ${reported}::date AND w.id < ${id}::uuid))))`);
    }
    const limit = add(query.limit + 1);
    const result = await this.executor.query<Record<string, unknown>>(
      `${summarySelect} WHERE ${where.join(" AND ")} ORDER BY priority_rank ASC, w.reported_on DESC, w.id DESC LIMIT ${limit}`,
      values,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    const items = rows.map(mapSummary);
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ rank: Number(last.priority_rank), reportedOn: dbDate(last.reported_on, "reported_on"), id: dbString(last.id, "id") }) : null;
    return workOrderListResponseSchema.parse({ items, nextCursor });
  }

  async get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; workOrderId: string }): Promise<WorkOrderDetail> {
    const scope = companyScopeSchema.parse(input.scope);
    authorizeCompanyRead(principal, scope, WORK_ORDER_READ_ROLES);
    const workOrderId = workOrderIdSchema.parse(input.workOrderId);
    const values: unknown[] = [];
    const where = scopePredicates(scope, values);
    values.push(workOrderId);
    where.push(`w.id = $${values.length}`);
    const result = await this.executor.query<Record<string, unknown>>(`${summarySelect} WHERE ${where.join(" AND ")}`, values);
    const row = result.rows[0];
    if (!row) throw new ValidationCommandError("Work order was not found in the requested company scope", { reason: "work_order_not_found" });
    const summary = mapSummary(row);
    const events = await this.executor.query<Record<string, unknown>>(
      `SELECT id, event_type, from_status, to_status, note, details, record_revision, actor_id, created_at
         FROM company_work_order_events
        WHERE organization_id = $1 AND work_order_id = $2
        ORDER BY record_revision, created_at, id`,
      [scope.organizationId, workOrderId],
    );
    const history = events.rows.map(event => workOrderEventSchema.parse({
      id: dbString(event.id, "event_id"),
      type: dbString(event.event_type, "event_type"),
      fromStatus: dbNullableString(event.from_status, "from_status"),
      toStatus: dbNullableString(event.to_status, "to_status"),
      note: dbNullableString(event.note, "note"),
      details: typeof event.details === "string" ? JSON.parse(event.details) : event.details ?? {},
      recordRevision: dbRevision(event.record_revision),
      actorId: dbString(event.actor_id, "actor_id"),
      createdAt: dbTimestamp(event.created_at, "created_at"),
    }));
    return workOrderDetailSchema.parse({
      ...summary,
      description: dbNullableString(row.description, "description"),
      allowedTransitions: [...allowedWorkOrderTransitions(summary.status)],
      history,
    });
  }

  /** Existing tenancies at one property, for linking a tenant or chargeback. */
  async tenantOptions(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; propertyId: string }): Promise<WorkOrderTenantOptionsResponse> {
    const scope = companyScopeSchema.parse(input.scope);
    if (scope.propertyId !== undefined && scope.propertyId !== input.propertyId) {
      throw new ValidationCommandError("Property is outside the requested scope", { reason: "work_order_property_scope" });
    }
    const propertyScope = companyScopeSchema.parse({ ...scope, propertyId: input.propertyId });
    if (propertyScope.legalEntityId === undefined) throw new ValidationCommandError("Tenant options require a legal entity scope", { reason: "work_order_entity_scope_required" });
    authorizeCompanyRead(principal, propertyScope, WORK_ORDER_READ_ROLES);
    const mapped = await this.executor.query(
      `SELECT 1 FROM company_property_entity_periods
        WHERE organization_id = $1 AND legal_entity_id = $2 AND property_id = $3 LIMIT 1`,
      [propertyScope.organizationId, propertyScope.legalEntityId, input.propertyId],
    );
    if (!mapped.rows.length) throw new ValidationCommandError("Property is not mapped to the legal entity", { reason: "property_entity_mapping" });
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT t.id AS tenancy_id, t.primary_person_id AS person_id, t.unit_id, u.unit_number, t.status,
              NULLIF(btrim(concat_ws(' ', pe.first_name, pe.last_name)), '') AS person_name
         FROM rent_ops_tenancies t
         JOIN rent_ops_people pe ON pe.id = t.primary_person_id
         LEFT JOIN rent_ops_units u ON u.id = t.unit_id
        WHERE t.property_id = $1 AND t.status <> 'cancelled'
        ORDER BY CASE t.status WHEN 'current' THEN 0 WHEN 'notice' THEN 1 WHEN 'future' THEN 2 ELSE 3 END, u.unit_number, pe.last_name, t.id
        LIMIT 500`,
      [input.propertyId],
    );
    return workOrderTenantOptionsResponseSchema.parse({
      items: result.rows.map(row => ({
        tenancyId: dbString(row.tenancy_id, "tenancy_id"),
        personId: dbString(row.person_id, "person_id"),
        personName: dbNullableString(row.person_name, "person_name") ?? "Unnamed tenant",
        unitId: dbNullableString(row.unit_id, "unit_id"),
        unitNumber: dbNullableString(row.unit_number, "unit_number"),
        status: dbString(row.status, "status"),
      })),
    });
  }
}
