import assert from 'node:assert/strict';
import test from 'node:test';
import { REPORT_KEYS } from '../types';
import {
  activeDestination, activeNavigationGroup, allDestinations, destinationMatches, destinationRoute, NAVIGATION_GROUP_LABELS,
  WORKSPACE_LABELS, WORKSPACE_NAVIGATION, workspaceDocumentTitle, type WorkspaceDestination,
} from './navigation';
import { accountInitials, destinationHref } from './top-navigation';
import { parseWorkspaceRoute, workspaceRouteSearch, WORKSPACE_SECTIONS, type WorkspaceRoute } from './workspace-state';
import { hasWorkspaceView, investorTabForWorkspace, investorTabFromWorkspace, projectTabForWorkspace, projectTabFromWorkspace, WORKSPACE_VIEWS } from '../../workspaces/views';
import { canonicalPropertyTab, PROPERTY_RECORD_TABS } from '../../workspaces/property-record-model';
import { INVESTOR_TABS } from '../../investors/types';

const company = '10000000-0000-4000-8000-000000000001';
const parse = (href: string) => parseWorkspaceRoute(new URL(href, 'https://app.example.test').search);
const stable = (route: WorkspaceRoute) => assert.deepEqual(parseWorkspaceRoute(workspaceRouteSearch(route)), route, `route ${route.section} is canonical`);

test('ten categories; Dashboard opens directly; menus hold only working destinations', () => {
  assert.deepEqual(WORKSPACE_NAVIGATION.map(group => group.label), [...NAVIGATION_GROUP_LABELS]);
  const dashboard = WORKSPACE_NAVIGATION[0];
  assert.equal(dashboard.direct?.section, 'dashboard');
  assert.deepEqual(dashboard.items, [], 'no one-item Dashboard dropdown');
  for (const group of WORKSPACE_NAVIGATION.slice(1)) {
    assert.equal(group.direct, undefined);
    assert.ok(group.items.length >= 3 && group.items.length <= 7, `${group.label} has a short one-level menu`);
    assert.equal(new Set(group.items.map(item => item.label)).size, group.items.length, `${group.label} labels are unique`);
  }
  const destinations = allDestinations();
  assert.equal(new Set(destinations.map(item => item.id)).size, destinations.length, 'destination ids are unique');
  for (const item of destinations) {
    assert.ok((WORKSPACE_SECTIONS as readonly string[]).includes(item.section), `${item.id} names a canonical section`);
    assert.ok(hasWorkspaceView(item.section), `${item.id} maps to an implemented view`);
    assert.doesNotMatch(item.label, /planned|coming soon|5Central Ops|Rent Op/i, `${item.id} label`);
    assert.doesNotMatch(item.label, /^(New|Record|Add|Post) /, `${item.id} is a destination, not an action`);
  }
});

test('every destination link opens exactly that destination and survives reload', () => {
  for (const item of allDestinations()) {
    const route = parse(destinationHref(item));
    assert.ok(destinationMatches(item, route), `${item.id} matches its own route`);
    assert.equal(activeDestination(route)?.id, item.id, `${item.id} is the active destination for its route`);
    const group = WORKSPACE_NAVIGATION.find(candidate => candidate.direct === item || candidate.items.includes(item))!;
    assert.equal(activeNavigationGroup(route), group.label, `${item.id} highlights ${group.label}`);
    stable(route);
  }
});

test('every section has a renderer spec and a page label', () => {
  for (const section of WORKSPACE_SECTIONS) {
    assert.ok(WORKSPACE_VIEWS[section], `${section} view`);
    assert.ok(WORKSPACE_LABELS[section], `${section} label`);
    assert.ok(activeNavigationGroup({ section, tab: 'summary', report: 'rent-roll' }), `${section} belongs to a category`);
  }
});

