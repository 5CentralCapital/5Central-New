import type { ReportKey } from '../types';
import { COMPANY_SECTIONS, type AccountingView, type InvestorNavTab, type ProjectNavTab, type WorkOrderRouteView, type WorkspaceRoute, type WorkspaceSection } from './workspace-state';

/**
 * One navigation destination. Every destination names a canonical route that
 * rm-workspace renders; there are no placeholder or disabled entries.
 * Actions (new work order, record receipt, record move) live in page toolbars.
 */
export interface WorkspaceDestination {
  /** Stable id used by tests and the browser smoke script. */
  readonly id: string;
  readonly label: string;
  readonly section: WorkspaceSection;
  readonly kind?: 'property' | 'unit';
  readonly report?: ReportKey;
  readonly reportId?: string;
  readonly projectTab?: ProjectNavTab;
  readonly investorTab?: InvestorNavTab;
  readonly workOrderView?: WorkOrderRouteView;
  readonly accountingView?: AccountingView;
}

export interface WorkspaceNavigationGroup {
  readonly label: NavigationGroupLabel;
  /** Present when the category opens directly instead of showing a menu. */
  readonly direct?: WorkspaceDestination;
  readonly items: readonly WorkspaceDestination[];
}

export const NAVIGATION_GROUP_LABELS = ['Dashboard', 'Properties', 'Tenants', 'Units', 'Accounting', 'Projects', 'Work Orders', 'Investors', 'Reporting', 'Company'] as const;
export type NavigationGroupLabel = (typeof NAVIGATION_GROUP_LABELS)[number];

const destination = (id: string, label: string, route: Omit<WorkspaceDestination, 'id' | 'label'>): WorkspaceDestination => Object.freeze({ id, label, ...route });

export const DASHBOARD_DESTINATION = destination('dashboard', 'Dashboard', { section: 'dashboard' });

export const WORKSPACE_NAVIGATION: readonly WorkspaceNavigationGroup[] = Object.freeze([
  { label: 'Dashboard', direct: DASHBOARD_DESTINATION, items: [] },
  { label: 'Properties', items: [
    destination('properties.all', 'All properties', { section: 'properties', kind: 'property' }),
    destination('properties.performance', 'Performance', { section: 'property-performance' }),
    destination('properties.rent-roll', 'Rent roll', { section: 'rent-roll' }),
    destination('properties.documents', 'Documents & compliance', { section: 'property-documents' }),
  ] },
  { label: 'Tenants', items: [
    destination('tenants.directory', 'Directory', { section: 'tenants' }),
    destination('tenants.collections', 'Collections', { section: 'collections' }),
    destination('tenants.leases', 'Leases & renewals', { section: 'leases' }),
    destination('tenants.moves', 'Move-ins & move-outs', { section: 'moves' }),
    destination('tenants.applications', 'Applications', { section: 'applicants' }),
  ] },
  { label: 'Units', items: [
    destination('units.all', 'All units', { section: 'properties', kind: 'unit' }),
    destination('units.availability', 'Availability', { section: 'reports', report: 'occupancy' }),
    destination('units.make-ready', 'Make-ready', { section: 'make-ready' }),
    destination('units.listings', 'Listings', { section: 'listings' }),
  ] },
  { label: 'Accounting', items: [
    destination('accounting.overview', 'Overview', { section: 'accounting', accountingView: 'overview' }),
    destination('accounting.transactions', 'Transactions', { section: 'accounting', accountingView: 'transactions' }),
    destination('accounting.bills', 'Bills & payments', { section: 'accounting', accountingView: 'bills' }),
    destination('accounting.banking', 'Banking & reconciliation', { section: 'accounting', accountingView: 'banking' }),
    destination('accounting.pm-settlements', 'PM settlements', { section: 'accounting', accountingView: 'pm-settlements' }),
    destination('accounting.close', 'Period close', { section: 'accounting', accountingView: 'close' }),
  ] },
  { label: 'Projects', items: [
    destination('projects.all', 'All projects', { section: 'projects', projectTab: 'overview' }),
    destination('projects.schedule', 'Schedule', { section: 'projects', projectTab: 'schedule' }),
    destination('projects.budget', 'Budgets & costs', { section: 'projects', projectTab: 'budget' }),
    destination('projects.commitments', 'Commitments & changes', { section: 'projects', projectTab: 'commitments' }),
    destination('projects.draws', 'Draws', { section: 'projects', projectTab: 'draws' }),
    destination('projects.cost-library', 'Cost library', { section: 'cost-library' }),
  ] },
  { label: 'Work Orders', items: [
    destination('work-orders.open', 'Open work', { section: 'work-orders', workOrderView: 'open' }),
    destination('work-orders.schedule', 'Schedule', { section: 'work-orders', workOrderView: 'schedule' }),
    destination('work-orders.completed', 'Completed work', { section: 'work-orders', workOrderView: 'completed' }),
  ] },
  { label: 'Investors', items: [
    destination('investors.accounts', 'Accounts', { section: 'investors', investorTab: 'overview' }),
    destination('investors.payments', 'Payment calendar', { section: 'investors', investorTab: 'payments' }),
    destination('investors.capital', 'Contributions & distributions', { section: 'investors', investorTab: 'capital' }),
    destination('investors.debt', 'Debt & maturities', { section: 'investors', investorTab: 'debt' }),
    destination('investors.agreements', 'Agreements', { section: 'investors', investorTab: 'contracts' }),
  ] },
  { label: 'Reporting', items: [
    destination('reporting.library', 'Report library', { section: 'report-library' }),
    destination('reporting.saved', 'Saved reports', { section: 'saved-reports' }),
    destination('reporting.packages', 'Packages', { section: 'report-packages' }),
    destination('reporting.forecasting', 'Forecasting', { section: 'forecasting' }),
  ] },
  { label: 'Company', items: [
    destination('company.review', 'Review queue', { section: 'review-queue' }),
    destination('company.entities', 'Entities & ownership', { section: 'entities' }),
    destination('company.people', 'People & vendors', { section: 'people' }),
    destination('company.time', 'Team & time', { section: 'time' }),
    destination('company.documents', 'Documents', { section: 'company-documents' }),
    destination('company.mra', 'MRA packets', { section: 'mra-packets' }),
    destination('company.settings', 'Settings', { section: 'settings' }),
  ] },
] satisfies WorkspaceNavigationGroup[]);

