import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectorHealth } from "@shared/accounting/operations";
import { SIZES, emptyCells, fromPreset, overlaps, type WidgetSize } from "./dashboard-grid-model";
import { DASHBOARD_PRESETS, DEFAULT_DASHBOARD_PRESET } from "./dashboard-presets";
import { WIDGETS, WIDGET_CATEGORIES, shortCents, sumCents, widgetById, type DashboardData, type WidgetMetrics } from "./dashboard-widgets";
import { qboEntities } from "./dashboard-sources";
import { propertyLines } from "./dashboard-widgets-overview";

// Shared components compiled with the classic JSX runtime expect a global React under tsx.
(globalThis as { React?: typeof React }).React = React;

const ASOF = "2026-09-26", ORG = "org-1", IDENTITY = "user-1";

function sampleData(overrides: Partial<DashboardData> = {}): DashboardData {
  const rentRoll = [
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u1", unitNumber: "A1", occupancy: "current", currentPersonId: "t1", currentTenantName: "Ann Lee", baseRentCents: 150000, marketRentCents: 165000, operationalBalanceCents: 0, readiness: "ready", listing: "not_listed" },
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u2", unitNumber: "A2", occupancy: "vacant", marketRentCents: 155000, readiness: "turn_needed", listing: "listed" },
    { propertyId: "p2", propertyName: "Lucia", unitId: "u3", unitNumber: "669-1", occupancy: "current", currentPersonId: "t2", currentTenantName: "Bo Diaz", baseRentCents: 120000, marketRentCents: 122500, operationalBalanceCents: -5000 },
    { propertyId: "p2", propertyName: "Lucia", unitId: "u4", unitNumber: "669-2", occupancy: "future_preleased", futureTenantName: "Cy Moe", marketRentCents: 122500 },
  ];
  const due = [
    { propertyId: "p1", propertyName: "Sun Cove", unitNumber: "A1", tenantName: "Ann Lee", personId: "t1", operationalBalanceCents: 175000, oldestUnpaidRentOn: "2026-07-01" },
    { propertyId: "p2", propertyName: "Lucia", unitNumber: "669-1", tenantName: "Bo Diaz", personId: "t2", operationalBalanceCents: null, totalBalanceCents: 43079 },
  ];
  return {
    snapshot: { snapshot: { properties: [{ id: "p1", name: "Sun Cove" }, { id: "p2", name: "Lucia" }], units: [{ id: "u1", bedrooms: 2 }, { id: "u2", bedrooms: 2 }, { id: "u3", bedrooms: 1 }, { id: "u4" }] } } as unknown as DashboardData["snapshot"],
    filters: { asOfDate: ASOF, search: "", status: "all", propertyScope: "active", propertyId: "all" } as unknown as DashboardData["filters"],
    identity: IDENTITY, year: 2026, monthLabel: "Sep 2026",
    kpis: [{ key: "occupancy", label: "Occupancy", value: "50%", detail: "2 of 4", tone: "normal", share: 0.5 }, { key: "due", label: "Balances due", value: "$1,750.00", detail: "1 account", tone: "attention" }],
    attention: [], rentRoll, dueRows: due, knownDue: [due[0]!], unverifiedDue: 1, dueSplit: { knownCount: 1, knownCents: 175000, unverifiedCount: 1 } as DashboardData["dueSplit"],
    receipts: [{ propertyId: "p2", propertyName: "Lucia", personId: "t2", tenantName: "Bo Diaz", paymentOn: "2026-09-03", amountCents: 120000 }],
    vacancy: [{ ...rentRoll[1], daysVacant: 120 }, { ...rentRoll[3], daysVacant: null }], vacancySorted: [],
    propertyRows: [
      { propertyId: "p1", propertyName: "Sun Cove", unitCount: 2, occupied: 1, vacant: 1, unknown: 0, preleased: 0, rent: 150000, rentUnknown: 0 },
      { propertyId: "p2", propertyName: "Lucia", unitCount: 2, occupied: 1, vacant: 1, unknown: 0, preleased: 1, rent: 120000, rentUnknown: 0 },
    ],
    movements: [{ tenantName: "Ann Lee", propertyName: "Sun Cove", unitNumber: "A1", date: "2026-09-30", movement: "Move-out", state: "Upcoming" }],
    applications: [], onOpenApplication: () => {},
    trends: { data: undefined, loading: true, retry: () => {}, metric: "occupancy", setMetric: () => {} },
    cash: { data: { state: "ready", name: "General Operating", mask: "7772", availableCents: 7214486, currentCents: 7361588, checkedAt: "2026-09-26T12:00:00.000Z" } as unknown as DashboardData["cash"]["data"], fetching: false, refetch: () => {} },
    banking: { data: { state: "ready", fetchedAt: "2026-09-26T12:00:00.000Z", fromDate: "2026-09-16", throughDate: ASOF, connections: [{ id: "c1", name: "Chase", balancesState: "ready", transactionsLastSuccessfulUpdate: null, transactionsLastFailedUpdate: null, transactionsState: "ready", accounts: [{ id: "a1", name: "Operating", mask: "7772", type: "depository", currency: "USD", currentCents: 7361588, availableCents: 7214486 }], transactions: [{ id: "x1", accountId: "a1", date: "2026-09-20", description: "Zelle rent", amountCents: -150000, currency: "USD", pending: false }, { id: "x2", accountId: "a1", date: "2026-09-21", description: "Home Depot", amountCents: 32000, currency: "USD", pending: true }] }] }, loading: false, refetch: () => {} },
    onReport: () => {},
    organizationId: ORG,
    ...overrides,
  };
}

