import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link2, LoaderCircle } from "lucide-react";
import type { TimeConnectionScope, TimeEntry } from "@shared/time";
import type { CostSourceLine } from "@shared/projects/source-lines";
import type { TimeApi, TimePayrollLink } from "./types";
import { sumTimeMoneyByCurrency, type TimeMoneyValue } from "./totals";

function money(value: string | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const cents = BigInt(value);
  const negative = cents < BigInt(0);
  const absolute = (negative ? -cents : cents).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${currency ?? ""} ${absolute.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${absolute.slice(-2)}`.trim();
}
function moneyTotals(values: readonly TimeMoneyValue[]): string {
  const totals = sumTimeMoneyByCurrency(values);
  if (!totals.length) return "—";
  return totals.map(total => total.knownCount === 0 ? `${total.currency === "Unknown currency" ? "Unknown currency" : "Unknown"}${total.unknownCount > 1 ? ` (${total.unknownCount})` : ""}` : `${money(total.cents!, total.currency)}${total.unknownCount ? ` + ${total.unknownCount} unknown` : ""}`).join(" · ");
}
function dateLabel(value: string | null | undefined): string { if (!value) return "—"; const date = new Date(`${value.slice(0, 10)}T00:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date); }
function lineKey(line: CostSourceLine): string { return `${line.source.realmId}|${line.source.objectType}|${line.source.objectId}|${line.source.lineId ?? ""}|${line.source.version}`; }
function centsFromText(value: string): string | null { const trimmed = value.trim(); if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed)) return null; const [whole, fraction = ""] = trimmed.split("."); return (BigInt(whole!) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))).toString(); }

