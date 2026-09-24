import React from "react";
import { useMemo, useState } from "react";
import { CASH_CATEGORY_LABELS, FORECAST_ACCOUNTS, FORECAST_LADDER_OVERDUE, type ForecastResultView } from "@shared/forecasting/result";
import { BarLineChart, CompositionChart, LadderChart, LineChart, WaterfallChart } from "./charts";
import { bpsToPercentText, dateLabel, dscr, money, moneyWhole, monthLabel } from "./format";
import { DrillCell, EmptyState, type Drill } from "./ui";
import { sumCents } from "../projects/money";

const big = (value: string | null | undefined) => BigInt(value ?? "0");
const categoryLabel = (key: string) => CASH_CATEGORY_LABELS[key as keyof typeof CASH_CATEGORY_LABELS] ?? key;
const accountLabel = (key: string) => FORECAST_ACCOUNTS.find(account => account.key === key)?.label ?? key;

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "warning" }) {
  return <div className={`fc-stat${tone ? ` fc-stat--${tone}` : ""}`}><dt>{label}</dt><dd>{value}</dd>{note && <span>{note}</span>}</div>;
}

/** Unknown opening cash is excluded, never zero: cash balances are then movements relative to it. */
export function openingCashUnknown(result: ForecastResultView): boolean {
  if (typeof result.summary.openingCashKnown === "boolean") return !result.summary.openingCashKnown;
  return result.opening.items.some(item => (item.key === "cash_operating" || item.key === "cash_restricted") && item.state === "unknown");
}
export const RELATIVE_CASH_NOTE = "Relative to unknown opening cash";

