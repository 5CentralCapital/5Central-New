import { isWorkOrderView, type WorkOrderView } from '../../work-orders/types';
import { workspaceToday } from './workspace-date';
import type { AdminSnapshot, AdminSnapshotView, ApiFilters, DashboardSummary, ReportKey, TenantTab, TenantView, ViewFilters } from '../types';
import { REPORT_KEYS } from '../types';
import { createWorkspaceReportDefinition, type RentOpsWorkspaceBootstrap, type WorkspaceCollection } from '../api';
import type { QuickAction } from '../form-payload';

/**
 * Canonical manager views. Every value is rendered by rm-workspace; legacy
 * spellings (income, banking, documents, old project/investor tabs) are
 * accepted only through the alias table below and never serialized again.
 */
export const WORKSPACE_SECTIONS = [
  'dashboard',
  // Properties
  'properties', 'property-performance', 'rent-roll', 'property-documents',
  // Tenants
  'tenants', 'collections', 'leases', 'moves', 'applicants', 'recurring',
  // Units
  'make-ready', 'listings',
  // Accounting, projects, work, investors
  'accounting', 'projects', 'cost-library', 'work-orders', 'investors',
  // Reporting
  'reports', 'report-library', 'company-reports', 'saved-reports', 'report-packages', 'forecasting',
  // Company
  'review-queue', 'entities', 'people', 'time', 'company-documents', 'mra-packets', 'settings',
] as const;
export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number];

/** Project workspace tabs as named in navigation (Lane F owns the workspace). */
export const PROJECT_NAV_TABS = ['overview', 'schedule', 'budget', 'commitments', 'draws'] as const;
export type ProjectNavTab = (typeof PROJECT_NAV_TABS)[number];
export const INVESTOR_NAV_TABS = ['overview', 'payments', 'capital', 'debt', 'contracts', 'activity'] as const;
export type InvestorNavTab = (typeof INVESTOR_NAV_TABS)[number];
export const ACCOUNTING_VIEWS = ['overview', 'connections', 'transactions', 'bills', 'banking', 'pm-settlements', 'close'] as const;
export type AccountingView = (typeof ACCOUNTING_VIEWS)[number];
export const FORECAST_TABS = ['cash', 'income', 'balance', 'debt', 'scenarios', 'assumptions'] as const;
export type ForecastTab = (typeof FORECAST_TABS)[number];
export const TENANT_DIRECTORY_STATUSES = ['current', 'all', 'future', 'former', 'contact', 'unknown'] as const;
export type TenantDirectoryStatus = (typeof TENANT_DIRECTORY_STATUSES)[number];
/** The schedule is an agenda over the same work orders; other values are the existing list views. */
export type WorkOrderRouteView = WorkOrderView | 'schedule';

export interface WorkspaceRoute {
  section: WorkspaceSection;
  recordId?: string;
  organizationId?: string;
  projectTab?: ProjectNavTab;
  investorTab?: InvestorNavTab;
  workOrderView?: WorkOrderRouteView;
  accountingView?: AccountingView;
  tenantStatus?: TenantDirectoryStatus;
  forecastTab?: ForecastTab;
  scenarioId?: string;
  legalEntityId?: string;
  reportId?: string;
  /** Saved report setup to apply when opening Company reports. */
  presetId?: string;
  kind?: 'property' | 'unit';
  tab: TenantTab;
  report: ReportKey;
}

/** Old bookmarks keep working: each legacy value maps to exactly one canonical view. */
export const LEGACY_SECTION_ALIASES: Readonly<Record<string, Partial<WorkspaceRoute> & { section: WorkspaceSection }>> = Object.freeze({
  income: { section: 'collections' },
  banking: { section: 'accounting', accountingView: 'banking' },
  documents: { section: 'property-documents' },
});
export const LEGACY_PROJECT_TAB_ALIASES: Readonly<Record<string, ProjectNavTab>> = Object.freeze({ scope: 'budget', costs: 'budget', execution: 'commitments' });
/** Activity is its own investor tab (payment history), so no investor tab is aliased today. */
export const LEGACY_INVESTOR_TAB_ALIASES: Readonly<Record<string, InvestorNavTab>> = Object.freeze({});

