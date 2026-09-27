// The default "Command" dashboard from the Sept 24 mockup (dashboard v2): a
// cash card, the rental summary and table, QuickBooks, what's coming up, the
// 15-week cash plan and the projects block. Each widget reads live data and
// says so when a source is missing instead of showing a made-up number.
import React, { useMemo, type ReactNode } from "react";
import type { ProjectDetail, ProjectSummary } from "@shared/projects";
import type { CompanyContextOrganization } from "@shared/company/context";
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

/** Posted QuickBooks spend against the approved budget; undefined when either is unknown. */
export function spentShare(project: ProjectSummary): number | undefined {
  const budget = centsNumber(project.approvedBudgetCents), spent = centsNumber(project.postedActualCents);
  return budget && budget > 0 && spent !== undefined ? spent / budget : undefined;
}

export const openProject = (data: DashboardData, project?: { id: string }) => data.onOpenCompany ? () => data.onOpenCompany!("projects", data.organizationId, project ? { projectTab: "overview", recordId: project.id } : { projectTab: "overview" }) : undefined;

/** The forecast week that contains the as-of date, then the ones after it. */
export function forecastWeeksFrom(result: ForecastResultView | undefined, asOfDate: string) {
  if (!result) return [];
  const index = result.weeks.findIndex(week => asOfDate <= week.end);
  // A plan that ended before the as-of date still shows its last weeks, never an empty grid.
  return index < 0 ? result.weeks.slice(-13) : result.weeks.slice(index);
}

export function ForecastGate({ forecast, children }: { forecast: ReturnType<typeof useForecast>; children: (result: ForecastResultView) => ReactNode }) {
  if (forecast.loading) return <Loading label="Loading cash forecast" />;
  if (forecast.list.error) return <Failed title="Forecast unavailable" error={forecast.list.error} retry={() => void forecast.list.refetch()} />;
  if (forecast.none) return <Empty title="No cash forecast yet">Create a scenario under Forecasting to plan weekly cash.</Empty>;
  if (forecast.run.error) return <Failed title="Forecast could not run" error={forecast.run.error} retry={() => void forecast.run.refetch()} />;
  if (!forecast.result) return <Loading label="Loading cash forecast" />;
  return <>{children(forecast.result)}</>;
}

/* ---------- cash card ---------- */

