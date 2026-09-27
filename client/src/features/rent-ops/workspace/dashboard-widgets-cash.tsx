// Cash widgets: every bank account, money in and out from the bank feed, and
// the weekly cash forecast (runway, weekly net, in vs out, low point, lines).
import React from "react";
import type { BankingSnapshot } from "../../../../../shared/rent-ops-banking";
import { CASH_CATEGORY_LABELS } from "@shared/forecasting/result";
import {
  Bars, Columns, Empty, Failed, Foot, LIST_ROW, LineChart, Loading, PairedColumns, Rows, SIZESETS, StatStrip, TILE, Tile,
  bankingStateNotice, centsNumber, companyOpener, dollars, fitRows, humanLabel, isSmall, numeric, shortCents, shortDay, signedCents, wholeCents,
  type DashboardData, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import { useForecast } from "./dashboard-sources";
import { ForecastGate, forecastWeeksFrom } from "./dashboard-widgets-overview";

type Transaction = BankingSnapshot["connections"][number]["transactions"][number] & { account: string };

/** Ready bank data, or the widget's empty/error state. */
function useBank(data: DashboardData, label: string): { snapshot?: BankingSnapshot; gate: React.ReactNode | null } {
  const banking = data.banking;
  if (banking.error) return { gate: <Failed title={`${label} unavailable`} error={banking.error} retry={banking.refetch} /> };
  if (!banking.data) return { gate: <Loading /> };
  if (banking.data.state === "unconfigured") return { gate: <Empty title="No bank connected">Connect an account under Accounting › Banking.</Empty> };
  const notice = bankingStateNotice(banking.data.state, label);
  if (notice) return { gate: <Empty title={notice.title}><span>{notice.detail}</span><button type="button" className="rops-link" disabled={banking.loading} onClick={banking.refetch}>Retry</button></Empty> };
  return { snapshot: banking.data, gate: null };
}

const transactions = (snapshot: BankingSnapshot): Transaction[] => snapshot.connections.flatMap(connection => connection.transactions.map(transaction => ({ ...transaction, account: connection.accounts.find(account => account.id === transaction.accountId)?.mask ?? "" })));

function Accounts({ data, metrics }: WidgetContext) {
  const banking = data.banking;
  if (banking.error) return <Failed title="Accounts unavailable" error={banking.error} retry={banking.refetch} />;
  if (!banking.data) return <Loading />;
  const accounts = banking.data.connections.flatMap(connection => connection.accounts.map(account => ({ ...account, connection: connection.name, balancesState: connection.balancesState })));
  if (!accounts.length) return <Empty title="No bank accounts connected">Connect accounts under Accounting › Banking.</Empty>;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={accounts.map(account => ({ key: account.id, label: <>{account.name}{account.mask ? ` ··${account.mask}` : ""}</>, detail: `${account.connection} · ${humanLabel(account.type)}`, value: account.balancesState !== "ready" || !numeric(account.availableCents ?? account.currentCents) ? "Unknown" : dollars((account.availableCents ?? account.currentCents) as number), tone: account.balancesState !== "ready" ? "muted" as const : undefined }))} />;
}

function TotalCash({ data, metrics }: WidgetContext) {
  const banking = data.banking;
  if (banking.error) return <Failed title="Cash unavailable" error={banking.error} retry={banking.refetch} />;
  if (!banking.data) return <Loading />;
  const accounts = banking.data.connections.flatMap(connection => connection.accounts.map(account => ({ ...account, ready: connection.balancesState === "ready" })));
  if (!accounts.length) return <Empty title="No bank connected" />;
  const unknown = accounts.filter(account => !account.ready || !numeric(account.availableCents ?? account.currentCents));
  const total = accounts.reduce((sum, account) => sum + (numeric(account.availableCents ?? account.currentCents) ? (account.availableCents ?? account.currentCents) as number : 0), 0);
  return <Tile label="Cash across accounts" big={isSmall(metrics) || metrics.h <= 2} value={`${unknown.length ? "≥ " : ""}${dollars(total)}`} detail={`${accounts.length} account${accounts.length === 1 ? "" : "s"}${unknown.length ? ` · ${unknown.length} balance unknown` : ""}`} />;
}

function MoneyList({ data, metrics, direction }: WidgetContext & { direction: "in" | "out" }) {
  const { snapshot, gate } = useBank(data, direction === "in" ? "Money received" : "Money paid out");
  if (gate) return gate;
  const rows = transactions(snapshot!).filter(transaction => numeric(transaction.amountCents) && (direction === "in" ? (transaction.amountCents as number) < 0 : (transaction.amountCents as number) > 0))
    .sort((a, b) => direction === "in" ? String(b.date).localeCompare(String(a.date)) : Math.abs(b.amountCents as number) - Math.abs(a.amountCents as number));
  const total = rows.reduce((sum, row) => sum + Math.abs(row.amountCents as number), 0);
  if (!rows.length) return <Empty title={direction === "in" ? "No deposits in the window" : "No payments in the window"} />;
  return <><Tile label={`${direction === "in" ? "Received" : "Paid out"} · ${shortDay(snapshot!.fromDate)} → ${shortDay(snapshot!.throughDate)}`} value={dollars(total)} big={isSmall(metrics)} detail={`${rows.length} transactions`} tone={direction === "out" ? "attention" : undefined} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map(row => ({ key: row.id, label: row.description, detail: `${shortDay(row.date)}${row.pending ? " · pending" : ""}${row.account ? ` · ··${row.account}` : ""}`, value: dollars(Math.abs(row.amountCents as number)), tone: direction === "in" ? "positive" as const : undefined }))} />}</>;
}

