import type { IsoDate } from "../../shared/company";
import {
  projectAssigneeOptionSchema,
  projectAssignmentSchema,
  projectBidSchema,
  projectChangeOrderSchema,
  projectCommitmentSchema,
  projectDrawRequestItemSchema,
  projectDrawRequestSchema,
  projectInspectionSchema,
  projectMilestoneSchema,
  projectPunchItemSchema,
  projectPurchaseOrderSchema,
  projectFinanceBindingSchema,
  projectIdSchema,
  projectVendorSchema,
  projectTemplateSchema,
  projectTemplateScopeItemSchema,
  projectTemplateTaskSchema,
} from "../../shared/projects";
import type { ProjectExecutionSnapshot, ProjectExecutionSnapshotSource, ProjectFinanceBindingSource } from "./execution";
import { financialSourceReferenceSchema } from "../../shared/accounting/source";
import type { CompanyScope } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import {
  assertProjectScope,
  dbCents,
  dbCount,
  dbDate,
  dbNullableDate,
  dbNullableString,
  dbNullableTimestamp,
  dbRevision,
  dbString,
  dbTimestamp,
  resolveEffectiveDate,
} from "./helpers";

function nullableUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return dbString(value, field);
}

/**
 * PostgreSQL/PGlite read port for the additive execution tables. It is kept
 * separate from the existing project read service so the root can open one
 * consistent transaction for both snapshots and the finance read port.
 */
export class ProjectExecutionStore implements ProjectExecutionSnapshotSource {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  async read(input: { scope: CompanyScope; projectId: string; asOf?: IsoDate }): Promise<ProjectExecutionSnapshot> {
    const asOf = resolveEffectiveDate(input.asOf);
    const project = await assertProjectScope(this.executor, input.scope, input.projectId, asOf);
    const projectId = projectIdSchema.parse(input.projectId);
    const values = [input.scope.organizationId, input.projectId];
    const [templateRows, templateScopeRows, templateTaskRows, assignmentRows, milestoneRows, inspectionRows, punchRows, vendorRows, assigneeRows, bidRows, commitmentRows, changeRows, poRows, drawRows, drawItemRows, budgetRows] = await Promise.all([
      this.executor.query<Record<string, unknown>>(
        `SELECT id, organization_id, name, project_type, description, currency, active, created_by, created_at, updated_at
           FROM company_project_templates WHERE organization_id = $1 ORDER BY updated_at DESC, id DESC`,
        [input.scope.organizationId],
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, template_id, description, category, unit_label, quantity::text quantity, rate_cents::text rate_cents, position
           FROM company_project_template_scope_items WHERE organization_id = $1 ORDER BY template_id, position, id`,
        [input.scope.organizationId],
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, template_id, title, description, relative_days, position
           FROM company_project_template_tasks WHERE organization_id = $1 ORDER BY template_id, position, id`,
        [input.scope.organizationId],
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, assignee_type, assignee_ref, role, status, starts_on, due_on, notes, created_at, updated_at
           FROM company_project_assignments WHERE organization_id = $1 AND project_id = $2 ORDER BY due_on NULLS LAST, id`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, name, description, status, target_on, completed_on, position, created_at, updated_at
           FROM company_project_milestones WHERE organization_id = $1 AND project_id = $2 ORDER BY position, id`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, inspection_type, status, scheduled_on, inspected_on, inspector_ref, notes, document_ref, created_at, updated_at
           FROM company_project_inspections WHERE organization_id = $1 AND project_id = $2 ORDER BY scheduled_on NULLS LAST, id`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, inspection_id, description, location, status, assigned_to, due_on, completed_on, notes, created_at, updated_at
           FROM company_project_punch_items WHERE organization_id = $1 AND project_id = $2 ORDER BY due_on NULLS LAST, id`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, organization_id, name, status, contact_ref, license_ref, insurance_expires_on, notes, created_at, updated_at
           FROM company_project_vendors WHERE organization_id = $1 ORDER BY name, id`,
        [input.scope.organizationId],
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT c.id, c.display_name,
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM company_contact_roles r
                     WHERE r.organization_id=c.organization_id AND r.contact_id=c.id
                       AND r.role='vendor'
                       AND (r.legal_entity_id IS NULL OR r.legal_entity_id=$2)
                       AND r.effective_from <= $3::date
                       AND (r.effective_until IS NULL OR r.effective_until > $3::date)
                  ) THEN 'vendor'
                  WHEN c.kind='organization' THEN 'team'
                  WHEN EXISTS (
                    SELECT 1 FROM company_contact_roles r
                     WHERE r.organization_id=c.organization_id AND r.contact_id=c.id
                       AND r.role IN ('employee','property_manager')
                       AND (r.legal_entity_id IS NULL OR r.legal_entity_id=$2)
                       AND r.effective_from <= $3::date
                       AND (r.effective_until IS NULL OR r.effective_until > $3::date)
                  ) THEN 'employee'
                  ELSE 'person'
                END AS assignee_type
           FROM company_contacts c
          WHERE c.organization_id=$1 AND c.archived_at IS NULL
          ORDER BY lower(c.display_name), c.id`,
        [input.scope.organizationId, input.scope.legalEntityId, asOf],
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, vendor_id, scope_item_id, status, amount_cents::text amount_cents, currency, submitted_on, valid_until, notes, created_at, updated_at
           FROM company_project_bids WHERE organization_id = $1 AND project_id = $2 ORDER BY updated_at DESC, id DESC`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, vendor_id, bid_id, description, status, original_cents::text original_cents,
                approved_change_cents::text approved_change_cents, committed_cents::text committed_cents,
                currency, start_on, target_on, created_at, updated_at
           FROM company_project_commitments WHERE organization_id = $1 AND project_id = $2 ORDER BY target_on NULLS LAST, id`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, commitment_id, description, reason, status, amount_cents::text amount_cents, currency,
                included_in_budget_version_id, submitted_on, approved_on, created_at, updated_at
           FROM company_project_change_orders WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at DESC, id DESC`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, commitment_id, po_number, status, amount_cents::text amount_cents, currency, issued_on, received_on, notes, created_at, updated_at
           FROM company_project_purchase_orders WHERE organization_id = $1 AND project_id = $2 ORDER BY issued_on NULLS LAST, id`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, project_id, request_no, status, period_from, period_to, gross_eligible_cents::text gross_eligible_cents,
                retainage_percent::text retainage_percent, retainage_cents::text retainage_cents, net_requested_cents::text net_requested_cents,
                currency, submitted_on, approved_on, paid_on, notes, created_at, updated_at
           FROM company_project_draw_requests WHERE organization_id = $1 AND project_id = $2 ORDER BY request_no DESC`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT id, draw_request_id, source_type, source_id, eligible_cents::text eligible_cents, requested_cents::text requested_cents,
                retainage_eligible, retainage_cents::text retainage_cents, notes
           FROM company_project_draw_request_items WHERE organization_id = $1 AND project_id = $2 ORDER BY draw_request_id, id`,
        values,
      ),
      this.executor.query<Record<string, unknown>>(
        `SELECT version_no, status, total_estimated_cents::text total_estimated_cents
           FROM company_project_budget_versions WHERE organization_id = $1 AND project_id = $2 AND status IN ('approved','superseded')
          ORDER BY version_no`,
        values,
      ),
    ]);

