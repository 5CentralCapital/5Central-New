import {createContext,useContext,type MouseEvent,type ReactNode} from 'react';
export const EntityNavigationContext=createContext<{onTenant?:(id:string,tab?:TenantTab)=>void;onRecord?:(kind:'property'|'unit',id:string)=>void}>({});
import type { TenantTab } from '../types';
import { workspaceRouteSearch, type WorkspaceRoute } from './workspace-state';

export function entityHref(route:WorkspaceRoute, search=typeof window==='undefined'?'':window.location.search):string {
  return workspaceRouteSearch(route,undefined,search);
}
export function shouldHandleEntityClick(event:Pick<MouseEvent,'button'|'metaKey'|'ctrlKey'|'shiftKey'|'altKey'|'defaultPrevented'>):boolean {
  return !event.defaultPrevented&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey;
}
function follow(event:MouseEvent<HTMLAnchorElement>, onOpen?:()=>void) {
  event.stopPropagation();
  if(!shouldHandleEntityClick(event))return;
  if(onOpen){event.preventDefault();onOpen();}
}
export function EntityLink({personId,tab='summary',onOpen,children,className}:{personId?:string|null;tab?:TenantTab;onOpen?:(id:string,tab?:TenantTab)=>void;children:ReactNode;className?:string}) {
  const navigation=useContext(EntityNavigationContext);onOpen=onOpen??navigation.onTenant;
  if(!personId)return <>{children}</>;
  return <a className={className??'rm-entity-link'} href={entityHref({section:'tenants',recordId:personId,tab,report:'rent-roll'})} onClick={event=>follow(event,onOpen?()=>onOpen(personId,tab):undefined)}>{children}</a>;
}
export function RecordLink({kind,recordId,onOpen,children,className}:{kind:'property'|'unit';recordId?:string|null;onOpen?:(id:string)=>void;children:ReactNode;className?:string}) {
  const navigation=useContext(EntityNavigationContext);onOpen=onOpen??(navigation.onRecord?(id)=>navigation.onRecord!(kind,id):undefined);
  if(!recordId)return <>{children}</>;
  return <a className={className??'rm-entity-link'} href={entityHref({section:'properties',kind,recordId,tab:'summary',report:'rent-roll'})} onClick={event=>follow(event,onOpen?()=>onOpen(recordId):undefined)}>{children}</a>;
}
