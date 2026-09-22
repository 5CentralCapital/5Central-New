import type { ProjectDetail, ProjectTask } from "../../shared/projects";
import type { ReportMissingData, ReportSourceCoverage, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { periodBounds, reportColumns, resultFromRecords, sourceCoverage } from "./source-engine-utils";
import type { ReportingEngine } from "./registry";
import type { ProjectReportingReadPort, ProjectReportingReadResult } from "./project-engine";

export const TASK_REPORT_IDS = ["completed-tasks", "open-tasks", "tasks-performance", "vendor-details"] as const;
export type TaskReportId = (typeof TASK_REPORT_IDS)[number];

function inPeriod(date: string | null, context: ReportingEngineContext): boolean {
  if (!date) return true;
  const bounds = periodBounds(context);
  return (!bounds.from || date >= bounds.from) && (!bounds.through || date <= bounds.through);
}

function coverage(context: ReportingEngineContext, result: ProjectReportingReadResult, rows: number): ReportSourceCoverage {
  const bounds = periodBounds(context);
  return sourceCoverage(context, { source: "company_project_tasks_and_vendor_costs", state: result.coverage.state, evidence: result.coverage.evidence, basis: "operational", watermark: result.coverage.watermark ?? null, coveredFrom: bounds.from, coveredThrough: bounds.through, rowCount: rows, reason: result.coverage.reason ?? "Task and vendor rows are read from project records; separate work-order history is not assumed." });
}

function projectMatches(context: ReportingEngineContext, project: ProjectDetail): boolean {
  const scope = context.request.scope;
  return (!scope.projectIds.length || scope.projectIds.includes(String(project.id) as typeof scope.projectIds[number]))
    && (!scope.propertyIds.length || scope.propertyIds.includes(String(project.propertyId) as typeof scope.propertyIds[number]))
    && (!scope.legalEntityIds.length || scope.legalEntityIds.includes(String(project.legalEntityId) as typeof scope.legalEntityIds[number]))
    && (!Array.isArray(context.request.filters.projectIds) || !context.request.filters.projectIds.length || context.request.filters.projectIds.includes(String(project.id)));
}

function taskMatchesFilters(context: ReportingEngineContext, project: ProjectDetail, task: ProjectTask): boolean {
  const selectedStatuses = context.request.filters.status;
  if (Array.isArray(selectedStatuses) && selectedStatuses.length) {
    const mapped = task.status === "completed" ? "complete" : task.status === "not_started" ? "open" : task.status;
    if (!selectedStatuses.some(value => typeof value === "string" && value === mapped)) return false;
  }
  const search = context.request.filters.search;
  if (typeof search === "string" && search.trim() && !`${project.name} ${task.title} ${task.description ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) return false;
  return true;
}

function taskRow(project: ProjectDetail, task: ProjectTask): unknown {
  return { taskId: task.id, projectId: project.id, projectName: project.name, legalEntityId: project.legalEntityId, propertyId: project.propertyId, title: task.title, description: task.description, status: task.status, startsOn: task.startsOn, dueOn: task.dueOn, completedOn: task.completedOn, dependencyCount: task.dependencyTaskIds.length, recordRevision: task.recordRevision, updatedAt: task.updatedAt };
}

export function createTaskReportingEngine(read: ProjectReportingReadPort): ReportingEngine {
  return {
    key: "company.tasks",
    reportIds: [...TASK_REPORT_IDS],
    ready: true,
    async run(context): Promise<ReportingEngineResult> {
      const source = await read.read({ context, projectIds: context.request.scope.projectIds.map(String), propertyIds: context.request.scope.propertyIds.map(String), legalEntityIds: context.request.scope.legalEntityIds.map(String) });
      if (source.coverage.state === "unavailable") throw new ReportingError("report_unavailable", "Project task records are unavailable for this scope.", 409, { dependency: "company_task_work_order_records" });
      if ((Array.isArray(context.request.filters.vendorIds) && context.request.filters.vendorIds.length) || (Array.isArray(context.request.filters.staffIds) && context.request.filters.staffIds.length)) throw new ReportingError("report_unavailable", "Vendor and assignee filters require verified task assignment identity records.", 409, { dependency: "project_task_assignment_identity" });
      const reportId = context.definition.id as TaskReportId;
      if (reportId === "vendor-details" && Array.isArray(context.request.filters.status) && context.request.filters.status.length) throw new ReportingError("report_unavailable", "Task status filtering is not applicable to vendor cost rows until each cost is linked to a task.", 409, { dependency: "project_task_cost_link" });
      const projects = source.projects.filter(project => projectMatches(context, project));
      const missing: ReportMissingData[] = [];
      let rows: unknown[] = [];
      if (reportId === "completed-tasks") rows = projects.flatMap(project => project.tasks.filter(task => task.status === "completed" && inPeriod(task.completedOn ?? task.dueOn, context) && taskMatchesFilters(context, project, task)).map(task => taskRow(project, task)));
      else if (reportId === "open-tasks") rows = projects.flatMap(project => project.tasks.filter(task => ["not_started", "in_progress", "blocked"].includes(task.status) && inPeriod(task.dueOn ?? task.startsOn, context) && taskMatchesFilters(context, project, task)).map(task => taskRow(project, task)));
      else if (reportId === "tasks-performance") {
        rows = projects.map(project => {
          const tasks = project.tasks.filter(task => inPeriod(task.completedOn ?? task.dueOn ?? task.startsOn, context) && taskMatchesFilters(context, project, task));
          const completed = tasks.filter(task => task.status === "completed");
          const blocked = tasks.filter(task => task.status === "blocked");
          const durations = completed.flatMap(task => task.startsOn && task.completedOn ? [Math.max(0, Math.round((Date.parse(task.completedOn) - Date.parse(task.startsOn)) / 86_400_000))] : []);
          return { projectId: project.id, projectName: project.name, propertyId: project.propertyId, taskCount: tasks.length, completedCount: completed.length, openCount: tasks.filter(task => ["not_started", "in_progress"].includes(task.status)).length, blockedCount: blocked.length, averageCompletionDays: durations.length ? durations.reduce((total, value) => total + value, 0) / durations.length : null, overdueOpenCount: tasks.filter(task => task.status !== "completed" && task.dueOn !== null && task.dueOn < (periodBounds(context).through ?? "9999-12-31")).length };
        });
      } else {
        const groups = new Map<string, { projectIds: Set<string>; amount: bigint; currency: string | null; recordCount: number }>();
        const search = typeof context.request.filters.search === "string" ? context.request.filters.search.trim().toLocaleLowerCase() : "";
        for (const project of projects) for (const cost of project.draftCosts.filter(cost => inPeriod(cost.incurredOn, context) && (!search || `${project.name} ${cost.vendorName ?? ""} ${cost.description}`.toLocaleLowerCase().includes(search)))) {
          const vendor = cost.vendorName ?? "unknown";
          const key = `${vendor}:${cost.currency}`;
          const current = groups.get(key) ?? { projectIds: new Set<string>(), amount: BigInt(0), currency: cost.currency, recordCount: 0 };
          current.projectIds.add(String(project.id)); current.amount += BigInt(cost.amountCents); current.recordCount += 1; groups.set(key, current);
        }
        rows = Array.from(groups.entries()).map(([key, group]) => ({ vendorName: key.split(":")[0], currency: group.currency, projectCount: group.projectIds.size, projectIds: Array.from(group.projectIds), draftCostCents: group.amount.toString(), recordCount: group.recordCount, vendorSource: "project_draft_costs" }));
        missing.push({ code: "vendor_accounting_details_unavailable", state: "partial", message: "Vendor details include project draft costs; provider account identity and verified QBO liability history are not registered." });
      }
      const columns = reportId === "tasks-performance"
        ? reportColumns([{ id: "projectName", label: "Project", type: "text" }, { id: "taskCount", label: "Tasks", type: "integer" }, { id: "completedCount", label: "Completed", type: "integer" }, { id: "openCount", label: "Open", type: "integer" }, { id: "blockedCount", label: "Blocked", type: "integer" }, { id: "averageCompletionDays", label: "Average completion (days)", type: "decimal" }, { id: "overdueOpenCount", label: "Overdue", type: "integer" }])
        : reportId === "vendor-details"
          ? reportColumns([{ id: "vendorName", label: "Vendor", type: "text" }, { id: "currency", label: "Currency", type: "text" }, { id: "projectCount", label: "Projects", type: "integer" }, { id: "draftCostCents", label: "Draft costs", type: "money" }, { id: "recordCount", label: "Cost records", type: "integer" }, { id: "vendorSource", label: "Source", type: "status" }])
          : reportColumns([{ id: "projectName", label: "Project", type: "text" }, { id: "title", label: "Task", type: "text" }, { id: "status", label: "Status", type: "status" }, { id: "startsOn", label: "Start", type: "date" }, { id: "dueOn", label: "Due", type: "date" }, { id: "completedOn", label: "Completed", type: "date" }, { id: "dependencyCount", label: "Dependencies", type: "integer" }]);
      const result = resultFromRecords(context, rows, { source: "company_project_tasks_and_vendor_costs", basis: "operational", missingData: missing, columns });
      return { ...result, coverage: [coverage(context, source, result.rows.length)] };
    },
  };
}

export function createUnavailableWorkOrderEngine(reason = "No company work-order source is registered."): ReportingEngine {
  return { key: "company.work-orders", reportIds: ["work-orders"], ready: false, reason, async run() { throw new ReportingError("report_unavailable", reason, 409, { dependency: "company_task_work_order_records" }); } };
}