/** Every bookmark the previous navigation could produce, with the canonical view it now opens. */
const LEGACY_LINKS: ReadonlyArray<[string, Partial<WorkspaceRoute>]> = [
  ['/ops?section=dashboard', { section: 'dashboard' }],
  ['/ops?section=properties&kind=property', { section: 'properties', kind: 'property' }],
  ['/ops?section=rent-roll', { section: 'rent-roll' }],
  ['/ops?section=tenants&tenantStatus=current', { section: 'tenants', tenantStatus: 'current' }],
  ['/ops?section=tenants&tenantStatus=future', { section: 'tenants', tenantStatus: 'future' }],
  ['/ops?section=tenants&tenantStatus=former', { section: 'tenants', tenantStatus: 'former' }],
  ['/ops?section=tenants&tenantStatus=all', { section: 'tenants', tenantStatus: 'all' }],
  ['/ops?section=leases', { section: 'leases' }],
  ['/ops?section=applicants', { section: 'applicants' }],
  ['/ops?section=properties&kind=unit', { section: 'properties', kind: 'unit' }],
  ['/ops?section=accounting', { section: 'accounting', accountingView: 'overview' }],
  ['/ops?section=banking', { section: 'accounting', accountingView: 'banking' }],
  ['/ops?section=income', { section: 'collections' }],
  ['/ops?section=recurring', { section: 'recurring' }],
  ['/ops?section=documents', { section: 'property-documents' }],
  ['/ops?section=time', { section: 'time' }],
  ['/ops?section=report-library', { section: 'report-library' }],
  ['/ops?section=company-reports&reportId=income-statement', { section: 'company-reports', reportId: 'income-statement' }],
  ['/ops?section=company-reports&reportId=project-performance', { section: 'company-reports', reportId: 'project-performance' }],
  ['/ops?section=company-reports&reportId=investor-owner-activity', { section: 'company-reports', reportId: 'investor-owner-activity' }],
  ['/ops?section=projects&projectTab=overview', { section: 'projects', projectTab: 'overview' }],
  ['/ops?section=projects&projectTab=scope', { section: 'projects', projectTab: 'budget' }],
  ['/ops?section=projects&projectTab=schedule', { section: 'projects', projectTab: 'schedule' }],
  ['/ops?section=projects&projectTab=costs', { section: 'projects', projectTab: 'budget' }],
  ['/ops?section=projects&projectTab=execution', { section: 'projects', projectTab: 'commitments' }],
  ['/ops?section=investors&investorTab=overview', { section: 'investors', investorTab: 'overview' }],
  ['/ops?section=investors&investorTab=payments', { section: 'investors', investorTab: 'payments' }],
  ['/ops?section=investors&investorTab=contracts', { section: 'investors', investorTab: 'contracts' }],
  ['/ops?section=investors&investorTab=debt', { section: 'investors', investorTab: 'debt' }],
  ['/ops?section=investors&investorTab=activity', { section: 'investors', investorTab: 'activity' }],
  ['/ops?section=investors&investorTab=capital', { section: 'investors', investorTab: 'capital' }],
  ['/ops?section=work-orders', { section: 'work-orders' }],
  ['/ops?section=work-orders&woView=all', { section: 'work-orders', workOrderView: 'all' }],
  ['/ops?section=work-orders&woView=completed', { section: 'work-orders', workOrderView: 'completed' }],
  ['/ops?section=work-orders&woView=scheduled', { section: 'work-orders', workOrderView: 'scheduled' }],
  [`/ops?section=projects&company=${company}&record=20000000-0000-4000-8000-000000000001&projectTab=costs`, { section: 'projects', organizationId: company, recordId: '20000000-0000-4000-8000-000000000001', projectTab: 'budget' }],
  ...REPORT_KEYS.map((report): [string, Partial<WorkspaceRoute>] => [`/ops?section=reports&report=${report}`, { section: 'reports', report }]),
];

test('old deep links resolve to the canonical view and then stay canonical', () => {
  for (const [href, expected] of LEGACY_LINKS) {
    const route = parse(href);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(route[key as keyof WorkspaceRoute], value, `${href} → ${key}`);
    assert.ok(hasWorkspaceView(route.section), `${href} opens an implemented view`);
    stable(route);
    const reserialized = new URLSearchParams(workspaceRouteSearch(route));
    assert.ok(!['income', 'banking', 'documents'].includes(reserialized.get('section') ?? ''), `${href} is not written back in its legacy form`);
  }
});

test('legacy tenant status and property tabs map onto the directory filter and new record tabs', () => {
  assert.equal(parse('/ops?section=tenants&tenantStatus=bogus').tenantStatus, undefined);
  assert.equal(parse('/ops?section=dashboard&tenantStatus=former').tenantStatus, undefined, 'status belongs to the directory only');
  for (const [legacy, tab] of [['general', 'overview'], ['units', 'overview'], ['marketing', 'overview'], ['occupancy', 'rent-roll'], ['recurring', 'rent-roll'], ['financials', 'financials'], [null, 'overview'], ['bogus', 'overview']] as const) {
    assert.equal(canonicalPropertyTab(legacy), tab);
  }
  assert.deepEqual([...PROPERTY_RECORD_TABS], ['overview', 'rent-roll', 'financials', 'projects', 'work-orders', 'documents']);
});

test('off-menu views still highlight their category', () => {
  const route = (partial: Partial<WorkspaceRoute> & { section: WorkspaceRoute['section'] }): WorkspaceRoute => ({ tab: 'summary', report: 'rent-roll', ...partial });
  assert.equal(activeNavigationGroup(route({ section: 'recurring' })), 'Tenants');
  assert.equal(activeNavigationGroup(route({ section: 'company-reports', reportId: 'income-statement' })), 'Reporting');
  assert.equal(activeNavigationGroup(route({ section: 'work-orders', workOrderView: 'all' })), 'Work Orders');
  assert.equal(activeNavigationGroup(route({ section: 'reports', report: 'delinquency' })), 'Tenants');
  assert.equal(activeNavigationGroup(route({ section: 'reports', report: 'hap' })), 'Reporting');
  assert.equal(activeNavigationGroup(route({ section: 'properties', kind: 'unit', recordId: 'unit-1' })), 'Units');
});

