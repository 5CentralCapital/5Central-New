import {
  centsFromBigInt,
  centsToBigInt,
  assertExpectedRevision,
  commandEnvelopeSchema,
  newRecordId,
  recordReferenceIdSchema,
  type CommandEnvelope,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  financialSourceCoverageSchema,
  financialSourceLineResolutionSchema,
  financialSourceReferenceSchema,
  financialSourceScopeKey,
  type FinancialProviderCostContextPort,
  type FinancialSourceAllocationPort,
  type FinancialSourceReadPort,
  type FinancialSourceReference,
} from "../../shared/accounting/source";
import {
  projectExecutionCommandKinds,
  projectExecutionCommandPayloadSchemas,
  projectIdSchema,
  projectTemplateIdSchema,
  type ProjectExecutionCommandKind,
  type ProjectExecutionCommandPayload,
} from "../../shared/projects";
import {
  type AuthenticatedPrincipal,
  type CommandAuthorizationPolicy,
  type TransportAttestation,
} from "../company/authorization";
import {
  runCompanyCommand,
  type CommandHandlerContext,
  type CommandHandlerResult,
} from "../company/commands/runner";
import { ConflictCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { hasProjectCostDirection } from "./cost-direction";
import {
  assertEntityPropertyUnit,
  assertProjectScope,
  assertScopeItemForProject,
  calculateEstimatedCents,
  dbCents,
  dbDate,
  dbNullableString,
  dbRevision,
  dbString,
  resolveEffectiveDate,
} from "./helpers";

export interface ProjectExecutionFinancePorts {
  readonly source: FinancialSourceReadPort;
  readonly allocations: FinancialSourceAllocationPort;
  readonly costContext: FinancialProviderCostContextPort;
}

export interface ProjectExecutionCommandOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
  /** Build transaction-bound finance ports after the company command transaction opens. */
  readonly financeFactory?: (executor: RentOpsQueryExecutor) => ProjectExecutionFinancePorts;
}

const EXECUTION_WRITE_ROLES = ["owner", "admin", "operations_pm", "project_manager", "finance"] as const;

export const PROJECT_EXECUTION_COMMAND_POLICIES: Readonly<Record<ProjectExecutionCommandKind, CommandAuthorizationPolicy>> = Object.freeze(
  Object.fromEntries(projectExecutionCommandKinds.map((commandKind) => [commandKind, { commandKind, allowedRoles: EXECUTION_WRITE_ROLES }])) as unknown as Record<ProjectExecutionCommandKind, CommandAuthorizationPolicy>,
);

type AnyExecutionEnvelope = CommandEnvelope<Record<string, unknown>>;
type FinanceCommandContext = CommandHandlerContext<unknown> & { readonly finance?: ProjectExecutionFinancePorts };

function savedExecutionResult(childId: string, projectId?: string, projectRevision?: Revision): CommandHandlerResult {
  const affected = projectId === undefined ? [childId] : [childId, projectId];
  return {
    state: "saved_in_rops",
    affectedRecordIds: affected,
    resultingRevisions: projectId === undefined || projectRevision === undefined
      ? []
      : [{ recordId: recordReferenceIdSchema.parse(projectId), revision: projectRevision }],
    validationOutcomes: [{ code: "project.execution.saved_in_rops", severity: "info", message: "Project execution record saved in R-ops" }],
  };
}

async function lockProject(context: CommandHandlerContext<unknown>, projectId: string) {
  const effectiveDate = resolveEffectiveDate(context.envelope.effectiveDate);
  await context.executor.query(
    `UPDATE company_projects SET record_revision = record_revision WHERE organization_id = $1 AND id = $2`,
    [context.envelope.scope.organizationId, projectId],
  );
  const project = await assertProjectScope(context.executor, context.envelope.scope, projectId, effectiveDate);
  if (project.status === "archived") throw new ConflictCommandError("Archived projects cannot be edited", { reason: "project_archived" });
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  await assertEntityPropertyUnit(context.executor, {
    organizationId: context.envelope.scope.organizationId,
    legalEntityId: project.legalEntityId,
    propertyId: project.propertyId,
    unitId: project.unitId,
    effectiveDate,
  });
  return project;
}

async function touchProject(context: CommandHandlerContext<unknown>, projectId: string): Promise<Revision> {
  const result = await context.executor.query<{ record_revision: number | string }>(
    `UPDATE company_projects SET record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2
      RETURNING record_revision`,
    [context.envelope.scope.organizationId, projectId],
  );
  return dbRevision(result.rows[0]?.record_revision ?? 0);
}

function ensureCurrency(projectCurrency: string, payloadCurrency: string): void {
  if (projectCurrency !== payloadCurrency) throw new ValidationCommandError("Execution currency must match the project currency", { reason: "project_currency_mismatch" });
}

function requireFinance(context: CommandHandlerContext<unknown>): ProjectExecutionFinancePorts {
  const finance = (context as FinanceCommandContext).finance;
  if (!finance) throw new ValidationCommandError("Verified finance source is unavailable", { reason: "project_finance_unavailable" });
  return finance;
}

function sourceKey(source: FinancialSourceReference): string {
  return [financialSourceScopeKey({ provider: source.provider, organizationId: source.organizationId, legalEntityId: source.legalEntityId, environment: source.environment, realmId: source.realmId }), source.objectType, source.objectId, source.lineId ?? "*", source.version].join("\u0000");
}

