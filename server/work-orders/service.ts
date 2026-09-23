import { companyScopeSchema, isoDateSchema, type CompanyScope } from "../../shared/company";
import { financialSourceReferenceSchema } from "../../shared/accounting/source";
import {
  WORK_ORDER_OPEN_STATUSES,
  WORK_ORDER_TARGET_DAYS,
  allowedWorkOrderTransitions,
  workOrderAgingDays,
  workOrderDetailSchema,
  workOrderDocumentOptionsResponseSchema,
  workOrderEventSchema,
  workOrderIdSchema,
  workOrderListQuerySchema,
  workOrderListResponseSchema,
  workOrderReference,
  workOrderSummarySchema,
  workOrderTargetOn,
  workOrderTenantOptionsResponseSchema,
  workOrderVendorOptionsResponseSchema,
  workOrderVendorSchema,
  type WorkOrderDetail,
  type WorkOrderDocumentOptionsResponse,
  type WorkOrderListQuery,
  type WorkOrderListResponse,
  type WorkOrderPriority,
  type WorkOrderStatus,
  type WorkOrderSummary,
  type WorkOrderTenantOptionsResponse,
  type WorkOrderVendor,
  type WorkOrderVendorOptionsResponse,
} from "../../shared/work-orders";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { nowIsoDate } from "../rent-ops/domain/dates";
import { dbDate, dbNullableCents, dbNullableDate, dbNullableString, dbRevision, dbString, dbTimestamp } from "../projects/helpers";

export const WORK_ORDER_READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;
export const WORK_ORDER_COST_CONSUMER_KIND = "work_order" as const;

