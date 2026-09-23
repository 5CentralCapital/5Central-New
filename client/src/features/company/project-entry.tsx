import { lazy, Suspense } from 'react';
import { useCompanyContext } from '../workspaces/page';
import type { ProjectTab } from '../projects/types';

const ProjectWorkspace = lazy(() => import('../projects/workspace').then(module => ({ default: module.ProjectWorkspace })));

export function ProjectEntry({ identity, organizationId, projectId, onNavigate, projectTab, onTabChange }: {
  identity: string; organizationId?: string; projectId?: string;
  projectTab?: ProjectTab; onTabChange?: (tab: ProjectTab) => void;
  onNavigate: (organizationId: string, projectId?: string) => void;
}) {
  const context = useCompanyContext(identity);
  if (context.error) return <div className="rm-notice" role="alert">{context.error.message} <button className="rm-button" onClick={() => void context.refetch()}>Retry</button></div>;
  if (!context.data) return <div className="rm-empty" role="status">Loading projects…</div>;
  const organizations = context.data.organizations;
  if (!organizations.length) return <div className="rm-empty">Company access needs setup.</div>;
  const organization = organizations.find(item => item.id === organizationId) ?? (!organizationId && organizations.length === 1 ? organizations[0] : undefined);
  return <>
    {(organizations.length > 1 || !organization) && <div className="rm-toolbar"><label>Company <select aria-label="Company" value={organization?.id ?? ''} onChange={event => onNavigate(event.target.value)}>
      <option value="" disabled>Select company</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label></div>}
    {organization && <Suspense fallback={<div className="rm-empty" role="status">Loading projects…</div>}><ProjectWorkspace key={organization.id}
      organizationId={organization.id} organizationName={organization.name} entities={organization.entities}
      initialProjectId={projectId} activeTab={projectTab} onTabChange={onTabChange} onNavigate={id => onNavigate(organization.id, id)}
    /></Suspense>}
  </>;
}
