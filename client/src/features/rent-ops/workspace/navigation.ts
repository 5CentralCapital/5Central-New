import type { ReportKey } from '../types';
import type { WorkspaceRoute, WorkspaceSection } from './workspace-state';
import type { ProjectTab } from '../../projects/types';

export interface WorkspaceDestination {
  label: string;
  section?: WorkspaceSection;
  kind?: 'property' | 'unit';
  report?: ReportKey;
  tenantStatus?: 'current' | 'future' | 'former' | 'all';
  projectTab?: ProjectTab;
}
export interface WorkspaceNavigationGroup { label: string; items: readonly WorkspaceDestination[]; }
const planned = (...labels: string[]): WorkspaceDestination[] => labels.map(label => ({ label }));
const report = (label: string, key: ReportKey): WorkspaceDestination => ({ label, section: 'reports', report: key });

/** Only destinations backed by a working workspace have a section. */
export const WORKSPACE_NAVIGATION: readonly WorkspaceNavigationGroup[] = [
  { label: 'Dashboard', items: [{ label: 'Overview', section: 'dashboard' }] },
  { label: 'Properties', items: [
    { label: 'Property records', section: 'properties', kind: 'property' },
    { label: 'Rent roll', section: 'rent-roll' },
  ] },
  { label: 'Tenants', items: [
    { label: 'Current tenants', section: 'tenants', tenantStatus: 'current' },
    { label: 'Future tenants', section: 'tenants', tenantStatus: 'future' },
    { label: 'Former tenants', section: 'tenants', tenantStatus: 'former' },
    { label: 'All tenants', section: 'tenants', tenantStatus: 'all' },
    { label: 'Leases', section: 'leases' },
    { label: 'Applications', section: 'applicants' },
  ] },
  { label: 'Units', items: [
    { label: 'Unit records', section: 'properties', kind: 'unit' },
    report('Availability & occupancy', 'occupancy'),
  ] },
  { label: 'Accounting', items: [
    { label: 'Cash & banking', section: 'banking' },
    { label: 'Payments & billing', section: 'income' },
    { label: 'Recurring charges', section: 'recurring' },
    report('Receivables', 'delinquency'), report('Tenant transactions', 'tenant-ledger'),
    report('Security deposits', 'security-deposit'),
    ...planned('Payables', 'Debt', 'Reconciliation', 'Imports'),
  ] },
  { label: 'Projects', items: [
    { label: 'All projects', section: 'projects', projectTab: 'overview' },
    { label: 'Scope & budget', section: 'projects', projectTab: 'scope' },
    { label: 'Schedule', section: 'projects', projectTab: 'schedule' },
    { label: 'Costs', section: 'projects', projectTab: 'costs' },
    ...planned('Files'),
  ] },
  { label: 'Work Orders', items: planned('Open work orders', 'Schedule', 'Completed work') },
  { label: 'Investors', items: planned('Investor records', 'Investments', 'Activity', 'Agreements', 'Distributions') },
  { label: 'Reporting', items: [
    { label: 'Report library', section: 'report-library' },
    report('Scheduled vs. collected', 'scheduled-vs-collected'),
    report('Collected income', 'collected-income'), report('Housing assistance', 'hap'),
    ...planned('Financial statements', 'Project reports', 'Investor reports', 'Debt & forecasts'),
  ] },
  { label: 'Company', items: [
    { label: 'Documents & activity', section: 'documents' },
    ...planned('Entities', 'Contacts & contractors', 'Employees & time', 'Administration'),
  ] },
];

export function activeNavigationGroup(route: WorkspaceRoute): string {
  switch (route.section) {
    case 'dashboard': return 'Dashboard';
    case 'properties': return route.kind === 'unit' ? 'Units' : 'Properties';
    case 'tenants': case 'leases': case 'applicants': return 'Tenants';
    case 'income': case 'recurring': case 'banking': return 'Accounting';
    case 'projects': return 'Projects';
    case 'documents': return 'Company';
    case 'rent-roll': return 'Properties';
    case 'reports':
      if (route.report === 'occupancy') return 'Units';
      if (['delinquency', 'tenant-ledger', 'security-deposit'].includes(route.report)) return 'Accounting';
      return 'Reporting';
    default: return 'Reporting';
  }
}

export const WORKSPACE_LABELS: Record<WorkspaceSection, string> = {
  dashboard: 'Dashboard', tenants: 'Tenants', properties: 'Properties', projects: 'Projects',
  leases: 'Leases', applicants: 'Applications', recurring: 'Recurring charges',
  income: 'Payments & billing', banking: 'Banking', 'rent-roll': 'Rent roll',
  reports: 'Reports', 'report-library': 'Reporting', documents: 'Documents & activity',
};
