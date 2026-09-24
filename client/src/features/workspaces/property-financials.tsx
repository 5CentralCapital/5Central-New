import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FinancialMeasure } from "@shared/workspaces/contracts";
import { EntityLink } from "../rent-ops/workspace/entity-link";
import type { ReportKey, TenantTab } from "../rent-ops/types";
import { REPORT_KEYS } from "../rent-ops/types";
import { workspacesApi } from "./api";
import { formatCentsText, formatIsoDate, formatKnownSubtotal, formatMeasure, formatMonth, sumCentsTexts } from "./format";
import { ErrorState, Loading, selectOrganization, useCompanyContext } from "./page";

const GROUPS: ReadonlyArray<[FinancialMeasure["group"], string]> = [
  ["rental", "Charges"], ["collections", "Collections"], ["balances", "Balances"], ["manager", "Property manager"], ["projects", "Projects"],
];

function MeasureRecords({ measure, currency, onOpenProject, onOpenReport }: { measure: FinancialMeasure; currency: string; onOpenProject: (projectId: string) => void; onOpenReport: (report: ReportKey) => void }) {
  const [detail, setDetail] = useState<number>();
  const shownTotal = sumCentsTexts(measure.records.map(record => record.amountCents));
  return <div className="ws-drill" id={`measure-${measure.key}`}>
    <header className="ws-drill-heading">
      <h4>{measure.label}</h4>
      {measure.report && REPORT_KEYS.includes(measure.report as ReportKey) && <button type="button" className="ws-link" onClick={() => onOpenReport(measure.report as ReportKey)}>Open report</button>}
    </header>
    <p className="ws-note">{measure.basis}{measure.unknownCount ? ` · ${measure.unknownCount} with unknown amount` : ""}</p>
    {measure.records.length === 0 ? <p className="ws-note">No contributing records.</p> : <table className="ws-table">
      <thead><tr><th scope="col">Record</th><th scope="col">Detail</th><th scope="col">Date</th><th scope="col" className="number">Amount</th></tr></thead>
      <tbody>{measure.records.map((record, index) => <tr key={index}>
        <td>{record.link?.kind === "tenant" ? <EntityLink personId={record.link.id} tab={(record.link.view ?? "summary") as TenantTab}>{record.label}</EntityLink>
          : record.link?.kind === "project" ? <button type="button" className="ws-link" onClick={() => onOpenProject(record.link!.id)}>{record.label}</button>
          : record.label}</td>
        <td>{record.detail ?? "—"}{record.sourceReferences.length > 0 && <>
          {" "}<button type="button" className="ws-link ws-link--quiet" aria-expanded={detail === index} onClick={() => setDetail(current => current === index ? undefined : index)}>Source</button>
          {detail === index && <span className="ws-source">{record.sourceReferences.join(" · ")}</span>}
        </>}</td>
        <td>{formatIsoDate(record.date)}</td>
        <td className="number">{formatCentsText(record.amountCents, currency)}</td>
      </tr>)}</tbody>
      <tfoot><tr><th scope="row" colSpan={3}>Shown total · {measure.records.length} record{measure.records.length === 1 ? "" : "s"}</th><td className="number">{formatKnownSubtotal(shownTotal.total, shownTotal.complete, currency)}</td></tr></tfoot>
    </table>}
    {measure.recordCount > measure.records.length && <p className="ws-note">Showing {measure.records.length} of {measure.recordCount}. Open the report for the full list.</p>}
  </div>;
}

/** Property record › Financials: distinct measures for one month, each opening its contributing records. */
export function PropertyFinancials({ identity, propertyId, asOfDate, organizationId, onOpenProject, onOpenReport }: {
  identity: string; propertyId: string; asOfDate: string; organizationId?: string;
  onOpenProject: (organizationId: string, projectId: string) => void; onOpenReport: (report: ReportKey) => void;
}) {
  const [month, setMonth] = useState(asOfDate.slice(0, 7));
  const [open, setOpen] = useState<FinancialMeasure["key"]>();
  const context = useCompanyContext(identity);
  const organization = context.data ? selectOrganization(context.data.organizations, organizationId) : undefined;
  // A past month is read at its last day; the current month at the workspace date.
  const asOf = month < asOfDate.slice(0, 7) ? lastDay(month) : asOfDate;
  const financials = useQuery({
    queryKey: ["rent-ops-workspace", "property-financials", identity, propertyId, month, asOf, organization?.id ?? ""],
    queryFn: ({ signal }) => workspacesApi.propertyFinancials(propertyId, { month, asOf, organizationId: organization?.id }, signal),
    enabled: !context.isLoading, staleTime: 30_000, retry: false,
  });
  return <section className="ws-page ws-financials" aria-label="Property financials">
    <div className="ws-toolbar">
      <label className="ws-field">Month<input type="month" value={month} max={asOfDate.slice(0, 7)} onChange={event => { if (event.currentTarget.value) { setMonth(event.currentTarget.value); setOpen(undefined); } }} /></label>
      {financials.data?.company?.legalEntityName && <span className="ws-note">{financials.data.company.legalEntityName}</span>}
    </div>
    {financials.error ? <ErrorState error={financials.error} onRetry={() => void financials.refetch()} />
      : !financials.data ? <Loading label="Loading financials…" />
      : <>{GROUPS.map(([group, title]) => {
        const measures = financials.data.measures.filter(item => item.group === group);
        const reasons = new Set(measures.map(item => item.unavailableReason));
        // One reason for a wholly unavailable group reads better than the same line per measure.
        if (measures.length && measures.every(item => item.state === "unavailable") && reasons.size === 1) {
          return <div className="ws-measure-group" key={group}><h3>{title}</h3><p className="ws-note">{measures[0].unavailableReason}</p></div>;
        }
        return <div className="ws-measure-group" key={group}>
          <h3>{title}</h3>
          <dl className="ws-measures">{measures.map(item => <div key={item.key} className={item.state === "unavailable" ? "is-unavailable" : undefined}>
            <dt>{item.label}</dt>
            <dd>{item.state === "unavailable" ? <span className="ws-unavailable">{item.unavailableReason}</span>
              : <button type="button" className="ws-amount" aria-expanded={open === item.key} aria-controls={`measure-${item.key}`} onClick={() => setOpen(current => current === item.key ? undefined : item.key)}>
                {formatMeasure(item.amountCents, item.complete)}
              </button>}</dd>
            <dd className="ws-basis">{item.basis}</dd>
          </div>)}</dl>
          {measures.some(item => item.key === open) && <MeasureRecords measure={measures.find(item => item.key === open)!} currency={financials.data.currency} onOpenReport={onOpenReport} onOpenProject={projectId => organization && onOpenProject(organization.id, projectId)} />}
        </div>;
      })}
      <p className="ws-note">{formatMonth(financials.data.period.month)} · balances as of {formatIsoDate(financials.data.period.asOf)}</p></>}
  </section>;
}

function lastDay(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(year, value, 0)).getUTCDate()).padStart(2, "0")}`;
}