async function verifyBindingSource(context: CommandHandlerContext<unknown>, sourceInput: FinancialSourceReference, allocatedCents: string, effectiveDate: string, expectedCurrency: string): Promise<ReturnType<typeof financialSourceLineResolutionSchema.parse>> {
  const finance = requireFinance(context);
  const source = financialSourceReferenceSchema.parse(sourceInput);
  if (source.lineId === null) throw new ValidationCommandError("A QBO source line is required", { reason: "project_finance_line_required" });
  const coverage = financialSourceCoverageSchema.parse(await finance.source.readCoverage({ provider: source.provider, organizationId: source.organizationId, legalEntityId: source.legalEntityId, environment: source.environment, realmId: source.realmId }));
  if (coverage.status === "unavailable" || coverage.evidence !== "live_provider_readback") throw new ValidationCommandError("A live finance readback is required", { reason: "project_finance_unverified" });
  const line = await finance.source.resolveLine({
    scope: { provider: source.provider, organizationId: source.organizationId, legalEntityId: source.legalEntityId, environment: source.environment, realmId: source.realmId },
    objectType: source.objectType,
    objectId: source.objectId,
    lineId: source.lineId,
    // Resolve the current mirror row; a version mismatch makes this binding stale.
  });
  if (!line) throw new ValidationCommandError("The QBO source line is not available", { reason: "project_finance_line_not_found" });
  const resolved = financialSourceLineResolutionSchema.parse(line);
  if (sourceKey(resolved.source) !== sourceKey(source)) throw new ValidationCommandError("The QBO source line revision is stale", { reason: "project_finance_revision_mismatch" });
  if (resolved.postingState !== "posted" || resolved.postedOn === null || resolved.postedOn > effectiveDate) throw new ValidationCommandError("The QBO source line is not posted for this effective date", { reason: "project_finance_line_not_posted" });
  if (!hasProjectCostDirection(resolved)) throw new ValidationCommandError("The QBO source line is not an eligible project cost", { reason: "project_finance_line_ineligible" });
  if (resolved.currency !== expectedCurrency) throw new ValidationCommandError("The QBO source line currency does not match the project", { reason: "project_finance_currency_mismatch" });
  const costContext = await finance.costContext.readCostContext({
    scope: { provider: source.provider, organizationId: source.organizationId, legalEntityId: source.legalEntityId, environment: source.environment, realmId: source.realmId },
    objectType: resolved.source.objectType,
    objectId: resolved.source.objectId,
    lineId: resolved.source.lineId ?? undefined,
  });
  if (
    !costContext
    || sourceKey(costContext.source) !== sourceKey(resolved.source)
    || costContext.accountObjectId !== resolved.accountObjectId
    || costContext.amountCents !== resolved.amountCents
    || costContext.currency !== resolved.currency
    || costContext.postedOn !== resolved.postedOn
    || costContext.postingState !== "posted"
    || !costContext.eligible
    || !["expense", "cogs", "capitalized_cost"].includes(costContext.classification)
  ) {
    throw new ValidationCommandError("The QBO source account is not an eligible project cost", { reason: "project_finance_account_ineligible" });
  }
  if (centsToBigInt(allocatedCents) > centsToBigInt(resolved.amountCents)) throw new ValidationCommandError("The binding allocation exceeds the source line", { reason: "project_finance_allocation_exceeded" });
  return resolved;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asText(value: unknown, field: string): string {
  return dbString(value, field);
}

function rowCents(value: unknown, field: string): ReturnType<typeof dbCents> {
  if (typeof value === "bigint") return dbCents(value.toString(), field);
  if (typeof value === "number" && Number.isSafeInteger(value)) return dbCents(String(value), field);
  return dbCents(value, field);
}

function decimalPercentOfCents(cents: string, percent: string): string {
  const [whole, fraction = ""] = percent.split(".");
  const scale = BigInt(10 ** fraction.length);
  const percentNumerator = BigInt(whole) * scale + BigInt(fraction || "0");
  return ((BigInt(cents) * percentNumerator) / (BigInt(100) * scale)).toString();
}

async function loadExecutionRow(context: CommandHandlerContext<unknown>, table: string, id: string, fields = "*"): Promise<Record<string, unknown>> {
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT ${fields} FROM ${table} WHERE organization_id = $1 AND id = $2`,
    [context.envelope.scope.organizationId, id],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Execution record was not found in the requested company scope", { reason: "project_execution_record_not_found" });
  return row;
}

async function executionProject(context: CommandHandlerContext<unknown>, table: string, id: string): Promise<{ row: Record<string, unknown>; project: Awaited<ReturnType<typeof lockProject>> }> {
  const row = await loadExecutionRow(context, table, id, "*");
  const projectId = asText(row.project_id, "execution_project_id");
  const project = await lockProject(context, projectId);
  return { row, project };
}

function addUpdate(updates: string[], values: unknown[], column: string, value: unknown): void {
  updates.push(`${column} = $${values.length + 1}`);
  values.push(value);
}

async function updateExecutionRow(
  context: CommandHandlerContext<unknown>,
  table: string,
  id: string,
  projectId: string,
  updates: string[],
  values: unknown[],
  includeUpdatedAt = true,
): Promise<Revision> {
  if (updates.length === 0) throw new ValidationCommandError("At least one execution field is required", { reason: "empty_project_execution_update" });
  const nextValues = [...values, context.envelope.scope.organizationId, id, projectId];
  const result = await context.executor.query(
    `UPDATE ${table} SET ${updates.join(", ")}${includeUpdatedAt ? ", updated_at = now()" : ""}
      WHERE organization_id = $${values.length + 1} AND id = $${values.length + 2} AND project_id = $${values.length + 3}
      RETURNING id`,
    nextValues,
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Execution record changed while it was being edited", { reason: "project_execution_record_conflict" });
  return touchProject(context, projectId);
}

async function recalculateDraw(context: CommandHandlerContext<unknown>, drawRequestId: string, projectId: string): Promise<void> {
  await context.executor.query(
    `UPDATE company_project_draw_requests
        SET gross_eligible_cents = totals.gross_cents,
            retainage_cents = totals.retainage_cents,
            net_requested_cents = totals.gross_cents - totals.retainage_cents,
            updated_at = now()
       FROM (SELECT COALESCE(SUM(requested_cents),0)::bigint AS gross_cents,
                    COALESCE(SUM(retainage_cents),0)::bigint AS retainage_cents
               FROM company_project_draw_request_items
              WHERE organization_id = $1 AND project_id = $2 AND draw_request_id = $3) totals
      WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
    [context.envelope.scope.organizationId, projectId, drawRequestId],
  );
}

