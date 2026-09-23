import {
  assertExpectedRevision,
  centsFromBigInt,
  centsToBigInt,
  commandEnvelopeSchema,
  newRecordId,
  recordReferenceIdSchema,
  sumCents,
  type CommandEnvelope,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  PROJECT_COMMAND_KINDS,
  approveBudgetPayloadSchema,
  archiveDraftCostPayloadSchema,
  archiveProjectPayloadSchema,
  archiveScopeItemPayloadSchema,
  archiveTaskPayloadSchema,
  createDraftCostPayloadSchema,
  createProjectPayloadSchema,
  createScopeItemPayloadSchema,
  createTaskPayloadSchema,
  parseProjectCommandPayload,
  projectCommandPayloadSchemas,
  projectIdSchema,
  projectQuantitySchema,
  setTaskDependenciesPayloadSchema,
  updateDraftCostPayloadSchema,
  updateProjectPayloadSchema,
  updateScopeItemPayloadSchema,
  updateTaskPayloadSchema,
  type ApproveBudgetPayload,
  type ArchiveDraftCostPayload,
  type ArchiveProjectPayload,
  type ArchiveScopeItemPayload,
  type ArchiveTaskPayload,
  type CreateDraftCostPayload,
  type CreateProjectPayload,
  type CreateScopeItemPayload,
  type CreateTaskPayload,
  type ProjectCommandKind,
  type SetTaskDependenciesPayload,
  type UpdateDraftCostPayload,
  type UpdateProjectPayload,
  type UpdateScopeItemPayload,
  type UpdateTaskPayload,
} from "../../shared/projects";
import {
  authorizeCommand,
  type AuthenticatedPrincipal,
  type CommandAuthorizationPolicy,
  type TransportAttestation,
} from "../company/authorization";
import {
  runCompanyCommand,
  type CommandHandlerContext,
  type CommandHandlerResult,
} from "../company/commands/runner";
import {
  ConflictCommandError,
  ForbiddenCommandError,
  ValidationCommandError,
} from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import {
  assertEntityPropertyUnit,
  assertEstimatedCents,
  assertProjectScope,
  assertScopeItemForProject,
  calculateEstimatedCents,
  dbCents,
  dbNullableDate,
  dbNullableString,
  dbRevision,
  dbString,
  resolveEffectiveDate,
} from "./helpers";

type AnyProjectCommandEnvelope = CommandEnvelope<Record<string, unknown>>;

export interface ProjectCommandExecutionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

const PROJECT_WRITE_ROLES = ["owner", "admin", "operations_pm", "project_manager", "finance"] as const;

export const PROJECT_COMMAND_POLICIES: Readonly<Record<ProjectCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "project.create": { commandKind: "project.create", allowedRoles: PROJECT_WRITE_ROLES },
  "project.update": { commandKind: "project.update", allowedRoles: PROJECT_WRITE_ROLES },
  "project.archive": { commandKind: "project.archive", allowedRoles: ["owner", "admin", "operations_pm", "project_manager"] },
  "project.scope_item.create": { commandKind: "project.scope_item.create", allowedRoles: PROJECT_WRITE_ROLES },
  "project.scope_item.update": { commandKind: "project.scope_item.update", allowedRoles: PROJECT_WRITE_ROLES },
  "project.scope_item.archive": { commandKind: "project.scope_item.archive", allowedRoles: PROJECT_WRITE_ROLES },
  "project.budget.approve": { commandKind: "project.budget.approve", allowedRoles: ["owner", "admin", "operations_pm", "project_manager", "finance"] },
  "project.task.create": { commandKind: "project.task.create", allowedRoles: ["owner", "admin", "operations_pm", "project_manager"] },
  "project.task.update": { commandKind: "project.task.update", allowedRoles: ["owner", "admin", "operations_pm", "project_manager"] },
  "project.task.archive": { commandKind: "project.task.archive", allowedRoles: ["owner", "admin", "operations_pm", "project_manager"] },
  "project.task.dependencies.set": { commandKind: "project.task.dependencies.set", allowedRoles: ["owner", "admin", "operations_pm", "project_manager"] },
  "project.draft_cost.create": { commandKind: "project.draft_cost.create", allowedRoles: PROJECT_WRITE_ROLES },
  "project.draft_cost.update": { commandKind: "project.draft_cost.update", allowedRoles: PROJECT_WRITE_ROLES },
  "project.draft_cost.archive": { commandKind: "project.draft_cost.archive", allowedRoles: PROJECT_WRITE_ROLES },
});

function savedResult(recordId: string, revision?: Revision): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [recordId],
    resultingRevisions: revision === undefined ? [] : [{ recordId: recordReferenceIdSchema.parse(recordId), revision }],
    validationOutcomes: [{ code: "project.saved_in_rops", severity: "info", message: "Project record saved in 5Central Ops" }],
  };
}