function CashCard({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  const company = useCompanyDashboard(data);
  const cash = data.cash.data;
  const weeks = forecastWeeksFrom(forecast.result, data.filters.asOfDate);
  const week = (index: number, label: string) => {
    const row = weeks[index];
    if (forecast.none) return <Empty title="No cash forecast yet">Weekly cash comes from Forecasting.</Empty>;
    if (!row) return forecast.loading ? <Loading /> : <Empty title="Forecast unavailable" />;
    return <><Tile label={`${label} · ${shortDay(row.start)}–${shortDay(row.end)}`} big={metrics.h <= 2} value={wholeCents(row.netCents)} tone={(centsNumber(row.netCents) ?? 0) < 0 ? "attention" : "normal"} detail={`Ending ${forecast.result?.summary.openingCashKnown === false ? "change" : "cash"} ${wholeCents(row.closingCashCents)}`} />
      {metrics.h > 2 && <Rows items={[{ key: "in", label: "Money in", value: wholeCents(row.inflowsCents), tone: "positive" }, { key: "out", label: "Money out", value: wholeCents(`${row.outflowsCents}`.replace(/^-/, "")) }, { key: "end", label: "Ending available", value: wholeCents(row.availableClosingCents) }]} />}</>;
  };
  const obligations = company.data?.obligations.items ?? [];
  const pages = [
    { key: "available", label: "Available cash", body: data.cash.error ? <Failed title="Cash balance unavailable" retry={data.cash.refetch} /> : !cash ? <Loading /> : cash.state !== "ready" ? <Empty title={cash.state === "unconfigured" ? "No bank connected" : "Bank balance unavailable"} /> : <>
      <Tile label={`Available · ${text(cash.name)} ··${cash.mask}`} big value={numeric(cash.availableCents) ? dollars(cash.availableCents) : "Unknown"} detail={`${numeric(cash.currentCents) ? dollars(cash.currentCents) : "Unknown"} current${numeric(cash.currentCents) && numeric(cash.availableCents) && cash.currentCents !== cash.availableCents ? ` · ${dollars(cash.currentCents - cash.availableCents)} processing` : ""}`} />
    </> },
    { key: "this-week", label: "This week", body: week(0, "This week") },
    { key: "next-week", label: "Next week", body: week(1, "Next week") },
    { key: "debt", label: "Debt & investors · 30 days", body: company.isLoading ? <Loading /> : company.error ? <Failed title="Company items unavailable" retry={() => void company.refetch()} /> : !company.data ? <Empty title="No company access" /> : <>
      <Tile label="Debt & investors · 30 days" big={metrics.h <= 2} value={obligations.length ? sumCents(obligations.map(item => item.expectedCents)) === null ? `≥ ${wholeCents(sumCents(obligations.map(item => item.knownMinimumCents)))}` : wholeCents(sumCents(obligations.map(item => item.expectedCents))) : "$0"} detail={`${obligations.length} payment${obligations.length === 1 ? "" : "s"}${company.data.maturities.length ? ` · ${company.data.maturities.length} maturing` : ""}`} />
      {metrics.h > 2 && <Rows limit={fitRows(metrics, 38, 90, 1)} items={obligations.map(item => ({ key: item.obligationId, label: item.accountName, detail: shortDay(item.dueOn), value: item.expectedCents === null ? `≥ ${wholeCents(item.knownMinimumCents)}` : wholeCents(item.expectedCents) }))} />}
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
  const due = new Map(groupByProperty(data.knownDue ?? [], () => ({ cents: 0, count: 0 }), (group, row) => { group.cents += Number(row.operationalBalanceCents) || 0; group.count += 1; }).map(group => [group.propertyId, group] as const));
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
      dueCents: data.knownDue ? due.get(id)?.cents ?? 0 : null,
      dueCount: due.get(id)?.count ?? 0,
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
  const total = (group: string) => {
    const values = reports.rows.map(row => financialFigure(row.report, group));
    return { cents: sumCents(values.filter((value): value is string => value !== null)), complete: values.every(value => value !== null) };
  };
  const figure = (group: string) => {
    if (reports.rows.some(row => row.loading)) return "…";
    const { cents, complete } = total(group);
    return `${wholeCents(cents)}${complete ? "" : "*"}`;
  };
  const incomplete = reports.rows.filter(row => !row.loading && financialFigure(row.report, "NetIncome") === null).length;
  const closeDone = close.rows.filter(row => row.checklist && row.checklist.completeCount === row.checklist.items.length).length;
  const stale = entities.filter(entity => entity.health.freshness !== "current").length;
  const items: Stat[] = [
    { key: "income", label: "Income YTD", value: figure("Income") },
    { key: "noi", label: "Operating income YTD", value: figure("NetOperatingIncome") },
    { key: "net", label: "Net income YTD", value: figure("NetIncome"), tone: (centsNumber(total("NetIncome").cents) ?? 0) < 0 ? "attention" : undefined },
    { key: "close", label: `${monthShort(close.month)} close`, value: close.loading ? "…" : `${closeDone} of ${entities.length}`, detail: "entities closed" },
    { key: "sync", label: "Sync", value: stale ? `${stale} stale` : "Current", tone: stale ? "attention" : undefined, detail: `${entities.length} ${entities.length === 1 ? "company" : "companies"}` },
  ];
  return <><StatStrip items={items} metrics={metrics} min={118} />{incomplete > 0 && <Foot>* {incomplete} of {entities.length} entities could not return a complete report; the total covers the rest.</Foot>}</>;
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
      if (within(project.targetOn)) list.push({ key: `target-${project.id}`, date: project.targetOn!, kind: "Project", title: `${project.name} · target`, detail: propertyNameFor(data, organization, project.propertyId), tone: "warning", onOpen: openProject(data, project) });
      if (within(project.startOn)) list.push({ key: `start-${project.id}`, date: project.startOn!, kind: "Project", title: `${project.name} · starts`, detail: propertyNameFor(data, organization, project.propertyId), onOpen: openProject(data, project) });
    }
    for (const project of details.details) for (const task of project.tasks) {
      if (task.archivedAt || task.status === "completed" || task.status === "cancelled") continue;
      const overdue = !!task.dueOn && task.dueOn < asOf;
      if (overdue || within(task.dueOn)) list.push({ key: `task-${task.id}`, date: task.dueOn!, kind: "Task", title: task.title, detail: `${project.name}${overdue ? " · overdue" : ""}`, tone: overdue || task.status === "blocked" ? "critical" : undefined, onOpen: openProject(data, project) });
    }
    for (const item of company.data?.obligations.items ?? []) list.push({ key: `obligation-${item.obligationId}`, date: item.dueOn, kind: "Investor", title: `${item.accountName} payment`, detail: `${item.instrumentName} · ${item.expectedCents === null ? `≥ ${wholeCents(item.knownMinimumCents)}` : wholeCents(item.expectedCents)}` });
    for (const item of company.data?.maturities ?? []) if (item.maturityOn <= addDays(asOf, 90)) list.push({ key: `maturity-${item.instrumentId}`, date: item.maturityOn, kind: "Loan", title: `${item.instrumentName} matures`, detail: `${item.accountName}${item.outstandingPrincipalCents ? ` · ${wholeCents(item.outstandingPrincipalCents)}` : ""}`, tone: "critical" });
    for (const item of company.data?.workDue.items ?? []) if (item.scheduledOn) list.push({ key: `work-${item.id}`, date: item.scheduledOn, kind: "Work", title: item.title, detail: `${item.propertyName ?? ""}${item.unitNumber ? ` ${item.unitNumber}` : ""}${item.overdue ? " · overdue" : ""}`, tone: item.overdue ? "critical" : undefined });
    return list.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }, [asOf, until, data, leases.rows, projects.data, details.details, company.data, organization]);
  const loading = !data.movements || leases.loading || projects.isLoading || company.isLoading;
  if (!items.length) return loading ? <Loading /> : <Empty title="Nothing in the next 30 days">Moves, lease ends, project dates, tasks, loan maturities and investor payments show here.</Empty>;
  return <ul className="ops-agenda">{items.map(item => {
    const days = dayDiff(asOf, item.date);
    return <li key={item.key} data-tone={item.tone}>
      <span className="ops-agenda-date"><strong>{shortDay(item.date)}</strong><small>{days < 0 ? `${-days}d late` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : `in ${days}d`}</small></span>
      <span className="ops-agenda-text">{item.onOpen ? <button type="button" className="rops-link" onClick={item.onOpen}>{item.title}</button> : <strong>{item.title}</strong>}<small>{item.kind} · {item.detail}</small></span>
    </li>;
  })}{metrics.h <= 2 && <li className="ops-agenda-more">{items.length} items</li>}</ul>;
}

