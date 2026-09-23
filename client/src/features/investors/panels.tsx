import { useEffect, useMemo, useState } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import type { InvestorDetail, InvestorPayment } from "@shared/investors";
import type { InvestorCalendarState } from "@shared/investors/rollforward";
import type { InvestorDebtMaturity, InvestorInstrumentFinancials, InvestorPaymentCalendarItem } from "@shared/investors/reports";
import type { InvestorsApi } from "./types";

function label(value: string | null | undefined): string { return value ? value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "—"; }
function dateLabel(value: string | null | undefined): string { if (!value) return "—"; const date = new Date(`${value.slice(0, 10)}T00:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date); }
function monthLabel(value: string): string { const date = new Date(`${value.slice(0, 10)}T00:00:00`); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(date); }
export function formatInvestorMoney(value: string | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined) return "Unknown";
  const amount = BigInt(value);
  const negative = amount < BigInt(0);
  const absolute = (negative ? -amount : amount).toString().padStart(3, "0");
  const whole = absolute.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${whole}.${absolute.slice(-2)}`;
}
const money = formatInvestorMoney;
function stateTone(state: string): string { return state === "settled" || state === "matches" ? "is-positive" : state === "overdue" || state === "review" || state === "partial" || state === "overpaid" || state === "mismatch" ? "is-warning" : state === "reversed" || state === "unknown" || state === "manual_missing" ? "is-muted" : ""; }
function Badge({ value, text }: { value: string; text?: string }) { return <span className={`investors-status ${stateTone(value)}`}>{text ?? label(value)}</span>; }
function Loading({ text }: { text: string }) { return <div className="investors-state" role="status"><LoaderCircle size={17} className="investors-spin" />{text}</div>; }
function Failure({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="investors-error" role="alert"><CircleAlert size={17} /><span>{message}</span><button type="button" className="investors-button investors-button-secondary" onClick={onRetry}>Retry</button></div>; }
function shiftMonth(month: string, offset: number): string { const [year, monthNumber] = month.split("-").map(Number); const index = year! * 12 + monthNumber! - 1 + offset; return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}-01`; }

export const CALENDAR_STATE_LABELS: Readonly<Record<InvestorCalendarState, string>> = { scheduled: "Scheduled", overdue: "Overdue", partial: "Partial", recorded: "Recorded", posted: "Posted", settled: "Settled", overpaid: "Overpaid", review: "Needs review", reversed: "Reversed" };

/** Month-by-month obligations for one investor across its legal entities. */
export function PaymentCalendarPanel({ api, organizationId, detail, month }: { api: InvestorsApi; organizationId: string; detail: InvestorDetail; month: string }) {
  const [anchor, setAnchor] = useState(month);
  const [items, setItems] = useState<readonly InvestorPaymentCalendarItem[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const entities = useMemo(() => Array.from(new Set(detail.instruments.map((item) => String(item.legalEntityId)))), [detail.instruments]);
  const fromMonth = shiftMonth(anchor, -2);
  const throughMonth = shiftMonth(anchor, 3);
  useEffect(() => {
    if (!api.getPaymentCalendar) return;
    const controller = new AbortController();
    setItems(undefined); setError(undefined);
    void (async () => {
      try {
        const collected: InvestorPaymentCalendarItem[] = [];
        for (const legalEntityId of entities) {
          let cursor: string | undefined;
          do {
            const page = await api.getPaymentCalendar!(organizationId, { legalEntityId, fromMonth, throughMonth, accountId: String(detail.id), cursor }, controller.signal);
            collected.push(...page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor && !controller.signal.aborted);
        }
        collected.sort((left, right) => left.dueOn.localeCompare(right.dueOn) || left.instrumentName.localeCompare(right.instrumentName));
        if (!controller.signal.aborted) setItems(collected);
      } catch (next) {
        if (!controller.signal.aborted) setError(next instanceof Error ? next.message : "The payment calendar could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [api, attempt, detail.id, entities, fromMonth, organizationId, throughMonth]);
  if (!api.getPaymentCalendar) return null;
  const months = Array.from({ length: 6 }, (_, index) => shiftMonth(fromMonth, index));
  return <div className="investors-card" aria-label="Payment calendar">
    <div className="investors-card-header"><h3>Payment calendar</h3><div className="investors-toolbar-actions"><button type="button" className="investors-button investors-button-secondary" onClick={() => setAnchor(shiftMonth(anchor, -3))} aria-label="Earlier months">Earlier</button><button type="button" className="investors-button investors-button-secondary" onClick={() => setAnchor(month)}>This month</button><button type="button" className="investors-button investors-button-secondary" onClick={() => setAnchor(shiftMonth(anchor, 3))} aria-label="Later months">Later</button></div></div>
    {error ? <Failure message={error} onRetry={() => setAttempt((value) => value + 1)} /> : !items ? <Loading text="Loading calendar…" /> : items.length === 0 ? <div className="investors-empty"><h4>No obligations</h4><p>Nothing is scheduled from {monthLabel(fromMonth)} to {monthLabel(throughMonth)}.</p></div> : <div className="investors-calendar">{months.map((value) => {
      const rows = items.filter((item) => item.periodMonth === value);
      return <section key={value} className="investors-calendar-month" aria-label={monthLabel(value)}><h4>{monthLabel(value)}</h4>{rows.length === 0 ? <p className="investors-muted">No obligations</p> : <ul>{rows.map((item) => <li key={item.obligationId}><div className="investors-stack"><strong>{item.instrumentName}</strong><small>Due {dateLabel(item.dueOn)}</small></div><div className="investors-calendar-amounts"><span>{item.expectedCents === null ? `${money(item.knownMinimumCents, item.currency)} + unknown` : money(item.expectedCents, item.currency)}</span>{item.remainingCents !== null && BigInt(item.remainingCents) > BigInt(0) && item.state !== "scheduled" && item.state !== "overdue" && <small>{money(item.remainingCents, item.currency)} remaining</small>}</div><Badge value={item.state} text={CALENDAR_STATE_LABELS[item.state]} /></li>)}</ul>}</section>;
    })}</div>}
  </div>;
}

const CAPITAL_KINDS = new Set(["contribution", "return_of_capital", "distribution"]);

function verified(payment: InvestorPayment): boolean { return (payment.status === "qbo_posted" && payment.postedSourceValidity === "current") || (payment.status === "bank_settled" && payment.settlementSource !== null); }

/** Capital contributed, returned and distributed by instrument, with the underlying activity. */
export function CapitalPanel({ detail }: { detail: InvestorDetail }) {
  const byId = new Map(detail.payments.map((payment) => [String(payment.id), payment]));
  const kindOf = (payment: InvestorPayment): string => payment.reversesPaymentId ? byId.get(String(payment.reversesPaymentId))?.kind ?? payment.kind : payment.kind;
  const activity = detail.payments.filter((payment) => CAPITAL_KINDS.has(kindOf(payment)));
  const rows = detail.instruments.map((instrument) => {
    const own = activity.filter((payment) => String(payment.instrumentId) === String(instrument.id) && payment.currency === instrument.currency);
    const sum = (kind: string, onlyVerified: boolean) => own.filter((payment) => kindOf(payment) === kind && (!onlyVerified || verified(payment.reversesPaymentId ? byId.get(String(payment.reversesPaymentId)) ?? payment : payment))).reduce((total, payment) => total + BigInt(kind === "distribution" ? payment.amounts.distributionCents : kind === "return_of_capital" ? payment.amounts.returnOfCapitalCents : payment.amountCents), BigInt(0));
    return { instrument, contributed: sum("contribution", false), contributedVerified: sum("contribution", true), returned: sum("return_of_capital", false), distributed: sum("distribution", false) };
  });
  return <div className="investors-panel">
    <div className="investors-card"><div className="investors-card-header"><h3>Contributions & distributions</h3></div><div className="investors-table-wrap"><table className="investors-table"><thead><tr><th>Instrument</th><th className="amount">Committed</th><th className="amount">Contributed</th><th className="amount">Verified</th><th className="amount">Returned</th><th className="amount">Distributed</th><th className="amount">Net invested</th></tr></thead><tbody>{rows.map((row) => <tr key={row.instrument.id}><td><div className="investors-stack"><strong>{row.instrument.name}</strong><small>{label(row.instrument.kind)}</small></div></td><td className="amount">{money(row.instrument.committedCents, row.instrument.currency)}</td><td className="amount">{money(row.contributed.toString(), row.instrument.currency)}</td><td className="amount">{money(row.contributedVerified.toString(), row.instrument.currency)}</td><td className="amount">{money(row.returned.toString(), row.instrument.currency)}</td><td className="amount">{money(row.distributed.toString(), row.instrument.currency)}</td><td className="amount">{money((row.contributed - row.returned).toString(), row.instrument.currency)}</td></tr>)}</tbody></table>{!rows.length && <div className="investors-empty"><h4>No investments</h4></div>}</div></div>
    <div className="investors-card"><div className="investors-card-header"><h3>Capital activity</h3></div><div className="investors-table-wrap"><table className="investors-table"><thead><tr><th>Date</th><th>Instrument</th><th>Kind</th><th className="amount">Amount</th><th>Status</th></tr></thead><tbody>{activity.map((payment) => <tr key={payment.id}><td>{dateLabel(payment.paymentOn)}</td><td>{detail.instruments.find((item) => String(item.id) === String(payment.instrumentId))?.name ?? "—"}</td><td>{payment.reversesPaymentId ? `Reversal · ${label(kindOf(payment))}` : label(payment.kind)}</td><td className="amount">{money(payment.amountCents, payment.currency)}</td><td><Badge value={payment.status} /></td></tr>)}</tbody></table>{!activity.length && <div className="investors-empty"><h4>No capital activity</h4></div>}</div></div>
  </div>;
}

/** Maturity ladder for this investor's debt and one instrument's schedule and rollforward. */
export function DebtMaturitiesPanel({ api, organizationId, detail }: { api: InvestorsApi; organizationId: string; detail: InvestorDetail }) {
  const debtInstruments = detail.instruments.filter((item) => item.kind === "private_loan" || item.kind === "member_loan");
  const [ladder, setLadder] = useState<readonly InvestorDebtMaturity[]>();
  const [ladderError, setLadderError] = useState<string>();
  const [selected, setSelected] = useState(String(debtInstruments[0]?.id ?? ""));
  const [financials, setFinancials] = useState<InvestorInstrumentFinancials>();
  const [financialsError, setFinancialsError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const entities = useMemo(() => Array.from(new Set(debtInstruments.map((item) => String(item.legalEntityId)))), [debtInstruments]);
  useEffect(() => {
    if (!api.getDebtMaturities || !entities.length) { setLadder([]); return; }
    const controller = new AbortController();
    setLadder(undefined); setLadderError(undefined);
    void Promise.all(entities.map((legalEntityId) => api.getDebtMaturities!(organizationId, { legalEntityId }, controller.signal)))
      .then((pages) => { if (!controller.signal.aborted) setLadder(pages.flatMap((page) => page.items).filter((item) => String(item.accountId) === String(detail.id)).sort((left, right) => (left.maturityOn ?? "9999").localeCompare(right.maturityOn ?? "9999"))); })
      .catch((next) => { if (!controller.signal.aborted) setLadderError(next instanceof Error ? next.message : "Maturities could not be loaded."); });
    return () => controller.abort();
  }, [api, attempt, detail.id, entities, organizationId]);
  useEffect(() => {
    const instrument = debtInstruments.find((item) => String(item.id) === selected);
    if (!api.getInstrumentFinancials || !instrument) { setFinancials(undefined); return; }
    const controller = new AbortController();
    setFinancials(undefined); setFinancialsError(undefined);
    void api.getInstrumentFinancials(organizationId, String(instrument.id), { legalEntityId: String(instrument.legalEntityId) }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setFinancials(value); })
      .catch((next) => { if (!controller.signal.aborted) setFinancialsError(next instanceof Error ? next.message : "The schedule could not be loaded."); });
    return () => controller.abort();
  }, [api, attempt, debtInstruments, organizationId, selected]);
  if (!debtInstruments.length || !api.getDebtMaturities) return null;
  const currency = financials?.currency ?? "USD";
  const rollforward = financials?.rollforward;
  const amortization = financials?.amortization;
  return <>
    <div className="investors-card" aria-label="Maturity ladder"><div className="investors-card-header"><h3>Maturities</h3></div>
      {ladderError ? <Failure message={ladderError} onRetry={() => setAttempt((value) => value + 1)} /> : !ladder ? <Loading text="Loading maturities…" /> : <div className="investors-table-wrap"><table className="investors-table"><thead><tr><th>Instrument</th><th>Maturity</th><th className="amount">Months</th><th className="amount">Balloon</th><th className="amount">Outstanding</th><th>Balance check</th></tr></thead><tbody>{ladder.map((row) => <tr key={row.instrumentId}><td><strong>{row.instrumentName}</strong></td><td>{dateLabel(row.maturityOn)}</td><td className="amount">{row.monthsToMaturity ?? "—"}</td><td className="amount">{row.balloonSource === "none" ? "—" : `${money(row.balloonCents, row.currency)}${row.balloonSource === "computed" ? " est." : ""}`}</td><td className="amount">{money(row.derivedOutstandingCents, row.currency)}</td><td><Badge value={row.reconciliation} text={row.reconciliation === "mismatch" ? `Manual ${money(row.manualOutstandingCents, row.currency)}` : row.reconciliation === "matches" ? "Matches" : row.reconciliation === "manual_missing" ? "No manual balance" : "Unknown"} /></td></tr>)}</tbody></table></div>}
    </div>
    <div className="investors-card" aria-label="Debt schedule"><div className="investors-card-header"><h3>Schedule and balance</h3>{debtInstruments.length > 1 && <select aria-label="Debt instrument" value={selected} onChange={(event) => setSelected(event.currentTarget.value)}>{debtInstruments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</div>
      {financialsError ? <Failure message={financialsError} onRetry={() => setAttempt((value) => value + 1)} /> : !financials ? <Loading text="Loading schedule…" /> : <>
        <div className="investors-metrics"><div><span>Derived outstanding</span><strong>{money(rollforward?.derivedOutstandingCents, currency)}</strong></div><div><span>Manual outstanding</span><strong>{money(rollforward?.manualOutstandingCents, currency)}</strong></div><div><span>Unclassified receipts</span><strong>{money(rollforward?.unclassifiedTotalCents, currency)}</strong></div><div><span>Guaranteed return left</span><strong>{rollforward?.guaranteedReturn ? money(rollforward.guaranteedReturn.remainingCents, currency) : "—"}</strong></div></div>
        {rollforward?.reconciliation === "mismatch" && <div className="investors-error" role="status"><CircleAlert size={17} /><span>Recorded activity implies {money(rollforward.derivedOutstandingCents, currency)} outstanding; the manual balance is {money(rollforward.manualOutstandingCents, currency)}.</span></div>}
        {amortization && amortization.status !== "ready" && <p className="investors-note">{amortization.warnings[0] ?? "The schedule cannot be projected from these terms."}</p>}
        {amortization && amortization.rows.length > 0 && <details className="investors-form-section" open><summary>Debt service{amortization.levelPaymentCents ? ` · level payment ${money(amortization.levelPaymentCents, currency)}` : ""}</summary><div className="investors-table-wrap"><table className="investors-table"><thead><tr><th>Due</th><th>Phase</th><th className="amount">Opening</th><th className="amount">Interest</th><th className="amount">Principal</th><th className="amount">Balloon</th><th className="amount">Payment</th><th className="amount">Closing</th></tr></thead><tbody>{amortization.rows.map((row) => <tr key={row.periodMonth}><td>{dateLabel(row.dueOn)}</td><td>{label(row.phase)}</td><td className="amount">{money(row.openingCents, currency)}</td><td className="amount">{money(row.interestCents, currency)}</td><td className="amount">{money(row.principalCents, currency)}</td><td className="amount">{row.balloonCents === "0" ? "—" : money(row.balloonCents, currency)}</td><td className="amount">{money(row.paymentCents, currency)}</td><td className="amount">{money(row.closingCents, currency)}</td></tr>)}</tbody></table></div></details>}
        {rollforward && rollforward.rows.length > 0 && <details className="investors-form-section"><summary>Monthly rollforward</summary><div className="investors-table-wrap"><table className="investors-table"><thead><tr><th>Month</th><th className="amount">Opening</th><th className="amount">Funded</th><th className="amount">Principal repaid</th><th className="amount">Interest paid</th><th className="amount">Unclassified</th><th className="amount">Closing</th></tr></thead><tbody>{rollforward.rows.map((row) => <tr key={row.periodMonth}><td>{monthLabel(row.periodMonth)}</td><td className="amount">{money(row.openingCents, currency)}</td><td className="amount">{money(row.fundedCents, currency)}</td><td className="amount">{money(row.principalRepaidCents, currency)}</td><td className="amount">{money(row.interestPaidCents, currency)}</td><td className="amount">{money(row.unclassifiedCents, currency)}</td><td className="amount">{money(row.closingCents, currency)}</td></tr>)}</tbody></table></div></details>}
      </>}
    </div>
  </>;
}
