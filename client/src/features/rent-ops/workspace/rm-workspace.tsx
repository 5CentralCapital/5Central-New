import { ReportLibrary } from './report-library';
import { ProjectEntry } from '../../company/project-entry';
import { InvestorEntry } from '../../company/investor-entry';
import { TimeEntry } from '../../time/entry';
import { WorkOrderEntry } from '../../work-orders/entry';
import { ReportingEntry } from '../../reporting/entry';
import type { ProjectTab } from '../../projects/types';
import type { InvestorTab } from '../../investors/types';
import type { WorkOrderView } from '../../work-orders/types';
import { ManagerTenancyActions } from './manager-tenancy-actions';
import { useWorkspaceDate } from './use-workspace-date';
import { selectWorkspaceToday, pinWorkspaceDate } from './workspace-date';
import { useRecurringChargeTerms } from './use-recurring-charge-terms';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus, RefreshCw, Search, X } from 'lucide-react';
import { loadOperationalScheduleRegister, loadRentOpsPreviewContext, loadRentOpsWorkspaceBootstrap } from '../api';
import { rentOpsAuthClient } from '../auth';
import { RentOpsAdminLogin, RentOpsAuthLoading, useRentOpsAuth } from '../auth-ui';
import type { QuickAction, FormValues } from '../form-payload';
import { REPORT_KEYS, REPORT_LABELS, type AdminSnapshot, type ReportKey, type TenantTab, type ViewFilters } from '../types';
import { EntityLink, RecordLink, EntityNavigationContext } from './entity-link';
import { TenantRecord } from './tenant-record';
import { DEFAULT_TENANT_DIRECTORY_STATUS, tenantDirectoryFilters } from './tenant-directory-state';
import { scheduleDisplayInterval } from './schedule-display';
import { PropertyUnitRecords } from './property-unit-records';
import { ReportsWorkspace } from './reports-workspace';
import { DashboardWorkspace } from './dashboard-workspace';
import { DashboardCompanyPanels } from './dashboard-company';
import { ApplicationsWorkspace } from './applications-workspace';
import { WorkspaceEditor } from './editor';
import { DataGrid } from './grid';
import { exactCentsMetric } from './list-totals';
import { ListTotals } from './list-totals';
import { summarizeCurrentMonthlyCharges } from './list-totals-model';
import { formatMoney, formatLabel } from './display';
import { displayPersonName, formatLongDate } from '../../../lib/rent-ops-formatters';
import { RowMenu } from './ops-ui';
import { CHARGE_TYPE_MISSING_LABEL, PROPERTY_MISSING_LABEL, STATUS_UNVERIFIED_LABEL } from '@shared/review-cases/display-labels';
import { filterTenantDirectory, parseWorkspaceFilters, selectedWorkspaceProperties, workspacePropertyMatches, parseWorkspaceRoute, companyReportNavigation, workspaceApiFilters, workspaceCollectionsFor, workspaceFiltersForRecord, workspaceRouteSearch, type TenantDirectoryStatus, type WorkspaceRoute, type WorkspaceSection } from './workspace-state';
import { recurringRegisterQueryKey, recurringRegisterViews, selectRecurringRegisterRows, type RecurringRegisterView } from './recurring-register-model';
import { clearSignedOutQueries, useWorkspaceData } from './use-workspace-data';
import '../rent-ops.css';
import './workspace.css';
import './workspace-modern.css';
import './dashboard-modern.css';
import '../../../styles/ops-tokens.css';
import '../../../styles/rops-system.css';
import { TopNavigation, useWorkspaceAppearance } from './top-navigation';
import { ScopeBar } from './scope-bar';
import { destinationRoute, workspaceDocumentTitle, workspacePageTitle, type WorkspaceDestination } from './navigation';
import { WORKSPACE_VIEWS, investorTabForWorkspace, investorTabFromWorkspace, projectTabForWorkspace, projectTabFromWorkspace } from '../../workspaces/views';
import { AccountingEntryWithView, CompanyDocumentsEntry, ForecastingEntry, IntakeResultsEntry, ReviewQueueEntry } from '../../workspaces/lane-mounts';
import { PropertyPerformance } from '../../workspaces/property-performance';
import { PropertyDocumentsPage } from '../../workspaces/property-documents';
import { Collections } from '../../workspaces/collections';
import { LeasesRenewals } from '../../workspaces/leases-renewals';
import { ListingsPage, MakeReadyPage, MovesPage } from '../../workspaces/unit-pages';
import { EntitiesPage, PeoplePage, SettingsPage } from '../../workspaces/company-pages';
import { CostLibrary } from '../../workspaces/cost-library';
import { ReportPackages, SavedReports } from '../../workspaces/report-collections';

