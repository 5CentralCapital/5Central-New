import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { forecastAssumptionsSchema } from "../../../../shared/forecasting/assumptions";
import type { ForecastResultView } from "../../../../shared/forecasting/result";
import { runForecast } from "../../../../server/forecasting/engine";
import { syntheticEngineInput, syntheticForecastAssumptionsInput } from "../../../../server/forecasting/testing/fixture";
import { getPath, sectionSpecs, setPath } from "./assumptions-editor";
import { niceScale } from "./charts";
import { inputSummary } from "./drilldown";
import { bpsToPercentInput, bpsToPercentText, chartDollars, dscr, moneyWhole, nextMonday, percentInputToBps, periodLabel } from "./format";
import { forecastingParams, parseForecastingParams } from "./params";
import { defaultComparison, defaultScenario } from "./scenarios";
import { BalanceView, CashView, DebtView, IncomeView } from "./views";

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
    assert.ok(!/5Central Ops|5Central Ops|5Central Ops/.test(html), `${name} uses current branding`);
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
