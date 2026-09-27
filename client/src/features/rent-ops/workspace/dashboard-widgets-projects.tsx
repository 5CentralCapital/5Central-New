// Project widgets beyond the default block: status mix, spend against budget,
// what is over budget or due, tasks, flip profit and sale forecasts, and how
// much of each project's cost is verified in QuickBooks.
import React from "react";
import type { ProjectSummary } from "@shared/projects";
import {
  Bars, Empty, LIST_ROW, Loading, Rows, SIZESETS, Stack, TABLE_ROW, TILE, Table, Tile,
  addDays, centsNumber, dayDiff, fitRows, humanLabel, isSmall, pct, shortDay, sumCents, wholeCents,
  type Row, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";
import { openProjects, useDealReports, useProjectDetails, useProjects } from "./dashboard-sources";
import { PROJECT_STATUS_LABEL, PROJECT_TYPE_LABEL, openProject, propertyNameFor, spentShare, useCompanyGate } from "./dashboard-widgets-overview";

function useProjectList(data: WidgetContext["data"]) {
  const { organization, gate } = useCompanyGate(data);
  const projects = useProjects(data);
  const blocked = gate ?? (projects.error ? <Empty title="Projects unavailable" /> : !projects.data ? <Loading label="Loading projects" /> : null);
  return { organization, projects: projects.data ?? [], gate: blocked };
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
  return <Bars format={value => `${Math.round(value)}%`} limit={fitRows(metrics, LIST_ROW, 0)} items={open.map(project => { const share = spentShare(project); return { key: project.id, label: projectLabel(project), value: share === undefined ? 0 : share * 100, display: share === undefined ? "Unknown" : `${pct(share)} · ${wholeCents(project.postedActualCents)}`, tone: share !== undefined && share > 1 ? "critical" as const : undefined }; })} />;
}

function OverBudget({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const flagged = (openProjects(projects) ?? []).map(project => ({ project, share: spentShare(project) })).filter(entry => entry.share !== undefined && entry.share >= 0.9).sort((a, b) => b.share! - a.share!);
  if (!flagged.length) return <Empty title="Nothing near budget">Projects at 90% or more of budget show here.</Empty>;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={flagged.map(({ project, share }) => ({ key: project.id, label: <button type="button" className="rops-link" onClick={openProject(data, project)}>{project.name}</button>, detail: `${wholeCents(project.postedActualCents)} of ${wholeCents(project.approvedBudgetCents)}`, value: pct(share!), tone: share! > 1 ? "critical" as const : undefined }))} />;
}

function DueSoon({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectList(data);
  if (gate) return gate;
  const asOf = data.filters.asOfDate, until = addDays(asOf, 60);
  const rows = (openProjects(projects) ?? []).filter(project => project.targetOn && project.targetOn <= until).sort((a, b) => a.targetOn!.localeCompare(b.targetOn!));
  if (!rows.length) return <Empty title="No project targets in 60 days" />;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map(project => { const days = dayDiff(asOf, project.targetOn!); return { key: project.id, label: <button type="button" className="rops-link" onClick={openProject(data, project)}>{project.name}</button>, detail: propertyNameFor(data, organization, project.propertyId), value: days < 0 ? `${-days}d late` : `${shortDay(project.targetOn)} · ${days}d`, tone: days < 0 ? "critical" as const : undefined }; })} />;
}

function ByType({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  if (!open.length) return <Empty title="No open projects" />;
  const groups = new Map<string, ProjectSummary[]>();
  for (const project of open) groups.set(project.projectType, [...(groups.get(project.projectType) ?? []), project]);
  return <Bars limit={fitRows(metrics, LIST_ROW, 0)} items={Array.from(groups.entries()).map(([type, list]) => { const budget = sumCents(list.map(project => project.approvedBudgetCents ?? "0")); return { key: type, label: <>{PROJECT_TYPE_LABEL[type] ?? humanLabel(type)} <small>{list.length}</small></>, value: centsNumber(budget) ?? 0, display: `${wholeCents(budget)} budget` }; })} />;
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
  if (!rows.length) return <Empty title={mode === "blocked" ? "Nothing blocked or late" : "No upcoming tasks"}>{mode === "upcoming" ? "Tasks with due dates on open projects show here." : undefined}</Empty>;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map(({ task, project }) => ({ key: task.id, label: task.title, detail: project.name, value: task.status === "blocked" ? "Blocked" : task.dueOn ? task.dueOn < asOf ? `${dayDiff(task.dueOn, asOf)}d late` : shortDay(task.dueOn) : "No date", tone: task.status === "blocked" || (task.dueOn !== null && task.dueOn < asOf) ? "critical" as const : undefined }))} />;
}

function TaskProgress({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  const details = useProjectDetails(data, projects);
  if (gate) return gate;
  if (details.loading) return <Loading label="Loading tasks" />;
  const rows = details.details.map(project => { const tasks = project.tasks.filter(task => !task.archivedAt && task.status !== "cancelled"); return { project, total: tasks.length, done: tasks.filter(task => task.status === "completed").length }; }).filter(row => row.total > 0);
  if (!rows.length) return <Empty title="No project tasks">Add tasks to projects to track progress.</Empty>;
  return <Bars format={value => `${Math.round(value)}%`} limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map(row => ({ key: row.project.id, label: <>{row.project.name} <small>{row.done}/{row.total}</small></>, value: row.done / row.total * 100, tone: "positive" as const }))} />;
}

function Profit({ data, metrics, mode }: WidgetContext & { mode: "profit" | "sale" | "cost" }) {
  const { projects, gate } = useProjectList(data);
  const deals = useDealReports(data, projects);
  if (gate) return gate;
  if (!deals.flips.length) return <Empty title="No flips">Flip projects show projected sale and profit here.</Empty>;
  if (deals.loading) return <Loading label="Loading deal reports" />;
  if (mode === "sale") {
    const rows: Row[] = deals.reports.map(entry => ({ id: entry.project.id, name: entry.project.name, saleOn: entry.report?.saleForecast.saleOn ?? null, gross: entry.report?.saleForecast.grossProceedsCents ?? null, net: entry.report?.saleForecast.netSaleProceedsCents ?? null, error: !!entry.error }));
    return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} columns={[
      { key: "name", label: "Flip" },
      { key: "saleOn", label: "Sale", render: row => row.error ? "Unavailable" : row.saleOn ? shortDay(String(row.saleOn)) : "Not set" },
      { key: "gross", label: "Price", number: true, render: row => wholeCents(row.gross as string | null) },
      { key: "net", label: "Net proceeds", number: true, render: row => wholeCents(row.net as string | null) },
    ]} />;
  }
  if (mode === "cost") {
    return <Bars limit={fitRows(metrics, LIST_ROW, 30, 1)} items={deals.reports.map(entry => { const totals = entry.report?.totals; const final = centsNumber(totals?.finalCostCents), budget = centsNumber(totals?.budgetCents); return { key: entry.project.id, label: <>{entry.project.name} <small>budget {wholeCents(totals?.budgetCents ?? null)}</small></>, value: final ?? centsNumber(totals?.incurredCents) ?? 0, display: final === undefined ? `${wholeCents(totals?.incurredCents ?? null)} so far` : wholeCents(final), tone: final !== undefined && budget !== undefined && final > budget ? "critical" as const : undefined }; })} />;
  }
  const known = deals.reports.map(entry => entry.report?.saleForecast.projectedProfitCents ?? null);
  const total = sumCents(known);
  return <><Tile label="Projected profit" big={isSmall(metrics)} value={total === null ? `${wholeCents(sumCents(known.filter((value): value is NonNullable<typeof value> => value !== null)))}*` : wholeCents(total)} detail={`${deals.flips.length} flips${total === null ? " · * some not forecast" : ""}`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={deals.reports.map(entry => { const cents = centsNumber(entry.report?.saleForecast.projectedProfitCents); return { key: entry.project.id, label: <>{entry.project.name}{entry.report?.saleForecast.profitState === "partial" ? <small> partial</small> : null}</>, value: cents ?? 0, display: cents === undefined ? "Not forecast" : wholeCents(cents), tone: cents !== undefined ? cents < 0 ? "critical" as const : "positive" as const : undefined }; })} />}</>;
}

function DraftCosts({ data, metrics }: WidgetContext) {
  const { projects, gate } = useProjectList(data);
  if (gate) return gate;
  const rows = (openProjects(projects) ?? []).filter(project => (centsNumber(project.draftCostCents) ?? 0) > 0).sort((a, b) => (centsNumber(b.draftCostCents) ?? 0) - (centsNumber(a.draftCostCents) ?? 0));
  const total = sumCents(rows.map(project => project.draftCostCents));
  if (!rows.length) return <Empty title="No unposted costs">Draft costs waiting to be posted to QuickBooks show here.</Empty>;
  return <><Tile label="Unposted costs" big={isSmall(metrics)} value={wholeCents(total)} detail={`${rows.length} projects · not in QuickBooks yet`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map(project => ({ key: project.id, label: project.name, value: centsNumber(project.draftCostCents) ?? 0 }))} />}</>;
}

function Budgets({ data, metrics }: WidgetContext) {
  const { organization, projects, gate } = useProjectList(data);
  if (gate) return gate;
  const open = openProjects(projects) ?? [];
  const rows: Row[] = open.map(project => ({ id: project.id, project, name: project.name, property: propertyNameFor(data, organization, project.propertyId), status: PROJECT_STATUS_LABEL[project.status], budget: project.approvedBudgetCents, spent: project.postedActualCents, left: project.approvedBudgetCents !== null && project.postedActualCents !== null ? String(BigInt(project.approvedBudgetCents) - BigInt(project.postedActualCents)) : null }));
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} empty="No open projects." columns={[
    { key: "name", label: "Project", render: row => <span className="rops-cell-stack"><button type="button" className="rops-link" onClick={openProject(data, row.project as ProjectSummary)}>{String(row.name)}</button><small>{String(row.property)} · {String(row.status)}</small></span> },
    { key: "budget", label: "Budget", number: true, render: row => wholeCents(row.budget as string | null) },
    { key: "spent", label: "Spent", number: true, render: row => wholeCents(row.spent as string | null) },
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
