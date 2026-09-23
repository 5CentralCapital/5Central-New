import type { ReactNode } from "react";
import type { WorkOrderSummary } from "@shared/work-orders";
import { formatIsoDate, humanize } from "./format";
import { scheduleGroups } from "./models";
import { Badge, CompanyGate, ErrorState, Loading, StatePanel } from "./page";
import { useOpenWorkOrders } from "./work-data";

const PRIORITY_TONE: Record<string, "critical" | "warning" | "neutral"> = { emergency: "critical", high: "warning", normal: "neutral", low: "neutral" };
const weekday = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** Work Orders › Schedule: open work as an agenda by scheduled date, then unscheduled work by priority. */
export function WorkOrderSchedule({ identity, organizationId, today, onOrganization, onOpen }: {
  identity: string; organizationId?: string; today: string; onOrganization: (organizationId: string) => void; onOpen: (organizationId: string, workOrderId: string) => void;
}) {
  return <CompanyGate identity={identity} organizationId={organizationId} onOrganization={onOrganization} loadingLabel="Loading the schedule…">
    {(organization, selector) => <Agenda identity={identity} organizationId={organization.id} today={today} selector={selector} onOpen={id => onOpen(organization.id, id)} />}
  </CompanyGate>;
}

function Agenda({ identity, organizationId, today, selector, onOpen }: { identity: string; organizationId: string; today: string; selector: ReactNode; onOpen: (workOrderId: string) => void }) {
  const work = useOpenWorkOrders(identity, organizationId);
  if (work.error) return <ErrorState error={work.error} onRetry={() => void work.refetch()} />;
  if (!work.data) return <Loading label="Loading the schedule…" />;
  const groups = scheduleGroups<WorkOrderSummary>(work.data.items, today, weekday);
  return <div className="ws-page">
    {selector && <div className="ws-toolbar">{selector}</div>}
    {work.data.truncated && <p className="ws-note">Showing the first 500 open work orders.</p>}
    {!groups.length ? <StatePanel title="No open work" message="Open work orders appear here by their scheduled date." />
      : groups.map(group => <section key={group.key} className="ws-agenda-day" aria-labelledby={`agenda-${group.key}`}>
        <h2 id={`agenda-${group.key}`} className={group.key === "overdue" ? "is-overdue" : undefined}>{group.label}<span className="ws-count">{group.items.length}</span></h2>
        <ul className="ws-agenda">{group.items.map(item => <li key={item.id}>
          <button type="button" className="ws-agenda-item" onClick={() => onOpen(item.id)}>
            <span className="ws-agenda-title">{item.title}</span>
            <span className="ws-agenda-meta">{[item.propertyName, item.unitNumber ? `Unit ${item.unitNumber}` : null, item.assignedTo].filter(Boolean).join(" · ")}</span>
            <span className="ws-agenda-tags">
              {item.priority !== "normal" && <Badge tone={PRIORITY_TONE[item.priority] ?? "neutral"}>{humanize(item.priority)}</Badge>}
              <Badge tone={item.status === "in_progress" ? "info" : "neutral"}>{humanize(item.status)}</Badge>
              {group.key === "overdue" && item.scheduledOn && <span className="ws-note">Scheduled {formatIsoDate(item.scheduledOn)}</span>}
              {group.key === "unscheduled" && <span className="ws-note">Reported {formatIsoDate(item.reportedOn)}</span>}
            </span>
          </button>
        </li>)}</ul>
      </section>)}
  </div>;
}