    const templateScopes = new Map<string, ReturnType<typeof projectTemplateScopeItemSchema.parse>[]>();
    for (const row of templateScopeRows.rows) {
      const templateId = dbString(row.template_id, "template_id");
      const list = templateScopes.get(templateId) ?? [];
      list.push(projectTemplateScopeItemSchema.parse({
        id: dbString(row.id, "template_scope_item_id"),
        templateId,
        description: dbString(row.description, "template_scope_description"),
        category: dbNullableString(row.category, "template_scope_category"),
        unitLabel: dbNullableString(row.unit_label, "template_scope_unit_label"),
        quantity: dbString(row.quantity, "template_scope_quantity"),
        rateCents: dbCents(row.rate_cents, "template_scope_rate_cents"),
        position: dbCount(row.position, "template_scope_position"),
      }));
      templateScopes.set(templateId, list);
    }
    const templateTasks = new Map<string, ReturnType<typeof projectTemplateTaskSchema.parse>[]>();
    for (const row of templateTaskRows.rows) {
      const templateId = dbString(row.template_id, "template_id");
      const list = templateTasks.get(templateId) ?? [];
      list.push(projectTemplateTaskSchema.parse({
        id: dbString(row.id, "template_task_id"),
        templateId,
        title: dbString(row.title, "template_task_title"),
        description: dbNullableString(row.description, "template_task_description"),
        relativeDays: dbCount(row.relative_days, "template_task_relative_days"),
        position: dbCount(row.position, "template_task_position"),
      }));
      templateTasks.set(templateId, list);
    }
    const templates = templateRows.rows.map((row) => projectTemplateSchema.parse({
      id: dbString(row.id, "template_id"),
      organizationId: dbString(row.organization_id, "organization_id"),
      name: dbString(row.name, "template_name"),
      projectType: dbString(row.project_type, "template_project_type"),
      description: dbNullableString(row.description, "template_description"),
      currency: dbNullableString(row.currency, "template_currency"),
      active: row.active === true,
      createdBy: dbString(row.created_by, "template_created_by"),
      createdAt: dbTimestamp(row.created_at, "template_created_at"),
      updatedAt: dbTimestamp(row.updated_at, "template_updated_at"),
      scopeItems: templateScopes.get(dbString(row.id, "template_id")) ?? [],
      tasks: templateTasks.get(dbString(row.id, "template_id")) ?? [],
    }));

