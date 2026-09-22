import { centsFromBigInt, centsToBigInt } from "../../shared/company";
import type { ProjectDetail } from "../../shared/projects";
import type { ReportMissingData, ReportSourceCoverage, ReportTotal, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { periodBounds, reportColumns, resultFromRecords, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";

export const PROJECT_REPORT_IDS = ["contractor-exposure", "project-performance", "rehab-benchmark"] as const;
export type ProjectReportId = (typeof PROJECT_REPORT_IDS)[number];

export interface ProjectReportingReadResult {
  readonly projects: readonly ProjectDetail[];
  readonly coverage: {
    readonly state: ReportSourceCoverage["state"];
    readonly evidence: ReportSourceCoverage["evidence"];
    readonly watermark?: string | null;
    readonly reason?: string | null;
  };
  /** Execution commitments are optional because the project read service and
   * execution service are separate bounded ports. Missing commitments remain
   * a named gap in contractor exposure. */
  readonly commitments?: readonly {
    readonly projectId: string;
    readonly vendorName?: string | null;
    readonly vendorId?: string | null;
    readonly committedCents: string;
    readonly status: string;
    readonly currency: string;
    readonly id: string;
    readonly committedOn?: string | null;
  }[];
}

export interface ProjectReportingReadPort {
  read(input: {
    readonly context: ReportingEngineContext;
    readonly projectIds: readonly string[];
    readonly propertyIds: readonly string[];
    readonly legalEntityIds: readonly string[];
  }): Promise<ProjectReportingReadResult>;
}

function includesRequested(context: ReportingEngineContext, project: ProjectDetail): boolean {
  const scope = context.request.scope;
  if (scope.projectIds.length && !scope.projectIds.includes(String(project.id) as typeof scope.projectIds[number])) return false;
  if (scope.propertyIds.length && !scope.propertyIds.includes(String(project.propertyId) as typeof scope.propertyIds[number])) return false;
  if (scope.legalEntityIds.length && !scope.legalEntityIds.includes(String(project.legalEntityId) as typeof scope.legalEntityIds[number])) return false;
  const selectedProjects = context.request.filters.projectIds;
  if (Array.isArray(selectedProjects) && selectedProjects.length && !selectedProjects.includes(String(project.id))) return false;
  return true;
}

function asDate(context: ReportingEngineContext): { from: string | null; through: string | null } {
  return periodBounds(context);
}

function inDate(date: string | null | undefined, context: ReportingEngineContext): boolean {
  if (!date) return false;
  const period = asDate(context);
  return (!period.from || date >= period.from) && (!period.through || date <= period.through);
}

function cumulativeThroughAsOf(context: ReportingEngineContext): boolean {
  const period = context.request.period;
  return period.mode === "as_of" || (period.mode === "custom" && Boolean(period.asOfDate) && !period.fromDate && !period.toDate);
}

function actualInScope(date: string | null | undefined, context: ReportingEngineContext): boolean {
  if (!date) return false;
  if (cumulativeThroughAsOf(context)) {
    const through = periodBounds(context).through;
    return !through || date <= through;
  }
  return inDate(date, context);
}

function latestApprovedBudget(project: ProjectDetail, context: ReportingEngineContext) {
  const through = periodBounds(context).through;
  return project.budgetVersions
    .filter(version => (version.status === "approved" || version.status === "superseded") && version.approvedAt !== null && (!through || version.approvedAt.slice(0, 10) <= through))
    .sort((left, right) => right.versionNo - left.versionNo || String(right.approvedAt).localeCompare(String(left.approvedAt)))[0] ?? null;
}

function statusMatches(project: ProjectDetail, context: ReportingEngineContext): boolean {
  const requested = context.request.filters.status;
  if (!Array.isArray(requested) || requested.length === 0) return true;
  const mapped = project.status === "planning" ? "planned" : project.status === "active" ? "in_progress" : project.status === "completed" ? "complete" : project.status === "on_hold" ? "blocked" : "cancelled";
  return requested.some(value => typeof value === "string" && value === mapped);
}

function projectMatchesFilters(project: ProjectDetail, context: ReportingEngineContext): boolean {
  if (!statusMatches(project, context)) return false;
  const search = context.request.filters.search;
  if (typeof search === "string" && search.trim() && !`${project.name} ${project.description ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
  return true;
}

function selectedActuals(project: ProjectDetail, context: ReportingEngineContext): { readonly amount: bigint | null; readonly state: "complete" | "partial" | "unavailable" } {
  if (project.postedActualCoverage === "unavailable") return { amount: null, state: "unavailable" };
  const actuals = project.postedActuals.filter(actual => actualInScope(actual.postedOn, context));
  if (project.postedActualCoverage === "partial") return { amount: actuals.reduce((total, actual) => total + centsToBigInt(actual.amountCents), BigInt(0)), state: "partial" };
  return { amount: actuals.reduce((total, actual) => total + centsToBigInt(actual.amountCents), BigInt(0)), state: "complete" };
}

function sum(values: readonly (string | null | undefined)[]): bigint | null {
  if (values.some(value => value === null || value === undefined)) return null;
  return values.reduce((total, value) => total + centsToBigInt(value!), BigInt(0));
}

function coverage(context: ReportingEngineContext, result: ProjectReportingReadResult, rows: number, dependency: string): ReportSourceCoverage {
  const bounds = periodBounds(context);
  return sourceCoverage(context, {
    source: "company_projects",
    state: result.coverage.state,
    evidence: result.coverage.evidence,
    basis: "mixed",
    watermark: result.coverage.watermark ?? null,
    coveredFrom: bounds.from,
    coveredThrough: bounds.through,
    rowCount: rows,
    reason: result.coverage.reason ?? dependency,
  });
}

function totals(key: string, amount: bigint | null, currency: string | null, state: ReportTotal["state"]): ReportTotal {
  return { key, amountCents: amount === null ? null : centsFromBigInt(amount), currency: currency as ReportTotal["currency"], state };
}

export function createProjectReportingEngine(read: ProjectReportingReadPort): ReportingEngine {
  return {
    key: "combined.projects",
    reportIds: [...PROJECT_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const source = await read.read({ context, projectIds: context.request.scope.projectIds.map(String), propertyIds: context.request.scope.propertyIds.map(String), legalEntityIds: context.request.scope.legalEntityIds.map(String) });
      if (Array.isArray(context.request.filters.vendorIds) && context.request.filters.vendorIds.length) throw new ReportingError("report_unavailable", "Vendor filtering requires a verified project-to-vendor identity mapping.", 409, { dependency: "project_vendor_identity" });
      const projects = source.projects.filter(project => includesRequested(context, project) && projectMatchesFilters(project, context));
      if (!projects.length && source.coverage.state === "unavailable") throw new ReportingError("report_unavailable", "Project reporting data is unavailable for the requested company scope.", 409, { dependency: "company_projects" });
      const reportId = context.definition.id as ProjectReportId;
      const missing: ReportMissingData[] = [];
      const records: unknown[] = [];
      let totalBudget: bigint | null = BigInt(0);
      let totalActual: bigint | null = BigInt(0);
      if (reportId === "project-performance") {
        for (const project of projects) {
          const budget = latestApprovedBudget(project, context);
          const actualSelection = selectedActuals(project, context);
          const actual = actualSelection.amount === null ? null : centsFromBigInt(actualSelection.amount);
          if (!budget) missing.push({ code: "project_budget_unavailable", state: "unknown", message: `Project ${project.name} has no budget version approved by the report date.`, scope: String(project.id) });
          if (actual === null) missing.push({ code: "project_actuals_unavailable", state: "unavailable", message: `Posted actuals for ${project.name} are not covered by a verified accounting source.`, scope: String(project.id) });
          else if (actualSelection.state === "partial") missing.push({ code: "project_actuals_partial", state: "partial", message: `Posted actuals for ${project.name} are only partially covered by the accounting source.`, scope: String(project.id) });
          if (budget) totalBudget = totalBudget === null ? null : totalBudget + centsToBigInt(budget.totalEstimatedCents);
          if (actual === null) totalActual = null;
          else if (totalActual !== null) totalActual += centsToBigInt(actual);
          records.push({ projectId: project.id, projectName: project.name, projectType: project.projectType, status: project.status, legalEntityId: project.legalEntityId, propertyId: project.propertyId, unitId: project.unitId, startOn: project.startOn, targetOn: project.targetOn, approvedBudgetCents: budget?.totalEstimatedCents ?? null, budgetScope: "approved_lifetime", postedActualCents: actual, actualScope: cumulativeThroughAsOf(context) ? "cumulative_through_as_of" : "requested_period", actualCoverage: project.postedActualCoverage, varianceCents: budget && actual !== null ? centsFromBigInt(centsToBigInt(actual) - centsToBigInt(budget.totalEstimatedCents)) : null });
        }
        const result = resultFromRecords(context, records, { source: "company_projects", basis: "mixed", missingData: missing, totals: [totals("approved_budget", totalBudget, projects[0]?.currency ?? null, totalBudget === null ? "partial" : "complete"), totals("posted_actuals", totalActual, projects[0]?.currency ?? null, totalActual === null ? "partial" : "complete")], columns: reportColumns([
          { id: "projectName", label: "Project", type: "text" }, { id: "projectType", label: "Type", type: "status" }, { id: "status", label: "Status", type: "status" }, { id: "startOn", label: "Start", type: "date" }, { id: "targetOn", label: "Target", type: "date" }, { id: "approvedBudgetCents", label: "Approved budget", type: "money" }, { id: "budgetScope", label: "Budget scope", type: "status" }, { id: "postedActualCents", label: "Posted actuals", type: "money" }, { id: "actualScope", label: "Actual scope", type: "status" }, { id: "actualCoverage", label: "Actual coverage", type: "status" }, { id: "varianceCents", label: "Variance", type: "money" },
        ]) });
        return { ...result, coverage: [coverage(context, source, result.rows.length, "Project budgets are R-ops records; posted actuals remain partial until the accounting mirror verifies every binding.")] };
      }
      if (reportId === "contractor-exposure") {
        const commitments = source.commitments ?? [];
        if (!source.commitments) missing.push({ code: "project_commitments_unavailable", state: "unavailable", message: "Approved commitment and purchase-order records are not registered for this report." });
        const grouped = new Map<string, { projectIds: Set<string>; amount: bigint; currency: string }>();
        const allowedProjectIds = new Set(projects.map(project => String(project.id)));
        for (const commitment of commitments) {
          if (!allowedProjectIds.has(commitment.projectId)) continue;
          if (!["approved", "closed"].includes(commitment.status)) continue;
          if (!commitment.committedOn) {
            missing.push({ code: "commitment_period_unavailable", state: "unknown", message: `Commitment ${commitment.id} has no dated approval or commitment date.`, scope: commitment.id });
            continue;
          }
          if (!inDate(commitment.committedOn, context)) continue;
          const key = `${commitment.vendorName ?? "unknown"}:${commitment.currency}`;
          const prior = grouped.get(key) ?? { projectIds: new Set<string>(), amount: BigInt(0), currency: commitment.currency };
          prior.projectIds.add(commitment.projectId); prior.amount += centsToBigInt(commitment.committedCents); grouped.set(key, prior);
        }
        for (const [key, value] of Array.from(grouped.entries())) records.push({ vendorName: key.split(":")[0], currency: value.currency, projectCount: value.projectIds.size, projectIds: Array.from(value.projectIds), committedCents: centsFromBigInt(value.amount), exposureState: source.commitments ? "approved_commitments" : "unavailable" });
        const result = resultFromRecords(context, records, { source: "company_project_commitments", basis: "mixed", missingData: missing, columns: reportColumns([{ id: "vendorName", label: "Vendor", type: "text" }, { id: "currency", label: "Currency", type: "text" }, { id: "projectCount", label: "Projects", type: "integer" }, { id: "committedCents", label: "Committed", type: "money" }, { id: "exposureState", label: "Coverage", type: "status" }]) });
        return { ...result, coverage: [coverage(context, source, result.rows.length, "Contractor exposure needs approved commitment records and verified accounting actuals.")] };
      }
      for (const project of projects) {
        const actualsByScope = new Map<string, bigint>();
        for (const actual of project.postedActuals) if (actual.scopeItemId && actualInScope(actual.postedOn, context)) actualsByScope.set(actual.scopeItemId, (actualsByScope.get(actual.scopeItemId) ?? BigInt(0)) + centsToBigInt(actual.amountCents));
        for (const item of project.scopeItems) {
          const actual = actualsByScope.get(String(item.id));
          records.push({ projectId: project.id, projectName: project.name, propertyId: project.propertyId, category: item.category, scopeItemId: item.id, description: item.description, quantity: item.quantity, estimatedCents: item.estimatedCents, actualCents: actual === undefined ? null : centsFromBigInt(actual), varianceCents: actual === undefined ? null : centsFromBigInt(actual - centsToBigInt(item.estimatedCents)), actualEvidence: actual === undefined ? "no_linked_actual" : project.postedActualCoverage });
          if (actual === undefined) missing.push({ code: "rehab_actual_link_unavailable", state: "partial", message: `No verified posted actual is linked to scope item ${item.description}.`, scope: String(item.id) });
        }
      }
      const result = resultFromRecords(context, records, { source: "company_project_scope_and_actuals", basis: "mixed", missingData: missing, columns: reportColumns([{ id: "projectName", label: "Project", type: "text" }, { id: "category", label: "Category", type: "text" }, { id: "description", label: "Scope item", type: "text" }, { id: "quantity", label: "Quantity", type: "decimal" }, { id: "estimatedCents", label: "Estimated", type: "money" }, { id: "actualCents", label: "Actual", type: "money" }, { id: "varianceCents", label: "Variance", type: "money" }, { id: "actualEvidence", label: "Actual coverage", type: "status" }]) });
      return { ...result, coverage: [coverage(context, source, result.rows.length, "Rehab benchmark requires verified completed-cost links and scope quantities.")] };
    },
  };
}
