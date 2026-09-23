import { lazy, Suspense, type ComponentType } from "react";
import type { CompanyContextOrganization } from "@shared/company/context";
import { CompanyGate, Loading, StatePanel } from "./page";
import { AccountingEntry } from "../accounting/entry";
import type { AccountingView } from "../rent-ops/workspace/workspace-state";

/**
 * Mount points for workspaces owned by other lanes. Modules are discovered
 * with import.meta.glob so a missing module is an "Unavailable" state rather
 * than a build failure. The integrator may replace these with direct imports.
 */
type LooseProps = Record<string, unknown>;
type Loader = () => Promise<Record<string, unknown>>;

const MODULES = import.meta.glob<Record<string, unknown>>([
  "../review-cases/workspace.tsx",
  "../intake/results.tsx",
  "../company-documents/workspace.tsx",
  "../forecasting/workspace.tsx",
]);

export interface LaneEntryProps {
  readonly identity: string;
  readonly organizationId?: string;
  readonly onNavigate: (organizationId: string) => void;
  readonly propertyId?: string;
  readonly [key: string]: unknown;
}

function Unavailable() {
  return <StatePanel title="Unavailable" message="This workspace is not installed in this version of 5Central Ops." />;
}

/**
 * Prefer the lane's `*Entry` export (resolves its own company). Otherwise wrap
 * the named workspace export in the shared company selector.
 */
function mount(path: string, entryExport: string, workspaceExport: string | undefined, loadingLabel: string, workspaceProps?: (organization: CompanyContextOrganization, props: LaneEntryProps) => LooseProps): ComponentType<LaneEntryProps> {
  const loader = MODULES[path] as Loader | undefined;
  const Lazy = lazy(async (): Promise<{ default: ComponentType<LaneEntryProps> }> => {
    if (!loader) return { default: Unavailable };
    let module: Record<string, unknown>;
    try { module = await loader(); } catch { return { default: Unavailable }; }
    const entry = module[entryExport];
    if (typeof entry === "function" || (typeof entry === "object" && entry !== null)) return { default: entry as ComponentType<LaneEntryProps> };
    const workspace = workspaceExport ? module[workspaceExport] : undefined;
    if (!workspace || !workspaceProps) return { default: Unavailable };
    const Workspace = workspace as ComponentType<LooseProps>;
    const Wrapped = (props: LaneEntryProps) => <CompanyGate identity={props.identity} organizationId={props.organizationId} onOrganization={props.onNavigate} loadingLabel={loadingLabel}>
      {(organization, selector) => <>{selector && <div className="ws-toolbar">{selector}</div>}<Workspace key={organization.id} {...workspaceProps(organization, props)} /></>}
    </CompanyGate>;
    return { default: Wrapped };
  });
  const Mounted = (props: LaneEntryProps) => <Suspense fallback={<Loading label={loadingLabel} />}><Lazy {...props} /></Suspense>;
  Mounted.displayName = entryExport;
  return Mounted;
}

const organizationProps = (organization: CompanyContextOrganization, props: LaneEntryProps): LooseProps => ({
  organizationId: organization.id, organizationName: organization.name, ...(props.propertyId ? { propertyId: props.propertyId } : {}),
});

export const ReviewQueueEntry = mount("../review-cases/workspace.tsx", "ReviewQueueEntry", "ReviewQueueWorkspace", "Loading the review queue…",
  (organization, props) => ({ organizationId: organization.id, propertyId: props.propertyId ?? null }));
export const IntakeResultsEntry = mount("../intake/results.tsx", "IntakeResultsEntry", "MraResults", "Loading MRA packets…", organizationProps);
export const CompanyDocumentsEntry = mount("../company-documents/workspace.tsx", "CompanyDocumentsEntry", "CompanyDocumentsWorkspace", "Loading company documents…", organizationProps);
export const ForecastingEntry = mount("../forecasting/workspace.tsx", "ForecastingEntry", undefined, "Loading forecasting…");

/**
 * Accounting sub-views (Lane B adds the `view` prop to AccountingEntry). Until
 * then the prop is ignored and the existing accounting workspace renders.
 */
export const AccountingEntryWithView = AccountingEntry as ComponentType<Parameters<typeof AccountingEntry>[0] & { view?: AccountingView }>;