test('page titles use the product name and qualify ambiguous labels', () => {
  const route = (partial: Partial<WorkspaceRoute> & { section: WorkspaceRoute['section'] }): WorkspaceRoute => ({ tab: 'summary', report: 'rent-roll', ...partial });
  assert.equal(workspaceDocumentTitle(route({ section: 'dashboard' })), '5Central Ops — Dashboard');
  assert.equal(workspaceDocumentTitle(route({ section: 'projects', projectTab: 'schedule' })), '5Central Ops — Projects schedule');
  assert.equal(workspaceDocumentTitle(route({ section: 'work-orders', workOrderView: 'schedule' })), '5Central Ops — Work Orders schedule');
  assert.equal(workspaceDocumentTitle(route({ section: 'accounting', accountingView: 'overview' })), '5Central Ops — Accounting overview');
  assert.equal(workspaceDocumentTitle(route({ section: 'collections' })), '5Central Ops — Collections');
  assert.equal(workspaceDocumentTitle(route({ section: 'recurring' })), '5Central Ops — Recurring charges');
});

test('navigation keeps company context for company views and the open record when switching tabs', () => {
  const byId = (id: string) => allDestinations().find(item => item.id === id) as WorkspaceDestination;
  const project: WorkspaceRoute = { section: 'projects', tab: 'summary', report: 'rent-roll', organizationId: company, recordId: 'project-1', projectTab: 'overview' };
  const schedule = destinationRoute(byId('projects.schedule'), project);
  assert.equal(schedule.organizationId, company); assert.equal(schedule.recordId, 'project-1'); assert.equal(schedule.projectTab, 'schedule');
  const library = destinationRoute(byId('projects.cost-library'), project);
  assert.equal(library.organizationId, company); assert.equal(library.recordId, undefined);
  const collections = destinationRoute(byId('tenants.collections'), project);
  assert.equal(collections.organizationId, undefined, 'rental views do not carry company scope');
  const property = destinationRoute(byId('properties.all'), collections, 'property-1');
  assert.equal(property.recordId, 'property-1'); assert.equal(property.kind, 'property');
});

test('new project and investor tabs fall back to the nearest existing tab until the workspaces accept them', () => {
  assert.equal(projectTabForWorkspace('budget', ['overview', 'scope', 'schedule', 'costs', 'execution']), 'scope');
  assert.equal(projectTabForWorkspace('draws', ['overview', 'scope', 'schedule', 'costs', 'execution']), 'execution');
  assert.equal(projectTabForWorkspace('budget', ['overview', 'schedule', 'budget', 'commitments', 'draws']), 'budget');
  assert.equal(projectTabFromWorkspace('costs'), 'budget');
  assert.equal(projectTabFromWorkspace('execution'), 'commitments');
  assert.equal(investorTabForWorkspace('capital', ['overview', 'payments', 'contracts', 'debt', 'activity']), 'activity');
  assert.equal(investorTabForWorkspace('capital', ['overview', 'payments', 'capital', 'debt', 'contracts']), 'capital');
  assert.equal(investorTabFromWorkspace('capital'), 'capital');
});

test('every investor tab the workspace renders is a live navigation tab that round-trips', () => {
  for (const tab of INVESTOR_TABS) {
    const nav = investorTabFromWorkspace(tab);
    assert.equal(nav, tab, `${tab} is a canonical navigation tab`);
    assert.equal(investorTabForWorkspace(nav), tab, `${tab} opens itself, not another tab`);
    const route = parse(`/ops?section=investors&investorTab=${tab}`);
    assert.equal(route.investorTab, tab);
    assert.equal(parse(`/ops${workspaceRouteSearch(route)}`).investorTab, tab, `${tab} survives serialization`);
  }
  assert.equal(investorTabFromWorkspace('activity'), 'activity', 'Activity is not redirected to Contributions & distributions');
  assert.equal(investorTabFromWorkspace('constructor'), 'overview', 'unknown tabs never resolve through prototype keys');
  assert.equal(parse('/ops?section=investors&investorTab=constructor').investorTab, undefined);
  assert.equal(parse('/ops?section=projects&projectTab=toString').projectTab, undefined);
});

test('account initials never expose more than two characters', () => {
  assert.equal(accountInitials('michael.example@example.test'), 'ME');
  assert.equal(accountInitials('demo-admin'), 'DA');
  assert.equal(accountInitials('x'), 'X');
  assert.equal(accountInitials(undefined), '5C');
});
