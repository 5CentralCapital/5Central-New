import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardData } from "./dashboard-kit";
import assert from "node:assert/strict";
import type { DashboardReport } from "../../accounting/dashboard-model";
import type { QboEntity } from "./dashboard-sources";
import { financialTotal, financialTotalText } from "./dashboard-widgets-quickbooks";
import { addExactCents, annualRatePercent, paymentLowerBoundCents } from "./dashboard-widgets-accounting";
import { CASH_WIDGETS, addForecastCents, cashTotal, isCashAccountType, pendingNetCents } from "./dashboard-widgets-cash";

const report = (cents: string): DashboardReport => ({
  generatedAt: "2026-09-26T12:00:00.000Z",
  page: {
    runId: "run-1", snapshotId: "snapshot-1", totalRows: 1, rowCount: 1, nextCursor: null,
    rows: [{ rowId: "income", label: "Income", values: { providerGroup: "Income", rowKind: "summary", providerTotalCents: cents, totalCents: cents } }],
    coverage: [{ source: "quickbooks_online_reports", state: "complete", evidence: "synthetic" }],
    missingData: [],
  },
} as unknown as DashboardReport);

const entity = (id: string, currency = "USD", available = true): QboEntity => ({
  available, name: id, currency,
  scope: { organizationId: "org-1", legalEntityId: id, environment: "production", realmId: `realm-${id}` },
  health: {} as QboEntity["health"],
});

test("QBO aggregates keep unavailable and mixed-currency figures explicit", () => {
  const unavailable = financialTotal([
    { entity: entity("e1", "USD", false), report: undefined, loading: false, error: undefined },
    { entity: entity("e2", "USD", false), report: undefined, loading: false, error: undefined },
  ], "Income");
  assert.equal(unavailable.known, 0);
  assert.equal(financialTotalText(unavailable), "Unavailable");

  const partial = financialTotal([
    { entity: entity("e1"), report: report("125000"), loading: false, error: undefined },
    { entity: entity("e2", "USD", false), report: undefined, loading: false, error: undefined },
  ], "Income");
  assert.equal(partial.complete, false);
  assert.equal(financialTotalText(partial), "Unknown");

  const mixed = financialTotal([
    { entity: entity("e1", "USD"), report: report("125000"), loading: false, error: undefined },
    { entity: entity("e2", "EUR"), report: report("125000"), loading: false, error: undefined },
  ], "Income");
  assert.equal(mixed.currencyMismatch, true);
  assert.equal(financialTotalText(mixed), "Multiple currencies");
});

test("cash totals use available deposit balances and exclude debt accounts", () => {
  assert.equal(isCashAccountType("depository"), true);
  assert.equal(isCashAccountType("credit"), false);
  assert.equal(isCashAccountType("loan"), false);
  const total = cashTotal([
    { type: "depository", currency: "USD", availableCents: 1000, balancesState: "ready" },
    { type: "credit", currency: "USD", availableCents: -5000, balancesState: "ready" },
    { type: "loan", currency: "USD", availableCents: -20000, balancesState: "ready" },
  ]);
  assert.equal(total.cashAccounts, 1);
  assert.equal(total.display, "$10");
  assert.equal(cashTotal([{ type: "depository", currency: "USD", availableCents: null, balancesState: "ready" }]).display, "Unknown");
  assert.equal(cashTotal([
    { type: "depository", currency: "USD", availableCents: 100, balancesState: "ready" },
    { type: "depository", currency: "EUR", availableCents: 100, balancesState: "ready" },
  ]).display, "Multiple currencies");
});

test("pending and investor unknown amounts never become zero", () => {
  assert.equal(pendingNetCents([-100, 50]), 50);
  assert.equal(pendingNetCents([-100, null]), null);
  assert.equal(addExactCents(undefined, "100"), "100");
  assert.equal(addExactCents("100", "50"), "150");
  assert.equal(addForecastCents(undefined, "100"), "100");
  assert.equal(addForecastCents("100", "50"), "150");
  assert.equal(paymentLowerBoundCents({ remainingCents: null, knownMinimumCents: "1000", recordedCents: "400" }), "600");
  assert.equal(paymentLowerBoundCents({ remainingCents: null, knownMinimumCents: "1000", recordedCents: "1400" }), "0");
  assert.equal(paymentLowerBoundCents({ remainingCents: "-1", knownMinimumCents: "1000", recordedCents: "0" }), "0");
});

test("debt annual rates are rendered from decimal fractions", () => {
  assert.equal(annualRatePercent("0.115"), "11.5");
  assert.equal(annualRatePercent("0.12"), "12");
  assert.equal(annualRatePercent("1"), "100");
  assert.equal(annualRatePercent("not-a-rate"), null);
});


test("monthly remittance and forecast aggregations initialize once and retain uncertainty", () => {
  for (const add of [addExactCents, addForecastCents]) {
    assert.equal(add(undefined, "150"), "150");
    assert.equal(add("150", "-50"), "100");
    assert.equal(add(null, "150"), null);
    assert.equal(add("150", null), null);
    assert.equal(add("900719925474099300", "50"), "900719925474099350");
  }
});


test("received cash excludes pending deposits and shows unknown posted amounts", () => {
  (globalThis as { React?: typeof React }).React = React;
  const data = {banking:{data:{state:"ready",fromDate:"2026-09-01",throughDate:"2026-09-26",connections:[{accounts:[],transactions:[
    {id:"posted",amountCents:-10000,currency:"USD",pending:false},
    {id:"pending",amountCents:-990000,currency:"USD",pending:true},
  ]}]}}} as unknown as DashboardData;
  const render = () => renderToStaticMarkup(<>{CASH_WIDGETS.find(item => item.id === "bank-inflows")!.render({data,metrics:{size:"S",w:2,h:2,bodyWidth:160,bodyHeight:130}})}</>);
  assert.match(render(), /\$100/);
  assert.doesNotMatch(render(), /\$10,000/);
  data.banking.data!.connections[0]!.transactions[0]!.amountCents = null;
  assert.match(render(), /Unknown/);
  assert.doesNotMatch(render(), /No deposits/);
});