async function resolveDrawSourceEligibility(
  context: CommandHandlerContext<unknown>,
  sourceType: string,
  sourceId: string,
  projectId: string,
  project: Awaited<ReturnType<typeof lockProject>>,
): Promise<string> {
  const organizationId = context.envelope.scope.organizationId;
  if (sourceType === "commitment") {
    const result = await context.executor.query<Record<string, unknown>>(
      `SELECT committed_cents::text AS eligible_cents, currency, status
         FROM company_project_commitments
        WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [organizationId, projectId, sourceId],
    );
    const row = result.rows[0];
    const status = row ? dbString(row.status, "draw_commitment_status") : null;
    if (!row || (status !== "approved" && status !== "closed")) throw new ValidationCommandError("Draw source is not an eligible project record", { reason: "project_draw_source_not_eligible" });
    ensureCurrency(project.currency, dbString(row.currency, "draw_commitment_currency"));
    return rowCents(row.eligible_cents, "draw_commitment_eligible");
  }
  if (sourceType === "change_order") {
    const result = await context.executor.query<Record<string, unknown>>(
      `SELECT amount_cents::text AS eligible_cents, currency, status
         FROM company_project_change_orders
        WHERE organization_id=$1 AND project_id=$2 AND id=$3`,
      [organizationId, projectId, sourceId],
    );
    const row = result.rows[0];
    if (!row || dbString(row.status, "draw_change_status") !== "approved") throw new ValidationCommandError("Draw source is not an eligible project record", { reason: "project_draw_source_not_eligible" });
    ensureCurrency(project.currency, dbString(row.currency, "draw_change_currency"));
    const amount = rowCents(row.eligible_cents, "draw_change_eligible");
    return centsFromBigInt(centsToBigInt(amount) < BigInt(0) ? BigInt(0) : centsToBigInt(amount));
  }
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT provider, environment, realm_id, object_type, object_id, line_id, source_version, allocated_cents::text AS allocated_cents
       FROM company_project_finance_bindings
      WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND binding_status='verified' AND eligible=true`,
    [organizationId, projectId, sourceId],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Draw source is not an eligible project record", { reason: "project_draw_source_not_eligible" });
  const source = financialSourceReferenceSchema.parse({
    provider: row.provider,
    organizationId,
    legalEntityId: project.legalEntityId,
    environment: row.environment,
    realmId: row.realm_id,
    objectType: row.object_type,
    objectId: row.object_id,
    lineId: row.line_id,
    version: row.source_version,
  });
  const allocated = rowCents(row.allocated_cents, "draw_actual_eligible");
  const line = await verifyBindingSource(context, source, allocated, resolveEffectiveDate(context.envelope.effectiveDate), project.currency);
  if (line.direction !== "debit") throw new ValidationCommandError("A project cost refund cannot fund a draw request", { reason: "project_draw_refund_ineligible" });
  return allocated;
}

async function assertDrawCapacity(
  context: CommandHandlerContext<unknown>,
  sourceType: string,
  sourceId: string,
  requestedCents: string,
  projectId: string,
  project: Awaited<ReturnType<typeof lockProject>>,
  excludeItemId?: string,
): Promise<string> {
  const eligible = await resolveDrawSourceEligibility(context, sourceType, sourceId, projectId, project);
  const values: unknown[] = [context.envelope.scope.organizationId, projectId, sourceType, sourceId];
  const exclusion = excludeItemId === undefined ? "" : ` AND i.id <> $${values.push(excludeItemId)}`;
  const result = await context.executor.query<{ requested_cents: unknown }>(
    `SELECT COALESCE(SUM(i.requested_cents),0)::text AS requested_cents
       FROM company_project_draw_request_items i
       JOIN company_project_draw_requests d
         ON d.organization_id=i.organization_id AND d.project_id=i.project_id AND d.id=i.draw_request_id
      WHERE i.organization_id=$1 AND i.project_id=$2 AND i.source_type=$3 AND i.source_id=$4
        AND d.status NOT IN ('void','rejected')${exclusion}`,
    values,
  );
  const alreadyRequested = rowCents(result.rows[0]?.requested_cents ?? "0", "draw_source_requested");
  if (centsToBigInt(alreadyRequested) + centsToBigInt(requestedCents) > centsToBigInt(eligible)) {
    throw new ValidationCommandError("Draw request exceeds the source eligibility", { reason: "project_draw_source_overdrawn" });
  }
  return eligible;
}

function offsetIsoDate(value: string | null, days: number): string | null {
  if (value === null) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new ValidationCommandError("Template task start date is invalid", { reason: "project_template_task_date" });
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function assertVendor(context: CommandHandlerContext<unknown>, vendorId: string): Promise<void> {
  const result = await context.executor.query(`SELECT 1 FROM company_project_vendors WHERE organization_id = $1 AND id = $2 AND status <> 'inactive'`, [context.envelope.scope.organizationId, vendorId]);
  if (result.rows.length !== 1) throw new ValidationCommandError("Vendor is not available in this company", { reason: "project_vendor_not_found" });
}

async function assertBid(context: CommandHandlerContext<unknown>, bidId: string, projectId: string): Promise<void> {
  const result = await context.executor.query(`SELECT 1 FROM company_project_bids WHERE organization_id = $1 AND id = $2 AND project_id = $3`, [context.envelope.scope.organizationId, bidId, projectId]);
  if (result.rows.length !== 1) throw new ValidationCommandError("Bid is not part of the selected project", { reason: "project_bid_not_found" });
}

async function assertCommitment(context: CommandHandlerContext<unknown>, commitmentId: string, projectId: string): Promise<void> {
  const result = await context.executor.query(`SELECT 1 FROM company_project_commitments WHERE organization_id = $1 AND id = $2 AND project_id = $3 AND status <> 'void'`, [context.envelope.scope.organizationId, commitmentId, projectId]);
  if (result.rows.length !== 1) throw new ValidationCommandError("Commitment is not part of the selected project", { reason: "project_commitment_not_found" });
}

async function handleTemplateCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.template.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.template.create"].parse(context.envelope.payload);
  const id = projectTemplateIdSchema.parse(newRecordId());
  await context.executor.query(
    `INSERT INTO company_project_templates (id, organization_id, name, project_type, description, currency, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, context.envelope.scope.organizationId, payload.name, payload.projectType, payload.description ?? null, payload.currency ?? null, context.principal.actorId],
  );
  return savedExecutionResult(id);
}

async function handleTemplateInstantiate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.template.instantiate"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.template.instantiate"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  const template = await context.executor.query<Record<string, unknown>>(
    `SELECT id, currency FROM company_project_templates WHERE organization_id = $1 AND id = $2 AND active = true`,
    [context.envelope.scope.organizationId, payload.templateId],
  );
  const templateRow = template.rows[0];
  if (!templateRow) throw new ValidationCommandError("Project template is not available", { reason: "project_template_not_found" });
  const templateCurrency = dbNullableString(templateRow.currency, "template_currency");
  if (templateCurrency !== null && templateCurrency !== project.currency) throw new ValidationCommandError("Template currency does not match the project currency", { reason: "project_template_currency_mismatch" });
  const scopeRows = await context.executor.query<Record<string, unknown>>(
    `SELECT id, description, category, unit_label, quantity::text AS quantity, rate_cents::text AS rate_cents, position
       FROM company_project_template_scope_items WHERE organization_id = $1 AND template_id = $2 ORDER BY position, id`,
    [context.envelope.scope.organizationId, payload.templateId],
  );
  const taskRows = await context.executor.query<Record<string, unknown>>(
    `SELECT title, description, relative_days, position
       FROM company_project_template_tasks WHERE organization_id = $1 AND template_id = $2 ORDER BY position, id`,
    [context.envelope.scope.organizationId, payload.templateId],
  );
  const insertedIds: string[] = [];
  for (const row of scopeRows.rows) {
    const id = newRecordId();
    const quantity = dbString(row.quantity, "template_quantity");
    const rate = dbCents(row.rate_cents, "template_rate_cents");
    await context.executor.query(
      `INSERT INTO company_project_scope_items
        (id, organization_id, project_id, description, category, unit_label, quantity, rate_cents, estimated_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9)`,
      [id, context.envelope.scope.organizationId, payload.projectId, dbString(row.description, "template_description"), dbNullableString(row.category, "template_category"), dbNullableString(row.unit_label, "template_unit_label"), quantity, rate, calculateEstimatedCents(quantity, rate)],
    );
    insertedIds.push(id);
  }
  for (const row of taskRows.rows) {
    const id = newRecordId();
    const relativeDays = Number(row.relative_days);
    if (!Number.isSafeInteger(relativeDays) || relativeDays < 0) throw new ValidationCommandError("Template task relative days are invalid", { reason: "project_template_task_days" });
    const startsOn = payload.startOn ?? project.startOn;
    const dueOn = offsetIsoDate(startsOn, relativeDays);
    await context.executor.query(
      `INSERT INTO company_project_tasks (id, organization_id, project_id, title, description, status, starts_on, due_on)
       VALUES ($1,$2,$3,$4,$5,'not_started',$6::date,$7::date)`,
      [id, context.envelope.scope.organizationId, payload.projectId, dbString(row.title, "template_task_title"), dbNullableString(row.description, "template_task_description"), startsOn, dueOn],
    );
    insertedIds.push(id);
  }
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  return {
    ...savedExecutionResult(payload.projectId, payload.projectId, projectRevision),
    affectedRecordIds: [payload.projectId, ...insertedIds],
  };
}

async function handleAssignmentCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.assignment.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.assignment.create"].parse(context.envelope.payload);
  await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_assignments (id, organization_id, project_id, assignee_type, assignee_ref, role, starts_on, due_on, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.assigneeType, payload.assigneeRef, payload.role, payload.startsOn ?? null, payload.dueOn ?? null, payload.notes ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleMilestoneCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.milestone.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.milestone.create"].parse(context.envelope.payload);
  await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_milestones (id, organization_id, project_id, name, description, target_on, position)
     VALUES ($1,$2,$3,$4,$5,$6::date,COALESCE($7,(SELECT COALESCE(MAX(position),-1)+1 FROM company_project_milestones WHERE organization_id=$2 AND project_id=$3)))`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.name, payload.description ?? null, payload.targetOn ?? null, payload.position ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleInspectionCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.inspection.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.inspection.create"].parse(context.envelope.payload);
  await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_inspections (id, organization_id, project_id, inspection_type, scheduled_on, inspector_ref, notes)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.inspectionType, payload.scheduledOn ?? null, payload.inspectorRef ?? null, payload.notes ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handlePunchItemCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.punch_item.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.punch_item.create"].parse(context.envelope.payload);
  await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  if (payload.inspectionId !== undefined && payload.inspectionId !== null) {
    const inspection = await context.executor.query(`SELECT 1 FROM company_project_inspections WHERE organization_id=$1 AND id=$2 AND project_id=$3`, [context.envelope.scope.organizationId, payload.inspectionId, payload.projectId]);
    if (inspection.rows.length !== 1) throw new ValidationCommandError("Inspection is not part of the selected project", { reason: "project_inspection_not_found" });
  }
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_punch_items (id, organization_id, project_id, inspection_id, description, location, assigned_to, due_on, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.inspectionId ?? null, payload.description, payload.location ?? null, payload.assignedTo ?? null, payload.dueOn ?? null, payload.notes ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleVendorCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.vendor.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.vendor.create"].parse(context.envelope.payload);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_vendors (id, organization_id, name, contact_ref, license_ref, insurance_expires_on, notes)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7)`,
    [id, context.envelope.scope.organizationId, payload.name, payload.contactRef ?? null, payload.licenseRef ?? null, payload.insuranceExpiresOn ?? null, payload.notes ?? null],
  );
  return savedExecutionResult(id);
}

async function handleBidCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.bid.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.bid.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  await assertVendor(context as unknown as CommandHandlerContext<unknown>, payload.vendorId);
  if (payload.scopeItemId !== undefined && payload.scopeItemId !== null) await assertScopeItemForProject(context.executor, { organizationId: context.envelope.scope.organizationId, projectId: payload.projectId, scopeItemId: payload.scopeItemId });
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_bids (id, organization_id, project_id, vendor_id, scope_item_id, amount_cents, currency, submitted_on, valid_until, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.vendorId, payload.scopeItemId ?? null, payload.amountCents, project.currency, payload.submittedOn ?? null, payload.validUntil ?? null, payload.notes ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleCommitmentCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.commitment.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.commitment.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  if (payload.vendorId !== undefined && payload.vendorId !== null) await assertVendor(context as unknown as CommandHandlerContext<unknown>, payload.vendorId);
  if (payload.bidId !== undefined && payload.bidId !== null) await assertBid(context as unknown as CommandHandlerContext<unknown>, payload.bidId, payload.projectId);
  ensureCurrency(project.currency, payload.currency);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_commitments (id, organization_id, project_id, vendor_id, bid_id, description, original_cents, approved_change_cents, committed_cents, currency, start_on, target_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,$8,$9::date,$10::date)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.vendorId ?? null, payload.bidId ?? null, payload.description, payload.originalCents, payload.currency, payload.startOn ?? null, payload.targetOn ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleChangeOrderCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.change_order.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.change_order.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  if (payload.commitmentId !== undefined && payload.commitmentId !== null) await assertCommitment(context as unknown as CommandHandlerContext<unknown>, payload.commitmentId, payload.projectId);
  ensureCurrency(project.currency, payload.currency);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_change_orders (id, organization_id, project_id, commitment_id, description, reason, amount_cents, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.commitmentId ?? null, payload.description, payload.reason, payload.amountCents, payload.currency],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handlePurchaseOrderCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.purchase_order.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.purchase_order.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  await assertCommitment(context as unknown as CommandHandlerContext<unknown>, payload.commitmentId, payload.projectId);
  ensureCurrency(project.currency, payload.currency);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_purchase_orders (id, organization_id, project_id, commitment_id, po_number, amount_cents, currency, issued_on, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.commitmentId, payload.poNumber, payload.amountCents, payload.currency, payload.issuedOn ?? null, payload.notes ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleDrawRequestCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.draw_request.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.draw_request.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  ensureCurrency(project.currency, payload.currency);
  const id = newRecordId();
  const requestNo = await context.executor.query<{ request_no: number | string }>(
    `SELECT COALESCE(MAX(request_no),0)+1 AS request_no FROM company_project_draw_requests WHERE organization_id=$1 AND project_id=$2`,
    [context.envelope.scope.organizationId, payload.projectId],
  );
  await context.executor.query(
    `INSERT INTO company_project_draw_requests
       (id, organization_id, project_id, request_no, period_from, period_to, gross_eligible_cents, retainage_percent, retainage_cents, net_requested_cents, currency, notes)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,0,$7,0,0,$8,$9)`,
    [id, context.envelope.scope.organizationId, payload.projectId, Number(requestNo.rows[0]?.request_no ?? 1), payload.periodFrom, payload.periodTo, payload.retainagePercent, payload.currency, payload.notes ?? null],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleAssignmentUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.assignment.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.assignment.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_assignments", payload.assignmentId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.assigneeType !== undefined) addUpdate(updates, values, "assignee_type", payload.assigneeType);
  if (payload.assigneeRef !== undefined) addUpdate(updates, values, "assignee_ref", payload.assigneeRef);
  if (payload.role !== undefined) addUpdate(updates, values, "role", payload.role);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (hasOwn(payload, "startsOn")) addUpdate(updates, values, "starts_on", payload.startsOn ?? null);
  if (hasOwn(payload, "dueOn")) addUpdate(updates, values, "due_on", payload.dueOn ?? null);
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_assignments", payload.assignmentId, asText(row.project_id, "assignment_project_id"), updates, values);
  return savedExecutionResult(payload.assignmentId, asText(row.project_id, "assignment_project_id"), revision);
}

async function handleMilestoneUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.milestone.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.milestone.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_milestones", payload.milestoneId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "milestone_project_id");
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.name !== undefined) addUpdate(updates, values, "name", payload.name);
  if (hasOwn(payload, "description")) addUpdate(updates, values, "description", payload.description ?? null);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (hasOwn(payload, "targetOn")) addUpdate(updates, values, "target_on", payload.targetOn ?? null);
  if (hasOwn(payload, "completedOn")) addUpdate(updates, values, "completed_on", payload.completedOn ?? null);
  if (payload.status === "complete" && !hasOwn(payload, "completedOn")) addUpdate(updates, values, "completed_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (payload.position !== undefined) addUpdate(updates, values, "position", payload.position);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_milestones", payload.milestoneId, projectId, updates, values);
  return savedExecutionResult(payload.milestoneId, projectId, revision);
}

async function handleInspectionUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.inspection.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.inspection.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_inspections", payload.inspectionId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "inspection_project_id");
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.inspectionType !== undefined) addUpdate(updates, values, "inspection_type", payload.inspectionType);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (hasOwn(payload, "scheduledOn")) addUpdate(updates, values, "scheduled_on", payload.scheduledOn ?? null);
  if (hasOwn(payload, "inspectedOn")) addUpdate(updates, values, "inspected_on", payload.inspectedOn ?? null);
  if (payload.status !== undefined && ["passed", "failed", "conditional"].includes(payload.status) && !hasOwn(payload, "inspectedOn")) addUpdate(updates, values, "inspected_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (hasOwn(payload, "inspectorRef")) addUpdate(updates, values, "inspector_ref", payload.inspectorRef ?? null);
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  if (hasOwn(payload, "documentRef")) addUpdate(updates, values, "document_ref", payload.documentRef ?? null);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_inspections", payload.inspectionId, projectId, updates, values);
  return savedExecutionResult(payload.inspectionId, projectId, revision);
}

async function handlePunchItemUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.punch_item.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.punch_item.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_punch_items", payload.punchItemId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "punch_project_id");
  if (hasOwn(payload, "inspectionId") && payload.inspectionId !== null) {
    const inspection = await context.executor.query(`SELECT 1 FROM company_project_inspections WHERE organization_id=$1 AND project_id=$2 AND id=$3`, [context.envelope.scope.organizationId, projectId, payload.inspectionId]);
    if (inspection.rows.length !== 1) throw new ValidationCommandError("Inspection is not part of the selected project", { reason: "project_inspection_not_found" });
  }
  const updates: string[] = [];
  const values: unknown[] = [];
  if (hasOwn(payload, "inspectionId")) addUpdate(updates, values, "inspection_id", payload.inspectionId ?? null);
  if (payload.description !== undefined) addUpdate(updates, values, "description", payload.description);
  if (hasOwn(payload, "location")) addUpdate(updates, values, "location", payload.location ?? null);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (hasOwn(payload, "assignedTo")) addUpdate(updates, values, "assigned_to", payload.assignedTo ?? null);
  if (hasOwn(payload, "dueOn")) addUpdate(updates, values, "due_on", payload.dueOn ?? null);
  if (hasOwn(payload, "completedOn")) addUpdate(updates, values, "completed_on", payload.completedOn ?? null);
  if (payload.status !== undefined && ["complete", "waived"].includes(payload.status) && !hasOwn(payload, "completedOn")) addUpdate(updates, values, "completed_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_punch_items", payload.punchItemId, projectId, updates, values);
  return savedExecutionResult(payload.punchItemId, projectId, revision);
}

async function handleVendorUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.vendor.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.vendor.update"].parse(context.envelope.payload);
  await loadExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_vendors", payload.vendorId);
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.name !== undefined) addUpdate(updates, values, "name", payload.name);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (hasOwn(payload, "contactRef")) addUpdate(updates, values, "contact_ref", payload.contactRef ?? null);
  if (hasOwn(payload, "licenseRef")) addUpdate(updates, values, "license_ref", payload.licenseRef ?? null);
  if (hasOwn(payload, "insuranceExpiresOn")) addUpdate(updates, values, "insurance_expires_on", payload.insuranceExpiresOn ?? null);
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  if (updates.length === 0) throw new ValidationCommandError("At least one vendor field is required", { reason: "empty_project_vendor_update" });
  const nextValues = [...values, context.envelope.scope.organizationId, payload.vendorId];
  const result = await context.executor.query(`UPDATE company_project_vendors SET ${updates.join(", ")}, updated_at=now() WHERE organization_id=$${values.length + 1} AND id=$${values.length + 2} RETURNING id`, nextValues);
  if (result.rows.length !== 1) throw new ConflictCommandError("Vendor changed while it was being edited", { reason: "project_vendor_conflict" });
  return savedExecutionResult(payload.vendorId);
}

