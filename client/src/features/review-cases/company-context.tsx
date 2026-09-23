import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyContext, CompanyContextOrganization } from "@shared/company/context";
import { rentOpsAuthClient } from "../rent-ops/auth";
import "./company-context.css";

/** The authorized companies, entities and properties for the signed-in manager. */
export function useCompanyContext() {
  return useQuery({
    queryKey: ["company-context", "lane-c"],
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request("/api/company/context", { signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Company records could not be loaded.");
      return response.json();
    },
    staleTime: 30_000,
    retry: false,
  });
}

/** Legal entity that owns a property in the authorized context, if any. */
export function entityForProperty(organization: CompanyContextOrganization | undefined, propertyId: string | null | undefined): string | undefined {
  if (!organization || !propertyId) return undefined;
  return organization.entities.find(entity => entity.properties.some(property => property.id === propertyId))?.id;
}

/**
 * Resolve the company for an entry point that has no required props. A
 * single authorized company is chosen automatically; otherwise a selector is
 * shown. Errors and empty access use the standard empty-state shape.
 */
export function CompanyGate({ organizationId, loadingLabel, children }: {
  organizationId?: string;
  loadingLabel: string;
  children: (organization: CompanyContextOrganization, select: (id: string) => void) => ReactNode;
}) {
  const context = useCompanyContext();
  if (context.error) {
    return <div className="rc-state" role="alert"><h3>Company Records Unavailable</h3><p>{context.error.message}</p><button type="button" className="rm-button" onClick={() => void context.refetch()}>Try Again</button></div>;
  }
  if (!context.data) return <div className="rc-state" role="status"><p>{loadingLabel}</p></div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rc-state"><h3>No Company Access</h3><p>Ask an owner to grant access to a company.</p></div>;
  const chosen = organizations.find(item => item.id === organizationId) ?? (organizations.length === 1 ? organizations[0] : undefined);
  return <CompanyChooser organizations={organizations} chosen={chosen} render={children} />;
}

function CompanyChooser({ organizations, chosen, render }: {
  organizations: readonly CompanyContextOrganization[];
  chosen: CompanyContextOrganization | undefined;
  render: (organization: CompanyContextOrganization, select: (id: string) => void) => ReactNode;
}) {
  const [selectedId, setSelectedId] = useSelectedCompany(chosen?.id);
  const organization = organizations.find(item => item.id === selectedId) ?? chosen;
  return <>
    {(organizations.length > 1 || !organization) && <div className="rc-company-picker"><label>Company <select aria-label="Company" value={organization?.id ?? ""} onChange={event => setSelectedId(event.currentTarget.value)}>
      <option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label></div>}
    {organization ? render(organization, setSelectedId) : null}
  </>;
}

function useSelectedCompany(initial: string | undefined): [string | undefined, (id: string) => void] {
  const [value, setValue] = useState(initial);
  return [value, setValue];
}
