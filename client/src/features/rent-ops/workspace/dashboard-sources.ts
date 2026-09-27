// Data for the company-side widgets (projects, QuickBooks, accounting, debt,
// investors, forecast). Each hook runs only when a widget that needs it is on
// the dashboard, and query keys match the full pages where they overlap so
// the cache is shared. Nothing here writes.
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CompanyContext, CompanyContextOrganization } from "@shared/company/context";
import type { ConnectorHealth } from "@shared/accounting/operations";
import type { ProjectSummary } from "@shared/projects";
import type { ReportKey } from "../types";
import { rentOpsAuthClient } from "../auth";
import { workspacesApi } from "../../workspaces/api";
import { createProjectsApi } from "../../projects/api";
import { accountingApi } from "../../accounting/api";
import type { AccountingMirrorKind, AccountingScope } from "../../accounting/types";
import { reportingApi } from "../../reporting/api";
import { investorsApi } from "../../investors/api";
import { forecastApi } from "../../forecasting/api";
import { financialRequest, loadDashboardReport, type DashboardSetup, type FinancialReport } from "../../accounting/dashboard-model";
import { rentalRows, useRentalReport } from "../../workspaces/rental-reports";
import { lastDayOfMonth, monthKey, type DashboardData, type Row } from "./dashboard-kit";

const projectsApi = createProjectsApi();
const SLOW = { staleTime: 10 * 60_000, gcTime: 30 * 60_000, retry: false, refetchOnWindowFocus: false } as const;
const MEDIUM = { staleTime: 120_000, gcTime: 600_000, retry: false, refetchOnWindowFocus: false } as const;

/* ---------- company ---------- */

/** Same request and cache key as the company pages (workspaces/page.tsx), without their styles. */
function useCompanyContext(identity: string) {
  return useQuery({
    queryKey: ["rent-ops-workspace", "company-context", identity],
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request("/api/company/context", { signal });
      if (!response.ok) throw new Error("Company records could not be loaded.");
      return response.json();
    },
    staleTime: 30_000,
    retry: false,
  });
}

function selectOrganization(organizations: readonly CompanyContextOrganization[], organizationId?: string): CompanyContextOrganization | undefined {
  return organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
}

export function useDashboardOrganization(data: DashboardData): { organization?: CompanyContextOrganization; loading: boolean; error: unknown; noAccess: boolean } {
  const context = useCompanyContext(data.identity);
  const organizations = context.data?.organizations ?? [];
  const organization = context.data ? selectOrganization(organizations, data.organizationId) ?? (data.organizationId ? undefined : organizations[0]) : undefined;
  return { organization, loading: context.isLoading, error: context.error, noAccess: !!context.data && !organization };
}

/** Same key as the dashboard's company rows, so they share one request. */
export function useCompanyDashboard(data: DashboardData) {
  const { organization } = useDashboardOrganization(data);
  return useQuery({
    queryKey: ["rent-ops-workspace", "dashboard-company", data.identity, organization?.id ?? "", data.filters.asOfDate],
    queryFn: ({ signal }) => workspacesApi.dashboard(organization!.id, data.filters.asOfDate, signal),
    enabled: Boolean(organization), staleTime: 60_000, retry: false, refetchOnWindowFocus: true,
  });
}

/* ---------- projects ---------- */

export function useProjects(data: DashboardData) {
  const { organization } = useDashboardOrganization(data);
  const organizationId = organization?.id;
  return useQuery({
    queryKey: ["rent-ops-workspace", "dashboard-projects", data.identity, organizationId ?? ""],
    queryFn: async ({ signal }) => {
      const items: ProjectSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const result = await projectsApi.listProjects(organizationId!, { status: "all", ...(cursor ? { cursor } : {}) }, signal);
        items.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return items.filter(project => project.status !== "archived" && project.archivedAt === null);
    },
    enabled: Boolean(organizationId), ...MEDIUM,
  });
}

export const openProjects = (projects: readonly ProjectSummary[] | undefined) => projects?.filter(project => project.status === "active" || project.status === "planning" || project.status === "on_hold");