async function handleBidUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.bid.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.bid.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_bids", payload.bidId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "bid_project_id");
  if (payload.vendorId !== undefined) await assertVendor(context as unknown as CommandHandlerContext<unknown>, payload.vendorId);
  if (payload.scopeItemId !== undefined && payload.scopeItemId !== null) await assertScopeItemForProject(context.executor, { organizationId: context.envelope.scope.organizationId, projectId, scopeItemId: payload.scopeItemId });
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.vendorId !== undefined) addUpdate(updates, values, "vendor_id", payload.vendorId);
  if (hasOwn(payload, "scopeItemId")) addUpdate(updates, values, "scope_item_id", payload.scopeItemId ?? null);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (payload.amountCents !== undefined) addUpdate(updates, values, "amount_cents", payload.amountCents);
  if (hasOwn(payload, "submittedOn")) addUpdate(updates, values, "submitted_on", payload.submittedOn ?? null);
  if (hasOwn(payload, "validUntil")) addUpdate(updates, values, "valid_until", payload.validUntil ?? null);
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_bids", payload.bidId, projectId, updates, values);
  return savedExecutionResult(payload.bidId, projectId, revision);
}

async function handleCommitmentUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.commitment.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.commitment.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_commitments", payload.commitmentId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "commitment_project_id");
  if (payload.vendorId !== undefined && payload.vendorId !== null) await assertVendor(context as unknown as CommandHandlerContext<unknown>, payload.vendorId);
  if (payload.bidId !== undefined && payload.bidId !== null) await assertBid(context as unknown as CommandHandlerContext<unknown>, payload.bidId, projectId);
  const original = payload.originalCents ?? rowCents(row.original_cents, "commitment_original_cents");
  const approvedChange = payload.approvedChangeCents ?? rowCents(row.approved_change_cents, "commitment_approved_change_cents");
  const committed = centsToBigInt(original) + centsToBigInt(approvedChange);
  if (committed < BigInt(0)) throw new ValidationCommandError("Commitment total cannot be negative", { reason: "project_commitment_negative" });
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.vendorId !== undefined) addUpdate(updates, values, "vendor_id", payload.vendorId);
  if (payload.bidId !== undefined) addUpdate(updates, values, "bid_id", payload.bidId);
  if (payload.description !== undefined) addUpdate(updates, values, "description", payload.description);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (payload.originalCents !== undefined || payload.approvedChangeCents !== undefined) { addUpdate(updates, values, "original_cents", original); addUpdate(updates, values, "approved_change_cents", approvedChange); addUpdate(updates, values, "committed_cents", centsFromBigInt(committed)); }
  if (hasOwn(payload, "startOn")) addUpdate(updates, values, "start_on", payload.startOn ?? null);
  if (hasOwn(payload, "targetOn")) addUpdate(updates, values, "target_on", payload.targetOn ?? null);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_commitments", payload.commitmentId, projectId, updates, values);
  return savedExecutionResult(payload.commitmentId, projectId, revision);
}

