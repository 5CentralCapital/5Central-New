// Project widgets beyond the default block: status mix, spend against budget,
// what is over budget or due, tasks, flip profit and sale forecasts, and how
// much of each project's cost is verified in QuickBooks.
import React from "react";
import type { ProjectSummary } from "@shared/projects";
import {
  Bars, Empty, Failed, Foot, LIST_ROW, Loading, Rows, SIZESETS, Stack, TABLE_ROW, TILE, Table, Tile,
  addDays, centsNumber, dayDiff, fitRows, humanLabel, isSmall, pct, shortDay, sumCents, wholeCents,
  type Row, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import { openProjects, useDealReports, useProjectDetails, useProjects } from "./dashboard-sources";
import { PROJECT_STATUS_LABEL, PROJECT_TYPE_LABEL, openProject, postedSpendLabel, propertyNameFor, spentShare, useCompanyGate } from "./dashboard-widgets-overview";

function useProjectList(data: WidgetContext["data"]) {
  const { organization, gate } = useCompanyGate(data);
  const projects = useProjects(data);
  const blocked = gate ?? (projects.error ? <Failed title="Projects unavailable" error={projects.error} retry={() => void projects.refetch()} /> : !projects.data ? <Loading label="Loading projects" /> : null);
  return { organization, projects: projects.data ?? [], gate: blocked };
}

function knownCents(values: readonly (string | null | undefined)[]): string | null {
  const known = values.filter((value): value is string => value !== null && value !== undefined);
  return known.length ? sumCents(known) : null;
}

const projectLabel = (project: ProjectSummary) => <>{project.name} <small>{PROJECT_TYPE_LABEL[project.projectType]}</small></>;

function StatusMix({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  if (!projects.length) return <Empty title="No projects yet" />;
  const count = (status: string) => projects.filter(project => project.status === status).length;
  return <><Tile label="Projects" value={String(projects.length)} big={isSmall(metrics)} detail={`${count("active")} active`} />
    {!isSmall(metrics) && <Stack format={value => String(value)} parts={[{ key: "active", label: "Active", value: count("active"), tone: "positive" }, { key: "planning", label: "Planning", value: count("planning"), tone: "accent" }, { key: "on_hold", label: "On hold", value: count("on_hold"), tone: "muted" }, { key: "completed", label: "Completed", value: count("completed") }]} />}</>;
}

function SpendVsBudget({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = (openProjects(projects) ?? []).filter(project => project.approvedBudgetCents !== null);
  if (!open.length) return <Empty title="No approved budgets">Approve a budget on a project to track spend against it.</Empty>;
  const unknown = open.filter(project => spentShare(project) === undefined).length;
  return <><Bars format={value => `${Math.round(value)}%`} limit={fitRows(metrics, LIST_ROW, 0)} items={open.map(project => { const share = spentShare(project); return { key: project.id, label: projectLabel(project), value: share === undefined ? 0 : share * 100, display: share === undefined ? postedSpendLabel(project) : `${pct(share)} · ${postedSpendLabel(project)}`, tone: share !== undefined && share > 1 ? "critical" as const : share === undefined ? "muted" as const : undefined }; })} />{unknown > 0 && <Foot>{unknown} project{unknown === 1 ? " has" : "s have"} incomplete QuickBooks spend coverage.</Foot>}</>;
}

function OverBudget({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  const unknown = open.filter(project => project.approvedBudgetCents !== null && spentShare(project) === undefined);
  const flagged = open.map(project => ({ project, share: spentShare(project) })).filter(entry => entry.share !== undefined && entry.share >= 0.9).sort((a, b) => b.share! - a.share!);
  if (!flagged.length) return unknown.length ? <Empty title="Budget coverage incomplete">Some projects could not be checked against their approved budget.</Empty> : <Empty title="Nothing near budget">Projects at 90% or more of budget show here.</Empty>;
  return <><Rows limit={fitRows(metrics, LIST_ROW, 0)} items={flagged.map(({ project, share }) => ({ key: project.id, label: <button type="button" className="rops-link" onClick={openProject(data, project, project.organizationId)}>{project.name}</button>, detail: `${postedSpendLabel(project)} of ${wholeCents(project.approvedBudgetCents)}`, value: pct(share!), tone: share! > 1 ? "critical" as const : undefined }))} />{unknown.length > 0 && <Foot>{unknown.length} other project{unknown.length === 1 ? " has" : "s have"} incomplete coverage.</Foot>}</>;
}

function DueSoon({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectList(data);
  if (gate) return gate;
  const asOf = data.filters.asOfDate, until = addDays(asOf, 60);
  const rows = (openProjects(projects) ?? []).filter(project => project.targetOn && project.targetOn <= until).sort((a, b) => a.targetOn!.localeCompare(b.targetOn!));
  if (!rows.length) return <Empty title="No project targets in 60 days" />;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map(project => { const days = dayDiff(asOf, project.targetOn!); return { key: project.id, label: <button type="button" className="rops-link" onClick={openProject(data, project, project.organizationId)}>{project.name}</button>, detail: propertyNameFor(data, organization, project.propertyId), value: days < 0 ? `${-days}d late` : `${shortDay(project.targetOn)} · ${days}d`, tone: days < 0 ? "critical" as const : undefined }; })} />;
}

function ByType({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  if (!open.length) return <Empty title="No open projects" />;
  const groups = new Map<string, ProjectSummary[]>();
  for (const project of open) groups.set(project.projectType, [...(groups.get(project.projectType) ?? []), project]);
  return <Bars limit={fitRows(metrics, LIST_ROW, 0)} items={Array.from(groups.entries()).map(([type, list]) => { const currencies = new Set(list.map(project => project.currency)); const budget = currencies.size > 1 ? null : knownCents(list.map(project => project.approvedBudgetCents)); const missing = list.some(project => project.approvedBudgetCents === null); return { key: type, label: <>{PROJECT_TYPE_LABEL[type] ?? humanLabel(type)} <small>{list.length}</small></>, value: centsNumber(budget) ?? 0, display: currencies.size > 1 ? "Multiple currencies" : budget === null ? "No approved budget" : `${missing ? "≥ " : ""}${wholeCents(budget)} budget`, tone: currencies.size > 1 || budget === null || missing ? "muted" as const : undefined }; })} />;
}

function Coverage({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  if (!open.length) return <Empty title="No open projects" />;
  const count = (state: string) => open.filter(project => project.postedActualCoverage === state).length;
  return <><Stack format={value => String(value)} parts={[{ key: "complete", label: "Verified in QuickBooks", value: count("complete"), tone: "positive" }, { key: "partial", label: "Partly verified", value: count("partial"), tone: "accent" }, { key: "unavailable", label: "Not linked", value: count("unavailable"), tone: "muted" }]} />
    {metrics.h > 2 && <Rows limit={fitRows(metrics, LIST_ROW, 70, 1)} items={open.filter(project => project.postedActualCoverage !== "complete").map(project => ({ key: project.id, label: project.name, value: humanLabel(project.postedActualCoverage), tone: "muted" as const }))} />}</>;
}

function Tasks({ data, metrics, mode }: WidgetContext & { mode: "upcoming" | "blocked" }) {
  const { projects, gate } = useProjectList(data);
  const details = useProjectDetails(data, projects);
  if (gate) return gate;
  if (details.loading) return <Loading label="Loading tasks" />;
  const asOf = data.filters.asOfDate;
  const tasks = details.details.flatMap(project => project.tasks.filter(task => !task.archivedAt && task.status !== "completed" && task.status !== "cancelled").map(task => ({ task, project })));
  const rows = mode === "blocked" ? tasks.filter(({ task }) => task.status === "blocked" || (task.dueOn !== null && task.dueOn < asOf)) : tasks.filter(({ task }) => task.dueOn !== null && task.dueOn >= asOf).sort((a, b) => a.task.dueOn!.localeCompare(b.task.dueOn!));
  if (!rows.length) return details.incomplete ? <Empty title="Project tasks unavailable">Some project task records could not be read.</Empty> : <Empty title={mode === "blocked" ? "Nothing blocked or late" : "No upcoming tasks"}>{mode === "upcoming" ? "Tasks with due dates on open projects show here." : undefined}</Empty>;
  const body = <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map(({ task, project }) => ({ key: task.id, label: task.title, detail: project.name, value: task.status === "blocked" ? "Blocked" : task.dueOn ? task.dueOn < asOf ? `${dayDiff(task.dueOn, asOf)}d late` : shortDay(task.dueOn) : "No date", tone: task.status === "blocked" || (task.dueOn !== null && task.dueOn < asOf) ? "critical" as const : undefined }))} />;
  return details.incomplete ? <>{body}<Foot>Some project task records could not be read.</Foot></> : body;
}

function TaskProgress({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  const details = useProjectDetails(data, projects);
  if (gate) return gate;
  if (details.loading) return <Loading label="Loading tasks" />;
  const rows = details.details.map(project => { const tasks = project.tasks.filter(task => !task.archivedAt && task.status !== "cancelled"); return { project, total: tasks.length, done: tasks.filter(task => task.status === "completed").length }; }).filter(row => row.total > 0);
  if (!rows.length) return details.incomplete ? <Empty title="Project tasks unavailable">Some project task records could not be read.</Empty> : <Empty title="No project tasks">Add tasks to projects to track progress.</Empty>;
  const body = <Bars format={value => `${Math.round(value)}%`} limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map(row => ({ key: row.project.id, label: <>{row.project.name} <small>{row.done}/{row.total}</small></>, value: row.done / row.total * 100, tone: "positive" as const }))} />;
  return details.incomplete ? <>{body}<Foot>Some project task records could not be read.</Foot></> : body;
}

function Profit({ data, metrics, mode }: WidgetContext & { mode: "profit" | "sale" | "cost" }) {
  const { projects, gate } = useProjectList(data);
  const deals = useDealReports(data, projects);
  if (gate) return gate;
  if (!deals.flips.length) return deals.incomplete ? <Empty title="Flip reports unavailable">Some flip projects could not be read.</Empty> : <Empty title="No flips">Flip projects show projected sale and profit here.</Empty>;
  if (deals.loading) return <Loading label="Loading deal reports" />;
  if (mode === "sale") {
    const rows: Row[] = deals.reports.map(entry => ({ id: entry.project.id, name: `${entry.project.name} · ${entry.project.currency}`, saleOn: entry.report?.saleForecast.saleOn ?? null, gross: entry.report?.saleForecast.grossProceedsCents ?? null, net: entry.report?.saleForecast.netSaleProceedsCents ?? null, error: !!entry.error }));
    const body = <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} columns={[
      { key: "name", label: "Flip" },
      { key: "saleOn", label: "Sale", render: row => row.error ? "Unavailable" : row.saleOn ? shortDay(String(row.saleOn)) : "Not set" },
      { key: "gross", label: "Price", number: true, render: row => wholeCents(row.gross as string | null) },
      { key: "net", label: "Net proceeds", number: true, render: row => wholeCents(row.net as string | null) },
    ]} />;
    return deals.incomplete ? <>{body}<Foot>Some flip sale reports could not be read.</Foot></> : body;
  }
  if (mode === "cost") {
    const body = <Bars limit={fitRows(metrics, LIST_ROW, 30, 1)} items={deals.reports.map(entry => { const report = entry.report; const totals = report?.totals; const finalCents = totals?.finalCostCents ?? null, incurredCents = totals?.incurredCents ?? null; const final = centsNumber(finalCents), incurred = centsNumber(incurredCents), budget = centsNumber(totals?.budgetCents); const partial = report?.coverage.status === "partial"; const finalKnown = finalCents !== null, incurredKnown = incurredCents !== null; return { key: entry.project.id, label: <>{entry.project.name} · {entry.project.currency} <small>budget {wholeCents(totals?.budgetCents ?? null)}</small></>, value: final ?? incurred ?? 0, display: finalKnown ? `${partial ? "≥ " : ""}${wholeCents(finalCents)}` : incurredKnown ? `${partial ? "≥ " : ""}${wholeCents(incurredCents)} so far` : "Unavailable", tone: final !== undefined && budget !== undefined && final > budget ? "critical" as const : !finalKnown && !incurredKnown ? "muted" as const : undefined }; })} />;
    return deals.incomplete ? <>{body}<Foot>Some flip cost reports could not be read.</Foot></> : body;
  }
  const flipCurrencies = new Set(deals.flips.map(project => project.currency));
  const known = deals.reports.map(entry => {
    const report = entry.report;
    return report && report.coverage.status === "complete" && report.saleForecast.profitState === "complete" ? report.saleForecast.projectedProfitCents : null;
  });
  const total = flipCurrencies.size <= 1 && known.every(value => value !== null) && !deals.incomplete ? sumCents(known) : null;
  const body = <><Tile label="Projected profit" big={isSmall(metrics)} value={flipCurrencies.size > 1 ? "Multiple currencies" : total === null ? "Unavailable" : wholeCents(total)} detail={`${deals.flips.length} flips${flipCurrencies.size > 1 ? " · totals separated by currency" : total === null ? " · some not forecast" : ""}`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={deals.reports.map(entry => { const report = entry.report; const complete = report?.coverage.status === "complete" && report.saleForecast.profitState === "complete"; const raw = complete ? report.saleForecast.projectedProfitCents : null; const cents = centsNumber(raw); return { key: entry.project.id, label: <>{entry.project.name} · {entry.project.currency}{!complete ? <small> not complete</small> : null}</>, value: cents ?? 0, display: raw === null ? "Not forecast" : wholeCents(raw), tone: cents !== undefined ? cents < 0 ? "critical" as const : "positive" as const : "muted" as const }; })} />}</>;
  return deals.incomplete ? <>{body}<Foot>Some flip profit reports could not be read; the total is unavailable.</Foot></> : body;
}

function DraftCosts({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  const rows = open.filter(project => /^-?\d+$/.test(project.draftCostCents) && BigInt(project.draftCostCents) > BigInt(0)).sort((a, b) => BigInt(b.draftCostCents) > BigInt(a.draftCostCents) ? -1 : BigInt(b.draftCostCents) < BigInt(a.draftCostCents) ? 1 : 0);
  const currencies = new Set(rows.map(project => project.currency));
  const total = currencies.size <= 1 ? sumCents(rows.map(project => project.draftCostCents)) : null;
  if (!rows.length) return <Empty title="No unposted costs">Draft costs waiting to be posted to QuickBooks show here.</Empty>;
  return <><Tile label="Unposted costs" big={isSmall(metrics)} value={currencies.size > 1 ? "Multiple currencies" : wholeCents(total)} detail={`${rows.length} projects · not in QuickBooks yet`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map(project => ({ key: project.id, label: <>{project.name} · {project.currency}</>, value: centsNumber(project.draftCostCents) ?? 0, display: wholeCents(project.draftCostCents) }))} />}</>;
}

function Budgets({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  const rows: Row[] = open.map(project => ({ id: project.id, project, name: project.name, property: propertyNameFor(data, organization, project.propertyId), status: PROJECT_STATUS_LABEL[project.status], budget: project.approvedBudgetCents, spent: project.postedActualCents, coverage: project.postedActualCoverage, left: project.approvedBudgetCents !== null && project.postedActualCoverage === "complete" && project.postedActualCents !== null ? String(BigInt(project.approvedBudgetCents) - BigInt(project.postedActualCents)) : null }));
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} empty="No open projects." columns={[
    { key: "name", label: "Project", render: row => <span className="rops-cell-stack"><button type="button" className="rops-link" onClick={openProject(data, row.project as ProjectSummary, (row.project as ProjectSummary).organizationId)}>{String(row.name)}</button><small>{String(row.property)} · {String(row.status)} · {(row.project as ProjectSummary).currency}</small></span> },
    { key: "budget", label: "Budget", number: true, render: row => wholeCents(row.budget as string | null) },
    { key: "spent", label: "Spent", number: true, render: row => postedSpendLabel({ postedActualCents: row.spent as string | null, postedActualCoverage: row.coverage as ProjectSummary["postedActualCoverage"] }) },
    { key: "left", label: "Left", number: true, render: row => <span data-tone={(centsNumber(row.left as string | null) ?? 0) < 0 ? "critical" : undefined}>{wholeCents(row.left as string | null)}</span> },
  ]} footer={<span>{open.length} open projects</span>} />;
}

export const PROJECT_WIDGETS: readonly WidgetDefinition[] = [
  { id: "proj-status", category: "projects", name: "Project status", description: "Projects by status: active, planning, on hold, completed", sizes: ["S", "M", "W"], defaultSize: "M", render: context => <StatusMix {...context} />, open: data => openProject(data) },
  { id: "proj-budgets", category: "projects", name: "Budgets & spend", description: "Approved budget, posted spend and what is left per project", sizes: SIZESETS.table, defaultSize: "L", render: context => <Budgets {...context} />, open: data => openProject(data) },
  { id: "proj-spend", category: "projects", name: "Spend vs budget", description: "Share of each approved budget already posted", sizes: SIZESETS.list, defaultSize: "MT", render: context => <SpendVsBudget {...context} />, open: data => openProject(data) },
  { id: "proj-over-budget", category: "projects", name: "Near or over budget", description: "Open projects at 90% or more of their budget", sizes: SIZESETS.list, defaultSize: "M", render: context => <OverBudget {...context} /> },
  { id: "proj-due-soon", category: "projects", name: "Project targets", description: "Projects due in the next 60 days and those past target", sizes: SIZESETS.list, defaultSize: "M", render: context => <DueSoon {...context} /> },
  { id: "proj-by-type", category: "projects", name: "Projects by type", description: "Open projects and approved budget by type", sizes: SIZESETS.list, defaultSize: "M", render: context => <ByType {...context} /> },
  { id: "proj-coverage", category: "projects", name: "QuickBooks cost coverage", description: "How much of each project's cost is verified in QuickBooks", sizes: SIZESETS.list, defaultSize: "M", render: context => <Coverage {...context} /> },
  { id: "proj-tasks", category: "projects", name: "Upcoming tasks", description: "Open project tasks by due date", sizes: SIZESETS.list, defaultSize: "MT", scrolls: true, render: context => <Tasks {...context} mode="upcoming" /> },
  { id: "proj-blocked", category: "projects", name: "Blocked & late tasks", description: "Project tasks that are blocked or past due", sizes: SIZESETS.list, defaultSize: "M", render: context => <Tasks {...context} mode="blocked" /> },
  { id: "proj-task-progress", category: "projects", name: "Task progress", description: "Completed tasks as a share of each project's tasks", sizes: SIZESETS.list, defaultSize: "M", render: context => <TaskProgress {...context} /> },
  { id: "proj-profit", category: "projects", name: "Profit by flip", description: "Projected profit per flip from its sale forecast", sizes: SIZESETS.list, defaultSize: "MT", render: context => <Profit {...context} mode="profit" /> },
  { id: "proj-sales", category: "projects", name: "Sale forecasts", description: "Planned sale date, price and net proceeds per flip", sizes: SIZESETS.table, defaultSize: "MT", render: context => <Profit {...context} mode="sale" /> },
  { id: "proj-deal-cost", category: "projects", name: "Whole-deal cost", description: "Final cost per flip (acquisition, rehab, financing, holding, selling) against budget", sizes: SIZESETS.list, defaultSize: "M", render: context => <Profit {...context} mode="cost" /> },
  { id: "proj-draft-costs", category: "projects", name: "Unposted costs", description: "Draft project costs not in QuickBooks yet", sizes: SIZESETS.list, defaultSize: "M", render: context => <DraftCosts {...context} /> },
];
