// The default "Command" dashboard, built to the Sept 24 dashboard v2 mockup
// (Claude outputs/dashboard-1.html): cash card, rental summary and table,
// QuickBooks, coming up, occupancy trend, the weekly cash plan, and the
// projects block. Every figure is live. Where a source has no data yet the
// cell says what is missing ("Not set", "—") instead of inventing a number.
import React, { useMemo, type ReactNode } from "react";
import type { ProjectDetail, ProjectSummary } from "@shared/projects";
import type { ProjectDealCostReport } from "@shared/projects/deal-costs";
import type { CompanyContextOrganization } from "@shared/company/context";
import type { DashboardCompany } from "@shared/workspaces/contracts";
import { CASH_CATEGORY_LABELS, type ForecastResultView } from "@shared/forecasting/result";
import { financialFigure } from "../../accounting/dashboard-model";
import { dashboardChartSeries, dashboardTrendPoints } from "./dashboard-model";
import {
  AxisChart, Cells, Chip, Empty, Failed, Foot, Loading, Pager, Ring, Spark,
  addDays, centsNumber, companyOpener, dayDiff, daysLabel, dollars, groupByProperty, humanLabel, kMoney, monthShort, numeric, pct, propertyLink,
  shortCents, shortDay, sumCents, sumKnown, text, weekday, wholeCents,
  type Cell, type DashboardData, type Row, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import {
  openProjects, useCloseChecklists, useCompanyDashboard, useDashboardOrganization, useDealReports, useExtraRentalRows, useFinancialReports,
  useForecast, useOpenProjectDeals, useProjectDetails, useProjects, useQboEntities,
} from "./dashboard-sources";

/* ---------- shared helpers for company widgets ---------- */

/** Loading and access states every company widget shares; null when ready. */
export function useCompanyGate(data: DashboardData): { organization?: CompanyContextOrganization; gate: ReactNode | null } {
  const { organization, loading, error, noAccess } = useDashboardOrganization(data);
  if (loading) return { gate: <Loading label="Loading company" /> };
  if (error) return { gate: <Failed title="Company records unavailable" error={error} /> };
  if (noAccess || !organization) return { gate: <Empty title="No company access">These figures appear for organization members.</Empty> };
  return { organization, gate: null };
}

export function propertyNameFor(data: DashboardData, organization: CompanyContextOrganization | undefined, propertyId: string): string {
  return data.snapshot.snapshot.properties.find(property => property.id === propertyId)?.name
    ?? organization?.entities.flatMap(entity => entity.properties).find(property => property.id === propertyId)?.name
    ?? "Property";
}

export const PROJECT_STATUS_LABEL: Record<string, string> = { planning: "Planning", active: "Active", on_hold: "On hold", completed: "Completed", archived: "Archived" };
export const PROJECT_TYPE_LABEL: Record<string, string> = { flip: "Flip", unit_turn: "Unit turn", rehab: "Rehab", common_area: "Common area", stabilization: "Stabilization", administrative: "Admin" };

/** Posted QuickBooks spend against the approved budget; partial reads are not exact shares. */
export function spentShare(project: ProjectSummary): number | undefined {
  if (project.postedActualCoverage !== "complete") return undefined;
  if (project.postedActualCents === null || !/^-?\d+$/.test(project.approvedBudgetCents ?? "") || !/^-?\d+$/.test(project.postedActualCents)) return undefined;
  const budget = BigInt(project.approvedBudgetCents!), spent = BigInt(project.postedActualCents);
  if (budget <= BigInt(0)) return undefined;
  // Keep the chart coordinate bounded while doing the money comparison in bigint cents.
  const scale = BigInt(1_000_000), scaled = (spent * scale) / budget;
  return Number(scaled > scale * BigInt(10_000) ? scale * BigInt(10_000) : scaled) / Number(scale);
}

/** Display a posted amount without turning a partial QBO read into an exact total. */
export function postedSpendLabel(project: { postedActualCents: string | null; postedActualCoverage: ProjectSummary["postedActualCoverage"] }): string {
  if (project.postedActualCents === null) return "Unknown";
  const amount = wholeCents(project.postedActualCents);
  return project.postedActualCoverage === "partial" ? `≥ ${amount}` : project.postedActualCoverage === "complete" ? amount : "Unknown";
}

/** Remaining amount on a company obligation, clamped at zero after payments. */
export type DashboardObligation = DashboardCompany["obligations"]["items"][number];
export function remainingObligationCents(item: { expectedCents: string | null; knownMinimumCents: string; paidCents: string; amountComplete?: boolean }): string | null {
  const amount = item.amountComplete === false ? item.knownMinimumCents : item.expectedCents ?? item.knownMinimumCents;
  if (!/^-?\d+$/.test(amount) || !/^-?\d+$/.test(item.paidCents)) return null;
  const remaining = BigInt(amount) - BigInt(item.paidCents);
  return (remaining > BigInt(0) ? remaining : BigInt(0)).toString();
}

export function obligationTotals(items: readonly DashboardObligation[], truncated = false): { total: string | null; complete: boolean } {
  if (new Set(items.map(item => item.currency)).size > 1) return { total: null, complete: false };
  const remaining = items.map(remainingObligationCents);
  const known = remaining.filter((value): value is NonNullable<typeof value> => value !== null);
  return {
    total: known.length ? sumCents(known) : null,
    complete: !truncated && items.every(item => item.expectedCents !== null && item.amountComplete !== false) && remaining.every(value => value !== null),
  };
}

export const openProject = (data: DashboardData, project?: { id: string }, organizationId?: string) => data.onOpenCompany ? () => data.onOpenCompany!("projects", organizationId ?? data.organizationId, project ? { projectTab: "overview", recordId: project.id } : { projectTab: "overview" }) : undefined;

/** The forecast week that contains the as-of date, then the ones after it. */
export function forecastWeeksFrom(result: ForecastResultView | undefined, asOfDate: string) {
  if (!result) return [];
  const index = result.weeks.findIndex(week => week.start <= asOfDate && asOfDate <= week.end);
  // A plan that ended before the selected date is stale; do not relabel old
  // weeks as "This week" or imply that they are a current forecast.
  return index < 0 ? [] : result.weeks.slice(index);
}

/** Draft plans are shown only with this label, never as the approved forecast. */
export function DraftBadge({ forecast }: { forecast: { isDraft?: boolean; scenario?: { name: string } } }) {
  return forecast.isDraft ? <span className="mk-draft" title="This scenario has not been approved in Forecasting">Draft plan · {forecast.scenario?.name ?? "not approved"}</span> : null;
}

export function ForecastGate({ forecast, children }: { forecast: ReturnType<typeof useForecast>; children: (result: ForecastResultView) => ReactNode }) {
  if (forecast.loading) return <Loading label="Loading cash forecast" />;
  if (forecast.list.error) return <Failed title="Forecast unavailable" error={forecast.list.error} retry={() => void forecast.list.refetch()} />;
  if (forecast.none) return <Empty title="No approved base forecast">Approve a base scenario under Forecasting to plan weekly cash.</Empty>;
  if (forecast.run.error) return <Failed title="Forecast could not run" error={forecast.run.error} retry={() => void forecast.run.refetch()} />;
  if (!forecast.result) return <Loading label="Loading cash forecast" />;
  if (!forecastWeeksFrom(forecast.result, forecast.asOfDate).length) return <Empty title="Forecast does not cover this date">Open Forecasting for a scenario covering the selected date.</Empty>;
  return <>{children(forecast.result)}</>;
}

/** Money for mockup cells: short above $10K, exact whole dollars below. */
const money = (cents: number | undefined | null) => cents === undefined || cents === null || !Number.isFinite(cents) ? "—" : Math.abs(cents) >= 1_000_000 ? kMoney(cents) : dollars(cents);
const shortName = (name: string) => name.replace(/^5Central\s*[-–]\s*/i, "").replace(/\s+(LLC|Inc\.?)$/i, "").replace(/\s+Apartments$/i, "").trim();

/* ---------- cash card ---------- */

type BankTransaction = { date: string; amountCents: number | null; pending: boolean; description: string };

/** Daily balance for the banking window, walked back from today's current balance. */
export function balanceHistory(currentCents: number, transactions: readonly BankTransaction[], fromDate: string, throughDate: string): Array<{ date: string; cents: number }> {
  const posted = transactions.filter(entry => !entry.pending && numeric(entry.amountCents));
  const days: Array<{ date: string; cents: number }> = [];
  let balance = currentCents;
  for (let date = throughDate; date >= fromDate && days.length < 120; date = addDays(date, -1)) {
    days.push({ date, cents: balance });
    // Plaid amounts: positive = money out. Before this day's activity the balance was higher by what left.
    for (const entry of posted) if (entry.date === date) balance += entry.amountCents as number;
  }
  return days.reverse();
}

function CashCard({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  const company = useCompanyDashboard(data);
  const cash = data.cash.data;
  const banking = data.banking.data;
  const weeks = forecastWeeksFrom(forecast.result, data.filters.asOfDate);
  const row = (label: ReactNode, value: ReactNode, tone?: "neg" | "pos") => <div className="mk-bk-r"><span>{label}</span><b className="mk-n" data-tone={tone}>{value}</b></div>;
  const transactions: BankTransaction[] = banking?.state === "ready" ? banking.connections.flatMap(connection => connection.transactions) : [];
  const receipts = sumKnown(data.receipts, "amountCents");
  const available = () => {
    if (data.cash.error) return <Failed title="Cash balance unavailable" retry={data.cash.refetch} />;
    if (!cash) return <Loading />;
    if (cash.state !== "ready") return <Empty title={cash.state === "unconfigured" ? "No bank connected" : "Bank balance unavailable"}>Connect the operating account under Accounting › Banking.</Empty>;
    const low = weeks.length ? weeks.reduce((min, week) => (centsNumber(week.availableClosingCents) ?? Infinity) < (centsNumber(min.availableClosingCents) ?? Infinity) ? week : min, weeks[0]!) : undefined;
    const relative = forecast.result?.summary.openingCashKnown === false;
    const history = banking?.state === "ready" && numeric(cash.currentCents) ? balanceHistory(cash.currentCents, transactions, banking.fromDate, banking.throughDate) : [];
    const spark = weeks.length > 2 && !relative ? { label: `Ending cash · next ${weeks.length} weeks${forecast.isDraft ? " (draft plan)" : ""}`, values: weeks.map(week => centsNumber(week.availableClosingCents) ?? null) }
      : history.length > 2 ? { label: `Balance · ${shortDay(history[0]!.date)} → today`, values: history.map(entry => entry.cents) } : undefined;
    return <div className="mk-bk">
      <div className="mk-bk-k">Available now <span>··{cash.mask}</span></div>
      <div className="mk-bk-n mk-n">{numeric(cash.availableCents) ? dollars(cash.availableCents) : "Unknown"}</div>
      <div className="mk-bk-rows">
        {row("Ledger balance", numeric(cash.currentCents) ? dollars(cash.currentCents) : "Unknown")}
        {numeric(cash.currentCents) && numeric(cash.availableCents) && cash.currentCents !== cash.availableCents && row("Payments in processing", dollars(cash.currentCents - cash.availableCents))}
        {row(`Rent received · ${data.monthLabel}`, receipts === undefined ? "—" : dollars(receipts), "pos")}
        {low && !relative && row(<>Low point next {weeks.length} wks <em>{shortDay(low.end)}</em></>, wholeCents(low.availableClosingCents), (centsNumber(low.availableClosingCents) ?? 0) < 2_500_000 ? "neg" : undefined)}
      </div>
      {spark && metrics.h >= 3 && <div className="mk-bk-spark"><span>{spark.label}</span><Spark values={spark.values} width={Math.max(120, metrics.bodyWidth)} height={44} /></div>}
    </div>;
  };
  const week = (index: number, label: string) => {
    if (forecast.loading) return <Loading />;
    if (forecast.none || forecast.list.error || forecast.run.error || !weeks[index]) {
      // No plan: show what actually moved through the bank this week instead.
      const start = addDays(data.filters.asOfDate, index === 0 ? -6 : -13), end = addDays(start, 6);
      if (index > 0 || banking?.state !== "ready") return <Empty title="No weekly plan">{forecast.none ? "Approve a base scenario under Forecasting to see next week." : "The cash forecast could not run."}</Empty>;
      const inWeek = transactions.filter(entry => !entry.pending && numeric(entry.amountCents) && entry.date >= start && entry.date <= data.filters.asOfDate);
      const inflow = inWeek.filter(entry => (entry.amountCents as number) < 0).reduce((sum, entry) => sum - (entry.amountCents as number), 0);
      const outflow = inWeek.filter(entry => (entry.amountCents as number) > 0).reduce((sum, entry) => sum + (entry.amountCents as number), 0);
      return <div className="mk-bk"><div className="mk-bk-k">Last 7 days <span>bank · {shortDay(start)}–{shortDay(end)}</span></div>
        <div className="mk-bk-n mk-n">{inflow - outflow < 0 ? "−" : "+"}{dollars(Math.abs(inflow - outflow))}</div>
        <div className="mk-bk-flow"><div><span>In</span><b className="mk-n">{dollars(inflow)}</b></div><div><span>Out</span><b className="mk-n">{dollars(outflow)}</b></div><div><span>Items</span><b className="mk-n">{inWeek.length}</b></div></div></div>;
    }
    const current = weeks[index]!;
    const lines = Object.entries(current.categories).map(([key, value]) => ({ key, cents: centsNumber(value) ?? 0 })).filter(line => line.cents !== 0).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)).slice(0, 4);
    const net = centsNumber(current.netCents) ?? 0;
    return <div className="mk-bk"><div className="mk-bk-k">{label} <span>ends {shortDay(current.end)}</span></div>
      <div className="mk-bk-n mk-n" data-tone={net < 0 ? "neg" : undefined}>{net < 0 ? "−" : "+"}{dollars(Math.abs(net))}</div>
      <div className="mk-bk-flow"><div><span>In</span><b className="mk-n">{wholeCents(current.inflowsCents)}</b></div><div><span>Out</span><b className="mk-n">{wholeCents(String(current.outflowsCents).replace(/^-/, ""))}</b></div><div><span>Ends at</span><b className="mk-n">{wholeCents(current.availableClosingCents)}</b></div></div>
      <div className="mk-bk-rows">{lines.map(line => row(CASH_CATEGORY_LABELS[line.key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(line.key), `${line.cents < 0 ? "−" : "+"}${dollars(Math.abs(line.cents))}`, line.cents > 0 ? "pos" : undefined))}</div>
      <DraftBadge forecast={forecast} /></div>;
  };
  const debt = () => {
    if (company.isLoading) return <Loading />;
    if (company.error || !company.data) return <Failed title="Company items unavailable" retry={() => void company.refetch()} />;
    const obligations = company.data.obligations.items;
    const totals = obligationTotals(obligations, company.data.obligations.truncated);
    const maturing = company.data.maturities.filter(item => item.maturityOn >= data.filters.asOfDate && item.maturityOn <= addDays(data.filters.asOfDate, 30));
    return <div className="mk-bk"><div className="mk-bk-k">Debt &amp; investors <span>next 30 days</span></div>
      <div className="mk-bk-n mk-n">{!obligations.length ? "$0" : totals.total === null ? "Unknown" : `${totals.complete ? "" : "≥ "}${wholeCents(totals.total)}`}</div>
      <div className="mk-bk-rows">{obligations.slice(0, 5).map(item => row(<>{item.accountName} <em>{shortDay(item.dueOn)}</em></>, wholeCents(remainingObligationCents(item))))}
        {maturing.map(item => row(<>{item.instrumentName} matures <em>{shortDay(item.maturityOn)}</em></>, wholeCents(item.outstandingPrincipalCents), "neg"))}
        {!obligations.length && !maturing.length && <p className="mk-cap">No investor payments or loan maturities recorded for the next 30 days.</p>}</div></div>;
  };
  const bigMoves = () => {
    if (banking?.state !== "ready") return <Empty title="Bank activity unavailable" />;
    const big = transactions.filter(entry => !entry.pending && numeric(entry.amountCents) && Math.abs(entry.amountCents as number) >= 500_000).sort((a, b) => b.date.localeCompare(a.date));
    return <div className="mk-bk"><div className="mk-bk-k">Big money moves <span>$5K+ · since {shortDay(banking.fromDate)}</span></div>
      <div className="mk-bk-n mk-n">{big.length}</div>
      <div className="mk-bk-rows">{big.slice(0, 5).map((entry, index) => row(<>{entry.description} <em>{shortDay(entry.date)}</em></>, `${(entry.amountCents as number) < 0 ? "+" : "−"}${kMoney(Math.abs(entry.amountCents as number))}`, (entry.amountCents as number) < 0 ? "pos" : undefined)).map((node, index) => <React.Fragment key={index}>{node}</React.Fragment>)}</div></div>;
  };
  return <Pager pages={[
    { key: "available", label: "Available cash", body: available() },
    { key: "this-week", label: "This week", body: week(0, "This week") },
    { key: "next-week", label: "Next week", body: week(1, "Next week") },
    { key: "big", label: "Big money moves", body: bigMoves() },
    { key: "debt", label: "Debt & investors · 30 days", body: debt() },
  ]} />;
}

/* ---------- rentals ---------- */

const isListed = (value: unknown): boolean => ["listed", "marketed", "active"].includes(String(value ?? "").trim().toLowerCase());

/** Occupied units per month from the trend read: portfolio or one property. */
export function occupiedHistory(data: DashboardData, propertyId?: string): Array<{ month: string; occupied: number | null; units: number | null }> {
  if (!data.trends.data) return [];
  return dashboardTrendPoints(data.trends.data).map(month => {
    const points = propertyId ? month.properties.filter(point => point.propertyId === propertyId) : month.properties;
    if (!points.length || points.some(point => point.occupiedUnitsKnown === false)) return { month: month.month, occupied: null, units: null };
    return { month: month.month, occupied: points.reduce((sum, point) => sum + point.occupiedUnits, 0), units: points.reduce((sum, point) => sum + point.unitCount, 0) };
  });
}

function RentalSummary({ data, metrics }: WidgetContext) {
  const units = sumKnown(data.propertyRows, "unitCount"), occupied = sumKnown(data.propertyRows, "occupied");
  const rent = sumKnown(data.propertyRows, "rent");
  const rentPartial = (data.propertyRows ?? []).some(row => Number(row.rentUnknown) > 0 || Number(row.unknown) > 0);
  const collected = sumKnown(data.receipts, "amountCents");
  const history = occupiedHistory(data);
  const previous = history.length > 1 ? history[history.length - 2]?.occupied : null;
  const delta = numeric(occupied) && numeric(previous) ? occupied - previous : undefined;
  const asOf = data.filters.asOfDate;
  const monthEnd = addDays(`${monthKeyOf(asOf, 1)}-01`, -1);
  const daysLeft = dayDiff(asOf, monthEnd);
  const vacant = (data.vacancy ?? []).filter(row => row.occupancy !== "future_preleased");
  const preleased = (data.vacancy ?? []).length - vacant.length;
  const priced = vacant.filter(row => numeric(row.marketRentCents));
  const vacancyKnown = priced.reduce((sum, row) => sum + (row.marketRentCents as number), 0);
  const unpriced = vacant.length - priced.length;
  const days = vacant.map(row => row.daysVacant).filter(numeric);
  const avgDays = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : undefined;
  const moves = data.movements ?? [];
  const outs = moves.filter(row => /out/i.test(String(row.movement))), ins = moves.filter(row => /in\b|in$|move-in/i.test(String(row.movement)) && !/out/i.test(String(row.movement)));
  const byUnit = new Map((data.rentRoll ?? []).map(row => [String(row.unitId), row] as const));
  const listed = vacant.filter(row => isListed(byUnit.get(String(row.unitId))?.listing)).length;
  const dueKnown = data.dueSplit?.knownCents;
  const collectedShare = collected !== undefined && rent ? collected / rent : undefined;
  const delinquency = dueKnown !== undefined && rent ? dueKnown / rent : undefined;
  const cells: Cell[] = [
    { key: "collected", label: "Collected MTD", value: collectedShare === undefined ? "—" : pct(collectedShare), sub: `${money(collected)} of ${money(rent)}${rentPartial ? "+" : ""} rent roll`, tone: collectedShare !== undefined && collectedShare < 0.5 ? "neg" : undefined },
    { key: "delinquency", label: "Delinquency", value: delinquency === undefined ? "—" : pct(delinquency), sub: data.dueSplit ? `${money(dueKnown)} owed · ${data.dueSplit.knownCount} account${data.dueSplit.knownCount === 1 ? "" : "s"}${data.dueSplit.unverifiedCount ? ` · ${data.dueSplit.unverifiedCount} unverified` : ""}` : "Loading", tone: delinquency !== undefined && delinquency > 0.1 ? "neg" : undefined },
    { key: "rent", label: "Rent roll", value: money(rent) + (rentPartial ? "+" : ""), sub: `${occupied ?? "—"} occupied units · monthly` },
    { key: "vacancy", label: "Vacancy cost", value: !data.vacancy ? "…" : !priced.length && unpriced ? "Not set" : `${unpriced ? "≥ " : ""}${money(vacancyKnown)}`, sub: `${vacant.length} units${avgDays !== undefined ? ` · ${avgDays} days avg` : ""}${unpriced ? ` · ${unpriced} without market rent` : ""}`, tone: !priced.length && unpriced ? "muted" : undefined },
    { key: "outs", label: "Move-outs", value: String(outs.length), sub: outs.length ? outs.map(row => shortDay(String(row.date))).join(" · ") : `none in ${data.monthLabel}` },
    { key: "ins", label: "Move-ins", value: String(ins.length), sub: ins.length ? ins.map(row => `${text(row.propertyName)} ${text(row.unitNumber)}`).slice(0, 2).join(", ") : `none in ${data.monthLabel}`, tone: ins.length ? "pos" : undefined },
    { key: "listed", label: "Listed", value: String(listed), sub: `of ${vacant.length} vacant units`, tone: vacant.length && listed < vacant.length ? "neg" : undefined },
    { key: "preleased", label: "Pre-leased", value: String(preleased), sub: "signed future tenants" },
    { key: "unverified", label: "Balances to verify", value: String(data.dueSplit?.unverifiedCount ?? "—"), sub: "not counted in delinquency", tone: data.dueSplit?.unverifiedCount ? "muted" : undefined },
  ];
  const columns = metrics.bodyWidth >= 620 ? 3 : 2;
  const month = new Date(`${asOf}T12:00:00`).toLocaleDateString("en-US", { month: "long" });
  return <div className="mk-rsum">
    <div className="mk-rsum-h"><div><b>{month}</b> <span className="mk-cap">· now · {daysLeft} day{daysLeft === 1 ? "" : "s"} left</span></div>
      {delta !== undefined && <Chip tone={delta >= 0 ? "ok" : "watch"}>{delta === 0 ? "Flat vs last month" : `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} unit${Math.abs(delta) === 1 ? "" : "s"}`}</Chip>}</div>
    <div className="mk-rsum-big">
      <span className="mk-n mk-n-xl">{occupied ?? "—"}</span><span className="mk-unit">/{units ?? "—"}</span>
      <span className="mk-n mk-n-m">{numeric(occupied) && units ? pct(occupied / units) : "—"}</span>
      {delta !== undefined && delta !== 0 && <span className="mk-delta" data-tone={delta > 0 ? "pos" : "neg"}>{delta > 0 ? "▲" : "▼"} {Math.abs(delta)} unit{Math.abs(delta) === 1 ? "" : "s"}</span>}
    </div>
    <Cells items={cells.slice(0, columns * Math.max(1, Math.min(3, Math.floor((metrics.bodyHeight - 96) / 64))))} columns={columns} />
  </div>;
}

function monthKeyOf(iso: string, offset: number): string {
  const date = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

type PropertyLine = Row & { propertyId: string; propertyName: string };
export function propertyLines(data: DashboardData): PropertyLine[] | undefined {
  if (!data.propertyRows) return undefined;
  const received = new Map(groupByProperty(data.receipts ?? [], () => ({ cents: 0, known: true }), (group, row) => { if (numeric(row.amountCents)) group.cents += row.amountCents; else group.known = false; }).map(group => [group.propertyId, group] as const));
  // Keep the unverified delinquency rows in the grouping.  `knownDue` is only
  // the numeric subset, so grouping it would make an unknown balance look like
  // zero for a property that has no other known rows.
  const dueRows = data.dueRows ?? data.knownDue;
  const due = new Map(groupByProperty(dueRows ?? [], () => ({ cents: 0, count: 0, known: true }), (group, row) => {
    if (numeric(row.operationalBalanceCents)) { group.cents += row.operationalBalanceCents; group.count += 1; }
    else group.known = false;
  }).map(group => [group.propertyId, group] as const));
  const vacant = new Map(groupByProperty((data.vacancy ?? []).filter(row => row.occupancy !== "future_preleased"), () => ({ cents: 0, known: true }), (group, row) => { if (numeric(row.marketRentCents)) group.cents += row.marketRentCents; else group.known = false; }).map(group => [group.propertyId, group] as const));
  return data.propertyRows.map(row => {
    const id = String(row.propertyId);
    const units = Number(row.unitCount) || 0, occupied = Number(row.occupied) || 0, rent = Number(row.rent) || 0;
    const got = received.get(id);
    const rentKnown = !row.rentUnknown && !row.unknown;
    return {
      ...row, propertyId: id, propertyName: text(row.propertyName),
      occupancyShare: units && !row.unknown ? occupied / units : null,
      rentCents: rentKnown ? rent : null,
      collectedCents: data.receipts ? got ? got.known ? got.cents : null : 0 : null,
      collectedShare: data.receipts && rentKnown && rent > 0 ? got ? got.known ? got.cents / rent : null : 0 : null,
      dueCents: dueRows ? due.get(id)?.known === false ? null : due.get(id)?.cents ?? 0 : null,
      dueCount: due.get(id)?.known === false ? 0 : due.get(id)?.count ?? 0,
      vacancyCents: data.vacancy ? vacant.get(id)?.known === false ? null : vacant.get(id)?.cents ?? 0 : null,
    } as PropertyLine;
  });
}

/** On track, watch or at risk from occupancy and past due as a share of rent. */
export function propertyStatus(line: Row): { tone: "ok" | "watch" | "risk"; label: string } | undefined {
  const occupancy = line.occupancyShare, due = line.dueCents, rent = line.rentCents;
  if (!numeric(occupancy)) return undefined;
  const dueShare = numeric(due) && numeric(rent) && rent > 0 ? due / rent : 0;
  if (occupancy < 0.7 || dueShare > 0.3) return { tone: "risk", label: "At risk" };
  if (occupancy < 0.9 || dueShare > 0.1) return { tone: "watch", label: "Watch" };
  return { tone: "ok", label: "On track" };
}

function RentalTable({ data, metrics }: WidgetContext) {
  const lines = propertyLines(data);
  if (!lines) return <Loading />;
  if (!lines.length) return <Empty title="No properties in scope" />;
  const city = (id: string) => data.snapshot.snapshot.properties.find(property => property.id === id)?.address?.city;
  const wide = metrics.bodyWidth >= 900;
  const units = sumKnown(lines, "unitCount"), occupied = sumKnown(lines, "occupied"), rent = sumKnown(lines, "rentCents"), collected = sumKnown(lines, "collectedCents"), due = sumKnown(lines, "dueCents");
  const portfolio = occupiedHistory(data);
  const trend = (history: ReturnType<typeof occupiedHistory>, total: number | null | undefined) => history.length > 1 ? <Spark width={wide ? 96 : 72} values={history.map(entry => entry.occupied)} reference={total ?? undefined} min={0} max={total ?? undefined} /> : <span className="mk-cap">—</span>;
  const collectedCell = (value: unknown, share: unknown) => <span className="mk-coll"><span className="mk-meter" aria-hidden="true"><i style={{ width: `${numeric(share) ? Math.min(100, share * 100) : 0}%` }} data-tone={numeric(share) && share < 0.5 ? "neg" : undefined} /></span><b>{numeric(value) ? dollars(value) : "—"}</b><small data-tone={numeric(share) && share < 0.5 ? "neg" : undefined}>{numeric(share) ? pct(share) : ""}</small></span>;
  const rows = lines.slice(0, Math.max(1, Math.floor((metrics.bodyHeight - 70) / 46)));
  return <div className="mk-tw"><table className="mk-rt">
    <thead><tr><th>Property</th><th>Units</th><th>Occupied</th><th className="c">Occupancy · 12 mo</th><th>Rent roll</th><th>Collected · {monthShort(data.filters.asOfDate)}</th><th>Past due</th>{wide && <th>Vacancy cost</th>}<th>Status</th></tr></thead>
    <tbody>{rows.map(line => {
      const status = propertyStatus(line);
      return <tr key={line.propertyId}>
        <td className="nm">{propertyLink(data, line)}<small>{city(line.propertyId) ?? `${text(line.unitCount)} units`}</small></td>
        <td>{text(line.unitCount)}</td>
        <td><span className="big">{text(line.occupied)}</span><span className="mk-t3"> · {numeric(line.occupancyShare) ? pct(line.occupancyShare) : "—"}</span></td>
        <td className="c">{trend(occupiedHistory(data, line.propertyId), Number(line.unitCount) || null)}</td>
        <td>{numeric(line.rentCents) ? dollars(line.rentCents) : "Unknown"}</td>
        <td>{collectedCell(line.collectedCents, line.collectedShare)}</td>
        <td>{numeric(line.dueCents) ? <><span data-tone={line.dueCents > 0 ? "neg" : undefined}>{dollars(line.dueCents)}</span>{numeric(line.rentCents) && line.rentCents > 0 && <span className="mk-t3"> · {pct(line.dueCents / line.rentCents)}</span>}</> : "Unknown"}</td>
        {wide && <td>{numeric(line.vacancyCents) ? dollars(line.vacancyCents) : <span className="mk-cap">market rent not set</span>}</td>}
        <td>{status ? <Chip tone={status.tone}>{status.label}</Chip> : <span className="mk-cap">—</span>}</td>
      </tr>;
    })}</tbody>
    <tfoot><tr><td className="nm">Portfolio</td><td>{units ?? "—"}</td><td><span className="big">{occupied ?? "—"}</span><span className="mk-t3"> · {numeric(occupied) && units ? pct(occupied / units) : "—"}</span></td>
      <td className="c">{trend(portfolio, units)}</td><td>{money(rent)}</td><td>{collectedCell(collected, collected !== undefined && rent ? collected / rent : undefined)}</td>
      <td>{due === undefined ? "Unknown" : <>{dollars(due)}{rent ? <span className="mk-t3"> · {pct(due / rent)}</span> : null}</>}</td>{wide && <td>{money(sumKnown(lines, "vacancyCents"))}</td>}<td /></tr></tfoot>
  </table></div>;
}

function OccupancyTrend({ data, metrics }: WidgetContext) {
  if (data.trends.error) return <Failed title="Trend unavailable" error={data.trends.error} retry={data.trends.retry} />;
  if (!data.trends.data) return <Loading />;
  const history = occupiedHistory(data);
  const total = history.map(entry => entry.units).filter(numeric).at(-1);
  const points = history.map(entry => ({ label: monthShort(entry.month), value: entry.occupied }));
  const last = [...history].reverse().find(entry => numeric(entry.occupied));
  const first = history.find(entry => numeric(entry.occupied));
  const change = last && first && numeric(last.occupied) && numeric(first.occupied) ? last.occupied - first.occupied : undefined;
  const series = dashboardChartSeries(data.trends.data, "portfolio", "occupancy", "units")[0];
  void series;
  return <div className="mk-trend">
    <div className="mk-trend-h"><span className="mk-n mk-n-m">{last?.occupied ?? "—"}<span className="mk-unit">/{total ?? "—"} occupied</span></span>{change !== undefined && <span className="mk-delta" data-tone={change >= 0 ? "pos" : "neg"}>{change >= 0 ? "▲" : "▼"} {Math.abs(change)} over {history.length} mo</span>}</div>
    <AxisChart width={metrics.bodyWidth} height={metrics.bodyHeight - 40} points={points} yMin={0} yMax={total ? Math.ceil(total / 10) * 10 : undefined} reference={total} ticks={3} />
  </div>;
}

/* ---------- QuickBooks summary ---------- */

function QboSummary({ data, metrics }: WidgetContext) {
  const { organization, gate } = useCompanyGate(data);
  const reports = useFinancialReports(data, "income-statement");
  const close = useCloseChecklists(data);
  const { entities, health } = useQboEntities(data);
  if (gate) return gate;
  if (health.error) return <Failed title="QuickBooks status unavailable" error={health.error} retry={() => void health.refetch()} />;
  if (!entities) return <Loading label="Loading QuickBooks" />;
  if (!entities.length) return <Empty title="QuickBooks not connected">Connect an entity under Accounting › Connections.</Empty>;
  const available = entities.filter(entity => entity.available !== false);
  const mixed = new Set(available.map(entity => entity.currency)).size > 1;
  const loading = reports.rows.some(row => row.loading);
  const total = (group: string) => {
    const values = reports.rows.map(row => financialFigure(row.report, group));
    const known = values.filter((value): value is NonNullable<typeof value> => value !== null);
    return { cents: known.length ? sumCents(known) : null, complete: !mixed && values.length > 0 && known.length === values.length, known: known.length };
  };
  const show = (group: string) => { if (loading) return "…"; if (mixed) return "Multiple currencies"; const result = total(group); return !result.known ? "Unavailable" : result.complete ? kMoney(result.cents) : "Unknown"; };
  const noi = total("NetOperatingIncome"), net = total("NetIncome");
  const closeRows = close.rows.filter(row => row.entity.available !== false);
  const closeDone = closeRows.filter(row => row.checklist && row.checklist.completeCount === row.checklist.items.length).length;
  const blocker = closeRows.flatMap(row => row.checklist?.items.filter(item => item.state !== "complete") ?? [])[0];
  const lastSync = entities.map(entity => entity.health.lastSuccessfulSyncAt).filter((value): value is NonNullable<typeof value> => !!value).sort()[0];
  const failed = entities.reduce((sum, entity) => sum + entity.health.jobs.dead, 0);
  const exceptions = entities.reduce((sum, entity) => sum + entity.health.openSyncExceptions, 0);
  const ago = (iso?: string) => { if (!iso) return "never"; const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000); return minutes < 60 ? `${Math.max(1, minutes)}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`; };
  const cells: Cell[] = [
    { key: "noi", label: `NOI · ${data.filters.asOfDate.slice(0, 4)} YTD`, value: show("NetOperatingIncome"), sub: `${show("Income")} income`, tone: (centsNumber(noi.cents) ?? 0) < 0 && noi.complete ? "neg" : undefined },
    { key: "net", label: "After interest", value: show("NetIncome"), sub: `${show("OtherExpenses")} other expenses`, tone: (centsNumber(net.cents) ?? 0) < 0 && net.complete ? "neg" : undefined },
    { key: "close", label: `${monthShort(close.month)} close`, value: close.loading ? "…" : <>{closeDone}<span className="mk-unit">/{closeRows.length}</span></>, sub: blocker ? blocker.label : closeRows.length ? "all checks complete" : "no connected entities" },
    { key: "sync", label: "QuickBooks", value: <>{available.length}<span className="mk-unit">/{entities.length}</span></>, sub: `synced ${ago(lastSync ?? undefined)}${failed ? ` · ${failed} failed jobs` : ""}${exceptions ? ` · ${exceptions} exceptions` : ""}`, tone: failed || exceptions ? undefined : undefined },
  ];
  const entityProps = (id: string) => organization?.entities.find(entity => entity.id === id)?.properties.map(property => shortName(property.name)).join(" · ") ?? "";
  const rows = reports.rows.slice(0, Math.max(0, Math.floor((metrics.bodyHeight - 130) / 30)));
  return <div className="mk-qb">
    <Cells items={cells} columns={metrics.bodyWidth >= 560 ? 4 : 2} />
    {rows.length > 0 && <div className="mk-rows">{rows.map(row => { const value = row.loading ? undefined : financialFigure(row.report, "NetOperatingIncome"); return <div key={row.entity.scope.legalEntityId} className="mk-r"><span className="k">{shortName(row.entity.name)} <span className="mk-t3">· {entityProps(row.entity.scope.legalEntityId) || "no properties"}</span></span><span className="v" data-tone={(centsNumber(value) ?? 0) < 0 ? "neg" : undefined}>{row.loading ? "…" : value === null ? "Unavailable" : kMoney(value)} <span className="mk-t3">NOI</span></span></div>; })}</div>}
  </div>;
}

/* ---------- coming up ---------- */

type Upcoming = { key: string; date: string; title: string; detail: string; tone?: "critical" | "warning" | "neutral"; kind: string; onOpen?: () => void };

function ComingUp({ data }: WidgetContext) {
  const asOf = data.filters.asOfDate, until = addDays(asOf, 30);
  const { organization } = useDashboardOrganization(data);
  const company = useCompanyDashboard(data);
  const projects = useProjects(data);
  const details = useProjectDetails(data, projects.data);
  const deals = useOpenProjectDeals(data, projects.data);
  const leases = useExtraRentalRows(data, "lease-expiration", ["propertyName", "unitNumber", "tenantName", "contractEndOn", "noticeDeadlineOn", "monthToMonth", "actionStatus", "personId", "unitId"]);
  const items = useMemo(() => {
    const list: Upcoming[] = [];
    const within = (date: string | null | undefined) => !!date && date >= asOf && date <= until;
    for (const row of data.movements ?? []) if (within(String(row.date ?? ""))) list.push({ key: `move-${row.tenantName}-${row.date}`, date: String(row.date), kind: "Move", title: `${text(row.movement)} · ${text(row.propertyName)} ${text(row.unitNumber)}`, detail: text(row.tenantName) });
    const firstOfNext = `${monthKeyOf(asOf, 1)}-01`;
    if (within(firstOfNext) && (data.propertyRows?.length ?? 0) > 0) list.push({ key: "rent-due", date: firstOfNext, kind: "Rent", title: "Rent due", detail: `${money(sumKnown(data.propertyRows, "rent"))} scheduled across ${data.propertyRows!.length} properties` });
    for (const row of leases.rows ?? []) {
      if (within(String(row.contractEndOn ?? ""))) list.push({ key: `lease-${row.unitId}-${row.contractEndOn}`, date: String(row.contractEndOn), kind: "Lease", title: `Lease ends · ${text(row.propertyName)} ${text(row.unitNumber)}`, detail: text(row.tenantName), tone: "warning" });
      else if (within(String(row.noticeDeadlineOn ?? ""))) list.push({ key: `notice-${row.unitId}-${row.noticeDeadlineOn}`, date: String(row.noticeDeadlineOn), kind: "Notice", title: `Renewal notice due · ${text(row.propertyName)} ${text(row.unitNumber)}`, detail: text(row.tenantName) });
    }
    for (const project of projects.data ?? []) {
      if (project.status === "completed") continue;
      if (within(project.targetOn)) list.push({ key: `target-${project.id}`, date: project.targetOn!, kind: "Project", title: `${project.name} · target`, detail: propertyNameFor(data, organization, project.propertyId), tone: "warning", onOpen: openProject(data, project, organization?.id) });
      if (within(project.startOn)) list.push({ key: `start-${project.id}`, date: project.startOn!, kind: "Project", title: `${project.name} · starts`, detail: propertyNameFor(data, organization, project.propertyId), onOpen: openProject(data, project, organization?.id) });
      const sale = deals.byId.get(project.id)?.saleForecast?.saleOn;
      if (within(sale)) list.push({ key: `sale-${project.id}`, date: sale!, kind: "Sale", title: `${project.name} · sale closes`, detail: kMoney(deals.byId.get(project.id)?.saleForecast?.grossProceedsCents ?? null), onOpen: openProject(data, project, organization?.id) });
    }
    for (const project of details.details) for (const task of project.tasks) {
      if (task.archivedAt || task.status === "completed" || task.status === "cancelled") continue;
      const overdue = !!task.dueOn && task.dueOn < asOf;
      if (overdue || within(task.dueOn)) list.push({ key: `task-${task.id}`, date: task.dueOn!, kind: "Task", title: task.title, detail: `${project.name}${overdue ? " · overdue" : ""}`, tone: overdue || task.status === "blocked" ? "critical" : undefined, onOpen: openProject(data, project, organization?.id) });
    }
    for (const item of company.data?.obligations.items ?? []) {
      const remaining = remainingObligationCents(item);
      if (item.expectedCents !== null && item.amountComplete !== false && remaining === "0") continue;
      if (within(item.dueOn)) list.push({ key: `obligation-${item.obligationId}`, date: item.dueOn, kind: "Investor", title: `${item.accountName} payment`, detail: `${item.expectedCents === null || item.amountComplete === false ? "≥ " : ""}${wholeCents(remaining)}` });
    }
    for (const item of company.data?.maturities ?? []) if (within(item.maturityOn)) list.push({ key: `maturity-${item.instrumentId}`, date: item.maturityOn, kind: "Loan", title: `${item.instrumentName} matures`, detail: `${item.accountName}${item.outstandingPrincipalCents ? ` · ${wholeCents(item.outstandingPrincipalCents)}` : ""}`, tone: "critical" });
    for (const item of company.data?.workDue.items ?? []) if (item.scheduledOn) list.push({ key: `work-${item.id}`, date: item.scheduledOn, kind: "Work", title: item.title, detail: `${item.propertyName ?? ""}${item.unitNumber ? ` ${item.unitNumber}` : ""}${item.overdue ? " · overdue" : ""}`, tone: item.overdue ? "critical" : undefined });
    return list.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }, [asOf, until, data, leases.rows, projects.data, details.details, company.data, organization, deals.byId]);
  const loading = !data.movements || leases.loading || projects.isLoading || company.isLoading || (!!projects.data && details.loading);
  const incomplete = !!leases.error || !!projects.error || !!company.error || details.incomplete || !!company.data?.obligations.truncated;
  if (!items.length) return loading ? <Loading /> : incomplete ? <Empty title="Upcoming data incomplete">Some project, company or lease records could not be read.</Empty> : <Empty title="Nothing in the next 30 days">Moves, lease ends, project dates, tasks, loan maturities and investor payments show here.</Empty>;
  return <div className="mk-up">{items.map(item => {
    const days = dayDiff(asOf, item.date);
    return <div key={item.key} className="mk-up-r" data-tone={item.tone}>
      <span className="mk-dd" data-tone={days < 0 || item.tone === "critical" ? "neg" : undefined}>{Math.abs(days)}<small>{days < 0 ? "days late" : days === 1 ? "day" : "days"}</small></span>
      <span className="mk-up-t">{item.onOpen ? <button type="button" className="rops-link" onClick={item.onOpen}>{item.title}</button> : <b>{item.title}</b>}<small>{weekday(item.date)} · {item.kind}{item.detail ? ` · ${item.detail}` : ""}</small></span>
    </div>;
  })}{incomplete && <p className="mk-cap">Some items unavailable</p>}</div>;
}

/* ---------- weekly cash plan ---------- */

const IN_CATEGORIES = new Set(["tenant_receipts", "subsidy_receipts", "pm_remittances", "deposits", "loan_proceeds", "sale_proceeds"]);

function CashflowGrid({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const count = Math.max(2, Math.min(weeks.length, Math.floor((metrics.bodyWidth - 190) / 66)));
    const shown = weeks.slice(0, count);
    const relative = result.summary.openingCashKnown === false;
    const keys = Array.from(new Set(shown.flatMap(week => Object.keys(week.categories)))).filter(key => shown.some(week => (centsNumber(week.categories[key]) ?? 0) !== 0));
    const total = (key: string) => shown.reduce((sum, week) => sum + (centsNumber(week.categories[key]) ?? 0), 0);
    const incoming = keys.filter(key => IN_CATEGORIES.has(key) || (!IN_CATEGORIES.has(key) && total(key) > 0 && key === "investor")).sort((a, b) => total(b) - total(a));
    const outgoing = keys.filter(key => !incoming.includes(key)).sort((a, b) => total(a) - total(b));
    const label = (key: string) => CASH_CATEGORY_LABELS[key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(key);
    const cell = (value: string | number | undefined, key: string, strong = false) => { const cents = typeof value === "number" ? value : centsNumber(value); return <td key={key} className={strong ? "is-strong" : undefined} data-tone={cents !== undefined && cents < 0 ? "neg" : undefined}>{cents === undefined ? "—" : cents === 0 ? <span className="z">–</span> : kMoney(Math.abs(cents))}</td>; };
    const ending = shown.map(week => centsNumber(week.availableClosingCents) ?? null);
    const low = shown.reduce((min, week) => (centsNumber(week.availableClosingCents) ?? Infinity) < (centsNumber(min.availableClosingCents) ?? Infinity) ? week : min, shown[0]!);
    const last = shown.at(-1)!;
    return <div className="mk-cf">
      <div className="mk-cf-top">
        <div><span className="mk-lbl">Low point</span><b className="mk-n mk-n-l" data-tone={(centsNumber(low.availableClosingCents) ?? 0) < 0 ? "neg" : undefined}>{relative ? "Unknown" : wholeCents(low.availableClosingCents)}</b><small>week of {shortDay(low.start)}</small></div>
        <div><span className="mk-lbl">{shortDay(last.end)}</span><b className="mk-n mk-n-l">{relative ? "Unknown" : wholeCents(last.availableClosingCents)}</b><small>ending cash{relative ? " · opening cash not set" : ""}</small></div>
        <div className="mk-cf-chart">{!relative && <AxisChart width={Math.max(160, metrics.bodyWidth - 380)} height={96} points={shown.map((week, index) => ({ label: shortDay(week.start), value: ending[index] ?? null }))} format={value => shortCents(value)} ticks={2} />}</div>
      </div>
      <div className="mk-cf-meta"><span>{result.scenario.name}</span><DraftBadge forecast={forecast} />{result.completeness === "partial" && <span className="mk-cap">partial inputs</span>}</div>
      <div className="mk-cf-wrap"><table className="mk-cf-table">
        <thead><tr><th />{shown.map((week, index) => <th key={week.key} className={index === 0 ? "now" : undefined}>{shortDay(week.start)}</th>)}</tr></thead>
        <tbody>
          <tr className="bal"><th>{relative ? "Starting cash (relative)" : "Starting cash"}</th>{shown.map(week => cell(week.openingCashCents, week.key))}</tr>
          {incoming.length > 0 && <tr className="sec"><th colSpan={shown.length + 1}>Money in</th></tr>}
          {incoming.map(key => <tr key={key} className="grp"><th>{label(key)}</th>{shown.map(week => cell(week.categories[key], week.key))}</tr>)}
          {outgoing.length > 0 && <tr className="sec"><th colSpan={shown.length + 1}>Money out</th></tr>}
          {outgoing.map(key => <tr key={key} className="grp"><th>{label(key)}</th>{shown.map(week => cell(week.categories[key], week.key))}</tr>)}
          <tr className="net"><th>Net</th>{shown.map(week => { const cents = centsNumber(week.netCents); return <td key={week.key} data-tone={(cents ?? 0) < 0 ? "neg" : undefined}>{cents === undefined ? "—" : `${cents < 0 ? "−" : "+"}${kMoney(Math.abs(cents))}`}</td>; })}</tr>
          <tr className="end"><th>Ending cash</th>{shown.map(week => cell(week.availableClosingCents, week.key, true))}</tr>
        </tbody></table></div>
      <Foot action="Open forecast" onAction={companyOpener(data, "forecasting", { forecastTab: "cash" })}>{`Actuals through ${shortDay(result.actualsCutoff)}`}{result.summary.weeksBelowFloor ? ` · ${result.summary.weeksBelowFloor} weeks below reserve` : ""}</Foot>
    </div>;
  }}</ForecastGate>;
}

/* ---------- projects block ---------- */

function useProjectsGate(data: DashboardData) {
  const { organization, gate } = useCompanyGate(data);
  const projects = useProjects(data);
  const blocked = gate ?? (projects.error ? <Failed title="Projects unavailable" error={projects.error} retry={() => void projects.refetch()} /> : !projects.data ? <Loading label="Loading projects" /> : null);
  return { organization, projects: projects.data, gate: blocked };
}

type Deal = ProjectDealCostReport | undefined;
const rehabLane = (deal: Deal) => deal?.byLane?.find(lane => lane.lane === "rehab");

/** Rehab budget: the approved project budget, else the deal's rehab lane budget. */
export function rehabBudgetCents(project: ProjectSummary, deal: Deal): string | null {
  return project.approvedBudgetCents ?? rehabLane(deal)?.budgetCents ?? null;
}

/** Rehab spend: complete QuickBooks actuals, else verified or source-backed rehab costs on the deal. */
export function rehabSpentCents(project: ProjectSummary, deal: Deal): { cents: string | null; source: "qbo" | "deal" | "none" } {
  if (project.postedActualCoverage === "complete" && project.postedActualCents !== null) return { cents: project.postedActualCents, source: "qbo" };
  const lane = rehabLane(deal);
  if (lane?.incurredCents) return { cents: lane.incurredCents, source: "deal" };
  return { cents: null, source: "none" };
}

function share(numerator: string | null, denominator: string | null): number | undefined {
  const top = centsNumber(numerator), bottom = centsNumber(denominator);
  return top !== undefined && bottom !== undefined && bottom > 0 ? top / bottom : undefined;
}

function ProjectTotals({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectsGate(data);
  const open = openProjects(projects) ?? [];
  const deals = useOpenProjectDeals(data, projects);
  const flipDeals = useDealReports(data, projects ? open : undefined);
  if (gate) return gate;
  if (!open.length) return <Empty title="No open projects">Projects you add appear here with budgets and spend.</Empty>;
  const flips = open.filter(project => project.projectType === "flip");
  const budgets = open.map(project => rehabBudgetCents(project, deals.byId.get(project.id)));
  const budgetSet = budgets.filter((value): value is NonNullable<typeof value> => value !== null);
  const spent = open.map(project => rehabSpentCents(project, deals.byId.get(project.id)).cents).filter((value): value is NonNullable<typeof value> => value !== null);
  const costToDate = open.map(project => deals.byId.get(project.id)?.totals?.incurredCents ?? null).filter((value): value is NonNullable<typeof value> => value !== null);
  const sales = flipDeals.reports.map(entry => entry.report?.saleForecast?.grossProceedsCents ?? null);
  const salesSet = sales.filter((value): value is NonNullable<typeof value> => value !== null);
  const profits = flipDeals.reports.map(entry => entry.report?.coverage?.status === "complete" && entry.report.saleForecast?.profitState === "complete" ? entry.report.saleForecast!.projectedProfitCents : null);
  const profit = !flipDeals.incomplete && profits.length === flips.length && profits.every(value => value !== null) ? sumCents(profits) : null;
  const cells: Cell[] = [
    { key: "sales", label: "Projected sales", value: flipDeals.loading ? "…" : salesSet.length ? kMoney(sumCents(salesSet)) : "Not set", sub: `${salesSet.length} of ${flips.length} flip${flips.length === 1 ? "" : "s"} priced`, tone: salesSet.length ? undefined : "muted" },
    { key: "profit", label: "Projected flip profit", value: flipDeals.loading ? "…" : !flips.length ? "—" : profit === null ? (profits.some(value => value !== null) ? "Unknown" : "Not set") : kMoney(profit), sub: `${flips.length} flip${flips.length === 1 ? "" : "s"}${profit === null && flips.length ? " · add sale forecasts in Projects" : ""}`, tone: profit === null ? "muted" : undefined },
    { key: "rehab", label: "Rehab spent", value: deals.loading ? "…" : spent.length ? kMoney(sumCents(spent)) : "Not recorded", sub: !budgetSet.length ? "no rehab budgets set in Projects" : `of ${kMoney(sumCents(budgetSet))} budget${budgetSet.length < open.length ? ` · ${open.length - budgetSet.length} without budget` : ""}`, tone: spent.length ? undefined : "muted" },
    { key: "cost", label: "Cost to date", value: deals.loading ? "…" : costToDate.length ? kMoney(sumCents(costToDate)) : "Not recorded", sub: `${open.length} open · acquisition, rehab, holding`, tone: costToDate.length ? undefined : "muted" },
  ];
  return <Cells items={cells} columns={metrics.bodyWidth >= 560 ? 4 : 2} />;
}

function RehabRings({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectsGate(data);
  const deals = useOpenProjectDeals(data, projects);
  if (gate) return gate;
  const open = (openProjects(projects) ?? []).filter(project => project.projectType !== "administrative");
  if (!open.length) return <Empty title="No open projects" />;
  const size = Math.max(48, Math.min(76, metrics.bodyHeight - 58));
  const fit = Math.max(1, Math.floor((metrics.bodyWidth + 10) / (size + 30)));
  const asOf = data.filters.asOfDate;
  return <div className="mk-rings">{open.slice(0, fit).map(project => {
    const deal = deals.byId.get(project.id);
    const budget = rehabBudgetCents(project, deal);
    const spent = rehabSpentCents(project, deal);
    const ratio = share(spent.cents, budget);
    const caption = project.targetOn ? daysLabel(asOf, project.targetOn) : budget === null ? "no budget" : spent.cents === null ? "no spend yet" : `${kMoney(spent.cents)} spent`;
    return <button key={project.id} type="button" className="mk-ring" onClick={openProject(data, project, project.organizationId)} title={`${project.name}: ${spent.cents === null ? "no spend recorded" : wholeCents(spent.cents)} of ${budget === null ? "no budget" : wholeCents(budget)}`}>
      <Ring share={ratio} size={size} tone={ratio !== undefined && ratio > 1 ? "critical" : "accent"} label={ratio === undefined ? "—" : pct(ratio)} />
      <b>{shortName(project.name.replace(/\s+(flip|rehab)$/i, ""))}</b>
      <span data-tone={project.targetOn && project.targetOn < asOf ? "neg" : undefined}>{caption}</span>
    </button>;
  })}</div>;
}

/** Milestones for one project: start, rehab target, sale; each may be missing. */
function milestones(project: ProjectSummary, deal: Deal) {
  return { start: project.startOn, target: project.targetOn, sale: deal?.saleForecast?.saleOn ?? null };
}

function Gantt({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectsGate(data);
  const details = useProjectDetails(data, projects);
  const deals = useOpenProjectDeals(data, projects);
  if (gate) return gate;
  const asOf = data.filters.asOfDate;
  const open = (openProjects(projects) ?? []).filter(project => project.projectType !== "administrative");
  if (!open.length) return <Empty title="No open projects" />;
  const tasksFor = (project: ProjectSummary): ProjectDetail["tasks"] => details.details.find(detail => detail.id === project.id)?.tasks.filter(task => task.dueOn && !task.archivedAt && task.status !== "cancelled") ?? [];
  const dates = open.flatMap(project => { const m = milestones(project, deals.byId.get(project.id)); return [m.start, m.target, m.sale, ...tasksFor(project).map(task => task.dueOn)]; }).filter((value): value is NonNullable<typeof value> => !!value);
  const from = [addDays(asOf, -21), ...dates].sort()[0]!, to = [addDays(asOf, 120), ...dates].sort().at(-1)!;
  const span = Math.max(1, dayDiff(from, to));
  const x = (date: string) => Math.max(0, Math.min(100, dayDiff(from, date) / span * 100));
  const months: string[] = [];
  for (let month = monthKeyOf(from, 1); month <= to.slice(0, 7) && months.length < 24; month = monthKeyOf(`${month}-01`, 1)) months.push(month);
  const rowHeight = Math.max(30, Math.min(52, Math.floor((metrics.bodyHeight - 60) / Math.max(1, open.length))));
  const rows = open.sort((a, b) => (milestones(a, deals.byId.get(a.id)).target ?? "9999").localeCompare(milestones(b, deals.byId.get(b.id)).target ?? "9999")).slice(0, Math.max(1, Math.floor((metrics.bodyHeight - 60) / rowHeight)));
  return <div className="mk-gt" style={{ ["--gl" as string]: `${Math.min(190, Math.max(110, metrics.bodyWidth * 0.16))}px` }}>
    <div className="mk-gt-axis">{months.map(month => <span key={month} style={{ left: `${x(`${month}-01`)}%` }}>{monthShort(month)}{month.endsWith("-01") ? ` ’${month.slice(2, 4)}` : ""}</span>)}<b className="mk-gt-today" style={{ left: `${x(asOf)}%`, height: 22 + rows.length * rowHeight }}><span>Today</span></b></div>
    {rows.map(project => {
      const m = milestones(project, deals.byId.get(project.id));
      const deal = deals.byId.get(project.id);
      const ratio = share(rehabSpentCents(project, deal).cents, rehabBudgetCents(project, deal));
      const rehabEnd = m.target ?? (m.start ? null : null);
      const late = !!m.target && m.target < asOf;
      const stage = !m.start && !m.target && !m.sale ? "No dates set" : late ? `${dayDiff(m.target!, asOf)}d past target` : m.target ? `Target ${shortDay(m.target)}` : PROJECT_STATUS_LABEL[project.status];
      return <div key={project.id} className="mk-gt-row" style={{ height: rowHeight }}>
        <button type="button" className="mk-gt-lab" onClick={openProject(data, project, organization?.id)}><b>{shortName(project.name.replace(/\s+(flip|rehab)$/i, ""))}</b><span data-tone={late ? "neg" : undefined}>{stage}</span></button>
        <div className="mk-gt-lane">
          {m.start && rehabEnd && <i className="mk-gt-bar reh" style={{ left: `${x(m.start)}%`, width: `${Math.max(0.8, x(rehabEnd) - x(m.start))}%` }} title={`Rehab ${shortDay(m.start)} → ${shortDay(rehabEnd)}`}><b style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%` }} /></i>}
          {m.start && !rehabEnd && <i className="mk-gt-pre" style={{ left: `${x(m.start)}%`, width: `${Math.max(0.8, x(asOf) - x(m.start))}%` }} title={`Started ${shortDay(m.start)} · no target date`} />}
          {!m.start && m.target && <i className="mk-gt-pre" style={{ left: `${x(asOf)}%`, width: `${Math.max(0.8, x(m.target) - x(asOf))}%` }} title={`Target ${shortDay(m.target)} · no start date`} />}
          {(m.target ?? m.start) && m.sale && <i className="mk-gt-bar mkt" style={{ left: `${x((m.target ?? m.start)!)}%`, width: `${Math.max(0.8, x(m.sale) - x((m.target ?? m.start)!))}%` }} title={`Listing to sale · ${shortDay(m.sale)}`} />}
          {m.sale && <i className="mk-gt-ms" style={{ left: `${x(m.sale)}%` }} title={`Sale closes ${shortDay(m.sale)}`} />}
          {m.target && <i className="mk-gt-tgt" data-tone={late ? "neg" : undefined} style={{ left: `${x(m.target)}%` }} title={`Target ${shortDay(m.target)}`} />}
          {tasksFor(project).map(task => <em key={task.id} className="mk-gt-task" data-tone={task.status === "completed" ? "done" : task.dueOn! < asOf ? "neg" : undefined} style={{ left: `${x(task.dueOn!)}%` }} title={`${task.title} · ${shortDay(task.dueOn)}`} />)}
          {!m.start && !m.target && !m.sale && <span className="mk-gt-none">Add start, target or sale dates in Projects</span>}
        </div>
      </div>;
    })}
    <div className="mk-gt-leg"><span><i className="k reh" />Rehab (fill = spend of budget)</span><span><i className="k mkt" />Listing → sale</span><span><i className="k ms" />Sale close</span><span><i className="k tgt" />Target</span><span><i className="k task" />Task due</span></div>
  </div>;
}

function ProjectBoard({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectsGate(data);
  const open = openProjects(projects) ?? [];
  const deals = useOpenProjectDeals(data, projects);
  const flipDeals = useDealReports(data, projects ? open : undefined);
  if (gate) return gate;
  if (flipDeals.loading) return <Loading label="Loading deal reports" />;
  if (!open.length) return <Empty title="No open projects">Projects you add appear here.</Empty>;
  const asOf = data.filters.asOfDate;
  const entityName = (id: string) => shortName(organization?.entities.find(entity => entity.id === id)?.name ?? "");
  const rowHeight = 92;
  const rows = open.slice(0, Math.max(1, Math.floor((metrics.bodyHeight - 30) / rowHeight)));
  return <div className="mk-pjs">{rows.map(project => {
    const deal = deals.byId.get(project.id) ?? flipDeals.reports.find(entry => entry.project.id === project.id)?.report;
    const budget = rehabBudgetCents(project, deal);
    const spent = rehabSpentCents(project, deal);
    const ratio = share(spent.cents, budget);
    const m = milestones(project, deal);
    const sale = deal?.saleForecast;
    const profit = sale && deal?.coverage?.status === "complete" && sale.profitState === "complete" ? sale.projectedProfitCents : null;
    const cushion = share(profit, sale?.grossProceedsCents ?? null);
    const late = !!m.target && m.target < asOf && project.status !== "completed";
    const over = ratio !== undefined && ratio > 1;
    const status = late || over ? { tone: "risk" as const, label: late ? "Past target" : "Over budget" } : !budget || (!m.target && !m.start) ? { tone: "watch" as const, label: "Needs setup" } : { tone: "ok" as const, label: "On track" };
    const points = [m.start, m.target, m.sale].filter((value): value is NonNullable<typeof value> => !!value).sort();
    const a = points[0], b = points.at(-1);
    const px = (date: string) => a && b && a !== b ? Math.max(0, Math.min(100, dayDiff(a, date) / dayDiff(a, b) * 100)) : 50;
    const next = [[m.target, "Target"], [m.sale, "Sale"]].find(([date]) => date && date >= asOf) as [string, string] | undefined;
    return <div key={project.id} className="mk-pj">
      <div className="mk-pj-a"><b>{project.name}</b><span className="mk-cap">{entityName(project.legalEntityId)} · {PROJECT_TYPE_LABEL[project.projectType]}</span><Chip tone={status.tone}>{status.label}</Chip></div>
      <div className="mk-pj-b"><Ring share={ratio} size={44} tone={over ? "critical" : "accent"} label={ratio === undefined ? "—" : pct(ratio)} />
        <div className="mk-pj-bar"><div className="mk-sp"><i style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%` }} /><b style={{ left: "100%" }} /></div>
          <span className="mk-cap"><b>{spent.cents === null ? "No spend recorded" : `${kMoney(spent.cents)} spent`}</b> · {budget === null ? "no budget" : `${kMoney(budget)} budget`}{spent.source === "deal" ? " · from deal costs" : ""}</span></div></div>
      <div className="mk-pj-c">{points.length ? <><div className="mk-strip">{[m.start, m.target, m.sale].map((date, index) => date ? <i key={index} className={date < asOf ? "done" : undefined} style={{ left: `${px(date)}%` }} title={`${["Start", "Target", "Sale"][index]} ${shortDay(date)}`} /> : null)}{a && b && asOf >= a && asOf <= b && <em style={{ left: `${px(asOf)}%` }} />}</div>
        <span className="mk-cap mk-strip-cap"><span>{a ? shortDay(a) : ""}</span><span>{next ? <>{next[1]} <b>{shortDay(next[0])}</b> · {dayDiff(asOf, next[0])}d</> : late ? <span data-tone="neg">{dayDiff(m.target!, asOf)}d past target</span> : ""}</span><span>{b && b !== a ? shortDay(b) : ""}</span></span></>
        : <span className="mk-cap">No start, target or sale dates yet</span>}</div>
      <div className="mk-pj-d"><div><span>Sale</span><b className="mk-n">{sale?.grossProceedsCents ? kMoney(sale.grossProceedsCents) : "—"}</b></div><div><span>Profit</span><b className="mk-n" data-tone={(centsNumber(profit) ?? 0) < 0 ? "neg" : undefined}>{profit ? kMoney(profit) : "—"}</b></div><div><span>Cushion</span><b className="mk-n">{cushion === undefined ? "—" : pct(cushion)}</b></div><div><span>Budget left</span><b className="mk-n">{budget && spent.cents ? kMoney(String(BigInt(budget) - BigInt(spent.cents))) : budget ? kMoney(budget) : "—"}</b></div></div>
      <div className="mk-pj-e"><button type="button" className="mk-btn2" onClick={openProject(data, project, organization?.id)}>Open</button></div>
    </div>;
  })}{open.length > rows.length && <button type="button" className="rops-link mk-more" onClick={openProject(data, undefined, organization?.id)}>{open.length - rows.length} more open projects</button>}
    {(deals.incomplete || flipDeals.incomplete) && <p className="mk-cap">Some deal reports could not be read.</p>}</div>;
}

/* ---------- registry ---------- */

export const OVERVIEW_WIDGETS: readonly WidgetDefinition[] = [
  { id: "cash-card", category: "cash", name: "Cash card", description: "Swipe: available cash, this week, next week, big money moves, debt & investor payments due", sizes: ["M", "MT", "L", "XT"], defaultSize: "MT", render: context => <CashCard {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "rent-summary", category: "rent", name: "Rental summary", description: "Occupied units, collections, delinquency, vacancy cost, moves and listings this month", sizes: ["W", "XT", "XL", "F"], defaultSize: "XT", render: context => <RentalSummary {...context} />, open: data => () => data.onReport("rent-roll") },
  { id: "rent-table", category: "rent", name: "Rentals by property", description: "Occupancy with its 12-month trend, rent roll, collected, past due and status per property", sizes: ["L", "XL", "F", "F6"], defaultSize: "F", render: context => <RentalTable {...context} />, open: data => () => data.onReport("rent-roll") },
  { id: "occ-trend", category: "units", name: "Occupancy trend", description: "Occupied units at each month end over the last year against total units", sizes: ["M", "MT", "L", "XT"], defaultSize: "MT", render: context => <OccupancyTrend {...context} />, open: data => () => data.onReport("occupancy") },
  { id: "qb-tiles", category: "qb", name: "QuickBooks summary", description: "NOI YTD, result after interest, last month's close and sync, with NOI per entity", sizes: ["M", "MT", "L", "XT"], defaultSize: "MT", render: context => <QboSummary {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "overview" }) },
  { id: "milestones", category: "company", name: "Coming up", description: "Next 30 days: rent due, moves, lease ends, project dates and tasks, sales, loan maturities, investor payments, work", sizes: ["MT", "L", "XT", "XL"], defaultSize: "MT", scrolls: true, render: context => <ComingUp {...context} /> },
  { id: "cashflow-grid", category: "cash", name: "Cashflow · weekly plan", description: "The cash forecast week by week: low point, ending cash, money in and out by line", sizes: ["XL", "F", "F6"], defaultSize: "F6", render: context => <CashflowGrid {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "proj-kpis", category: "projects", name: "Project totals", description: "Projected sales and flip profit, rehab spent against budget, and cost to date", sizes: ["M", "MT", "W", "XT"], defaultSize: "W", render: context => <ProjectTotals {...context} />, open: data => openProject(data) },
  { id: "rehab-rings", category: "projects", name: "Rehab progress", description: "Rehab spend against budget per open project with days to target", sizes: ["M", "MT", "W", "L"], defaultSize: "M", render: context => <RehabRings {...context} />, open: data => openProject(data) },
  { id: "gantt", category: "projects", name: "Schedule", description: "Rehab, listing and sale per project with targets, task due dates and today", sizes: ["W", "FT", "F", "F6"], defaultSize: "FT", render: context => <Gantt {...context} />, open: data => openProject(data) },
  { id: "proj-board", category: "projects", name: "Projects board", description: "Status, rehab spend against budget, milestones, sale, profit and cushion per open project", sizes: ["L", "XL", "F", "F6"], defaultSize: "F6", render: context => <ProjectBoard {...context} />, open: data => openProject(data) },
];
