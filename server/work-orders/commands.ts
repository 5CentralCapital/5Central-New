import {
  commandEnvelopeSchema,
  newRecordId,
  recordReferenceIdSchema,
  type CommandEnvelope,
  type IsoDate,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  WORK_ORDER_REVISIONED_COMMANDS,
  WORK_ORDER_TRANSITION_MESSAGES,
  addWorkOrderNotePayloadSchema,
  changeWorkOrderStatusPayloadSchema,
  clearWorkOrderChargebackPayloadSchema,
  createWorkOrderPayloadSchema,
  linkWorkOrderProjectPayloadSchema,
  setWorkOrderChargebackPayloadSchema,
  updateWorkOrderPayloadSchema,
  assignWorkOrderVendorPayloadSchema,
  linkWorkOrderCostPayloadSchema,
  unlinkWorkOrderCostPayloadSchema,
  setWorkOrderManualActualPayloadSchema,
  workOrderAttachmentPayloadSchema,
  type WorkOrderVendor,
  workOrderCommandPayloadSchemas,
  workOrderIdSchema,
  workOrderTransitionProblem,
  type WorkOrderCommandKind,
  type WorkOrderEventType,
  type WorkOrderStatus,
} from "../../shared/work-orders";
import type { AuthenticatedPrincipal, CommandAuthorizationPolicy, TransportAttestation } from "../company/authorization";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import { ConflictCommandError, ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { ProjectExecutionFinancePorts } from "../projects/execution-commands";
import { reserveCostAllocation, verifyCostSourceLine } from "../projects/source-lines";
import { WORK_ORDER_COST_CONSUMER_KIND } from "./service";
import { assertEntityPropertyUnit, dbDate, dbNullableCents, dbNullableDate, dbNullableString, dbRevision, dbString, resolveEffectiveDate } from "../projects/helpers";

type AnyEnvelope = CommandEnvelope<Record<string, unknown>>;
type Context = CommandHandlerContext<Record<string, unknown>>;

export interface WorkOrderCommandExecutionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
  /** Transaction-bound QBO mirror ports; required only to link or unlink QBO cost lines. */
  readonly financeFactory?: (executor: RentOpsQueryExecutor) => ProjectExecutionFinancePorts;
}

type FinanceContext = Context & { readonly finance?: ProjectExecutionFinancePorts };

const WORK_ORDER_WRITE_ROLES = ["owner", "admin", "operations_pm", "project_manager"] as const;
const WORK_ORDER_CHARGEBACK_ROLES = ["owner", "admin", "operations_pm", "project_manager", "finance"] as const;