/** Sections whose data is owned by a company (organization) rather than the rental snapshot. */
export const COMPANY_SECTIONS: readonly WorkspaceSection[] = [
  'dashboard', 'property-performance', 'property-documents', 'accounting', 'projects', 'cost-library', 'work-orders', 'investors',
  'report-library', 'company-reports', 'saved-reports', 'report-packages', 'forecasting',
  'review-queue', 'entities', 'people', 'time', 'company-documents', 'mra-packets', 'settings',
];
const tabs: TenantTab[] = ['summary','household','tenancy','charges','ledger','quickbooks','deposits','housing-assistance','documents','activity'];
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recordPattern = /^[A-Za-z0-9:_-]{1,160}$/;
const includes = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);

function canonicalSection(raw: string | null): Partial<WorkspaceRoute> & { section: WorkspaceSection } {
  if (raw && Object.hasOwn(LEGACY_SECTION_ALIASES, raw)) return LEGACY_SECTION_ALIASES[raw];
  return { section: includes(WORKSPACE_SECTIONS, raw) ? raw : 'dashboard' };
}

/**
 * Company reports navigating to another report or company. A saved setup
 * (?preset=) belongs to the report it was saved for, so it is dropped as soon
 * as the report or the company changes.
 */
export function companyReportNavigation(route: WorkspaceRoute, organizationId: string | undefined, reportId: string | undefined): WorkspaceRoute {
  const { presetId, ...rest } = route;
  const same = route.organizationId === organizationId && route.reportId === reportId;
  const next: WorkspaceRoute = { ...rest, organizationId, reportId };
  return same && presetId ? { ...next, presetId } : next;
}

export function parseWorkspaceRoute(search: string): WorkspaceRoute {
  const params = new URLSearchParams(search);
  const alias = canonicalSection(params.get('section'));
  const section = alias.section;
  const rawTab = params.get('tab');
  const report = params.get('report');
  const record = params.get('record');
  const organizationId = params.get('company');
  const reportId = params.get('reportId');
  const presetId = params.get('preset');
  const rawProjectTab = params.get('projectTab') ?? '';
  const projectTab = includes(PROJECT_NAV_TABS, rawProjectTab) ? rawProjectTab : Object.hasOwn(LEGACY_PROJECT_TAB_ALIASES, rawProjectTab) ? LEGACY_PROJECT_TAB_ALIASES[rawProjectTab] : undefined;
  const rawInvestorTab = params.get('investorTab') ?? '';
  const investorTab = includes(INVESTOR_NAV_TABS, rawInvestorTab) ? rawInvestorTab : Object.hasOwn(LEGACY_INVESTOR_TAB_ALIASES, rawInvestorTab) ? LEGACY_INVESTOR_TAB_ALIASES[rawInvestorTab] : undefined;
  const workOrderView = params.get('woView');
  const accountingView = params.get('acctView');
  const tenantStatus = params.get('tenantStatus');
  const scenarioId = params.get('scenario');
  const legalEntityId = params.get('entity');
  return {
    ...(section === 'company-reports' && reportId && /^[a-z][a-z0-9-]{1,119}$/.test(reportId) ? { reportId } : {}),
    ...(section === 'company-reports' && presetId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(presetId) ? { presetId } : {}),
    section,
    tab: section === 'tenants' && includes(tabs, rawTab) ? rawTab : 'summary',
    report: includes(REPORT_KEYS, report) ? report : 'rent-roll',
    recordId: record && recordPattern.test(record) ? record : undefined,
    ...(section === 'projects' && projectTab ? { projectTab } : {}),
    ...(section === 'investors' && investorTab ? { investorTab } : {}),
    ...(section === 'work-orders' && (workOrderView === 'schedule' || isWorkOrderView(workOrderView)) ? { workOrderView } : {}),
    ...(section === 'accounting' ? { accountingView: includes(ACCOUNTING_VIEWS, accountingView) ? accountingView : alias.accountingView ?? 'overview' } : {}),
    ...(section === 'tenants' && includes(TENANT_DIRECTORY_STATUSES, tenantStatus) ? { tenantStatus } : {}),
    ...(section === 'forecasting' && includes(FORECAST_TABS, rawTab) ? { forecastTab: rawTab } : {}),
    ...(section === 'forecasting' && scenarioId && recordPattern.test(scenarioId) ? { scenarioId } : {}),
    ...(section === 'forecasting' && legalEntityId && uuidPattern.test(legalEntityId) ? { legalEntityId } : {}),
    kind: params.get('kind') === 'unit' ? 'unit' : 'property',
    ...(COMPANY_SECTIONS.includes(section) && organizationId && uuidPattern.test(organizationId) ? { organizationId } : {}),
  };
}

