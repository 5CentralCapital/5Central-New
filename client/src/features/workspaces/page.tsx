import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { CompanyContext, CompanyContextOrganization } from "@shared/company/context";
import { rentOpsAuthClient } from "../rent-ops/auth";
import "./workspaces.css";

/** Company directory shared with every company entry (same query key, one request). */
export function useCompanyContext(identity: string) {
  return useQuery({
    queryKey: ["rent-ops-workspace", "company-context", identity],
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request("/api/company/context", { signal });
      if (!response.ok) throw new Error("Company records could not be loaded.");
      return response.json();
    },
    staleTime: 30_000,
    retry: false,
  });
}

/** Resolve the route's company, or the only company the manager can access. */
export function selectOrganization(organizations: readonly CompanyContextOrganization[], organizationId?: string): CompanyContextOrganization | undefined {
  return organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
}

/** Empty, unavailable and error states: Title 3 heading, one line, at most one action. */
export function StatePanel({ title, message, action, role }: { title: string; message: string; action?: { label: string; onClick: () => void }; role?: "status" | "alert" }) {
  return <section className="ws-state" role={role}>
    <h3>{title}</h3>
    <p>{message}</p>
    {action && <button type="button" className="rm-button" onClick={action.onClick}>{action.label}</button>}
  </section>;
}

export function Loading({ label }: { label: string }) {
  return <div className="ws-loading" role="status"><RefreshCw size={16} className="spin" aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <StatePanel role="alert" title="Couldn’t load this view" message={error instanceof Error ? error.message : "Records could not be loaded."} action={onRetry ? { label: "Try again", onClick: onRetry } : undefined} />;
}

export function CompanySelector({ organizations, value, onChange }: { organizations: readonly CompanyContextOrganization[]; value?: string; onChange: (organizationId: string) => void }) {
  if (organizations.length < 2 && value) return null;
  return <label className="ws-field">Company<select aria-label="Company" value={value ?? ""} onChange={event => onChange(event.currentTarget.value)}>
    <option value="" disabled>Select company</option>
    {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
  </select></label>;
}

/**
 * Renders children for one company. Several companies show a selector; none
 * shows a setup state instead of an empty page.
 */
export function CompanyGate({ identity, organizationId, onOrganization, loadingLabel, children }: {
  identity: string; organizationId?: string; onOrganization: (organizationId: string) => void; loadingLabel: string;
  children: (organization: CompanyContextOrganization, selector: ReactNode) => ReactNode;
}) {
  const context = useCompanyContext(identity);
  if (context.error) return <ErrorState error={context.error} onRetry={() => void context.refetch()} />;
  if (!context.data) return <Loading label={loadingLabel} />;
  const organizations = context.data.organizations;
  if (!organizations.length) return <StatePanel title="No company access" message="Company records appear here after your access is set up." />;
  const organization = selectOrganization(organizations, organizationId);
  const selector = <CompanySelector organizations={organizations} value={organization?.id} onChange={onOrganization} />;
  if (!organization) return <div className="ws-page"><div className="ws-toolbar">{selector}</div><StatePanel title="Choose a company" message="Select the company whose records you want to see." /></div>;
  return <>{children(organization, organizations.length > 1 ? selector : null)}</>;
}

export function Section({ title, count, actions, children, id }: { title: string; count?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return <section className="ws-section" aria-labelledby={id}>
    <header className="ws-section-heading"><h2 id={id}>{title}{count !== undefined && <span className="ws-count">{count}</span>}</h2>{actions && <div className="ws-section-actions">{actions}</div>}</header>
    {children}
  </section>;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "positive" | "warning" | "critical" | "info"; children: ReactNode }) {
  return <span className={`ws-badge ws-badge--${tone}`}>{children}</span>;
}

/** Two to four mutually exclusive views; each option is a toggle button in a labelled group. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void }) {
  return <div className="ws-segmented" role="group" aria-label={label}>
    {options.map(([option, text]) => <button key={option} type="button" aria-pressed={value === option} className={value === option ? "is-selected" : undefined} onClick={() => onChange(option)}>{text}</button>)}
  </div>;
}

/** The legal entity that currently holds a property in the company directory. */
export function propertyEntity(organization: CompanyContextOrganization | undefined, propertyId: string | undefined): string | undefined {
  if (!organization || !propertyId) return undefined;
  return organization.entities.find(entity => entity.properties.some(property => property.id === propertyId))?.id;
}
