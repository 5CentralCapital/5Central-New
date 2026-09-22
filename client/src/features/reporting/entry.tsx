import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "@shared/company/context";
import { rentOpsAuthClient } from "../rent-ops/auth";

const ReportingWorkspace = lazy(() => import("./workspace").then(module => ({ default: module.ReportingWorkspace })));

export function ReportingEntry({ identity, organizationId, reportId, onNavigate, onOpenLegacy }: { identity: string; organizationId?: string; reportId?: string; onNavigate?: (organizationId: string, reportId?: string) => void; onOpenLegacy?: (reportId: string) => void }) {
  const context = useQuery({ queryKey: ["rent-ops-workspace", "company-context", identity], queryFn: async ({ signal }): Promise<CompanyContext> => { const response = await rentOpsAuthClient.request("/api/company/context", { signal }); if (!response.ok) throw new Error("Company records could not be loaded."); return response.json(); }, staleTime: 30_000, retry: false });
  if (context.isLoading) return <div className="reporting-state" role="status">Loading reports…</div>;
  if (context.error) return <div className="reporting-state reporting-error" role="alert">{context.error instanceof Error ? context.error.message : "Company records could not be loaded."}</div>;
  const organizations = context.data?.organizations ?? [];
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  if (!organization) return <div className="reporting-state">Choose a company to view reports.</div>;
  return <Suspense fallback={<div className="reporting-state" role="status">Loading reports…</div>}><ReportingWorkspace identity={identity} organization={organization} initialReportId={reportId} onNavigate={onNavigate} onOpenLegacy={onOpenLegacy} /></Suspense>;
}

export { ReportingWorkspace } from "./workspace";