function savedRelatedResult(childId: string, childRevision: Revision, projectId: string, projectRevision: Revision): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [childId, projectId],
    resultingRevisions: [
      { recordId: recordReferenceIdSchema.parse(childId), revision: childRevision },
      { recordId: recordReferenceIdSchema.parse(projectId), revision: projectRevision },
    ],
    validationOutcomes: [{ code: "project.saved_in_rops", severity: "info", message: "Project record saved in 5Central Ops" }],
  };
}

function ensureLegalEntityScope(context: CommandHandlerContext<unknown>): string {
  const legalEntityId = context.envelope.scope.legalEntityId;
  if (legalEntityId === undefined) throw new ValidationCommandError("Project commands require a legal entity scope", { reason: "project_entity_scope_required" });
  return legalEntityId;
}

function assertSamePropertyScope(context: CommandHandlerContext<unknown>, propertyId: string): void {
  const scopePropertyId = context.envelope.scope.propertyId;
  if (scopePropertyId !== undefined && scopePropertyId !== propertyId) {
    throw new ForbiddenCommandError("Project property is outside the requested scope", { reason: "project_property_scope" });
  }
}

async function assertProjectWriteContext(
  context: CommandHandlerContext<unknown>,
  projectId: string,
  effectiveDate: ReturnType<typeof resolveEffectiveDate>,
): Promise<Awaited<ReturnType<typeof assertProjectScope>>> {
  // Tuple-fence the parent before reading it. This serializes child writes and
  // prevents two repeatable-read transactions from both passing a graph or
  // budget check against the same project revision.
  await context.executor.query(
    `UPDATE company_projects SET record_revision = record_revision WHERE organization_id = $1 AND id = $2`,
    [context.envelope.scope.organizationId, projectId],
  );
  const project = await assertProjectScope(context.executor, context.envelope.scope, projectId, effectiveDate);
  if (project.status === "archived") throw new ConflictCommandError("Archived projects cannot be edited", { reason: "project_archived" });
  await assertEntityPropertyUnit(context.executor, {
    organizationId: context.envelope.scope.organizationId, legalEntityId: project.legalEntityId,
    propertyId: project.propertyId, unitId: project.unitId, effectiveDate,
  });
  return project;
}

function ensureDateOrder(startOn: string | null | undefined, targetOn: string | null | undefined): void {
  if (startOn !== undefined && startOn !== null && targetOn !== undefined && targetOn !== null && targetOn < startOn) {
    throw new ValidationCommandError("targetOn must be on or after startOn", { reason: "project_date_order" });
  }
}

function ensureTaskDateOrder(startsOn: string | null | undefined, dueOn: string | null | undefined): void {
  if (startsOn !== undefined && startsOn !== null && dueOn !== undefined && dueOn !== null && dueOn < startsOn) {
    throw new ValidationCommandError("dueOn must be on or after startsOn", { reason: "task_date_order" });
  }
}

async function handleCreateProject(context: CommandHandlerContext<CreateProjectPayload>): Promise<CommandHandlerResult> {
  const payload = createProjectPayloadSchema.parse(context.envelope.payload);
  const legalEntityId = ensureLegalEntityScope(context as unknown as CommandHandlerContext<unknown>);
  assertSamePropertyScope(context as unknown as CommandHandlerContext<unknown>, payload.propertyId);
  const effectiveDate = resolveEffectiveDate(context.envelope.effectiveDate ?? payload.startOn);
  const mapping = await assertEntityPropertyUnit(context.executor, {
    organizationId: context.envelope.scope.organizationId,
    legalEntityId,
    propertyId: payload.propertyId,
    unitId: payload.unitId,
    effectiveDate,
  });
  if (payload.currency !== undefined && payload.currency !== mapping.currency) {
    throw new ValidationCommandError("Project currency must match the legal entity currency", { reason: "project_currency_mismatch" });
  }
  const id = projectIdSchema.parse(newRecordId());
  const result = await context.executor.query<{ record_revision: number }>(
    `INSERT INTO company_projects
       (id, organization_id, legal_entity_id, property_id, unit_id, name, description, project_type, status, start_on, target_on, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING record_revision`,
    [id, context.envelope.scope.organizationId, legalEntityId, payload.propertyId, payload.unitId ?? null, payload.name, payload.description ?? null, payload.projectType, payload.status, payload.startOn ?? null, payload.targetOn ?? null, mapping.currency],
  );
  const revision = dbRevision(result.rows[0]?.record_revision ?? 1);
  return savedResult(id, revision);
}

