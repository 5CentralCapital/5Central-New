import { lazy, Suspense } from "react";
import { useCompanyContext } from "../workspaces/page";
import type { AccountingView, AccountingWorkspaceProps } from "./types";

const AccountingWorkspace = lazy(() => import("./workspace").then(module => ({ default: module.AccountingWorkspace })));

export function AccountingEntry({ identity, organizationId, onNavigate, view, onViewChange }: { readonly identity: string; readonly organizationId?: string; readonly onNavigate: (organizationId: string) => void; readonly view?: AccountingView; readonly onViewChange?: (view: AccountingView) => void }) {
  const context = useCompanyContext(identity);
  if (context.error) return <div className="rm-notice" role="alert">{context.error.message} <button className="rm-button" onClick={() => void context.refetch()}>Retry</button></div>;
  if (!context.data) return <div className="rm-empty" role="status">Loading accounting…</div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rm-empty">Company access needs setup.</div>;
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  const props: AccountingWorkspaceProps | null = organization ? { organizationId: organization.id, organizationName: organization.name, entities: organization.entities } : null;
  return <>{(organizations.length > 1 || !organization) && <div className="rm-toolbar"><label>Company<select aria-label="Company" value={organization?.id ?? ""} onChange={event => onNavigate(event.currentTarget.value)}><option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}{props && <Suspense fallback={<div className="rm-empty" role="status">Loading accounting…</div>}><AccountingWorkspace key={props.organizationId} {...props} {...(view ? { view } : {})} {...(onViewChange ? { onViewChange } : {})} /></Suspense>}</>;
}
