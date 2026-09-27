import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectSummary } from "@shared/projects";
import type { DashboardData, WidgetMetrics } from "./dashboard-kit";
import {
  ForecastGate,
  forecastWeeksFrom,
  obligationTotals,
  openProject,
  postedSpendLabel,
  propertyLines,
  remainingObligationCents,
  spentShare,
  OVERVIEW_WIDGETS,
} from "./dashboard-widgets-overview";
import { PROJECT_WIDGETS } from "./dashboard-widgets-projects";
import type { ForecastResultView } from "@shared/forecasting/result";

// These widgets use the classic JSX runtime when the node test runner loads them.
(globalThis as { React?: typeof React }).React = React;

const AS_OF = "2026-09-26";
const ORG = "org-audit";
const IDENTITY = "dashboard-audit-user";
const metrics: WidgetMetrics = { size: "M", w: 4, h: 4, bodyWidth: 364, bodyHeight: 270 };

type ProjectMoneyOverrides = {
  approvedBudgetCents?: string | null;
  postedActualCents?: string | null;
  postedActualCoverage?: ProjectSummary["postedActualCoverage"];
};

function project(overrides: ProjectMoneyOverrides = {}): ProjectSummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    organizationId: ORG,
    legalEntityId: "00000000-0000-4000-8000-000000000002" as ProjectSummary["legalEntityId"],
    propertyId: "00000000-0000-4000-8000-000000000003" as ProjectSummary["propertyId"],
    unitId: null,
    name: "Synthetic rehab",
    projectType: "rehab",
    description: null,
    status: "active",
    currency: "USD",
    startOn: null,
    targetOn: null,
    recordRevision: 1,
    updatedAt: "2026-09-25T12:00:00.000Z",
    archivedAt: null,
    scopeItemCount: 0,
    taskCount: 0,
    approvedBudgetCents: null,
    draftCostCents: "2500",
    postedActualCents: null,
    postedActualCoverage: "unavailable",
    ...overrides,
  } as unknown as ProjectSummary;
}

function dashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    snapshot: { snapshot: { properties: [] } } as unknown as DashboardData["snapshot"],
    filters: { asOfDate: AS_OF, search: "", status: "all", propertyScope: "active", propertyId: "all" } as unknown as DashboardData["filters"],
    identity: IDENTITY,
    year: 2026,
    monthLabel: "Sep 2026",
    kpis: [],
    attention: [],
    onOpenApplication: () => {},
    trends: { loading: false, retry: () => {}, metric: "occupancy", setMetric: () => {} },
    cash: { fetching: false, refetch: () => {} },
    banking: { loading: false, refetch: () => {} },
    onReport: () => {},
    ...overrides,
  } as DashboardData;
}