async function handleUpdateProject(context: CommandHandlerContext<UpdateProjectPayload>): Promise<CommandHandlerResult> {
  const payload = updateProjectPayloadSchema.parse(context.envelope.payload);
  const effectiveDate = resolveEffectiveDate(context.envelope.effectiveDate ?? payload.startOn);
  const project = await assertProjectWriteContext(context as unknown as CommandHandlerContext<unknown>, payload.projectId, effectiveDate);
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  assertSamePropertyScope(context as unknown as CommandHandlerContext<unknown>, project.propertyId);
  const nextStart = Object.prototype.hasOwnProperty.call(payload, "startOn") ? payload.startOn ?? null : project.startOn;
  const nextTarget = Object.prototype.hasOwnProperty.call(payload, "targetOn") ? payload.targetOn ?? null : project.targetOn;
  // When only one date is edited, validate against the other value already stored.
  ensureDateOrder(nextStart, nextTarget);
  await assertEntityPropertyUnit(context.executor, {
    organizationId: context.envelope.scope.organizationId,
    legalEntityId: project.legalEntityId,
    propertyId: project.propertyId,
    unitId: Object.prototype.hasOwnProperty.call(payload, "unitId") ? payload.unitId : project.unitId,
    effectiveDate,
  });
  const updates: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => { updates.push(`${column} = $${values.length + 1}`); values.push(value); };
  if (payload.name !== undefined) set("name", payload.name);
  if (payload.projectType !== undefined) set("project_type", payload.projectType);
  if (Object.prototype.hasOwnProperty.call(payload, "description")) set("description", payload.description ?? null);
  if (payload.status !== undefined) {
    if (payload.status === "archived") throw new ValidationCommandError("Use the archive project command", { reason: "project_archive_command_required" });
    set("status", payload.status);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "unitId")) set("unit_id", payload.unitId ?? null);
  if (Object.prototype.hasOwnProperty.call(payload, "startOn")) set("start_on", payload.startOn ?? null);
  if (Object.prototype.hasOwnProperty.call(payload, "targetOn")) set("target_on", payload.targetOn ?? null);
  if (updates.length === 0) throw new ValidationCommandError("At least one project field is required", { reason: "empty_project_update" });
  values.push(context.envelope.scope.organizationId, payload.projectId, project.recordRevision);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_projects
        SET ${updates.join(", ")}, record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $${values.length - 2}
        AND id = $${values.length - 1}
        AND record_revision = $${values.length}
      RETURNING record_revision`,
    values,
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Project changed while it was being edited", { reason: "revision_conflict" });
  return savedResult(payload.projectId, dbRevision(result.rows[0]!.record_revision));
}

async function handleArchiveProject(context: CommandHandlerContext<ArchiveProjectPayload>): Promise<CommandHandlerResult> {
  const payload = archiveProjectPayloadSchema.parse(context.envelope.payload);
  const project = await assertProjectWriteContext(context as unknown as CommandHandlerContext<unknown>, payload.projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_projects
        SET status = 'archived', archived_at = now(), updated_at = now(), record_revision = record_revision + 1
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 AND archived_at IS NULL
      RETURNING record_revision`,
    [context.envelope.scope.organizationId, payload.projectId, project.recordRevision],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Project changed while it was being archived", { reason: "revision_conflict" });
  return savedResult(payload.projectId, dbRevision(result.rows[0]!.record_revision));
}

