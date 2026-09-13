import { ManagerTenancyActions } from './manager-tenancy-actions';
import { useWorkspaceDate } from './use-workspace-date';
import { selectWorkspaceToday, pinWorkspaceDate } from './workspace-date';
import { useRecurringChargeTerms } from './use-recurring-charge-terms';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CalendarDays, ChevronLeft, FileText, Home, List, LogOut, Menu, Plus, RefreshCw, Search, Users, WalletCards, X } from 'lucide-react';
import { loadOperationalScheduleRegister, loadRentOpsPreviewContext } from '../api';
import { rentOpsAuthClient } from '../auth';
import { RentOpsAdminLogin, RentOpsAuthLoading, useRentOpsAuth } from '../auth-ui';
import { ManagerIncomeActions } from '../manager-income-actions';
import { RmBanking } from './rm-banking';
import { RecurringBillingPanel } from '../recurring-billing-panel';
import type { QuickAction, FormValues } from '../form-payload';
import { REPORT_LABELS, type AdminSnapshot, type ReportKey, type TenantTab, type ViewFilters } from '../types';
import { EntityLink, RecordLink, EntityNavigationContext } from './entity-link';
import { TenantRecord } from './tenant-record';
import { DEFAULT_TENANT_DIRECTORY_STATUS, tenantDirectoryFilters } from './tenant-directory-state';
import { scheduleDisplayInterval } from './schedule-display';
import { PropertyUnitRecords } from './property-unit-records';
import { ReportsWorkspace, WorkspaceReportPreload } from './reports-workspace';
import { isOccupancyReport, occupancyReportStatusOptions } from './report-model';
import { DashboardWorkspace } from './dashboard-workspace';
import { ApplicationsWorkspace } from './applications-workspace';
import { DocumentsWorkspace } from './documents-workspace';
import { WorkspaceEditor } from './editor';
import { DataGrid } from './grid';
import { formatMoney, formatLabel } from './display';
import { filterTenantDirectory, parseWorkspaceFilters, selectedWorkspaceProperties, workspacePropertyMatches, parseWorkspaceRoute, workspaceApiFilters, workspaceCollectionsFor, workspaceFiltersForRecord, workspaceRecordInScope, workspaceRouteSearch, type WorkspaceRoute, type WorkspaceSection } from './workspace-state';
import { recurringRegisterQueryKey, recurringRegisterViews, selectRecurringRegisterRows, type RecurringRegisterView } from './recurring-register-model';
import { useWorkspaceData } from './use-workspace-data';
import '../rent-ops.css';
import './workspace.css';

