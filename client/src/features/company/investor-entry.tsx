import { lazy, Suspense } from "react";
import { useCompanyContext } from "../workspaces/page";
import type { InvestorTab } from "../investors/types";

const InvestorWorkspace = lazy(() => import("../investors/workspace").then(module => ({ default: module.InvestorWorkspace })));

export type { InvestorTab };

export function InvestorEntry({ identity, organizationId, accountId, onNavigate, investorTab, onTabChange }: {
  identity: string;
  organizationId?: string;
  accountId?: string;
  investorTab?: InvestorTab;
  onTabChange?: (tab: InvestorTab) => void;
  onNavigate: (organizationId: string, accountId?: string) => void;
}) {
  const context = useCompanyContext(identity);
  if (context.error) return <div className="rm-notice" role="alert">{context.error.message} <button className="rm-button" onClick={() => void context.refetch()}>Retry</button></div>;
  if (!context.data) return <div className="rm-empty" role="status">Loading investors…</div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rm-empty">Company access needs setup.</div>;
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  return <>{(organizations.length > 1 || !organization) && <div className="rm-toolbar"><label>Company <select aria-label="Company" value={organization?.id ?? ""} onChange={event => onNavigate(event.currentTarget.value)}><option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}{organization && <Suspense fallback={<div className="rm-empty" role="status">Loading investors…</div>}><InvestorWorkspace key={organization.id} organizationId={organization.id} organizationName={organization.name} entities={organization.entities} initialAccountId={accountId} activeTab={investorTab} onTabChange={onTabChange} onNavigate={id => onNavigate(organization.id, id)} /></Suspense>}</>;
}