/** Full records (tasks, costs) for the open projects, capped so the dashboard stays light. */
export function useProjectDetails(data: DashboardData, projects: readonly ProjectSummary[] | undefined, limit = 12) {
  const { organization } = useDashboardOrganization(data);
  const chosen = (openProjects(projects) ?? []).slice(0, limit);
  const results = useQueries({ queries: chosen.map(project => ({
    queryKey: ["rent-ops-workspace", "dashboard-project", data.identity, organization?.id ?? "", project.id, project.recordRevision],
    queryFn: ({ signal }: { signal: AbortSignal }) => projectsApi.getProject(organization!.id, project.id, signal),
    enabled: Boolean(organization), ...MEDIUM,
  })) });
  const loading = !projects || results.some(result => result.isLoading);
  return { details: results.flatMap(result => result.data ? [result.data] : []), loading, failed: results.filter(result => result.error).length };
}

/** Whole-deal cost reports (sale forecast, profit) for flips. */
export function useDealReports(data: DashboardData, projects: readonly ProjectSummary[] | undefined, limit = 10) {
  const { organization } = useDashboardOrganization(data);
  const flips = (projects ?? []).filter(project => project.projectType === "flip" && project.status !== "archived").slice(0, limit);
  const results = useQueries({ queries: flips.map(project => ({
    queryKey: ["rent-ops-workspace", "dashboard-deal", data.identity, organization?.id ?? "", project.id, project.recordRevision, data.filters.asOfDate],
    queryFn: ({ signal }: { signal: AbortSignal }) => projectsApi.getDealCostReport!(organization!.id, project.id, { legalEntityId: project.legalEntityId, propertyId: project.propertyId }, signal),
    enabled: Boolean(organization), ...MEDIUM,
  })) });
  return { flips, reports: flips.map((project, index) => ({ project, report: results[index]?.data, error: results[index]?.error })), loading: !projects || results.some(result => result.isLoading) };
}

/* ---------- QuickBooks ---------- */

export function useQboHealth(data: DashboardData) {
  const { organization } = useDashboardOrganization(data);
  return useQuery({
    queryKey: ["rent-ops-workspace", "dashboard-qbo-health", data.identity, organization?.id ?? ""],
    queryFn: ({ signal }) => accountingApi.health(organization!.id, undefined, signal),
    enabled: Boolean(organization), staleTime: 60_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: false,
  });
}

export interface QboEntity { scope: AccountingScope; name: string; currency: string; health: ConnectorHealth }