async function handleChangeOrderUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.change_order.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.change_order.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_change_orders", payload.changeOrderId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "change_order_project_id");
  if (payload.commitmentId !== undefined && payload.commitmentId !== null) await assertCommitment(context as unknown as CommandHandlerContext<unknown>, payload.commitmentId, projectId);
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.commitmentId !== undefined) addUpdate(updates, values, "commitment_id", payload.commitmentId);
  if (payload.description !== undefined) addUpdate(updates, values, "description", payload.description);
  if (payload.reason !== undefined) addUpdate(updates, values, "reason", payload.reason);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (payload.amountCents !== undefined) addUpdate(updates, values, "amount_cents", payload.amountCents);
  if (hasOwn(payload, "includedInBudgetVersionId")) addUpdate(updates, values, "included_in_budget_version_id", payload.includedInBudgetVersionId ?? null);
  if (hasOwn(payload, "submittedOn")) addUpdate(updates, values, "submitted_on", payload.submittedOn ?? null);
  if (hasOwn(payload, "approvedOn")) addUpdate(updates, values, "approved_on", payload.approvedOn ?? null);
  if (payload.status === "approved" && !hasOwn(payload, "approvedOn")) addUpdate(updates, values, "approved_on", resolveEffectiveDate(context.envelope.effectiveDate));
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_change_orders", payload.changeOrderId, projectId, updates, values);
  return savedExecutionResult(payload.changeOrderId, projectId, revision);
}