export const PRIORITY_RANK = `CASE w.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;
export const TARGET_ON_SQL = `(w.reported_on + (CASE w.priority WHEN 'emergency' THEN 1 WHEN 'high' THEN 3 WHEN 'normal' THEN 7 ELSE 14 END))`;

/**
 * Vendor, manual actual and attachment state are derived from the
 * append-only event history (event details are the designed place for
 * structured activity). QBO costs are the work order's rows in the central
 * allocation ledger, so a bill line can never be counted twice.
 */
export const DERIVED_JOINS = `
    LEFT JOIN LATERAL (
      SELECT e.details->'vendorAssignment' AS vendor FROM company_work_order_events e
       WHERE e.organization_id = w.organization_id AND e.work_order_id = w.id AND e.details ? 'vendorAssignment'
       ORDER BY e.record_revision DESC, e.created_at DESC, e.id DESC LIMIT 1
    ) va ON true
    LEFT JOIN LATERAL (
      SELECT e.details->'manualActual' AS manual FROM company_work_order_events e
       WHERE e.organization_id = w.organization_id AND e.work_order_id = w.id AND e.details ? 'manualActual'
       ORDER BY e.record_revision DESC, e.created_at DESC, e.id DESC LIMIT 1
    ) ma ON true
    LEFT JOIN LATERAL (
      SELECT SUM(x.amount_cents)::text AS linked_cents, COUNT(*) AS linked_count FROM accounting_qbo_source_line_allocations x
       WHERE x.organization_id = w.organization_id AND x.consumer_kind = '${WORK_ORDER_COST_CONSUMER_KIND}' AND x.consumer_id = w.id::text
    ) wa ON true`;

const summarySelect = `
  SELECT w.id, w.organization_id, w.legal_entity_id, w.property_id, p.name AS property_name,
         w.unit_id, u.unit_number, w.tenancy_id, w.person_id,
         NULLIF(btrim(concat_ws(' ', pe.first_name, pe.last_name)), '') AS person_name,
         w.project_id, pr.name AS project_name, w.title, w.description, w.category, w.priority, w.status,
         w.reported_on, w.scheduled_on, w.completed_on, w.assigned_to, w.entry_permitted, w.currency,
         w.estimated_cost_cents::text AS estimated_cost_cents, w.chargeback_amount_cents::text AS chargeback_amount_cents,
         w.chargeback_description, w.chargeback_ledger_transaction_id,
         w.record_revision, w.created_by, w.updated_by, w.created_at, w.updated_at,
         va.vendor, ma.manual, wa.linked_cents, wa.linked_count,
         ${PRIORITY_RANK} AS priority_rank
    FROM company_work_orders w
    JOIN rent_ops_properties p ON p.id = w.property_id
    LEFT JOIN rent_ops_units u ON u.id = w.unit_id
    LEFT JOIN rent_ops_people pe ON pe.id = w.person_id
    LEFT JOIN company_projects pr ON pr.organization_id = w.organization_id AND pr.id = w.project_id
    ${DERIVED_JOINS}`;

function jsonValue(value: unknown): unknown {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
  return value ?? null;
}

export function mapVendor(value: unknown): WorkOrderVendor | null {
  const parsed = workOrderVendorSchema.safeParse(jsonValue(value));
  return parsed.success ? parsed.data : null;
}

export function mapManualActual(value: unknown): { amountCents: string; note: string | null; setAt: string; setBy: string } | null {
  const raw = jsonValue(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.amountCents !== "string" || typeof record.setAt !== "string" || typeof record.setBy !== "string") return null;
  return { amountCents: record.amountCents, note: typeof record.note === "string" ? record.note : null, setAt: record.setAt, setBy: record.setBy };
}

export function operatingDate(now = new Date()): string {
  return nowIsoDate(now);
}

export function actualCostFrom(row: Record<string, unknown>) {
  const linked = row.linked_cents === null || row.linked_cents === undefined ? "0" : String(row.linked_cents);
  const count = Number(row.linked_count ?? 0);
  const manual = mapManualActual(row.manual);
  return { linkedCents: linked, linkedLineCount: count, manualCents: manual?.amountCents ?? null, state: count > 0 ? "verified" as const : manual ? "manual" as const : "none" as const };
}

function mapSummary(row: Record<string, unknown>, asOf: string): WorkOrderSummary {
  const id = dbString(row.id, "id");
  const chargebackAmount = dbNullableCents(row.chargeback_amount_cents, "chargeback_amount_cents");
  const ledgerTransactionId = dbNullableString(row.chargeback_ledger_transaction_id, "chargeback_ledger_transaction_id");
  const reportedOn = dbDate(row.reported_on, "reported_on");
  const completedOn = dbNullableDate(row.completed_on, "completed_on");
  const priority = dbString(row.priority, "priority") as WorkOrderPriority;
  const status = dbString(row.status, "status");
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
    priority,
    status,
    reportedOn,
    scheduledOn: dbNullableDate(row.scheduled_on, "scheduled_on"),
    completedOn,
    assignedTo: dbNullableString(row.assigned_to, "assigned_to"),
    vendor: mapVendor(row.vendor),
    targetOn: workOrderTargetOn(reportedOn, priority),
    agingDays: workOrderAgingDays({ reportedOn, completedOn, status }, asOf),
    entryPermitted: row.entry_permitted === true,
    currency: dbString(row.currency, "currency"),
    estimatedCostCents: dbNullableCents(row.estimated_cost_cents, "estimated_cost_cents"),
    actualCost: actualCostFrom(row),
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

type Cursor =
  | { sort: "priority"; rank: number; reportedOn: string; id: string }
  | { sort: "schedule"; on: string; id: string };

function encodeCursor(value: Cursor): string {
  // Priority cursors keep their original shape so links issued before sorting existed still work.
  const body = value.sort === "priority" ? { rank: value.rank, reportedOn: value.reportedOn, id: value.id } : value;
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, sort: "priority" | "schedule"): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (sort === "schedule") {
      if (parsed.sort !== "schedule") throw new Error("sort");
      return { sort, on: isoDateSchema.parse(parsed.on), id: workOrderIdSchema.parse(parsed.id) };
    }
    if (parsed.sort !== undefined) throw new Error("sort");
    if (typeof parsed.rank !== "number" || !Number.isInteger(parsed.rank) || parsed.rank < 0 || parsed.rank > 3) throw new Error("rank");
    return { sort, rank: parsed.rank, reportedOn: isoDateSchema.parse(parsed.reportedOn), id: workOrderIdSchema.parse(parsed.id) };
  } catch {
    throw new ValidationCommandError("Work order cursor is invalid", { reason: "invalid_work_order_cursor" });
  }
}

/**
 * The agenda date the schedule view groups by: the scheduled date, else the
 * derived target date (reported date plus the priority response time).
 */
const AGENDA_ON = `coalesce(w.scheduled_on, w.reported_on + (CASE w.priority ${
  Object.entries(WORK_ORDER_TARGET_DAYS).map(([priority, days]) => `WHEN '${priority}' THEN ${Number(days)}`).join(" ")
} ELSE ${Number(WORK_ORDER_TARGET_DAYS.low)} END))`;

function scopePredicates(scope: CompanyScope, values: unknown[]): string[] {
  values.push(scope.organizationId, scope.legalEntityId ?? null, scope.propertyId ?? null);
  return [`w.organization_id = $1`, `($2::uuid IS NULL OR w.legal_entity_id = $2)`, `($3::varchar IS NULL OR w.property_id = $3)`];
}

/** Scoped work order reads; grants are checked exactly as project reads are. */
export class WorkOrderReadService {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly today: () => string = () => operatingDate()) {}

  async list(principal: AuthenticatedPrincipal, input: WorkOrderListQuery): Promise<WorkOrderListResponse> {
    const query = workOrderListQuerySchema.parse(input);
    authorizeCompanyRead(principal, query.scope, WORK_ORDER_READ_ROLES);
    const cursor = decodeCursor(query.cursor, query.sort);
    const values: unknown[] = [];
    const where = scopePredicates(query.scope, values);
    const add = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    const statuses: readonly WorkOrderStatus[] | undefined = query.statuses ?? (query.openOnly ? WORK_ORDER_OPEN_STATUSES : undefined);
    if (statuses) where.push(`w.status = ANY(${add([...statuses])}::text[])`);
    if (query.priorities) where.push(`w.priority = ANY(${add([...query.priorities])}::text[])`);
    if (query.categories) where.push(`w.category = ANY(${add([...query.categories])}::text[])`);
    if (query.unitId) where.push(`w.unit_id = ${add(query.unitId)}`);
    if (query.assignedTo) { const term = add(query.assignedTo); where.push(`(w.assigned_to ILIKE '%' || ${term} || '%' OR va.vendor->>'name' ILIKE '%' || ${term} || '%')`); }
    if (query.vendorId) where.push(`va.vendor->>'id' = ${add(query.vendorId)}`);
    if (query.scheduledFrom) where.push(`w.scheduled_on >= ${add(query.scheduledFrom)}::date`);
    if (query.scheduledThrough) where.push(`w.scheduled_on <= ${add(query.scheduledThrough)}::date`);
    if (query.search) {
      const term = add(query.search);
      const reference = add(query.search.replace(/^wo-?/i, "").replace(/-/g, "").toLowerCase());
      where.push(`(w.title ILIKE '%' || ${term} || '%' OR w.description ILIKE '%' || ${term} || '%'
        OR w.assigned_to ILIKE '%' || ${term} || '%' OR p.name ILIKE '%' || ${term} || '%' OR va.vendor->>'name' ILIKE '%' || ${term} || '%'
        OR u.unit_number ILIKE '%' || ${term} || '%' OR concat_ws(' ', pe.first_name, pe.last_name) ILIKE '%' || ${term} || '%'
        OR (length(${reference}) >= 4 AND replace(w.id::text, '-', '') LIKE ${reference} || '%'))`);
    }
    if (cursor?.sort === "priority") {
      const rank = add(cursor.rank); const reported = add(cursor.reportedOn); const id = add(cursor.id);
      where.push(`(${PRIORITY_RANK} > ${rank} OR (${PRIORITY_RANK} = ${rank} AND (w.reported_on < ${reported}::date OR (w.reported_on = ${reported}::date AND w.id < ${id}::uuid))))`);
    } else if (cursor?.sort === "schedule") {
      const on = add(cursor.on); const id = add(cursor.id);
      where.push(`(${AGENDA_ON} > ${on}::date OR (${AGENDA_ON} = ${on}::date AND w.id > ${id}::uuid))`);
    }
    const limit = add(query.limit + 1);
    const order = query.sort === "schedule" ? `${AGENDA_ON} ASC, w.id ASC` : "priority_rank ASC, w.reported_on DESC, w.id DESC";
    const result = await this.executor.query<Record<string, unknown>>(
      `${summarySelect} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
      values,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    const asOf = this.today();
    const items = rows.map(row => mapSummary(row, asOf));
    const last = rows.at(-1);
    const nextCursor = !hasMore || !last ? null : query.sort === "schedule"
      ? encodeCursor({ sort: "schedule", on: items.at(-1)!.scheduledOn ?? items.at(-1)!.targetOn, id: dbString(last.id, "id") })
      : encodeCursor({ sort: "priority", rank: Number(last.priority_rank), reportedOn: dbDate(last.reported_on, "reported_on"), id: dbString(last.id, "id") });
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
    const summary = mapSummary(row, this.today());
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
    // Fold attachment events into the current set of linked documents.
    const linked = new Map<string, { linkedAt: string; linkedBy: string }>();
    for (const event of history) {
      const attachment = event.details.attachment as { documentId?: unknown; action?: unknown } | undefined;
      if (!attachment || typeof attachment.documentId !== "string") continue;
      if (attachment.action === "linked") linked.set(attachment.documentId, { linkedAt: event.createdAt, linkedBy: event.actorId });
      else if (attachment.action === "unlinked") linked.delete(attachment.documentId);
    }
    const documentIds = Array.from(linked.keys());
    const documents = documentIds.length
      ? await this.executor.query<Record<string, unknown>>(`SELECT id, title, kind, document_date, state FROM company_documents WHERE organization_id = $1 AND id = ANY($2::varchar[])`, [scope.organizationId, documentIds])
      : { rows: [] as Record<string, unknown>[] };
    const documentById = new Map(documents.rows.map(document => [String(document.id), document]));
    const attachments = documentIds.map(documentId => {
      const document = documentById.get(documentId);
      const link = linked.get(documentId)!;
      return {
        documentId,
        title: document ? dbString(document.title, "document_title") : "Unavailable document",
        kind: document ? dbString(document.kind, "document_kind") : "other",
        documentDate: document ? dbNullableDate(document.document_date, "document_date") : null,
        available: document?.state === "verified",
        linkedAt: link.linkedAt,
        linkedBy: link.linkedBy,
      };
    });
    const costRows = await this.executor.query<Record<string, unknown>>(
      `SELECT x.environment, x.realm_id, x.object_type, x.object_id, x.line_id, x.source_version, x.amount_cents::text AS allocated_cents, x.currency,
              b.latest_version, b.is_current, b.posting_state, b.amount_cents::text AS line_amount_cents, b.posted_on, b.transaction_type, l.description
         FROM accounting_qbo_source_line_allocations x
         LEFT JOIN accounting_qbo_source_line_balances b
           ON b.organization_id = x.organization_id AND b.legal_entity_id = x.legal_entity_id AND b.environment = x.environment AND b.realm_id = x.realm_id
          AND b.object_type = x.object_type AND b.object_id = x.object_id AND b.line_id = x.line_id
         LEFT JOIN accounting_qbo_transaction_lines l
           ON l.organization_id = x.organization_id AND l.legal_entity_id = x.legal_entity_id AND l.environment = x.environment AND l.realm_id = x.realm_id
          AND l.object_type = x.object_type AND l.object_id = x.object_id AND l.source_line_id = x.line_id AND l.source_version = x.source_version
        WHERE x.organization_id = $1 AND x.legal_entity_id = $2 AND x.consumer_kind = '${WORK_ORDER_COST_CONSUMER_KIND}' AND x.consumer_id = $3
        ORDER BY x.created_at, x.object_type, x.object_id, x.line_id
        LIMIT 200`,
      [scope.organizationId, summary.legalEntityId, workOrderId],
    );
    const costLines = costRows.rows.map(line => ({
      source: financialSourceReferenceSchema.parse({ provider: "qbo", organizationId: scope.organizationId, legalEntityId: summary.legalEntityId, environment: line.environment, realmId: String(line.realm_id), objectType: line.object_type, objectId: line.object_id, lineId: line.line_id, version: line.source_version }),
      transactionType: line.transaction_type === null || line.transaction_type === undefined ? null : String(line.transaction_type),
      description: line.description === null || line.description === undefined ? null : String(line.description).slice(0, 500),
      postedOn: line.posted_on === null || line.posted_on === undefined ? null : dbDate(line.posted_on, "posted_on"),
      currency: String(line.currency),
      allocatedCents: String(line.allocated_cents),
      lineAmountCents: line.line_amount_cents === null || line.line_amount_cents === undefined ? null : String(line.line_amount_cents),
      validity: line.is_current === true && line.posting_state === "posted" && line.latest_version === line.source_version ? "current" as const : "stale" as const,
    }));
    const manual = mapManualActual(row.manual);
    return workOrderDetailSchema.parse({
      ...summary,
      description: dbNullableString(row.description, "description"),
      attachments,
      costLines,
      manualActual: manual,
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

  /** Vendors: company contacts holding the vendor role, and project vendor records. */
  async vendorOptions(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; asOf?: string }): Promise<WorkOrderVendorOptionsResponse> {
    const scope = companyScopeSchema.parse(input.scope);
    authorizeCompanyRead(principal, scope, WORK_ORDER_READ_ROLES);
    const asOf = input.asOf ?? this.today();
    const contacts = await this.executor.query<Record<string, unknown>>(
      `SELECT c.id, c.display_name FROM company_contacts c
        WHERE c.organization_id = $1 AND c.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM company_contact_roles r WHERE r.organization_id = c.organization_id AND r.contact_id = c.id AND r.role = 'vendor'
                        AND ($2::uuid IS NULL OR r.legal_entity_id IS NULL OR r.legal_entity_id = $2)
                        AND r.effective_from <= $3::date AND (r.effective_until IS NULL OR r.effective_until > $3::date))
        ORDER BY lower(c.display_name), c.id LIMIT 250`,
      [scope.organizationId, scope.legalEntityId ?? null, asOf],
    );
    const vendors = await this.executor.query<Record<string, unknown>>(
      `SELECT id, name, status FROM company_project_vendors WHERE organization_id = $1 AND status <> 'inactive' ORDER BY lower(name), id LIMIT 250`,
      [scope.organizationId],
    );
    return workOrderVendorOptionsResponseSchema.parse({ items: [
      ...contacts.rows.map(row => ({ kind: "contact", id: dbString(row.id, "contact_id"), name: dbString(row.display_name, "contact_name").slice(0, 240), status: "active" })),
      ...vendors.rows.map(row => ({ kind: "project_vendor", id: dbString(row.id, "vendor_id"), name: dbString(row.name, "vendor_name").slice(0, 240), status: dbString(row.status, "vendor_status") })),
    ] });
  }

  /** Verified company documents that may be attached at this property. */
  async documentOptions(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; propertyId: string; search?: string }): Promise<WorkOrderDocumentOptionsResponse> {
    const scope = companyScopeSchema.parse(input.scope);
    const propertyScope = companyScopeSchema.parse({ ...scope, propertyId: input.propertyId });
    if (scope.propertyId !== undefined && scope.propertyId !== input.propertyId) throw new ValidationCommandError("Property is outside the requested scope", { reason: "work_order_property_scope" });
    if (scope.legalEntityId === undefined) throw new ValidationCommandError("Document options require a legal entity scope", { reason: "work_order_entity_scope_required" });
    authorizeCompanyRead(principal, propertyScope, WORK_ORDER_READ_ROLES);
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT id, title, kind, document_date, property_id FROM company_documents
        WHERE organization_id = $1 AND state = 'verified' AND legal_entity_id = $2 AND (property_id IS NULL OR property_id = $3)
          AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%')
        ORDER BY document_date DESC NULLS LAST, updated_at DESC, id DESC LIMIT 200`,
      [scope.organizationId, scope.legalEntityId, input.propertyId, input.search?.trim() || null],
    );
    return workOrderDocumentOptionsResponseSchema.parse({ items: result.rows.map(row => ({
      documentId: dbString(row.id, "document_id"), title: dbString(row.title, "document_title"), kind: dbString(row.kind, "document_kind"),
      documentDate: dbNullableDate(row.document_date, "document_date"), propertyId: dbNullableString(row.property_id, "property_id"),
    })) });
  }
}
