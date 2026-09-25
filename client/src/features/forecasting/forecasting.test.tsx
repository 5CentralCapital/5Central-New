import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { forecastAssumptionsSchema } from "../../../../shared/forecasting/assumptions";
import type { ForecastResultView } from "../../../../shared/forecasting/result";
import { runForecast } from "../../../../server/forecasting/engine";
import { explainForecastLine } from "../../../../server/forecasting/explain";
import { readFileSync } from "node:fs";
import { syntheticEngineInput, syntheticForecastAssumptionsInput } from "../../../../server/forecasting/testing/fixture";
import { getPath, sectionSpecs, setPath } from "./assumptions-editor";
import { niceScale } from "./charts";
import { inputSummary } from "./drilldown";
import { bpsToPercentInput, bpsToPercentText, chartDollars, dscr, moneyWhole, nextMonday, percentInputToBps, periodLabel } from "./format";
import { forecastingParams, forecastingRoutePatch, parseForecastingParams } from "./params";
import { approvalBlocker, defaultComparison, defaultScenario, snapshotIsCurrent } from "./scenarios";
import { BalanceView, CashView, DebtView, IncomeView, balanceComposition } from "./views";
import { FORECAST_MODEL_VERSION } from "../../../../shared/forecasting/result";

function view(): ForecastResultView {
  const { events: _events, ...rest } = runForecast(syntheticEngineInput(draft => {
    draft.sales = [{ id: "sell-a", label: "Sell Example Court", propertyId: "prop-a", closeOn: "2028-06-01", priceCents: "110000000", sellingCostsCents: "3300000", payoffLoanIds: ["loan-a"], transferDeposits: true }];
  }));
  return rest;
}

test("formatting keeps money exact and parses percentages without floats", () => {
  assert.equal(moneyWhole("123456789"), "$1,234,568");
  assert.equal(moneyWhole("-150"), "−$2");
  assert.equal(moneyWhole(null), "Unknown");
  assert.equal(chartDollars("-12345"), -123.45);
  assert.equal(percentInputToBps("3.25"), 325);
  assert.equal(percentInputToBps("100"), 10_000);
  assert.throws(() => percentInputToBps("3.255"));
  assert.equal(bpsToPercentInput(325), "3.25");
  assert.equal(bpsToPercentText(9_650), "96.5%");
  assert.equal(dscr(12_500), "1.25x");
  assert.equal(periodLabel("M:2027-01"), "Jan 2027");
  assert.equal(new Date(`${nextMonday(new Date(2026, 8, 23))}T12:00:00Z`).getUTCDay(), 1);
});

test("context parameters round-trip and reject malformed values", () => {
  const scenario = "11111111-1111-4111-8111-111111111111";
  const parsed = parseForecastingParams(new URLSearchParams(`section=forecasting&scenario=${scenario}&property=demo-property-a&tab=debt`));
  assert.deepEqual(parsed, { tab: "debt", scenarioId: scenario, propertyId: "demo-property-a" });
  assert.deepEqual(parseForecastingParams(new URLSearchParams("scenario=not-a-uuid&tab=wat")), { tab: "cash" });
  const params = forecastingParams({ tab: "income", scenarioId: scenario }, new URLSearchParams("view=reporting&tab=x"));
  assert.equal(params.get("section"), "forecasting");
  assert.equal(params.get("tab"), "income");
  assert.equal(params.get("view"), "reporting");
  assert.equal(forecastingParams({ tab: "cash" }).has("tab"), false);
});

test("chart scales include zero and cover the data with round ticks", () => {
  const scale = niceScale([1_250, 98_400, -3_000], 10, 210);
  assert.ok(scale.min <= -3_000 && scale.max >= 98_400);
  assert.ok(scale.ticks.includes(0));
  assert.equal(scale.y(scale.min), 210);
  assert.equal(scale.y(scale.max), 10);
});

