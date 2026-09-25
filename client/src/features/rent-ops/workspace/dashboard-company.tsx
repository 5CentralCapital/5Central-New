import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { workspacesApi } from "../../workspaces/api";
import { formatCentsText, formatIsoDate, humanize } from "../../workspaces/format";
import { obligationRemaining } from "../../workspaces/models";
import { selectOrganization, useCompanyContext } from "../../workspaces/page";
import { Skeleton } from "./ops-ui";

export interface DashboardCompanyTargets {
  onObligations: (organizationId: string) => void;
  onMaturities: (organizationId: string) => void;
  onReviewQueue: (organizationId: string) => void;
  onWorkSchedule: (organizationId: string, workOrderId?: string) => void;
  onForecasting: (organizationId: string) => void;
}

/**
 * Company rows inside the dashboard's "Needs attention" list: record issues,
 * investor payments and work due. Empty lanes fold into one all-clear line
 * (design audit D3, D6). Hidden without company access.
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
  const row = (key: string, tone: string, title: ReactNode, detail: ReactNode, action?: ReactNode) => <li key={key} className="rops-attention-row" data-tone={tone}><span className="rops-attention-stripe" aria-hidden="true" /><span className="rops-attention-text"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>{action}</li>;
  if (data.error) return row("company-error", "neutral", "Company items could not be loaded.", null, <button type="button" className="rm-button rm-button--small" onClick={() => void data.refetch()}>Retry</button>);
  const value = data.data;
  if (!value) return <li className="rops-attention-row"><span className="rops-attention-stripe" aria-hidden="true" /><span className="rops-attention-text"><Skeleton width="16em" label="Loading company items" /></span></li>;
  const rows: ReactNode[] = [];
  const clear: string[] = [];
  const obligations = value.obligations.items;
  if (obligations.length || value.maturities.length) {
    const first = obligations[0];
    rows.push(row("obligations", "warning", obligations.length ? `${obligations.length}${value.obligations.truncated ? "+" : ""} investor ${obligations.length === 1 ? "payment" : "payments"} due in 30 days` : `${value.maturities.length} ${value.maturities.length === 1 ? "loan matures" : "loans mature"} soon`,
      first ? `${first.accountName} · ${first.instrumentName} · due ${formatIsoDate(first.dueOn)} · ${obligationRemaining(first)}` : value.maturities[0] ? `${value.maturities[0].instrumentName} · matures ${formatIsoDate(value.maturities[0].maturityOn)}${value.maturities[0].outstandingPrincipalCents === null ? "" : ` · ${formatCentsText(value.maturities[0].outstandingPrincipalCents, value.maturities[0].currency)}`}` : null,
      <button type="button" className="rm-button rm-button--small" onClick={() => obligations.length ? targets.onObligations(org) : targets.onMaturities(org)}>{obligations.length ? "Payment calendar" : "Maturities"}</button>));
  } else clear.push("no investor payments scheduled in the next 30 days");
  if (value.workDue.items.length) {
    const overdue = value.workDue.items.filter(item => item.overdue).length;
    const first = value.workDue.items[0];
    rows.push(row("work", overdue ? "critical" : "warning", `${value.workDue.openCount} work ${value.workDue.openCount === 1 ? "order" : "orders"} due in 14 days${overdue ? ` · ${overdue} overdue` : ""}`,
      `${first.title}${first.propertyName ? ` · ${first.propertyName}` : ""}${first.unitNumber ? ` ${first.unitNumber}` : ""}${first.scheduledOn ? ` · ${formatIsoDate(first.scheduledOn)}` : ""}`,
      <button type="button" className="rm-button rm-button--small" onClick={() => targets.onWorkSchedule(org)}>Work schedule</button>));
  } else clear.push("no work due in 14 days");
  if (value.reviewCases.available !== false && value.reviewCases.openCount > 0) {
    rows.push(row("review", "neutral", `${value.reviewCases.openCount} record ${value.reviewCases.openCount === 1 ? "issue" : "issues"} to review`,
      value.reviewCases.topReasons.slice(0, 3).map(reason => `${reason.count} ${humanize(reason.reasonCode).toLowerCase()}`).join(" · "),
      <button type="button" className="rm-button rm-button--small" onClick={() => targets.onReviewQueue(org)}>Review queue</button>));
  }
  rows.push(row("clear", "positive", null, <>{clear.length ? `All clear: ${clear.join(", ")}. ` : ""}<button type="button" className="rops-link" onClick={() => targets.onForecasting(org)}>13-week cash forecast</button></>));
  return <>{rows}</>;
}
