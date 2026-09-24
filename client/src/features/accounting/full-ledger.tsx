import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { reportRunRequestSchema, type ReportPage } from "@shared/reporting";
import { formatReportValue } from "@shared/reporting/format";
import type { ReportingApi } from "../reporting/types";
import { reportingApi } from "../reporting/api";
import { workspaceToday } from "../rent-ops/workspace/workspace-date";
import { ErrorState } from "./views";

/** Complete QuickBooks GL read through the same authorized report service as Reporting. */
export function FullGeneralLedger({ organizationId, legalEntityId, currency, api = reportingApi }: { organizationId: string; legalEntityId: string; currency: string; api?: ReportingApi }) {
  const [draft, setDraft] = useState(() => { const today = workspaceToday(); return { from: `${today.slice(0, 4)}-01-01`, through: today, basis: "cash" as "cash" | "accrual" }; });
  const [setup, setSetup] = useState(draft);
  const [cursors, setCursors] = useState<string[]>([]);
  const report = useQuery({ queryKey: ["accounting", "general-ledger", organizationId, legalEntityId, currency, setup], queryFn: () => api.run(organizationId, reportRunRequestSchema.parse({ reportId: "general-ledger", definitionVersion: "1", scope: { organizationId, legalEntityIds: [legalEntityId] }, period: { mode: "range", fromDate: setup.from, toDate: setup.through }, basis: setup.basis, currency, filters: {} })), staleTime: 300_000, retry: false, refetchOnWindowFocus: false });
  const cursor = cursors.at(-1);
  const pageQuery = useQuery({ queryKey: ["accounting", "general-ledger-page", organizationId, report.data?.run.id, cursor], queryFn: () => api.page(organizationId, report.data!.run.id, cursor), enabled: Boolean(cursor && report.data), staleTime: 300_000, retry: false });
  const page: ReportPage | undefined = cursor ? pageQuery.data : report.data?.page;
  const columns = page?.columns.filter(column => !["providerPath", "rowKind", "providerGroup", "providerTotalCents"].includes(column.id) && !column.id.endsWith("Id")) ?? [];
  const order = ["date", "transactionDate", "transactionType", "num", "name", "memoDescription", "account", "split", "debitCents", "creditCents", "amountCents", "balanceCents"];
  columns.sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : 6) - (order.includes(b.id) ? order.indexOf(b.id) : 6));
  const loading = report.isLoading || Boolean(cursor && pageQuery.isLoading);
  const error = report.error ?? (cursor ? pageQuery.error : null);
  const financial = (type: string) => type === "money" || type === "integer" || type === "percent";
  return <section aria-label="QuickBooks general ledger">
    <form className="accounting-dashboard-filters" onSubmit={event => { event.preventDefault(); if (!draft.from || !draft.through || draft.from > draft.through) return; setCursors([]); if (JSON.stringify(draft) === JSON.stringify(setup)) void report.refetch(); else setSetup(draft); }}>
      <label>From<input type="date" value={draft.from} max={draft.through} required onChange={event => setDraft({ ...draft, from: event.currentTarget.value })} /></label>
      <label>Through<input type="date" value={draft.through} min={draft.from} required onChange={event => setDraft({ ...draft, through: event.currentTarget.value })} /></label>
      <label>Basis<select value={draft.basis} onChange={event => setDraft({ ...draft, basis: event.currentTarget.value as "cash" | "accrual" })}><option value="cash">Cash</option><option value="accrual">Accrual</option></select></label>
      <button type="submit" className="accounting-button" disabled={report.isFetching || !draft.from || !draft.through || draft.from > draft.through}>{report.isFetching ? "Loading…" : "Run ledger"}</button>
    </form>
    <p className="accounting-meta">QuickBooks general ledger · {setup.from} – {setup.through} · {setup.basis === "cash" ? "Cash" : "Accrual"} basis · {currency}</p>
    {loading ? <div className="accounting-empty" role="status">Loading general ledger…</div> : error ? <ErrorState error={error} retry={() => void (cursor ? pageQuery.refetch() : report.refetch())} /> : page && <>
      {page.coverage.some(item => item.state !== "complete") && <p className="accounting-message is-warning">QuickBooks returned an incomplete report. Narrow the period to load the remaining activity.</p>}
      {!page.rows.length ? <p className="accounting-empty">No general ledger activity for this period.</p> : <div className="accounting-table-wrap"><table className="accounting-table" aria-label="Full QuickBooks general ledger"><thead><tr>{columns.map(column => <th scope="col" key={column.id} className={financial(column.type) ? "is-number" : ""}>{column.label}</th>)}</tr></thead>
        <tbody>{page.rows.map(row => <tr key={row.rowId} className={row.values.rowKind === "summary" ? "accounting-provider-total" : row.values.rowKind === "section" ? "accounting-provider-section" : ""}>{columns.map(column => <td key={column.id} className={financial(column.type) ? "is-number" : "accounting-description"}>{formatReportValue(row.values[column.id], column, row.values, currency)}</td>)}</tr>)}</tbody>
        <tfoot><tr><td colSpan={columns.length}>{page.rows.length} of {page.totalRows} report rows · Account totals from QuickBooks</td></tr></tfoot>
      </table></div>}
      {(cursor || page.nextCursor) && <nav className="accounting-pagination" aria-label="General ledger pages"><button className="accounting-button" disabled={!cursor} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button><span className="accounting-meta">Page {cursors.length + 1}</span><button className="accounting-button" disabled={!page.nextCursor} onClick={() => page.nextCursor && setCursors([...cursors, page.nextCursor])}>Next</button></nav>}
    </>}
  </section>;
}