test("every workspace view renders a real engine result with drillable cells", () => {
  const result = view();
  const drills: string[] = [];
  const onDrill = (line: string, period: string) => { drills.push(`${line}@${period}`); };
  for (const [name, element] of [["cash", <CashView result={result} onDrill={onDrill} />], ["income", <IncomeView result={result} onDrill={onDrill} />], ["balance", <BalanceView result={result} onDrill={onDrill} />], ["debt", <DebtView result={result} onDrill={onDrill} />]] as const) {
    const html = renderToStaticMarkup(element);
    assert.ok(html.includes("fc-cell") || name === "debt", `${name} has drill cells`);
    assert.ok(html.includes("<svg"), `${name} renders a chart`);
    assert.ok(!/R-ops|Rent Ops|Rent Operations/.test(html), `${name} uses current branding`);
    assert.ok(!html.includes("NaN"), `${name} has no NaN`);
  }
  const cash = renderToStaticMarkup(<CashView result={result} onDrill={onDrill} />);
  assert.match(cash, /Reserve floor/);
  assert.match(cash, /Owner planning \(not in company statements\)/);
  const debt = renderToStaticMarkup(<DebtView result={result} onDrill={onDrill} />);
  assert.match(debt, /Modeled/);
  assert.match(debt, /Maturity ladder/);
});

test("scenario defaults prefer an approved base and compare base, downside and upside", () => {
  const snapshot = { id: "22222222-2222-4222-8222-222222222222" } as never;
  const make = (id: string, kind: string, state = "draft", latest: unknown = snapshot) => ({ id, kind, state, latestSnapshot: latest }) as never;
  const scenarios = [make("a", "custom"), make("b", "base"), make("c", "base", "approved"), make("d", "downside"), make("e", "upside"), make("f", "base", "archived")];
  assert.equal(defaultScenario(scenarios)?.id, "c");
  assert.deepEqual(defaultComparison(scenarios), ["b", "d", "e"]);
  assert.deepEqual(defaultComparison([make("x", "custom"), make("y", "custom", "draft", null)]), ["x"]);
});

test("editor templates create valid rows and nested paths edit immutably", () => {
  const document = syntheticForecastAssumptionsInput() as Record<string, unknown>;
  for (const spec of sectionSpecs(document)) {
    const rows = (document[spec.key] as Record<string, unknown>[] | undefined) ?? [];
    document[spec.key] = [...rows, spec.template(document, rows.length + 100)];
  }
  // Templated refinances/sales/time need their references to exist; they do in the synthetic document.
  const parsed = forecastAssumptionsSchema.safeParse(document);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
  const row = { id: "x", newLoan: { id: "n", annualRateBps: 1 } };
  const changed = setPath(row, "newLoan.annualRateBps", 600);
  assert.equal(getPath(changed, "newLoan.annualRateBps"), 600);
  assert.equal(getPath(row, "newLoan.annualRateBps"), 1, "original untouched");
  assert.deepEqual(setPath({ fixedAsset: { usefulLifeMonths: 1 } }, "fixedAsset.usefulLifeMonths", undefined), {}, "empty optional group is removed");
  assert.deepEqual(inputSummary({ amountCents: "12345", firstOn: "2027-01-15", annualRateBps: 650 }).map(([label]) => label), ["Amount", "Rate", "First date"]);
});

test("unknown opening cash is labelled relative and never shown as zero-based liquidity", () => {
  const input = syntheticEngineInput();
  const { events: _events, ...result } = runForecast({ ...input, sources: { ...input.sources, items: input.sources.items.map(item => item.key === "cash_operating" ? { ...item, amountCents: null, asOf: null, state: "unknown" as const, sourceIds: [] } : item) } });
  const cash = renderToStaticMarkup(<CashView result={result} onDrill={() => {}} />);
  assert.match(cash, /Closing \(relative\)/);
  assert.match(cash, /Available \(relative\)/);
  assert.match(cash, /Relative to unknown opening cash/);
  assert.match(cash, /Net change, 13 weeks/);
  assert.doesNotMatch(cash, /Reserve floor/, "the floor line is not drawn against relative balances");
  assert.doesNotMatch(cash, /Below floor/);
  assert.match(cash, /Weeks below floor<\/dt><dd>Unknown/);
  const balance = renderToStaticMarkup(<BalanceView result={result} onDrill={() => {}} />);
  assert.match(balance, /Operating cash \(relative\)/);
  assert.match(balance, /Cash balances are relative to unknown opening cash/);
  const known = renderToStaticMarkup(<CashView result={view()} onDrill={() => {}} />);
  assert.doesNotMatch(known, /\(relative\)/);
});