async function touchProject(context: CommandHandlerContext<unknown>, projectId: string): Promise<Revision> {
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_projects SET record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING record_revision`,
    [context.envelope.scope.organizationId, projectId],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Project changed while a related record was being saved", { reason: "revision_conflict" });
  return dbRevision(result.rows[0]!.record_revision);
}

async function handleCreateScopeItem(context: CommandHandlerContext<CreateScopeItemPayload>): Promise<CommandHandlerResult> {
  const payload = createScopeItemPayloadSchema.parse(context.envelope.payload);
  const project = await assertProjectWriteContext(context as unknown as CommandHandlerContext<unknown>, payload.projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const estimate = assertEstimatedCents(payload.quantity, payload.rateCents, payload.estimatedCents);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_scope_items
       (id, organization_id, project_id, description, category, unit_label, quantity, rate_cents, estimated_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::bigint,$9::bigint)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.description, payload.category ?? null, payload.unitLabel ?? null, payload.quantity, payload.rateCents, estimate],
  );
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  return savedRelatedResult(id, dbRevision(1), payload.projectId, projectRevision);
}

async function loadScopeItemForCommand(context: CommandHandlerContext<unknown>, scopeItemId: string): Promise<{ projectId: string; projectRevision: Revision; revision: Revision; quantity: string; rateCents: ReturnType<typeof dbCents>; estimatedCents: ReturnType<typeof dbCents> }> {
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT i.project_id, i.record_revision, i.quantity::text AS quantity, i.rate_cents::text AS rate_cents, i.estimated_cents::text AS estimated_cents
       FROM company_project_scope_items i
      WHERE i.organization_id = $1 AND i.id = $2 AND i.archived_at IS NULL`,
    [context.envelope.scope.organizationId, scopeItemId],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Scope item was not found in the requested company scope", { reason: "scope_item_not_found" });
  const projectId = dbString(row.project_id, "project_id");
  const project = await assertProjectWriteContext(context, projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  return {
    projectId,
    projectRevision: project.recordRevision,
    revision: dbRevision(row.record_revision),
    quantity: dbString(row.quantity, "quantity"),
    rateCents: dbCents(row.rate_cents, "rate_cents"),
    estimatedCents: dbCents(row.estimated_cents, "estimated_cents"),
  };
}

async function handleUpdateScopeItem(context: CommandHandlerContext<UpdateScopeItemPayload>): Promise<CommandHandlerResult> {
  const payload = updateScopeItemPayloadSchema.parse(context.envelope.payload);
  const current = await loadScopeItemForCommand(context as unknown as CommandHandlerContext<unknown>, payload.scopeItemId);
  assertExpectedRevision(current.projectRevision, context.envelope.expectedRevision);
  const quantity = payload.quantity ?? projectQuantitySchema.parse(current.quantity);
  const rateCents = payload.rateCents ?? current.rateCents;
  const estimateProvided = Object.prototype.hasOwnProperty.call(payload, "estimatedCents");
  const estimate = estimateProvided
    ? (payload.estimatedCents === undefined ? current.estimatedCents : assertEstimatedCents(quantity, rateCents, payload.estimatedCents))
    : (payload.quantity !== undefined || payload.rateCents !== undefined ? calculateEstimatedCents(quantity, rateCents) : current.estimatedCents);
  const updates: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => { updates.push(`${column} = $${values.length + 1}`); values.push(value); };
  if (payload.description !== undefined) set("description", payload.description);
  if (Object.prototype.hasOwnProperty.call(payload, "category")) set("category", payload.category ?? null);
  if (Object.prototype.hasOwnProperty.call(payload, "unitLabel")) set("unit_label", payload.unitLabel ?? null);
  if (payload.quantity !== undefined) set("quantity", quantity);
  if (payload.rateCents !== undefined) set("rate_cents", rateCents);
  if (estimateProvided || payload.quantity !== undefined || payload.rateCents !== undefined) set("estimated_cents", estimate);
  if (updates.length === 0) throw new ValidationCommandError("At least one scope item field is required", { reason: "empty_scope_item_update" });
  values.push(context.envelope.scope.organizationId, payload.scopeItemId, current.revision);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_project_scope_items
        SET ${updates.join(", ")}, record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $${values.length - 2} AND id = $${values.length - 1} AND record_revision = $${values.length}
      RETURNING record_revision`, values,
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Scope item changed while it was being edited", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
  return savedRelatedResult(payload.scopeItemId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
}

async function handleArchiveScopeItem(context: CommandHandlerContext<ArchiveScopeItemPayload>): Promise<CommandHandlerResult> {
  const payload = archiveScopeItemPayloadSchema.parse(context.envelope.payload);
  const current = await loadScopeItemForCommand(context as unknown as CommandHandlerContext<unknown>, payload.scopeItemId);
  assertExpectedRevision(current.projectRevision, context.envelope.expectedRevision);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_project_scope_items SET archived_at = now(), updated_at = now(), record_revision = record_revision + 1
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 AND archived_at IS NULL
      RETURNING record_revision`, [context.envelope.scope.organizationId, payload.scopeItemId, current.revision],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Scope item changed while it was being archived", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
  return savedRelatedResult(payload.scopeItemId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
}

async function handleApproveBudget(context: CommandHandlerContext<ApproveBudgetPayload>): Promise<CommandHandlerResult> {
  const payload = approveBudgetPayloadSchema.parse(context.envelope.payload);
  const project = await assertProjectWriteContext(context as unknown as CommandHandlerContext<unknown>, payload.projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const itemResult = await context.executor.query<Record<string, unknown>>(
    `SELECT id, description, unit_label, quantity::text AS quantity, rate_cents::text AS rate_cents, estimated_cents::text AS estimated_cents
       FROM company_project_scope_items
      WHERE organization_id = $1 AND project_id = $2 AND archived_at IS NULL ORDER BY id`,
    [context.envelope.scope.organizationId, payload.projectId],
  );
  const versionResult = await context.executor.query<{ version_no: number | string }>(
    `SELECT COALESCE(MAX(version_no), 0)::text AS version_no FROM company_project_budget_versions WHERE organization_id = $1 AND project_id = $2`,
    [context.envelope.scope.organizationId, payload.projectId],
  );
  const nextVersionNo = Number(versionResult.rows[0]?.version_no ?? 0) + 1;
  if (!Number.isSafeInteger(nextVersionNo) || nextVersionNo <= 0) throw new ValidationCommandError("Budget version number exceeded supported range", { reason: "budget_version_overflow" });
  const total = sumCents(itemResult.rows.map((row) => dbCents(row.estimated_cents, "estimated_cents")));
  await context.executor.query(
    `UPDATE company_project_budget_versions SET status = 'superseded'
      WHERE organization_id = $1 AND project_id = $2 AND status = 'approved'`,
    [context.envelope.scope.organizationId, payload.projectId],
  );
  const budgetId = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_budget_versions
       (id, organization_id, project_id, version_no, status, currency, total_estimated_cents, notes, created_by, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,'draft',$5,$6::bigint,$7,$8,NULL,NULL)`,
    [budgetId, context.envelope.scope.organizationId, payload.projectId, nextVersionNo, project.currency, total, payload.notes ?? null, context.principal.actorId],
  );
  for (let index = 0; index < itemResult.rows.length; index += 1) {
    const row = itemResult.rows[index]!;
    await context.executor.query(
      `INSERT INTO company_project_budget_lines
         (id, organization_id, budget_version_id, scope_item_id, position, description, unit_label, quantity, rate_cents, estimated_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::bigint,$10::bigint)`,
      [newRecordId(), context.envelope.scope.organizationId, budgetId, row.id, index, row.description, row.unit_label ?? null, row.quantity, row.rate_cents, row.estimated_cents],
    );
  }
  await context.executor.query(
    `UPDATE company_project_budget_versions SET status = 'approved', approved_by = $3, approved_at = now()
      WHERE organization_id = $1 AND id = $2 AND status = 'draft'`,
    [context.envelope.scope.organizationId, budgetId, context.principal.actorId],
  );
  const projectUpdate = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_projects SET record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 RETURNING record_revision`,
    [context.envelope.scope.organizationId, payload.projectId, project.recordRevision],
  );
  if (projectUpdate.rows.length !== 1) throw new ConflictCommandError("Project changed while the budget was being approved", { reason: "revision_conflict" });
  return {
    state: "saved_in_rops",
    affectedRecordIds: [payload.projectId, budgetId],
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(payload.projectId), revision: dbRevision(projectUpdate.rows[0]!.record_revision) }],
    validationOutcomes: [{ code: "project.budget.approved_in_rops", severity: "info", message: "Budget snapshot approved and saved in 5Central Ops" }],
  };
}