function renderProjectWidget(id: string, projects: readonly ProjectSummary[], readyDeals: readonly ProjectSummary[] = []): string {
  const widget = [...PROJECT_WIDGETS, ...OVERVIEW_WIDGETS].find(entry => entry.id === id);
  assert.ok(widget, `widget ${id} exists`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["rent-ops-workspace", "company-context", IDENTITY], {
    organizations: [{ id: ORG, name: "Audit company", role: "owner", entities: [] }],
  });
  client.setQueryData(["rent-ops-workspace", "dashboard-projects", IDENTITY, ORG], projects);
  for (const entry of readyDeals) {
    client.setQueryData(["rent-ops-workspace", "dashboard-deal", IDENTITY, ORG, entry.id, entry.recordRevision, AS_OF], {
      coverage: { status: "complete" },
      saleForecast: { profitState: "complete", projectedProfitCents: "10000", saleOn: null },
    });
  }
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{widget.render({ data: dashboardData({ organizationId: ORG }), metrics })}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

test("project actual coverage never becomes an exact share or an exact dollar label", () => {
  const partial = project({ approvedBudgetCents: "10000", postedActualCents: "5000", postedActualCoverage: "partial" });
  assert.equal(spentShare(partial), undefined);
  assert.equal(postedSpendLabel(partial), "≥ $50");
  const unavailable = project({ approvedBudgetCents: "10000", postedActualCents: null, postedActualCoverage: "unavailable" });
  assert.equal(postedSpendLabel(unavailable), "Unknown");
});

test("open-project widgets exclude completed flips from counts, currency, and report coverage", () => {
  const active = { ...project(), projectType: "flip", name: "Active synthetic flip" } as ProjectSummary;
  const completed = { ...active, id: "00000000-0000-4000-8000-000000000004", name: "Completed synthetic flip", status: "completed", currency: "EUR" } as ProjectSummary;
  const totals = renderProjectWidget("proj-kpis", [completed, active], [active]);
  assert.match(totals, /Projected flip profit.*\$100/);
  assert.match(totals, /1 flip</);
  assert.doesNotMatch(totals, /2 flips|Multiple currencies|some not forecast/);
  const board = renderProjectWidget("proj-board", [completed, active], [active]);
  assert.match(board, /Active synthetic flip/);
  assert.match(board, /\$100/);
  assert.doesNotMatch(board, /Completed synthetic flip|Loading deal reports|Some flip reports could not be read/);
});

test("completed flips cannot consume the open-project report limit", () => {
  const active = { ...project(), projectType: "flip", name: "Active synthetic flip" } as ProjectSummary;
  const completed = Array.from({ length: 11 }, (_, index) => ({ ...active, id: `completed-${index}`, status: "completed" } as ProjectSummary));
  const totals = renderProjectWidget("proj-kpis", [...completed, active], [active]);
  assert.match(totals, /Projected flip profit.*\$100/);
  assert.match(totals, /1 flip</);
  const board = renderProjectWidget("proj-board", [...completed, active], [active]);
  assert.match(board, /Active synthetic flip/);
  assert.match(board, /\$100/);
  assert.doesNotMatch(board, /Loading deal reports|Some flip reports could not be read/);
});

test("project budget widgets keep missing budgets and spend unknown", () => {
  const byType = renderProjectWidget("proj-by-type", [project()]);
  assert.match(byType, /No approved budget/);
  assert.doesNotMatch(byType, /\$0 budget/);

  const totalsId = [...PROJECT_WIDGETS, ...OVERVIEW_WIDGETS].find(entry => entry.name === "Project totals")?.id;
  assert.ok(totalsId, "project totals widget exists");
  const totals = renderProjectWidget(totalsId, [project()]);
  assert.match(totals, /Approved budgets.*Unknown/);
  assert.match(totals, /Posted spend.*Not linked/);
  assert.doesNotMatch(totals, /Approved budgets.*\$0/);
});

test("budget table marks partial spend as a lower bound and leaves Left unknown", () => {
  const markup = renderProjectWidget("proj-budgets", [project({ approvedBudgetCents: "10000", postedActualCents: "5000", postedActualCoverage: "partial" })]);
  assert.match(markup, /≥ \$50/);
  assert.match(markup, /<button[^>]*>Left<\/button>/);
  assert.match(markup, /<td[^>]*><span>—<\/span><\/td>/);
});

test("property balances use the full delinquency read so unknown rows do not become zero", () => {
  const lines = propertyLines(dashboardData({
    propertyRows: [{ propertyId: "p1", propertyName: "Sun Cove", unitCount: 1, occupied: 1, rent: 100000, rentUnknown: 0 }],
    dueRows: [{ propertyId: "p1", propertyName: "Sun Cove", operationalBalanceCents: null }],
    knownDue: [],
  }))!;
  assert.equal(lines[0]!.dueCents, null);
  assert.equal(lines[0]!.dueCount, 0);
});

test("project navigation preserves the selected organization", () => {
  const calls: unknown[][] = [];
  const data = dashboardData({ onOpenCompany: (...args) => calls.push(args) });
  openProject(data, { id: "project-1" }, "organization-2")!();
  assert.deepEqual(calls, [["projects", "organization-2", { projectTab: "overview", recordId: "project-1" }]]);
});

test("expired forecast weeks are not relabeled as current", () => {
  const result = {
    weeks: [{ key: "w1", start: "2026-08-01", end: "2026-08-07" }],
  } as unknown as ForecastResultView;
  assert.deepEqual(forecastWeeksFrom(result, AS_OF), []);
  assert.equal(forecastWeeksFrom(result, "2026-08-03").length, 1);
});

test("cash forecast without an approved base states the source requirement", () => {
  const forecast = {
    loading: false,
    none: true,
    list: { error: undefined, refetch: () => {} },
    run: { error: undefined, refetch: () => {} },
    result: undefined,
  } as never;
  const markup = renderToStaticMarkup(<ForecastGate forecast={forecast}>{() => <span>result</span>}</ForecastGate>);
  assert.match(markup, /No approved base forecast/);
  assert.doesNotMatch(markup, /No cash forecast yet/);
});

test("obligation totals subtract posted payments and stay incomplete when truncated", () => {
  const item = { expectedCents: "10000", knownMinimumCents: "10000", paidCents: "2500" } as const;
  assert.equal(remainingObligationCents(item), "7500");
  assert.equal(remainingObligationCents({ ...item, paidCents: "12000" }), "0");
  assert.equal(remainingObligationCents({ ...item, expectedCents: null, knownMinimumCents: "9000" }), "6500");
  assert.equal(remainingObligationCents({ ...item, expectedCents: "12000", knownMinimumCents: "9000", amountComplete: false }), "6500");
  assert.equal(remainingObligationCents({ ...item, paidCents: "unknown" }), null);
  const complete = obligationTotals([item as never]);
  assert.deepEqual(complete, { total: "7500", complete: true });
  const truncated = obligationTotals([item as never], true);
  assert.deepEqual(truncated, { total: "7500", complete: false });
  assert.deepEqual(obligationTotals([{ ...item, currency: "USD" } as never, { ...item, currency: "EUR" } as never]), { total: null, complete: false });
});