/** Coverage of approved time by posted payroll, plus linking a QBO payroll line to a pay period. */
export function PayrollPanel({ api, organizationId, scope, entries, saving, execute }: { api: TimeApi; organizationId: string; scope: TimeConnectionScope; entries: readonly TimeEntry[]; saving: boolean; execute: (kind: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [links, setLinks] = useState<readonly TimePayrollLink[]>();
  const [linksError, setLinksError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<readonly CostSourceLine[]>();
  const [linesLoading, setLinesLoading] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodThrough, setPeriodThrough] = useState("");
  const [formError, setFormError] = useState<string>();
  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!api.listPayrollLinks) return;
    setLinksError(undefined);
    try { const next = await api.listPayrollLinks(organizationId, scope.legalEntityId, signal); if (!signal?.aborted) setLinks(next); }
    catch (reason) { if (!signal?.aborted) setLinksError(reason instanceof Error ? reason.message : "Payroll links could not be loaded."); }
  }, [api, organizationId, scope.legalEntityId]);
  useEffect(() => { const controller = new AbortController(); void reload(controller.signal); return () => controller.abort(); }, [reload]);
  const findLines = async () => {
    if (!api.searchPayrollLines) return;
    setLinesLoading(true); setFormError(undefined);
    try { const page = await api.searchPayrollLines(organizationId, { legalEntityId: scope.legalEntityId, search }); setLines(page.items); }
    catch (reason) { setFormError(reason instanceof Error ? reason.message : "QBO payroll lines could not be loaded."); }
    finally { setLinesLoading(false); }
  };
  useEffect(() => { if (adding && !lines) void findLines(); }, [adding]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!api.listPayrollLinks) return null;
  const approved = entries.filter((entry) => entry.reviewState === "approved");
  const posted = approved.filter((entry) => entry.postedPayrollCents !== null).length;
  const estimated = approved.filter((entry) => entry.postedPayrollCents === null && entry.estimatedLaborCostCents !== null).length;
  const unpriced = approved.length - posted - estimated;
  const line = lines?.find((item) => lineKey(item) === selected);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cents = centsFromText(amount);
    if (!line) { setFormError("Choose a QBO payroll line."); return; }
    if (!cents || BigInt(cents) <= BigInt(0) || BigInt(cents) > BigInt(line.availableCents)) { setFormError("Enter an amount up to the unallocated balance of the line."); return; }
    if (!periodFrom || !periodThrough || periodThrough < periodFrom) { setFormError("Choose the pay period."); return; }
    setFormError(undefined);
    await execute("time.payroll.link", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, source: line.source, amountCents: cents, periodFrom, periodThrough });
    setAdding(false); setLines(undefined); setSelected(""); setAmount("");
    await reload();
  };
  const release = async (link: TimePayrollLink) => {
    const reason = typeof window === "undefined" ? "Released" : window.prompt("Reason for releasing this payroll link");
    if (!reason?.trim()) return;
    await execute("time.payroll.unlink", { environment: scope.environment, providerCompanyId: scope.providerCompanyId, batchId: link.batchId, reason: reason.trim() });
    await reload();
  };
  return <section className="time-card time-payroll" aria-label="Posted payroll">
    <div className="time-card-header"><div><h3>Posted payroll</h3></div>{api.searchPayrollLines && !adding && <button type="button" className="time-button time-button-secondary" onClick={() => setAdding(true)} disabled={saving}><Link2 size={14} />Link payroll</button>}</div>
    <div className="time-metrics"><div><span>Approved entries</span><strong>{approved.length}</strong></div><div><span>Posted payroll</span><strong>{posted}</strong></div><div><span>Estimate only</span><strong>{estimated}</strong></div><div><span>Unpriced</span><strong>{unpriced}</strong></div></div>
    {adding && <form className="time-form time-form-grid" onSubmit={(event) => void submit(event)} aria-label="Link payroll">
      {formError && <div className="time-message is-error time-form-wide" role="alert">{formError}</div>}
      <label>Pay period start<input type="date" value={periodFrom} onChange={(event) => setPeriodFrom(event.currentTarget.value)} /></label>
      <label>Pay period end<input type="date" value={periodThrough} onChange={(event) => setPeriodThrough(event.currentTarget.value)} /></label>
      <label className="time-form-wide">Find QBO line<span className="time-inline"><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Description or document" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void findLines(); } }} /><button type="button" className="time-button time-button-secondary" onClick={() => void findLines()} disabled={linesLoading}>Search</button></span></label>
      <label className="time-form-wide">QBO payroll line<select value={selected} onChange={(event) => { setSelected(event.currentTarget.value); const next = lines?.find((item) => lineKey(item) === event.currentTarget.value); if (next) setAmount(money(next.availableCents, null).replace(/,/g, "")); }} disabled={linesLoading}><option value="">{linesLoading ? "Loading lines…" : lines?.length ? "Choose line" : "No unallocated lines"}</option>{lines?.map((item) => <option key={lineKey(item)} value={lineKey(item)}>{dateLabel(item.postedOn)} · {item.description ?? item.transactionType} · {money(item.availableCents, item.currency)} available</option>)}</select></label>
      <label>Amount<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.currentTarget.value)} placeholder="0.00" /></label>
      <div className="time-form-actions time-form-wide"><button type="button" className="time-button time-button-secondary" onClick={() => { setAdding(false); setFormError(undefined); }} disabled={saving}>Cancel</button><button type="submit" className="time-button time-button-primary" disabled={saving || !line}>Link payroll</button></div>
    </form>}
    {linksError ? <div className="time-message is-error" role="alert">{linksError}</div> : !links ? <div className="time-empty time-empty-small" role="status"><LoaderCircle size={16} className="time-spin" />Loading payroll links…</div> : links.length === 0 ? <div className="time-empty time-empty-small">No posted payroll linked yet.</div> : <div className="time-table-wrap"><table className="time-table"><thead><tr><th>Pay period</th><th>Posted</th><th>Entries</th><th className="time-number">Amount</th><th>Status</th><th><span className="time-sr-only">Actions</span></th></tr></thead><tbody>{links.map((link) => <tr key={link.batchId}><td>{dateLabel(link.periodFrom)} – {dateLabel(link.periodThrough)}</td><td>{dateLabel(link.postedOn)}</td><td>{link.timesheetCount}</td><td className="time-number">{money(link.amountCents, link.currency)}</td><td><span className={`time-badge ${link.status === "active" ? "is-positive" : ""}`}>{link.status === "active" ? "Linked" : "Released"}</span></td><td>{link.status === "active" && <button type="button" className="time-button time-button-secondary" onClick={() => void release(link)} disabled={saving}>Release</button>}</td></tr>)}</tbody><tfoot><tr><th scope="row">Shown: {links.length} payroll links</th><td>State totals</td><td>{links.reduce((total, link) => total + link.timesheetCount, 0)}</td><td className="time-number">Linked {moneyTotals(links.filter(link => link.status === "active").map(link => ({ cents: link.amountCents, currency: link.currency })))} · Released {moneyTotals(links.filter(link => link.status !== "active").map(link => ({ cents: link.amountCents, currency: link.currency })))}</td><td colSpan={2}>Statuses kept separate</td></tr></tfoot></table></div>}
  </section>;
}
