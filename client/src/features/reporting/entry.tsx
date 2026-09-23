import { lazy, Suspense } from "react";
import { CompanySelector, useCompanyContext } from "../workspaces/page";

const ReportingWorkspace = lazy(() => import("./workspace").then(module => ({ default: module.ReportingWorkspace })));

export function ReportingEntry({ identity, organizationId, reportId, presetId, onNavigate, onOpenLegacy }: { identity: string; organizationId?: string; reportId?: string; presetId?: string; onNavigate?: (organizationId: string, reportId?: string) => void; onOpenLegacy?: (reportId: string) => void }) {
  const context = useCompanyContext(identity);
  if (context.isLoading) return <div className="reporting-state" role="status">Loading reports…</div>;
  if (context.error) return <div className="reporting-state reporting-error" role="alert">{context.error instanceof Error ? context.error.message : "Company records could not be loaded."} <button type="button" className="reporting-quiet-button" onClick={() => void context.refetch()}>Try Again</button></div>;
  const organizations = context.data?.organizations ?? [];
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  if (!organization) return <div className="reporting-state">{!organizations.length ? "Company access needs setup." : onNavigate ? <CompanySelector organizations={organizations} onChange={id => onNavigate(id, reportId)} /> : "Choose a company to view reports."}</div>;
  return <Suspense fallback={<div className="reporting-state" role="status">Loading reports…</div>}><ReportingWorkspace key={organization.id} identity={identity} organization={organization} initialReportId={reportId} initialPresetId={presetId} onNavigate={onNavigate} onOpenLegacy={onOpenLegacy} /></Suspense>;
}
