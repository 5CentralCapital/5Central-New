import type { CommandEnvelope, OperationReceipt } from "@shared/company/commands";
import type { CompanyContextEntity, CompanyContextProperty } from "@shared/company/context";
import type {
  ProjectCommandKind,
  ProjectDetail as SharedProjectDetail,
  ProjectDraftCost,
  ProjectScopeItem,
  ProjectStatus,
  ProjectSummary as SharedProjectSummary,
  ProjectTask as SharedProjectTask,
  ProjectTaskStatus,
  ProjectType,
} from "@shared/projects";

export type ProjectWorkspaceProperty = CompanyContextProperty;
export type ProjectWorkspaceEntity = CompanyContextEntity;
export type ProjectSummary = SharedProjectSummary;
export type ProjectDetail = SharedProjectDetail;
export type ProjectScopeLine = ProjectScopeItem;
export type ProjectTask = SharedProjectTask;
export type ProjectCostControl = ProjectDraftCost;
export type { ProjectCommandKind, ProjectStatus, ProjectTaskStatus, ProjectType };

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

export interface ProjectCommandResult {
  readonly receipt?: OperationReceipt;
  readonly project?: ProjectDetail;
}

export interface ProjectsApi {
  listProjects(organizationId: string, filters?: ProjectListFilters, signal?: AbortSignal): Promise<ProjectListPage>;
  getProject(organizationId: string, projectId: string, signal?: AbortSignal): Promise<ProjectDetail>;
  sendCommand<TPayload = unknown>(
    organizationId: string,
    kind: ProjectCommandKind,
    envelope: ProjectCommandEnvelope<TPayload>,
  ): Promise<ProjectCommandResult>;
}

export type ProjectTab = "overview" | "scope" | "schedule" | "costs";

export interface ProjectWorkspaceProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly entities?: readonly ProjectWorkspaceEntity[];
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