interface TaskGraph { taskIds: Set<string>; edges: Map<string, Set<string>>; }

async function loadTaskGraph(executor: RentOpsQueryExecutor, organizationId: string, projectId: string): Promise<TaskGraph> {
  const [tasks, edges] = await Promise.all([
    executor.query<Record<string, unknown>>(`SELECT id FROM company_project_tasks WHERE organization_id = $1 AND project_id = $2 AND archived_at IS NULL`, [organizationId, projectId]),
    executor.query<Record<string, unknown>>(`SELECT task_id, depends_on_task_id FROM company_project_task_dependencies WHERE organization_id = $1 AND project_id = $2`, [organizationId, projectId]),
  ]);
  const taskIds = new Set(tasks.rows.map((row) => dbString(row.id, "task_id")));
  const graph = new Map<string, Set<string>>();
  for (const row of edges.rows) {
    const taskId = dbString(row.task_id, "task_id");
    const dependencyId = dbString(row.depends_on_task_id, "depends_on_task_id");
    if (!taskIds.has(taskId) || !taskIds.has(dependencyId)) continue;
    const set = graph.get(taskId) ?? new Set<string>();
    set.add(dependencyId);
    graph.set(taskId, set);
  }
  return { taskIds, edges: graph };
}

function assertDependenciesAcyclic(graph: TaskGraph, taskId: string, dependencyTaskIds: readonly string[]): void {
  const unique = new Set(dependencyTaskIds);
  if (unique.size !== dependencyTaskIds.length) throw new ValidationCommandError("Task dependencies must be unique", { reason: "duplicate_task_dependency" });
  if (unique.has(taskId)) throw new ValidationCommandError("A task cannot depend on itself", { reason: "task_dependency_self" });
  Array.from(unique).forEach((dependencyId) => {
    if (!graph.taskIds.has(dependencyId)) throw new ValidationCommandError("Task dependency is outside the project", { reason: "task_dependency_project_mismatch" });
  });
  const edges = new Map<string, Set<string>>();
  graph.edges.forEach((value, key) => edges.set(key, new Set(Array.from(value))));
  edges.set(taskId, new Set(unique));
  const reaches = (start: string, target: string, seen = new Set<string>()): boolean => {
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    return Array.from(edges.get(start) ?? []).some((next) => reaches(next, target, seen));
  };
  for (const dependencyId of Array.from(unique)) {
    if (reaches(dependencyId, taskId)) throw new ConflictCommandError("Task dependency would create a cycle", { reason: "task_dependency_cycle" });
  }
}

async function replaceTaskDependencies(context: CommandHandlerContext<unknown>, projectId: string, taskId: string, dependencyTaskIds: readonly string[]): Promise<void> {
  const graph = await loadTaskGraph(context.executor, context.envelope.scope.organizationId, projectId);
  graph.taskIds.add(taskId);
  assertDependenciesAcyclic(graph, taskId, dependencyTaskIds);
  await context.executor.query(`DELETE FROM company_project_task_dependencies WHERE organization_id = $1 AND project_id = $2 AND task_id = $3`, [context.envelope.scope.organizationId, projectId, taskId]);
  for (const dependencyTaskId of dependencyTaskIds) {
    await context.executor.query(
      `INSERT INTO company_project_task_dependencies (organization_id, project_id, task_id, depends_on_task_id)
       VALUES ($1,$2,$3,$4)`, [context.envelope.scope.organizationId, projectId, taskId, dependencyTaskId],
    );
  }
}