    const assignments = assignmentRows.rows.map((row) => projectAssignmentSchema.parse({
      id: dbString(row.id, "assignment_id"),
      projectId,
      assigneeType: dbString(row.assignee_type, "assignment_type"),
      assigneeRef: dbString(row.assignee_ref, "assignment_ref"),
      role: dbString(row.role, "assignment_role"),
      status: dbString(row.status, "assignment_status"),
      startsOn: dbNullableDate(row.starts_on, "assignment_starts_on"),
      dueOn: dbNullableDate(row.due_on, "assignment_due_on"),
      notes: dbNullableString(row.notes, "assignment_notes"),
      createdAt: dbTimestamp(row.created_at, "assignment_created_at"),
      updatedAt: dbTimestamp(row.updated_at, "assignment_updated_at"),
    }));
    const milestones = milestoneRows.rows.map((row) => projectMilestoneSchema.parse({
      id: dbString(row.id, "milestone_id"), projectId,
      name: dbString(row.name, "milestone_name"), description: dbNullableString(row.description, "milestone_description"),
      status: dbString(row.status, "milestone_status"), targetOn: dbNullableDate(row.target_on, "milestone_target_on"),
      completedOn: dbNullableDate(row.completed_on, "milestone_completed_on"), position: dbCount(row.position, "milestone_position"),
      createdAt: dbTimestamp(row.created_at, "milestone_created_at"), updatedAt: dbTimestamp(row.updated_at, "milestone_updated_at"),
    }));
    const inspections = inspectionRows.rows.map((row) => projectInspectionSchema.parse({
      id: dbString(row.id, "inspection_id"), projectId, inspectionType: dbString(row.inspection_type, "inspection_type"),
      status: dbString(row.status, "inspection_status"), scheduledOn: dbNullableDate(row.scheduled_on, "inspection_scheduled_on"),
      inspectedOn: dbNullableDate(row.inspected_on, "inspection_inspected_on"), inspectorRef: nullableUuid(row.inspector_ref, "inspection_inspector_ref"),
      notes: dbNullableString(row.notes, "inspection_notes"), documentRef: nullableUuid(row.document_ref, "inspection_document_ref"),
      createdAt: dbTimestamp(row.created_at, "inspection_created_at"), updatedAt: dbTimestamp(row.updated_at, "inspection_updated_at"),
    }));
    const punchItems = punchRows.rows.map((row) => projectPunchItemSchema.parse({
      id: dbString(row.id, "punch_item_id"), projectId, inspectionId: nullableUuid(row.inspection_id, "punch_inspection_id"),
      description: dbString(row.description, "punch_description"), location: dbNullableString(row.location, "punch_location"),
      status: dbString(row.status, "punch_status"), assignedTo: nullableUuid(row.assigned_to, "punch_assigned_to"), dueOn: dbNullableDate(row.due_on, "punch_due_on"),
      completedOn: dbNullableDate(row.completed_on, "punch_completed_on"), notes: dbNullableString(row.notes, "punch_notes"),
      createdAt: dbTimestamp(row.created_at, "punch_created_at"), updatedAt: dbTimestamp(row.updated_at, "punch_updated_at"),
    }));
    const vendors = vendorRows.rows.map((row) => projectVendorSchema.parse({
      id: dbString(row.id, "vendor_id"), organizationId: dbString(row.organization_id, "organization_id"), name: dbString(row.name, "vendor_name"),
      status: dbString(row.status, "vendor_status"), contactRef: nullableUuid(row.contact_ref, "vendor_contact_ref"), licenseRef: dbNullableString(row.license_ref, "vendor_license_ref"),
      insuranceExpiresOn: dbNullableDate(row.insurance_expires_on, "vendor_insurance_expires_on"), notes: dbNullableString(row.notes, "vendor_notes"),
      createdAt: dbTimestamp(row.created_at, "vendor_created_at"), updatedAt: dbTimestamp(row.updated_at, "vendor_updated_at"),
    }));
    const assigneeOptions = [...vendors.map((vendor) => projectAssigneeOptionSchema.parse({ id: vendor.id, label: vendor.name, type: "vendor" })), ...assigneeRows.rows.map((row) => projectAssigneeOptionSchema.parse({
      id: dbString(row.id, "assignee_contact_id"),
      label: dbString(row.display_name, "assignee_contact_name"),
      type: dbString(row.assignee_type, "assignee_type"),
    }))].filter((option, index, options) => options.findIndex((candidate) => candidate.id === option.id) === index);
    const bids = bidRows.rows.map((row) => projectBidSchema.parse({
      id: dbString(row.id, "bid_id"), projectId, vendorId: dbString(row.vendor_id, "bid_vendor_id"), scopeItemId: nullableUuid(row.scope_item_id, "bid_scope_item_id"),
      status: dbString(row.status, "bid_status"), amountCents: dbCents(row.amount_cents, "bid_amount_cents"), currency: dbString(row.currency, "bid_currency"),
      submittedOn: dbNullableDate(row.submitted_on, "bid_submitted_on"), validUntil: dbNullableDate(row.valid_until, "bid_valid_until"), notes: dbNullableString(row.notes, "bid_notes"),
      createdAt: dbTimestamp(row.created_at, "bid_created_at"), updatedAt: dbTimestamp(row.updated_at, "bid_updated_at"),
    }));
    const commitments = commitmentRows.rows.map((row) => projectCommitmentSchema.parse({
      id: dbString(row.id, "commitment_id"), projectId, vendorId: nullableUuid(row.vendor_id, "commitment_vendor_id"), bidId: nullableUuid(row.bid_id, "commitment_bid_id"),
      description: dbString(row.description, "commitment_description"), status: dbString(row.status, "commitment_status"), originalCents: dbCents(row.original_cents, "commitment_original_cents"),
      approvedChangeCents: dbCents(row.approved_change_cents, "commitment_approved_change_cents"), committedCents: dbCents(row.committed_cents, "commitment_cents"), currency: dbString(row.currency, "commitment_currency"),
      startOn: dbNullableDate(row.start_on, "commitment_start_on"), targetOn: dbNullableDate(row.target_on, "commitment_target_on"), createdAt: dbTimestamp(row.created_at, "commitment_created_at"), updatedAt: dbTimestamp(row.updated_at, "commitment_updated_at"),
    }));
    const changeOrders = changeRows.rows.map((row) => projectChangeOrderSchema.parse({
      id: dbString(row.id, "change_order_id"), projectId, commitmentId: nullableUuid(row.commitment_id, "change_commitment_id"), description: dbString(row.description, "change_description"), reason: dbString(row.reason, "change_reason"), status: dbString(row.status, "change_status"), amountCents: dbCents(row.amount_cents, "change_amount_cents"), currency: dbString(row.currency, "change_currency"), includedInBudgetVersionId: nullableUuid(row.included_in_budget_version_id, "change_budget_version_id"), submittedOn: dbNullableDate(row.submitted_on, "change_submitted_on"), approvedOn: dbNullableDate(row.approved_on, "change_approved_on"), createdAt: dbTimestamp(row.created_at, "change_created_at"), updatedAt: dbTimestamp(row.updated_at, "change_updated_at"),
    }));
    const purchaseOrders = poRows.rows.map((row) => projectPurchaseOrderSchema.parse({
      id: dbString(row.id, "po_id"), projectId, commitmentId: dbString(row.commitment_id, "po_commitment_id"), poNumber: dbString(row.po_number, "po_number"), status: dbString(row.status, "po_status"), amountCents: dbCents(row.amount_cents, "po_amount_cents"), currency: dbString(row.currency, "po_currency"), issuedOn: dbNullableDate(row.issued_on, "po_issued_on"), receivedOn: dbNullableDate(row.received_on, "po_received_on"), notes: dbNullableString(row.notes, "po_notes"), createdAt: dbTimestamp(row.created_at, "po_created_at"), updatedAt: dbTimestamp(row.updated_at, "po_updated_at"),
    }));
    const drawItems = new Map<string, ReturnType<typeof projectDrawRequestItemSchema.parse>[]>();
    for (const row of drawItemRows.rows) {
      const drawId = dbString(row.draw_request_id, "draw_request_id");
      const list = drawItems.get(drawId) ?? [];
      list.push(projectDrawRequestItemSchema.parse({ id: dbString(row.id, "draw_item_id"), drawRequestId: drawId, sourceType: dbString(row.source_type, "draw_source_type"), sourceId: dbString(row.source_id, "draw_source_id"), eligibleCents: dbCents(row.eligible_cents, "draw_eligible_cents"), requestedCents: dbCents(row.requested_cents, "draw_requested_cents"), retainageEligible: row.retainage_eligible === true, retainageCents: dbCents(row.retainage_cents, "draw_retainage_cents"), notes: dbNullableString(row.notes, "draw_item_notes") }));
      drawItems.set(drawId, list);
    }
    const drawRequests = drawRows.rows.map((row) => { const drawId = dbString(row.id, "draw_id"); return projectDrawRequestSchema.parse({
      id: drawId, projectId, requestNo: dbCount(row.request_no, "draw_request_no"), status: dbString(row.status, "draw_status"), periodFrom: dbDate(row.period_from, "draw_period_from"), periodTo: dbDate(row.period_to, "draw_period_to"), grossEligibleCents: dbCents(row.gross_eligible_cents, "draw_gross_eligible_cents"), retainagePercent: dbString(row.retainage_percent, "draw_retainage_percent"), retainageCents: dbCents(row.retainage_cents, "draw_retainage_cents"), netRequestedCents: dbCents(row.net_requested_cents, "draw_net_requested_cents"), currency: dbString(row.currency, "draw_currency"), submittedOn: dbNullableDate(row.submitted_on, "draw_submitted_on"), approvedOn: dbNullableDate(row.approved_on, "draw_approved_on"), paidOn: dbNullableDate(row.paid_on, "draw_paid_on"), notes: dbNullableString(row.notes, "draw_notes"), createdAt: dbTimestamp(row.created_at, "draw_created_at"), updatedAt: dbTimestamp(row.updated_at, "draw_updated_at"), items: drawItems.get(drawId) ?? [],
    }); });
    const budgets = budgetRows.rows.map((row) => ({ versionNo: dbCount(row.version_no, "budget_version_no"), status: dbString(row.status, "budget_status") as "approved" | "superseded", totalEstimatedCents: dbCents(row.total_estimated_cents, "budget_total_estimated_cents") }));
    return { projectId: projectId as string, scope: input.scope, currency: project.currency, budgets, assignments, milestones, inspections, punchItems, vendors, assigneeOptions, bids, commitments, changeOrders, purchaseOrders, drawRequests, templates };
  }
}