const health = (legalEntityId: string, environment: "sandbox" | "production", status: ConnectorHealth["connection"]["status"] = "active"): ConnectorHealth => ({
  scope: { organizationId: ORG, legalEntityId, environment, realmId: environment === "production" ? "123" : "456" }, legalEntityName: legalEntityId === "e1" ? "5Central Capital LLC" : "Lucia Apartments LLC", companyName: null,
  connection: { status, readEnabled: true, accessTokenExpiresAt: null, refreshTokenHardExpiresAt: null }, freshness: "current", lastSuccessfulSyncAt: "2026-09-26T11:00:00.000Z", lastChangeSyncAt: null, lastVerifiedFullReplayAt: null, lagSeconds: 60,
  coverage: { status: "complete", reason: null }, openSyncExceptions: 1, activeTombstones: 0, jobs: { queued: 0, running: 0, retry: 0, dead: 0, lastFailureCode: null }, lastWebhookAt: null, rateLimitedUntil: null,
}) as unknown as ConnectorHealth;

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["rent-ops-workspace", "company-context", IDENTITY], { organizations: [{ id: ORG, name: "5Central", role: "owner", entities: [{ id: "e1", name: "5Central Capital LLC", currency: "USD", properties: [{ id: "p1", name: "Sun Cove", units: [] }] }, { id: "e2", name: "Lucia Apartments LLC", currency: "USD", properties: [{ id: "p2", name: "Lucia", units: [] }] }] }] });
  const project = (id: string, name: string, projectType: string, status: string, budget: string | null, spent: string | null) => ({ id, organizationId: ORG, legalEntityId: "e1", propertyId: "p1", unitId: null, name, projectType, description: null, status, currency: "USD", startOn: "2026-08-01", targetOn: "2026-10-20", recordRevision: 3, updatedAt: "2026-09-20T00:00:00.000Z", archivedAt: null, scopeItemCount: 2, taskCount: 1, approvedBudgetCents: budget, draftCostCents: "25000", postedActualCents: spent, postedActualCoverage: "partial" });
  const projects = [project("pr1", "115th St flip", "flip", "active", "6000000", "4500000"), project("pr2", "Sun Cove rehab", "rehab", "planning", null, null)];
  client.setQueryData(["rent-ops-workspace", "dashboard-projects", IDENTITY, ORG], projects);
  client.setQueryData(["rent-ops-workspace", "dashboard-project", IDENTITY, ORG, "pr1", 3], { ...projects[0], scopeItems: [], budgetVersions: [], draftCosts: [], postedActuals: [], qboProjectIdentities: [], tasks: [{ id: "t1", projectId: "pr1", title: "Paint exterior", description: null, status: "blocked", startsOn: null, dueOn: "2026-09-28", completedOn: null, dependencyTaskIds: [], recordRevision: 1, updatedAt: "2026-09-20T00:00:00.000Z", archivedAt: null }] });
  client.setQueryData(["rent-ops-workspace", "dashboard-deal", IDENTITY, ORG, "pr1", 3, ASOF], { projectId: "pr1", currency: "USD", asOf: ASOF, costs: [], funding: [], saleForecast: { grossProceedsCents: "42500000", saleOn: "2026-11-15", sellingCostCents: "2500000", netSaleProceedsCents: "40000000", projectedProfitCents: "5200000", profitState: "complete" }, byLane: [], totals: { budgetCents: "30000000", incurredCents: "28000000", paidCents: null, prepaidCents: null, remainingForecastCents: "1000000", finalCostCents: "29000000" }, fundingTotals: [], coverage: {} });
  client.setQueryData(["rent-ops-workspace", "dashboard-company", IDENTITY, ORG, ASOF], {
    asOf: ASOF, obligations: { items: [{ obligationId: "o1", accountId: "i1", accountName: "Cameryn Worden", instrumentName: "Note A", dueOn: "2026-10-01", currency: "USD", expectedCents: "250000", knownMinimumCents: "250000", paidCents: "0", amountComplete: true }], truncated: false },
    maturities: [{ instrumentId: "m1", accountId: "l1", accountName: "Lima One", instrumentName: "Bridge loan", maturityOn: "2026-12-01", currency: "USD", outstandingPrincipalCents: "150000000", balloonCents: null }],
    reviewCases: { available: true, openCount: 3, topReasons: [{ reasonCode: "lease_missing", count: 2, highMaterialityCount: 1 }] },
    workDue: { items: [{ id: "w1", title: "Fix AC", propertyId: "p1", propertyName: "Sun Cove", unitId: null, unitNumber: "A1", priority: "high", status: "open", scheduledOn: "2026-09-27", reportedOn: "2026-09-20", overdue: false }], openCount: 1 },
  });
  client.setQueryData(["rent-ops-workspace", "dashboard-qbo-health", IDENTITY, ORG], { items: [health("e1", "production"), health("e2", "sandbox")], workers: { active: 1, lastSeenAt: "2026-09-26T11:00:00.000Z" }, generatedAt: "2026-09-26T12:00:00.000Z" });
  client.setQueryData(["rent-ops-workspace", "dashboard-debt", IDENTITY, ORG], { asOf: ASOF, items: [{ instrumentId: "m1", accountId: "l1", accountName: "Lima One", instrumentName: "Bridge loan", kind: "loan", legalEntityId: "e1", currency: "USD", maturityOn: "2026-12-01", monthsToMaturity: 2, annualRate: "11.5", balloonCents: "150000000", balloonSource: "documented", derivedOutstandingCents: "150000000", manualOutstandingCents: null, reconciliation: "matched" }] });
  const week = (key: string, start: string, end: string, net: string) => ({ key, start, end, openingCashCents: "7000000", inflowsCents: "2000000", outflowsCents: "-1500000", netCents: net, closingCashCents: "7500000", restrictedClosingCents: "0", availableClosingCents: "7500000", modeledInflowsCents: "0", belowReserveFloor: false, categories: { tenant_receipts: "2000000", debt_service: "-1200000", project_costs: "-300000" } });
  const scenario = { id: "s1", organizationId: ORG, name: "Base plan", kind: "base", state: "approved", baseScenarioId: null, startDate: "2026-09-21", horizonWeeks: 13, horizonMonths: 12, reserveFloorCents: "2000000", currency: "USD", currentAssumptionVersion: 2, recordRevision: 1, createdBy: "m", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
  client.setQueryData(["forecasting", "list", ORG], { items: [scenario], nextCursor: null });
  client.setQueryData(["rent-ops-workspace", "dashboard-forecast", ORG, "s1", 2], { kind: "preview", snapshot: null, assumptionVersion: 2, draft: false, resultSha256: "x", result: {
    modelVersion: "1", currency: "USD", scenario: { name: "Base plan", kind: "base", startDate: "2026-09-21", horizonWeeks: 13, horizonMonths: 12, reserveFloorCents: "2000000" }, actualsCutoff: "2026-09-25", calendarEnd: "2027-09-30", rounding: "half_even", completeness: "complete",
    opening: { asOf: ASOF, items: [], complete: true, unknown: [], balances: {} },
    weeks: [week("w1", "2026-09-21", "2026-09-27", "500000"), week("w2", "2026-09-28", "2026-10-04", "-250000"), week("w3", "2026-10-05", "2026-10-11", "1500000")],
    months: [{ key: "m1", month: "2026-10", start: "2026-10-01", end: "2026-10-31", income: {}, revenueCents: "4000000", operatingExpensesCents: "1500000", noiCents: "2500000", netIncomeCents: "900000", balance: {}, totalAssetsCents: "0", totalLiabilitiesCents: "0", totalEquityCents: "0", cashFlow: {}, operations: {} }],
    debt: { loans: [], coverage: [{ month: "2026-10", noiCents: "2500000", debtServiceCents: "1800000", dscrBps: 13888 }], ladder: [{ year: "2026", maturingCents: "150000000", scheduledPrincipalCents: "0" }] },
    capital: { refinances: [], sales: [] }, owner: null, checks: [], warnings: [],
    summary: { openingCashKnown: true, minAvailableCashCents: "6800000", minAvailableWeek: "w2", endingCashCents: "8750000", weeksBelowFloor: 0, totalNoiCents: "2500000", totalNetIncomeCents: "900000", eventCount: 10 },
  } });
  return client;
}