const tenantStatuses=[['current','Current'],['all','All tenants'],['future','Future'],['former','Former'],['contact','Account contacts'],['unknown',STATUS_UNVERIFIED_LABEL]];
const applicationStatuses=[['all','All applications'],['submitted','Submitted'],['missing_information','Missing information'],['under_review','Under review'],['approved','Approved'],['declined','Declined'],['withdrawn','Withdrawn'],['converted','Converted']];
function Busy({label='Loading records…'}:{label?:string}){return <div className="rm-empty" role="status"><RefreshCw size={18} className="spin"/><span>{label}</span></div>;}
function ErrorNotice({error,retry}:{error:unknown;retry?:()=>void}){return <div className="rm-error" role="alert"><span>{error instanceof Error?error.message:'Records could not be loaded.'}</span>{retry&&<button className="rm-button" onClick={retry}>Try again</button>}</div>;}
function routeKey(route:WorkspaceRoute){return [route.section,route.organizationId??'',route.kind??'',route.recordId??'',route.section==='reports'?route.report:'',route.projectTab??'',route.investorTab??'',route.workOrderView??'',route.accountingView??''].join(':');}
function scopeProperties(snapshot:AdminSnapshot,filters:ViewFilters){return snapshot.snapshot.properties.filter(p=>filters.propertyScope==='all'||p.state==='active');}
/** Dates from charge terms arrive as ISO strings or as status words ("Unverified", "Month to month"). */
function termDate(value:string){return formatLongDate(value)??value;}
/** Short charge codes such as "RC" read as their category ("Rent"); real names are kept. */
const CHARGE_CATEGORY_LABELS:Record<string,string>={base_rent:'Rent',rent:'Rent',pet_rent:'Pet rent',parking:'Parking',utility:'Utilities',utilities:'Utilities',late_fee:'Late fee',hap:'Housing assistance',subsidy:'Housing assistance'};
function chargeDisplayName(name:string|null|undefined,category:string|null|undefined){const text=(name??'').trim();if(!text)return category?CHARGE_CATEGORY_LABELS[category]??formatLabel(category):CHARGE_TYPE_MISSING_LABEL;if(/^[A-Z]{1,4}$/.test(text)&&category)return CHARGE_CATEGORY_LABELS[category]??formatLabel(category);return text;}

