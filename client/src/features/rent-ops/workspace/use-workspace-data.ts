import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadRentOpsTenantProfile, loadRentOpsWorkspaceBootstrap, loadRentOpsWorkspaceCollection, loadRentOpsWorkspaceDashboard, type WorkspaceCollection } from '../api';
import { rentOpsAuthClient } from '../auth';
import type { AdminSnapshotView, ViewFilters } from '../types';
import { composeWorkspaceSnapshot, workspaceApiFilters } from './workspace-state';
import { seedWorkspaceDashboardReports } from './dashboard-cache';
const queryRoot=['rent-ops-workspace'] as const;
export function useWorkspaceData({enabled,identity,filters,collections,summaryNeeded,personId}:{enabled:boolean;identity:string;filters:ViewFilters;collections:WorkspaceCollection[];summaryNeeded:boolean;personId?:string}){
 const client=useQueryClient();
 const apiFilters=useMemo(()=>workspaceApiFilters(filters),[filters.propertyScope,filters.propertyId,filters.propertyIds,filters.asOfDate]);
 const scope=[identity,filters.propertyScope,filters.propertyId,[...(filters.propertyIds??[])].sort(),filters.asOfDate];
 const bootstrap=useQuery({queryKey:[...queryRoot,'bootstrap',...scope],queryFn:({signal})=>loadRentOpsWorkspaceBootstrap(apiFilters,signal),enabled:enabled&&!!filters.asOfDate,staleTime:60_000,gcTime:300_000,retry:false});
 const summary=useQuery({queryKey:[...queryRoot,'dashboard',...scope],queryFn:({signal})=>loadRentOpsWorkspaceDashboard(apiFilters,signal),enabled:enabled&&summaryNeeded&&!!filters.asOfDate,staleTime:30_000,gcTime:300_000,retry:false});
 useEffect(()=>{
  if(!enabled||!summaryNeeded||!summary.data||summary.isStale)return;
  seedWorkspaceDashboardReports(client,summary.data,apiFilters,identity,summary.dataUpdatedAt,rentOpsAuthClient.getSnapshot());
 },[client,enabled,summaryNeeded,identity,apiFilters,summary.data,summary.dataUpdatedAt,summary.isStale]);
 const fetched=useQueries({queries:collections.map(name=>({queryKey:[...queryRoot,'collection',name,...scope],queryFn:({signal}:{signal:AbortSignal})=>loadRentOpsWorkspaceCollection(name,apiFilters,signal),enabled:enabled&&!!filters.asOfDate&&!bootstrap.data?.loadedCollections.includes(name),staleTime:60_000,gcTime:300_000,retry:false}))});
 const tenant=useQuery({queryKey:[...queryRoot,'tenant',personId,...scope],queryFn:({signal})=>loadRentOpsTenantProfile(personId!,apiFilters,signal),enabled:enabled&&!!filters.asOfDate&&!!personId,staleTime:60_000,gcTime:300_000,retry:false});
 const previousCollections=useRef<{names:WorkspaceCollection[];values:unknown[];merged:Partial<AdminSnapshotView>}>({names:[],values:[],merged:{}});
 const values=fetched.map(query=>query.data);
 if(collections.length!==previousCollections.current.names.length||collections.some((name,i)=>name!==previousCollections.current.names[i]||values[i]!==previousCollections.current.values[i])){
  const merged:Partial<AdminSnapshotView>={};
  collections.forEach((name,i)=>{if(values[i])Object.assign(merged,{[name]:values[i]});});
  previousCollections.current={names:[...collections],values,merged};
 }
 const merged=previousCollections.current.merged;
 const snapshot=useMemo(()=>enabled&&bootstrap.data?composeWorkspaceSnapshot(bootstrap.data,filters.asOfDate,summary.data?.summary,merged):undefined,[enabled,bootstrap.data,filters.asOfDate,summary.data,merged]);
 const collectionError=fetched.find(q=>q.error)?.error;
 const collectionsReady=!!bootstrap.data&&collections.every((name,i)=>bootstrap.data!.loadedCollections.includes(name)||fetched[i].isSuccess);
 const refresh=useCallback(async()=>{await client.invalidateQueries({queryKey:queryRoot});},[client]);
 return {bootstrap,summary,tenant,snapshot,collectionsReady,collectionError,refresh,isRefreshing:bootstrap.isFetching||summary.isFetching||tenant.isFetching||fetched.some(q=>q.isFetching)};
}