const metricsFor = (size: WidgetSize): WidgetMetrics => {
  const [w, h] = SIZES[size];
  return { size, w, h, bodyWidth: w * 100 - 36, bodyHeight: h * 100 - 70 };
};

function render(id: string, size: WidgetSize, data: DashboardData, client = seededClient()) {
  const widget = widgetById(id)!;
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{widget.render({ data, metrics: metricsFor(size) })}</QueryClientProvider>);
  } finally {
    // Queries built during render schedule garbage-collection timers; clear them so the runner can exit.
    client.clear();
  }
}

test("the suite has 75+ widgets with at least ten in every category the dashboard asks for", () => {
  assert.ok(WIDGETS.length >= 75, `${WIDGETS.length} widgets`);
  for (const category of ["rent", "units", "cash", "accounting", "qb", "projects"] as const) {
    const count = WIDGETS.filter(widget => widget.category === category).length;
    assert.ok(count >= 10, `${WIDGET_CATEGORIES[category]} has ${count}`);
  }
  assert.ok(WIDGETS.every(widget => WIDGET_CATEGORIES[widget.category]), "every widget is in a library tab");
});

test("every widget can be resized to at least two known sizes", () => {
  for (const widget of WIDGETS) {
    assert.ok(widget.sizes.length >= 2, `${widget.id} has one size`);
    for (const size of widget.sizes) assert.ok(SIZES[size], `${widget.id}: ${size}`);
    assert.ok(widget.name.trim() && widget.description.trim(), `${widget.id} is labelled`);
  }
});