function DailyNet({ data, metrics }: WidgetContext) {
  const { snapshot, gate } = useBank(data, "Daily cash");
  if (gate) return gate;
  const byDay = new Map<string, number>();
  for (const transaction of transactions(snapshot!)) if (numeric(transaction.amountCents) && !transaction.pending) byDay.set(transaction.date, (byDay.get(transaction.date) ?? 0) - (transaction.amountCents as number));
  const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-Math.max(5, Math.floor(metrics.bodyWidth / 18)));
  if (!days.length) return <Empty title="No posted transactions" />;
  return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} showValues={metrics.bodyWidth / days.length > 44} points={days.map(([day, cents]) => ({ label: shortDay(day).replace(/^\w+ /, ""), value: cents }))} /><Foot>Net cash per day · posted only</Foot></>;
}

function Pending({ data, metrics }: WidgetContext) {
  const { snapshot, gate } = useBank(data, "Pending transactions");
  if (gate) return gate;
  const rows = transactions(snapshot!).filter(transaction => transaction.pending);
  if (!rows.length) return <Empty title="Nothing pending" />;
  const net = rows.reduce((sum, row) => sum - (numeric(row.amountCents) ? row.amountCents as number : 0), 0);
  return <><Tile label="Pending" big={isSmall(metrics)} value={signedCents(net)} detail={`${rows.length} transactions not posted yet`} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map(row => ({ key: row.id, label: row.description, detail: shortDay(row.date), value: numeric(row.amountCents) ? signedCents(-(row.amountCents as number)) : "—", tone: numeric(row.amountCents) && (row.amountCents as number) < 0 ? "positive" as const : undefined }))} />}</>;
}

/* ---------- forecast ---------- */

function Runway({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const floor = centsNumber(result.scenario.reserveFloorCents);
    const relative = !result.summary.openingCashKnown;
    return <><LineChart width={metrics.bodyWidth} height={metrics.bodyHeight - 40} floor={floor && floor > 0 && !relative ? floor : undefined} points={weeks.map(week => ({ label: shortDay(week.start), value: centsNumber(week.availableClosingCents) ?? null, tone: week.belowReserveFloor ? "critical" : undefined }))} />
      <Foot action="Forecast" onAction={companyOpener(data, "forecasting", { forecastTab: "cash" })}>{relative ? "Opening cash unknown: change from today" : `Ending available ${wholeCents(result.summary.endingCashCents)}`}{floor ? ` · reserve ${shortCents(floor)}` : ""}</Foot></>;
  }}</ForecastGate>;
}

function WeeklyNet({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const burn = weeks.filter(week => (centsNumber(week.netCents) ?? 0) < 0).length;
    return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} showValues={metrics.bodyWidth / Math.max(1, weeks.length) > 40} points={weeks.map(week => ({ label: shortDay(week.start), value: centsNumber(week.netCents) ?? null, tone: (centsNumber(week.netCents) ?? 0) < 0 ? "critical" : week.modeledInflowsCents !== "0" ? "accent" : undefined }))} />
      <Foot>{burn} of {weeks.length} weeks burn cash · highlighted weeks include modeled capital</Foot></>;
  }}</ForecastGate>;
}

function InOut({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const inflow = weeks.reduce((sum, week) => sum + (centsNumber(week.inflowsCents) ?? 0), 0), outflow = weeks.reduce((sum, week) => sum + Math.abs(centsNumber(week.outflowsCents) ?? 0), 0);
    return <><PairedColumns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} labels={weeks.map(week => shortDay(week.start))} a={weeks.map(week => centsNumber(week.inflowsCents) ?? null)} b={weeks.map(week => centsNumber(week.outflowsCents) ?? null)} />
      <Foot>{shortCents(inflow)} in · {shortCents(outflow)} out over {weeks.length} weeks</Foot></>;
  }}</ForecastGate>;
}