/* ---------- 15-week cash grid ---------- */

function CashflowGrid({ data, metrics }: WidgetContext) {
  const forecast = useForecast(data);
  return <ForecastGate forecast={forecast}>{result => {
    const weeks = forecastWeeksFrom(result, data.filters.asOfDate);
    const count = Math.max(2, Math.min(weeks.length, Math.floor((metrics.bodyWidth - 170) / 74)));
    const shown = weeks.slice(0, count);
    const categories = Array.from(new Set(shown.flatMap(week => Object.keys(week.categories)))).filter(key => shown.some(week => (centsNumber(week.categories[key]) ?? 0) !== 0));
    const magnitude = (key: string) => shown.reduce((sum, week) => sum + Math.abs(centsNumber(week.categories[key]) ?? 0), 0);
    const room = Math.max(0, Math.floor((metrics.bodyHeight - 40) / 25) - 6);
    const kept = categories.sort((a, b) => magnitude(b) - magnitude(a)).slice(0, room);
    const ordered = kept.sort((a, b) => (shown.reduce((s, w) => s + (centsNumber(w.categories[b]) ?? 0), 0)) - (shown.reduce((s, w) => s + (centsNumber(w.categories[a]) ?? 0), 0)));
    const cell = (value: string | undefined, strong = false) => { const cents = centsNumber(value); return <td className={`number${strong ? " is-strong" : ""}`} data-tone={cents !== undefined && cents < 0 ? "critical" : undefined}>{cents === undefined ? "—" : cents === 0 ? "·" : shortCents(cents)}</td>; };
    const relative = result.summary.openingCashKnown === false;
    return <><div className="ops-cashgrid"><table>
      <thead><tr><th>{result.scenario.name}</th>{shown.map(week => <th key={week.key} className="number">{shortDay(week.start)}</th>)}</tr></thead>
      <tbody>
        <tr className="is-sub"><th>{relative ? "Opening (relative)" : "Opening cash"}</th>{shown.map(week => cell(week.openingCashCents))}</tr>
        {ordered.map(key => <tr key={key}><th>{CASH_CATEGORY_LABELS[key as keyof typeof CASH_CATEGORY_LABELS] ?? humanLabel(key)}</th>{shown.map(week => cell(week.categories[key]))}</tr>)}
        {categories.length > ordered.length && <tr className="is-sub"><th>{categories.length - ordered.length} more lines</th>{shown.map(week => <td key={week.key} />)}</tr>}
        <tr className="is-total"><th>Net</th>{shown.map(week => cell(week.netCents, true))}</tr>
        <tr className="is-total"><th>{relative ? "Ending (relative)" : "Ending cash"}</th>{shown.map(week => <React.Fragment key={week.key}>{cell(week.closingCashCents, true)}</React.Fragment>)}</tr>
        <tr className="is-sub"><th>Available</th>{shown.map(week => <React.Fragment key={week.key}>{cell(week.availableClosingCents)}</React.Fragment>)}</tr>
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
  const budget = sumCents(open.map(project => project.approvedBudgetCents));
  const spent = sumCents(open.map(project => project.postedActualCents));
  const knownSpent = sumCents(open.map(project => project.postedActualCents ?? "0"));
  const draft = sumCents(open.map(project => project.draftCostCents));
  const profits = deals.reports.filter(entry => entry.project.status !== "completed").map(entry => entry.report?.saleForecast.projectedProfitCents ?? null);
  const profit = sumCents(profits);
  const items: Stat[] = [
    { key: "open", label: "Open projects", value: String(open.length), detail: `${open.filter(project => project.status === "active").length} active · ${open.filter(project => project.status === "planning").length} planning` },
    { key: "budget", label: "Approved budgets", value: budget === null ? `${wholeCents(sumCents(open.map(project => project.approvedBudgetCents ?? "0")))}+` : wholeCents(budget), detail: budget === null ? `${open.filter(project => project.approvedBudgetCents === null).length} without a budget` : undefined },
    { key: "spent", label: "Posted spend", value: open.every(project => project.postedActualCents === null) ? "Not linked" : spent === null ? `${wholeCents(knownSpent)}+` : wholeCents(spent), detail: budget !== null && spent !== null && centsNumber(budget) ? `${pct((centsNumber(spent) ?? 0) / (centsNumber(budget) ?? 1))} of budget` : "QuickBooks actuals" },
    { key: "draft", label: "Unposted costs", value: wholeCents(draft), detail: "Draft costs not in QuickBooks yet" },
    { key: "profit", label: "Projected flip profit", value: deals.loading ? "…" : !deals.flips.length ? "—" : profit === null ? `${wholeCents(sumCents(profits.filter((value): value is NonNullable<typeof value> => value !== null)))}*` : wholeCents(profit), detail: deals.flips.length ? `${deals.flips.length} flip${deals.flips.length === 1 ? "" : "s"}${profit === null ? " · some not forecast" : ""}` : "No flips" },
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
    return <li key={project.id}><button type="button" className="ops-ring-button" onClick={openProject(data, project)} title={`Posted ${wholeCents(project.postedActualCents)} of ${wholeCents(project.approvedBudgetCents)} budget`}>
      <Ring share={share} size={size} tone={share !== undefined && share > 1 ? "critical" : "accent"} />
      <strong>{project.name}</strong><small>{share === undefined ? project.approvedBudgetCents === null ? "No budget" : "Spend unknown" : `${wholeCents(project.postedActualCents)} of ${shortCents(project.approvedBudgetCents)}`}</small>
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
  return <div className="ops-gantt">
    <div className="ops-gantt-scale"><span />{<div>{months.map(month => <i key={month} style={{ left: x(`${month}-01`) }}>{monthShort(month)}</i>)}<b style={{ left: x(asOf) }} title="Today" /></div>}</div>
    {rows.map(project => {
      const start = project.startOn ?? project.targetOn!, end = project.targetOn ?? project.startOn!;
      const late = project.targetOn !== null && project.targetOn < asOf;
      return <div key={project.id} className="ops-gantt-row">
        <button type="button" className="ops-gantt-name" onClick={openProject(data, project)} title={propertyNameFor(data, organization, project.propertyId)}>{project.name}<small>{PROJECT_STATUS_LABEL[project.status]}</small></button>
        <div className="ops-gantt-track"><b style={{ left: x(asOf) }} aria-hidden="true" />
          <i className="ops-gantt-bar" data-tone={late ? "critical" : project.status === "on_hold" ? "muted" : undefined} style={{ left: x(start), width: `max(6px, calc(${x(end)} - ${x(start)}))` }} title={`${shortDay(start)} → ${shortDay(end)}`} />
          {tasksFor(project).map(task => <em key={task.id} className="ops-gantt-task" data-tone={task.status === "completed" ? "positive" : task.dueOn! < asOf ? "critical" : undefined} style={{ left: x(task.dueOn!) }} title={`${task.title} · ${shortDay(task.dueOn)}`} />)}
        </div>
      </div>;
    })}
  </div>;
}

function ProjectBoard({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectsGate(data);
  const deals = useDealReports(data, projects);
  if (gate) return gate;
  const profit = new Map(deals.reports.map(entry => [entry.project.id, entry.report?.saleForecast] as const));
  const rows: Row[] = (projects ?? []).filter(project => project.status !== "completed").map(project => ({
    id: project.id, project, name: project.name, propertyName: propertyNameFor(data, organization, project.propertyId), type: PROJECT_TYPE_LABEL[project.projectType], status: PROJECT_STATUS_LABEL[project.status],
    targetOn: project.targetOn, budget: centsNumber(project.approvedBudgetCents) ?? null, spent: centsNumber(project.postedActualCents) ?? null, draft: centsNumber(project.draftCostCents) ?? null,
    share: spentShare(project) ?? null, profit: centsNumber(profit.get(project.id)?.projectedProfitCents) ?? null, saleOn: profit.get(project.id)?.saleOn ?? null,
  }));
  const wide = metrics.w >= 12;
  const columns: Column[] = [
    { key: "name", label: "Project", render: row => <span className="rops-cell-stack"><button type="button" className="rops-link" onClick={openProject(data, row.project as ProjectSummary)}>{text(row.name)}</button><small>{text(row.propertyName)} · {text(row.type)}</small></span> },
    { key: "status", label: "Status" },
    { key: "targetOn", label: "Target", render: row => { const date = row.targetOn as string | null; return date ? <span data-tone={date < data.filters.asOfDate ? "critical" : undefined}>{shortDay(date)}</span> : "—"; } },
    { key: "budget", label: "Budget", number: true, render: row => numeric(row.budget) ? dollars(row.budget) : "—" },
    { key: "spent", label: "Spent", number: true, render: row => numeric(row.spent) ? dollars(row.spent) : "—" },
    { key: "share", label: "Used", number: true, render: row => numeric(row.share) ? <span data-tone={row.share > 1 ? "critical" : undefined}>{pct(row.share)}</span> : "—" },
    ...(wide ? [{ key: "draft", label: "Unposted", number: true, render: (row: Row) => numeric(row.draft) ? dollars(row.draft) : "—" }, { key: "saleOn", label: "Sale", render: (row: Row) => row.saleOn ? shortDay(String(row.saleOn)) : "—" }] : []),
    { key: "profit", label: "Profit", number: true, render: row => numeric(row.profit) ? <span data-tone={row.profit < 0 ? "critical" : "positive"}>{dollars(row.profit)}</span> : row.type === "Flip" ? "Not forecast" : "—" },
  ];
  return <Table rows={rows} columns={columns} limit={fitRows(metrics, 46, 40)} empty="No open projects." onMore={openProject(data)} footer={<><span>{rows.length} open · {rows.filter(row => row.status === "Active").length} active</span>{openProject(data) && <button type="button" className="rops-link" onClick={openProject(data)}>All projects</button>}</>} />;
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

