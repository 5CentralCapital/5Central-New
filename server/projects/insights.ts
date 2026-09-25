import { companyScopeSchema, isoDateSchema, type CompanyScope, type IsoDate } from "../../shared/company";
import {
  calculateProjectCostReport,
  projectCostReportQuerySchema,
  PROJECT_ETC_OVERRIDE_VENDOR,
  type ProjectCostReport,
  type ProjectCostReportQuery,
  type ProjectEtcOverrideInput,
} from "../../shared/projects/cost-report";
import { unavailableProjectFinanceReadPort, type ProjectDetail, type ProjectFinanceReadPort } from "../../shared/projects";
import type { CostSourceLinePage, CostSourceLineQuery } from "../../shared/projects/source-lines";
import type { ProjectLaborResponse } from "../../shared/time/labor";
import { loadAuthenticatedPrincipal, type AuthenticatedPrincipal } from "../company/authorization";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { nowIsoDate } from "../rent-ops/domain/dates";
import { readProjectLabor } from "../time/labor";
import { ProjectExecutionStore } from "./execution-store";
import { dbCents, dbString } from "./helpers";
import { ProjectReadService } from "./service";
import { searchCostSourceLines } from "./source-lines";

/**
 * Read-only project cost reporting shared by web and Codex: the canonical
 * cost summary, the QBO line picker for finance bindings and the approved
 * labor allocation. Every read authorizes through the project read service.
 */
export interface ProjectInsightsPort {
  costReport(principal: AuthenticatedPrincipal, query: ProjectCostReportQuery): Promise<ProjectCostReport>;
  labor(principal: AuthenticatedPrincipal, query: { scope: CompanyScope; projectId: string }): Promise<ProjectLaborResponse>;
  costSourceLines(principal: AuthenticatedPrincipal, query: CostSourceLineQuery): Promise<CostSourceLinePage>;
}

export interface CreateProjectInsightsPortOptions {
  readonly financeFactory?: (transaction: RentOpsQueryExecutor) => ProjectFinanceReadPort;
  readonly today?: () => string;
}

const LIEN_WAIVER_TAGS = ["lien waiver", "lien_waiver", "lien-waiver", "lien waivers"];

async function etcOverrides(executor: RentOpsQueryExecutor, organizationId: string, projectId: string): Promise<ProjectEtcOverrideInput[]> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (scope_item_id) id, scope_item_id, amount_cents::text AS amount_cents, description
       FROM company_project_draft_costs
      WHERE organization_id=$1 AND project_id=$2 AND vendor_name=$3 AND archived_at IS NULL AND scope_item_id IS NOT NULL
      ORDER BY scope_item_id, updated_at DESC, id DESC`,
    [organizationId, projectId, PROJECT_ETC_OVERRIDE_VENDOR],
  );
  return result.rows.map((row) => ({
    id: dbString(row.id, "etc_override_id"),
    scopeItemId: dbString(row.scope_item_id, "scope_item_id"),
    amountCents: dbCents(row.amount_cents, "etc_override_amount"),
    reason: row.description === null || row.description === undefined ? "" : String(row.description),
  }));
}

async function lienWaiverCount(executor: RentOpsQueryExecutor, organizationId: string, projectId: string): Promise<number> {
  const result = await executor.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM company_documents d
      WHERE d.organization_id=$1 AND d.project_id=$2 AND d.state='verified'
        AND EXISTS (SELECT 1 FROM unnest(d.tags) tag WHERE lower(btrim(tag)) = ANY($3::text[]))`,
    [organizationId, projectId, LIEN_WAIVER_TAGS],
  );
  return Number(result.rows[0]?.count ?? 0);
}

type ProjectActualResult = Awaited<ReturnType<ProjectFinanceReadPort["getProjectActuals"]>>;

/**
 * Build the canonical rehab cost report from the existing project workflow.
 * Deal-cost reporting calls this helper for ETC; it does not recreate budget,
 * commitment, labor or override arithmetic in a second ledger.
 */