async function handlePurchaseOrderUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.purchase_order.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.purchase_order.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_purchase_orders", payload.purchaseOrderId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "po_project_id");
  if (payload.commitmentId !== undefined) await assertCommitment(context as unknown as CommandHandlerContext<unknown>, payload.commitmentId, projectId);
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.commitmentId !== undefined) addUpdate(updates, values, "commitment_id", payload.commitmentId);
  if (payload.poNumber !== undefined) addUpdate(updates, values, "po_number", payload.poNumber);
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (payload.amountCents !== undefined) addUpdate(updates, values, "amount_cents", payload.amountCents);
  if (hasOwn(payload, "issuedOn")) addUpdate(updates, values, "issued_on", payload.issuedOn ?? null);
  if (hasOwn(payload, "receivedOn")) addUpdate(updates, values, "received_on", payload.receivedOn ?? null);
  if (payload.status !== undefined && ["issued", "partially_received", "received"].includes(payload.status) && !hasOwn(payload, "issuedOn")) addUpdate(updates, values, "issued_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (payload.status === "received" && !hasOwn(payload, "receivedOn")) addUpdate(updates, values, "received_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_purchase_orders", payload.purchaseOrderId, projectId, updates, values);
  return savedExecutionResult(payload.purchaseOrderId, projectId, revision);
}

