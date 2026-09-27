// Cash widgets: every bank account, money in and out from the bank feed, and
// the weekly cash forecast (runway, weekly net, in vs out, low point, lines).
import React from "react";
import type { BankingSnapshot } from "../../../../../shared/rent-ops-banking";
import { CASH_CATEGORY_LABELS } from "@shared/forecasting/result";
import {
  Bars, Columns, Empty, Failed, Foot, LIST_ROW, LineChart, Loading, PairedColumns, Rows, SIZESETS, StatStrip, TILE, Tile,
  bankingStateNotice, centsNumber, companyOpener, dollars, fitRows, humanLabel, isSmall, numeric, shortCents, shortDay, signedCents, sumCents, wholeCents,
  type DashboardData, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import { useForecast } from "./dashboard-sources";
import { ForecastGate, forecastWeeksFrom } from "./dashboard-widgets-overview";

type Transaction = BankingSnapshot["connections"][number]["transactions"][number] & { account: string };
type Account = BankingSnapshot["connections"][number]["accounts"][number] & { balancesState: BankingSnapshot["connections"][number]["balancesState"] };

/** Plaid's credit, loan and investment accounts are not cash available for operations. */
export function isCashAccountType(type: string): boolean {
  return new Set(["depository", "checking", "savings", "cash", "cash management", "money market"]).has(type.trim().toLowerCase());
}

export interface CashTotal { display: string; cashAccounts: number; unknown: number; currencyMismatch: boolean; currency: string | null; }
export function cashTotal(accounts: readonly Pick<Account, "type" | "currency" | "availableCents" | "balancesState">[]): CashTotal {
  const cash = accounts.filter(account => isCashAccountType(account.type));
  if (!cash.length) return { display: "No cash accounts", cashAccounts: 0, unknown: 0, currencyMismatch: false, currency: null };
  const currencies = new Set(cash.map(account => account.currency).filter((currency): currency is string => Boolean(currency)));
  const currencyMismatch = currencies.size > 1;
  const unknown = cash.filter(account => account.balancesState !== "ready" || account.availableCents === null || !Number.isSafeInteger(account.availableCents) || !account.currency).length;
  const currency = currencies.size === 1 ? Array.from(currencies)[0]! : null;
  if (currencyMismatch) return { display: "Multiple currencies", cashAccounts: cash.length, unknown, currencyMismatch, currency: null };
  if (unknown) return { display: "Unknown", cashAccounts: cash.length, unknown, currencyMismatch, currency };
  const total = sumCents(cash.map(account => String(account.availableCents)));
  return { display: wholeCents(total), cashAccounts: cash.length, unknown: 0, currencyMismatch: false, currency };
}

export function pendingNetCents(amounts: readonly (number | null)[]): number | null {
  if (amounts.some(amount => amount === null || !numeric(amount))) return null;
  let total = 0;
  for (const amount of amounts) total -= amount as number;
  return Number.isSafeInteger(total) ? total : null;
}

export function addForecastCents(previous: string | null | undefined, value: string | null | undefined): string | null {
  return previous === undefined ? value ?? null : sumCents([previous, value]);
}

const exactBigInt = (value: string | null | undefined): bigint | undefined => typeof value === "string" && /^-?\d+$/.test(value) ? BigInt(value) : undefined;
const absoluteExact = (value: string | null | undefined): string | null => {
  const amount = exactBigInt(value);
  return amount === undefined ? null : (amount < BigInt(0) ? -amount : amount).toString();
};
const signedExact = (value: string | null | undefined): string => {
  if (value === null || value === undefined || exactBigInt(value) === undefined) return "Unknown";
  return value.startsWith("-") ? wholeCents(value) : `+${wholeCents(value)}`;
};

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
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={accounts.map(account => ({ key: account.id, label: <>{account.name}{account.mask ? ` ··${account.mask}` : ""}</>, detail: `${account.connection} · ${humanLabel(account.type)}${account.currency ? ` · ${account.currency}` : ""}`, value: account.balancesState !== "ready" || !numeric(account.availableCents) ? "Unknown" : dollars(account.availableCents), tone: account.balancesState !== "ready" ? "muted" as const : undefined }))} />;
}