export function allDestinations(): WorkspaceDestination[] {
  return WORKSPACE_NAVIGATION.flatMap(group => group.direct ? [group.direct, ...group.items] : [...group.items]);
}

/** Group for views that are not themselves menu destinations. */
const SECTION_GROUPS: Record<WorkspaceSection, NavigationGroupLabel> = {
  dashboard: 'Dashboard',
  properties: 'Properties', 'property-performance': 'Properties', 'rent-roll': 'Properties', 'property-documents': 'Properties',
  tenants: 'Tenants', collections: 'Tenants', leases: 'Tenants', moves: 'Tenants', applicants: 'Tenants', recurring: 'Tenants',
  'make-ready': 'Units', listings: 'Units',
  accounting: 'Accounting',
  projects: 'Projects', 'cost-library': 'Projects',
  'work-orders': 'Work Orders',
  investors: 'Investors',
  reports: 'Reporting', 'report-library': 'Reporting', 'company-reports': 'Reporting', 'saved-reports': 'Reporting', 'report-packages': 'Reporting', forecasting: 'Reporting',
  'review-queue': 'Company', entities: 'Company', people: 'Company', time: 'Company', 'company-documents': 'Company', 'mra-packets': 'Company', settings: 'Company',
};

const REPORT_GROUPS: Partial<Record<ReportKey, NavigationGroupLabel>> = {
  occupancy: 'Units', 'rent-roll': 'Properties', delinquency: 'Tenants', 'lease-expiration': 'Tenants', 'applicant-pipeline': 'Tenants',
};

function routeValue<K extends keyof WorkspaceRoute>(route: WorkspaceRoute, key: K): WorkspaceRoute[K] | string | undefined {
  if (key === 'projectTab') return route.projectTab ?? 'overview';
  if (key === 'investorTab') return route.investorTab ?? 'overview';
  if (key === 'workOrderView') return route.workOrderView ?? 'open';
  if (key === 'accountingView') return route.accountingView ?? 'overview';
  if (key === 'kind') return route.kind ?? 'property';
  return route[key];
}