function LowPoint({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const summary = result.summary;
    if (!summary.openingCashKnown) return <Empty title="Opening cash unknown">Low point and ending cash need a known opening balance in the forecast.</Empty>;
    return <StatStrip metrics={metrics} min={120} items={[
      { key: "low", label: "Lowest available", value: wholeCents(summary.minAvailableCashCents), detail: summary.minAvailableWeek ? `week of ${shortDay(result.weeks.find(week => week.key === summary.minAvailableWeek)?.start ?? summary.minAvailableWeek)}` : undefined, tone: (centsNumber(summary.minAvailableCashCents) ?? 0) < 0 ? "attention" : undefined },
      { key: "end", label: "Ending cash", value: wholeCents(summary.endingCashCents), detail: `after ${result.scenario.horizonWeeks} weeks` },
      { key: "below", label: "Weeks below reserve", value: String(summary.weeksBelowFloor ?? "—"), detail: `reserve ${wholeCents(result.scenario.reserveFloorCents)}`, tone: summary.weeksBelowFloor ? "attention" : undefined },
    ]} />;
  }}</ForecastGate>;
}

function Categories({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const totals = new Map<string, number>();
    for (const week of weeks) for (const [key, value] of Object.entries(week.categories)) totals.set(key, (totals.get(key) ?? 0) + (centsNumber(value) ?? 0));
    const items = Array.from(totals.entries()).filter(([, cents]) => cents !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (!items.length) return <Empty title="No forecast cash lines" />;
    return <Bars limit={fitRows(metrics, LIST_ROW, 0)} format={value => signedCents(value)} items={items.map(([key, cents]) => ({ key, label: CASH_CATEGORY_LABELS[key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(key), value: cents, display: signedCents(cents), tone: cents < 0 ? "critical" as const : "positive" as const }))} />;
  }}</ForecastGate>;
}

function BigMoves({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const moves = weeks.flatMap(week => Object.entries(week.categories).map(([key, value]) => ({ week, key, cents: centsNumber(value) ?? 0 }))).filter(entry => Math.abs(entry.cents) >= 1_000_000).sort((a, b) => a.week.start.localeCompare(b.week.start) || Math.abs(b.cents) - Math.abs(a.cents));
    if (!moves.length) return <Empty title="No large cash moves">Weekly lines of $10K or more show here.</Empty>;
    return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={moves.map(entry => ({ key: `${entry.week.key}-${entry.key}`, label: CASH_CATEGORY_LABELS[entry.key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(entry.key), detail: `week of ${shortDay(entry.week.start)}`, value: signedCents(entry.cents), tone: entry.cents < 0 ? "critical" as const : "positive" as const }))} />;
  }}</ForecastGate>;
}

export const CASH_WIDGETS: readonly WidgetDefinition[] = [
  { id: "total-cash", category: "cash", name: "Cash across accounts", description: "Available balance summed over every connected bank account", sizes: SIZESETS.tile, defaultSize: "S", render: context => <TotalCash {...context} /> },
  { id: "bank-accounts", category: "cash", name: "Bank accounts", description: "Each connected account with its available balance", sizes: SIZESETS.list, defaultSize: "M", render: context => <Accounts {...context} /> },
  { id: "bank-inflows", category: "cash", name: "Money received", description: "Deposits on the connected accounts, newest first", sizes: SIZESETS.list, defaultSize: "MT", render: context => <MoneyList {...context} direction="in" /> },
  { id: "bank-outflows", category: "cash", name: "Money paid out", description: "The largest payments out of the connected accounts", sizes: SIZESETS.list, defaultSize: "MT", render: context => <MoneyList {...context} direction="out" /> },
  { id: "bank-daily", category: "cash", name: "Daily net cash", description: "Posted money in minus out per day over the banking window", sizes: SIZESETS.chart, defaultSize: "MT", render: context => <DailyNet {...context} /> },
  { id: "bank-pending", category: "cash", name: "Pending transactions", description: "Bank transactions not posted yet", sizes: SIZESETS.list, defaultSize: "M", render: context => <Pending {...context} /> },
  { id: "cash-runway", category: "cash", name: "Cash runway", description: "Forecast available cash at the end of each week against the reserve", sizes: SIZESETS.wideChart, defaultSize: "XT", render: context => <Runway {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "cash-weekly-net", category: "cash", name: "Weekly net", description: "Forecast cash in minus out per week; red weeks burn cash", sizes: SIZESETS.chart, defaultSize: "MT", render: context => <WeeklyNet {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "cash-in-out", category: "cash", name: "Cash in vs out", description: "Forecast inflow and outflow columns per week", sizes: SIZESETS.chart, defaultSize: "MT", render: context => <InOut {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "cash-low-point", category: "cash", name: "Cash low point", description: "Lowest forecast available cash, ending cash and weeks below reserve", sizes: ["M", "MT", "W"], defaultSize: "M", render: context => <LowPoint {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "cash-lines", category: "cash", name: "Cash by line", description: "Forecast net cash per line (rent, debt service, projects…) over the horizon", sizes: SIZESETS.list, defaultSize: "MT", render: context => <Categories {...context} /> },
  { id: "cash-big-moves", category: "cash", name: "Big money moves", description: "Forecast weekly lines of $10K or more: draws, sales, payoffs, big bills", sizes: SIZESETS.list, defaultSize: "MT", render: context => <BigMoves {...context} /> },
];