const ROUTE_KEYS = ['section', 'record', 'kind', 'tab', 'report', 'company', 'projectTab', 'investorTab', 'woView', 'reportId', 'preset', 'acctView', 'tenantStatus', 'scenario', 'entity'];

export function workspaceRouteSearch(route: WorkspaceRoute, filters?: ViewFilters, baseSearch = ""): string {
  const params = new URLSearchParams(baseSearch);
  for (const key of ROUTE_KEYS) params.delete(key);
  // Record-local view state belongs only to the view that wrote it.
  if (route.section !== 'properties') params.delete('propertyTab');
  if (route.section !== 'recurring') params.delete('recurringView');
  params.set("section",route.section);
  if(route.recordId) params.set('record',route.recordId);
  if(COMPANY_SECTIONS.includes(route.section)&&route.organizationId) params.set('company',route.organizationId);
  if(route.section==='work-orders'&&route.workOrderView&&route.workOrderView!=='open') params.set('woView',route.workOrderView);
  if(route.section==='projects'&&route.projectTab) params.set('projectTab',route.projectTab);
  if(route.section==='investors'&&route.investorTab) params.set('investorTab',route.investorTab);
  if(route.section==='accounting') params.set('acctView',route.accountingView??'overview');
  if(route.section==='properties') params.set('kind',route.kind??'property');
  if(route.section==='tenants' && route.tab!=='summary') params.set('tab',route.tab);
  if(route.section==='tenants' && route.tenantStatus) params.set('tenantStatus',route.tenantStatus);
  if(route.section==='forecasting' && route.forecastTab) params.set('tab',route.forecastTab);
  if(route.section==='forecasting' && route.scenarioId) params.set('scenario',route.scenarioId);
  if(route.section==='forecasting' && route.legalEntityId) params.set('entity',route.legalEntityId);
  if(route.section==='reports') params.set('report',route.report);
  if(route.section==='company-reports'&&route.reportId) params.set('reportId',route.reportId);
  if(route.section==='company-reports'&&route.presetId) params.set('preset',route.presetId);
  if(filters) {
    params.set("scope",filters.propertyScope); params.delete("property");
    for(const id of selectedWorkspaceProperties(filters)) params.append("property",id);
    params.set("asOf",filters.asOfMode==='today'?'today':filters.asOfDate); params.set("status",filters.status); params.set("search",filters.search);
  }
  return `?${params.toString()}`;
}
export function selectedWorkspaceProperties(filters: Pick<ViewFilters,'propertyId'|'propertyIds'>): string[] {
  return filters.propertyIds?.length ? Array.from(new Set(filters.propertyIds)).sort() : filters.propertyId && filters.propertyId !== 'all' ? [filters.propertyId] : [];
}
export function workspacePropertyMatches(filters: Pick<ViewFilters,'propertyId'|'propertyIds'>, id?:string):boolean {
  const selected=selectedWorkspaceProperties(filters);return !selected.length || !!id&&selected.includes(id);
}
export function parseWorkspaceFilters(search:string, now=new Date()):ViewFilters {
  const params=new URLSearchParams(search); const propertyIds=Array.from(new Set(params.getAll('property').filter(id=>/^[A-Za-z0-9:_-]{1,160}$/.test(id))));
  const date=params.get('asOf');const rolling=!date||date==='today';
  return {propertyScope:params.get('scope')==='all'?'all':'active',propertyId:propertyIds.length===1?propertyIds[0]:'all',propertyIds,asOfDate:rolling?workspaceToday(now):date!,...(rolling?{asOfMode:'today' as const}:{}),status:params.get('status')??'all',search:params.get('search')??''};
}
export function workspaceApiFilters(filters: ViewFilters): ApiFilters {
  const propertyIds=selectedWorkspaceProperties(filters);
  return {propertyScope:filters.propertyScope, ...(propertyIds.length===1?{propertyId:propertyIds[0]}:propertyIds.length?{propertyIds}:{}), asOfDate:filters.asOfDate};
}
export function indexTenantViews(bootstrap: RentOpsWorkspaceBootstrap): TenantView[] {
  const source=bootstrap.snapshot;
  const people=new Map(source.people.map(p=>[p.id,p]));
  const tenancies=new Map(source.tenancies.map(t=>[t.id,t]));
  const units=new Map(source.units.map(u=>[u.id,u]));
  const properties=new Map(source.properties.map(p=>[p.id,p]));
  return bootstrap.tenantIndex.map(entry=>{
    const tenancy=entry.selectedTenancyId ? tenancies.get(entry.selectedTenancyId) : undefined;
    return {person:people.get(entry.person.id)??entry.person,tenancy,tenancies:entry.tenancyIds.flatMap(id=>tenancies.has(id)?[tenancies.get(id)!]:[]),property:properties.get(tenancy?.propertyId),unit:units.get(tenancy?.unitId),household:[],leaseTerms:[],schedules:[],ledger:[],deposits:[],subsidyContracts:[],documents:[],activity:[]};
  });
}
export function filterTenantDirectory(bootstrap: RentOpsWorkspaceBootstrap, filters: ViewFilters): TenantView[] {
  const categories=new Map(bootstrap.tenantIndex.map(entry=>[entry.person.id,entry.category??'unknown']));
  const query=filters.search.trim().toLocaleLowerCase();
  return indexTenantViews(bootstrap).filter(tenant=>{
    // The server scopes the navigation index, including account-only contacts.
    // Requiring a tenancy here would hide valid contacts from that scoped index.
    if(filters.propertyScope==='active' && !tenant.tenancies?.length && categories.get(tenant.person.id)!=='contact') return false;
    if(filters.status!=='all' && categories.get(tenant.person.id)!==filters.status) return false;
    if(!query)return true;
    return [tenant.person.firstName,tenant.person.lastName,tenant.person.email,tenant.person.phone,tenant.property?.name,tenant.unit?.unitNumber].some(v=>String(v??'').toLocaleLowerCase().includes(query)) || `${tenant.person.firstName??''} ${tenant.person.lastName??''}`.toLocaleLowerCase().includes(query);
  }).sort((a,b)=>`${a.person.lastName??''}, ${a.person.firstName??''}`.localeCompare(`${b.person.lastName??''}, ${b.person.firstName??''}`,undefined,{numeric:true,sensitivity:'base'}));
}

