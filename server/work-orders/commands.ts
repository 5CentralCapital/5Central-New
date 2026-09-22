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
import { assertEntityPropertyUnit, dbDate, dbNullableCents, dbNullableDate, dbNullableString, dbRevision, dbString, resolveEffectiveDate } from "../projects/helpers";

type AnyEnvelope = CommandEnvelope<Record<string, unknown>>;
type Context = CommandHandlerContext<Record<string, unknown>>;

export interface WorkOrderCommandExecutionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

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
  readonly recordRevision: Revision;
}

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function saved(id: string, revision: Revision): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [id],
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(id), revision }],
    validationOutcomes: [{ code: "work_order.saved_in_rops", severity: "info", message: "Work order saved in R-ops. No charge, bill or payment was posted." }],
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
            chargeback_description, chargeback_ledger_transaction_id, record_revision
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

const handlers: Record<WorkOrderCommandKind, (context: Context) => Promise<CommandHandlerResult>> = {
  "work_order.create": handleCreate,
  "work_order.update": handleUpdate,
  "work_order.status.change": handleStatusChange,
  "work_order.note.add": handleNote,
  "work_order.project.link": handleProjectLink,
  "work_order.chargeback.set": handleChargebackSet,
  "work_order.chargeback.clear": handleChargebackClear,
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
    handler: handler as (context: CommandHandlerContext<Record<string, unknown>>) => Promise<CommandHandlerResult>,
  });
}
