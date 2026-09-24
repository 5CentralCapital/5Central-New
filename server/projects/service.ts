import {
  projectBudgetVersionSchema,
  projectBudgetLineSchema,
  projectDetailSchema,
  projectDraftCostSchema,
  projectListQuerySchema,
  projectListResponseSchema,
  projectPostedActualSchema,
  projectQboIdentitySchema,
  projectScopeItemSchema,
  projectSummarySchema,
  projectTaskSchema,
  type ProjectDetail,
  type ProjectId,
  type ProjectListQuery,
  type ProjectListResponse,
  type ProjectBudgetLine,
} from "../../shared/projects";
import {
  centsFromBigInt,
  companyScopeSchema,
  type CompanyScope,
} from "../../shared/company";
import { authorizeCompanyRead, type AuthenticatedPrincipal } from "../company/authorization";
import { ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import {
  dbCents,
  dbCount,
  dbDate,
  dbNullableCents,
  dbNullableDate,
  dbNullableString,
  dbNullableTimestamp,
  dbRevision,
  dbString,
  dbTimestamp,
  decodeProjectCursor,
  encodeProjectCursor,
  resolveEffectiveDate,
} from "./helpers";
import { legalEntityIdSchema } from "../../shared/company";
import {
  budgetLineIdSchema,
  budgetVersionIdSchema,
  draftCostIdSchema,
  postedActualIdSchema,
  projectIdSchema,
  projectTaskIdSchema,
  scopeItemIdSchema,
} from "../../shared/projects/contracts";
import { z } from "zod";
import { executeProjectCommand, type ProjectCommandExecutionOptions } from "./commands";
import type { OperationReceipt } from "../../shared/company";
import type { ProjectCommandKind } from "../../shared/projects";
import {
  projectFinanceCoverageSchema,
  type ProjectFinanceActual,
  type ProjectFinanceReadPort,
} from "../../shared/projects";

interface ProjectSummaryRow extends Record<string, unknown> {}

function assertReadScope(principal: AuthenticatedPrincipal, scope: CompanyScope): void {
  const parsedScope = companyScopeSchema.parse(scope);
  authorizeCompanyRead(principal, parsedScope, ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"]);
}

function mapProjectSummary(row: ProjectSummaryRow): ReturnType<typeof projectSummarySchema.parse> {
  return projectSummarySchema.parse({
    id: projectIdSchema.parse(dbString(row.id, "id")),
    organizationId: dbString(row.organization_id, "organization_id"),
    legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"),
    propertyId: dbString(row.property_id, "property_id"),
    unitId: dbNullableString(row.unit_id, "unit_id"),
    name: dbString(row.name, "name"),
    projectType: dbString(row.project_type, "project_type"),
    description: dbNullableString(row.description, "description"),
    status: dbString(row.status, "status"),
    currency: dbString(row.currency, "currency"),
    startOn: dbNullableDate(row.start_on, "start_on"),
    targetOn: dbNullableDate(row.target_on, "target_on"),
    recordRevision: dbRevision(row.record_revision),
    updatedAt: dbTimestamp(row.updated_at, "updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "archived_at"),
    scopeItemCount: dbCount(row.scope_item_count, "scope_item_count"),
    taskCount: dbCount(row.task_count, "task_count"),
    approvedBudgetCents: dbNullableCents(row.approved_budget_cents, "approved_budget_cents"),
    draftCostCents: dbCents(row.draft_cost_cents, "draft_cost_cents"),
    postedActualCents: dbNullableCents(row.posted_actual_cents, "posted_actual_cents"),
    postedActualCoverage: "unavailable",
  });
}

function mapScopeItem(row: Record<string, unknown>): ReturnType<typeof projectScopeItemSchema.parse> {
  return projectScopeItemSchema.parse({
    id: scopeItemIdSchema.parse(dbString(row.id, "scope_item_id")),
    projectId: projectIdSchema.parse(dbString(row.project_id, "project_id")),
    description: dbString(row.description, "description"),
    category: dbNullableString(row.category, "category"),
    unitLabel: dbNullableString(row.unit_label, "unit_label"),
    quantity: dbString(row.quantity, "quantity"),
    rateCents: dbCents(row.rate_cents, "rate_cents"),
    estimatedCents: dbCents(row.estimated_cents, "estimated_cents"),
    recordRevision: dbRevision(row.record_revision),
    updatedAt: dbTimestamp(row.updated_at, "updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "archived_at"),
  });
}

function mapBudgetVersion(row: Record<string, unknown>, lines: readonly ProjectBudgetLine[]): ReturnType<typeof projectBudgetVersionSchema.parse> {
  return projectBudgetVersionSchema.parse({
    id: budgetVersionIdSchema.parse(dbString(row.id, "budget_version_id")),
    projectId: projectIdSchema.parse(dbString(row.project_id, "project_id")),
    versionNo: dbCount(row.version_no, "version_no"),
    status: dbString(row.status, "status"),
    currency: dbString(row.currency, "currency"),
    totalEstimatedCents: dbCents(row.total_estimated_cents, "total_estimated_cents"),
    notes: dbNullableString(row.notes, "notes"),
    createdBy: dbString(row.created_by, "created_by"),
    approvedBy: dbNullableString(row.approved_by, "approved_by"),
    createdAt: dbTimestamp(row.created_at, "created_at"),
    approvedAt: dbNullableTimestamp(row.approved_at, "approved_at"),
    lines,
  });
}

function mapTask(row: Record<string, unknown>, dependencyTaskIds: readonly string[]): ReturnType<typeof projectTaskSchema.parse> {
  return projectTaskSchema.parse({
    id: projectTaskIdSchema.parse(dbString(row.id, "task_id")),
    projectId: projectIdSchema.parse(dbString(row.project_id, "project_id")),
    title: dbString(row.title, "title"),
    description: dbNullableString(row.description, "description"),
    status: dbString(row.status, "status"),
    startsOn: dbNullableDate(row.starts_on, "starts_on"),
    dueOn: dbNullableDate(row.due_on, "due_on"),
    completedOn: dbNullableDate(row.completed_on, "completed_on"),
    dependencyTaskIds: dependencyTaskIds.map((value) => projectTaskIdSchema.parse(value)),
    recordRevision: dbRevision(row.record_revision),
    updatedAt: dbTimestamp(row.updated_at, "updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "archived_at"),
  });
}

function mapDraftCost(row: Record<string, unknown>): ReturnType<typeof projectDraftCostSchema.parse> {
  return projectDraftCostSchema.parse({
    id: draftCostIdSchema.parse(dbString(row.id, "draft_cost_id")),
    projectId: projectIdSchema.parse(dbString(row.project_id, "project_id")),
    scopeItemId: row.scope_item_id === null || row.scope_item_id === undefined ? null : scopeItemIdSchema.parse(dbString(row.scope_item_id, "scope_item_id")),
    vendorName: dbNullableString(row.vendor_name, "vendor_name"),
    description: dbString(row.description, "description"),
    amountCents: dbCents(row.amount_cents, "amount_cents"),
    currency: dbString(row.currency, "currency"),
    incurredOn: dbDate(row.incurred_on, "incurred_on"),
    recordRevision: dbRevision(row.record_revision),
    updatedAt: dbTimestamp(row.updated_at, "updated_at"),
    archivedAt: dbNullableTimestamp(row.archived_at, "archived_at"),
  });
}

function mapPostedActual(row: Record<string, unknown>): ReturnType<typeof projectPostedActualSchema.parse> {
  return projectPostedActualSchema.parse({
    id: postedActualIdSchema.parse(dbString(row.id, "posted_actual_id")),
    projectId: projectIdSchema.parse(dbString(row.project_id, "project_id")),
    scopeItemId: row.scope_item_id === null || row.scope_item_id === undefined ? null : scopeItemIdSchema.parse(dbString(row.scope_item_id, "scope_item_id")),
    provider: dbString(row.provider, "provider"),
    sourceScope: dbString(row.source_scope, "source_scope"),
    externalId: dbString(row.external_id, "external_id"),
    description: dbString(row.description, "description"),
    amountCents: dbCents(row.amount_cents, "amount_cents"),
    currency: dbString(row.currency, "currency"),
    postedOn: dbDate(row.posted_on, "posted_on"),
    createdAt: dbTimestamp(row.created_at, "created_at"),
  });
}

function mapProjectQboIdentity(row: Record<string, unknown>): ReturnType<typeof projectQboIdentitySchema.parse> {
  const sourceScope = dbString(row.source_scope, "qbo_source_scope");
  const match = /^qbo:(sandbox|production):(\d{1,32})$/.exec(sourceScope);
  if (!match) throw new ValidationCommandError("Project storage returned an invalid QuickBooks identity scope", { reason: "invalid_project_qbo_identity" });
  return projectQboIdentitySchema.parse({
    id: dbString(row.id, "qbo_identity_id"),
    projectId: projectIdSchema.parse(dbString(row.project_id, "qbo_identity_project_id")),
    recordKind: dbString(row.record_kind, "qbo_identity_record_kind"),
    externalId: dbString(row.external_id, "qbo_identity_external_id"),
    environment: match[1],
    realmId: match[2],
    linkedAt: dbTimestamp(row.created_at, "qbo_identity_created_at"),
  });
}

function mapFinanceActual(actual: ProjectFinanceActual): ReturnType<typeof projectPostedActualSchema.parse> {
  const sourceScope = JSON.stringify({ environment: actual.source.environment, legalEntityId: actual.source.legalEntityId, realmId: actual.source.realmId });
  const externalId = [actual.source.objectType, actual.source.objectId, actual.source.lineId ?? "*", actual.source.version].join(":");
  return projectPostedActualSchema.parse({
    id: postedActualIdSchema.parse(actual.id),
    projectId: projectIdSchema.parse(actual.projectId),
    scopeItemId: actual.scopeItemId === null ? null : scopeItemIdSchema.parse(actual.scopeItemId),
    provider: "qbo",
    sourceScope,
    externalId,
    description: actual.description,
    amountCents: actual.amountCents,
    currency: actual.currency,
    postedOn: actual.postedOn,
    createdAt: new Date(`${actual.postedOn}T00:00:00.000Z`).toISOString(),
  });
}

function sumActuals(actuals: readonly ProjectFinanceActual[]): ReturnType<typeof centsFromBigInt> {
  return centsFromBigInt(actuals.reduce((total, actual) => total + BigInt(actual.amountCents), BigInt(0)));
}

const summarySelect = `
  SELECT p.id, p.organization_id, p.legal_entity_id, p.property_id, p.unit_id,
         p.name, p.description, p.project_type, p.status, p.currency, p.start_on, p.target_on,
         p.record_revision, p.updated_at, p.archived_at,
         COALESCE(si.scope_item_count, 0)::text AS scope_item_count,
         COALESCE(pt.task_count, 0)::text AS task_count,
         ab.total_estimated_cents::text AS approved_budget_cents,
         COALESCE(dc.draft_cost_cents, 0)::text AS draft_cost_cents,
         pa.posted_actual_cents::text AS posted_actual_cents
    FROM company_projects p
    LEFT JOIN LATERAL (
      SELECT count(*) AS scope_item_count
        FROM company_project_scope_items i
       WHERE i.organization_id = p.organization_id
         AND i.project_id = p.id
         AND i.archived_at IS NULL
    ) si ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS task_count
        FROM company_project_tasks t
       WHERE t.organization_id = p.organization_id
         AND t.project_id = p.id
         AND t.archived_at IS NULL
    ) pt ON true
    LEFT JOIN LATERAL (
      SELECT b.total_estimated_cents
        FROM company_project_budget_versions b
       WHERE b.organization_id = p.organization_id
         AND b.project_id = p.id
         AND b.status = 'approved'
       ORDER BY b.version_no DESC
       LIMIT 1
    ) ab ON true
    LEFT JOIN LATERAL (
      SELECT SUM(c.amount_cents) AS draft_cost_cents
        FROM company_project_draft_costs c
       WHERE c.organization_id = p.organization_id
         AND c.project_id = p.id
         AND c.archived_at IS NULL
    ) dc ON true
    LEFT JOIN LATERAL (
      SELECT SUM(a.amount_cents) AS posted_actual_cents
        FROM company_project_posted_actuals a
       WHERE a.organization_id = p.organization_id
         AND a.project_id = p.id
    ) pa ON true`;

function scopeWhere(scope: CompanyScope, asOf?: string, projectId?: string): { sql: string; values: unknown[] } {
  // A project's entity and property are immutable ownership fields. Keep them
  // readable after a later transfer closes the property/entity mapping. An
  // explicit historical read still opts into effective-date validation.
  const values: unknown[] = [scope.organizationId, scope.legalEntityId ?? null, scope.propertyId ?? null, asOf ?? null];
  const predicates = [
    `p.organization_id = $1`,
    `($2::uuid IS NULL OR p.legal_entity_id = $2)`,
    `($3::varchar IS NULL OR p.property_id = $3)`,
    `($4::date IS NULL OR EXISTS (
       SELECT 1 FROM company_property_entity_periods pep
        WHERE pep.organization_id = p.organization_id
          AND pep.legal_entity_id = p.legal_entity_id
          AND pep.property_id = p.property_id
          AND pep.effective_from <= $4::date
          AND (pep.effective_until IS NULL OR pep.effective_until > $4::date)
    ))`,
  ];
  if (projectId !== undefined) {
    values.push(projectId);
    predicates.push(`p.id = $${values.length}`);
  }
  return { sql: predicates.join(" AND "), values };
}

export interface ProjectReadServiceOptions {
  readonly executor: RentOpsQueryExecutor;
  /** Optional verified central finance source. When omitted, legacy manual actual reads remain available. */
  readonly finance?: ProjectFinanceReadPort;
}

export class ProjectReadService {
  private readonly finance: ProjectFinanceReadPort | null;

  constructor(protected readonly executor: RentOpsQueryExecutor, finance: ProjectFinanceReadPort | null = null) {
    this.finance = finance;
  }

  async list(principal: AuthenticatedPrincipal, input: ProjectListQuery): Promise<ProjectListResponse> {
    const query = projectListQuerySchema.parse(input);
    assertReadScope(principal, query.scope);
    const asOf = query.asOf === undefined ? undefined : resolveEffectiveDate(query.asOf);
    const cursor = decodeProjectCursor(query.cursor);
    const where = scopeWhere(query.scope, asOf);
    const values = [...where.values, query.status ?? null, query.search ?? null, cursor?.updatedAt ?? null, cursor?.id ?? null, query.limit + 1];
    const result = await this.executor.query<ProjectSummaryRow>(
      `${summarySelect}
       WHERE ${where.sql}
         AND ($5::text IS NULL OR p.status = $5)
         AND (($5::text = 'archived' AND p.archived_at IS NOT NULL) OR ($5::text IS DISTINCT FROM 'archived' AND p.archived_at IS NULL))
         AND ($6::text IS NULL OR p.name ILIKE '%' || $6 || '%')
         AND ($7::timestamptz IS NULL OR p.updated_at < $7 OR (p.updated_at = $7 AND p.id < $8::uuid))
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT $9`,
      values,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    let items = rows.map(mapProjectSummary);
    if (this.finance !== null) {
      items = await Promise.all(rows.map(async (row, index) => {
        const projectId = projectIdSchema.parse(dbString(row.id, "id"));
        const result = await this.finance!.getProjectActuals({
          organizationId: dbString(row.organization_id, "organization_id"),
          legalEntityId: legalEntityIdSchema.parse(dbString(row.legal_entity_id, "legal_entity_id")),
          projectId,
          asOf,
        });
        const coverage = projectFinanceCoverageSchema.parse(result.coverage);
        return projectSummarySchema.parse({
          ...items[index],
          postedActualCents: coverage === "unavailable" ? null : sumActuals(result.actuals),
          postedActualCoverage: coverage,
        });
      }));
    }
    const nextCursor = hasMore && items.at(-1) ? encodeProjectCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null;
    return projectListResponseSchema.parse({ items, nextCursor });
  }

  async get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; projectId: ProjectId | string; asOf?: string }): Promise<ProjectDetail> {
    const scope = companyScopeSchema.parse(input.scope);
    assertReadScope(principal, scope);
    const projectId = projectIdSchema.parse(input.projectId);
    const asOf = input.asOf === undefined ? undefined : resolveEffectiveDate(input.asOf);
    const where = scopeWhere(scope, asOf, projectId);
    const summaryResult = await this.executor.query<ProjectSummaryRow>(`${summarySelect} WHERE ${where.sql}`, where.values);
    const summaryRow = summaryResult.rows[0];
    if (!summaryRow) throw new ValidationCommandError("Project was not found in the requested company scope", { reason: "project_not_found" });
    let summary = mapProjectSummary(summaryRow);
    const projectValues = [scope.organizationId, projectId];

    const [scopeItemsResult, budgetVersionsResult, budgetLinesResult, tasksResult, dependenciesResult, draftCostsResult, postedActualsResult, qboIdentitiesResult] = await Promise.all([
      this.executor.query<Record<string, unknown>>(
        `SELECT i.id, i.project_id, i.description, i.category, i.unit_label, i.quantity::text AS quantity,
                i.rate_cents::text AS rate_cents, i.estimated_cents::text AS estimated_cents,
                i.record_revision, i.updated_at, i.archived_at
           FROM company_project_scope_items i
           JOIN company_projects p ON p.organization_id = i.organization_id AND p.id = i.project_id
          WHERE i.organization_id = $1 AND i.project_id = $2 AND i.archived_at IS NULL
          ORDER BY i.updated_at DESC, i.id DESC`, projectValues),
      this.executor.query<Record<string, unknown>>(
        `SELECT b.id, b.project_id, b.version_no, b.status, b.currency, b.total_estimated_cents::text AS total_estimated_cents,
                b.notes, b.created_by, b.approved_by, b.created_at, b.approved_at
           FROM company_project_budget_versions b
           JOIN company_projects p ON p.organization_id = b.organization_id AND p.id = b.project_id
          WHERE b.organization_id = $1 AND b.project_id = $2
          ORDER BY b.version_no DESC`, projectValues),
      this.executor.query<Record<string, unknown>>(
        `SELECT l.id, l.budget_version_id, l.scope_item_id, l.position, l.description, l.unit_label,
                l.quantity::text AS quantity, l.rate_cents::text AS rate_cents, l.estimated_cents::text AS estimated_cents
           FROM company_project_budget_lines l
           JOIN company_project_budget_versions b
             ON b.organization_id = l.organization_id AND b.id = l.budget_version_id
          WHERE l.organization_id = $1 AND b.project_id = $2
          ORDER BY l.budget_version_id, l.position`, projectValues),
      this.executor.query<Record<string, unknown>>(
        `SELECT t.id, t.project_id, t.title, t.description, t.status, t.starts_on, t.due_on, t.completed_on,
                t.record_revision, t.updated_at, t.archived_at
           FROM company_project_tasks t
           JOIN company_projects p ON p.organization_id = t.organization_id AND p.id = t.project_id
          WHERE t.organization_id = $1 AND t.project_id = $2 AND t.archived_at IS NULL
          ORDER BY t.starts_on NULLS LAST, t.due_on NULLS LAST, t.id`, projectValues),
      this.executor.query<Record<string, unknown>>(
        `SELECT d.task_id, d.depends_on_task_id
           FROM company_project_task_dependencies d
           JOIN company_projects p ON p.organization_id = d.organization_id AND p.id = d.project_id
          WHERE d.organization_id = $1 AND d.project_id = $2
          ORDER BY d.task_id, d.depends_on_task_id`, projectValues),
      this.executor.query<Record<string, unknown>>(
        `SELECT c.id, c.project_id, c.scope_item_id, c.vendor_name, c.description, c.amount_cents::text AS amount_cents,
                c.currency, c.incurred_on, c.record_revision, c.updated_at, c.archived_at
           FROM company_project_draft_costs c
           JOIN company_projects p ON p.organization_id = c.organization_id AND p.id = c.project_id
          WHERE c.organization_id = $1 AND c.project_id = $2 AND c.archived_at IS NULL
          ORDER BY c.incurred_on DESC, c.id DESC`, projectValues),
      this.executor.query<Record<string, unknown>>(
        `SELECT a.id, a.project_id, a.scope_item_id, a.provider, a.source_scope, a.external_id, a.description,
                a.amount_cents::text AS amount_cents, a.currency, a.posted_on, a.created_at
           FROM company_project_posted_actuals a
           JOIN company_projects p ON p.organization_id = a.organization_id AND p.id = a.project_id
          WHERE a.organization_id = $1 AND a.project_id = $2
          ORDER BY a.posted_on DESC, a.id DESC`, projectValues),
      this.executor.query<Record<string, unknown>>(
        `SELECT i.id, i.local_id AS project_id, i.record_kind, i.source_scope, i.external_id, i.created_at
           FROM company_external_identities i
           JOIN company_projects p
             ON p.organization_id = i.organization_id
            AND p.id::text = i.local_id
            AND p.legal_entity_id = i.legal_entity_id
          WHERE i.organization_id = $1
            AND i.provider = 'qbo'
            AND i.local_kind = 'project'
            AND i.local_id = $2
            AND i.record_kind IN ('Project', 'Customer')
          ORDER BY i.record_kind, i.created_at DESC, i.id DESC`, projectValues),
    ]);

    const scopeItems = scopeItemsResult.rows.map(mapScopeItem);
    const lineRowsByVersion = new Map<string, ProjectBudgetLine[]>();
    for (const row of budgetLinesResult.rows) {
      const versionId = budgetVersionIdSchema.parse(dbString(row.budget_version_id, "budget_version_id"));
      const line = {
        id: budgetLineIdSchema.parse(dbString(row.id, "budget_line_id")),
        budgetVersionId: versionId,
        scopeItemId: row.scope_item_id === null || row.scope_item_id === undefined ? null : scopeItemIdSchema.parse(dbString(row.scope_item_id, "scope_item_id")),
        position: dbCount(row.position, "position"),
        description: dbString(row.description, "description"),
        unitLabel: dbNullableString(row.unit_label, "unit_label"),
        quantity: dbString(row.quantity, "quantity"),
        rateCents: dbCents(row.rate_cents, "rate_cents"),
        estimatedCents: dbCents(row.estimated_cents, "estimated_cents"),
      };
      const parsed = projectBudgetLineSchema.parse(line);
      const lines = lineRowsByVersion.get(versionId) ?? [];
      lines.push(parsed);
      lineRowsByVersion.set(versionId, lines);
    }
    const budgetVersions = budgetVersionsResult.rows.map((row) => {
      const versionId = dbString(row.id, "budget_version_id");
      return mapBudgetVersion(row, lineRowsByVersion.get(versionId) ?? []);
    });
    const dependencies = new Map<string, string[]>();
    for (const row of dependenciesResult.rows) {
      const taskId = dbString(row.task_id, "task_id");
      const list = dependencies.get(taskId) ?? [];
      list.push(dbString(row.depends_on_task_id, "depends_on_task_id"));
      dependencies.set(taskId, list);
    }
    const tasks = tasksResult.rows.map((row) => mapTask(row, dependencies.get(dbString(row.id, "task_id")) ?? []));
    const draftCosts = draftCostsResult.rows.map(mapDraftCost);
    const qboProjectIdentities = qboIdentitiesResult.rows.map(mapProjectQboIdentity);
    let postedActuals = postedActualsResult.rows.map(mapPostedActual);
    if (this.finance !== null) {
      const financeResult = await this.finance.getProjectActuals({
        organizationId: scope.organizationId,
        legalEntityId: scope.legalEntityId ?? legalEntityIdSchema.parse(summary.legalEntityId),
        projectId,
        asOf,
      });
      const coverage = projectFinanceCoverageSchema.parse(financeResult.coverage);
      const actuals = financeResult.actuals;
      postedActuals = actuals.map(mapFinanceActual);
      summary = projectSummarySchema.parse({
        ...summary,
        postedActualCents: coverage === "unavailable" ? null : sumActuals(actuals),
        postedActualCoverage: coverage,
      });
    }
    return projectDetailSchema.parse({ ...summary, scopeItems, budgetVersions, tasks, draftCosts, postedActuals, qboProjectIdentities });
  }
}

export class ProjectService extends ProjectReadService {
  constructor(executor: RentOpsQueryExecutor) {
    super(executor);
  }

  async execute(kind: ProjectCommandKind, envelope: unknown, options: ProjectCommandExecutionOptions): Promise<OperationReceipt> {
    return executeProjectCommand(this.executor, kind, envelope, options);
  }
}

export const projectReadService = (executor: RentOpsQueryExecutor, finance?: ProjectFinanceReadPort): ProjectReadService => new ProjectReadService(executor, finance ?? null);
