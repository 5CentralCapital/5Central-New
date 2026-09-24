import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { reportingApi } from "../reporting/api";
import type { ReportingApi } from "../reporting/types";
import { workspaceToday } from "../rent-ops/workspace/workspace-date";
import { dateLabel, dateTimeLabel, formatCents } from "./format";
import { BALANCE_LINES, PROFIT_LINES, financialFigure, financialRequest, loadDashboardReport, reportIsComplete, type DashboardReport, type DashboardSetup } from "./dashboard-model";
import { financialReportHref } from "./report-links";
import { EmptyState, ErrorState } from "./views";

function Figure({ label, amount, pending, accent = false, currency }: { label: string; amount: string | null; pending: boolean; accent?: boolean; currency: string }) {
  return <div className={`accounting-financial-figure${accent ? " is-accent" : ""}`}><dt>{label}</dt><dd>{pending ? "Loading…" : amount === null ? "Unavailable" : formatCents(amount, currency)}</dd></div>;
}

function Statement({ title, report, loading, error, retry, lines, finalGroup, currency, date }: { title: string; report?: DashboardReport; loading: boolean; error: unknown; retry: () => void; lines: readonly (readonly [string, string])[]; finalGroup: string; currency: string; date: string }) {
  const visible = lines.filter(([group]) => group !== finalGroup && financialFigure(report, group) !== null);
  const final = lines.find(([group]) => group === finalGroup)!;
  return <section className="accounting-card accounting-statement"><header className="accounting-card-header"><div><h3>{title}</h3><span className="accounting-meta">{date}</span></div></header>
    {loading ? <div className="accounting-card-body" role="status">Loading QuickBooks report…</div> : error ? <ErrorState error={error} retry={retry} /> : report && !reportIsComplete(report) ? <div className="accounting-card-body" role="status">QuickBooks returned an incomplete report. <button className="accounting-button" onClick={retry}>Try again</button></div> : <div className="accounting-table-wrap is-flush"><table className="accounting-table" aria-label={title}>
      <thead><tr><th scope="col">Category</th><th scope="col" className="is-number">{currency}</th></tr></thead>
      <tbody>{visible.map(([group, label]) => <tr key={group}><th scope="row">{label}</th><td className="is-number">{formatCents(financialFigure(report, group), currency)}</td></tr>)}</tbody>
      <tfoot><tr><th scope="row">{final[1]}</th><td className="is-number">{financialFigure(report, finalGroup) === null ? "Unavailable" : formatCents(financialFigure(report, finalGroup), currency)}</td></tr></tfoot>
    </table></div>}
    {report && <div className="accounting-card-footer accounting-meta">QuickBooks · Updated {dateTimeLabel(report.generatedAt)}</div>}
  </section>;
}