const destinations: Array<{section:WorkspaceSection;label:string;icon:typeof Home;group:string;kind?:'property'|'unit';report?:ReportKey}>=[
 {section:'dashboard',label:'Dashboard',icon:Home,group:'Home'},
 {section:'tenants',label:'Tenants',icon:Users,group:'Rental Info'},
 {section:'properties',label:'Properties',icon:Building2,group:'Rental Info',kind:'property'},
 {section:'properties',label:'Units',icon:List,group:'Rental Info',kind:'unit'},
 {section:'leases',label:'Leases',icon:CalendarDays,group:'Rental Info'},
 {section:'applicants',label:'Applications',icon:Users,group:'Rental Info'},
 {section:'recurring',label:'Recurring charges',icon:CalendarDays,group:'Receivables'},
 {section:'income',label:'Payments & billing',icon:WalletCards,group:'Receivables'},
 {section:'banking',label:'Banking',icon:WalletCards,group:'Accounting'},
 {section:'rent-roll',label:'Rent roll',icon:List,group:'Reports'},
 {section:'reports',label:'Vacancies',icon:Home,group:'Reports',report:'occupancy'},
 {section:'reports',label:'Balances due',icon:WalletCards,group:'Reports',report:'delinquency'},
 {section:'reports',label:'Reports',icon:FileText,group:'Reports'},
 {section:'documents',label:'Documents & activity',icon:FileText,group:'Records'},
];
const tenantStatuses=[['current','Current'],['all','All tenants'],['future','Future'],['former','Former'],['contact','Account contacts'],['unknown','Status needs review']];
const generalStatuses=[['all','All statuses'],['current','Current'],['future_preleased','Future preleased'],['vacant','Vacant'],['not_ready','Not ready'],['off_market','Off market']];
const applicationStatuses=[['all','All applications'],['submitted','Submitted'],['missing_information','Missing information'],['under_review','Under review'],['approved','Approved'],['declined','Declined'],['withdrawn','Withdrawn'],['converted','Converted']];
function Busy({label='Loading records…'}:{label?:string}){return <div className="rm-empty" role="status"><RefreshCw size={18} className="spin"/><span>{label}</span></div>;}
function ErrorNotice({error,retry}:{error:unknown;retry?:()=>void}){return <div className="rm-error" role="alert"><span>{error instanceof Error?error.message:'Records could not be loaded.'}</span>{retry&&<button className="rm-button" onClick={retry}>Try again</button>}</div>;}
function routeKey(route:WorkspaceRoute){return [route.section,route.kind??'',route.recordId??'',route.section==='reports'?route.report:''].join(':');}
function scopeProperties(snapshot:AdminSnapshot,filters:ViewFilters){return snapshot.snapshot.properties.filter(p=>filters.propertyScope==='all'||p.state==='active');}

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
  return {...row,displayEnd:display.effectiveTo,propertyName:properties.get(row.propertyId??undefined)?.name??'Property needs review',unitName:units.get(row.unitId??undefined)?.unitNumber??'—',tenantName:person?`${person.firstName??''} ${person.lastName??''}`.trim():'—',chargeName:definition?.displayName??row.description??'Charge type needs review'};
 });
 return <section className="rm-panel"><div className="rm-toolbar"><label>Show<select value={state} onChange={e=>changeView(e.target.value as RecurringRegisterView)}>{recurringRegisterViews.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button className="rm-button rm-button-primary" onClick={()=>onEdit('save-recurring-schedule',{...(filters.propertyId!=='all'?{propertyId:filters.propertyId}:{})})}><Plus size={14}/>Add recurring charge</button></div>
 {!metadata.data.complete&&<p role="status">Some schedules need review. Current charges include only confirmed schedules.</p>}
 <DataGrid rows={rows} search={filters.search} getRowKey={(row,index)=>row.id??String(index)} pageSize={25} emptyMessage="No recurring charges match these filters." columns={[
 {key:'propertyName',label:'Property',render:r=><RecordLink kind="property" recordId={r.propertyId}>{r.propertyName}</RecordLink>},{key:'unitName',label:'Unit',render:r=><RecordLink kind="unit" recordId={r.unitId}>{r.unitName}</RecordLink>},{key:'tenantName',label:'Tenant',render:r=><EntityLink personId={r.personId} tab="charges">{r.tenantName}</EntityLink>},{key:'chargeName',label:'Charge',render:r=><EntityLink personId={r.personId} tab="charges">{r.chargeName}</EntityLink>},
 {key:'scopeType',label:'Applies to',render:r=>formatLabel(r.scopeType)},{key:'billingFrequency',label:'Frequency',render:r=>r.billingFrequency?formatLabel(r.billingFrequency):'Unverified'},
 {key:'chargeStarts',label:'Charge starts',render:r=>chargeTerms.label(r.id,'start',r.scopeType)},{key:'leaseThrough',label:'Lease through',render:r=>chargeTerms.label(r.id,'through',r.scopeType)},{key:'scheduledEnd',label:'Scheduled end',render:r=>r.displayEnd??'—'},
 {key:'amountCents',label:'Amount',align:'right',render:r=><EntityLink personId={r.personId} tab="charges">{formatMoney(r.amountCents)}</EntityLink>},{key:'displayStatus',label:'Status'},
 {key:'actions',label:'Actions',render:r=>r.canChange?<div className="rm-actions"><button className="rm-button rm-button--small" onClick={()=>onEdit('replace-recurring-schedule',{predecessorId:r.id,expectedRevision:r.recordRevision??1,amountDollars:'',effectiveFrom:''})}>Schedule change</button><button className="rm-button rm-button--small" onClick={()=>onEdit('end-recurring-schedule',{predecessorId:r.id,expectedRevision:r.recordRevision??1,effectiveFrom:''})}>End</button></div>:'—'},
 ]}/></section>;
}