function Scroll({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="fc-scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

// ------------------------------------------------------------------ Cash
export function CashView({ result, onDrill }: { result: ForecastResultView; onDrill: Drill }) {
  const { weeks, currency } = result;
  const firstLow = weeks.find(week => week.belowReserveFloor)?.key;
  const [bridgeKey, setBridgeKey] = useState(firstLow ?? weeks[0]?.key ?? "");
  if (!weeks.length) return <EmptyState title="No weekly view" message="This scenario has no weekly horizon." />;
  const bridge = weeks.find(week => week.key === bridgeKey) ?? weeks[0]!;
  const steps = Object.entries(bridge.categories).filter(([, cents]) => cents !== "0")
    .sort(([, a], [, b]) => { const left = big(a) < BigInt(0) ? -big(a) : big(a); const right = big(b) < BigInt(0) ? -big(b) : big(b); return left === right ? 0 : left > right ? -1 : 1; })
    .map(([key, cents]) => ({ key, label: categoryLabel(key), cents }));
  const lowWeek = result.summary.minAvailableWeek;
  const modeled = weeks.some(week => week.modeledInflowsCents !== "0");
  const cashUnknown = openingCashUnknown(result);
  const netChange = weeks.reduce((total, week) => total + big(week.netCents), BigInt(0)).toString();
  const periodInflows = sumCents(weeks.map(week => week.inflowsCents));
  const periodOutflows = sumCents(weeks.map(week => week.outflowsCents));
  const periodNet = sumCents(weeks.map(week => week.netCents));
  const periodModeledInflows = sumCents(weeks.map(week => week.modeledInflowsCents));
  const relative = (label: string) => cashUnknown ? `${label} (relative)` : label;
  return <div className="fc-view">
    <dl className="fc-stats">
      <Stat label="Opening cash" value={cashUnknown ? "Unknown" : moneyWhole(weeks[0]!.openingCashCents, currency)} note={cashUnknown ? "Set opening balances" : dateLabel(weeks[0]!.start, "long")} tone={cashUnknown ? "warning" : undefined} />
      <Stat label="Lowest available" value={moneyWhole(result.summary.minAvailableCashCents, currency)} note={[lowWeek ? `Week of ${dateLabel(lowWeek)}` : null, cashUnknown ? RELATIVE_CASH_NOTE : null].filter(Boolean).join(" · ") || undefined} tone={result.summary.weeksBelowFloor ? "warning" : undefined} />
      {cashUnknown
        ? <Stat label={`Net change, ${weeks.length} weeks`} value={moneyWhole(netChange, currency)} note={RELATIVE_CASH_NOTE} />
        : <Stat label={`Cash after ${weeks.length} weeks`} value={moneyWhole(weeks.at(-1)!.closingCashCents, currency)} />}
      <Stat label="Weeks below floor" value={result.summary.weeksBelowFloor === null ? "Unknown" : String(result.summary.weeksBelowFloor)} note={cashUnknown ? "Needs opening cash" : `Floor ${moneyWhole(result.scenario.reserveFloorCents, currency)}`} tone={result.summary.weeksBelowFloor ? "warning" : undefined} />
    </dl>
    <LineChart title={cashUnknown ? `Weekly cash · ${RELATIVE_CASH_NOTE.toLowerCase()}` : "Weekly cash"} periods={weeks.map(week => ({ key: week.key, label: week.start }))}
      series={[
        { id: "available", label: "Available", tone: "ink", values: weeks.map(week => week.availableClosingCents) },
        { id: "closing", label: "Total", tone: "muted", dashed: true, values: weeks.map(week => week.closingCashCents) },
      ]}
      {...(cashUnknown ? {} : { floorCents: result.scenario.reserveFloorCents })}
      onSelect={(_series, key) => onDrill("cash.available", key)} selectedKey={bridge.key} />
    <Scroll label="13-week cash table">
      <table className="rm-table fc-table">
        <caption className="fc-sr-only">Weekly cash schedule</caption>
        <thead><tr>
          <th scope="col">Week of</th><th scope="col" className="fc-num">{relative("Opening")}</th><th scope="col" className="fc-num">Inflows</th><th scope="col" className="fc-num">Outflows</th>
          <th scope="col" className="fc-num">Net</th><th scope="col" className="fc-num">{relative("Closing")}</th><th scope="col" className="fc-num">{relative("Restricted")}</th><th scope="col" className="fc-num">{relative("Available")}</th>
          {modeled && <th scope="col" className="fc-num">Modeled inflows</th>}
        </tr></thead>
        <tbody>{weeks.map(week => <tr key={week.key} className={week.belowReserveFloor === true ? "fc-row--low" : undefined}>
          <th scope="row"><button type="button" className="fc-link" onClick={() => setBridgeKey(week.key)} aria-pressed={week.key === bridge.key}>{dateLabel(week.start)}</button>{week.belowReserveFloor === true && <span className="rm-status rm-status--warning fc-tag">Below floor</span>}</th>
          <DrillCell cents={week.openingCashCents} line="cash.opening" period={week.key} label={`Opening cash, week of ${week.start}`} onDrill={onDrill} currency={currency} />
          <DrillCell cents={week.inflowsCents} line="cash.inflows" period={week.key} label={`Inflows, week of ${week.start}`} onDrill={onDrill} currency={currency} />
          <DrillCell cents={week.outflowsCents} line="cash.outflows" period={week.key} label={`Outflows, week of ${week.start}`} onDrill={onDrill} currency={currency} />
          <DrillCell cents={week.netCents} line="cash.net" period={week.key} label={`Net cash, week of ${week.start}`} onDrill={onDrill} currency={currency} />
          <DrillCell cents={week.closingCashCents} line="cash.closing" period={week.key} label={`Closing cash, week of ${week.start}`} onDrill={onDrill} currency={currency} emphasis />
          <DrillCell cents={week.restrictedClosingCents} line="cash.restricted" period={week.key} label={`Restricted cash, week of ${week.start}`} onDrill={onDrill} currency={currency} />
          <DrillCell cents={week.availableClosingCents} line="cash.available" period={week.key} label={`Available cash, week of ${week.start}`} onDrill={onDrill} currency={currency} emphasis />
          {modeled && <td className="fc-num">{week.modeledInflowsCents === "0" ? "—" : moneyWhole(week.modeledInflowsCents, currency)}</td>}
        </tr>)}</tbody><tfoot><tr className="fc-row--total"><th scope="row">Period totals</th><td className="fc-num">—</td><td className="fc-num">{money(periodInflows, currency)}</td><td className="fc-num">{money(periodOutflows, currency)}</td><td className="fc-num">{money(periodNet, currency)}</td><td className="fc-num">—</td><td className="fc-num">—</td><td className="fc-num">—</td>{modeled && <td className="fc-num">{money(periodModeledInflows, currency)}</td>}</tr></tfoot>
      </table>
    </Scroll>
    {cashUnknown && <p className="fc-footnote">Balances are relative to unknown opening cash; set opening balances to see cash on hand.</p>}
    {modeled && <p className="fc-footnote">Modeled inflows are projected refinance, sale or draw proceeds. They are never actual cash.</p>}
    <section className="fc-split" aria-label="Cash bridge">
      <WaterfallChart title={`Cash bridge · week of ${dateLabel(bridge.start, "long")}`} openingCents={bridge.openingCashCents} closingCents={bridge.closingCashCents} steps={steps} onSelect={key => onDrill(`cash.category.${key}`, bridge.key)} />
      <table className="rm-table fc-table fc-table--compact">
        <caption className="fc-sr-only">Cash bridge values</caption>
        <tbody>
          <tr><th scope="row">{relative("Opening")}</th><td className="fc-num">{money(bridge.openingCashCents, currency)}</td></tr>
          {steps.map(step => <tr key={step.key}><th scope="row">{step.label}</th>
            <DrillCell cents={step.cents} line={`cash.category.${step.key}`} period={bridge.key} label={`${step.label}, week of ${bridge.start}`} onDrill={onDrill} currency={currency} /></tr>)}
          <tr className="fc-row--total"><th scope="row">{relative("Closing")}</th><td className="fc-num">{money(bridge.closingCashCents, currency)}</td></tr>
        </tbody>
      </table>
    </section>
    {result.owner && <details className="fc-details">
      <summary>Owner planning (not in company statements)</summary>
      <Scroll label="Owner planning cash">
        <table className="rm-table fc-table fc-table--compact">
          <thead><tr><th scope="col">Week of</th><th scope="col" className="fc-num">Net</th><th scope="col" className="fc-num">Cumulative</th></tr></thead>
          <tbody>{result.owner.weeks.map(week => <tr key={week.key}><th scope="row">{dateLabel(week.key.slice(2))}</th><td className="fc-num">{moneyWhole(week.netCents, currency)}</td><td className="fc-num">{moneyWhole(week.cumulativeCents, currency)}</td></tr>)}</tbody>
        </table>
      </Scroll>
    </details>}
  </div>;
}

// ------------------------------------------------------------------ Income
const INCOME_ROWS: readonly { key: string; label: string; line: string; strong?: boolean; optional?: boolean }[] = [
  { key: "rental_income_tenant", label: "Rent – tenant portion", line: "is.rental_income_tenant" },
  { key: "rental_income_subsidy", label: "Rent – housing assistance", line: "is.rental_income_subsidy", optional: true },
  { key: "concessions", label: "Less concessions", line: "is.concessions", optional: true },
  { key: "revenue", label: "Revenue", line: "is.revenue", strong: true },
  { key: "bad_debt", label: "Bad debt", line: "is.bad_debt", optional: true },
  { key: "pm_fees", label: "Property management fees", line: "is.pm_fees", optional: true },
  ...["opex_utilities", "opex_insurance", "opex_property_tax", "opex_payroll", "opex_repairs", "opex_admin", "opex_other"].map(key => ({ key, label: accountLabel(key), line: `is.${key}`, optional: true })),
  { key: "operating_expenses", label: "Operating expenses", line: "is.operating_expenses", strong: true },
  { key: "noi", label: "Net operating income", line: "is.noi", strong: true },
  { key: "depreciation", label: "Depreciation", line: "is.depreciation", optional: true },
  { key: "interest_expense", label: "Interest", line: "is.interest_expense", optional: true },
  { key: "financing_costs", label: "Financing costs", line: "is.financing_costs", optional: true },
  { key: "gain_on_sale", label: "Gain (loss) on sale", line: "is.gain_on_sale", optional: true },
  { key: "net_income", label: "Net income", line: "is.net_income", strong: true },
];

export function IncomeView({ result, onDrill }: { result: ForecastResultView; onDrill: Drill }) {
  const { months, currency } = result;
  const value = (month: ForecastResultView["months"][number], key: string) => {
    if (key === "revenue") return month.revenueCents;
    if (key === "operating_expenses") return month.operatingExpensesCents;
    if (key === "noi") return month.noiCents;
    if (key === "net_income") return month.netIncomeCents;
    return month.income[key] ?? "0";
  };
  const rows = INCOME_ROWS.filter(row => !row.optional || months.some(month => value(month, row.key) !== "0"));
  return <div className="fc-view">
    <dl className="fc-stats">
      <Stat label={`NOI, ${months.length} months`} value={moneyWhole(result.summary.totalNoiCents, currency)} />
      <Stat label="Net income" value={moneyWhole(result.summary.totalNetIncomeCents, currency)} />
      <Stat label="Occupancy at end" value={bpsToPercentText(months.at(-1)?.operations.unitsAtEnd ? Math.floor((months.at(-1)!.operations.occupiedUnitsAtEnd * 10_000) / months.at(-1)!.operations.unitsAtEnd) : null)}
        note={months.at(-1) ? `${months.at(-1)!.operations.occupiedUnitsAtEnd} of ${months.at(-1)!.operations.unitsAtEnd} units` : undefined} />
    </dl>
    <BarLineChart title="Net operating income and occupancy" months={months.map(month => month.month)} bars={months.map(month => month.noiCents)} barLabel="NOI"
      line={months.map(month => month.operations.occupancyBps)} lineLabel="Occupancy" onSelect={index => onDrill("is.noi", months[index]!.key)} />
    <Scroll label="Monthly income statement">
      <table className="rm-table fc-table fc-table--wide">
        <caption className="fc-sr-only">Monthly income statement</caption>
        <thead><tr><th scope="col" className="fc-sticky">Line</th>{months.map(month => <th key={month.key} scope="col" className="fc-num">{monthLabel(month.month, month.month.endsWith("-01") || month === months[0])}</th>)}</tr></thead>
        <tbody>
          {rows.map(row => <tr key={row.key} className={row.strong ? "fc-row--total" : undefined}>
            <th scope="row" className="fc-sticky">{row.label}</th>
            {months.map(month => <DrillCell key={month.key} cents={value(month, row.key)}
              line={row.line} period={month.key} label={`${row.label}, ${month.month}`} onDrill={onDrill} currency={currency} emphasis={row.strong} />)}
          </tr>)}
          <tr className="fc-row--note"><th scope="row" className="fc-sticky">Occupancy</th>{months.map(month => <td key={month.key} className="fc-num">{bpsToPercentText(month.operations.occupancyBps)}</td>)}</tr>
          <tr><th scope="row" className="fc-sticky">Scheduled rent</th>{months.map(month => <DrillCell key={month.key} cents={month.operations.scheduledRentCents} line="ops.scheduled_rent" period={month.key} label={`Scheduled rent, ${month.month}`} onDrill={onDrill} currency={currency} />)}</tr>
        </tbody>
      </table>
    </Scroll>
  </div>;
}

// ------------------------------------------------------------------ Balance sheet
const ASSET_KEYS = ["cash_operating", "cash_restricted", "rent_receivable", "subsidy_receivable", "pm_held_funds", "fixed_assets", "accumulated_depreciation", "cip"];
const LIABILITY_KEYS = ["accounts_payable", "project_payables", "retainage_payable", "deposits_held", "investor_payable", "debt"];
const EQUITY_KEYS = ["opening_equity", "contributed_capital", "distributions", "retained_earnings"];

/**
 * Balance-sheet composition. Each key is an explainable line (`bs.<key>`:
 * composites such as cash_total, or the single debt account), so selecting a
 * segment opens exactly the figure it shows.
 */
export function balanceComposition(month: ForecastResultView["months"][number], cashUnknown = false) {
  const b = month.balance;
  const assets = [
    { key: "cash_total", label: cashUnknown ? "Cash (relative)" : "Cash", cents: (big(b.cash_operating) + big(b.cash_restricted)).toString() },
    { key: "receivables_total", label: "Receivables and manager funds", cents: (big(b.rent_receivable) + big(b.subsidy_receivable) + big(b.pm_held_funds)).toString() },
    { key: "property_net", label: "Property, net", cents: (big(b.fixed_assets) - big(b.accumulated_depreciation) + big(b.cip)).toString() },
  ];
  const claims = [
    { key: "debt", label: "Loans", cents: b.debt ?? "0" },
    { key: "payables_total", label: "Payables and deposits", cents: (big(b.accounts_payable) + big(b.project_payables) + big(b.retainage_payable) + big(b.deposits_held) + big(b.investor_payable)).toString() },
    { key: "equity_total", label: "Equity", cents: month.totalEquityCents },
  ];
  return { assets, claims };
}

export function BalanceView({ result, onDrill }: { result: ForecastResultView; onDrill: Drill }) {
  const { months, currency } = result;
  const [selected, setSelected] = useState(months.at(-1)?.key ?? "");
  const month = months.find(item => item.key === selected) ?? months.at(-1);
  const cashUnknown = openingCashUnknown(result);
  const composition = useMemo(() => (month ? balanceComposition(month, cashUnknown) : null), [month, cashUnknown]);
  if (!month || !composition) return <EmptyState title="No monthly view" message="This scenario has no monthly horizon." />;
  const rowLabel = (key: string) => key === "retained_earnings" ? "Retained earnings since cutoff" : key === "accumulated_depreciation" ? "Less accumulated depreciation" : key === "distributions" ? "Less distributions"
    : cashUnknown && (key === "cash_operating" || key === "cash_restricted") ? `${accountLabel(key)} (relative)` : accountLabel(key);
  const row = (key: string) => <tr key={key}><th scope="row" className="fc-sticky">{rowLabel(key)}</th>
    {months.map(item => <DrillCell key={item.key} cents={item.balance[key] ?? "0"} line={`bs.${key}`} period={item.key} label={`${rowLabel(key)}, ${item.month}`} onDrill={onDrill} currency={currency} />)}</tr>;
  const total = (label: string, pick: (item: ForecastResultView["months"][number]) => string) => <tr className="fc-row--total"><th scope="row" className="fc-sticky">{label}</th>{months.map(item => <td key={item.key} className="fc-num fc-num--strong">{moneyWhole(pick(item), currency)}</td>)}</tr>;
  const cashFlow = month.cashFlow;
  return <div className="fc-view">
    <div className="fc-toolbar">
      <label className="fc-inline-field">Month <select value={month.key} onChange={event => setSelected(event.currentTarget.value)}>{months.map(item => <option key={item.key} value={item.key}>{monthLabel(item.month, true)}</option>)}</select></label>
      {big(month.totalEquityCents) < BigInt(0) && <span className="rm-status rm-status--warning">Negative book equity</span>}
    </div>
    <CompositionChart title={`Balance sheet composition · ${monthLabel(month.month, true)}`} assets={composition.assets} claims={composition.claims} onSelect={key => onDrill(`bs.${key}`, month.key)} />
    {cashUnknown && <p className="fc-footnote">Cash balances are relative to unknown opening cash.</p>}
    <Scroll label="Monthly balance sheet">
      <table className="rm-table fc-table fc-table--wide">
        <caption className="fc-sr-only">Monthly balance sheet</caption>
        <thead><tr><th scope="col" className="fc-sticky">Account</th>{months.map(item => <th key={item.key} scope="col" className="fc-num">{monthLabel(item.month, item.month.endsWith("-01") || item === months[0])}</th>)}</tr></thead>
        <tbody>
          <tr className="fc-row--group"><th scope="rowgroup" colSpan={months.length + 1}>Assets</th></tr>
          {ASSET_KEYS.map(key => row(key))}
          {total("Total assets", item => item.totalAssetsCents)}
          <tr className="fc-row--group"><th scope="rowgroup" colSpan={months.length + 1}>Liabilities</th></tr>
          {LIABILITY_KEYS.map(key => row(key))}
          {total("Total liabilities", item => item.totalLiabilitiesCents)}
          <tr className="fc-row--group"><th scope="rowgroup" colSpan={months.length + 1}>Equity</th></tr>
          {EQUITY_KEYS.map(key => row(key))}
          {total("Total equity", item => item.totalEquityCents)}
          {total("Liabilities and equity", item => (big(item.totalLiabilitiesCents) + big(item.totalEquityCents)).toString())}
        </tbody>
      </table>
    </Scroll>
    <section className="fc-split" aria-label="Cash flow statement">
      <table className="rm-table fc-table fc-table--compact">
        <caption className="fc-table-caption">Cash flow · {monthLabel(month.month, true)} (indirect)</caption>
        <tbody>
          {cashFlow.operating.map(line => <tr key={`op-${line.key}`}><th scope="row">{line.label}</th><td className="fc-num">{money(line.cents, currency)}</td></tr>)}
          <tr className="fc-row--total"><th scope="row">Operating activities</th><DrillCell cents={cashFlow.operatingCents} line="cf.operating" period={month.key} label="Operating activities" onDrill={onDrill} currency={currency} emphasis /></tr>
          {cashFlow.investing.map(line => <tr key={`in-${line.key}`}><th scope="row">{line.label}</th><td className="fc-num">{money(line.cents, currency)}</td></tr>)}
          <tr className="fc-row--total"><th scope="row">Investing activities</th><DrillCell cents={cashFlow.investingCents} line="cf.investing" period={month.key} label="Investing activities" onDrill={onDrill} currency={currency} emphasis /></tr>
          {cashFlow.financing.map(line => <tr key={`fi-${line.key}`}><th scope="row">{line.label}</th><td className="fc-num">{money(line.cents, currency)}</td></tr>)}
          <tr className="fc-row--total"><th scope="row">Financing activities</th><DrillCell cents={cashFlow.financingCents} line="cf.financing" period={month.key} label="Financing activities" onDrill={onDrill} currency={currency} emphasis /></tr>
          <tr className="fc-row--total"><th scope="row">Net change in cash</th><td className="fc-num fc-num--strong">{money(cashFlow.indirectNetChangeCents, currency)}</td></tr>
        </tbody>
      </table>
      <table className="rm-table fc-table fc-table--compact">
        <caption className="fc-table-caption">Receipts and payments (direct)</caption>
        <tbody>
          {cashFlow.direct.map(line => <tr key={line.key}><th scope="row">{categoryLabel(line.key)}</th>
            <DrillCell cents={line.cents} line={`cf.direct.${line.key}`} period={month.key} label={categoryLabel(line.key)} onDrill={onDrill} currency={currency} /></tr>)}
          <tr className="fc-row--total"><th scope="row">Net change in cash</th><td className="fc-num fc-num--strong">{money(cashFlow.directNetChangeCents, currency)}</td></tr>
          <tr><th scope="row">Reconciles to statement cash</th><td className="fc-num">{cashFlow.directNetChangeCents === cashFlow.indirectNetChangeCents ? "Yes" : "No"}</td></tr>
        </tbody>
      </table>
    </section>
  </div>;
}

// ------------------------------------------------------------------ Debt
export function DebtView({ result, onDrill }: { result: ForecastResultView; onDrill: Drill }) {
  const { debt, capital, currency } = result;
  const [year, setYear] = useState<string | null>(null);
  if (!debt.loans.length && !capital.refinances.length && !capital.sales.length) return <EmptyState title="No debt in this scenario" message="Add loans in Assumptions to see maturities and coverage." />;
  const overdue = year === FORECAST_LADDER_OVERDUE;
  const payments = year ? debt.loans.flatMap(loan => loan.payments.filter(row => (overdue ? loan.pastMaturity === true : !loan.pastMaturity && row.date.startsWith(year))).map(row => ({ ...row, loan: loan.label }))).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) : [];
  const paymentInterest = sumCents(payments.map(row => row.interestCents));
  const paymentPrincipal = sumCents(payments.map(row => row.principalCents.replace(/^-/, "")));
  const yearLabel = (value: string) => value === FORECAST_LADDER_OVERDUE ? "Overdue" : value;
  const kindLabel = { scheduled: "Payment", balloon: "Balloon", payoff: "Payoff", draw: "Funding" } as const;
  return <div className="fc-view">
    {debt.ladder.length > 0 && <LadderChart title="Maturity ladder" rows={debt.ladder.map(row => ({ ...row, year: yearLabel(row.year) }))} onSelect={value => setYear(value === "Overdue" ? FORECAST_LADDER_OVERDUE : value)} selectedYear={year ? yearLabel(year) : undefined} />}
    {year && <div className="fc-scroll" role="region" aria-label={overdue ? "Overdue loan balances" : `Loan payments in ${year}`} tabIndex={0}>
      <table className="rm-table fc-table fc-table--compact">
        <caption className="fc-table-caption">{overdue ? "Overdue loan balances" : `Loan payments in ${year}`} <button type="button" className="rm-button rm-button--small rm-button--ghost" onClick={() => setYear(null)}>Close</button></caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Loan</th><th scope="col">Type</th><th scope="col" className="fc-num">Interest</th><th scope="col" className="fc-num">Principal</th><th scope="col" className="fc-num">Balance after</th></tr></thead>
        <tbody>{payments.map(row => <tr key={`${row.loan}-${row.date}-${row.kind}`}><td>{dateLabel(row.date, "long")}</td><td>{row.loan}</td><td>{kindLabel[row.kind]}</td>
          <td className="fc-num">{money(row.interestCents, currency)}</td><td className="fc-num">{money(row.principalCents.replace(/^-/, ""), currency)}</td><td className="fc-num">{money(row.balanceCents, currency)}</td></tr>)}</tbody><tfoot><tr className="fc-row--total"><th scope="row">Period totals · {payments.length} payment{payments.length === 1 ? "" : "s"}</th><td colSpan={2} /><td className="fc-num">{money(paymentInterest, currency)}</td><td className="fc-num">{money(paymentPrincipal, currency)}</td><td className="fc-num">—</td></tr></tfoot>
      </table>
    </div>}
    <Scroll label="Loans">
      <table className="rm-table fc-table">
        <caption className="fc-table-caption">Loans</caption>
        <thead><tr><th scope="col">Loan</th><th scope="col">Lender</th><th scope="col" className="fc-num">Opening principal</th><th scope="col" className="fc-num">Rate</th><th scope="col">Maturity</th><th scope="col" className="fc-num">Due at maturity</th><th scope="col">Status</th></tr></thead>
        <tbody>{debt.loans.map(loan => <tr key={loan.loanId}>
          <th scope="row">{loan.label}</th><td>{loan.lender ?? "—"}</td>
          <td className="fc-num">{loan.principalKnown ? moneyWhole(loan.openingPrincipalCents, currency) : <span className="rm-status rm-status--warning">Unknown</span>}</td>
          <td className="fc-num">{bpsToPercentText(loan.annualRateBps, 2)}</td><td>{dateLabel(loan.maturityOn, "long")}</td>
          <td className="fc-num">{loan.balloonCents === null ? "—" : moneyWhole(loan.balloonCents, currency)}</td>
          <td>{loan.pastMaturity ? <span className="rm-status rm-status--warning">Past maturity</span> : loan.paidOffOn ? `Paid off ${dateLabel(loan.paidOffOn, "long")}` : loan.fundedOn ? `Funded ${dateLabel(loan.fundedOn, "long")}` : loan.principalKnown ? "Outstanding" : "Excluded until balance is known"}</td>
        </tr>)}</tbody>
      </table>
    </Scroll>
    <Scroll label="Debt coverage">
      <table className="rm-table fc-table">
        <caption className="fc-table-caption">Coverage</caption>
        <thead><tr><th scope="col">Month</th><th scope="col" className="fc-num">NOI</th><th scope="col" className="fc-num">Scheduled debt service</th><th scope="col" className="fc-num">DSCR</th></tr></thead>
        <tbody>{debt.coverage.map((row, index) => { const month = result.months[index]!; return <tr key={row.month} className={row.dscrBps !== null && row.dscrBps < 12_000 ? "fc-row--low" : undefined}>
          <th scope="row">{monthLabel(row.month, true)}</th>
          <DrillCell cents={row.noiCents} line="is.noi" period={month.key} label={`NOI, ${row.month}`} onDrill={onDrill} currency={currency} />
          <DrillCell cents={row.debtServiceCents} line="debt.service" period={month.key} label={`Debt service, ${row.month}`} onDrill={onDrill} currency={currency} />
          <td className="fc-num">{dscr(row.dscrBps)}</td>
        </tr>; })}</tbody>
      </table>
    </Scroll>
    {(capital.refinances.length > 0 || capital.sales.length > 0) && <section aria-label="Capital events">
      {capital.refinances.length > 0 && <Scroll label="Refinances"><table className="rm-table fc-table">
        <caption className="fc-table-caption">Refinances <span className="rm-status rm-status--warning fc-tag">Modeled</span></caption>
        <thead><tr><th scope="col">Refinance</th><th scope="col">Closing</th><th scope="col" className="fc-num">Gross proceeds</th><th scope="col" className="fc-num">Payoff</th><th scope="col" className="fc-num">Costs</th><th scope="col" className="fc-num">Reserves</th><th scope="col" className="fc-num">Net usable</th></tr></thead>
        <tbody>{capital.refinances.map(item => <tr key={item.id}><th scope="row">{item.label}{item.excluded && <span className="rm-status rm-status--unknown fc-tag">Excluded</span>}</th><td>{dateLabel(item.closeOn, "long")}</td>
          <td className="fc-num">{moneyWhole(item.grossProceedsCents, currency)}</td><td className="fc-num">{moneyWhole(item.payoffCents, currency)}</td><td className="fc-num">{moneyWhole(item.costsCents, currency)}</td>
          <td className="fc-num">{moneyWhole(item.reservesCents, currency)}</td><td className="fc-num fc-num--strong">{moneyWhole(item.netUsableCents, currency)}</td></tr>)}</tbody><tfoot><tr className="fc-row--total"><th scope="row">Shown: {capital.refinances.length} refinances</th><td>Filtered totals</td><td className="fc-num">{money(sumCents(capital.refinances.map(item => item.grossProceedsCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.refinances.map(item => item.payoffCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.refinances.map(item => item.costsCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.refinances.map(item => item.reservesCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.refinances.map(item => item.netUsableCents)), currency)}</td></tr></tfoot>
      </table></Scroll>}
      {capital.sales.length > 0 && <Scroll label="Sales"><table className="rm-table fc-table">
        <caption className="fc-table-caption">Sales <span className="rm-status rm-status--warning fc-tag">Modeled</span></caption>
        <thead><tr><th scope="col">Sale</th><th scope="col">Closing</th><th scope="col" className="fc-num">Price</th><th scope="col" className="fc-num">Selling costs</th><th scope="col" className="fc-num">Book value</th><th scope="col" className="fc-num">Gain</th><th scope="col" className="fc-num">Payoff</th><th scope="col" className="fc-num">Deposits transferred</th><th scope="col" className="fc-num">Net proceeds</th></tr></thead>
        <tbody>{capital.sales.map(item => <tr key={item.id}><th scope="row">{item.label}{item.excluded && <span className="rm-status rm-status--unknown fc-tag">Excluded</span>}</th><td>{dateLabel(item.closeOn, "long")}</td>
          <td className="fc-num">{moneyWhole(item.priceCents, currency)}</td><td className="fc-num">{moneyWhole(item.sellingCostsCents, currency)}</td><td className="fc-num">{moneyWhole(item.netBookValueCents, currency)}</td>
          <td className="fc-num">{moneyWhole(item.gainCents, currency)}</td><td className="fc-num">{moneyWhole(item.payoffCents, currency)}</td><td className="fc-num">{moneyWhole(item.depositsTransferredCents, currency)}</td>
          <td className="fc-num fc-num--strong">{moneyWhole(item.netProceedsCents, currency)}</td></tr>)}</tbody><tfoot><tr className="fc-row--total"><th scope="row">Shown: {capital.sales.length} sales</th><td>Filtered totals</td><td className="fc-num">{money(sumCents(capital.sales.map(item => item.priceCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.sales.map(item => item.sellingCostsCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.sales.map(item => item.netBookValueCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.sales.map(item => item.gainCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.sales.map(item => item.payoffCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.sales.map(item => item.depositsTransferredCents)), currency)}</td><td className="fc-num">{money(sumCents(capital.sales.map(item => item.netProceedsCents)), currency)}</td></tr></tfoot>
      </table></Scroll>}
    </section>}
  </div>;
}