test("balance composition segments drill into lines that explain exactly the figure shown", () => {
  const full = runForecast(syntheticEngineInput());
  const assumptions = forecastAssumptionsSchema.parse(syntheticForecastAssumptionsInput());
  const month = full.months[5]!;
  const { assets, claims } = balanceComposition(month);
  for (const part of [...assets, ...claims]) {
    const explained = explainForecastLine(full, assumptions, { line: `bs.${part.key}`, period: month.key, limit: 500 });
    assert.equal(explained.totalCents, part.cents, part.label);
  }
});

test("a loan past maturity shows as overdue, not in a past year", () => {
  const { events: _events, ...result } = runForecast(syntheticEngineInput(draft => {
    draft.loans![0] = { ...draft.loans![0]!, firstPaymentOn: "2024-01-01", maturityOn: "2026-12-01" };
  }));
  const debt = renderToStaticMarkup(<DebtView result={result} onDrill={() => {}} />);
  assert.match(debt, />Overdue</);
  assert.match(debt, /Past maturity/);
});

test("a company switch is one route update and tab changes keep their history mode", () => {
  const scenario = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(forecastingRoutePatch({ tab: "debt", scenarioId: scenario }), { forecastTab: "debt", scenarioId: scenario });
  assert.deepEqual(forecastingRoutePatch({ tab: "debt", scenarioId: scenario }, { organizationId: "org-2", replace: false }), { forecastTab: "debt", scenarioId: undefined, organizationId: "org-2", recordId: undefined });
  // Applying the patch once to the current route changes the company and tab together.
  const route = { section: "forecasting", organizationId: "org-1", forecastTab: "cash", scenarioId: scenario, recordId: "x" };
  assert.deepEqual({ ...route, ...forecastingRoutePatch({ tab: "income" }, { organizationId: "org-2" }) }, { section: "forecasting", organizationId: "org-2", forecastTab: "income", scenarioId: undefined, recordId: undefined });
  const mount = readFileSync(new URL("../workspaces/lane-mounts.tsx", import.meta.url), "utf8");
  assert.match(mount, /onLocationChange\(forecastingRoutePatch\(next, options\), options\.replace \?\? false\)/);
  assert.doesNotMatch(mount, /onOrganizationChange/);
});

test("stale snapshots are not approvable or used as the current run; override removal asks for a reason", () => {
  const hash = "a".repeat(64);
  const scenario = { currentAssumptionVersion: 2, parametersSha256: hash };
  const snapshot = { assumptionVersion: 2, parametersSha256: hash, modelVersion: FORECAST_MODEL_VERSION };
  assert.equal(snapshotIsCurrent(scenario, snapshot), true);
  assert.equal(snapshotIsCurrent(scenario, { ...snapshot, parametersSha256: "b".repeat(64) }), false);
  assert.equal(snapshotIsCurrent(scenario, { ...snapshot, modelVersion: "fcst-0" }), false);
  const summary = { ...scenario, latestSnapshot: { ...snapshot, checksPassed: true } } as never;
  assert.equal(approvalBlocker(summary), undefined);
  assert.equal(approvalBlocker({ ...scenario, latestSnapshot: { ...snapshot, parametersSha256: "b".repeat(64), checksPassed: true } } as never), "Scenario settings changed. Save a new snapshot first.");
  const editor = readFileSync(new URL("./assumptions-editor.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(editor, /void save\(/, "saves are awaited so failures are shown");
  assert.doesNotMatch(editor, /Removed from the assumptions page/, "removal reasons come from the user");
  assert.match(editor, /kind: "remove"/);
});
