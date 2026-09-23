import type { CommandEnvelope, OperationReceipt } from "@shared/company";
import type { CompanyContextEntity } from "@shared/company/context";
import type {
  TimeCoverage,
  TimeConnectionScope,
  TimeConnectionSummary,
  TimeEmployeeMapping,
  TimeEntry,
  TimeEnvironment,
  TimeJobcode,
  TimeJobcodeMapping,
  TimeUser,
} from "@shared/time";
import type { TimePayrollLink } from "@shared/time/labor";
import type { CostSourceLinePage } from "@shared/projects/source-lines";

export type { TimePayrollLink, CostSourceLinePage };

export type TimeWorkspaceEntity = CompanyContextEntity;
export type { TimeCoverage, TimeConnectionScope, TimeConnectionSummary, TimeEmployeeMapping, TimeEntry, TimeEnvironment, TimeJobcode, TimeJobcodeMapping, TimeUser };

export interface TimeContactOption { readonly id: string; readonly displayName: string; readonly kind: "person" | "organization"; }
export interface TimeProjectOption { readonly id: string; readonly name: string; readonly legalEntityId: string; }

export interface TimeListFilters {
  readonly legalEntityId: string;
  readonly environment: TimeEnvironment;
  readonly providerCompanyId: string;
  readonly propertyId?: string;
  readonly reviewState?: TimeEntry["reviewState"];
  readonly mappingStatus?: TimeEntry["mappingStatus"];
  readonly from?: string;
  readonly through?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TimeListPage {
  readonly items: readonly TimeEntry[];
  readonly nextCursor: string | null;
  readonly coverage: readonly TimeCoverage[];
}

export type TimeCommandEnvelope<TPayload = unknown> = CommandEnvelope<TPayload>;

export interface TimeApi {
  listEntries(organizationId: string, filters: TimeListFilters, signal?: AbortSignal): Promise<TimeListPage>;
  listConnections(organizationId: string, legalEntityId: string, environment?: TimeEnvironment, signal?: AbortSignal): Promise<readonly TimeConnectionSummary[]>;
  beginConnection(organizationId: string, legalEntityId: string, providerCompanyId?: string, signal?: AbortSignal): Promise<{ readonly authorizationUrl: string; readonly expiresAt: string; readonly environment: TimeEnvironment }>;
  listContacts(organizationId: string, signal?: AbortSignal): Promise<readonly TimeContactOption[]>;
  listProjects(organizationId: string, legalEntityId: string, signal?: AbortSignal): Promise<readonly TimeProjectOption[]>;
  listUsers(organizationId: string, scope: TimeConnectionScope, signal?: AbortSignal): Promise<readonly TimeUser[]>;
  listJobcodes(organizationId: string, scope: TimeConnectionScope, signal?: AbortSignal): Promise<readonly TimeJobcode[]>;
  listEmployeeMappings(organizationId: string, scope: TimeConnectionScope, signal?: AbortSignal): Promise<readonly TimeEmployeeMapping[]>;
  listJobcodeMappings(organizationId: string, scope: TimeConnectionScope, signal?: AbortSignal): Promise<readonly TimeJobcodeMapping[]>;
  sync(organizationId: string, scope: TimeConnectionScope, signal?: AbortSignal): Promise<{ readonly status: "complete" | "partial"; readonly streams: readonly TimeCoverage[]; readonly conflicts: readonly string[] }>;
  sendCommand<TPayload = unknown>(organizationId: string, kind: string, envelope: TimeCommandEnvelope<TPayload>): Promise<OperationReceipt>;
  listProjectScopeItems?(organizationId: string, projectId: string, signal?: AbortSignal): Promise<readonly { readonly id: string; readonly description: string }[]>;
  listPayrollLinks?(organizationId: string, legalEntityId: string, signal?: AbortSignal): Promise<readonly TimePayrollLink[]>;
  searchPayrollLines?(organizationId: string, query: { legalEntityId: string; search?: string; cursor?: string }, signal?: AbortSignal): Promise<CostSourceLinePage>;
}

export interface TimeWorkspaceProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly entities?: readonly TimeWorkspaceEntity[];
  readonly api?: TimeApi;
}
