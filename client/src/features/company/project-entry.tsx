import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProjectTab } from '../projects/types';
import type { CompanyContext } from '@shared/company/context';
import { plannedPropertyPlanListSchema, type PlannedPropertyPlan } from '@shared/company/property-contracts';
import { rentOpsAuthClient } from '../rent-ops/auth';

const ProjectWorkspace = lazy(() => import('../projects/project-workspace').then(module => ({ default: module.ProjectWorkspace })));

function mergePlannedProperties(entities: CompanyContext['organizations'][number]['entities'], plans: readonly PlannedPropertyPlan[]): CompanyContext['organizations'][number]['entities'] {
  return entities.map(entity => {
    const entityPlans = plans.filter(plan => plan.legalEntityId === entity.id);
    if (!entityPlans.length) return entity;
    const existing = new Set(entity.properties.map(property => property.id));
    const planned = entityPlans.filter(plan => !existing.has(plan.propertyId)).map(plan => ({ id: plan.propertyId, name: `${plan.propertyName} (planned)`, units: [] }));
    return planned.length ? { ...entity, properties: [...entity.properties, ...planned] } : entity;
  });
}

export function ProjectEntry({ identity, organizationId, projectId, onNavigate, projectTab, onTabChange }: {
  identity: string; organizationId?: string; projectId?: string;
  projectTab?: ProjectTab; onTabChange?: (tab: ProjectTab) => void;
  onNavigate: (organizationId: string, projectId?: string) => void;
}) {
  const context = useQuery({
    queryKey: ['rent-ops-workspace', 'company-context', identity],
    queryFn: async ({ signal }): Promise<CompanyContext> => {
      const response = await rentOpsAuthClient.request('/api/company/context', { signal });
      if (!response.ok) throw new Error('Company records could not be loaded.');
      return response.json();
    },
    staleTime: 30_000, retry: false,
  });
  const candidateOrganizationId = organizationId ?? (context.data?.organizations.length === 1 ? context.data.organizations[0]?.id : undefined);
  const plannedPlans = useQuery({
    queryKey: ['rent-ops-workspace', 'planned-property-plans', identity, candidateOrganizationId],
    enabled: Boolean(candidateOrganizationId),
    queryFn: async ({ signal }): Promise<readonly PlannedPropertyPlan[]> => {
      const response = await rentOpsAuthClient.request(`/api/company/${encodeURIComponent(candidateOrganizationId!)}/property-plans`, { signal });
      if (!response.ok) throw new Error('Planned properties could not be loaded.');
      return plannedPropertyPlanListSchema.parse(await response.json()).items;
    },
    staleTime: 30_000, retry: false,
  });
  if (context.error) return <div className="rm-notice" role="alert">{context.error.message} <button className="rm-button" onClick={() => void context.refetch()}>Retry</button></div>;
  if (!context.data) return <div className="rm-empty" role="status">Loading projects…</div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rm-empty">Company access needs setup.</div>;
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  const plans = plannedPlans.data?.filter(plan => plan.organizationId === organization?.id) ?? [];
  const projectEntities = organization ? mergePlannedProperties(organization.entities, plans) : [];
  return <>
    {(organizations.length > 1 || !organization) && <div className="rm-toolbar"><label>Company <select aria-label="Company" value={organization?.id ?? ''} onChange={event => onNavigate(event.target.value)}>
      <option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label></div>}
    {organization && <Suspense fallback={<div className="rm-empty" role="status">Loading projects…</div>}><ProjectWorkspace key={organization.id}
      organizationId={organization.id} organizationName={organization.name} entities={projectEntities} plannedPropertyIds={plans.map(plan => plan.propertyId)}
      initialProjectId={projectId} activeTab={projectTab} onTabChange={onTabChange} onNavigate={id => onNavigate(organization.id, id)}
    /></Suspense>}
  </>;
}