function RecurringRegister({snapshot,filters,onEdit}:{snapshot:AdminSnapshot;filters:ViewFilters;onEdit:(action:QuickAction,values?:FormValues)=>void}){
 const [state,setState]=useState<RecurringRegisterView>(()=>{const saved=new URLSearchParams(window.location.search).get('recurringView');return recurringRegisterViews.some(([value])=>value===saved)?saved as RecurringRegisterView:'current';});
 const changeView=(view:RecurringRegisterView)=>{setState(view);const params=new URLSearchParams(window.location.search);params.set('recurringView',view);window.history.replaceState(window.history.state,'',`${window.location.pathname}?${params}`);};
 const auth=useRentOpsAuth();
 const metadata=useQuery({queryKey:recurringRegisterQueryKey(auth.user?.id??'',filters.propertyScope,selectedWorkspaceProperties(filters).join(','),filters.asOfDate),queryFn:({signal})=>loadOperationalScheduleRegister(workspaceApiFilters(filters),signal),enabled:auth.status==='authenticated'&&!!filters.asOfDate,staleTime:60_000,gcTime:300_000,retry:false});
 const chargeTerms=useRecurringChargeTerms(snapshot.snapshot.recurringSchedules.filter(row=>workspacePropertyMatches(filters,row.propertyId??undefined)).map(row=>row.id),filters.asOfDate);
 if(metadata.error)return <ErrorNotice error={metadata.error} retry={()=>void metadata.refetch()}/>;
 if(!metadata.data||metadata.data.asOfDate!==filters.asOfDate)return <Busy label="Loading current charge classifications…"/>;
 const properties=new Map(snapshot.snapshot.properties.map(p=>[p.id,p]));
 const units=new Map(snapshot.snapshot.units.map(u=>[u.id,u]));
 const people=new Map(snapshot.snapshot.people.map(p=>[p.id,p]));
 const definitions=new Map(snapshot.chargeDefinitions.map(d=>[d.id,d]));
 const scoped=snapshot.snapshot.recurringSchedules.filter(row=>workspacePropertyMatches(filters,row.propertyId??undefined)).filter(row=>filters.propertyScope==='all'||properties.get(row.propertyId??undefined)?.state==='active');
 const rows=selectRecurringRegisterRows(scoped,metadata.data,state).map(row=>{
  const person=people.get(row.personId??undefined);const definition=definitions.get(row.chargeDefinitionId??undefined);
  const display=scheduleDisplayInterval(row,filters.asOfDate);
  return {...row,displayEnd:display.effectiveTo,propertyName:properties.get(row.propertyId??undefined)?.name??PROPERTY_MISSING_LABEL,unitName:units.get(row.unitId??undefined)?.unitNumber??'—',tenantName:person?`${person.firstName??''} ${person.lastName??''}`.trim():'—',chargeName:chargeDisplayName(definition?.displayName??row.description,definition?.category),chargeCode:definition?.displayName??row.description??''};
 });
 return <section className="rm-panel"><div className="rm-toolbar"><label>Show<select value={state} onChange={e=>changeView(e.target.value as RecurringRegisterView)}>{recurringRegisterViews.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button className="rm-button rm-button-primary" onClick={()=>onEdit('save-recurring-schedule',{...(filters.propertyId!=='all'?{propertyId:filters.propertyId}:{})})}><Plus size={14}/>Add recurring charge</button></div>
 {!metadata.data.complete&&<p role="status">Some schedules are unconfirmed. Current charges include only confirmed schedules.</p>}
 <DataGrid rows={rows} search={filters.search} getRowKey={(row,index)=>row.id??String(index)} pageSize={25} emptyMessage="No recurring charges match these filters." summaryLabel="recurring charge" getFooterMetrics={state === 'current' ? (visibleRows) => { const summary = summarizeCurrentMonthlyCharges(visibleRows); return summary ? [exactCentsMetric('Current monthly tenant/unit charges', summary)] : []; } : undefined} columns={[
 {key:'propertyName',label:'Property',render:r=><RecordLink kind="property" recordId={r.propertyId}>{r.propertyName}</RecordLink>},{key:'unitName',label:'Unit',render:r=><RecordLink kind="unit" recordId={r.unitId}>{r.unitName}</RecordLink>},{key:'tenantName',label:'Tenant',render:r=><EntityLink personId={r.personId} tab="charges">{displayPersonName(r.tenantName)||'—'}</EntityLink>},
 {key:'chargeName',label:'Charge',render:r=><span className="rm-cell-stack"><EntityLink personId={r.personId} tab="charges"><span title={r.chargeCode!==r.chargeName?r.chargeCode:undefined}>{r.chargeName}</span></EntityLink><small>{r.billingFrequency?formatLabel(r.billingFrequency):'Frequency unverified'}{r.scopeType&&r.scopeType!=='tenancy'&&r.scopeType!=='tenant'?` · ${formatLabel(r.scopeType)}`:''}</small></span>},
 {key:'chargeStarts',label:'Term',render:r=>{const start=chargeTerms.label(r.id,'start',r.scopeType);const through=chargeTerms.label(r.id,'through',r.scopeType);const end=r.displayEnd?termDate(r.displayEnd):undefined;return <span className="rm-cell-stack"><span>{termDate(start)} → {termDate(through)}</span>{end&&<small>Ends {end}</small>}</span>;}},
 {key:'amountCents',label:'Amount',align:'right',render:r=><EntityLink personId={r.personId} tab="charges">{formatMoney(r.amountCents)}</EntityLink>},{key:'displayStatus',label:'Status'},
 {key:'actions',label:'',render:r=>r.canChange?<RowMenu label="Charge actions" items={[{label:'Schedule a change…',onSelect:()=>onEdit('replace-recurring-schedule',{predecessorId:r.id,expectedRevision:r.recordRevision??1,amountDollars:'',effectiveFrom:''})},{label:'End charge…',onSelect:()=>onEdit('end-recurring-schedule',{predecessorId:r.id,expectedRevision:r.recordRevision??1,effectiveFrom:''})}]}/>:null},
 ]}/></section>;
}

export default function RmWorkspace(){
 const auth=useRentOpsAuth();const client=useQueryClient();
 useEffect(()=>{const previous=document.title;return()=>{document.title=previous;};},[]);
 // Signed-in views title themselves per page (child effects run first, so only the signed-out state is set here).
 useEffect(()=>{if(auth.status!=='authenticated')document.title='5Central Ops';},[auth.status]);
 useEffect(()=>{if(auth.status==='unknown')void rentOpsAuthClient.initialize().catch(()=>undefined);},[auth.status]);
 useEffect(()=>{
  if(auth.status!=='authenticated')clearSignedOutQueries(client);
 },[auth.status,client]);
 if(auth.status==='unknown')return <RentOpsAuthLoading/>;
 if(auth.status==='unauthenticated')return <RentOpsAdminLogin message={auth.message}/>;
 return <AuthenticatedWorkspace key={auth.user?.id}/>;
}

function AuthenticatedWorkspace(){
 const auth=useRentOpsAuth();
 const identity=auth.user?.id??'';
 const [route,setRoute]=useState<WorkspaceRoute>(()=>parseWorkspaceRoute(window.location.search));
 const [filters,setFilters]=useState<ViewFilters>(()=>parseWorkspaceFilters(window.location.search));
 const calendarDay=useWorkspaceDate(setFilters);
 const [incomeHistoryNeeded,setIncomeHistoryNeeded]=useState(false);
 const [source,setSource]=useState<'live'|'synthetic'>('live');const [contextError,setContextError]=useState<unknown>();
 const [businessDate,setBusinessDate]=useState('');const [notice,setNotice]=useState('');
 const [manageMoves,setManageMoves]=useState<{personId?:string}>();
 const [editing,setEditing]=useState<{action:QuickAction;values:FormValues}>();
 const {transparency,changeTransparency}=useWorkspaceAppearance();
 const view=WORKSPACE_VIEWS[route.section];
 const tenantStatus:TenantDirectoryStatus=route.tenantStatus??DEFAULT_TENANT_DIRECTORY_STATUS;
 const scrollPositions=useRef(new Map<string,number>());
 const navigationRef=useRef(route);
 const filtersRef=useRef(filters);filtersRef.current=filters;
 const captureScroll=()=>({window:window.scrollY,panels:Array.from(document.querySelectorAll('.rm-main,.rm-record-list-items,.rm-property-unit-list-items')).map(node=>node.scrollTop)});
 const pendingScroll=useRef<ReturnType<typeof captureScroll>>();
 const needed=useMemo(()=>workspaceCollectionsFor(route.section,manageMoves?'save-tenancy':editing?.action,incomeHistoryNeeded),[route.section,editing?.action,incomeHistoryNeeded,manageMoves]);
 const data=useWorkspaceData({enabled:auth.status==='authenticated'&&view.snapshot,identity,filters,collections:needed,summaryNeeded:route.section==='dashboard',personId:route.section==='tenants'?route.recordId:undefined});
 const reportDirectoryQuery=useQuery({queryKey:['rent-ops-workspace','report-directory',identity,filters.asOfDate],queryFn:({signal})=>loadRentOpsWorkspaceBootstrap({propertyScope:'all',asOfDate:filters.asOfDate},signal),enabled:auth.status==='authenticated'&&['reports','rent-roll'].includes(route.section)&&!!filters.asOfDate,staleTime:60_000,gcTime:300_000,retry:false});
 const reportDirectory=reportDirectoryQuery.data?{properties:reportDirectoryQuery.data.snapshot.properties,units:reportDirectoryQuery.data.snapshot.units,people:reportDirectoryQuery.data.snapshot.people,tenancies:reportDirectoryQuery.data.snapshot.tenancies}:undefined;
 const snapshot=data.snapshot;
 useEffect(()=>{document.title=workspaceDocumentTitle(route);},[route]);
 const reconcileRecordScope=useCallback((next:WorkspaceRoute)=>{setFilters(current=>workspaceFiltersForRecord(next,data.bootstrap.data,current));},[data.bootstrap.data]);
 const go=useCallback((next:WorkspaceRoute,replace=false)=>{
  const previous=navigationRef.current;pendingScroll.current=undefined;
  scrollPositions.current.set(routeKey(previous),window.scrollY);
  window.history.replaceState({...window.history.state,scroll:captureScroll()},'',window.location.href);
  navigationRef.current=next;setRoute(next);
  window.history[replace?'replaceState':'pushState'](replace?window.history.state:{returnTo:window.location.href},'',`${window.location.pathname}${workspaceRouteSearch(next,filtersRef.current,window.location.search)}`);
 },[]);
 const activateRecord=useCallback((next:WorkspaceRoute,replace=false)=>{reconcileRecordScope(next);go(next,replace);},[go,reconcileRecordScope]);
 useEffect(()=>{if(data.bootstrap.data&&route.recordId)reconcileRecordScope(route);},[data.bootstrap.data,route,reconcileRecordScope]);
 useEffect(()=>{const listener=()=>{scrollPositions.current.set(routeKey(navigationRef.current),window.scrollY);const next=parseWorkspaceRoute(window.location.search);setFilters(parseWorkspaceFilters(window.location.search));pendingScroll.current=window.history.state?.scroll;navigationRef.current=next;setRoute(next);};window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);},[]);
 useEffect(()=>{window.history.replaceState(window.history.state,'',`${window.location.pathname}${workspaceRouteSearch(route,filters,window.location.search)}`);},[route,filters]);
 useEffect(()=>{
  const saved=pendingScroll.current;let frame=0;
  const restore=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{window.scrollTo({top:saved?.window??scrollPositions.current.get(routeKey(route))??0,behavior:'instant'});if(saved)document.querySelectorAll('.rm-main,.rm-record-list-items,.rm-property-unit-list-items').forEach((node,index)=>{node.scrollTop=saved.panels[index]??0;});});};
  restore();if(!saved)return()=>cancelAnimationFrame(frame);
  const observer=new MutationObserver(restore);const main=document.querySelector('.rm-body');if(main)observer.observe(main,{childList:true,subtree:true});
  const stop=()=>{observer.disconnect();pendingScroll.current=undefined;};
  window.addEventListener('wheel',stop,{once:true,passive:true});window.addEventListener('touchstart',stop,{once:true,passive:true});window.addEventListener('keydown',stop,{once:true});
  const timeout=window.setTimeout(stop,5000);
  return()=>{observer.disconnect();cancelAnimationFrame(frame);clearTimeout(timeout);window.removeEventListener('wheel',stop);window.removeEventListener('touchstart',stop);window.removeEventListener('keydown',stop);};
 },[route,data.bootstrap.data,data.tenant.data,data.collectionsReady]);
 useEffect(()=>{
  if(auth.status!=='authenticated')return;
  let active=true;setContextError(undefined);
  void loadRentOpsPreviewContext().then(context=>{if(!active)return;setSource(context.source);setBusinessDate(context.asOfDate);}).catch(error=>{if(active)setContextError(error);});
  return()=>{active=false;};
 },[auth.status,auth.user?.id,calendarDay]);
 const directory=useMemo(()=>data.bootstrap.data?filterTenantDirectory(data.bootstrap.data,tenantDirectoryFilters(filters,tenantStatus)):[],[data.bootstrap.data,filters,tenantStatus]);
 useEffect(()=>{if(route.section==='tenants'&&!route.recordId&&directory[0]?.person.id)go({...route,recordId:directory[0].person.id},true);},[route,directory,go]);
 function changeScope(changes:Partial<Pick<ViewFilters,'propertyScope'|'propertyId'|'propertyIds'>>){
  const nextFilters={...filters,...changes};setFilters(nextFilters);
  if(route.section==='tenants')go({...route,recordId:undefined},true);
  if(route.section==='properties'){
   const properties=snapshot?scopeProperties(snapshot,nextFilters).filter(property=>workspacePropertyMatches(nextFilters,property.id)):[];
   const ids=new Set(properties.map(property=>property.id));
   const recordId=route.kind==='unit'?snapshot?.snapshot.units.find(unit=>ids.has(unit.propertyId))?.id:properties[0]?.id;
   go({...route,recordId},true);
  }
 }
 function navigate(destination:WorkspaceDestination){
  const nextFilters={...filters,status:destination.report==='occupancy'?'vacant':'all',search:''};
  setFilters(nextFilters);filtersRef.current=nextFilters;
  const propertyIds=new Set(snapshot?scopeProperties(snapshot,filters).map(p=>p.id):[]);
  const firstId=destination.section==='properties'?(destination.kind==='unit'?snapshot?.snapshot.units.find(u=>propertyIds.has(u.propertyId)&&workspacePropertyMatches(filters,u.propertyId))?.id:snapshot?.snapshot.properties.find(p=>propertyIds.has(p.id)&&workspacePropertyMatches(filters,p.id))?.id):undefined;
  go(destinationRoute(destination,route,firstId));
 }
 const base={tab:'summary' as TenantTab,report:'rent-roll' as ReportKey};
 const openCompany=(section:WorkspaceSection,organizationId:string|undefined,extra:Partial<WorkspaceRoute>={})=>go({...base,section,...(organizationId?{organizationId}:{}),...extra});
 function openTenant(id:string,tab:TenantTab='summary'){activateRecord({section:'tenants',recordId:id,tab,report:'rent-roll'});}
 function openUnit(id:string){activateRecord({section:'properties',kind:'unit',recordId:id,tab:'summary',report:'rent-roll'});}
 function openProperty(id:string){activateRecord({section:'properties',kind:'property',recordId:id,tab:'summary',report:'rent-roll'});}
 const openReport=(report:ReportKey)=>go({...base,section:'reports',report});
 const openProject=(organizationId:string,projectId?:string)=>openCompany('projects',organizationId,{projectTab:'overview',...(projectId?{recordId:projectId}:{})});
 const openWorkOrder=(organizationId:string,workOrderId?:string)=>openCompany('work-orders',organizationId,{workOrderView:workOrderId?'all':'open',...(workOrderId?{recordId:workOrderId}:{})});
 const changeOrganization=(organizationId:string)=>go({...route,organizationId,recordId:undefined});
 const openEditor=(action:QuickAction,values:FormValues={})=>{setNotice('');setEditing({action,values});};
 const refresh=useCallback(async()=>{await data.refresh();},[data.refresh]);
 const refreshRequired=useCallback(async()=>{await data.refreshRequired();},[data.refreshRequired]);
 function finishEdit(message:string){
  const saved=editing;
  setEditing(undefined);
  setNotice(saved?.action==='post-ledger-transaction'&&saved.values.kind==='charge'?'Charge added.':message);
  if(saved&&route.section==='tenants'&&saved.values.personId===route.recordId){
   if(saved.action==='post-ledger-transaction')go({...route,tab:'ledger'},true);
   if(['save-recurring-schedule','replace-recurring-schedule','end-recurring-schedule'].includes(saved.action))go({...route,tab:'charges'},true);
  }
  void refresh();
 }
 const selectedReport=route.section==='rent-roll'?'rent-roll':route.report;
 const fullTenant=data.tenant.data&&snapshot?{...data.tenant.data,property:data.tenant.data.property??snapshot.snapshot.properties.find(p=>p.id===data.tenant.data?.tenancy?.propertyId),unit:data.tenant.data.unit??snapshot.snapshot.units.find(u=>u.id===data.tenant.data?.tenancy?.unitId)}:undefined;
 const statusOptions=view.status==='tenants'?tenantStatuses:applicationStatuses;
 const heading=route.section==='tenants'?'Tenants':route.section==='properties'?(route.kind==='unit'?'Units':'Properties'):route.section==='reports'?(route.report==='occupancy'?'Availability':route.report==='rent-roll'?'Rent roll':REPORT_LABELS[route.report]):workspacePageTitle(route);
 const canRecordMoves=source==='live'&&!!businessDate;
 const reportsView=()=>reportDirectoryQuery.isLoading?<Busy label="Loading report directory…"/>:reportDirectoryQuery.error?<ErrorNotice error={reportDirectoryQuery.error} retry={()=>void reportDirectoryQuery.refetch()}/>:reportDirectory&&snapshot?<ReportsWorkspace snapshot={snapshot} filters={filters} selected={selectedReport} directory={reportDirectory} allowAllScope onSelect={report=>openReport(report)} onOpenTenant={openTenant} onOpenUnit={openUnit} onOpenProperty={openProperty}/>:<Busy label="Loading report directory…"/>;
 const needsCollections=(render:()=>ReactNode)=>()=>data.collectionsReady?render():data.collectionError?null:<Busy/>;
 /** One renderer per canonical view; a missing section is a compile-time error. */
 const views:Record<WorkspaceSection,()=>ReactNode>={
  dashboard:()=><>{data.summary.error&&<ErrorNotice error={data.summary.error} retry={()=>void data.summary.refetch()}/>}{!data.summary.data?!data.summary.error&&<Busy label="Loading portfolio summary…"/>:<DashboardWorkspace onManageMoves={canRecordMoves?()=>setManageMoves({}):undefined} snapshot={snapshot!} filters={filters} previews={data.summary.data.reports} refreshing={data.summary.isFetching} onReport={openReport} onOpenTenant={openTenant} onOpenUnit={openUnit} onOpenProperty={openProperty}
   companyPanels={<DashboardCompanyPanels identity={identity} organizationId={route.organizationId} asOfDate={filters.asOfDate} targets={{
    onObligations:organizationId=>openCompany('investors',organizationId,{investorTab:'payments'}),
    onMaturities:organizationId=>openCompany('investors',organizationId,{investorTab:'debt'}),
    onReviewQueue:organizationId=>openCompany('review-queue',organizationId),
    onWorkSchedule:(organizationId,workOrderId)=>workOrderId?openWorkOrder(organizationId,workOrderId):openCompany('work-orders',organizationId,{workOrderView:'schedule'}),
    onForecasting:organizationId=>openCompany('forecasting',organizationId,{forecastTab:'cash'}),
   }}/>}/>}</>,
  properties:needsCollections(()=><PropertyUnitRecords readOnly={source!=='live'} snapshot={snapshot!} filters={filters} onSearchChange={search=>setFilters(current=>({...current,search}))} selectedPropertyId={route.kind==='property'?route.recordId:undefined} selectedUnitId={route.kind==='unit'?route.recordId:undefined} onSelect={(kind,id)=>go({...route,kind,recordId:id})} onEdit={openEditor}
   identity={identity} organizationId={route.organizationId} onOpenProject={openProject} onOpenWorkOrder={openWorkOrder} onOpenReport={openReport}/>),
  'property-performance':()=><PropertyPerformance identity={identity} filters={filters} organizationId={route.organizationId} onOpenReport={openReport}/>,
  'rent-roll':reportsView,
  reports:reportsView,
  'property-documents':needsCollections(()=><PropertyDocumentsPage identity={identity} snapshot={snapshot!} filters={filters} organizationId={route.organizationId} onEdit={openEditor} onChanged={()=>void refresh()}/>),
  tenants:()=><div className="rm-record-layout"><section className="rm-record-list"><div className="rm-toolbar"><strong>{directory.length} {tenantStatus==='all'?'tenants':tenantStatuses.find(([value])=>value===tenantStatus)?.[1].toLowerCase()??'tenants'}</strong>{source==='live'&&<button className="rm-button rm-button--icon rm-button--small" aria-label="Add tenant" title="Add tenant" onClick={()=>openEditor('save-person')}><Plus size={14}/></button>}</div><div className="rm-record-list-items">{directory.map(tenant=>{const id=tenant.person.id;const index=data.bootstrap.data?.tenantIndex.find(row=>row.person.id===id);return <EntityLink personId={id} tab={route.tab} onOpen={()=>go({...route,recordId:id})} key={id??`${tenant.person.firstName}:${tenant.person.lastName}`} className={`rm-record-list-item${route.recordId===id?' active':''}`} ><strong className="rm-record-list-item-title">{displayPersonName(tenant.person.lastName)}{tenant.person.lastName?', ':''}{displayPersonName(tenant.person.firstName)}</strong><span className="rm-record-list-item-meta">{tenant.property?.name??'Account contact'}{tenant.unit?.unitNumber?` · ${tenant.unit.unitNumber}`:''}</span>{(tenantStatus==='all'||(index?.category??'unknown')!==tenantStatus)&&<small className="rm-record-list-item-meta">{formatLabel(index?.category??'unknown')}</small>}</EntityLink>;})}{!directory.length&&<div className="rm-empty">No tenants match these filters.</div>}</div><ListTotals totalCount={directory.length} itemLabel="tenant" /></section><div className="rm-record-detail">{data.tenant.error?<ErrorNotice error={data.tenant.error} retry={()=>void data.tenant.refetch()}/>:fullTenant?<TenantRecord tenant={fullTenant} snapshot={snapshot!} tab={route.tab} onTab={(tab:TenantTab)=>go({...route,tab},true)} onEdit={openEditor} onChanged={refresh} onMoveRefresh={refreshRequired} businessDate={businessDate} readOnly={source!=='live'} onManageMoves={()=>setManageMoves({personId:fullTenant.person.id})}/>:<Busy label={route.recordId?'Loading tenant details…':'Select a tenant to open the record.'}/>}</div></div>,
  collections:()=><Collections identity={identity} snapshot={snapshot!} filters={filters} businessDate={businessDate} readOnly={source!=='live'} paymentContextLoading={incomeHistoryNeeded&&!data.collectionsReady} onRequestPaymentContext={()=>setIncomeHistoryNeeded(true)} onSaved={refresh} onEdit={action=>openEditor(action)} onOpenRecurring={()=>go({...base,section:'recurring'})}/>,
  leases:()=><LeasesRenewals identity={identity} snapshot={snapshot!} filters={filters}/>,
  moves:()=><MovesPage snapshot={snapshot!} filters={filters} canRecord={canRecordMoves} onRecordMove={personId=>setManageMoves({personId})}/>,
  applicants:needsCollections(()=><ApplicationsWorkspace snapshot={snapshot!} filters={filters} onChanged={()=>void refresh()} onEdit={openEditor}/>),
  recurring:needsCollections(()=><RecurringRegister snapshot={snapshot!} filters={filters} onEdit={openEditor}/>),
  'make-ready':()=><MakeReadyPage identity={identity} snapshot={snapshot!} filters={filters} organizationId={route.organizationId} readOnly={source!=='live'}/>,
  listings:()=><ListingsPage snapshot={snapshot!} filters={filters} readOnly={source!=='live'}/>,
  accounting:()=><AccountingEntryWithView identity={identity} organizationId={route.organizationId} view={route.accountingView??'overview'} onViewChange={accountingView=>go({...route,accountingView})} onNavigate={organizationId=>go({...route,organizationId})}/>,
  projects:()=><ProjectEntry identity={identity} organizationId={route.organizationId} projectId={route.recordId} projectTab={projectTabForWorkspace(route.projectTab??'overview') as ProjectTab} onTabChange={tab=>go({...route,projectTab:projectTabFromWorkspace(tab)})} onNavigate={(organizationId,recordId)=>go({...route,organizationId,recordId})}/>,
  'cost-library':()=><CostLibrary identity={identity} organizationId={route.organizationId} asOfDate={filters.asOfDate} onOrganization={changeOrganization} onOpenProject={openProject}/>,
  'work-orders':()=><WorkOrderEntry identity={identity} organizationId={route.organizationId} workOrderId={route.recordId} view={(route.workOrderView??'open') as WorkOrderView} onNavigate={(organizationId,recordId,replace)=>go({...route,organizationId,recordId},replace)} onViewChange={workOrderView=>go({...route,workOrderView,recordId:undefined})} onOpenProperty={openProperty} onOpenUnit={openUnit} onOpenTenant={id=>openTenant(id)}/>,
  investors:()=><InvestorEntry identity={identity} organizationId={route.organizationId} accountId={route.recordId} investorTab={investorTabForWorkspace(route.investorTab??'overview') as InvestorTab} onTabChange={tab=>go({...route,investorTab:investorTabFromWorkspace(tab)})} onNavigate={(organizationId,recordId)=>go({...route,organizationId,recordId})}/>,
  'report-library':()=><ReportLibrary identity={identity} organizationId={route.organizationId} onCompanyChange={organizationId=>go({...route,organizationId})} onOpen={report=>openReport(report)} onOpenCompany={(organizationId,reportId)=>go({...base,section:'company-reports',organizationId,reportId})}/>,
  'company-reports':()=><ReportingEntry identity={identity} organizationId={route.organizationId} reportId={route.reportId} presetId={route.presetId} onNavigate={(organizationId,reportId)=>go(companyReportNavigation(route,organizationId,reportId))} onOpenLegacy={report=>{if(REPORT_KEYS.includes(report as ReportKey))openReport(report as ReportKey);}}/>,
  'saved-reports':()=><SavedReports identity={identity} organizationId={route.organizationId} onOrganization={changeOrganization} onOpenReport={(organizationId,reportId,presetId)=>go({...base,section:'company-reports',organizationId,reportId,...(presetId?{presetId}:{})})} onOpenLibrary={()=>go({...base,section:'report-library',...(route.organizationId?{organizationId:route.organizationId}:{})})}/>,
  'report-packages':()=><ReportPackages identity={identity} organizationId={route.organizationId} onOrganization={changeOrganization} onOpenReport={(organizationId,reportId)=>go({...base,section:'company-reports',organizationId,reportId})} onOpenLibrary={()=>go({...base,section:'report-library',...(route.organizationId?{organizationId:route.organizationId}:{})})}/>,
  forecasting:()=><ForecastingEntry identity={identity} organizationId={route.organizationId} scenarioId={route.scenarioId} legalEntityId={route.legalEntityId} propertyId={selectedWorkspaceProperties(filters).length===1?selectedWorkspaceProperties(filters)[0]:undefined} tab={route.forecastTab} onLocationChange={(patch,replace)=>go({...route,...patch} as WorkspaceRoute,replace)}/>,
  'review-queue':()=><ReviewQueueEntry identity={identity} organizationId={route.organizationId} onNavigate={changeOrganization}/>,
  entities:()=><EntitiesPage identity={identity} organizationId={route.organizationId} asOfDate={filters.asOfDate} onOrganization={changeOrganization} onOpenAccounting={organizationId=>openCompany('accounting',organizationId,{accountingView:'overview'})}/>,
  people:()=><PeoplePage identity={identity} organizationId={route.organizationId} asOfDate={filters.asOfDate} onOrganization={changeOrganization}/>,
  time:()=><TimeEntry identity={identity} organizationId={route.organizationId} onNavigate={organizationId=>go({...route,organizationId})}/>,
  'company-documents':()=><CompanyDocumentsEntry identity={identity} organizationId={route.organizationId} onNavigate={changeOrganization}/>,
  'mra-packets':()=><IntakeResultsEntry identity={identity} organizationId={route.organizationId} onNavigate={changeOrganization}/>,
  settings:()=><SettingsPage identity={identity} organizationId={route.organizationId} asOfDate={filters.asOfDate} onOrganization={changeOrganization} transparency={transparency} onTransparency={changeTransparency} onOpenAccounting={organizationId=>openCompany('accounting',organizationId,{accountingView:'overview'})} onOpenTime={organizationId=>openCompany('time',organizationId)}/>,
 };
 const body=!view.snapshot?views[route.section]():contextError?<ErrorNotice error={contextError}/>:data.bootstrap.error?<ErrorNotice error={data.bootstrap.error} retry={()=>void data.bootstrap.refetch()}/>:!snapshot?<Busy label="Loading the workspace directory…"/>:<>{data.collectionError&&<ErrorNotice error={data.collectionError} retry={()=>void refresh()}/>}{views[route.section]()}</>;
 return <EntityNavigationContext.Provider value={{onTenant:openTenant,onRecord:(kind,id)=>kind==='unit'?openUnit(id):openProperty(id)}}><div className="rm-workspace rops-modern" data-transparency={transparency}>
  <a className="rops-skip-link" href="#rops-content">Skip to content</a>
  <TopNavigation route={route} onNavigate={navigate} transparency={transparency} onTransparency={changeTransparency} source={source} accountLabel={auth.user?.email??auth.user?.id} onLogout={()=>void rentOpsAuthClient.logout()}/>
  <div className="rm-body">
  <main className="rm-main" id="rops-content" tabIndex={-1} aria-labelledby={view.heading?'rops-page-title':undefined}>
   {view.heading&&<header className={`rm-page-heading rm-workspace-heading${view.filters?' has-scope':''}`}>{route.recordId&&window.history.state?.returnTo&&<button className="rm-button rm-button--icon" aria-label="Back to previous view" title="Back" onClick={()=>window.history.back()}><ChevronLeft size={17}/></button>}<h1 id="rops-page-title">{heading}</h1>
    {view.filters&&<ScopeBar filters={filters} properties={snapshot?scopeProperties(snapshot,filters):[]} onScope={changeScope} onDate={date=>setFilters(f=>pinWorkspaceDate(f,date))} onToday={()=>setFilters(f=>selectWorkspaceToday(f))}
     status={view.status?{value:view.status==='tenants'?tenantStatus:filters.status,options:statusOptions,onChange:value=>{if(view.status==='tenants')go({...route,tenantStatus:value as TenantDirectoryStatus,recordId:undefined},true);else setFilters(f=>({...f,status:value}));}}:undefined}
     searchPlaceholder={route.section==='tenants'?'Name, property, unit, email or phone':'Search tenants, units, properties'} onSearch={search=>setFilters(f=>({...f,search}))} onRefresh={()=>void refresh()} refreshing={data.isRefreshing} updatedAt={data.bootstrap.dataUpdatedAt||undefined}/>}
   </header>}
   {notice&&<div className="rm-notice" role="status">{notice}<button className="rm-button" aria-label="Dismiss notice" onClick={()=>setNotice('')}><X size={12}/></button></div>}
   {body}
  </main></div>
  {manageMoves&&source==='live'&&snapshot&&<div className="rm-dialog-backdrop"><section className="rm-dialog" role="dialog" aria-modal="true" aria-label="Move-in and move-out">{data.collectionsReady?<ManagerTenancyActions snapshot={snapshot} businessDate={businessDate} personId={manageMoves.personId} propertyId={filters.propertyId} onSaved={refreshRequired} onClose={()=>setManageMoves(undefined)}/>:<><Busy label="Loading tenancy records…"/>{data.collectionError&&<ErrorNotice error={data.collectionError} retry={()=>void refresh()}/>}<button className="rm-button" onClick={()=>setManageMoves(undefined)}>Cancel</button></>}</section></div>}
  {editing&&snapshot&&(data.collectionsReady?<WorkspaceEditor action={editing.action} snapshot={snapshot} initialValues={editing.values} onClose={()=>setEditing(undefined)} onSaved={finishEdit} onConflict={()=>{setEditing(undefined);setNotice('This record changed. The latest values are being loaded; review them before saving again.');void refresh();}}/>:<div className="rm-dialog-backdrop"><section className="rm-dialog" role="dialog" aria-modal="true" aria-label="Loading editor"><Busy label="Loading related records…"/>{data.collectionError&&<ErrorNotice error={data.collectionError}/>}<button className="rm-button" onClick={()=>setEditing(undefined)}>Cancel</button></section></div>)}
 </div></EntityNavigationContext.Provider>;
}