export const createProjectExecutionStore = (executor: RentOpsQueryExecutor): ProjectExecutionStore => new ProjectExecutionStore(executor);

/** Binding read port used by the execution finance adapter and root wiring. */
export class ProjectFinanceBindingStore implements ProjectFinanceBindingSource {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  async listProjectBindings(input: { organizationId: string; projectId: string }): Promise<readonly import("../../shared/projects").ProjectFinanceBindingRecord[]> {
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT b.id, b.project_id, b.commitment_id, b.scope_item_id, b.provider, b.environment, b.realm_id,
              object_type, object_id, line_id, source_version, allocated_cents::text allocated_cents,
              eligible, binding_status, p.legal_entity_id
         FROM company_project_finance_bindings b
         JOIN company_projects p ON p.organization_id = b.organization_id AND p.id = b.project_id
        WHERE b.organization_id = $1 AND b.project_id = $2
        ORDER BY id`,
      [input.organizationId, input.projectId],
    );
    return result.rows.map((row) => projectFinanceBindingSchema.parse({
      id: row.id,
      projectId: projectIdSchema.parse(row.project_id),
      commitmentId: row.commitment_id === null || row.commitment_id === undefined ? null : row.commitment_id,
      scopeItemId: row.scope_item_id === null || row.scope_item_id === undefined ? null : row.scope_item_id,
      source: financialSourceReferenceSchema.parse({
        provider: row.provider,
        organizationId: input.organizationId,
        legalEntityId: row.legal_entity_id ?? undefined,
        environment: row.environment,
        realmId: row.realm_id,
        objectType: row.object_type,
        objectId: row.object_id,
        lineId: row.line_id ?? null,
        version: row.source_version,
      }),
      allocatedCents: dbCents(row.allocated_cents, "binding_allocated_cents"),
      eligible: row.eligible === true,
      bindingStatus: row.binding_status,
    }));
  }
}

export const createProjectFinanceBindingStore = (executor: RentOpsQueryExecutor): ProjectFinanceBindingStore => new ProjectFinanceBindingStore(executor);
