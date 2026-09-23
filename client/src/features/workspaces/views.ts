import { PROJECT_TABS } from "../projects/types";
import { INVESTOR_TABS } from "../investors/types";
import {
  INVESTOR_NAV_TABS, LEGACY_INVESTOR_TAB_ALIASES, LEGACY_PROJECT_TAB_ALIASES, WORKSPACE_SECTIONS,
  type InvestorNavTab, type ProjectNavTab, type WorkspaceSection,
} from "../rent-ops/workspace/workspace-state";

/**
 * What each manager view needs from the shell. rm-workspace renders views
 * from a Record keyed by the same sections, so a section without a renderer
 * is a type error, and this table lets tests check every destination.
 */
export interface WorkspaceViewSpec {
  /** Needs the rental snapshot bootstrap before it can render. */
  readonly snapshot: boolean;
  /** Shows the shared portfolio/date/search toolbar. */
  readonly filters: boolean;
  /** The shell draws the page title (company workspaces draw their own). */
  readonly heading: boolean;
  /** Status filter options offered in the shared toolbar. */
  readonly status?: "tenants" | "applications";
}

const rental = (extra: Partial<WorkspaceViewSpec> = {}): WorkspaceViewSpec => ({ snapshot: true, filters: true, heading: true, ...extra });
const company = (extra: Partial<WorkspaceViewSpec> = {}): WorkspaceViewSpec => ({ snapshot: false, filters: false, heading: true, ...extra });

export const WORKSPACE_VIEWS: Readonly<Record<WorkspaceSection, WorkspaceViewSpec>> = Object.freeze({
  dashboard: rental(),
  properties: rental(),
  "property-performance": rental(),
  "rent-roll": rental({ filters: false }),
  "property-documents": rental(),
  tenants: rental({ status: "tenants" }),
  collections: rental(),
  leases: rental(),
  moves: rental(),
  applicants: rental({ status: "applications" }),
  recurring: rental(),
  "make-ready": rental(),
  listings: rental(),
  accounting: company({ heading: false }),
  projects: company({ heading: false }),
  "cost-library": company(),
  "work-orders": company({ heading: false }),
  investors: company({ heading: false }),
  reports: rental({ filters: false }),
  "report-library": company(),
  "company-reports": company({ heading: false }),
  "saved-reports": company(),
  "report-packages": company(),
  forecasting: company({ heading: false }),
  "review-queue": company({ heading: false }),
  entities: company(),
  people: company(),
  time: company({ heading: false }),
  "company-documents": company(),
  "mra-packets": company(),
  settings: company(),
});

export function hasWorkspaceView(section: string): section is WorkspaceSection {
  return (WORKSPACE_SECTIONS as readonly string[]).includes(section) && Object.hasOwn(WORKSPACE_VIEWS, section);
}

/**
 * Compatibility with the project workspace while its new tabs land: a tab the
 * workspace does not know yet opens its nearest existing tab.
 */
const PROJECT_TAB_FALLBACKS: Record<ProjectNavTab, string> = { overview: "overview", schedule: "schedule", budget: "scope", commitments: "execution", draws: "execution" };
export function projectTabForWorkspace(tab: ProjectNavTab, supported: readonly string[] = PROJECT_TABS): string {
  return supported.includes(tab) ? tab : PROJECT_TAB_FALLBACKS[tab];
}
export function projectTabFromWorkspace(tab: string): ProjectNavTab {
  return (["overview", "schedule", "budget", "commitments", "draws"] as const).find(value => value === tab) ?? (Object.hasOwn(LEGACY_PROJECT_TAB_ALIASES, tab) ? LEGACY_PROJECT_TAB_ALIASES[tab] : undefined) ?? "overview";
}

const INVESTOR_TAB_FALLBACKS: Record<InvestorNavTab, string> = { overview: "overview", payments: "payments", capital: "activity", debt: "debt", contracts: "contracts", activity: "activity" };
export function investorTabForWorkspace(tab: InvestorNavTab, supported: readonly string[] = INVESTOR_TABS): string {
  return supported.includes(tab) ? tab : INVESTOR_TAB_FALLBACKS[tab];
}
export function investorTabFromWorkspace(tab: string): InvestorNavTab {
  return INVESTOR_NAV_TABS.find(value => value === tab) ?? (Object.hasOwn(LEGACY_INVESTOR_TAB_ALIASES, tab) ? LEGACY_INVESTOR_TAB_ALIASES[tab] : undefined) ?? "overview";
}