/** True when the route is the view this destination opens (records inside it included). */
export function destinationMatches(target: WorkspaceDestination, route: WorkspaceRoute): boolean {
  if (target.section !== route.section) return false;
  const keys = ['kind', 'report', 'reportId', 'projectTab', 'investorTab', 'workOrderView', 'accountingView'] as const;
  return keys.every(key => target[key] === undefined || routeValue(route, key) === target[key]);
}

export function activeDestination(route: WorkspaceRoute): WorkspaceDestination | undefined {
  return allDestinations().find(target => destinationMatches(target, route));
}

export function activeNavigationGroup(route: WorkspaceRoute): NavigationGroupLabel {
  const current = activeDestination(route);
  if (current) return WORKSPACE_NAVIGATION.find(group => group.direct === current || group.items.includes(current))!.label;
  if (route.section === 'properties') return route.kind === 'unit' ? 'Units' : 'Properties';
  if (route.section === 'reports') return REPORT_GROUPS[route.report] ?? 'Reporting';
  return SECTION_GROUPS[route.section];
}

/** Page names for headings and the browser tab title. */
export const WORKSPACE_LABELS: Record<WorkspaceSection, string> = {
  dashboard: 'Dashboard',
  properties: 'Properties', 'property-performance': 'Property performance', 'rent-roll': 'Rent roll', 'property-documents': 'Documents & compliance',
  tenants: 'Tenants', collections: 'Collections', leases: 'Leases & renewals', moves: 'Move-ins & move-outs', applicants: 'Applications', recurring: 'Recurring charges',
  'make-ready': 'Make-ready', listings: 'Listings',
  accounting: 'Accounting',
  projects: 'Projects', 'cost-library': 'Cost library',
  'work-orders': 'Work orders',
  investors: 'Investors',
  reports: 'Reports', 'report-library': 'Report library', 'company-reports': 'Reports', 'saved-reports': 'Saved reports', 'report-packages': 'Report packages', forecasting: 'Forecasting',
  'review-queue': 'Review queue', entities: 'Entities & ownership', people: 'People & vendors', time: 'Team & time', 'company-documents': 'Company documents', 'mra-packets': 'MRA packets', settings: 'Settings',
};

/** Short page name: the destination label, qualified by its category when the label alone is ambiguous. */
export function workspacePageTitle(route: WorkspaceRoute): string {
  const page = activeDestination(route);
  if (!page) return WORKSPACE_LABELS[route.section];
  const group = activeNavigationGroup(route);
  if (page.section === 'dashboard') return 'Dashboard';
  const ambiguous = page.label === 'Overview' || allDestinations().filter(other => other.label === page.label).length > 1;
  return ambiguous ? `${group} ${page.label.toLowerCase()}` : page.label;
}

/** Browser tab title: "5Central Ops — <page>". */
export function workspaceDocumentTitle(route: WorkspaceRoute): string {
  return `5Central Ops — ${workspacePageTitle(route)}`;
}

/** Route for a navigation destination; company context stays with company views. */
export function destinationRoute(destination: WorkspaceDestination, current: WorkspaceRoute, firstRecordId?: string): WorkspaceRoute {
 const {section}=destination;
 const sameSection=current.section===section;
 const organizationId=COMPANY_SECTIONS.includes(section)?current.organizationId:undefined;
 // Switching tabs inside projects/investors keeps the open record.
 const keepRecord=sameSection&&(section==='projects'||section==='investors')||sameSection&&section==='work-orders'&&(destination.workOrderView??'open')===(current.workOrderView??'open');
 return {
  section,tab:'summary',report:destination.report??'rent-roll',
  ...(destination.kind?{kind:destination.kind}:{}),
  ...(destination.reportId?{reportId:destination.reportId}:{}),
  ...(destination.projectTab?{projectTab:destination.projectTab}:{}),
  ...(destination.investorTab?{investorTab:destination.investorTab}:{}),
  ...(destination.workOrderView?{workOrderView:destination.workOrderView}:{}),
  ...(destination.accountingView?{accountingView:destination.accountingView}:{}),
  ...(organizationId?{organizationId}:{}),
  recordId:keepRecord?current.recordId:firstRecordId,
 };
}
