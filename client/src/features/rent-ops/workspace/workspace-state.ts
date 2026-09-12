import type { AdminSnapshot, AdminSnapshotView, ApiFilters, DashboardSummary, ReportKey, SectionKey, TenantTab, TenantView, ViewFilters } from '../types';
import { REPORT_KEYS } from '../types';
import { createWorkspaceReportDefinition, type RentOpsWorkspaceBootstrap, type WorkspaceCollection } from '../api';
import type { QuickAction } from '../form-payload';

export type WorkspaceSection = SectionKey | 'recurring';
export interface WorkspaceRoute { section: WorkspaceSection; recordId?: string; kind?: 'property' | 'unit'; tab: TenantTab; report: ReportKey; }
const sections: WorkspaceSection[] = ['dashboard','tenants','properties','reports','rent-roll','leases','income','applicants','documents','recurring'];
const tabs: TenantTab[] = ['summary','household','tenancy','charges','ledger','deposits','housing-assistance','documents','activity'];
export function parseWorkspaceRoute(search: string): WorkspaceRoute {
  const params = new URLSearchParams(search);
  const section = params.get('section') as WorkspaceSection;
  const tab = params.get('tab') as TenantTab;
  const report = params.get('report') as ReportKey;
  const record = params.get('record');
  return { section: sections.includes(section) ? section : 'dashboard', tab: tabs.includes(tab) ? tab : 'summary', report: REPORT_KEYS.includes(report) ? report : 'rent-roll', recordId: record && /^[A-Za-z0-9:_-]{1,160}$/.test(record) ? record : undefined, kind: params.get('kind') === 'unit' ? 'unit' : 'property' };
}
export function workspaceRouteSearch(route: WorkspaceRoute): string {
  const params = new URLSearchParams({section:route.section});
  if(route.recordId) params.set('record',route.recordId);
  if(route.section==='properties') params.set('kind',route.kind??'property');
  if(route.section==='tenants' && route.tab!=='summary') params.set('tab',route.tab);
  if(route.section==='reports') params.set('report',route.report);
  return `?${params.toString()}`;
}
export function workspaceApiFilters(filters: ViewFilters): ApiFilters {
  return {propertyScope:filters.propertyScope, ...(filters.propertyId==='all'?{}:{propertyId:filters.propertyId}), asOfDate:filters.asOfDate};
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
export function workspaceCollectionsFor(section:WorkspaceSection,editing?:QuickAction):WorkspaceCollection[] {
  const names:WorkspaceCollection[]=[];
  if(section==='properties'||section==='recurring')names.push('recurringSchedules');
  if(section==='income')names.push('ledgerTransactions','paymentAllocations');
  if(section==='applicants')names.push('applications','applicationHouseholdMembers','applicationRequirements');
  if(section==='documents')names.push('documents','activityEvents');
  if(editing==='save-payment-allocation'||editing==='reverse-ledger-transaction')names.push('ledgerTransactions','paymentAllocations');
  if(editing==='save-security-deposit')names.push('securityDeposits');
  if(editing==='save-subsidy-contract')names.push('subsidyContracts');
  if(editing==='save-recurring-schedule'||editing==='replace-recurring-schedule'||editing==='end-recurring-schedule')names.push('recurringSchedules');
  if(editing==='convert-application')names.push('applications','applicationHouseholdMembers','applicationRequirements');
  return Array.from(new Set(names));
}
