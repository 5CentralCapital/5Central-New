import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSummary } from "@shared/projects";
import type { ProjectDealCostReport } from "@shared/projects/deal-costs";
import type { ForecastResultView } from "@shared/forecasting/result";
import { AxisChart } from "./dashboard-kit";
import { ForecastGate, balanceHistory, propertyStatus, rehabSpentCents } from "./dashboard-widgets-overview";
(globalThis as { React?: typeof React }).React = React;

test("unknown past due never makes a property look on track", () => {
  assert.deepEqual(propertyStatus({ occupancyShare: 0.95, dueCents: null, rentCents: 500000 }), { tone: "flat", label: "Review" });
  assert.deepEqual(propertyStatus({ occupancyShare: 0.5, dueCents: null, rentCents: 500000 }), { tone: "risk", label: "At risk" });
  assert.deepEqual(propertyStatus({ occupancyShare: 0.95, dueCents: 0, rentCents: 500000 }), { tone: "ok", label: "On track" });
  assert.equal(propertyStatus({ occupancyShare: null, dueCents: 0, rentCents: 500000 }), undefined);
});

test("rehab spend from a partially reconciled lane is a lower bound", () => {
  const project = { postedActualCoverage: "unavailable", postedActualCents: null, approvedBudgetCents: "5500000" } as unknown as ProjectSummary;
  const deal = (coverage: string) => ({ byLane: [{ lane: "rehab", budgetCents: "5500000", incurredCents: "1000000", coverage }] }) as unknown as ProjectDealCostReport;
  assert.deepEqual(rehabSpentCents(project, deal("partial")), { cents: "1000000", source: "deal", partial: true });
  assert.deepEqual(rehabSpentCents(project, deal("complete")), { cents: "1000000", source: "deal", partial: false });
  assert.deepEqual(rehabSpentCents(project, undefined), { cents: null, source: "none", partial: false });
});

test("a draft forecast is labelled for every widget that renders through the gate", () => {
  const result = { weeks: [{ start: "2026-09-21", end: "2026-09-27" }] } as unknown as ForecastResultView;
  const forecast = { loading: false, none: false, list: {}, run: {}, result, asOfDate: "2026-09-26", isDraft: true, scenario: { name: "Base draft" } } as never;
  const drafted = renderToStaticMarkup(<ForecastGate forecast={forecast}>{() => <span>body</span>}</ForecastGate>);
  assert.match(drafted, /Draft plan · Base draft[\s\S]*body/);
  const selfLabelled = renderToStaticMarkup(<ForecastGate forecast={forecast} labelsDraft>{() => <span>body</span>}</ForecastGate>);
  assert.doesNotMatch(selfLabelled, /Draft plan/);
  const approved = renderToStaticMarkup(<ForecastGate forecast={{ ...(forecast as object), isDraft: false } as never}>{() => <span>body</span>}</ForecastGate>);
  assert.doesNotMatch(approved, /Draft plan/);
});

test("balance history walks back only the transactions it is given", () => {
  const history = balanceHistory(100000, [
    { id: "a", accountId: "op", date: "2026-09-26", amountCents: 25000, pending: false, description: "out" },
    { id: "b", accountId: "op", date: "2026-09-25", amountCents: -10000, pending: false, description: "in" },
    { id: "c", accountId: "op", date: "2026-09-26", amountCents: 99999, pending: true, description: "pending" },
  ], "2026-09-24", "2026-09-26");
  assert.deepEqual(history, [{ date: "2026-09-24", cents: 115000 }, { date: "2026-09-25", cents: 125000 }, { date: "2026-09-26", cents: 100000 }]);
});

test("axis ticks stay inside the chart when the maximum is not a whole step", () => {
  const markup = renderToStaticMarkup(<AxisChart width={300} height={120} points={[{ label: "Jan", value: 40 }, { label: "Feb", value: 45 }]} yMin={0} yMax={50} ticks={3} />);
  const labels = Array.from(markup.matchAll(/class="ops-chart-label"[^>]*text-anchor="end"[^>]*>(\d+)</g)).map(match => Number(match[1]));
  assert.ok(labels.length >= 2, markup.slice(0, 400));
  assert.ok(Math.max(...labels) <= 60 && Math.max(...labels) >= 50, String(labels));
});
