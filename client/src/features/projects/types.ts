import type { CommandEnvelope, OperationReceipt } from "@shared/company/commands";
import type { CompanyContextEntity } from "@shared/company/context";
import type {
  ProjectCommandKind,
  ProjectExecutionCommandKind,
  ProjectExecutionDetail as SharedProjectExecutionDetail,
  ProjectExecutionCommandPayload,
  ProjectDetail as SharedProjectDetail,
  ProjectDraftCost,
  ProjectScopeItem,
  ProjectStatus,
  ProjectSummary as SharedProjectSummary,
  ProjectTask as SharedProjectTask,
  ProjectTaskStatus,
  ProjectType,
} from "@shared/projects";
import type { ProjectCostReport } from "@shared/projects/cost-report";
import type { CostSourceLinePage } from "@shared/projects/source-lines";
import type { ProjectLaborResponse } from "@shared/time/labor";
import type { QboProjectRecordKind } from "@shared/projects";
import type {
  ProjectDealCost,
  ProjectDealCostCommandKind,
  ProjectDealCostReport,
  ProjectDealFunding,
} from "@shared/projects/deal-costs";

export type { ProjectCostReport, CostSourceLinePage, ProjectLaborResponse };
export type { ProjectDealCost, ProjectDealCostCommandKind, ProjectDealCostReport, ProjectDealFunding };

export type ProjectWorkspaceEntity = CompanyContextEntity;
export type ProjectSummary = SharedProjectSummary;
export type ProjectDetail = SharedProjectDetail;
export type ProjectScopeLine = ProjectScopeItem;
export type ProjectTask = SharedProjectTask;
export type ProjectCostControl = ProjectDraftCost;
export type ProjectExecutionDetail = SharedProjectExecutionDetail;
export type { ProjectCommandKind, ProjectExecutionCommandKind, ProjectExecutionCommandPayload, ProjectStatus, ProjectTaskStatus, ProjectType };

export interface QboIdentityFormValues {
  readonly nativeProjectId: string;
  readonly customerId: string;
  readonly environment: "sandbox" | "production";
  readonly realmId: string;
}

export function qboIdentityFormEntries(values: QboIdentityFormValues): readonly { recordKind: QboProjectRecordKind; externalId: string }[] {
  return [
    { recordKind: "Project", externalId: values.nativeProjectId.trim() },
    ...(values.customerId.trim() ? [{ recordKind: "Customer" as const, externalId: values.customerId.trim() }] : []),
  ];
}

export interface ProjectListFilters {
  readonly status?: ProjectStatus | "all";
  readonly search?: string;
  readonly cursor?: string;
}

export interface ProjectListPage {
  readonly items: readonly ProjectSummary[];
  readonly nextCursor: string | null;
}

export type ProjectCommandEnvelope<TPayload = unknown> = CommandEnvelope<TPayload>;
export type ProjectExecutionCommandEnvelope<TPayload = unknown> = CommandEnvelope<TPayload>;

export interface ProjectCommandResult {
  readonly receipt?: OperationReceipt;
  readonly project?: ProjectDetail;
}

export interface ProjectsApi {
  listProjects(organizationId: string, filters?: ProjectListFilters, signal?: AbortSignal): Promise<ProjectListPage>;
  getProject(organizationId: string, projectId: string, signal?: AbortSignal): Promise<ProjectDetail>;
  getProjectExecution(organizationId: string, projectId: string, scope?: { legalEntityId?: string; propertyId?: string }, signal?: AbortSignal): Promise<ProjectExecutionDetail>;
  sendCommand<TPayload = unknown>(
    organizationId: string,
    kind: ProjectCommandKind | ProjectDealCostCommandKind,
    envelope: ProjectCommandEnvelope<TPayload>,
  ): Promise<ProjectCommandResult>;
  getCostReport?(organizationId: string, projectId: string, scope: { legalEntityId: string; propertyId: string }, signal?: AbortSignal): Promise<ProjectCostReport>;
  getDealCostReport?(organizationId: string, projectId: string, scope: { legalEntityId: string; propertyId: string }, signal?: AbortSignal): Promise<ProjectDealCostReport>;
  getLabor?(organizationId: string, projectId: string, scope: { legalEntityId: string; propertyId: string }, signal?: AbortSignal): Promise<ProjectLaborResponse>;
  searchCostSourceLines?(organizationId: string, query: { legalEntityId: string; purpose: "cost" | "payroll"; projectId?: string; environment?: "sandbox" | "production"; realmId?: string; includeRefunds?: boolean; search?: string; cursor?: string }, signal?: AbortSignal): Promise<CostSourceLinePage>;
  sendExecutionCommand<TPayload = unknown>(
    organizationId: string,
    kind: ProjectExecutionCommandKind,
    envelope: ProjectExecutionCommandEnvelope<TPayload>,
  ): Promise<ProjectCommandResult>;
}

/** Route values. "scope" and "costs" open Budgets & costs; "execution" opens Commitments. */
export const PROJECT_TABS = ["overview", "schedule", "budget", "deal-costs", "commitments", "draws", "scope", "costs", "execution"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
export type ProjectSection = "overview" | "schedule" | "budget" | "deal-costs" | "commitments" | "draws";
export const PROJECT_SECTIONS: readonly (readonly [ProjectSection, string])[] = [["overview", "Overview"], ["schedule", "Schedule"], ["budget", "Budgets & costs"], ["deal-costs", "Deal costs"], ["commitments", "Commitments"], ["draws", "Draws"]];
export function projectSectionFor(tab: ProjectTab | undefined): ProjectSection {
  if (tab === "scope" || tab === "costs") return "budget";
  if (tab === "execution") return "commitments";
  return tab ?? "overview";
}

export interface ProjectWorkspaceProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly entities?: readonly ProjectWorkspaceEntity[];
  /** Planned properties come from the project-scoped property-plan read, not company context. */
  readonly plannedPropertyIds?: readonly string[];
  readonly api?: ProjectsApi;
  readonly initialProjectId?: string;
  readonly activeTab?: ProjectTab;
  readonly onTabChange?: (tab: ProjectTab) => void;
  readonly onNavigate?: (projectId?: string) => void;
}

export interface ProjectFormValues {
  readonly name: string;
  readonly description: string;
  readonly projectType: ProjectType;
  readonly status: ProjectStatus;
  readonly legalEntityId: string;
  readonly propertyId: string;
  readonly unitId: string;
  readonly startOn: string;
  readonly targetOn: string;
}

export interface ScopeLineFormValues {
  readonly description: string;
  readonly category: string;
  readonly unitLabel: string;
  readonly quantity: string;
  readonly rate: string;
}

export interface TaskFormValues {
  readonly title: string;
  readonly description: string;
  readonly status: ProjectTaskStatus;
  readonly startsOn: string;
  readonly dueOn: string;
  readonly completedOn: string;
  readonly dependencyTaskIds: readonly string[];
}

export interface CostControlFormValues {
  readonly vendorName: string;
  readonly description: string;
  readonly amount: string;
  readonly incurredOn: string;
  readonly scopeItemId: string;
}
