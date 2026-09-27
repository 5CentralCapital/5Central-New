// The default "Command" dashboard from the Sept 24 mockup (dashboard v2): a
// cash card, the rental summary and table, QuickBooks, what's coming up, the
// 15-week cash plan and the projects block. Each widget reads live data and
// says so when a source is missing instead of showing a made-up number.
import React, { useMemo, type ReactNode } from "react";
import type { ProjectDetail, ProjectSummary } from "@shared/projects";
import type { CompanyContextOrganization } from "@shared/company/context";
import type { DashboardCompany } from "@shared/workspaces/contracts";
import { CASH_CATEGORY_LABELS, type ForecastResultView } from "@shared/forecasting/result";
import { financialFigure } from "../../accounting/dashboard-model";
import { dashboardChartSeries, dashboardTrendPoints } from "./dashboard-model";
import {
  Columns, Empty, Failed, Foot, LineChart, Loading, Pager, Ring, Rows, StatStrip, Table, Tile,
  addDays, centsNumber, companyOpener, dayDiff, dollars, fitRows, groupByProperty, humanLabel, monthShort, numeric, pct, propertyLink,
  shortCents, shortDay, sumCents, sumKnown, text, wholeCents,
  type Column, type DashboardData, type Row, type Stat, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import {
  openProjects, useCloseChecklists, useCompanyDashboard, useDashboardOrganization, useDealReports, useExtraRentalRows, useFinancialReports,
  useForecast, useProjectDetails, useProjects, useQboEntities,
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
  const known = remaining.filter((value): value is string => value !== null);
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

export function ForecastGate({ forecast, children }: { forecast: ReturnType<typeof useForecast>; children: (result: ForecastResultView) => ReactNode }) {
  if (forecast.loading) return <Loading label="Loading cash forecast" />;
  if (forecast.list.error) return <Failed title="Forecast unavailable" error={forecast.list.error} retry={() => void forecast.list.refetch()} />;
  if (forecast.none) return <Empty title="No approved base forecast">Approve a base scenario under Forecasting to plan weekly cash.</Empty>;
  if (forecast.run.error) return <Failed title="Forecast could not run" error={forecast.run.error} retry={() => void forecast.run.refetch()} />;
  if (!forecast.result) return <Loading label="Loading cash forecast" />;
  if (!forecastWeeksFrom(forecast.result, forecast.asOfDate).length) return <Empty title="Forecast does not cover this date">Open Forecasting for an approved scenario covering the selected date.</Empty>;
  return <>{children(forecast.result)}</>;
}

/* ---------- cash card ---------- */

function CashCard({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  const company = useCompanyDashboard(data);
  const cash = data.cash.data;
  const weeks = forecastWeeksFrom(forecast.result, data.filters.asOfDate);
  const forecastRelative = forecast.result?.summary.openingCashKnown === false;
  const forecastPartial = forecast.result?.completeness === "partial";
  const week = (index: number, label: string) => {
    const row = weeks[index];
    if (forecast.loading) return <Loading />;
    if (forecast.list.error) return <Failed title="Forecast unavailable" error={forecast.list.error} retry={() => void forecast.list.refetch()} />;
    if (forecast.run.error) return <Failed title="Forecast could not run" error={forecast.run.error} retry={() => void forecast.run.refetch()} />;
    if (forecast.none) return <Empty title="No cash forecast yet">Weekly cash comes from Forecasting.</Empty>;
    if (!row) return <Empty title="Forecast does not cover this date">Open Forecasting for an approved scenario covering the selected date.</Empty>;
    const suffix = forecastPartial ? " · partial forecast" : "";
    return <><Tile label={`${label} · ${shortDay(row.start)}–${shortDay(row.end)}`} big={metrics.h <= 2} value={wholeCents(row.netCents)} tone={(centsNumber(row.netCents) ?? 0) < 0 ? "attention" : "normal"} detail={`Ending ${forecastRelative ? "change" : "cash"} ${wholeCents(row.closingCashCents)}${suffix}`} />
      {metrics.h > 2 && <Rows items={[{ key: "in", label: "Money in", value: wholeCents(row.inflowsCents), tone: "positive" }, { key: "out", label: "Money out", value: wholeCents(`${row.outflowsCents}`.replace(/^-/, "")) }, { key: "end", label: forecastRelative ? "Ending available (relative)" : "Ending available", value: wholeCents(row.availableClosingCents) }]} />}</>;
  };
  const obligations = company.data?.obligations.items ?? [];
  const obligationSummary = company.data ? obligationTotals(obligations, company.data.obligations.truncated) : undefined;
  const maturingSoon = company.data?.maturities.filter(item => item.maturityOn >= data.filters.asOfDate && item.maturityOn <= addDays(data.filters.asOfDate, 30)) ?? [];
  const obligationValue = company.data?.obligations.truncated ? "Unknown" : !obligations.length ? "$0" : obligationSummary?.total === null ? "Unknown" : `${obligationSummary?.complete ? "" : "≥ "}${wholeCents(obligationSummary?.total)}`;
  const pages = [
    { key: "available", label: "Available cash", body: data.cash.error ? <Failed title="Cash balance unavailable" retry={data.cash.refetch} /> : !cash ? <Loading /> : cash.state !== "ready" ? <Empty title={cash.state === "unconfigured" ? "No bank connected" : "Bank balance unavailable"} /> : <>
      <Tile label={`Available · ${text(cash.name)} ··${cash.mask}`} big value={numeric(cash.availableCents) ? dollars(cash.availableCents) : "Unknown"} detail={`${numeric(cash.currentCents) ? dollars(cash.currentCents) : "Unknown"} current${numeric(cash.currentCents) && numeric(cash.availableCents) && cash.currentCents !== cash.availableCents ? ` · ${dollars(cash.currentCents - cash.availableCents)} processing` : ""}`} />
    </> },
    { key: "this-week", label: "This week", body: week(0, "This week") },
    { key: "next-week", label: "Next week", body: week(1, "Next week") },
    { key: "debt", label: "Debt & investors · 30 days", body: company.isLoading ? <Loading /> : company.error ? <Failed title="Company items unavailable" retry={() => void company.refetch()} /> : !company.data ? <Empty title="No company access" /> : <>
      <Tile label="Debt & investors · 30 days" big={metrics.h <= 2} value={obligationValue} detail={`${obligations.length}${company.data.obligations.truncated ? "+" : ""} payment${obligations.length === 1 ? "" : "s"}${maturingSoon.length ? ` · ${maturingSoon.length} maturing` : ""}`} />
      {metrics.h > 2 && <Rows limit={fitRows(metrics, 38, 90, 1)} items={obligations.map(item => ({ key: item.obligationId, label: item.accountName, detail: shortDay(item.dueOn), value: `${item.expectedCents === null || item.amountComplete === false ? "≥ " : ""}${wholeCents(remainingObligationCents(item))}` }))} />}
    </> },
  ];
  return <Pager pages={pages} />;
}

/* ---------- rentals ---------- */

function kpiStats(data: DashboardData): Stat[] {
  return data.kpis.map(kpi => ({ key: kpi.key, label: kpi.label, value: kpi.tone === "loading" ? "…" : kpi.value, detail: kpi.detail, tone: kpi.tone }));
}

function RentalSummary({ data, metrics }: WidgetContext) {
  const series = data.trends.data ? dashboardChartSeries(data.trends.data, "portfolio", "occupancy", "units")[0] : undefined;
  const months = data.trends.data ? dashboardTrendPoints(data.trends.data) : [];
  const chartHeight = metrics.bodyHeight - 96;
  return <div className="ops-overview-rentals">
    <StatStrip items={kpiStats(data)} metrics={metrics} min={150} />
    {chartHeight >= 70 && series && <div className="ops-chart-slot"><span className="ops-tile-label">Occupied units by month</span><LineChart width={metrics.bodyWidth} height={chartHeight - 18} format={value => `${value}`} points={months.map((month, index) => ({ label: monthShort(month.month), value: series.values[index] ?? null }))} /></div>}
  </div>;
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

function RentalTable({ data, metrics }: WidgetContext) {
  const rows = propertyLines(data);
  const wide = metrics.w >= 12, mid = metrics.w >= 8;
  const shareCell = (value: unknown, low: number) => numeric(value) ? <span data-tone={value < low ? "critical" : undefined}>{pct(value)}</span> : "—";
  const columns: Column[] = [
    { key: "propertyName", label: "Property", render: row => <span className="rops-cell-stack">{propertyLink(data, row)}<small>{text(row.unitCount)} units{row.preleased ? ` · ${row.preleased} preleased` : ""}</small></span> },
    { key: "occupied", label: "Occupied", number: true, render: row => `${text(row.occupied)} / ${text(row.unitCount)}` },
    { key: "occupancyShare", label: "Occupancy", number: true, render: row => shareCell(row.occupancyShare, 0.8) },
    ...(mid ? [{ key: "rentCents", label: "Rent roll", number: true, render: (row: Row) => numeric(row.rentCents) ? dollars(row.rentCents) : "—" }] : []),
    { key: "collectedCents", label: "Collected", number: true, render: row => numeric(row.collectedCents) ? dollars(row.collectedCents) : "—" },
    ...(mid ? [{ key: "collectedShare", label: "Collected %", number: true, render: (row: Row) => shareCell(row.collectedShare, 0.5) }] : []),
    { key: "dueCents", label: "Past due", number: true, render: row => numeric(row.dueCents) ? <span data-tone={row.dueCents > 0 ? "critical" : undefined}>{dollars(row.dueCents)}{row.dueCount ? <small> · {String(row.dueCount)}</small> : null}</span> : "—" },
    ...(wide ? [{ key: "vacancyCents", label: "Vacancy cost / mo", number: true, render: (row: Row) => numeric(row.vacancyCents) ? dollars(row.vacancyCents) : "—" }] : []),
  ];
  const totals = rows ? { occupied: sumKnown(rows, "occupied"), units: sumKnown(rows, "unitCount"), rent: sumKnown(rows, "rentCents"), collected: sumKnown(rows, "collectedCents"), due: sumKnown(rows, "dueCents") } : undefined;
  return <Table rows={rows} columns={columns} limit={fitRows(metrics, 46, 40)} empty="No properties in scope." onMore={() => data.onReport("rent-roll")}
    footer={totals ? <><span>{totals.occupied ?? "—"} of {totals.units ?? "—"} units occupied · rent roll {totals.rent === undefined ? "—" : dollars(totals.rent)} · collected {totals.collected === undefined ? "—" : dollars(totals.collected)}</span><strong>{totals.due === undefined ? "—" : `${dollars(totals.due)} past due`}</strong></> : undefined} />;
}

function OccupancyTrend({ data, metrics }: WidgetContext) {
  if (data.trends.error) return <Failed title="Trend unavailable" error={data.trends.error} retry={data.trends.retry} />;
  if (!data.trends.data) return <Loading />;
  const series = dashboardChartSeries(data.trends.data, "portfolio", "occupancy", "units")[0];
  const months = dashboardTrendPoints(data.trends.data);
  const points = months.map((month, index) => ({ label: monthShort(month.month), value: series?.values[index] ?? null }));
  const last = [...points].reverse().find(point => numeric(point.value));
  const first = points.find(point => numeric(point.value));
  const change = last && first && numeric(last.value) && numeric(first.value) ? last.value - first.value : undefined;
  return <><Tile label="Occupied now" value={last && numeric(last.value) ? `${last.value} units` : "—"} detail={change === undefined ? undefined : `${change >= 0 ? "+" : "−"}${Math.abs(change)} over ${points.length} months`} />
    {metrics.bodyHeight > 120 && <LineChart width={metrics.bodyWidth} height={metrics.bodyHeight - 80} format={value => `${value}`} points={points} />}</>;
}

/* ---------- QuickBooks summary ---------- */

function QboSummary({ data, metrics }: WidgetContext) {
  const { gate } = useCompanyGate(data);
  const reports = useFinancialReports(data, "income-statement");
  const close = useCloseChecklists(data);
  const { entities, health } = useQboEntities(data);
  if (gate) return gate;
  if (health.error) return <Failed title="QuickBooks status unavailable" error={health.error} retry={() => void health.refetch()} />;
  if (!entities) return <Loading label="Loading QuickBooks" />;
  if (!entities.length) return <Empty title="QuickBooks not connected">Connect an entity under Accounting › Connections.</Empty>;
  const availableEntities = entities.filter(entity => entity.available !== false);
  const currencies = new Set(availableEntities.map(entity => entity.currency));
  const incompatibleCurrencies = currencies.size > 1;
  const total = (group: string) => {
    if (incompatibleCurrencies) return { cents: null, complete: false, known: false };
    const values = reports.rows.map(row => financialFigure(row.report, group));
    const complete = values.length > 0 && values.every(value => value !== null);
    return { cents: complete ? sumCents(values as string[]) : null, complete, known: complete };
  };
  const figure = (group: string) => {
    if (reports.rows.some(row => row.loading)) return "…";
    if (incompatibleCurrencies) return "Multiple currencies";
    const { cents, known } = total(group);
    return !known ? "Unknown" : wholeCents(cents);
  };
  const incomplete = reports.rows.some(row => !row.loading && ["Income", "NetOperatingIncome", "NetIncome"].some(group => financialFigure(row.report, group) === null));
  const closeRows = close.rows.filter(row => row.entity.available !== false);
  const closeDone = closeRows.filter(row => row.checklist && row.checklist.completeCount === row.checklist.items.length).length;
  const closeIncomplete = closeRows.some(row => !row.checklist || row.error);
  const stale = entities.filter(entity => entity.health.freshness !== "current").length;
  const unavailable = entities.filter(entity => entity.available === false).length;
  const syncValue = unavailable ? `${unavailable} unavailable` : stale ? `${stale} stale` : "Current";
  const items: Stat[] = [
    { key: "income", label: "Income YTD", value: figure("Income") },
    { key: "noi", label: "Operating income YTD", value: figure("NetOperatingIncome") },
    { key: "net", label: "Net income YTD", value: figure("NetIncome"), tone: (centsNumber(total("NetIncome").cents) ?? 0) < 0 ? "attention" : undefined },
    { key: "close", label: `${monthShort(close.month)} close`, value: close.loading ? "…" : availableEntities.length === 0 ? "Unavailable" : `${closeDone} of ${availableEntities.length}${closeIncomplete ? "*" : ""}`, detail: "entities closed" },
    { key: "sync", label: "Sync", value: syncValue, tone: unavailable || stale ? "attention" : undefined, detail: `${entities.length} ${entities.length === 1 ? "company" : "companies"}` },
  ];
  return <><StatStrip items={items} metrics={metrics} min={118} />{incompatibleCurrencies ? <Foot>Totals are shown as unavailable because connected entities use different currencies.</Foot> : (incomplete || closeIncomplete) && <Foot>* Some QuickBooks entities could not return a complete read; totals cover the available entities.</Foot>}</>;
}

/* ---------- coming up ---------- */

type Upcoming = { key: string; date: string; title: string; detail: string; tone?: "critical" | "warning" | "neutral"; kind: string; onOpen?: () => void };

function ComingUp({ data, metrics }: WidgetContext) {
  const asOf = data.filters.asOfDate, until = addDays(asOf, 30);
  const { organization } = useDashboardOrganization(data);
  const company = useCompanyDashboard(data);
  const projects = useProjects(data);
  const details = useProjectDetails(data, projects.data);
  const leases = useExtraRentalRows(data, "lease-expiration", ["propertyName", "unitNumber", "tenantName", "contractEndOn", "noticeDeadlineOn", "monthToMonth", "actionStatus", "personId", "unitId"]);
  const items = useMemo(() => {
    const list: Upcoming[] = [];
    const within = (date: string | null | undefined) => !!date && date >= asOf && date <= until;
    for (const row of data.movements ?? []) if (within(String(row.date ?? ""))) list.push({ key: `move-${row.tenantName}-${row.date}`, date: String(row.date), kind: "Move", title: `${text(row.movement)} · ${text(row.propertyName)} ${text(row.unitNumber)}`, detail: text(row.tenantName) });
    for (const row of leases.rows ?? []) {
      if (within(String(row.contractEndOn ?? ""))) list.push({ key: `lease-${row.unitId}-${row.contractEndOn}`, date: String(row.contractEndOn), kind: "Lease", title: `Lease ends · ${text(row.propertyName)} ${text(row.unitNumber)}`, detail: text(row.tenantName), tone: "warning" });
      else if (within(String(row.noticeDeadlineOn ?? ""))) list.push({ key: `notice-${row.unitId}-${row.noticeDeadlineOn}`, date: String(row.noticeDeadlineOn), kind: "Notice", title: `Renewal notice due · ${text(row.propertyName)} ${text(row.unitNumber)}`, detail: text(row.tenantName) });
    }
    for (const project of projects.data ?? []) {
      if (project.status === "completed") continue;
      if (within(project.targetOn)) list.push({ key: `target-${project.id}`, date: project.targetOn!, kind: "Project", title: `${project.name} · target`, detail: propertyNameFor(data, organization, project.propertyId), tone: "warning", onOpen: openProject(data, project, organization?.id) });
      if (within(project.startOn)) list.push({ key: `start-${project.id}`, date: project.startOn!, kind: "Project", title: `${project.name} · starts`, detail: propertyNameFor(data, organization, project.propertyId), onOpen: openProject(data, project, organization?.id) });
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
  }, [asOf, until, data, leases.rows, projects.data, details.details, company.data, organization]);
  const loading = !data.movements || leases.loading || projects.isLoading || company.isLoading || (!!projects.data && details.loading);
  const incomplete = !!leases.error || !!projects.error || !!company.error || details.incomplete || !!company.data?.obligations.truncated;
  if (!items.length) return loading ? <Loading /> : incomplete ? <Empty title="Upcoming data incomplete">Some project, company or lease records could not be read.</Empty> : <Empty title="Nothing in the next 30 days">Moves, lease ends, project dates, tasks, loan maturities and investor payments show here.</Empty>;
  return <ul className="ops-agenda">{items.map(item => {
    const days = dayDiff(asOf, item.date);
    return <li key={item.key} data-tone={item.tone}>
      <span className="ops-agenda-date"><strong>{shortDay(item.date)}</strong><small>{days < 0 ? `${-days}d late` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : `in ${days}d`}</small></span>
      <span className="ops-agenda-text">{item.onOpen ? <button type="button" className="rops-link" onClick={item.onOpen}>{item.title}</button> : <strong>{item.title}</strong>}<small>{item.kind} · {item.detail}</small></span>
    </li>;
  })}{incomplete && <li className="ops-agenda-more">Some items unavailable</li>}{metrics.h <= 2 && <li className="ops-agenda-more">{items.length} items</li>}</ul>;
}

/* ---------- 15-week cash grid ---------- */

function CashflowGrid({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    if (!weeks.length) return <Empty title="Forecast does not cover this date">Open Forecasting for an approved scenario covering the selected date.</Empty>;
    const count = Math.max(2, Math.min(weeks.length, Math.floor((metrics.bodyWidth - 170) / 74)));
    const shown = weeks.slice(0, count);
    const categories = Array.from(new Set(shown.flatMap(week => Object.keys(week.categories)))).filter(key => shown.some(week => (centsNumber(week.categories[key]) ?? 0) !== 0));
    const magnitude = (key: string) => shown.reduce((sum, week) => sum + Math.abs(centsNumber(week.categories[key]) ?? 0), 0);
    const room = Math.max(0, Math.floor((metrics.bodyHeight - 40) / 25) - 6);
    const kept = categories.sort((a, b) => magnitude(b) - magnitude(a)).slice(0, room);
    const ordered = kept.sort((a, b) => (shown.reduce((s, w) => s + (centsNumber(w.categories[b]) ?? 0), 0)) - (shown.reduce((s, w) => s + (centsNumber(w.categories[a]) ?? 0), 0)));
    const cell = (value: string | undefined, strong = false, key?: string) => { const cents = centsNumber(value); return <td key={key} className={`number${strong ? " is-strong" : ""}`} data-tone={cents !== undefined && cents < 0 ? "critical" : undefined}>{cents === undefined ? "—" : cents === 0 ? "·" : shortCents(cents)}</td>; };
    const relative = result.summary.openingCashKnown === false;
    return <><div className="ops-cashgrid"><table>
      <thead><tr><th>{result.scenario.name}</th>{shown.map(week => <th key={week.key} className="number">{shortDay(week.start)}</th>)}</tr></thead>
      <tbody>
        <tr className="is-sub"><th>{relative ? "Opening (relative)" : "Opening cash"}</th>{shown.map(week => cell(week.openingCashCents, false, week.key))}</tr>
        {ordered.map(key => <tr key={key}><th>{CASH_CATEGORY_LABELS[key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(key)}</th>{shown.map(week => cell(week.categories[key], false, week.key))}</tr>)}
        {categories.length > ordered.length && <tr className="is-sub"><th>{categories.length - ordered.length} more lines</th>{shown.map(week => <td key={week.key} />)}</tr>}
        <tr className="is-total"><th>Net</th>{shown.map(week => cell(week.netCents, true, week.key))}</tr>
        <tr className="is-total"><th>{relative ? "Ending (relative)" : "Ending cash"}</th>{shown.map(week => <React.Fragment key={week.key}>{cell(week.closingCashCents, true)}</React.Fragment>)}</tr>
        <tr className="is-sub"><th>{relative ? "Available (relative)" : "Available"}</th>{shown.map(week => <React.Fragment key={week.key}>{cell(week.availableClosingCents)}</React.Fragment>)}</tr>
      </tbody></table></div>
      <Foot action="Open forecast" onAction={companyOpener(data, "forecasting", { forecastTab: "cash" })}>{result.completeness === "partial" ? "Partial forecast: some inputs are missing" : `Actuals through ${shortDay(result.actualsCutoff)}`}{result.summary.weeksBelowFloor ? ` · ${result.summary.weeksBelowFloor} weeks below reserve` : ""}</Foot></>;
  }}</ForecastGate>;
}

/* ---------- projects block ---------- */

function useProjectsGate(data: DashboardData) {
  const { organization, gate } = useCompanyGate(data);
  const projects = useProjects(data);
  const blocked = gate ?? (projects.error ? <Failed title="Projects unavailable" error={projects.error} retry={() => void projects.refetch()} /> : !projects.data ? <Loading label="Loading projects" /> : null);
  return { organization, projects: projects.data, gate: blocked };
}

function ProjectTotals({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectsGate(data);
  const deals = useDealReports(data, projects);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  if (!open.length) return <Empty title="No open projects">Projects you add appear here with budgets and spend.</Empty>;
  const currencies = new Set(open.map(project => project.currency));
  const budgetValues = open.map(project => project.approvedBudgetCents);
  const budget = currencies.size <= 1 && budgetValues.every(value => value !== null) ? sumCents(budgetValues) : null;
  const spentValues = open.map(project => project.postedActualCents);
  const spentKnown = currencies.size <= 1 && spentValues.every(value => value !== null) && open.every(project => project.postedActualCoverage !== "unavailable");
  const spent = spentKnown ? sumCents(spentValues) : null;
  const spentPartial = spentKnown && open.some(project => project.postedActualCoverage === "partial");
  const draft = currencies.size <= 1 ? sumCents(open.map(project => project.draftCostCents)) : null;
  const profits = deals.reports.filter(entry => entry.project.status !== "completed").map(entry => entry.report?.coverage.status === "complete" && entry.report.saleForecast.profitState === "complete" ? entry.report.saleForecast.projectedProfitCents : null);
  const flipCurrencies = new Set(deals.flips.map(project => project.currency));
  const profit = flipCurrencies.size <= 1 && !deals.incomplete && profits.every(value => value !== null) ? sumCents(profits) : null;
  const items: Stat[] = [
    { key: "open", label: "Open projects", value: String(open.length), detail: `${open.filter(project => project.status === "active").length} active · ${open.filter(project => project.status === "planning").length} planning` },
    { key: "budget", label: "Approved budgets", value: currencies.size > 1 ? "Multiple currencies" : budget === null ? "Unknown" : wholeCents(budget), detail: currencies.size > 1 ? "Totals separated by currency" : budget === null ? `${open.filter(project => project.approvedBudgetCents === null).length} without a budget` : undefined },
    { key: "spent", label: "Posted spend", value: currencies.size > 1 ? "Multiple currencies" : !spentValues.some(value => value !== null) ? "Not linked" : spent === null ? "Unknown" : `${spentPartial ? "≥ " : ""}${wholeCents(spent)}`, detail: currencies.size > 1 ? "Totals separated by currency" : budget !== null && spent !== null && !spentPartial && centsNumber(budget) ? `${pct((centsNumber(spent) ?? 0) / (centsNumber(budget) ?? 1))} of budget` : "QuickBooks actuals" },
    { key: "draft", label: "Unposted costs", value: currencies.size > 1 ? "Multiple currencies" : wholeCents(draft), detail: "Draft costs not in QuickBooks yet" },
    { key: "profit", label: "Projected flip profit", value: deals.loading ? "…" : !deals.flips.length ? "—" : flipCurrencies.size > 1 ? "Multiple currencies" : profit === null ? "Unknown" : wholeCents(profit), detail: deals.flips.length ? `${deals.flips.length} flip${deals.flips.length === 1 ? "" : "s"}${flipCurrencies.size > 1 ? " · totals separated by currency" : profit === null ? " · some not forecast" : ""}` : "No flips" },
  ];
  return <StatStrip items={items} metrics={metrics} min={130} />;
}

function RehabRings({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectsGate(data);
  if (gate) return gate;
  const open = (openProjects(projects) ?? []).filter(project => project.projectType !== "administrative");
  if (!open.length) return <Empty title="No open projects" />;
  const size = Math.max(44, Math.min(84, metrics.bodyHeight - 58));
  const fit = Math.max(1, Math.floor((metrics.bodyWidth + 10) / (size + 34)));
  return <ul className="ops-rings">{open.slice(0, fit).map(project => {
    const share = spentShare(project);
    return <li key={project.id}><button type="button" className="ops-ring-button" onClick={openProject(data, project, project.organizationId)} title={`Posted ${postedSpendLabel(project)} of ${wholeCents(project.approvedBudgetCents)} budget`}>
      <Ring share={share} size={size} tone={share !== undefined && share > 1 ? "critical" : "accent"} />
      <strong>{project.name}</strong><small>{share === undefined ? project.approvedBudgetCents === null ? "No budget" : postedSpendLabel(project) : `${postedSpendLabel(project)} of ${shortCents(project.approvedBudgetCents)}`}</small>
    </button></li>;
  })}{open.length > fit && <li className="ops-rings-more"><small>+{open.length - fit} more</small><small>{propertyNameFor(data, organization, open[fit]!.propertyId)}</small></li>}</ul>;
}

function Gantt({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectsGate(data);
  const details = useProjectDetails(data, projects);
  if (gate) return gate;
  const asOf = data.filters.asOfDate;
  const dated = (projects ?? []).filter(project => project.status !== "completed" && (project.startOn || project.targetOn));
  if (!dated.length) return <Empty title="No project dates">Add start and target dates to projects to see the schedule.</Empty>;
  const starts = dated.map(project => project.startOn ?? project.targetOn!), ends = dated.map(project => project.targetOn ?? project.startOn!);
  const from = [addDays(asOf, -30), ...starts].sort()[0]!, to = [addDays(asOf, 60), ...ends].sort().at(-1)!;
  const span = Math.max(1, dayDiff(from, to));
  const x = (date: string) => `${Math.max(0, Math.min(100, dayDiff(from, date) / span * 100))}%`;
  const rows = dated.sort((a, b) => (a.targetOn ?? a.startOn ?? "").localeCompare(b.targetOn ?? b.startOn ?? "")).slice(0, Math.max(1, Math.floor((metrics.bodyHeight - 34) / 30)));
  const months: string[] = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7) && months.length < 24; month = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7)) months.push(month);
  const tasksFor = (project: ProjectSummary): ProjectDetail["tasks"] => details.details.find(detail => detail.id === project.id)?.tasks.filter(task => task.dueOn && !task.archivedAt && task.status !== "cancelled") ?? [];
  const body = <div className="ops-gantt">
    <div className="ops-gantt-scale"><span />{<div>{months.map(month => <i key={month} style={{ left: x(`${month}-01`) }}>{monthShort(month)}</i>)}<b style={{ left: x(asOf) }} title="As of date" /></div>}</div>
    {rows.map(project => {
      const start = project.startOn ?? project.targetOn!, end = project.targetOn ?? project.startOn!;
      const late = project.targetOn !== null && project.targetOn < asOf;
      return <div key={project.id} className="ops-gantt-row">
        <button type="button" className="ops-gantt-name" onClick={openProject(data, project, project.organizationId)} title={propertyNameFor(data, organization, project.propertyId)}>{project.name}<small>{PROJECT_STATUS_LABEL[project.status]}</small></button>
        <div className="ops-gantt-track"><b style={{ left: x(asOf) }} aria-hidden="true" />
          <i className="ops-gantt-bar" data-tone={late ? "critical" : project.status === "on_hold" ? "muted" : undefined} style={{ left: x(start), width: `max(6px, calc(${x(end)} - ${x(start)}))` }} title={`${shortDay(start)} → ${shortDay(end)}`} />
          {tasksFor(project).map(task => <em key={task.id} className="ops-gantt-task" data-tone={task.status === "completed" ? "positive" : task.dueOn! < asOf ? "critical" : undefined} style={{ left: x(task.dueOn!) }} title={`${task.title} · ${shortDay(task.dueOn)}`} />)}
        </div>
      </div>;
    })}
  </div>;
  return details.incomplete ? <>{body}<Foot>Some project task records could not be read.</Foot></> : body;
}

function ProjectBoard({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectsGate(data);
  const deals = useDealReports(data, projects);
  if (gate) return gate;
  const profit = new Map(deals.reports.map(entry => [entry.project.id, entry.report && entry.report.coverage.status === "complete" && entry.report.saleForecast.profitState === "complete" ? entry.report.saleForecast : undefined] as const));
  const rows: Row[] = (projects ?? []).filter(project => project.status !== "completed").map(project => ({
    id: project.id, project, name: project.name, propertyName: propertyNameFor(data, organization, project.propertyId), type: PROJECT_TYPE_LABEL[project.projectType], currency: project.currency, status: PROJECT_STATUS_LABEL[project.status],
    targetOn: project.targetOn, budget: project.approvedBudgetCents, spent: project.postedActualCents, coverage: project.postedActualCoverage, draft: project.draftCostCents,
    share: spentShare(project) ?? null, profit: profit.get(project.id)?.profitState === "complete" ? profit.get(project.id)?.projectedProfitCents ?? null : null, saleOn: profit.get(project.id)?.saleOn ?? null,
  }));
  const wide = metrics.w >= 12;
  const columns: Column[] = [
    { key: "name", label: "Project", render: row => <span className="rops-cell-stack"><button type="button" className="rops-link" onClick={openProject(data, row.project as ProjectSummary, (row.project as ProjectSummary).organizationId)}>{text(row.name)}</button><small>{text(row.propertyName)} · {text(row.type)} · {text(row.currency)}</small></span> },
    { key: "status", label: "Status" },
    { key: "targetOn", label: "Target", render: row => { const date = row.targetOn as string | null; return date ? <span data-tone={date < data.filters.asOfDate ? "critical" : undefined}>{shortDay(date)}</span> : "—"; } },
    { key: "budget", label: "Budget", number: true, render: row => wholeCents(row.budget as string | null) },
    { key: "spent", label: "Spent", number: true, render: row => postedSpendLabel({ postedActualCents: row.spent as string | null, postedActualCoverage: row.coverage as ProjectSummary["postedActualCoverage"] }) },
    { key: "share", label: "Used", number: true, render: row => numeric(row.share) ? <span data-tone={row.share > 1 ? "critical" : undefined}>{pct(row.share)}</span> : "—" },
    ...(wide ? [{ key: "draft", label: "Unposted", number: true, render: (row: Row) => wholeCents(row.draft as string | null) }, { key: "saleOn", label: "Sale", render: (row: Row) => row.saleOn ? shortDay(String(row.saleOn)) : "—" }] : []),
    { key: "profit", label: "Profit", number: true, render: row => typeof row.profit === "string" ? <span data-tone={(centsNumber(row.profit) ?? 0) < 0 ? "critical" : "positive"}>{wholeCents(row.profit)}</span> : row.type === "Flip" ? "Not forecast" : "—" },
  ];
  const body = <Table rows={rows} columns={columns} limit={fitRows(metrics, 46, 40)} empty="No open projects." onMore={openProject(data, undefined, organization?.id)} footer={<><span>{rows.length} open · {rows.filter(row => row.status === "Active").length} active</span>{openProject(data, undefined, organization?.id) && <button type="button" className="rops-link" onClick={openProject(data, undefined, organization?.id)}>All projects</button>}</>} />;
  return deals.loading ? <Loading label="Loading deal reports" /> : deals.incomplete ? <>{body}<Foot>Some flip reports could not be read.</Foot></> : body;
}

/* ---------- registry ---------- */

export const OVERVIEW_WIDGETS: readonly WidgetDefinition[] = [
  { id: "cash-card", category: "cash", name: "Cash card", description: "Page through available cash, this week, next week and debt & investor payments due", sizes: ["M", "MT", "L", "XT"], defaultSize: "MT", render: context => <CashCard {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "rent-summary", category: "rent", name: "Rental summary", description: "Occupancy, rent roll, collections and past due with the occupancy trend", sizes: ["W", "XT", "XL", "F"], defaultSize: "XT", render: context => <RentalSummary {...context} />, open: data => () => data.onReport("rent-roll") },
  { id: "rent-table", category: "rent", name: "Rentals by property", description: "Occupancy, rent roll, collected, past due and vacancy cost per property", sizes: ["L", "XL", "F", "F6"], defaultSize: "F", render: context => <RentalTable {...context} />, open: data => () => data.onReport("rent-roll") },
  { id: "occ-trend", category: "units", name: "Occupancy trend", description: "Occupied units at each month end over the last year", sizes: ["M", "MT", "L", "XT"], defaultSize: "MT", render: context => <OccupancyTrend {...context} />, open: data => () => data.onReport("occupancy") },
  { id: "qb-tiles", category: "qb", name: "QuickBooks summary", description: "Income, operating income and net income YTD across entities, last month's close and sync", sizes: ["M", "MT", "L", "XT"], defaultSize: "MT", render: context => <QboSummary {...context} />, open: data => companyOpener(data, "accounting", { accountingView: "overview" }) },
  { id: "milestones", category: "company", name: "Coming up", description: "Next 30 days: moves, lease ends, project dates and tasks, loan maturities, investor payments, work", sizes: ["MT", "L", "XT", "XL"], defaultSize: "MT", scrolls: true, render: context => <ComingUp {...context} /> },
  { id: "cashflow-grid", category: "cash", name: "Cashflow · weekly plan", description: "The cash forecast week by week: opening, each cash line, net and ending cash", sizes: ["XL", "F", "F6"], defaultSize: "F6", render: context => <CashflowGrid {...context} />, open: data => companyOpener(data, "forecasting", { forecastTab: "cash" }) },
  { id: "proj-kpis", category: "projects", name: "Project totals", description: "Open projects, approved budgets, posted spend, unposted costs and projected flip profit", sizes: ["M", "MT", "W", "XT"], defaultSize: "W", render: context => <ProjectTotals {...context} />, open: data => openProject(data) },
  { id: "rehab-rings", category: "projects", name: "Rehab progress", description: "Posted spend against the approved budget for each open project", sizes: ["M", "MT", "W", "L"], defaultSize: "M", render: context => <RehabRings {...context} />, open: data => openProject(data) },
  { id: "gantt", category: "projects", name: "Schedule", description: "Each open project from start to target with task due dates and today", sizes: ["W", "FT", "F", "F6"], defaultSize: "FT", render: context => <Gantt {...context} />, open: data => openProject(data) },
  { id: "proj-board", category: "projects", name: "Projects board", description: "Status, target, budget, spend and projected profit for every open project", sizes: ["L", "XL", "F", "F6"], defaultSize: "F6", render: context => <ProjectBoard {...context} />, open: data => openProject(data) },
];
