import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { workspacesApi } from "../../workspaces/api";
import { formatCentsText, formatIsoDate, humanize } from "../../workspaces/format";
import { obligationRemaining } from "../../workspaces/models";
import { selectOrganization, useCompanyContext } from "../../workspaces/page";
import { RecordLink } from "./entity-link";

export interface DashboardCompanyTargets {
  onObligations: (organizationId: string) => void;
  onMaturities: (organizationId: string) => void;
  onReviewQueue: (organizationId: string) => void;
  onWorkSchedule: (organizationId: string, workOrderId?: string) => void;
  onForecasting: (organizationId: string) => void;
}

function CompactPanel({ title, onOpen, children }: { title: string; onOpen?: () => void; children: ReactNode }) {
  return <section className="rmd-panel rmd-compact" aria-label={title}>
    <header className="rmd-panel-header"><h2>{title}</h2>{onOpen && <button type="button" onClick={onOpen} title={`Open ${title}`} aria-label={`Open ${title}`}><ArrowUpRight size={13} /></button>}</header>
    {children}
  </section>;
}

/**
 * Company rows on the RM-style dashboard: upcoming obligations, exceptions to
 * resolve, work due and the cash-outlook entry. Hidden without company access.
 */
export function DashboardCompanyPanels({ identity, organizationId, asOfDate, targets }: { identity: string; organizationId?: string; asOfDate: string; targets: DashboardCompanyTargets }) {
  const context = useCompanyContext(identity);
  const organization = context.data ? selectOrganization(context.data.organizations, organizationId) : undefined;
  const data = useQuery({
    queryKey: ["rent-ops-workspace", "dashboard-company", identity, organization?.id ?? "", asOfDate],
    queryFn: ({ signal }) => workspacesApi.dashboard(organization!.id, asOfDate, signal),
    enabled: Boolean(organization), staleTime: 60_000, retry: false, refetchOnWindowFocus: true,
  });
  if (!organization) return null;
  const org = organization.id;
  if (data.error) return <div className="rmd-company-grid"><div className="rmd-load-error" role="alert">Company rows could not be loaded. <button onClick={() => void data.refetch()}>Retry</button></div></div>;
  const value = data.data;
  return <div className="rmd-company-grid" aria-label="Company">
    <CompactPanel title="Upcoming obligations" onOpen={() => targets.onObligations(org)}>
      {!value ? <p className="rmd-empty">Loading…</p> : !value.obligations.items.length && !value.maturities.length ? <p className="rmd-empty">No investor payments due in the next 30 days.</p> : <ul className="rmd-rows">
        {value.obligations.items.slice(0, 5).map(item => <li key={item.obligationId}><span><strong>{item.accountName}</strong><small>{item.instrumentName} · due {formatIsoDate(item.dueOn)}</small></span><span className="number">{obligationRemaining(item)}</span></li>)}
        {value.maturities.slice(0, 3).map(item => <li key={item.instrumentId}><span><button type="button" className="rmd-row-link" onClick={() => targets.onMaturities(org)}>{item.instrumentName}</button><small>{item.accountName} · matures {formatIsoDate(item.maturityOn)}</small></span><span className="number">{item.outstandingPrincipalCents === null ? "Balance unknown" : formatCentsText(item.outstandingPrincipalCents, item.currency)}</span></li>)}
      </ul>}
      {value && value.obligations.items.length > 5 && <footer className="rmd-table-total"><span>{value.obligations.items.length}{value.obligations.truncated ? "+" : ""} due in 30 days</span></footer>}
    </CompactPanel>
    {value?.reviewCases.available !== false && <CompactPanel title="Needs attention" onOpen={() => targets.onReviewQueue(org)}>
      {!value ? <p className="rmd-empty">Loading…</p> : !value.reviewCases.openCount ? <p className="rmd-empty">No open review cases.</p> : <ul className="rmd-rows">
        {value.reviewCases.topReasons.map(reason => <li key={reason.reasonCode}><span><button type="button" className="rmd-row-link" onClick={() => targets.onReviewQueue(org)}>{humanize(reason.reasonCode)}</button>{reason.highMaterialityCount > 0 && <small>{reason.highMaterialityCount} high impact</small>}</span><span className="number">{reason.count}</span></li>)}
      </ul>}
      {value && value.reviewCases.openCount > 0 && <footer className="rmd-table-total"><span>Open cases</span><strong>{value.reviewCases.openCount}</strong></footer>}
    </CompactPanel>}
    <CompactPanel title="Work due" onOpen={() => targets.onWorkSchedule(org)}>
      {!value ? <p className="rmd-empty">Loading…</p> : !value.workDue.items.length ? <p className="rmd-empty">No work scheduled in the next 14 days.</p> : <ul className="rmd-rows">
        {value.workDue.items.slice(0, 6).map(item => <li key={item.id}><span><button type="button" className="rmd-row-link" onClick={() => targets.onWorkSchedule(org, item.id)}>{item.title}</button><small><RecordLink kind="property" recordId={item.propertyId}>{item.propertyName ?? "Property"}</RecordLink>{item.unitNumber ? ` · Unit ${item.unitNumber}` : ""}</small></span><span className={item.overdue ? "rmd-overdue" : undefined}>{item.scheduledOn ? `${item.overdue ? "Overdue · " : ""}${formatIsoDate(item.scheduledOn)}` : humanize(item.priority)}</span></li>)}
      </ul>}
      {value && value.workDue.openCount > 6 && <footer className="rmd-table-total"><span>{value.workDue.openCount} due</span></footer>}
    </CompactPanel>
    <CompactPanel title="Cash outlook" onOpen={() => targets.onForecasting(org)}>
      <p className="rmd-empty"><button type="button" className="rmd-row-link" onClick={() => targets.onForecasting(org)}>Open the 13-week cash forecast</button></p>
    </CompactPanel>
  </div>;
}
