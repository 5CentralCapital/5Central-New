import { z } from "zod";
import { companyScopeSchema } from "../../shared/company";
import { projectCostReportQuerySchema } from "../../shared/projects/cost-report";
import { costSourceLineQuerySchema } from "../../shared/projects/source-lines";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { loadAuthenticatedPrincipal } from "../company/authorization";
import type { ProjectInsightsPort } from "./insights";

export type ProjectInsightToolRegistrar = (name: string, description: string, schema: z.ZodRawShape, write: boolean, handler: (args: any) => Promise<unknown>) => void;

/** Codex reads the same project cost report and line picker as the web workspace. */
export function registerProjectInsightMcpTools(register: ProjectInsightToolRegistrar, options: { executor: RentOpsQueryExecutor; insights: ProjectInsightsPort; actorId: string }): void {
  const { executor, insights, actorId } = options;
  const principalFor = (organizationId: string) => loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
  register("get_project_cost_report", "Read the canonical project cost summary: original budget, approved changes, revised budget, committed, incurred (verified QBO actual plus posted payroll labor plus estimated labor for approved time not yet posted; each part is also reported on its own, and incurred is a minimum while QBO coverage is partial or labor is unpriced), paid, remaining commitment, cost to complete, estimate at completion, variance, schedule risk, retainage rollforward and closeout checklist. Unknown amounts are null, never zero.",
    { query: projectCostReportQuerySchema }, false,
    async ({ query }) => insights.costReport(await principalFor(query.scope.organizationId), query));
  register("get_project_labor", "Read approved time allocated to a project by jobcode mapping and cost code, with the estimated labor or linked posted payroll for each timesheet.",
    { scope: companyScopeSchema, projectId: z.string().uuid() }, false,
    async ({ scope, projectId }) => insights.labor(await principalFor(scope.organizationId), { scope, projectId }));
  register("search_cost_source_lines", "Search current posted QBO lines with their unallocated balance, for project finance bindings (purpose cost) or payroll links (purpose payroll). Follow nextCursor to continue.",
    { query: costSourceLineQuerySchema }, false,
    async ({ query }) => insights.costSourceLines(await principalFor(query.organizationId), query));
}
