import { lazy, Suspense } from "react";
import { useCompanyContext } from "../workspaces/page";
import type { WorkOrderView } from "./types";

const WorkOrdersWorkspace = lazy(() => import("./workspace").then(module => ({ default: module.WorkOrdersWorkspace })));

/** Company selector entry point used by the manager's top navigation. */
export function WorkOrderEntry({ identity, organizationId, workOrderId, view, createRequest, onNavigate, onViewChange, onOpenProperty, onOpenUnit, onOpenTenant }: {
  identity: string; organizationId?: string; workOrderId?: string; view: WorkOrderView; createRequest?: number;
  onNavigate: (organizationId: string, workOrderId?: string, replace?: boolean) => void;
  onViewChange: (view: WorkOrderView) => void;
  onOpenProperty?: (propertyId: string) => void; onOpenUnit?: (unitId: string) => void; onOpenTenant?: (personId: string) => void;
}) {
  const context = useCompanyContext(identity);
  if (context.error) return <div className="rm-notice" role="alert">{context.error.message} <button className="rm-button" onClick={() => void context.refetch()}>Retry</button></div>;
  if (!context.data) return <div className="rm-empty" role="status">Loading work orders…</div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rm-empty">Company access needs setup.</div>;
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  return <>
    {(organizations.length > 1 || !organization) && <div className="rm-toolbar"><label>Company <select aria-label="Company" value={organization?.id ?? ""} onChange={event => onNavigate(event.currentTarget.value)}>
      <option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label></div>}
    {organization && <Suspense fallback={<div className="rm-empty" role="status">Loading work orders…</div>}>
      <WorkOrdersWorkspace key={organization.id} organizationId={organization.id} entities={organization.entities} view={view}
        selectedId={workOrderId} createRequest={createRequest}
        onSelect={(id, replace) => onNavigate(organization.id, id, replace)} onViewChange={onViewChange}
        onOpenProperty={onOpenProperty} onOpenUnit={onOpenUnit} onOpenTenant={onOpenTenant} />
    </Suspense>}
  </>;
}