export default function RmWorkspace(){
 const auth=useRentOpsAuth();const client=useQueryClient();
 useEffect(()=>{const previous=document.title;document.title='5Central | Rent Operations';return()=>{document.title=previous;};},[]);
 useEffect(()=>{if(auth.status==='unknown')void rentOpsAuthClient.initialize().catch(()=>undefined);},[auth.status]);
 useEffect(()=>{
  if(auth.status!=='authenticated')client.removeQueries({queryKey:['rent-ops-workspace']});
 },[auth.status,client]);
 if(auth.status==='unknown')return <RentOpsAuthLoading/>;
 if(auth.status==='unauthenticated')return <RentOpsAdminLogin message={auth.message}/>;
 return <AuthenticatedWorkspace key={auth.user?.id}/>;
}

function AuthenticatedWorkspace(){
 const auth=useRentOpsAuth();const client=useQueryClient();
 const [route,setRoute]=useState<WorkspaceRoute>(()=>parseWorkspaceRoute(window.location.search));
 const [filters,setFilters]=useState<ViewFilters>(()=>parseWorkspaceFilters(window.location.search));
 const calendarDay=useWorkspaceDate(setFilters);
 const [tenantStatus,setTenantStatus]=useState(()=>new URLSearchParams(window.location.search).get('tenantStatus')??DEFAULT_TENANT_DIRECTORY_STATUS);
 const [incomeHistoryNeeded,setIncomeHistoryNeeded]=useState(false);
 const [source,setSource]=useState<'live'|'synthetic'>('live');const [contextError,setContextError]=useState<unknown>();
 const [businessDate,setBusinessDate]=useState('');const [notice,setNotice]=useState('');
 const [manageMoves,setManageMoves]=useState<{personId?:string}>();
 const [editing,setEditing]=useState<{action:QuickAction;values:FormValues}>();
 const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>window.matchMedia('(max-width: 768px)').matches);
 const [openRecords,setOpenRecords]=useState<WorkspaceRoute[]>([route]);
 const [recentRecords,setRecentRecords]=useState<WorkspaceRoute[]>([]);
 const scrollPositions=useRef(new Map<string,number>());
 const navigationRef=useRef(route);
 const filtersRef=useRef(filters);filtersRef.current=filters;
 const captureScroll=()=>({window:window.scrollY,panels:Array.from(document.querySelectorAll('.rm-main,.rm-record-list-items,.rm-property-unit-list-items')).map(node=>node.scrollTop)});
 const pendingScroll=useRef<ReturnType<typeof captureScroll>>();
 useEffect(()=>{const viewport=window.matchMedia('(max-width: 768px)');const change=(event:MediaQueryListEvent)=>setSidebarCollapsed(event.matches);viewport.addEventListener('change',change);return()=>viewport.removeEventListener('change',change);},[]);
 const needed=useMemo(()=>workspaceCollectionsFor(route.section,manageMoves?'save-tenancy':editing?.action,incomeHistoryNeeded),[route.section,editing?.action,incomeHistoryNeeded,manageMoves]);
 const data=useWorkspaceData({enabled:auth.status==='authenticated',identity:auth.user?.id??'',filters,collections:needed,summaryNeeded:route.section==='dashboard',personId:route.section==='tenants'?route.recordId:undefined});
 const snapshot=data.snapshot;
 const reconcileRecordScope=useCallback((next:WorkspaceRoute)=>{setFilters(current=>workspaceFiltersForRecord(next,data.bootstrap.data,current));},[data.bootstrap.data]);
 const go=useCallback((next:WorkspaceRoute,replace=false)=>{
  const previous=navigationRef.current;pendingScroll.current=undefined;
  if(window.matchMedia('(max-width: 768px)').matches)setSidebarCollapsed(true);
  scrollPositions.current.set(routeKey(previous),window.scrollY);
  window.history.replaceState({...window.history.state,scroll:captureScroll()},'',window.location.href);
  navigationRef.current=next;setRoute(next);
  window.history[replace?'replaceState':'pushState'](replace?window.history.state:{returnTo:window.location.href},'',`${window.location.pathname}${workspaceRouteSearch(next,filtersRef.current,window.location.search)}`);
  setOpenRecords(current=>{const key=routeKey(next);const base=replace&&previous.section===next.section&&!previous.recordId?current.filter(r=>routeKey(r)!==routeKey(previous)):current;const existing=base.findIndex(r=>routeKey(r)===key);return existing<0?[...base,next]:base.map((r,i)=>i===existing?next:r);});
  setRecentRecords(current=>[next,...current.filter(r=>routeKey(r)!==routeKey(next))].slice(0,12));
 },[]);
 const activateRecord=useCallback((next:WorkspaceRoute,replace=false)=>{reconcileRecordScope(next);go(next,replace);},[go,reconcileRecordScope]);
 useEffect(()=>{if(data.bootstrap.data&&route.recordId)reconcileRecordScope(route);},[data.bootstrap.data,route,reconcileRecordScope]);
 useEffect(()=>{const listener=()=>{scrollPositions.current.set(routeKey(navigationRef.current),window.scrollY);const next=parseWorkspaceRoute(window.location.search);setFilters(parseWorkspaceFilters(window.location.search));setTenantStatus(new URLSearchParams(window.location.search).get('tenantStatus')??DEFAULT_TENANT_DIRECTORY_STATUS);pendingScroll.current=window.history.state?.scroll;navigationRef.current=next;setRoute(next);setOpenRecords(current=>current.some(r=>routeKey(r)===routeKey(next))?current:[...current,next]);};window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);},[]);
 useEffect(()=>{const search=workspaceRouteSearch(route,filters,window.location.search);const params=new URLSearchParams(search);params.set('tenantStatus',tenantStatus);window.history.replaceState(window.history.state,'',`${window.location.pathname}?${params}`);},[route,filters,tenantStatus]);
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
  if(auth.status!=='authenticated'){if(auth.status==='unauthenticated'){client.removeQueries({queryKey:['rent-ops-workspace']});setOpenRecords([]);setRecentRecords([]);}return;}
  let active=true;setContextError(undefined);
  setOpenRecords(current=>current.length?current:[navigationRef.current]);
  void loadRentOpsPreviewContext().then(context=>{if(!active)return;setSource(context.source);setBusinessDate(context.asOfDate);}).catch(error=>{if(active)setContextError(error);});
  return()=>{active=false;};
 },[auth.status,auth.user?.id,client,calendarDay]);
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
 function navigate(section:WorkspaceSection,kind?:'property'|'unit',report?:ReportKey){
  if(report){setFilters(current=>({...current,status:report==='occupancy'?'vacant':'all',search:''}));go({section:'reports',report,tab:'summary'});return;}
  setFilters(current=>({...current,status:'all',search:''}));
  const existing=[...openRecords].reverse().find(r=>r.section===section&&(section!=='properties'||r.kind===kind)&&workspaceRecordInScope(r,data.bootstrap.data,filters)&&(section!=='tenants'||directory.some(tenant=>tenant.person.id===r.recordId)));
  const propertyIds=new Set(snapshot?scopeProperties(snapshot,filters).map(p=>p.id):[]);
  const firstId=section==='properties'?(kind==='unit'?snapshot?.snapshot.units.find(u=>propertyIds.has(u.propertyId)&&workspacePropertyMatches(filters,u.propertyId))?.id:snapshot?.snapshot.properties.find(p=>propertyIds.has(p.id)&&workspacePropertyMatches(filters,p.id))?.id):undefined;
  go(existing??{section,kind,recordId:firstId,tab:'summary',report:'rent-roll'});
 }
 function labelFor(record:WorkspaceRoute){
  if(record.section==='tenants'&&record.recordId){const person=snapshot?.snapshot.people.find(p=>p.id===record.recordId);return person?`${person.firstName??''} ${person.lastName??''}`.trim():'Tenant';}
  if(record.section==='properties'&&record.recordId){return record.kind==='unit'?`Unit ${snapshot?.snapshot.units.find(u=>u.id===record.recordId)?.unitNumber??''}`:`${snapshot?.snapshot.properties.find(p=>p.id===record.recordId)?.name??'Property'}`;}
  if(record.section==='reports')return record.report==='rent-roll'?'Rent roll':record.report==='occupancy'?'Vacancies':record.report==='delinquency'?'Balances due':REPORT_LABELS[record.report];
  return destinations.find(d=>d.section===record.section&&(record.section!=='properties'||d.kind===record.kind))?.label??'Workspace';
 }
 function openTenant(id:string,tab:TenantTab='summary'){activateRecord({section:'tenants',recordId:id,tab,report:'rent-roll'});}
 function openUnit(id:string){activateRecord({section:'properties',kind:'unit',recordId:id,tab:'summary',report:'rent-roll'});}
 function openProperty(id:string){activateRecord({section:'properties',kind:'property',recordId:id,tab:'summary',report:'rent-roll'});}
 const openEditor=(action:QuickAction,values:FormValues={})=>{setNotice('');setEditing({action,values});};
 const refresh=useCallback(async()=>{await data.refresh();},[data.refresh]);
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
 const selectedReport=route.section==='rent-roll'?'rent-roll':route.section==='leases'?'lease-expiration':route.report;
 const fullTenant=data.tenant.data&&snapshot?{...data.tenant.data,property:data.tenant.data.property??snapshot.snapshot.properties.find(p=>p.id===data.tenant.data?.tenancy?.propertyId),unit:data.tenant.data.unit??snapshot.snapshot.units.find(u=>u.id===data.tenant.data?.tenancy?.unitId)}:undefined;
 const occupancyStatus=['reports','rent-roll'].includes(route.section)&&isOccupancyReport(selectedReport);
 const statusOptions=route.section==='tenants'?tenantStatuses:route.section==='applicants'?applicationStatuses:occupancyStatus?occupancyReportStatusOptions:generalStatuses;
 const selectedStatus=route.section==='tenants'?tenantStatus:occupancyStatus&&!statusOptions.some(([value])=>value===filters.status)?'all':filters.status;
 return <EntityNavigationContext.Provider value={{onTenant:openTenant,onRecord:(kind,id)=>kind==='unit'?openUnit(id):openProperty(id)}}><main className={`rm-workspace${sidebarCollapsed?' is-sidebar-collapsed':''}`}>
  <header className="rm-ribbon"><div className="rm-nav-group"><button type="button" aria-label={sidebarCollapsed?'Show navigation':'Collapse navigation'} onClick={()=>setSidebarCollapsed(v=>!v)}><Menu size={17}/><strong>5CENTRAL</strong></button></div>
  {['Home','Rental Info','Receivables','Accounting','Reports','Records'].map(group=><nav key={group} className="rm-nav-group" aria-label={group}>{destinations.filter(d=>d.group===group).map(({section,label,icon:Icon,kind,report})=><button type="button" key={`${section}:${kind??''}:${report??''}`} aria-current={route.section===section&&(section!=='properties'||route.kind===kind)&&(report?route.report===report:section!=='reports'||!['occupancy','delinquency'].includes(route.report))?'page':undefined} onClick={()=>navigate(section,kind,report)}><Icon size={15}/>{label}</button>)}</nav>)}
  <div className="rm-ribbon-spacer"/><button className="rm-button" aria-label="Sign out" onClick={()=>void rentOpsAuthClient.logout()}><LogOut size={15}/></button></header>
  <div className="rm-open-tabs" aria-label="Open records">{openRecords.map(record=><div className={`rm-open-tab${routeKey(route)===routeKey(record)?' active':''}`} key={routeKey(record)}><button className="rm-open-tab-label" title={labelFor(record)} onClick={()=>activateRecord(record)} aria-current={routeKey(route)===routeKey(record)?'page':undefined}>{labelFor(record)}</button>{openRecords.length>1&&<button className="rm-open-tab-close" aria-label={`Close ${labelFor(record)}`} onClick={()=>{const remaining=openRecords.filter(r=>routeKey(r)!==routeKey(record));setOpenRecords(remaining);if(routeKey(route)===routeKey(record))activateRecord(remaining[remaining.length-1]);}}><X size={12}/></button>}</div>)}</div>
  <div className="rm-body"><aside className={`rm-sidebar${sidebarCollapsed?' is-collapsed':''}`}><div className="rm-sidebar-heading">Frequently used</div>{destinations.filter(d=>['tenants','properties','recurring','rent-roll','income'].includes(d.section)).map(d=><button key={`${d.section}:${d.kind}`} className="rm-sidebar-link" aria-label={d.label} title={d.label} onClick={()=>navigate(d.section,d.kind)}><d.icon size={14}/><span>{d.label}</span></button>)}<div className="rm-sidebar-heading">Recent records</div>{recentRecords.slice(0,8).map(record=><button className="rm-sidebar-link" key={routeKey(record)} onClick={()=>activateRecord(record)} title={labelFor(record)}>{labelFor(record)}</button>)}<div className="rm-sidebar-footer"><span>{source==='synthetic'?'Synthetic development data':'Live operational data'}</span><a href="/ops?ui=classic">Classic workspace</a><a href="/">5Central website</a></div></aside>
  <div className="rm-main">
   <header className="rm-page-heading rm-workspace-heading">{route.recordId&&window.history.state?.returnTo&&<button className="rm-button rm-button--icon" aria-label="Back to previous view" title="Back" onClick={()=>window.history.back()}><ChevronLeft size={17}/></button>}<h1>{route.section==='tenants'?'Tenants':labelFor({...route,recordId:undefined})}</h1></header>
   {route.section!=='banking'&&<div className="rm-toolbar rm-workspace-toolbar" aria-label="Workspace filters">
    <label>Portfolio<select aria-label="Portfolio scope" value={filters.propertyScope} onChange={e=>changeScope({propertyScope:e.target.value as 'active'|'all',propertyId:'all',propertyIds:[]})}><option value="active">Active portfolio</option><option value="all">All imported properties</option></select></label>
    <details className="rm-property-filter"><summary>{selectedWorkspaceProperties(filters).length===0?'All properties':selectedWorkspaceProperties(filters).length===1?(snapshot?.snapshot.properties.find(p=>p.id===selectedWorkspaceProperties(filters)[0])?.name??'1 property'):`${selectedWorkspaceProperties(filters).length} properties`}</summary><div className="rm-property-filter-options"><label><input type="checkbox" checked={!selectedWorkspaceProperties(filters).length} onChange={()=>changeScope({propertyId:'all',propertyIds:[]})}/>All properties</label>{snapshot&&scopeProperties(snapshot,filters).map(p=>p.id&&<label key={p.id}><input type="checkbox" checked={selectedWorkspaceProperties(filters).includes(p.id)} onChange={e=>{const ids=e.target.checked?[...selectedWorkspaceProperties(filters),p.id!]:selectedWorkspaceProperties(filters).filter(id=>id!==p.id);changeScope({propertyIds:ids,propertyId:ids.length===1?ids[0]:'all'});}}/>{p.name??'Unnamed property'}</label>)}</div></details>
    <label>As of<input type="date" value={filters.asOfDate} onChange={e=>{if(e.target.value)setFilters(f=>pinWorkspaceDate(f,e.target.value));}}/></label>
    <button type="button" className="rm-button" aria-pressed={filters.asOfMode==='today'} onClick={()=>setFilters(f=>selectWorkspaceToday(f))}>Today</button>
    {['tenants','applicants'].includes(route.section)&&<label>Status<select value={selectedStatus} onChange={e=>{if(route.section==='tenants'){setTenantStatus(e.target.value);go({...route,recordId:undefined},true);}else setFilters(f=>({...f,status:e.target.value}));}}>{statusOptions.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>}
    <label className="rm-search"><Search size={14}/><input aria-label="Search records" placeholder={route.section==='tenants'?'Name, property, unit, email or phone':'Search records'} value={filters.search} onChange={e=>setFilters(f=>({...f,search:e.target.value}))}/></label>
    <div className="rm-workspace-toolbar-actions"><button className="rm-button rm-button--icon" aria-label="Refresh workspace" title="Refresh" onClick={()=>void refresh()} disabled={data.isRefreshing}><RefreshCw size={15} className={data.isRefreshing?'spin':''}/></button>
    {route.section==='properties'&&snapshot&&<button className="rm-button rm-button-primary" onClick={()=>openEditor('save-property')}><Plus size={14}/>Add property</button>}</div>
   </div>}
   {['rent-roll','reports','leases','income'].includes(route.section)&&<WorkspaceReportPreload selected={route.section==='income'?'scheduled-vs-collected':selectedReport} filters={filters} enabled={!snapshot}/>}
   {notice&&<div className="rm-notice" role="status">{notice}<button className="rm-button" aria-label="Dismiss notice" onClick={()=>setNotice('')}><X size={12}/></button></div>}
   {contextError?<ErrorNotice error={contextError}/>:data.bootstrap.error?<ErrorNotice error={data.bootstrap.error} retry={()=>void data.bootstrap.refetch()}/>:!snapshot?<Busy label="Loading the workspace directory…"/>:<>
    {data.collectionError&&<ErrorNotice error={data.collectionError} retry={()=>void refresh()}/>}
    {route.section==='dashboard'&&<>{data.summary.error&&<ErrorNotice error={data.summary.error} retry={()=>void data.summary.refetch()}/>} {!data.summary.data?!data.summary.error&&<Busy label="Loading portfolio summary…"/>:<DashboardWorkspace onManageMoves={source==='live' && businessDate ? ()=>setManageMoves({}) : undefined} snapshot={snapshot} filters={filters} previews={data.summary.data.reports} refreshing={data.summary.isFetching} onReport={report=>go({section:'reports',report,tab:'summary'})} onOpenTenant={openTenant} onOpenUnit={openUnit} onOpenProperty={openProperty}/>}</>}
    {route.section==='tenants'&&<div className="rm-record-layout"><section className="rm-record-list"><div className="rm-toolbar"><strong>{directory.length} tenants</strong><button className="rm-button" onClick={()=>openEditor('save-person')}><Plus size={13}/>Add</button></div><div className="rm-record-list-items">{directory.map(tenant=>{const id=tenant.person.id;const index=data.bootstrap.data?.tenantIndex.find(row=>row.person.id===id);return <EntityLink personId={id} tab={route.tab} onOpen={()=>go({...route,recordId:id})} key={id??`${tenant.person.firstName}:${tenant.person.lastName}`} className={`rm-record-list-item${route.recordId===id?' active':''}`} ><strong className="rm-record-list-item-title">{tenant.person.lastName}{tenant.person.lastName?', ':''}{tenant.person.firstName}</strong><span className="rm-record-list-item-meta">{tenant.property?.name??'Account contact'}{tenant.unit?.unitNumber?` · ${tenant.unit.unitNumber}`:''}</span><small className="rm-record-list-item-meta">{formatLabel(index?.category??'unknown')}</small></EntityLink>;})}{!directory.length&&<div className="rm-empty">No tenants match these filters.</div>}</div></section><div className="rm-record-detail">{data.tenant.error?<ErrorNotice error={data.tenant.error} retry={()=>void data.tenant.refetch()}/>:fullTenant?<TenantRecord tenant={fullTenant} snapshot={snapshot} tab={route.tab} onTab={(tab:TenantTab)=>go({...route,tab},true)} onEdit={openEditor} onChanged={refresh} businessDate={businessDate} readOnly={source!=='live'} onManageMoves={()=>setManageMoves({personId:fullTenant.person.id})}/>:<Busy label={route.recordId?'Loading tenant details…':'Select a tenant to open the record.'}/>}</div></div>}
    {route.section==='properties'&&(data.collectionsReady?<PropertyUnitRecords readOnly={source !== 'live'} snapshot={snapshot} filters={filters} onSearchChange={search=>setFilters(current=>({...current,search}))} selectedPropertyId={route.kind==='property'?route.recordId:undefined} selectedUnitId={route.kind==='unit'?route.recordId:undefined} onSelect={(kind,id)=>go({...route,kind,recordId:id})} onEdit={openEditor}/>:<Busy/>)}
    {['reports','rent-roll','leases'].includes(route.section)&&<ReportsWorkspace snapshot={snapshot} filters={filters} selected={selectedReport} onSelect={report=>go({section:'reports',report,tab:'summary'})} onOpenTenant={openTenant} onOpenUnit={openUnit} onOpenProperty={openProperty}/>}
    {route.section==='income'&&<><ManagerIncomeActions snapshot={snapshot} businessDate={businessDate} propertyId={filters.propertyId} onSaved={refresh} onRequestPaymentContext={()=>setIncomeHistoryNeeded(true)} paymentContextLoading={incomeHistoryNeeded&&!data.collectionsReady}/><>{selectedWorkspaceProperties(filters).length>1?<button className="rm-button" disabled>Select one property</button>:<RecurringBillingPanel businessDate={businessDate} propertyId={filters.propertyId==='all'?undefined:filters.propertyId} onPosted={refresh}/>}</><div className="rm-toolbar"><button className="rm-button" onClick={()=>openEditor('post-ledger-transaction')}>Post charge or credit</button><button className="rm-button" onClick={()=>openEditor('save-payment-allocation')}>Allocate payment</button><button className="rm-button" onClick={()=>openEditor('reverse-ledger-transaction')}>Reverse transaction</button></div><ReportsWorkspace snapshot={snapshot} filters={filters} selected="scheduled-vs-collected" onOpenTenant={openTenant} onOpenUnit={openUnit} onOpenProperty={openProperty} onSelect={report=>go({section:'reports',report,tab:'summary'})}/></>}
    {route.section==='recurring'&&(data.collectionsReady?<RecurringRegister snapshot={snapshot} filters={filters} onEdit={openEditor}/>:<Busy/>)}
    {route.section==='applicants'&&(data.collectionsReady?<ApplicationsWorkspace snapshot={snapshot} filters={filters} onChanged={()=>void refresh()} onEdit={openEditor}/>:<Busy/>)}
    {route.section==='banking'&&<RmBanking/>}
    {route.section==='documents'&&(data.collectionsReady?<DocumentsWorkspace snapshot={snapshot} filters={filters} onChanged={()=>void refresh()} onEdit={openEditor}/>:<Busy/>)}
   </>}
  </div></div>
  {manageMoves&&source==='live'&&snapshot&&<div className="rm-dialog-backdrop"><section className="rm-dialog" role="dialog" aria-modal="true" aria-label="Move-in and move-out">{data.collectionsReady?<ManagerTenancyActions snapshot={snapshot} businessDate={businessDate} personId={manageMoves.personId} propertyId={filters.propertyId} onSaved={refresh} onClose={()=>setManageMoves(undefined)}/>:<><Busy label="Loading tenancy records…"/>{data.collectionError&&<ErrorNotice error={data.collectionError} retry={()=>void refresh()}/>}<button className="rm-button" onClick={()=>setManageMoves(undefined)}>Cancel</button></>}</section></div>}
  {editing&&snapshot&&(data.collectionsReady?<WorkspaceEditor action={editing.action} snapshot={snapshot} initialValues={editing.values} onClose={()=>setEditing(undefined)} onSaved={finishEdit} onConflict={()=>{setEditing(undefined);setNotice('This record changed. The latest values are being loaded; review them before saving again.');void refresh();}}/>:<div className="rm-dialog-backdrop"><section className="rm-dialog" role="dialog" aria-modal="true" aria-label="Loading editor"><Busy label="Loading related records…"/>{data.collectionError&&<ErrorNotice error={data.collectionError}/>}<button className="rm-button" onClick={()=>setEditing(undefined)}>Cancel</button></section></div>)}
 </main></EntityNavigationContext.Provider>;
}
