import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext } from "@shared/company/context";
import { rentOpsAuthClient } from "../rent-ops/auth";
import type { TimeWorkspaceProps } from "./types";

const TimeWorkspace = lazy(() => import("./workspace").then(module => ({ default: module.TimeWorkspace })));

/** Company selector entry point used by the shared workspace navigation. */
export function TimeEntry({ identity, organizationId, onNavigate }: { identity: string; organizationId?: string; onNavigate: (organizationId: string) => void }) {
  const context = useQuery({
    queryKey: ["rent-ops-workspace", "company-context", identity],
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request("/api/company/context", { signal });
      if (!response.ok) throw new Error("Company records could not be loaded.");
      return response.json();
    },
    staleTime: 30_000,
    retry: false,
  });
  if (context.error) return <div className="rm-notice" role="alert">{context.error.message} <button className="rm-button" onClick={() => void context.refetch()}>Retry</button></div>;
  if (!context.data) return <div className="rm-empty" role="status">Loading employee time…</div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rm-empty">Company access needs setup.</div>;
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  const workspaceProps: TimeWorkspaceProps | null = organization ? { organizationId: organization.id, organizationName: organization.name, entities: organization.entities } : null;
  return <>{(organizations.length > 1 || !organization) && <div className="rm-toolbar"><label>Company <select aria-label="Company" value={organization?.id ?? ""} onChange={event => onNavigate(event.currentTarget.value)}><option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}{workspaceProps && <Suspense fallback={<div className="rm-empty" role="status">Loading employee time…</div>}><TimeWorkspace key={workspaceProps.organizationId} {...workspaceProps} /></Suspense>}</>;
}