async function handleDrawRequestUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.draw_request.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.draw_request.update"].parse(context.envelope.payload);
  const { row, project } = await executionProject(context as unknown as CommandHandlerContext<unknown>, "company_project_draw_requests", payload.drawRequestId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const projectId = asText(row.project_id, "draw_project_id");
  const periodFrom = payload.periodFrom ?? dbDate(row.period_from, "draw_period_from");
  const periodTo = payload.periodTo ?? dbDate(row.period_to, "draw_period_to");
  if (periodTo < periodFrom) throw new ValidationCommandError("Draw period must be valid", { reason: "project_draw_period" });
  const updates: string[] = [];
  const values: unknown[] = [];
  if (payload.status !== undefined) addUpdate(updates, values, "status", payload.status);
  if (payload.periodFrom !== undefined) addUpdate(updates, values, "period_from", payload.periodFrom);
  if (payload.periodTo !== undefined) addUpdate(updates, values, "period_to", payload.periodTo);
  if (payload.retainagePercent !== undefined) { addUpdate(updates, values, "retainage_percent", payload.retainagePercent); addUpdate(updates, values, "retainage_cents", decimalPercentOfCents(rowCents(row.gross_eligible_cents, "draw_gross"), payload.retainagePercent)); }
  if (payload.status !== undefined && ["submitted", "approved", "paid"].includes(payload.status) && (row.submitted_on === null || row.submitted_on === undefined)) addUpdate(updates, values, "submitted_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (payload.status !== undefined && ["approved", "paid"].includes(payload.status) && (row.approved_on === null || row.approved_on === undefined)) addUpdate(updates, values, "approved_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (payload.status === "paid" && (row.paid_on === null || row.paid_on === undefined)) addUpdate(updates, values, "paid_on", resolveEffectiveDate(context.envelope.effectiveDate));
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_draw_requests", payload.drawRequestId, projectId, updates, values);
  return savedExecutionResult(payload.drawRequestId, projectId, revision);
}

async function handleDrawItemCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.draw_request.item.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.draw_request.item.create"].parse(context.envelope.payload);
  const row = await loadExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_draw_requests", payload.drawRequestId, "*");
  const projectId = asText(row.project_id, "draw_project_id");
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, projectId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const eligibleCents = await assertDrawCapacity(context as unknown as CommandHandlerContext<unknown>, payload.sourceType, payload.sourceId, payload.requestedCents, projectId, project);
  if (centsToBigInt(payload.eligibleCents) !== centsToBigInt(eligibleCents)) throw new ValidationCommandError("Draw source eligibility changed; reload the project", { reason: "project_draw_source_eligibility_stale" });
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_draw_request_items
      (id, organization_id, project_id, draw_request_id, source_type, source_id, eligible_cents, requested_cents, retainage_eligible, retainage_cents, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, context.envelope.scope.organizationId, projectId, payload.drawRequestId, payload.sourceType, payload.sourceId, eligibleCents, payload.requestedCents, payload.retainageEligible, payload.retainageCents, payload.notes ?? null],
  );
  await recalculateDraw(context as unknown as CommandHandlerContext<unknown>, payload.drawRequestId, projectId);
  return savedExecutionResult(id, projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, projectId));
}

async function handleDrawItemUpdate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.draw_request.item.update"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.draw_request.item.update"].parse(context.envelope.payload);
  const item = await loadExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_draw_request_items", payload.drawRequestItemId, "*");
  const projectId = asText(item.project_id, "draw_item_project_id");
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, projectId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const requested = payload.requestedCents ?? rowCents(item.requested_cents, "draw_item_requested");
  const canonicalEligible = await assertDrawCapacity(context as unknown as CommandHandlerContext<unknown>, asText(item.source_type, "draw_item_source_type"), asText(item.source_id, "draw_item_source_id"), requested, projectId, project, payload.drawRequestItemId);
  const eligible = rowCents(item.eligible_cents, "draw_item_eligible");
  const retainageEligible = payload.retainageEligible ?? item.retainage_eligible === true;
  const retainage = payload.retainageCents ?? rowCents(item.retainage_cents, "draw_item_retainage");
  if (centsToBigInt(requested) > centsToBigInt(canonicalEligible) || centsToBigInt(retainage) > centsToBigInt(requested) || (!retainageEligible && centsToBigInt(retainage) !== BigInt(0))) throw new ValidationCommandError("Draw item amounts are not eligible", { reason: "project_draw_item_amounts" });
  const updates: string[] = [];
  const values: unknown[] = [];
  if (centsToBigInt(eligible) !== centsToBigInt(canonicalEligible)) addUpdate(updates, values, "eligible_cents", canonicalEligible);
  if (payload.requestedCents !== undefined) addUpdate(updates, values, "requested_cents", requested);
  if (payload.retainageEligible !== undefined) addUpdate(updates, values, "retainage_eligible", retainageEligible);
  if (payload.retainageCents !== undefined) addUpdate(updates, values, "retainage_cents", retainage);
  if (hasOwn(payload, "notes")) addUpdate(updates, values, "notes", payload.notes ?? null);
  const drawRequestId = asText(item.draw_request_id, "draw_item_request_id");
  const revision = await updateExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_draw_request_items", payload.drawRequestItemId, projectId, updates, values, false);
  await recalculateDraw(context as unknown as CommandHandlerContext<unknown>, drawRequestId, projectId);
  return savedExecutionResult(payload.drawRequestItemId, projectId, revision);
}