function TotalCash({ data, metrics }: WidgetContext) {
  const banking = data.banking;
  if (banking.error) return <Failed title="Cash unavailable" error={banking.error} retry={banking.refetch} />;
  if (!banking.data) return <Loading />;
  const accounts = banking.data.connections.flatMap(connection => connection.accounts.map(account => ({ ...account, balancesState: connection.balancesState })));
  const total = cashTotal(accounts);
  if (!total.cashAccounts) return <Empty title="No cash accounts connected" />;
  if (banking.data.state !== "ready") {
    const notice = bankingStateNotice(banking.data.state, "Cash");
    return <Empty title={notice?.title ?? "Cash unavailable"}>{notice?.detail}</Empty>;
  }
  return <Tile label="Cash across accounts" big={isSmall(metrics) || metrics.h <= 2} value={total.display} detail={`${total.cashAccounts} cash account${total.cashAccounts === 1 ? "" : "s"}${total.currency ? ` · ${total.currency}` : ""}${total.unknown ? ` · ${total.unknown} balance unknown` : ""}${total.currencyMismatch ? " · currencies differ" : ""}`} />;
}

function MoneyList({ data, metrics, direction }: WidgetContext & { direction: "in" | "out" }) {
  const { snapshot, gate } = useBank(data, direction === "in" ? "Money received" : "Money paid out");
  if (gate) return gate;
  const all = transactions(snapshot!).filter(transaction => !transaction.pending);
  const unknownCount = all.filter(transaction => transaction.amountCents === null).length;
  const rows = all.filter(transaction => numeric(transaction.amountCents) && (direction === "in" ? (transaction.amountCents as number) < 0 : (transaction.amountCents as number) > 0))
    .sort((a, b) => direction === "in" ? String(b.date).localeCompare(String(a.date)) : Math.abs(b.amountCents as number) - Math.abs(a.amountCents as number));
  const total = rows.reduce((sum, row) => sum + Math.abs(row.amountCents as number), 0);
  const currencies = new Set(all.map(row => row.currency));
  if (!rows.length && !unknownCount) return <Empty title={direction === "in" ? "No deposits in the window" : "No payments in the window"} />;
  return <><Tile label={`${direction === "in" ? "Received" : "Paid out"} · ${shortDay(snapshot!.fromDate)} → ${shortDay(snapshot!.throughDate)}`} value={currencies.size > 1 ? "Multiple currencies" : unknownCount || currencies.has(null) ? "Unknown" : dollars(total)} big={isSmall(metrics)} detail={`Posted only · ${rows.length ? `${rows.length} transactions` : "Transactions present"}${unknownCount ? ` · ${unknownCount} amount${unknownCount === 1 ? "" : "s"} unknown` : ""}`} tone={direction === "out" ? "attention" : undefined} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map(row => ({ key: row.id, label: row.description, detail: `${shortDay(row.date)}${row.pending ? " · pending" : ""}${row.account ? ` · ··${row.account}` : ""}`, value: dollars(Math.abs(row.amountCents as number)), tone: direction === "in" ? "positive" as const : undefined }))} />}</>;
}

function DailyNet({ data, metrics }: WidgetContext) {
  const { snapshot, gate } = useBank(data, "Daily cash");
  if (gate) return gate;
  const all = transactions(snapshot!);
  if (new Set(all.filter(row => !row.pending).map(row => row.currency)).size > 1) return <Empty title="Multiple currencies">Daily cash cannot combine different currencies.</Empty>;
  const unknown = all.some(transaction => !transaction.pending && transaction.amountCents === null);
  const byDay = new Map<string, number>();
  for (const transaction of all) if (numeric(transaction.amountCents) && !transaction.pending) byDay.set(transaction.date, (byDay.get(transaction.date) ?? 0) - (transaction.amountCents as number));
  const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(-Math.max(5, Math.floor(metrics.bodyWidth / 18)));
  if (!days.length) return <Empty title={unknown ? "Posted cash amounts unavailable" : "No posted transactions"}>{unknown ? "Some posted transactions did not include an amount." : undefined}</Empty>;
  return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} showValues={metrics.bodyWidth / days.length > 44} points={days.map(([day, cents]) => ({ label: shortDay(day).replace(/^\w+ /, ""), value: cents }))} /><Foot>Net cash per day · posted only{unknown ? " · some amounts unknown" : ""}</Foot></>;
}

function Pending({ data, metrics }: WidgetContext) {
  const { snapshot, gate } = useBank(data, "Pending transactions");
  if (gate) return gate;
  const rows = transactions(snapshot!).filter(transaction => transaction.pending);
  if (!rows.length) return <Empty title="Nothing pending" />;
  const currencies = new Set(rows.map(row => row.currency));
  const net = pendingNetCents(rows.map(row => row.amountCents));
  return <><Tile label="Pending" big={isSmall(metrics)} value={currencies.size > 1 ? "Multiple currencies" : net === null || currencies.has(null) ? "Unknown" : signedCents(net)} detail={`${rows.length} transactions not posted yet${net === null ? " · amount unknown" : ""}`} />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map(row => ({ key: row.id, label: row.description, detail: shortDay(row.date), value: numeric(row.amountCents) ? signedCents(-(row.amountCents as number)) : "Unknown", tone: numeric(row.amountCents) && (row.amountCents as number) < 0 ? "positive" as const : undefined }))} />}</>;
}