export const WORK_ORDER_COMMAND_POLICIES: Readonly<Record<WorkOrderCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "work_order.create": { commandKind: "work_order.create", allowedRoles: WORK_ORDER_WRITE_ROLES },
  "work_order.update": { commandKind: "work_order.update", allowedRoles: WORK_ORDER_WRITE_ROLES },
  "work_order.status.change": { commandKind: "work_order.status.change", allowedRoles: WORK_ORDER_WRITE_ROLES },
  "work_order.note.add": { commandKind: "work_order.note.add", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
  "work_order.project.link": { commandKind: "work_order.project.link", allowedRoles: WORK_ORDER_WRITE_ROLES },
  "work_order.chargeback.set": { commandKind: "work_order.chargeback.set", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
  "work_order.chargeback.clear": { commandKind: "work_order.chargeback.clear", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
  "work_order.vendor.assign": { commandKind: "work_order.vendor.assign", allowedRoles: WORK_ORDER_WRITE_ROLES },
  "work_order.cost.link": { commandKind: "work_order.cost.link", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
  "work_order.cost.unlink": { commandKind: "work_order.cost.unlink", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
  "work_order.actual.set": { commandKind: "work_order.actual.set", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
  "work_order.attachment.link": { commandKind: "work_order.attachment.link", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
  "work_order.attachment.unlink": { commandKind: "work_order.attachment.unlink", allowedRoles: WORK_ORDER_CHARGEBACK_ROLES },
});

export interface WorkOrderRow {
  readonly id: string;
  readonly legalEntityId: string;
  readonly propertyId: string;
  readonly unitId: string | null;
  readonly tenancyId: string | null;
  readonly personId: string | null;
  readonly projectId: string | null;
  readonly status: WorkOrderStatus;
  readonly reportedOn: IsoDate;
  readonly scheduledOn: IsoDate | null;
  readonly completedOn: IsoDate | null;
  readonly chargebackAmountCents: string | null;
  readonly chargebackDescription: string | null;
  readonly chargebackLedgerTransactionId: string | null;
  readonly currency: string;
  readonly recordRevision: Revision;
}

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function saved(id: string, revision: Revision): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [id],
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(id), revision }],
    validationOutcomes: [{ code: "work_order.saved_in_rops", severity: "info", message: "Work order saved in 5Central Ops. No charge, bill or payment was posted." }],
  };
}

function assertPropertyInScope(context: Context, propertyId: string): void {
  const scoped = context.envelope.scope.propertyId;
  if (scoped !== undefined && scoped !== propertyId) {
    throw new ForbiddenCommandError("Work order property is outside the requested scope", { reason: "work_order_property_scope" });
  }
}

function requireRevision(context: Context, current: Revision): void {
  const expected = context.envelope.expectedRevision;
  if (expected === undefined) throw new ValidationCommandError("Supply the work order revision you read before editing", { reason: "work_order_revision_required" });
  if (expected !== current) {
    throw new ConflictCommandError("Work order changed since it was read. Reload it before saving again.", { reason: "revision_conflict", expected, actual: current });
  }
}

/** Lock the row and prove it belongs to the command's company scope. */
export async function loadWorkOrderForCommand(context: Context, workOrderId: string): Promise<WorkOrderRow> {
  const scope = context.envelope.scope;
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT id, legal_entity_id, property_id, unit_id, tenancy_id, person_id, project_id, status,
            reported_on, scheduled_on, completed_on, chargeback_amount_cents::text AS chargeback_amount_cents,
            chargeback_description, chargeback_ledger_transaction_id, currency, record_revision
       FROM company_work_orders
      WHERE organization_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR legal_entity_id = $3)
        AND ($4::varchar IS NULL OR property_id = $4)
      FOR UPDATE`,
    [scope.organizationId, workOrderIdSchema.parse(workOrderId), scope.legalEntityId ?? null, scope.propertyId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Work order was not found in the requested company scope", { reason: "work_order_not_found" });
  return {
    id: dbString(row.id, "id"),
    legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"),
    propertyId: dbString(row.property_id, "property_id"),
    unitId: dbNullableString(row.unit_id, "unit_id"),
    tenancyId: dbNullableString(row.tenancy_id, "tenancy_id"),
    personId: dbNullableString(row.person_id, "person_id"),
    projectId: dbNullableString(row.project_id, "project_id"),
    status: dbString(row.status, "status") as WorkOrderStatus,
    reportedOn: dbDate(row.reported_on, "reported_on"),
    scheduledOn: dbNullableDate(row.scheduled_on, "scheduled_on"),
    completedOn: dbNullableDate(row.completed_on, "completed_on"),
    chargebackAmountCents: dbNullableCents(row.chargeback_amount_cents, "chargeback_amount_cents"),
    chargebackDescription: dbNullableString(row.chargeback_description, "chargeback_description"),
    chargebackLedgerTransactionId: dbNullableString(row.chargeback_ledger_transaction_id, "chargeback_ledger_transaction_id"),
    currency: dbString(row.currency, "currency"),
    recordRevision: dbRevision(row.record_revision),
  };
}

/**
 * Tenant links use the existing rental IDs. A tenancy must be at this property
 * (and unit when one is set); a person must belong to that tenancy or, with no
 * tenancy, hold some tenancy at the property. Returns the person to store.
 */
export async function resolveTenantLink(executor: RentOpsQueryExecutor, input: {
  propertyId: string; unitId: string | null; tenancyId: string | null; personId: string | null;
}): Promise<{ tenancyId: string | null; personId: string | null }> {
  if (input.tenancyId) {
    const tenancy = await executor.query<{ unit_id: string; primary_person_id: string }>(
      `SELECT unit_id, primary_person_id FROM rent_ops_tenancies WHERE id = $1 AND property_id = $2`,
      [input.tenancyId, input.propertyId],
    );
    const row = tenancy.rows[0];
    if (!row) throw new ValidationCommandError("Tenancy does not belong to the selected property", { reason: "work_order_tenancy_property" });
    if (input.unitId && row.unit_id !== input.unitId) throw new ValidationCommandError("Tenancy does not belong to the selected unit", { reason: "work_order_tenancy_unit" });
    const personId = input.personId ?? row.primary_person_id;
    if (personId !== row.primary_person_id) {
      const member = await executor.query(`SELECT 1 FROM rent_ops_household_memberships WHERE tenancy_id = $1 AND person_id = $2 LIMIT 1`, [input.tenancyId, personId]);
      if (!member.rows.length) throw new ValidationCommandError("Person is not part of the selected tenancy", { reason: "work_order_person_tenancy" });
    }
    return { tenancyId: input.tenancyId, personId };
  }
  if (input.personId) {
    const person = await executor.query(
      `SELECT 1 FROM rent_ops_tenancies t
        WHERE t.property_id = $1 AND ($2::varchar IS NULL OR t.unit_id = $2)
          AND (t.primary_person_id = $3 OR EXISTS (SELECT 1 FROM rent_ops_household_memberships m WHERE m.tenancy_id = t.id AND m.person_id = $3))
        LIMIT 1`,
      [input.propertyId, input.unitId, input.personId],
    );
    if (!person.rows.length) throw new ValidationCommandError("Person has no tenancy at the selected property", { reason: "work_order_person_property" });
  }
  return { tenancyId: null, personId: input.personId };
}

async function assertProjectLink(context: Context, propertyId: string, projectId: string): Promise<void> {
  const result = await context.executor.query(
    `SELECT 1 FROM company_projects WHERE organization_id = $1 AND id = $2 AND property_id = $3 AND archived_at IS NULL`,
    [context.envelope.scope.organizationId, projectId, propertyId],
  );
  if (!result.rows.length) throw new ValidationCommandError("Project was not found at this property", { reason: "work_order_project_property" });
}

async function recordEvent(context: Context, input: {
  workOrderId: string; type: WorkOrderEventType; revision: Revision;
  fromStatus?: WorkOrderStatus; toStatus?: WorkOrderStatus; note?: string | null; details?: Record<string, unknown>;
}): Promise<void> {
  await context.executor.query(
    `INSERT INTO company_work_order_events
       (id, organization_id, work_order_id, event_type, from_status, to_status, note, details, record_revision, actor_id, operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [newRecordId(), context.envelope.scope.organizationId, input.workOrderId, input.type, input.fromStatus ?? null, input.toStatus ?? null,
      input.note ?? null, JSON.stringify(input.details ?? {}), input.revision, context.principal.actorId, context.envelope.operationId],
  );
}