async function handleFinanceBindingCreate(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.finance_binding.create"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.finance_binding.create"].parse(context.envelope.payload);
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  const source = financialSourceReferenceSchema.parse(payload.source);
  if (source.organizationId !== context.envelope.scope.organizationId || source.legalEntityId !== project.legalEntityId) throw new ValidationCommandError("Finance source does not match the project entity", { reason: "project_finance_scope_mismatch" });
  if (payload.commitmentId !== undefined && payload.commitmentId !== null) await assertCommitment(context as unknown as CommandHandlerContext<unknown>, payload.commitmentId, payload.projectId);
  if (payload.scopeItemId !== undefined && payload.scopeItemId !== null) await assertScopeItemForProject(context.executor, { organizationId: context.envelope.scope.organizationId, projectId: payload.projectId, scopeItemId: payload.scopeItemId });
  const line = await verifyBindingSource(context as unknown as CommandHandlerContext<unknown>, source, payload.allocatedCents, resolveEffectiveDate(context.envelope.effectiveDate), project.currency);
  const finance = requireFinance(context as unknown as CommandHandlerContext<unknown>);
  const id = newRecordId();
  await finance.allocations.reserve({ source, consumerKind: "project_finance_binding", consumerId: id, amountCents: payload.allocatedCents, currency: line.currency });
  await context.executor.query(
    `INSERT INTO company_project_finance_bindings
      (id, organization_id, project_id, commitment_id, scope_item_id, provider, environment, realm_id, object_type, object_id, line_id, source_version, allocated_cents, eligible, binding_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,'verified')`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.commitmentId ?? null, payload.scopeItemId ?? null, source.provider, source.environment, source.realmId, source.objectType, source.objectId, source.lineId, source.version, payload.allocatedCents],
  );
  return savedExecutionResult(id, payload.projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId));
}

async function handleFinanceBindingRelease(context: CommandHandlerContext<ProjectExecutionCommandPayload["project.finance_binding.release"]>): Promise<CommandHandlerResult> {
  const payload = projectExecutionCommandPayloadSchemas["project.finance_binding.release"].parse(context.envelope.payload);
  const row = await loadExecutionRow(context as unknown as CommandHandlerContext<unknown>, "company_project_finance_bindings", payload.bindingId, "*");
  const projectId = asText(row.project_id, "binding_project_id");
  const project = await lockProject(context as unknown as CommandHandlerContext<unknown>, projectId);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  if (asText(row.binding_status, "binding_status") === "released") throw new ValidationCommandError("Finance binding is already released", { reason: "project_finance_binding_released" });
  const source = financialSourceReferenceSchema.parse({
    provider: row.provider,
    organizationId: context.envelope.scope.organizationId,
    legalEntityId: project.legalEntityId,
    environment: row.environment,
    realmId: row.realm_id,
    objectType: row.object_type,
    objectId: row.object_id,
    lineId: row.line_id,
    version: row.source_version,
  });
  const finance = requireFinance(context as unknown as CommandHandlerContext<unknown>);
  const balance = await finance.allocations.getBalance(source);
  await finance.allocations.release({ source, consumerKind: "project_finance_binding", consumerId: payload.bindingId, amountCents: rowCents(row.allocated_cents, "binding_allocated_cents"), currency: balance.currency });
  const result = await context.executor.query(
    `UPDATE company_project_finance_bindings SET binding_status='released', eligible=false, updated_at=now()
      WHERE organization_id=$1 AND id=$2 AND project_id=$3 AND binding_status <> 'released' RETURNING id`,
    [context.envelope.scope.organizationId, payload.bindingId, projectId],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Finance binding changed while it was being released", { reason: "project_finance_binding_conflict" });
  return savedExecutionResult(payload.bindingId, projectId, await touchProject(context as unknown as CommandHandlerContext<unknown>, projectId));
}

const handlers = {
  "project.template.create": handleTemplateCreate,
  "project.template.instantiate": handleTemplateInstantiate,
  "project.assignment.create": handleAssignmentCreate,
  "project.milestone.create": handleMilestoneCreate,
  "project.inspection.create": handleInspectionCreate,
  "project.punch_item.create": handlePunchItemCreate,
  "project.vendor.create": handleVendorCreate,
  "project.bid.create": handleBidCreate,
  "project.commitment.create": handleCommitmentCreate,
  "project.change_order.create": handleChangeOrderCreate,
  "project.purchase_order.create": handlePurchaseOrderCreate,
  "project.draw_request.create": handleDrawRequestCreate,
  "project.assignment.update": handleAssignmentUpdate,
  "project.milestone.update": handleMilestoneUpdate,
  "project.inspection.update": handleInspectionUpdate,
  "project.punch_item.update": handlePunchItemUpdate,
  "project.vendor.update": handleVendorUpdate,
  "project.bid.update": handleBidUpdate,
  "project.commitment.update": handleCommitmentUpdate,
  "project.change_order.update": handleChangeOrderUpdate,
  "project.purchase_order.update": handlePurchaseOrderUpdate,
  "project.draw_request.update": handleDrawRequestUpdate,
  "project.draw_request.item.create": handleDrawItemCreate,
  "project.draw_request.item.update": handleDrawItemUpdate,
  "project.finance_binding.create": handleFinanceBindingCreate,
  "project.finance_binding.release": handleFinanceBindingRelease,
} as const;

export async function executeProjectExecutionCommand(
  executor: RentOpsQueryExecutor,
  kind: ProjectExecutionCommandKind,
  rawEnvelope: unknown,
  options: ProjectExecutionCommandOptions,
): Promise<OperationReceipt> {
  const payloadSchema = projectExecutionCommandPayloadSchemas[kind];
  let envelope: AnyExecutionEnvelope;
  try {
    envelope = commandEnvelopeSchema(payloadSchema).parse(rawEnvelope) as unknown as AnyExecutionEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw new ValidationCommandError("Project execution command payload failed validation", { reason: "invalid_project_execution_command_payload" });
    throw error;
  }
  const handler = handlers[kind] as (context: CommandHandlerContext<any>) => Promise<CommandHandlerResult>;
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: PROJECT_EXECUTION_COMMAND_POLICIES[kind],
    handler: (context) => handler({ ...context, finance: options.financeFactory?.(context.executor) } as typeof context),
  });
}

export const runProjectExecutionCommand = executeProjectExecutionCommand;
