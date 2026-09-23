import type { ProjectFinanceActual, ProjectFinanceCoverage, ProjectFinanceReadPort } from "../../shared/projects";
import { isoDateSchema, legalEntityIdSchema } from "../../shared/company";
import { projectIdSchema } from "../../shared/projects/contracts";
import { grantCovers, type WorkspaceReadContext } from "./access";

/** Most projects read per workspace request; more make the posted total incomplete. */
export const PROJECT_POSTING_LIMIT = 200;

export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
  readonly legalEntityId: string;
  readonly propertyId: string;
  readonly currency: string;
}

export interface ProjectPostings {
  /** Projects whose postings were asked for. */
  readonly projectCount: number;
  /**
   * complete: every project's bound QuickBooks lines were read in full.
   * partial: some lines or projects could not be read; the amount is a minimum.
   * unavailable: nothing could be read.
   */
  readonly coverage: ProjectFinanceCoverage;
  readonly actuals: ReadonlyArray<{ readonly project: WorkspaceProject; readonly actual: ProjectFinanceActual }>;
}

/** Projects on the given properties, limited to what the principal's grants cover. */
export async function readWorkspaceProjects(
  context: WorkspaceReadContext,
  propertyIds: readonly string[],
  statuses?: readonly string[],
): Promise<{ projects: WorkspaceProject[]; truncated: boolean; uncovered: number }> {
  if (!propertyIds.length) return { projects: [], truncated: false, uncovered: 0 };
  const { rows } = await context.executor.query<{ id: string; name: string; legal_entity_id: string; property_id: string; currency: string }>(
    `SELECT id, name, legal_entity_id, property_id, currency FROM company_projects
      WHERE organization_id = $1 AND property_id = ANY($2::text[]) AND ($3::text[] IS NULL OR status = ANY($3::text[]))
      ORDER BY property_id, id LIMIT ${PROJECT_POSTING_LIMIT + 1}`,
    [context.principal.organizationId, [...propertyIds], statuses ? [...statuses] : null],
  );
  const projects: WorkspaceProject[] = [];
  let uncovered = 0;
  for (const row of rows.slice(0, PROJECT_POSTING_LIMIT)) {
    if (!grantCovers(context.principal, row.legal_entity_id, row.property_id)) { uncovered += 1; continue; }
    projects.push({ id: row.id, name: row.name, legalEntityId: row.legal_entity_id, propertyId: row.property_id, currency: row.currency });
  }
  return { projects, truncated: rows.length > PROJECT_POSTING_LIMIT, uncovered };
}

/**
 * Posted project costs through the project finance read port — the same bound
 * QuickBooks lines the project pages use — posted on or before `through` and,
 * when given, on or after `from`. Coverage is never upgraded: one partial or
 * unreadable project makes the whole result partial.
 */
export async function readProjectPostings(
  context: WorkspaceReadContext,
  finance: ProjectFinanceReadPort,
  projects: readonly WorkspaceProject[],
  input: { from?: string; through: string; incomplete?: boolean },
): Promise<ProjectPostings> {
  if (!projects.length) return { projectCount: 0, coverage: input.incomplete ? "partial" : "complete", actuals: [] };
  const coverages: ProjectFinanceCoverage[] = [];
  const actuals: Array<{ project: WorkspaceProject; actual: ProjectFinanceActual }> = [];
  for (const project of projects) {
    const result = await finance.getProjectActuals({
      organizationId: context.principal.organizationId,
      legalEntityId: legalEntityIdSchema.parse(project.legalEntityId),
      projectId: projectIdSchema.parse(project.id),
      asOf: isoDateSchema.parse(input.through),
    });
    coverages.push(result.coverage);
    if (result.coverage === "unavailable") continue;
    for (const actual of result.actuals) {
      if (actual.postedOn > input.through || (input.from !== undefined && actual.postedOn < input.from)) continue;
      actuals.push({ project, actual });
    }
  }
  const coverage: ProjectFinanceCoverage = coverages.every(value => value === "unavailable")
    ? "unavailable"
    : coverages.every(value => value === "complete") && !input.incomplete ? "complete" : "partial";
  return { projectCount: projects.length, coverage, actuals };
}