export function FinancialDashboard({ organizationId, legalEntityId, currency, connected, onConnections, api = reportingApi }: { organizationId: string; legalEntityId: string; currency: string; connected: boolean; onConnections: () => void; api?: ReportingApi }) {
  const [draft, setDraft] = useState<DashboardSetup>(() => { const today = workspaceToday(); return { from: `${today.slice(0, 4)}-01-01`, through: today, basis: "cash" }; });
  const [setup, setSetup] = useState(draft);
  const pnl = useQuery({ queryKey: ["accounting", "financial-dashboard", organizationId, legalEntityId, currency, "income-statement", setup], queryFn: ({ signal }) => loadDashboardReport(api, financialRequest(organizationId, legalEntityId, currency, "income-statement", setup), signal), enabled: connected, staleTime: 300_000, retry: false, refetchOnWindowFocus: false });
  const balance = useQuery({ queryKey: ["accounting", "financial-dashboard", organizationId, legalEntityId, currency, "balance-sheet", setup], queryFn: ({ signal }) => loadDashboardReport(api, financialRequest(organizationId, legalEntityId, currency, "balance-sheet", setup), signal), enabled: connected, staleTime: 300_000, retry: false, refetchOnWindowFocus: false });
  const valid = Boolean(draft.from && draft.through && draft.from <= draft.through);
  const changed = JSON.stringify(draft) !== JSON.stringify(setup);
  const reportLink = (reportId: string) => financialReportHref(organizationId, legalEntityId, reportId, setup);
  if (!connected) return <EmptyState title="Connect QuickBooks to see your financial dashboard" detail="Select the matching QuickBooks company for this legal entity." action={{ label: "Open connections", onClick: onConnections }} />;
  return <div className="accounting-financial-dashboard">
    <form className="accounting-dashboard-filters" onSubmit={event => { event.preventDefault(); if (!valid) return; if (changed) setSetup(draft); else { void pnl.refetch(); void balance.refetch(); } }}>
      <label>From<input type="date" value={draft.from} max={draft.through} required onChange={event => setDraft({ ...draft, from: event.currentTarget.value })} /></label>
      <label>Through<input type="date" value={draft.through} min={draft.from} required onChange={event => setDraft({ ...draft, through: event.currentTarget.value })} /></label>
      <label>Basis<select value={draft.basis} onChange={event => setDraft({ ...draft, basis: event.currentTarget.value as DashboardSetup["basis"] })}><option value="cash">Cash</option><option value="accrual">Accrual</option></select></label>
      <button type="submit" className="accounting-button" disabled={!valid || pnl.isFetching || balance.isFetching}>{pnl.isFetching || balance.isFetching ? "Loading…" : changed ? "Apply" : "Refresh dashboard"}</button>
    </form>
    <div className="accounting-dashboard-heading"><h2>Profit & loss</h2><span>{dateLabel(setup.from)} – {dateLabel(setup.through)} · {setup.basis === "cash" ? "Cash" : "Accrual"} basis · {currency}</span></div>
    <dl className="accounting-financial-grid">
      <Figure label="Income" amount={pnl.isError ? null : financialFigure(pnl.data, "Income")} pending={pnl.isLoading} currency={currency} />
      <Figure label="Operating expenses" amount={pnl.isError ? null : financialFigure(pnl.data, "Expenses")} pending={pnl.isLoading} currency={currency} />
      <Figure label="Net income" amount={pnl.isError ? null : financialFigure(pnl.data, "NetIncome")} pending={pnl.isLoading} currency={currency} accent />
    </dl>
    <div className="accounting-dashboard-heading"><h2>Financial position</h2><span>As of {dateLabel(setup.through)}</span></div>
    <dl className="accounting-financial-grid">
      {BALANCE_LINES.slice(0, 3).map(([group, label]) => <Figure key={group} label={label} amount={balance.isError ? null : financialFigure(balance.data, group)} pending={balance.isLoading} currency={currency} />)}
    </dl>
    <div className="accounting-dashboard-statements">
      <Statement title="Profit & loss summary" report={pnl.isError ? undefined : pnl.data} loading={pnl.isLoading} error={pnl.error} retry={() => void pnl.refetch()} lines={PROFIT_LINES} finalGroup="NetIncome" currency={currency} date={`${dateLabel(setup.from)} – ${dateLabel(setup.through)}`} />
      <Statement title="Balance sheet summary" report={balance.isError ? undefined : balance.data} loading={balance.isLoading} error={balance.error} retry={() => void balance.refetch()} lines={BALANCE_LINES} finalGroup="LiabilitiesAndEquity" currency={currency} date={`As of ${dateLabel(setup.through)}`} />
    </div>
    <nav className="accounting-report-links" aria-label="Full QuickBooks reports">{[["income-statement", "Profit & loss"], ["balance-sheet", "Balance sheet"], ["cash-flow-statement", "Cash flow"], ["general-ledger", "General ledger"], ["trial-balance", "Trial balance"]].map(([id, label]) => <a key={id} className="accounting-button" href={reportLink(id)}>{label}</a>)}</nav>
  </div>;
}
