import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CircleAlert, Landmark, Link2, Search } from "lucide-react";
import type { FinancialSourceReference } from "@shared/accounting/source";
import type { ProjectCostLine, ProjectCostReport } from "@shared/projects/cost-report";
import type { CostSourceLine, CostSourceLinePage } from "@shared/projects/source-lines";
import type { ProjectLaborResponse } from "@shared/time/labor";
import type { ProjectDetail, ProjectExecutionDetail } from "./types";
import { formatInputValue, formatMoney, formatQualifiedMoney, incurredLabel, paidLabel, parseMoneyInput, sumCents, sumCentsByCurrency } from "./money";

function label(value: string): string { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateLabel(value: string | null | undefined): string { if (!value) return "—"; const date = new Date(`${value.slice(0, 10)}T00:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date); }
function money(value: string | null | undefined, currency: string): string { return value === null || value === undefined ? "Unknown" : formatMoney(value, currency); }
function moneyTotalsByCurrency(values: readonly { readonly cents: string | null | undefined; readonly currency: string }[]): string {
  const totals = sumCentsByCurrency(values);
  return totals.length ? totals.map(total => total.cents === null ? `${total.currency} Unknown${total.unknownCount > 1 ? ` (${total.unknownCount})` : ""}` : `${total.currency} ${formatMoney(total.cents, total.currency)}${total.unknownCount ? ` + ${total.unknownCount} unknown` : ""}`).join(" · ") : "—";
}
function hours(seconds: number): string { return (seconds / 3_600).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function tone(status: string): string { return status === "complete" || status === "on_track" || status === "settled" ? "is-positive" : status === "open" || status === "at_risk" || status === "late" || status === "partial" ? "is-warning" : status === "unknown" || status === "not_applicable" || status === "unavailable" ? "is-muted" : ""; }
function Status({ value, text }: { value: string; text?: string }) { return <span className={`projects-status ${tone(value)}`}>{text ?? label(value)}</span>; }

export function PanelState({ loading, error, onRetry, children, loadingLabel }: { loading: boolean; error?: string; onRetry?: () => void; children: ReactNode; loadingLabel: string }) {
  if (loading) return <div className="projects-state" role="status"><span>{loadingLabel}</span></div>;
  if (error) return <div className="projects-error" role="alert"><CircleAlert size={18} /><span>{error}</span>{onRetry && <button type="button" className="projects-button projects-button-secondary" onClick={onRetry}>Try again</button>}</div>;
  return <>{children}</>;
}

function CoverageBadge({ coverage }: { coverage: string }) {
  const text = coverage === "complete" ? "QBO verified" : coverage === "partial" ? "QBO partial" : "QBO unavailable";
  return <span className={`projects-execution-coverage ${coverage === "complete" ? "is-positive" : coverage === "partial" ? "is-warning" : "is-muted"}`}><Landmark size={14} />{text}</span>;
}

/** The canonical cost summary shared by Overview and Budgets & costs. */
export function ProjectCostSummary({ report }: { report: ProjectCostReport }) {
  const summary = report.summary;
  const currency = summary.currency;
  const incurred = summary.incurred;
  return <section className="projects-panel" aria-label="Cost summary">
    <div className="projects-panel-heading"><h3>Cost summary</h3><CoverageBadge coverage={summary.actualCoverage} /></div>
    <div className="projects-execution-metric-grid projects-cost-grid">
      <div><span>Original budget</span><strong>{formatMoney(summary.originalBudgetCents, currency)}</strong></div>
      <div><span>Approved changes</span><strong>{formatMoney(summary.approvedChangeCents, currency)}</strong></div>
      <div><span>Revised budget</span><strong>{formatMoney(summary.revisedBudgetCents, currency)}</strong></div>
      <div><span>Committed</span><strong>{formatMoney(summary.committedCents, currency)}</strong></div>
      <div><span>Incurred</span><strong>{incurredLabel(summary)}</strong></div>
      <div><span>Paid</span><strong>{paidLabel(summary)}</strong></div>
      <div><span>Remaining commitment</span><strong>{money(summary.remainingCommitmentCents, currency)}</strong></div>
      <div><span>Cost to complete</span><strong>{money(summary.costToCompleteCents, currency)}</strong></div>
      <div><span>Forecast final cost</span><strong>{money(summary.forecastFinalCostCents, currency)}</strong></div>
      <div><span>Variance</span><strong className={summary.varianceCents !== null && BigInt(summary.varianceCents) < BigInt(0) ? "projects-negative" : undefined}>{money(summary.varianceCents, currency)}</strong></div>
    </div>
    <dl className="projects-definition-list projects-cost-breakdown">
      <div><dt>QBO actual</dt><dd>{formatQualifiedMoney(incurred.verifiedActualCents, summary.actualCoverage, currency)}</dd></div>
      <div><dt>Posted payroll</dt><dd>{formatMoney(incurred.laborPostedCents, currency)}</dd></div>
      <div><dt>Estimated labor</dt><dd>{formatMoney(incurred.laborEstimatedCents, currency)}{incurred.unpricedLaborEntries > 0 && <small className="projects-table-subline">{incurred.unpricedLaborEntries} unpriced</small>}</dd></div>
      <div><dt>Draft costs</dt><dd>{formatMoney(summary.draftCostCents, currency)}</dd></div>
    </dl>
    {report.warnings.length > 0 && <ul className="projects-warning-list">{report.warnings.map((warning) => <li key={warning}><CircleAlert size={14} />{warning}</li>)}</ul>}
  </section>;
}

export function ProjectScheduleRiskPanel({ report, project }: { report: ProjectCostReport; project: ProjectDetail }) {
  const risk = report.schedule;
  const title = (id: string) => project.tasks.find((task) => task.id === id)?.title ?? "Task";
  return <section className="projects-panel" aria-label="Schedule risk">
    <div className="projects-panel-heading"><h3>Schedule</h3><Status value={risk.status} /></div>
    <dl className="projects-definition-list">
      <div><dt>Target</dt><dd>{dateLabel(risk.targetOn)}</dd></div>
      <div><dt>Projected finish</dt><dd>{dateLabel(risk.projectedFinishOn)}</dd></div>
      <div><dt>Open tasks</dt><dd>{risk.openTaskCount}</dd></div>
    </dl>
    {risk.lateTaskIds.length > 0 && <p className="projects-muted">Late: {risk.lateTaskIds.map(title).join(", ")}</p>}
    {risk.dependencyRiskTaskIds.length > 0 && <p className="projects-muted">Held by dependencies: {risk.dependencyRiskTaskIds.map(title).join(", ")}</p>}
  </section>;
}

export function ProjectCloseoutPanel({ report }: { report: ProjectCostReport }) {
  return <section className="projects-panel" aria-label="Closeout">
    <div className="projects-panel-heading"><h3>Closeout</h3><Status value={report.closeout.ready ? "complete" : "open"} text={report.closeout.ready ? "Ready" : "Open items"} /></div>
    <ul className="projects-checklist">{report.closeout.items.map((item) => <li key={item.key}><Status value={item.status} /><span><strong>{item.label}</strong><small className="projects-table-subline">{item.detail}</small></span></li>)}</ul>
  </section>;
}

function EtcForm({ line, currency, disabled, onSave, onCancel }: { line: ProjectCostLine; currency: string; disabled: boolean; onSave: (amountCents: string, reason: string) => void; onCancel: () => void }) {
  const [amount, setAmount] = useState(line.etcOverride ? formatInputValue(line.etcOverride.amountCents) : "");
  const [reason, setReason] = useState(line.etcOverride?.reason ?? "");
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const cents = parseMoneyInput(amount, "Cost to complete").cents;
      if (BigInt(cents) < BigInt(0)) throw new Error("Cost to complete cannot be negative.");
      if (!reason.trim()) throw new Error("A reason is required.");
      setError(undefined);
      onSave(cents, reason.trim());
    } catch (next) { setError(next instanceof Error ? next.message : "Enter a valid amount."); }
  };
  return <form className="projects-execution-form" onSubmit={submit} aria-label={`Cost to complete for ${line.description}`}>
    <div className="projects-execution-form-heading"><h4>Cost to complete · {line.description}</h4></div>
    {error && <div className="projects-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    <div className="projects-execution-form-grid">
      <label className="projects-execution-field"><span>Amount ({currency})</span><input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.currentTarget.value)} placeholder="0.00" disabled={disabled} /></label>
      <label className="projects-execution-field"><span>Reason</span><input value={reason} maxLength={300} onChange={(event) => setReason(event.currentTarget.value)} disabled={disabled} /></label>
    </div>
    <div className="projects-panel-actions"><button type="button" className="projects-button projects-button-secondary" onClick={onCancel} disabled={disabled}>Cancel</button><button type="submit" className="projects-button projects-button-primary" disabled={disabled}>Save</button></div>
  </form>;
}

/** Budget, commitment, incurred and forecast by scope line, with the cost-to-complete override. */
export function ProjectCostLinesPanel({ report, readOnly, saving, onSetEtc, onClearEtc }: { report: ProjectCostReport; readOnly: boolean; saving: boolean; onSetEtc: (scopeItemId: string, amountCents: string, reason: string) => void; onClearEtc: (scopeItemId: string) => void }) {
  const [editing, setEditing] = useState<string>();
  const currency = report.summary.currency;
  const line = report.lines.find((item) => item.scopeItemId === editing);
  const total = (pick: (item: ProjectCostLine) => string | null | undefined) => sumCents(report.lines.map(pick));
  const incurredUnknown = report.lines.filter((item) => item.incurredCents === null || item.incurredCents === undefined).length;
  return <section className="projects-panel" aria-label="Budget by line">
    <div className="projects-panel-heading"><h3>Budget by line</h3></div>
    {line && <EtcForm line={line} currency={currency} disabled={saving} onCancel={() => setEditing(undefined)} onSave={(amount, reason) => { onSetEtc(line.scopeItemId!, amount, reason); setEditing(undefined); }} />}
    {report.lines.length === 0 ? <div className="projects-state projects-empty"><strong>No budget lines</strong></div> : <div className="projects-table-wrap"><table className="projects-table">
      <thead><tr><th>Line</th><th className="projects-number">Revised</th><th className="projects-number">Committed</th><th className="projects-number">Incurred</th><th className="projects-number">Cost to complete</th><th className="projects-number">Forecast</th><th className="projects-number">Variance</th>{!readOnly && <th><span className="projects-sr-only">Actions</span></th>}</tr></thead>
      <tbody>{report.lines.map((item) => <tr key={item.key}>
        <td><strong>{item.description}</strong>{item.etcOverride && <small className="projects-table-subline">Override: {item.etcOverride.reason}</small>}</td>
        <td className="projects-number">{formatMoney(item.revisedBudgetCents, currency)}</td>
        <td className="projects-number">{formatMoney(item.committedCents, currency)}</td>
        <td className="projects-number">{formatQualifiedMoney(item.incurredCents, report.summary.actualCoverage, currency)}{BigInt(item.laborCents) !== BigInt(0) && <small className="projects-table-subline">Labor {formatMoney(item.laborCents, currency)}</small>}</td>
        <td className="projects-number">{money(item.costToCompleteCents, currency)}</td>
        <td className="projects-number">{money(item.forecastFinalCostCents, currency)}</td>
        <td className="projects-number">{money(item.varianceCents, currency)}</td>
        {!readOnly && <td className="projects-row-actions">{item.scopeItemId && <button type="button" className="projects-link-button" onClick={() => setEditing(item.scopeItemId!)} disabled={saving}>{item.etcOverride ? "Edit override" : "Override"}</button>}{item.etcOverride && <button type="button" className="projects-link-button projects-link-danger" onClick={() => onClearEtc(item.scopeItemId!)} disabled={saving}>Clear</button>}</td>}
      </tr>)}</tbody><tfoot><tr><th scope="row">Shown: {report.lines.length} budget lines</th><td className="projects-number">{formatMoney(total(item => item.revisedBudgetCents) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(total(item => item.committedCents) ?? undefined, currency)}</td><td className="projects-number">{formatQualifiedMoney(total(item => item.incurredCents), report.summary.actualCoverage, currency)}{incurredUnknown ? ` + ${incurredUnknown} unknown` : ""}</td><td className="projects-number">{formatMoney(total(item => item.costToCompleteCents) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(total(item => item.forecastFinalCostCents) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(total(item => item.varianceCents) ?? undefined, currency)}</td>{!readOnly && <td />}</tr></tfoot>
    </table></div>}
  </section>;
}

export function ProjectLaborPanel({ labor, currency, loading, error, onRetry }: { labor?: ProjectLaborResponse; currency: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <section className="projects-panel" aria-label="Labor">
    <div className="projects-panel-heading"><h3>Labor</h3></div>
    <PanelState loading={loading} error={error} onRetry={onRetry} loadingLabel="Loading labor…">
      {!labor || labor.rows.length === 0 ? <div className="projects-state projects-empty"><strong>No approved time</strong></div> : <>
        <dl className="projects-definition-list">
          <div><dt>Approved hours</dt><dd>{hours(labor.approvedSeconds)}</dd></div>
          <div><dt>Posted payroll</dt><dd>{formatMoney(labor.postedCents, currency)}</dd></div>
          <div><dt>Estimated</dt><dd>{formatMoney(labor.estimatedCents, currency)}</dd></div>
          <div><dt>Unpriced entries</dt><dd>{labor.unpricedEntries}</dd></div>
        </dl>
        {labor.truncated && <p className="projects-muted">Showing the first {labor.rows.length} entries.</p>}
      </>}
    </PanelState>
  </section>;
}

function sourceKey(source: FinancialSourceReference): string { return `${source.realmId}:${source.objectType}:${source.objectId}:${source.lineId ?? ""}:${source.version}`; }

/** Pick a posted QBO line from the mirror and bind part of it to this project. */
function FinanceBindingForm({ project, execution, disabled, search, onCreate, onCancel }: { project: ProjectDetail; execution: ProjectExecutionDetail; disabled: boolean; search: (query: { search?: string; cursor?: string }) => Promise<CostSourceLinePage>; onCreate: (payload: { source: FinancialSourceReference; allocatedCents: string; scopeItemId: string | null; commitmentId: string | null }) => void; onCancel: () => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<CostSourceLinePage>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CostSourceLine>();
  const [amount, setAmount] = useState("");
  const [scopeItemId, setScopeItemId] = useState("");
  const [commitmentId, setCommitmentId] = useState("");
  const [error, setError] = useState<string>();
  const run = async (cursor?: string) => {
    setLoading(true); setError(undefined);
    try {
      const next = await search({ search: query, cursor });
      setPage((current) => cursor && current ? { items: [...current.items, ...next.items], nextCursor: next.nextCursor } : next);
    } catch (next) { setError(next instanceof Error ? next.message : "QBO lines could not be loaded."); } finally { setLoading(false); }
  };
  useEffect(() => { void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      if (!selected) throw new Error("Choose a QBO line.");
      const cents = parseMoneyInput(amount, "Amount").cents;
      if (BigInt(cents) <= BigInt(0)) throw new Error("Amount must be positive.");
      if (BigInt(cents) > BigInt(selected.availableCents)) throw new Error("Amount exceeds the unallocated balance of this line.");
      setError(undefined);
      onCreate({ source: selected.source, allocatedCents: cents, scopeItemId: scopeItemId || null, commitmentId: commitmentId || null });
    } catch (next) { setError(next instanceof Error ? next.message : "Enter a valid amount."); }
  };
  return <form className="projects-execution-form" onSubmit={submit} aria-label="Link a QBO line">
    <div className="projects-execution-form-heading"><h4>Link a QBO line</h4></div>
    {error && <div className="projects-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    <div className="projects-source-search"><label className="projects-search"><Search size={16} /><span className="projects-sr-only">Search QBO lines</span><input value={query} placeholder="Search description or document" onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void run(); } }} /></label><button type="button" className="projects-button projects-button-secondary" onClick={() => void run()} disabled={loading}>Search</button></div>
    {loading && !page ? <div className="projects-state" role="status"><span>Loading QBO lines…</span></div> : page && page.items.length === 0 ? <div className="projects-state projects-empty"><strong>No unallocated QBO lines</strong></div> : page && <div className="projects-table-wrap projects-source-results" role="radiogroup" aria-label="QBO lines">
      <table className="projects-table"><thead><tr><th><span className="projects-sr-only">Select</span></th><th>Line</th><th>Posted</th><th className="projects-number">Available</th></tr></thead>
        <tbody>{page.items.map((item) => <tr key={sourceKey(item.source)} className={selected && sourceKey(selected.source) === sourceKey(item.source) ? "is-selected" : undefined}>
          <td><input type="radio" name="project-source-line" aria-label={item.description ?? item.transactionType} checked={!!selected && sourceKey(selected.source) === sourceKey(item.source)} onChange={() => { setSelected(item); setAmount(formatInputValue(item.availableCents)); }} /></td>
          <td><strong>{item.description ?? item.transactionType}</strong><small className="projects-table-subline">{item.transactionType}</small></td>
          <td>{dateLabel(item.postedOn)}</td>
          <td className="projects-number">{formatMoney(item.availableCents, item.currency)}</td>
        </tr>)}</tbody><tfoot><tr><th scope="row">Shown: {page.items.length} QBO lines</th><td colSpan={2}>{page.nextCursor ? "Page totals by currency" : "Filtered totals by currency"}</td><td className="projects-number">{moneyTotalsByCurrency(page.items.map(item => ({ cents: item.availableCents, currency: item.currency })))}</td></tr></tfoot>
      </table>
      {page.nextCursor && <button type="button" className="projects-load-more" onClick={() => void run(page.nextCursor!)} disabled={loading}>{loading ? "Loading…" : "Load more lines"}</button>}
    </div>}
    <div className="projects-execution-form-grid">
      <label className="projects-execution-field"><span>Amount ({project.currency})</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.currentTarget.value)} placeholder="0.00" disabled={disabled} /></label>
      <label className="projects-execution-field"><span>Scope line</span><select value={scopeItemId} onChange={(event) => setScopeItemId(event.currentTarget.value)} disabled={disabled}><option value="">Unassigned</option>{project.scopeItems.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.description}</option>)}</select></label>
      <label className="projects-execution-field"><span>Commitment</span><select value={commitmentId} onChange={(event) => setCommitmentId(event.currentTarget.value)} disabled={disabled}><option value="">None</option>{execution.commitments.filter((item) => item.status !== "void").map((item) => <option key={item.id} value={item.id}>{item.description}</option>)}</select></label>
    </div>
    <div className="projects-panel-actions"><button type="button" className="projects-button projects-button-secondary" onClick={onCancel} disabled={disabled}>Cancel</button><button type="submit" className="projects-button projects-button-primary" disabled={disabled || !selected}>Link line</button></div>
  </form>;
}

/** Verified QBO lines bound to the project, with release and the mirror line picker. */
export function ProjectFinanceBindingsPanel({ project, execution, readOnly, saving, search, onCreate, onRelease }: { project: ProjectDetail; execution: ProjectExecutionDetail; readOnly: boolean; saving: boolean; search?: (query: { search?: string; cursor?: string }) => Promise<CostSourceLinePage>; onCreate: (payload: { source: FinancialSourceReference; allocatedCents: string; scopeItemId: string | null; commitmentId: string | null }) => void; onRelease: (bindingId: string) => void }) {
  const [adding, setAdding] = useState(false);
  const actuals = execution.financeActuals;
  const scopeName = (id: string | null) => id ? project.scopeItems.find((item) => item.id === id)?.description ?? "Scope line" : "Unassigned";
  return <section className="projects-panel" aria-label="QBO costs">
    <div className="projects-panel-heading"><h3>QBO costs</h3><div className="projects-panel-actions"><CoverageBadge coverage={execution.totals.actualCoverage} />{!readOnly && search && !adding && <button type="button" className="projects-button projects-button-secondary" onClick={() => setAdding(true)} disabled={saving}><Link2 size={16} />Link QBO line</button>}</div></div>
    {adding && search && <FinanceBindingForm project={project} execution={execution} disabled={saving} search={search} onCancel={() => setAdding(false)} onCreate={(payload) => { onCreate(payload); setAdding(false); }} />}
    {actuals.length === 0 ? <div className="projects-state projects-empty"><strong>No linked QBO costs</strong></div> : <div className="projects-table-wrap"><table className="projects-table">
      <thead><tr><th>Line</th><th>Scope</th><th>Posted</th><th>Payment</th><th className="projects-number">Allocated</th>{!readOnly && <th><span className="projects-sr-only">Actions</span></th>}</tr></thead>
      <tbody>{actuals.map((actual) => <tr key={actual.id}>
        <td><strong>{actual.description}</strong><small className="projects-table-subline">{actual.transactionType ?? actual.source.objectType} {actual.source.objectId}</small></td>
        <td>{scopeName(actual.scopeItemId)}</td>
        <td>{dateLabel(actual.postedOn)}</td>
        <td>{actual.settlement ? <Status value={actual.settlement.state} /> : <Status value="unknown" />}</td>
        <td className="projects-number">{formatMoney(actual.amountCents, actual.currency)}</td>
        {!readOnly && <td className="projects-row-actions"><button type="button" className="projects-link-button projects-link-danger" onClick={() => onRelease(actual.id)} disabled={saving}>Release</button></td>}
      </tr>)}</tbody><tfoot><tr><th scope="row">Shown: {actuals.length} QBO actuals</th><td colSpan={3}>Filtered totals by currency</td><td className="projects-number">{moneyTotalsByCurrency(actuals.map(actual => ({ cents: actual.amountCents, currency: actual.currency })))}</td>{!readOnly && <td />}</tr></tfoot>
    </table></div>}
  </section>;
}

/** Commitments with derived receipts (PO receiving) and invoices (linked QBO bill lines). */
export function ProjectCommitmentLedgerPanel({ report }: { report: ProjectCostReport }) {
  const currency = report.summary.currency;
  return <section className="projects-panel" aria-label="Commitment ledger">
    <div className="projects-panel-heading"><h3>Commitment ledger</h3></div>
    {report.commitments.length === 0 ? <div className="projects-state projects-empty"><strong>No commitments</strong></div> : <div className="projects-table-wrap"><table className="projects-table">
      <thead><tr><th>Commitment</th><th>Status</th><th className="projects-number">Committed</th><th className="projects-number">Received</th><th className="projects-number">Invoiced</th><th className="projects-number">Paid</th><th className="projects-number">Remaining</th></tr></thead>
      <tbody>{report.commitments.map((row) => <tr key={row.commitmentId}>
        <td><details><summary><strong>{row.description}</strong></summary>
          {row.receipts.length > 0 && <ul className="projects-execution-list">{row.receipts.map((receipt) => <li key={receipt.purchaseOrderId}>PO {receipt.poNumber} · {label(receipt.status)} · {formatMoney(receipt.amountCents, currency)}{receipt.receivedOn ? ` · received ${dateLabel(receipt.receivedOn)}` : ""}</li>)}</ul>}
          {row.invoices.length > 0 && <ul className="projects-execution-list">{row.invoices.map((invoice) => <li key={invoice.bindingId}>{invoice.description} · {dateLabel(invoice.postedOn)} · {formatMoney(invoice.amountCents, currency)} · {label(invoice.settlementState)}</li>)}</ul>}
          {row.receipts.length === 0 && row.invoices.length === 0 && <p className="projects-muted">No receipts or invoices yet.</p>}
        </details></td>
        <td><Status value={row.status} /></td>
        <td className="projects-number">{formatMoney(row.committedCents, currency)}</td>
        <td className="projects-number">{formatMoney(row.receivedCents, currency)}{row.partialReceiptCount > 0 && <small className="projects-table-subline">{row.partialReceiptCount} partial</small>}</td>
        <td className="projects-number">{money(row.invoicedCents, currency)}</td>
        <td className="projects-number">{money(row.paidCents, currency)}</td>
        <td className="projects-number">{money(row.remainingCents, currency)}</td>
      </tr>)}</tbody><tfoot><tr><th scope="row">Shown: {report.commitments.length} commitments</th><td>Filtered totals</td><td className="projects-number">{formatMoney(sumCents(report.commitments.map(row => row.committedCents)) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(sumCents(report.commitments.map(row => row.receivedCents)) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(sumCents(report.commitments.map(row => row.invoicedCents)) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(sumCents(report.commitments.map(row => row.paidCents)) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(sumCents(report.commitments.map(row => row.remainingCents)) ?? undefined, currency)}</td></tr></tfoot>
    </table></div>}
  </section>;
}

export function ProjectRetainagePanel({ report }: { report: ProjectCostReport }) {
  const currency = report.summary.currency;
  const retainage = report.retainage;
  return <section className="projects-panel" aria-label="Retainage">
    <div className="projects-panel-heading"><h3>Retainage payable</h3></div>
    <div className="projects-execution-metric-grid">
      <div><span>Withheld</span><strong>{formatMoney(retainage.withheldCents, currency)}</strong></div>
      <div><span>Released</span><strong>{formatMoney(retainage.releasedCents, currency)}</strong></div>
      <div><span>Outstanding</span><strong>{formatMoney(retainage.outstandingCents, currency)}</strong></div>
      <div><span>Pending draws</span><strong>{formatMoney(retainage.pendingWithheldCents, currency)}</strong></div>
    </div>
    {retainage.rows.length > 0 && <div className="projects-table-wrap"><table className="projects-table">
      <thead><tr><th>Draw</th><th>Through</th><th className="projects-number">Opening</th><th className="projects-number">Withheld</th><th className="projects-number">Released</th><th className="projects-number">Closing</th></tr></thead>
      <tbody>{retainage.rows.map((row) => <tr key={row.drawRequestId}><td>Draw {row.requestNo} <Status value={row.status} /></td><td>{dateLabel(row.periodTo)}</td><td className="projects-number">{formatMoney(row.openingCents, currency)}</td><td className="projects-number">{formatMoney(row.withheldCents, currency)}</td><td className="projects-number">{formatMoney(row.releasedCents, currency)}</td><td className="projects-number">{formatMoney(row.closingCents, currency)}</td></tr>)}</tbody><tfoot><tr><th scope="row">Shown: {retainage.rows.length} draws</th><td>Period totals</td><td className="projects-number">—</td><td className="projects-number">{formatMoney(sumCents(retainage.rows.map(row => row.withheldCents)) ?? undefined, currency)}</td><td className="projects-number">{formatMoney(sumCents(retainage.rows.map(row => row.releasedCents)) ?? undefined, currency)}</td><td className="projects-number">—</td></tr></tfoot>
    </table></div>}
  </section>;
}

/** Apply a saved template to this project, or save this project's lines and tasks as a template. */
export function ProjectTemplatesPanel({ project, execution, readOnly, saving, onApply, onSaveAsTemplate }: { project: ProjectDetail; execution: ProjectExecutionDetail; readOnly: boolean; saving: boolean; onApply: (templateId: string, startOn: string | null) => void; onSaveAsTemplate: (name: string) => void }) {
  const templates = execution.templates.filter((template) => template.active && (template.currency === null || template.currency === project.currency));
  const [templateId, setTemplateId] = useState("");
  const [startOn, setStartOn] = useState(project.startOn ?? "");
  const [name, setName] = useState("");
  if (readOnly) return null;
  return <section className="projects-panel" aria-label="Templates">
    <div className="projects-panel-heading"><h3>Templates</h3></div>
    <div className="projects-execution-split">
      <form className="projects-execution-form" onSubmit={(event) => { event.preventDefault(); if (templateId) onApply(templateId, startOn || null); }} aria-label="Apply template">
        <div className="projects-execution-form-grid">
          <label className="projects-execution-field"><span>Template</span><select value={templateId} onChange={(event) => setTemplateId(event.currentTarget.value)} disabled={saving || templates.length === 0}><option value="">{templates.length ? "Choose template" : "No templates"}</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.scopeItems.length} lines · {template.tasks.length} tasks</option>)}</select></label>
          <label className="projects-execution-field"><span>Task start</span><input type="date" value={startOn} onChange={(event) => setStartOn(event.currentTarget.value)} disabled={saving} /></label>
        </div>
        <div className="projects-panel-actions"><button type="submit" className="projects-button projects-button-secondary" disabled={saving || !templateId}>Apply template</button></div>
      </form>
      <form className="projects-execution-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) { onSaveAsTemplate(name.trim()); setName(""); } }} aria-label="Save as template">
        <div className="projects-execution-form-grid"><label className="projects-execution-field"><span>Template name</span><input value={name} maxLength={200} onChange={(event) => setName(event.currentTarget.value)} disabled={saving} /></label></div>
        <div className="projects-panel-actions"><button type="submit" className="projects-button projects-button-secondary" disabled={saving || !name.trim()}>Save as template</button></div>
      </form>
    </div>
  </section>;
}