/** Required legacy-shaped adapter only. NaN counters cannot masquerade as confirmed zero; the dashboard is gated on a real summary. */
function unavailableSummary(bootstrap: RentOpsWorkspaceBootstrap, asOfDate:string):DashboardSummary {
  return {asOfDate,propertyCount:bootstrap.snapshot.properties.length,unitCount:bootstrap.snapshot.units.length,occupiedUnits:NaN,futurePreleasedUnits:NaN,genuineVacantUnits:NaN,readyVacantUnits:NaN,notReadyUnits:NaN,offMarketUnits:NaN,physicalOccupancyPercent:NaN,scheduledRentCents:NaN,collectedRentCents:NaN,rentOnlyDelinquencyCents:null,totalDelinquencyCents:null,unappliedCashCents:null,expiringIn30Days:NaN,expiringIn60Days:NaN,expiringIn90Days:NaN,monthToMonthCount:NaN,applicationsSubmitted:NaN,applicationsMissingInformation:NaN,securityDepositLiabilityCents:null,balanceComplete:false,scheduledRentComplete:false,drilldowns:{}};
}
export function composeWorkspaceSnapshot(bootstrap:RentOpsWorkspaceBootstrap,asOfDate:string,summary?:DashboardSummary,collections:Partial<AdminSnapshotView>={}):AdminSnapshot {
  const source={...bootstrap.snapshot,...collections};
  const reports=Object.fromEntries(REPORT_KEYS.map(key=>[key,createWorkspaceReportDefinition(key)])) as AdminSnapshot['reports'];
  return {generatedAt:bootstrap.generatedAt,snapshot:source,summary:summary??unavailableSummary(bootstrap,asOfDate),rentRoll:[],occupancy:[],scheduledIncome:[],collectedIncome:[],scheduledVsCollected:[],delinquency:[],ledger:[],leaseExpiration:[],depositLiability:[],hap:[],tenants:indexTenantViews(bootstrap),applicants:source.applications,documents:source.documents,activities:source.activityEvents,reports,chargeDefinitions:bootstrap.chargeDefinitions};
}
export function workspaceCollectionsFor(section:WorkspaceSection,editing?:QuickAction,includeIncomeHistory=true):WorkspaceCollection[] {
  const names:WorkspaceCollection[]=[];
  if(section==='properties'||section==='recurring')names.push('recurringSchedules');
  if(section==='collections'&&includeIncomeHistory)names.push('ledgerTransactions','paymentAllocations');
  if(section==='applicants')names.push('applications','applicationHouseholdMembers','applicationRequirements');
  if(section==='property-documents')names.push('documents','activityEvents');
  if(editing==='save-payment-allocation'||editing==='reverse-ledger-transaction')names.push('ledgerTransactions','paymentAllocations');
  if(editing==='save-tenancy')names.push('recurringSchedules','securityDeposits');
  if(editing==='save-security-deposit')names.push('securityDeposits');
  if(editing==='save-subsidy-contract')names.push('subsidyContracts');
  if(editing==='save-recurring-schedule'||editing==='replace-recurring-schedule'||editing==='end-recurring-schedule')names.push('recurringSchedules');
  if(editing==='convert-application')names.push('applications','applicationHouseholdMembers','applicationRequirements');
  return Array.from(new Set(names));
}