async function handleCreateTask(context: CommandHandlerContext<CreateTaskPayload>): Promise<CommandHandlerResult> {
  const payload = createTaskPayloadSchema.parse(context.envelope.payload);
  const project = await assertProjectWriteContext(context as unknown as CommandHandlerContext<unknown>, payload.projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  const status = payload.status ?? "not_started";
  const completedOn = payload.completedOn ?? (status === "completed" ? resolveEffectiveDate(context.envelope.effectiveDate) : null);
  ensureTaskDateOrder(payload.startsOn, payload.dueOn);
  const taskId = newRecordId();
  const graph = await loadTaskGraph(context.executor, context.envelope.scope.organizationId, payload.projectId);
  graph.taskIds.add(taskId);
  const dependencies = payload.dependencyTaskIds ?? [];
  assertDependenciesAcyclic(graph, taskId, dependencies);
  await context.executor.query(
    `INSERT INTO company_project_tasks
       (id, organization_id, project_id, title, description, status, starts_on, due_on, completed_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [taskId, context.envelope.scope.organizationId, payload.projectId, payload.title, payload.description ?? null, status, payload.startsOn ?? null, payload.dueOn ?? null, completedOn],
  );
  for (const dependencyTaskId of dependencies) {
    await context.executor.query(
      `INSERT INTO company_project_task_dependencies (organization_id, project_id, task_id, depends_on_task_id) VALUES ($1,$2,$3,$4)`,
      [context.envelope.scope.organizationId, payload.projectId, taskId, dependencyTaskId],
    );
  }
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  return savedRelatedResult(taskId, dbRevision(1), payload.projectId, projectRevision);
}

async function loadTaskForCommand(context: CommandHandlerContext<unknown>, taskId: string): Promise<{ projectId: string; projectRevision: Revision; revision: Revision; title: string; description: string | null; status: string; startsOn: string | null; dueOn: string | null; completedOn: string | null }> {
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT project_id, record_revision, title, description, status, starts_on, due_on, completed_on
       FROM company_project_tasks WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
    [context.envelope.scope.organizationId, taskId],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Task was not found in the requested company scope", { reason: "task_not_found" });
  const projectId = dbString(row.project_id, "project_id");
  const project = await assertProjectWriteContext(context, projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  return {
    projectId,
    projectRevision: project.recordRevision,
    revision: dbRevision(row.record_revision),
    title: dbString(row.title, "title"),
    description: dbNullableString(row.description, "description"),
    status: dbString(row.status, "status"),
    startsOn: dbNullableDate(row.starts_on, "starts_on"),
    dueOn: dbNullableDate(row.due_on, "due_on"),
    completedOn: dbNullableDate(row.completed_on, "completed_on"),
  };
}

async function handleUpdateTask(context: CommandHandlerContext<UpdateTaskPayload>): Promise<CommandHandlerResult> {
  const payload = updateTaskPayloadSchema.parse(context.envelope.payload);
  const current = await loadTaskForCommand(context as unknown as CommandHandlerContext<unknown>, payload.taskId);
  assertExpectedRevision(current.projectRevision, context.envelope.expectedRevision);
  const startsOn = Object.prototype.hasOwnProperty.call(payload, "startsOn") ? payload.startsOn ?? null : current.startsOn;
  const dueOn = Object.prototype.hasOwnProperty.call(payload, "dueOn") ? payload.dueOn ?? null : current.dueOn;
  ensureTaskDateOrder(startsOn, dueOn);
  const status = payload.status ?? current.status;
  const completedOn = Object.prototype.hasOwnProperty.call(payload, "completedOn")
    ? payload.completedOn ?? null
    : (payload.status !== undefined ? (status === "completed" ? resolveEffectiveDate(context.envelope.effectiveDate) : null) : current.completedOn);
  if (status === "completed" && completedOn === null) throw new ValidationCommandError("Completed tasks require completedOn", { reason: "task_completed_date_required" });
  const updates: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => { updates.push(`${column} = $${values.length + 1}`); values.push(value); };
  if (payload.title !== undefined) set("title", payload.title);
  if (Object.prototype.hasOwnProperty.call(payload, "description")) set("description", payload.description ?? null);
  if (payload.status !== undefined) set("status", status);
  if (Object.prototype.hasOwnProperty.call(payload, "startsOn")) set("starts_on", startsOn);
  if (Object.prototype.hasOwnProperty.call(payload, "dueOn")) set("due_on", dueOn);
  if (Object.prototype.hasOwnProperty.call(payload, "completedOn") || payload.status !== undefined) set("completed_on", completedOn);
  const dependenciesProvided = payload.dependencyTaskIds !== undefined;
  if (updates.length === 0 && !dependenciesProvided) throw new ValidationCommandError("At least one task field is required", { reason: "empty_task_update" });
  if (updates.length > 0) {
    values.push(context.envelope.scope.organizationId, payload.taskId, current.revision);
    const result = await context.executor.query<{ record_revision: number }>(
      `UPDATE company_project_tasks SET ${updates.join(", ")}, record_revision = record_revision + 1, updated_at = now()
        WHERE organization_id = $${values.length - 2} AND id = $${values.length - 1} AND record_revision = $${values.length}
        RETURNING record_revision`, values,
    );
    if (result.rows.length !== 1) throw new ConflictCommandError("Task changed while it was being edited", { reason: "revision_conflict" });
    if (dependenciesProvided) await replaceTaskDependencies(context as unknown as CommandHandlerContext<unknown>, current.projectId, payload.taskId, payload.dependencyTaskIds!);
    const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
    return savedRelatedResult(payload.taskId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
  }
  await replaceTaskDependencies(context as unknown as CommandHandlerContext<unknown>, current.projectId, payload.taskId, payload.dependencyTaskIds!);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_project_tasks SET record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 RETURNING record_revision`,
    [context.envelope.scope.organizationId, payload.taskId, current.revision],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Task changed while dependencies were being edited", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
  return savedRelatedResult(payload.taskId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
}

async function handleArchiveTask(context: CommandHandlerContext<ArchiveTaskPayload>): Promise<CommandHandlerResult> {
  const payload = archiveTaskPayloadSchema.parse(context.envelope.payload);
  const current = await loadTaskForCommand(context as unknown as CommandHandlerContext<unknown>, payload.taskId);
  assertExpectedRevision(current.projectRevision, context.envelope.expectedRevision);
  const dependents = await context.executor.query<{ task_id: unknown }>(
    `SELECT d.task_id
       FROM company_project_task_dependencies d
       JOIN company_project_tasks dependent
         ON dependent.organization_id = d.organization_id
        AND dependent.project_id = d.project_id
        AND dependent.id = d.task_id
      WHERE d.organization_id = $1
        AND d.project_id = $2
        AND d.depends_on_task_id = $3
        AND dependent.archived_at IS NULL
      ORDER BY d.task_id
      LIMIT 1`,
    [context.envelope.scope.organizationId, current.projectId, payload.taskId],
  );
  if (dependents.rows.length > 0) {
    throw new ConflictCommandError("Task cannot be archived while an active task depends on it; remove that dependency first", {
      reason: "task_has_active_dependents",
      dependentTaskId: dbString(dependents.rows[0]!.task_id, "dependent_task_id"),
    });
  }
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_project_tasks SET archived_at = now(), updated_at = now(), record_revision = record_revision + 1
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 AND archived_at IS NULL RETURNING record_revision`,
    [context.envelope.scope.organizationId, payload.taskId, current.revision],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Task changed while it was being archived", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
  return savedRelatedResult(payload.taskId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
}

async function handleSetTaskDependencies(context: CommandHandlerContext<SetTaskDependenciesPayload>): Promise<CommandHandlerResult> {
  const payload = setTaskDependenciesPayloadSchema.parse(context.envelope.payload);
  const current = await loadTaskForCommand(context as unknown as CommandHandlerContext<unknown>, payload.taskId);
  assertExpectedRevision(current.projectRevision, context.envelope.expectedRevision);
  await replaceTaskDependencies(context as unknown as CommandHandlerContext<unknown>, current.projectId, payload.taskId, payload.dependencyTaskIds);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_project_tasks SET record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 RETURNING record_revision`,
    [context.envelope.scope.organizationId, payload.taskId, current.revision],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Task changed while dependencies were being edited", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
  return savedRelatedResult(payload.taskId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
}

async function assertDraftCostScopeItem(context: CommandHandlerContext<unknown>, projectId: string, scopeItemId: string | null | undefined): Promise<void> {
  if (scopeItemId !== undefined && scopeItemId !== null) await assertScopeItemForProject(context.executor, { organizationId: context.envelope.scope.organizationId, projectId, scopeItemId });
}

async function handleCreateDraftCost(context: CommandHandlerContext<CreateDraftCostPayload>): Promise<CommandHandlerResult> {
  const payload = createDraftCostPayloadSchema.parse(context.envelope.payload);
  const project = await assertProjectWriteContext(context as unknown as CommandHandlerContext<unknown>, payload.projectId, resolveEffectiveDate(context.envelope.effectiveDate ?? payload.incurredOn));
  assertExpectedRevision(project.recordRevision, context.envelope.expectedRevision);
  await assertDraftCostScopeItem(context as unknown as CommandHandlerContext<unknown>, payload.projectId, payload.scopeItemId);
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_project_draft_costs
       (id, organization_id, project_id, scope_item_id, vendor_name, description, amount_cents, currency, incurred_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9)`,
    [id, context.envelope.scope.organizationId, payload.projectId, payload.scopeItemId ?? null, payload.vendorName ?? null, payload.description, payload.amountCents, project.currency, payload.incurredOn],
  );
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, payload.projectId);
  return savedRelatedResult(id, dbRevision(1), payload.projectId, projectRevision);
}

async function loadDraftCostForCommand(context: CommandHandlerContext<unknown>, draftCostId: string): Promise<{ projectId: string; projectRevision: Revision; revision: Revision }> {
  const result = await context.executor.query<Record<string, unknown>>(`SELECT project_id, record_revision FROM company_project_draft_costs WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL AND vendor_name IS DISTINCT FROM 'system:etc_override'`, [context.envelope.scope.organizationId, draftCostId]);
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Draft cost was not found in the requested company scope", { reason: "draft_cost_not_found" });
  const projectId = dbString(row.project_id, "project_id");
  const project = await assertProjectWriteContext(context, projectId, resolveEffectiveDate(context.envelope.effectiveDate));
  return { projectId, projectRevision: project.recordRevision, revision: dbRevision(row.record_revision) };
}

async function handleUpdateDraftCost(context: CommandHandlerContext<UpdateDraftCostPayload>): Promise<CommandHandlerResult> {
  const payload = updateDraftCostPayloadSchema.parse(context.envelope.payload);
  const current = await loadDraftCostForCommand(context as unknown as CommandHandlerContext<unknown>, payload.draftCostId);
  assertExpectedRevision(current.projectRevision, context.envelope.expectedRevision);
  await assertDraftCostScopeItem(context as unknown as CommandHandlerContext<unknown>, current.projectId, payload.scopeItemId);
  const project = await assertProjectWriteContext(context as unknown as CommandHandlerContext<unknown>, current.projectId, resolveEffectiveDate(context.envelope.effectiveDate ?? payload.incurredOn));
  const updates: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => { updates.push(`${column} = $${values.length + 1}`); values.push(value); };
  if (Object.prototype.hasOwnProperty.call(payload, "scopeItemId")) set("scope_item_id", payload.scopeItemId ?? null);
  if (Object.prototype.hasOwnProperty.call(payload, "vendorName")) set("vendor_name", payload.vendorName ?? null);
  if (payload.description !== undefined) set("description", payload.description);
  if (payload.amountCents !== undefined) set("amount_cents", payload.amountCents);
  if (payload.incurredOn !== undefined) set("incurred_on", payload.incurredOn);
  if (updates.length === 0) throw new ValidationCommandError("At least one draft cost field is required", { reason: "empty_draft_cost_update" });
  values.push(context.envelope.scope.organizationId, payload.draftCostId, current.revision);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_project_draft_costs SET ${updates.join(", ")}, record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $${values.length - 2} AND id = $${values.length - 1} AND record_revision = $${values.length} RETURNING record_revision`, values,
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Draft cost changed while it was being edited", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
  return savedRelatedResult(payload.draftCostId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
}

async function handleArchiveDraftCost(context: CommandHandlerContext<ArchiveDraftCostPayload>): Promise<CommandHandlerResult> {
  const payload = archiveDraftCostPayloadSchema.parse(context.envelope.payload);
  const current = await loadDraftCostForCommand(context as unknown as CommandHandlerContext<unknown>, payload.draftCostId);
  assertExpectedRevision(current.projectRevision, context.envelope.expectedRevision);
  const result = await context.executor.query<{ record_revision: number }>(
    `UPDATE company_project_draft_costs SET archived_at = now(), updated_at = now(), record_revision = record_revision + 1
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 AND archived_at IS NULL RETURNING record_revision`,
    [context.envelope.scope.organizationId, payload.draftCostId, current.revision],
  );
  if (result.rows.length !== 1) throw new ConflictCommandError("Draft cost changed while it was being archived", { reason: "revision_conflict" });
  const projectRevision = await touchProject(context as unknown as CommandHandlerContext<unknown>, current.projectId);
  return savedRelatedResult(payload.draftCostId, dbRevision(result.rows[0]!.record_revision), current.projectId, projectRevision);
}

const handlers = {
  "project.create": handleCreateProject,
  "project.update": handleUpdateProject,
  "project.archive": handleArchiveProject,
  "project.scope_item.create": handleCreateScopeItem,
  "project.scope_item.update": handleUpdateScopeItem,
  "project.scope_item.archive": handleArchiveScopeItem,
  "project.budget.approve": handleApproveBudget,
  "project.task.create": handleCreateTask,
  "project.task.update": handleUpdateTask,
  "project.task.archive": handleArchiveTask,
  "project.task.dependencies.set": handleSetTaskDependencies,
  "project.draft_cost.create": handleCreateDraftCost,
  "project.draft_cost.update": handleUpdateDraftCost,
  "project.draft_cost.archive": handleArchiveDraftCost,
} as const;

export async function executeProjectCommand(
  executor: RentOpsQueryExecutor,
  kind: ProjectCommandKind,
  rawEnvelope: unknown,
  options: ProjectCommandExecutionOptions,
): Promise<OperationReceipt> {
  const payloadSchema = projectCommandPayloadSchemas[kind];
  let envelope: AnyProjectCommandEnvelope;
  try {
    envelope = commandEnvelopeSchema(payloadSchema).parse(rawEnvelope) as unknown as AnyProjectCommandEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw new ValidationCommandError("Project command payload failed validation", { reason: "invalid_project_command_payload" });
    throw error;
  }
  const handler = handlers[kind] as (context: CommandHandlerContext<any>) => Promise<CommandHandlerResult>;
  return runCompanyCommand(executor, {
    envelope,
    principal: options.principal,
    resolvePrincipal: options.resolvePrincipal,
    transport: options.transport,
    policy: PROJECT_COMMAND_POLICIES[kind],
    handler,
  });
}

export const runProjectCommand = executeProjectCommand;