/** One QuickBooks company per legal entity: production before sandbox, readable connections only. */
export function qboEntities(items: readonly ConnectorHealth[] | undefined, organization?: CompanyContextOrganization): QboEntity[] | undefined {
  if (!items) return undefined;
  const byEntity = new Map<string, ConnectorHealth>();
  for (const item of items) {
    if (item.connection.status !== "active" || !item.connection.readEnabled) continue;
    const current = byEntity.get(item.scope.legalEntityId);
    if (!current || (current.scope.environment === "sandbox" && item.scope.environment === "production")) byEntity.set(item.scope.legalEntityId, item);
  }
  return Array.from(byEntity.values()).map(health => ({
    scope: { organizationId: health.scope.organizationId, legalEntityId: health.scope.legalEntityId, environment: health.scope.environment, realmId: health.scope.realmId },
    name: health.legalEntityName || health.companyName || "Entity",
    currency: organization?.entities.find(entity => entity.id === health.scope.legalEntityId)?.currency ?? "USD",
    health,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export function useQboEntities(data: DashboardData) {
  const { organization } = useDashboardOrganization(data);
  const health = useQboHealth(data);
  return { organization, health, entities: qboEntities(health.data?.items, organization) };
}

export const ytdSetup = (asOfDate: string): DashboardSetup => ({ from: `${asOfDate.slice(0, 4)}-01-01`, through: asOfDate, basis: "cash" });

/** QuickBooks native reports per connected entity (same cache key as Accounting › Dashboard). */
export function useFinancialReports(data: DashboardData, reportId: FinancialReport, setup: DashboardSetup = ytdSetup(data.filters.asOfDate)) {
  const { organization, entities, health } = useQboEntities(data);
  const results = useQueries({ queries: (entities ?? []).map(entity => ({
    queryKey: ["accounting", "financial-dashboard", organization?.id ?? "", entity.scope.legalEntityId, entity.currency, reportId, setup],
    queryFn: ({ signal }: { signal: AbortSignal }) => loadDashboardReport(reportingApi, financialRequest(organization!.id, entity.scope.legalEntityId, entity.currency, reportId, setup), signal),
    enabled: Boolean(organization), ...SLOW,
  })) });
  return {
    entities, health, setup,
    rows: (entities ?? []).map((entity, index) => ({ entity, report: results[index]?.data, error: results[index]?.error, loading: !!results[index]?.isLoading })),
    loading: health.isLoading || results.some(result => result.isLoading),
    retry: () => { void health.refetch(); results.forEach(result => { if (result.error) void result.refetch(); }); },
  };
}

export const previousMonth = (asOfDate: string) => monthKey(asOfDate, -1);

export function useCloseChecklists(data: DashboardData, month = previousMonth(data.filters.asOfDate)) {
  const { organization, entities, health } = useQboEntities(data);
  const period = { periodStart: `${month}-01`, periodEnd: lastDayOfMonth(month) };
  const results = useQueries({ queries: (entities ?? []).map(entity => ({
    queryKey: ["rent-ops-workspace", "dashboard-close", organization?.id ?? "", entity.scope.legalEntityId, period.periodStart],
    queryFn: ({ signal }: { signal: AbortSignal }) => accountingApi.closeChecklist(organization!.id, entity.scope.legalEntityId, period, signal),
    enabled: Boolean(organization), ...MEDIUM,
  })) });
  return { month, entities, health, rows: (entities ?? []).map((entity, index) => ({ entity, checklist: results[index]?.data, error: results[index]?.error })), loading: health.isLoading || results.some(result => result.isLoading) };
}

export function usePayables(data: DashboardData, kind: "bills" | "payments") {
  const { organization, entities, health } = useQboEntities(data);
  const results = useQueries({ queries: (entities ?? []).map(entity => ({
    queryKey: ["rent-ops-workspace", "dashboard-payables", organization?.id ?? "", entity.scope.legalEntityId, entity.scope.environment, entity.scope.realmId, kind],
    queryFn: ({ signal }: { signal: AbortSignal }) => accountingApi.payables(organization!.id, entity.scope, kind, undefined, signal),
    enabled: Boolean(organization), ...MEDIUM,
  })) });
  return {
    entities, health,
    items: (entities ?? []).flatMap((entity, index) => (results[index]?.data?.items ?? []).map(item => ({ ...item, entityName: entity.name }))),
    incomplete: results.some(result => result.data && result.data.coverage.status !== "complete") || results.some(result => result.error),
    loading: health.isLoading || results.some(result => result.isLoading),
  };
}

export function useMirrors(data: DashboardData, kind: AccountingMirrorKind) {
  const { organization, entities, health } = useQboEntities(data);
  const results = useQueries({ queries: (entities ?? []).map(entity => ({
    queryKey: ["rent-ops-workspace", "dashboard-mirrors", organization?.id ?? "", entity.scope.legalEntityId, entity.scope.environment, entity.scope.realmId, kind],
    queryFn: ({ signal }: { signal: AbortSignal }) => accountingApi.listMirrors(organization!.id, entity.scope, kind, signal),
    enabled: Boolean(organization), ...SLOW,
  })) });
  return {
    entities, health,
    rows: (entities ?? []).map((entity, index) => ({ entity, mirrors: results[index]?.data, error: results[index]?.error })),
    loading: health.isLoading || results.some(result => result.isLoading),
  };
}

export function useQboTransactions(data: DashboardData) {
  const { organization, entities, health } = useQboEntities(data);
  const results = useQueries({ queries: (entities ?? []).map(entity => ({
    queryKey: ["rent-ops-workspace", "dashboard-qbo-transactions", organization?.id ?? "", entity.scope.legalEntityId, entity.scope.environment, entity.scope.realmId],
    queryFn: ({ signal }: { signal: AbortSignal }) => accountingApi.listTransactions(organization!.id, entity.scope, signal),
    enabled: Boolean(organization), ...MEDIUM,
  })) });
  return {
    entities, health,
    items: (entities ?? []).flatMap((entity, index) => (results[index]?.data?.items ?? []).map(item => ({ ...item, entityName: entity.name }))),
    incomplete: results.some(result => result.data && result.data.coverage.status !== "complete") || results.some(result => result.error),
    loading: health.isLoading || results.some(result => result.isLoading),
  };
}

export function usePmSettlements(data: DashboardData) {
  const { organization } = useDashboardOrganization(data);
  const entities = organization?.entities ?? [];
  const results = useQueries({ queries: entities.map(entity => ({
    queryKey: ["rent-ops-workspace", "dashboard-pm-settlements", organization?.id ?? "", entity.id],
    queryFn: ({ signal }: { signal: AbortSignal }) => accountingApi.pmSettlements(organization!.id, { legalEntityId: entity.id }, signal),
    enabled: Boolean(organization), ...MEDIUM,
  })) });
  return {
    organization,
    items: entities.flatMap((entity, index) => (results[index]?.data?.items ?? []).map(item => ({ ...item, entityName: entity.name }))),
    failed: results.filter(result => result.error).length,
    loading: !organization || results.some(result => result.isLoading),
  };
}

/* ---------- debt and investors ---------- */

export function useDebtMaturities(data: DashboardData) {
  const { organization } = useDashboardOrganization(data);
  return useQuery({
    queryKey: ["rent-ops-workspace", "dashboard-debt", data.identity, organization?.id ?? ""],
    queryFn: ({ signal }) => investorsApi.getDebtMaturities!(organization!.id, {}, signal),
    enabled: Boolean(organization && investorsApi.getDebtMaturities), ...MEDIUM,
  });
}

export function usePaymentCalendar(data: DashboardData, months = 3) {
  const { organization } = useDashboardOrganization(data);
  const entities = organization?.entities ?? [];
  // The calendar takes the first day of each month (YYYY-MM-01).
  const fromMonth = `${data.filters.asOfDate.slice(0, 7)}-01`, throughMonth = `${monthKey(data.filters.asOfDate, months - 1)}-01`;
  const results = useQueries({ queries: entities.map(entity => ({
    queryKey: ["rent-ops-workspace", "dashboard-payment-calendar", organization?.id ?? "", entity.id, fromMonth, throughMonth],
    queryFn: ({ signal }: { signal: AbortSignal }) => investorsApi.getPaymentCalendar!(organization!.id, { legalEntityId: entity.id, fromMonth, throughMonth }, signal),
    enabled: Boolean(organization && investorsApi.getPaymentCalendar), ...MEDIUM,
  })) });
  return {
    organization,
    items: entities.flatMap((entity, index) => (results[index]?.data?.items ?? []).map(item => ({ ...item, entityName: entity.name }))).sort((a, b) => a.dueOn.localeCompare(b.dueOn)),
    failed: results.filter(result => result.error).length,
    loading: !organization || results.some(result => result.isLoading),
  };
}

/* ---------- forecast ---------- */

/** The approved base scenario (or the newest usable one), run at its current assumptions. */
export function useForecast(data: DashboardData) {
  const { organization } = useDashboardOrganization(data);
  const organizationId = organization?.id ?? "";
  const list = useQuery({ queryKey: ["forecasting", "list", organizationId], queryFn: ({ signal }) => forecastApi.list(organizationId, signal), enabled: Boolean(organization), staleTime: 60_000, retry: false, refetchOnWindowFocus: false });
  const usable = (list.data?.items ?? []).filter(item => item.state !== "archived" && item.currentAssumptionVersion > 0);
  const scenario = usable.find(item => item.state === "approved" && item.kind === "base") ?? usable.find(item => item.state === "approved") ?? usable.find(item => item.kind === "base") ?? usable[0];
  const run = useQuery({
    queryKey: ["rent-ops-workspace", "dashboard-forecast", organizationId, scenario?.id ?? "", scenario?.currentAssumptionVersion ?? 0],
    queryFn: ({ signal }) => forecastApi.preview(organizationId, scenario!.id, { assumptionVersion: scenario!.currentAssumptionVersion }, signal),
    enabled: Boolean(organization && scenario), ...SLOW,
  });
  return { organization, list, scenario, run, result: run.data?.result, loading: list.isLoading || (Boolean(scenario) && run.isLoading), none: !!list.data && !scenario };
}

/* ---------- rental reports the base dashboard does not load ---------- */

export function useExtraRentalRows(data: DashboardData, key: ReportKey, keys: readonly string[], period?: { month?: string }) {
  const query = useRentalReport(data.identity, key, data.filters, { asOfDate: data.filters.asOfDate, ...(period?.month ? { month: period.month } : {}) });
  const rows: Row[] | undefined = rentalRows(query.data, data.snapshot, keys);
  return { rows, error: query.error, loading: query.isLoading, retry: () => void query.refetch() };
}