/** Apply column changes with an exact revision fence and advance the revision. */
async function saveChanges(context: Context, current: WorkOrderRow, changes: Record<string, unknown>): Promise<Revision> {
  const columns = Object.keys(changes);
  const values: unknown[] = columns.map(column => changes[column]);
  const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
  values.push(context.principal.actorId, context.envelope.scope.organizationId, current.id, current.recordRevision);
  const n = values.length;
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_work_orders
        SET ${[...assignments, `updated_by = $${n - 3}`, "updated_at = now()", "record_revision = record_revision + 1"].join(", ")}
      WHERE organization_id = $${n - 2} AND id = $${n - 1} AND record_revision = $${n}
      RETURNING record_revision`,
    values,
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Work order changed while it was being saved", { reason: "revision_conflict" });
  return dbRevision(result.rows[0]!.record_revision);
}

async function handleCreate(context: Context): Promise<CommandHandlerResult> {
  const payload = createWorkOrderPayloadSchema.parse(context.envelope.payload);
  const legalEntityId = context.envelope.scope.legalEntityId;
  if (legalEntityId === undefined) throw new ValidationCommandError("Work orders require a legal entity scope", { reason: "work_order_entity_scope_required" });
  assertPropertyInScope(context, payload.propertyId);
  const reportedOn = resolveEffectiveDate(payload.reportedOn);
  const mapping = await assertEntityPropertyUnit(context.executor, {
    organizationId: context.envelope.scope.organizationId, legalEntityId, propertyId: payload.propertyId,
    unitId: payload.unitId ?? null, effectiveDate: resolveEffectiveDate(context.envelope.effectiveDate ?? reportedOn),
  });
  const tenant = await resolveTenantLink(context.executor, { propertyId: payload.propertyId, unitId: payload.unitId ?? null, tenancyId: payload.tenancyId ?? null, personId: payload.personId ?? null });
  if (payload.projectId) await assertProjectLink(context, payload.propertyId, payload.projectId);
  const id = workOrderIdSchema.parse(newRecordId());
  const result = await context.executor.query<{ record_revision: number }>(
    `INSERT INTO company_work_orders
       (id, organization_id, legal_entity_id, property_id, unit_id, tenancy_id, person_id, project_id, title, description,
        category, priority, status, reported_on, scheduled_on, assigned_to, entry_permitted, currency, estimated_cost_cents, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
     RETURNING record_revision`,
    [id, context.envelope.scope.organizationId, legalEntityId, payload.propertyId, payload.unitId ?? null, tenant.tenancyId, tenant.personId,
      payload.projectId ?? null, payload.title, payload.description ?? null, payload.category, payload.priority, payload.status, reportedOn,
      payload.scheduledOn ?? null, payload.assignedTo ?? null, payload.entryPermitted, mapping.currency, payload.estimatedCostCents ?? null, context.principal.actorId],
  );
  const revision = dbRevision(result.rows[0]?.record_revision ?? 1);
  await recordEvent(context, { workOrderId: id, type: "created", revision, toStatus: undefined, details: { status: payload.status, priority: payload.priority } });
  return saved(id, revision);
}

const UPDATE_COLUMNS = {
  title: "title", description: "description", category: "category", priority: "priority", reportedOn: "reported_on",
  scheduledOn: "scheduled_on", assignedTo: "assigned_to", entryPermitted: "entry_permitted", estimatedCostCents: "estimated_cost_cents",
  unitId: "unit_id", tenancyId: "tenancy_id", personId: "person_id",
} as const;

async function handleUpdate(context: Context): Promise<CommandHandlerResult> {
  const payload = updateWorkOrderPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  const changes: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(UPDATE_COLUMNS)) {
    if (has(payload, key) && (payload as Record<string, unknown>)[key] !== undefined) changes[column] = (payload as Record<string, unknown>)[key] ?? null;
  }
  const unitId = has(changes, "unit_id") ? (changes.unit_id as string | null) : current.unitId;
  const linkChanged = has(changes, "unit_id") || has(changes, "tenancy_id") || has(changes, "person_id");
  if (has(changes, "unit_id") && unitId !== null) {
    await assertEntityPropertyUnit(context.executor, {
      organizationId: context.envelope.scope.organizationId, legalEntityId: current.legalEntityId, propertyId: current.propertyId,
      unitId, effectiveDate: resolveEffectiveDate(context.envelope.effectiveDate),
    });
  }
  if (linkChanged) {
    // Revalidate the whole tenant link against the resulting unit; a new
    // tenancy without an explicit person defaults to its primary person.
    const tenancyId = has(changes, "tenancy_id") ? (changes.tenancy_id as string | null) : current.tenancyId;
    const personId = has(changes, "person_id") ? (changes.person_id as string | null) : has(changes, "tenancy_id") ? null : current.personId;
    const tenant = await resolveTenantLink(context.executor, { propertyId: current.propertyId, unitId, tenancyId, personId });
    changes.tenancy_id = tenant.tenancyId;
    changes.person_id = tenant.personId;
    if (current.chargebackAmountCents !== null && !tenant.tenancyId && !tenant.personId) {
      throw new ValidationCommandError("Clear the chargeback before removing the tenant link", { reason: "work_order_chargeback_requires_tenant" });
    }
  }
  const scheduledOn = has(changes, "scheduled_on") ? (changes.scheduled_on as string | null) : current.scheduledOn;
  if (current.status === "scheduled" && !scheduledOn) {
    throw new ValidationCommandError("Scheduled work orders need a scheduled date; change the status first", { reason: "work_order_scheduled_date_required" });
  }
  const reportedOn = has(changes, "reported_on") ? (changes.reported_on as string) : current.reportedOn;
  if (current.completedOn && current.completedOn < reportedOn) {
    throw new ValidationCommandError("The reported date cannot be after the completed date", { reason: "work_order_date_order" });
  }
  const revision = await saveChanges(context, current, changes);
  await recordEvent(context, { workOrderId: current.id, type: "updated", revision, details: { fields: Object.keys(payload).filter(key => key !== "workOrderId").sort() } });
  return saved(current.id, revision);
}

async function handleStatusChange(context: Context): Promise<CommandHandlerResult> {
  const payload = changeWorkOrderStatusPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  const scheduledOn = payload.scheduledOn ?? current.scheduledOn;
  const completedOn = payload.status === "completed" ? resolveEffectiveDate(payload.completedOn ?? context.envelope.effectiveDate) : null;
  const problem = workOrderTransitionProblem({ from: current.status, to: payload.status, note: payload.note, scheduledOn, reportedOn: current.reportedOn, completedOn });
  if (problem) throw new ValidationCommandError(WORK_ORDER_TRANSITION_MESSAGES[problem], { reason: `work_order_${problem}`, from: current.status, to: payload.status });
  const changes: Record<string, unknown> = { status: payload.status, completed_on: completedOn };
  if (payload.scheduledOn !== undefined) changes.scheduled_on = payload.scheduledOn;
  const revision = await saveChanges(context, current, changes);
  await recordEvent(context, {
    workOrderId: current.id, type: "status_changed", revision, fromStatus: current.status, toStatus: payload.status, note: payload.note ?? null,
    details: { ...(payload.scheduledOn ? { scheduledOn: payload.scheduledOn } : {}), ...(completedOn ? { completedOn } : {}) },
  });
  return saved(current.id, revision);
}

async function handleNote(context: Context): Promise<CommandHandlerResult> {
  const payload = addWorkOrderNotePayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  // Notes append history; a supplied revision is still honored.
  if (context.envelope.expectedRevision !== undefined) requireRevision(context, current.recordRevision);
  const revision = await saveChanges(context, current, {});
  await recordEvent(context, { workOrderId: current.id, type: "note", revision, note: payload.note });
  return saved(current.id, revision);
}

async function handleProjectLink(context: Context): Promise<CommandHandlerResult> {
  const payload = linkWorkOrderProjectPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  if (payload.projectId === current.projectId) throw new ValidationCommandError("The work order already has this project link", { reason: "work_order_project_unchanged" });
  if (payload.projectId) await assertProjectLink(context, current.propertyId, payload.projectId);
  const revision = await saveChanges(context, current, { project_id: payload.projectId });
  await recordEvent(context, {
    workOrderId: current.id, type: payload.projectId ? "project_linked" : "project_unlinked", revision,
    details: { projectId: payload.projectId ?? current.projectId },
  });
  return saved(current.id, revision);
}

async function handleChargebackSet(context: Context): Promise<CommandHandlerResult> {
  const payload = setWorkOrderChargebackPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  if (!current.tenancyId && !current.personId) {
    throw new ValidationCommandError("Link the tenant before recording a chargeback", { reason: "work_order_chargeback_requires_tenant" });
  }
  const ledgerTransactionId = payload.ledgerTransactionId ?? null;
  if (ledgerTransactionId) {
    // Linking verifies an existing posted tenant charge. It never creates, edits or posts one.
    const charge = await context.executor.query<{ tenancy_id: string | null; person_id: string | null }>(
      `SELECT tenancy_id, person_id FROM rent_ops_ledger_transactions
        WHERE id = $1 AND property_id = $2 AND kind = 'charge' AND status = 'posted'`,
      [ledgerTransactionId, current.propertyId],
    );
    const row = charge.rows[0];
    if (!row) throw new ValidationCommandError("Linked ledger entry must be a posted tenant charge at this property", { reason: "work_order_chargeback_ledger_invalid" });
    if ((current.tenancyId && row.tenancy_id && row.tenancy_id !== current.tenancyId) || (!current.tenancyId && current.personId && row.person_id && row.person_id !== current.personId)) {
      throw new ValidationCommandError("Linked charge belongs to a different tenant", { reason: "work_order_chargeback_tenant_mismatch" });
    }
    const other = await context.executor.query(
      `SELECT 1 FROM company_work_orders WHERE chargeback_ledger_transaction_id = $1 AND id <> $2 LIMIT 1`,
      [ledgerTransactionId, current.id],
    );
    if (other.rows.length) throw new ConflictCommandError("That tenant charge is already linked to another work order", { reason: "work_order_chargeback_ledger_in_use" });
  }
  const revision = await saveChanges(context, current, {
    chargeback_amount_cents: payload.amountCents, chargeback_description: payload.description, chargeback_ledger_transaction_id: ledgerTransactionId,
  });
  await recordEvent(context, {
    workOrderId: current.id, type: "chargeback_set", revision,
    details: { amountCents: payload.amountCents, ledgerTransactionId, previousAmountCents: current.chargebackAmountCents },
  });
  return saved(current.id, revision);
}

async function handleChargebackClear(context: Context): Promise<CommandHandlerResult> {
  const payload = clearWorkOrderChargebackPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  if (current.chargebackAmountCents === null) throw new ValidationCommandError("This work order has no chargeback", { reason: "work_order_chargeback_absent" });
  const revision = await saveChanges(context, current, { chargeback_amount_cents: null, chargeback_description: null, chargeback_ledger_transaction_id: null });
  await recordEvent(context, {
    workOrderId: current.id, type: "chargeback_cleared", revision,
    details: { previousAmountCents: current.chargebackAmountCents, previousLedgerTransactionId: current.chargebackLedgerTransactionId },
  });
  return saved(current.id, revision);
}

async function currentEventState(context: Context, workOrderId: string, key: "vendorAssignment" | "manualActual"): Promise<unknown> {
  const result = await context.executor.query<{ value: unknown }>(
    `SELECT details->$3 AS value FROM company_work_order_events
      WHERE organization_id = $1 AND work_order_id = $2 AND details ? $3
      ORDER BY record_revision DESC, created_at DESC, id DESC LIMIT 1`,
    [context.envelope.scope.organizationId, workOrderId, key],
  );
  const value = result.rows[0]?.value;
  return typeof value === "string" ? JSON.parse(value) : value ?? null;
}

async function handleVendorAssign(context: Context): Promise<CommandHandlerResult> {
  const payload = assignWorkOrderVendorPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  let vendor: WorkOrderVendor | null = null;
  if (payload.vendor) {
    const organizationId = context.envelope.scope.organizationId;
    if (payload.vendor.kind === "contact") {
      const result = await context.executor.query<{ display_name: string }>(
        `SELECT c.display_name FROM company_contacts c
          WHERE c.organization_id = $1 AND c.id = $2 AND c.archived_at IS NULL
            AND EXISTS (SELECT 1 FROM company_contact_roles r WHERE r.organization_id = c.organization_id AND r.contact_id = c.id AND r.role = 'vendor'
                          AND (r.legal_entity_id IS NULL OR r.legal_entity_id = $3)
                          AND r.effective_from <= $4::date AND (r.effective_until IS NULL OR r.effective_until > $4::date))`,
        [organizationId, payload.vendor.id, current.legalEntityId, resolveEffectiveDate(context.envelope.effectiveDate)],
      );
      const row = result.rows[0];
      if (!row) throw new ValidationCommandError("Contact is not an active vendor for this entity", { reason: "work_order_vendor_not_found" });
      vendor = { kind: "contact", id: payload.vendor.id, name: String(row.display_name).slice(0, 240) };
    } else {
      const result = await context.executor.query<{ name: string }>(`SELECT name FROM company_project_vendors WHERE organization_id = $1 AND id = $2 AND status <> 'inactive'`, [organizationId, payload.vendor.id]);
      const row = result.rows[0];
      if (!row) throw new ValidationCommandError("Vendor is not available in this company", { reason: "work_order_vendor_not_found" });
      vendor = { kind: "project_vendor", id: payload.vendor.id, name: String(row.name).slice(0, 240) };
    }
  }
  const previous = await currentEventState(context, current.id, "vendorAssignment");
  if (JSON.stringify(previous ?? null) === JSON.stringify(vendor)) throw new ValidationCommandError("The work order already has this vendor", { reason: "work_order_vendor_unchanged" });
  const revision = await saveChanges(context, current, {});
  await recordEvent(context, { workOrderId: current.id, type: "updated", revision, details: { action: vendor ? "vendor_assigned" : "vendor_cleared", vendorAssignment: vendor, previousVendor: previous } });
  return saved(current.id, revision);
}

function requireFinance(context: Context): ProjectExecutionFinancePorts {
  const finance = (context as FinanceContext).finance;
  if (!finance) throw new ValidationCommandError("Verified QuickBooks source lines are unavailable", { reason: "work_order_finance_unavailable" });
  return finance;
}

/**
 * Link a posted QBO bill line (or part of it) to a work order. The amount is
 * reserved in the central allocation ledger shared with projects and payroll,
 * so one bill line can never be counted as two costs.
 */
async function handleCostLink(context: Context): Promise<CommandHandlerResult> {
  const payload = linkWorkOrderCostPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  if (payload.source.organizationId !== context.envelope.scope.organizationId || payload.source.legalEntityId !== current.legalEntityId) {
    throw new ValidationCommandError("The QBO line belongs to another entity", { reason: "work_order_cost_scope_mismatch" });
  }
  const finance = requireFinance(context);
  const line = await verifyCostSourceLine(finance, { source: payload.source, amountCents: payload.amountCents, currency: current.currency, effectiveDate: resolveEffectiveDate(context.envelope.effectiveDate), purpose: "cost", reasonPrefix: "work_order_cost" });
  await reserveCostAllocation(finance, { source: line.source, consumerKind: WORK_ORDER_COST_CONSUMER_KIND, consumerId: current.id, amountCents: payload.amountCents, currency: line.currency }, "work_order_cost");
  const revision = await saveChanges(context, current, {});
  await recordEvent(context, { workOrderId: current.id, type: "updated", revision, details: { action: "cost_linked", costLink: { source: line.source, amountCents: payload.amountCents } } });
  return costSaved(current.id, revision);
}

async function handleCostUnlink(context: Context): Promise<CommandHandlerResult> {
  const payload = unlinkWorkOrderCostPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  const source = payload.source;
  const existing = await context.executor.query<{ amount_cents: string; currency: string; source_version: string }>(
    `SELECT amount_cents::text AS amount_cents, currency, source_version FROM accounting_qbo_source_line_allocations
      WHERE organization_id = $1 AND legal_entity_id = $2 AND environment = $3 AND realm_id = $4 AND object_type = $5 AND object_id = $6 AND line_id = $7
        AND consumer_kind = $8 AND consumer_id = $9`,
    [context.envelope.scope.organizationId, current.legalEntityId, source.environment, source.realmId, source.objectType, source.objectId, source.lineId ?? "", WORK_ORDER_COST_CONSUMER_KIND, current.id],
  );
  const row = existing.rows[0];
  if (!row) throw new ValidationCommandError("This QBO line is not linked to the work order", { reason: "work_order_cost_not_linked" });
  const finance = requireFinance(context);
  await finance.allocations.release({ source: { ...source, version: row.source_version }, consumerKind: WORK_ORDER_COST_CONSUMER_KIND, consumerId: current.id, amountCents: row.amount_cents, currency: row.currency });
  const revision = await saveChanges(context, current, {});
  await recordEvent(context, { workOrderId: current.id, type: "updated", revision, details: { action: "cost_unlinked", costLink: { source: { ...source, version: row.source_version }, amountCents: row.amount_cents } } });
  return costSaved(current.id, revision);
}

async function handleManualActual(context: Context): Promise<CommandHandlerResult> {
  const payload = setWorkOrderManualActualPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  const previous = await currentEventState(context, current.id, "manualActual");
  if (payload.amountCents === null && previous === null) throw new ValidationCommandError("This work order has no manual actual cost", { reason: "work_order_manual_actual_absent" });
  const revision = await saveChanges(context, current, {});
  const manualActual = payload.amountCents === null ? null : { amountCents: payload.amountCents, note: payload.note ?? null, setAt: new Date().toISOString(), setBy: context.principal.actorId };
  await recordEvent(context, { workOrderId: current.id, type: "updated", revision, details: { action: manualActual ? "manual_actual_set" : "manual_actual_cleared", manualActual } });
  return saved(current.id, revision);
}

async function linkedDocumentIds(context: Context, workOrderId: string): Promise<Set<string>> {
  const events = await context.executor.query<{ details: unknown }>(
    `SELECT details FROM company_work_order_events WHERE organization_id = $1 AND work_order_id = $2 AND details ? 'attachment' ORDER BY record_revision, created_at, id`,
    [context.envelope.scope.organizationId, workOrderId],
  );
  const linked = new Set<string>();
  for (const event of events.rows) {
    const details = (typeof event.details === "string" ? JSON.parse(event.details) : event.details) as { attachment?: { documentId?: string; action?: string } };
    const attachment = details.attachment;
    if (!attachment?.documentId) continue;
    if (attachment.action === "linked") linked.add(attachment.documentId); else linked.delete(attachment.documentId);
  }
  return linked;
}

async function handleAttachment(context: Context, action: "linked" | "unlinked"): Promise<CommandHandlerResult> {
  const payload = workOrderAttachmentPayloadSchema.parse(context.envelope.payload);
  const current = await loadWorkOrderForCommand(context, payload.workOrderId);
  requireRevision(context, current.recordRevision);
  const linked = await linkedDocumentIds(context, current.id);
  if (action === "linked") {
    if (linked.has(payload.documentId)) throw new ValidationCommandError("This document is already attached", { reason: "work_order_attachment_exists" });
    const document = await context.executor.query(
      `SELECT 1 FROM company_documents WHERE organization_id = $1 AND id = $2 AND state = 'verified'
         AND (legal_entity_id IS NULL OR legal_entity_id = $3) AND (property_id IS NULL OR property_id = $4)`,
      [context.envelope.scope.organizationId, payload.documentId, current.legalEntityId, current.propertyId],
    );
    if (!document.rows.length) throw new ValidationCommandError("Document is not available for this property", { reason: "work_order_document_not_found" });
    if (linked.size >= 200) throw new ValidationCommandError("A work order can have at most 200 attachments", { reason: "work_order_attachment_limit" });
  } else if (!linked.has(payload.documentId)) {
    throw new ValidationCommandError("This document is not attached", { reason: "work_order_attachment_absent" });
  }
  const revision = await saveChanges(context, current, {});
  await recordEvent(context, { workOrderId: current.id, type: "updated", revision, details: { action: action === "linked" ? "attachment_linked" : "attachment_unlinked", attachment: { documentId: payload.documentId, action } } });
  return saved(current.id, revision);
}

function costSaved(id: string, revision: Revision): CommandHandlerResult {
  return { ...saved(id, revision), validationOutcomes: [{ code: "work_order.cost_saved", severity: "info", message: "QuickBooks line allocation saved. Nothing was posted to QuickBooks." }] };
}

const handlers: Record<WorkOrderCommandKind, (context: Context) => Promise<CommandHandlerResult>> = {
  "work_order.create": handleCreate,
  "work_order.update": handleUpdate,
  "work_order.status.change": handleStatusChange,
  "work_order.note.add": handleNote,
  "work_order.project.link": handleProjectLink,
  "work_order.chargeback.set": handleChargebackSet,
  "work_order.chargeback.clear": handleChargebackClear,
  "work_order.vendor.assign": handleVendorAssign,
  "work_order.cost.link": handleCostLink,
  "work_order.cost.unlink": handleCostUnlink,
  "work_order.actual.set": handleManualActual,
  "work_order.attachment.link": (context) => handleAttachment(context, "linked"),
  "work_order.attachment.unlink": (context) => handleAttachment(context, "unlinked"),
};

/** The single mutation path for browser, Codex and seed callers. */
export async function executeWorkOrderCommand(
  executor: RentOpsQueryExecutor,
  kind: WorkOrderCommandKind,
  rawEnvelope: unknown,
  options: WorkOrderCommandExecutionOptions,
): Promise<OperationReceipt> {
  const handler = handlers[kind];
  if (!handler) throw new ValidationCommandError("Unknown work order command", { reason: "unknown_work_order_command" });
  let envelope: AnyEnvelope;
  try {
    envelope = commandEnvelopeSchema(workOrderCommandPayloadSchemas[kind]).parse(rawEnvelope) as unknown as AnyEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      const issue = (error as unknown as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
      throw new ValidationCommandError(issue ? `Work order ${issue.path.join(".") || "command"}: ${issue.message}` : "Work order command failed validation", { reason: "invalid_work_order_command_payload" });
    }
    throw error;
  }
  if (WORK_ORDER_REVISIONED_COMMANDS.includes(kind) && envelope.expectedRevision === undefined) {
    throw new ValidationCommandError("Supply the work order revision you read before editing", { reason: "work_order_revision_required" });
  }
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: WORK_ORDER_COMMAND_POLICIES[kind],
    handler: (context) => handler({ ...context, finance: options.financeFactory?.(context.executor) } as FinanceContext),
  });
}