/* ---------- forecast ---------- */

function Runway({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const floorCents = result.scenario.reserveFloorCents;
    const floor = centsNumber(floorCents);
    const relative = !result.summary.openingCashKnown;
    return <><LineChart width={metrics.bodyWidth} height={metrics.bodyHeight - 40} floor={floor && floor > 0 && !relative ? floor : undefined} points={weeks.map(week => ({ label: shortDay(week.start), value: centsNumber(week.availableClosingCents) ?? null, tone: week.belowReserveFloor ? "critical" : undefined }))} />
      <Foot action="Forecast" onAction={companyOpener(data, "forecasting", { forecastTab: "cash" })}>{relative ? "Opening cash unknown: change from today" : `Ending available ${wholeCents(result.summary.endingCashCents)}`}{floorCents !== "0" ? ` · reserve ${shortCents(floorCents)}` : ""}</Foot></>;
  }}</ForecastGate>;
}

function WeeklyNet({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const known = weeks.map(week => centsNumber(week.netCents)).filter((cents): cents is number => cents !== undefined);
    const burn = known.filter(cents => cents < 0).length;
    return <><Columns width={metrics.bodyWidth} height={metrics.bodyHeight - 40} showValues={metrics.bodyWidth / Math.max(1, weeks.length) > 40} points={weeks.map(week => ({ label: shortDay(week.start), value: centsNumber(week.netCents) ?? null, tone: (centsNumber(week.netCents) ?? 0) < 0 ? "critical" : week.modeledInflowsCents !== "0" ? "accent" : undefined }))} />
      <Foot>{burn} of {known.length} known weeks burn cash{known.length < weeks.length ? ` · ${weeks.length - known.length} week${weeks.length - known.length === 1 ? "" : "s"} unknown` : ""} · highlighted weeks include modeled capital</Foot></>;
  }}</ForecastGate>;
}

function InOut({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const inflow = sumCents(weeks.map(week => week.inflowsCents));
    const outflow = sumCents(weeks.map(week => absoluteExact(week.outflowsCents)));
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
    const totals = new Map<string, string | null>();
    for (const week of weeks) for (const [key, value] of Object.entries(week.categories)) {
      const previous = totals.get(key);
      totals.set(key, addForecastCents(previous, value));
    }
    const items = Array.from(totals.entries()).filter(([, cents]) => { const amount = exactBigInt(cents); return amount !== undefined && amount !== BigInt(0); }).sort((a, b) => {
      const left = exactBigInt(a[1])!, right = exactBigInt(b[1])!;
      const leftAbs = left < BigInt(0) ? -left : left, rightAbs = right < BigInt(0) ? -right : right;
      return rightAbs > leftAbs ? 1 : rightAbs < leftAbs ? -1 : 0;
    });
    if (!items.length) return <Empty title="No forecast cash lines" />;
    return <Bars limit={fitRows(metrics, LIST_ROW, 0)} format={value => signedCents(value)} items={items.map(([key, cents]) => ({ key, label: CASH_CATEGORY_LABELS[key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(key), value: centsNumber(cents) ?? 0, display: signedExact(cents), tone: exactBigInt(cents)! < BigInt(0) ? "critical" as const : "positive" as const }))} />;
  }}</ForecastGate>;
}

function BigMoves({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const moves = weeks.flatMap(week => Object.entries(week.categories).map(([key, value]) => ({ week, key, cents: value }))).filter(entry => {
      const amount = exactBigInt(entry.cents);
      return amount !== undefined && (amount < BigInt(0) ? -amount : amount) >= BigInt(1_000_000);
    }).sort((a, b) => {
      const byDate = a.week.start.localeCompare(b.week.start);
      if (byDate) return byDate;
      const left = exactBigInt(a.cents)!, right = exactBigInt(b.cents)!;
      const leftAbs = left < BigInt(0) ? -left : left, rightAbs = right < BigInt(0) ? -right : right;
      return rightAbs > leftAbs ? 1 : rightAbs < leftAbs ? -1 : 0;
    });
    if (!moves.length) return <Empty title="No large cash moves">Weekly lines of $10K or more show here.</Empty>;
    return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={moves.map(entry => ({ key: `${entry.week.key}-${entry.key}`, label: CASH_CATEGORY_LABELS[entry.key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(entry.key), detail: `week of ${shortDay(entry.week.start)}`, value: signedExact(entry.cents), tone: entry.cents.startsWith("-") ? "critical" as const : "positive" as const }))} />;
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