export async function readCanonicalProjectCostReport(
  executor: RentOpsQueryExecutor,
  project: ProjectDetail,
  finance: ProjectFinanceReadPort,
  asOf: IsoDate,
  actualResult?: ProjectActualResult,
): Promise<ProjectCostReport> {
  const scope = companyScopeSchema.parse({ organizationId: project.organizationId, legalEntityId: project.legalEntityId, propertyId: project.propertyId });
  const snapshot = await new ProjectExecutionStore(executor).read({ scope, projectId: project.id, asOf });
  const actuals = actualResult ?? await finance.getProjectActuals({ organizationId: project.organizationId, legalEntityId: project.legalEntityId, projectId: project.id, asOf });
  const labor = await readProjectLabor(executor, { organizationId: project.organizationId, projectId: project.id, scopeItemIds: project.scopeItems.map((item) => String(item.id)) });
  const report = calculateProjectCostReport({
    projectId: project.id,
    currency: project.currency,
    asOf,
    targetOn: project.targetOn,
    scopeItems: project.scopeItems.filter((item) => item.archivedAt === null).map((item) => ({ id: String(item.id), description: item.description, estimatedCents: item.estimatedCents })),
    budgetVersions: project.budgetVersions.map((version) => ({
      versionNo: version.versionNo, status: version.status, totalEstimatedCents: version.totalEstimatedCents,
      lines: version.lines.map((line) => ({ scopeItemId: line.scopeItemId === null ? null : String(line.scopeItemId), description: line.description, estimatedCents: line.estimatedCents })),
    })),
    draftCostCents: project.draftCostCents,
    etcOverrides: await etcOverrides(executor, project.organizationId, project.id),
    commitments: snapshot.commitments,
    bids: snapshot.bids.map((bid) => ({ id: String(bid.id), scopeItemId: bid.scopeItemId === null ? null : String(bid.scopeItemId) })),
    changeOrders: snapshot.changeOrders,
    purchaseOrders: snapshot.purchaseOrders,
    draws: snapshot.drawRequests,
    punchItems: snapshot.punchItems,
    tasks: project.tasks.filter((task) => task.archivedAt === null).map((task) => ({
      id: String(task.id), title: task.title, status: task.status, startsOn: task.startsOn, dueOn: task.dueOn, completedOn: task.completedOn,
      dependencyTaskIds: task.dependencyTaskIds.map(String),
    })),
    actuals: actuals.actuals,
    actualCoverage: actuals.coverage,
    labor: labor.rows.map((row) => ({ timesheetId: row.timesheetId, scopeItemId: row.scopeItemId, currency: row.currency, estimatedCents: row.estimatedCents, postedCents: row.postedCents })),
    lienWaiverDocumentCount: await lienWaiverCount(executor, project.organizationId, project.id),
  });
  if (!labor.truncated) return report;
  return { ...report, warnings: [...report.warnings, "Labor rows exceed the read limit; labor totals are incomplete."].slice(0, 100) };
}

export function createProjectInsightsPort(executor: RentOpsQueryExecutor, options: CreateProjectInsightsPortOptions = {}): ProjectInsightsPort {
  const today = options.today ?? (() => nowIsoDate());
  async function read<T>(principal: AuthenticatedPrincipal, work: (transaction: RentOpsQueryExecutor, fresh: AuthenticatedPrincipal, finance: ProjectFinanceReadPort) => Promise<T>): Promise<T> {
    if (!executor.transaction) throw new Error("Project reads require transaction support");
    return executor.transaction(async (transaction) => {
      const fresh = await loadAuthenticatedPrincipal(transaction, { actorId: principal.actorId, organizationId: principal.organizationId, role: principal.role });
      return work(transaction, fresh, options.financeFactory?.(transaction) ?? unavailableProjectFinanceReadPort);
    }, { readOnly: true });
  }

  return {
    costReport: (principal, input) => read(principal, async (transaction, fresh, finance) => {
      const query = projectCostReportQuerySchema.parse(input);
      const asOf = isoDateSchema.parse(query.asOf ?? today()) as IsoDate;
      const project = await new ProjectReadService(transaction, finance).get(fresh, { scope: query.scope, projectId: query.projectId });
      return readCanonicalProjectCostReport(transaction, project, finance, asOf);
    }),
    labor: (principal, input) => read(principal, async (transaction, fresh, finance) => {
      const project = await new ProjectReadService(transaction, finance).get(fresh, { scope: companyScopeSchema.parse(input.scope), projectId: input.projectId });
      return readProjectLabor(transaction, { organizationId: project.organizationId, projectId: project.id, scopeItemIds: project.scopeItems.map((item) => String(item.id)) });
    }),
    costSourceLines: (principal, query) => read(principal, (transaction, fresh) => searchCostSourceLines(transaction, fresh, query)),
  };
}