/** Scope membership uses the server navigation index, never display search/status filters. */
export function workspaceRecordInScope(route:WorkspaceRoute, bootstrap:RentOpsWorkspaceBootstrap|undefined, filters:ViewFilters):boolean {
  if(!route.recordId || (route.section!=='tenants' && route.section!=='properties')) return true;
  if(!bootstrap) return false;
  if(route.section==='tenants') return bootstrap.tenantIndex.some(entry=>entry.person.id===route.recordId);
  const propertyId=route.kind==='unit'
    ? bootstrap.snapshot.units.find(unit=>unit.id===route.recordId)?.propertyId
    : route.recordId;
  if(!propertyId) return false;
  const property=bootstrap.snapshot.properties.find(candidate=>candidate.id===propertyId);
  return !!property && (filters.propertyScope==='all' || property.state==='active')
    && workspacePropertyMatches(filters,property.id);
}

/** An explicit record activation can widen navigation scope without changing the reporting date. */
export function workspaceFiltersForRecord(route:WorkspaceRoute, bootstrap:RentOpsWorkspaceBootstrap|undefined, filters:ViewFilters):ViewFilters {
  if(workspaceRecordInScope(route,bootstrap,filters) || filters.propertyScope==='all' && !selectedWorkspaceProperties(filters).length) return filters;
  return {...filters,propertyScope:'all',propertyId:'all',...(filters.propertyIds?{propertyIds:[]}: {})};
}