test("the default layout is the Sept 24 mockup and every preset tiles", () => {
  assert.equal(DEFAULT_DASHBOARD_PRESET, "Command");
  assert.deepEqual(DASHBOARD_PRESETS.Command!.map(entry => entry.id), ["cash-card", "rent-summary", "rent-table", "qb-tiles", "milestones", "occ-trend", "cashflow-grid", "proj-kpis", "rehab-rings", "gantt", "proj-board"]);
  for (const [name, entries] of Object.entries(DASHBOARD_PRESETS)) {
    if (!entries) continue;
    const layout = fromPreset(entries, id => !!widgetById(id));
    assert.equal(layout.length, entries.length, `${name} keeps every widget`);
    assert.deepEqual(overlaps(layout), [], name);
    assert.equal(emptyCells(layout), 0, name);
  }
});

test("every widget renders at every size with live-shaped data", () => {
  const data = sampleData();
  for (const widget of WIDGETS) for (const size of widget.sizes) {
    const markup = render(widget.id, size, data);
    assert.ok(markup.length > 0, `${widget.id} at ${size}`);
    assert.doesNotMatch(markup, /NaN|undefined|\[object Object\]/, `${widget.id} at ${size}`);
  }
});

test("every widget renders while its data is still loading", () => {
  const data = sampleData({ rentRoll: undefined, dueRows: undefined, knownDue: undefined, dueSplit: undefined, receipts: undefined, vacancy: undefined, vacancySorted: undefined, propertyRows: undefined, movements: undefined, kpis: [], cash: { fetching: true, refetch: () => {} }, banking: { loading: true, refetch: () => {} } });
  const empty = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false, gcTime: Infinity } } });
  for (const widget of WIDGETS) assert.doesNotThrow(() => render(widget.id, widget.defaultSize, data, empty), widget.id);
  empty.clear();
});

test("company widgets show real figures from the company reads", () => {
  const data = sampleData();
  assert.match(render("proj-board", "F6", data), /115th St flip[\s\S]*\$52,000/);
  assert.match(render("proj-kpis", "W", data), /\$60,000\+?/);
  assert.match(render("cashflow-grid", "F6", data), /Tenant rent[\s\S]*Ending cash/);
  assert.match(render("milestones", "L", data), /Paint exterior[\s\S]*Cameryn Worden payment|Cameryn Worden payment[\s\S]*Paint exterior/);
  assert.match(render("debt-maturities", "L", data), /Bridge loan/);
  assert.match(render("qb-sync", "M", data), /5Central Capital LLC/);
});

test("unknown amounts never become zero", () => {
  assert.equal(sumCents(["100", null]), null);
  assert.equal(sumCents(["100", "-50"]), "50");
  assert.equal(shortCents(null), "—");
  assert.equal(shortCents("12500000"), "$125K");
  const lines = propertyLines(sampleData({ receipts: undefined }))!;
  assert.ok(lines.every(line => line.collectedCents === null), "no receipts read means collected is unknown");
});

test("QuickBooks entities prefer production and skip unreadable connections", () => {
  const entities = qboEntities([health("e1", "sandbox"), health("e1", "production"), health("e2", "production", "needs_reconnect")])!;
  assert.equal(entities.length, 1);
  assert.equal(entities[0]!.scope.environment, "production");
});
