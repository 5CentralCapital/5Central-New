import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { reportQueryFilters, reportQueryKey } from "./report-model";
import { widgetById, type DashboardData, type WidgetMetrics } from "./dashboard-widgets";
import type { ReportKey } from "../types";

// The dashboard widgets use the classic JSX runtime in the node test runner.
(globalThis as { React?: typeof React }).React = React;

const AS_OF = "2026-09-26";
const IDENTITY = "audit-user";
const filters = { propertyScope: "active", propertyId: "all", asOfDate: AS_OF, status: "all", search: "" } as DashboardData["filters"];

const metrics: WidgetMetrics = { size: "M", w: 4, h: 4, bodyWidth: 364, bodyHeight: 270 };

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    snapshot: {
      snapshot: {
        properties: [{ id: "p1", name: "Sun Cove" }],
        units: [{ id: "u1", propertyId: "p1", unitNumber: "A1", bedrooms: 2 }, { id: "u2", propertyId: "p1", unitNumber: "A2", bedrooms: 2 }],
      },
    } as unknown as DashboardData["snapshot"],
    filters,
    identity: IDENTITY,
    year: 2026,
    monthLabel: "Sep 2026",
    kpis: [],
    attention: [],
    rentRoll: [],
    dueRows: [],
    knownDue: [],
    unverifiedDue: 0,
    dueSplit: { knownCount: 0, knownCents: 0, unverifiedCount: 0 },
    receipts: [],
    vacancy: [],
    vacancySorted: [],
    propertyRows: [],
    movements: [],
    applications: [],
    onOpenApplication: () => {},
    trends: { loading: false, retry: () => {}, metric: "occupancy", setMetric: () => {} },
    cash: { fetching: false, refetch: () => {} },
    banking: { loading: false, refetch: () => {} },
    onReport: () => {},
    onOpenTenant: () => {},
    onOpenUnit: () => {},
    ...overrides,
  };
}

function renderWidget(id: string, input: DashboardData, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })): string {
  const widget = widgetById(id);
  assert.ok(widget, `widget ${id} exists`);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{widget.render({ data: input, metrics })}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

function seedReport(client: QueryClient, report: ReportKey, rows: readonly Record<string, unknown>[], month = AS_OF.slice(0, 7)): void {
  const query = reportQueryFilters({ ...filters, status: "all", search: "" }, report, { asOfDate: AS_OF, ...(report === "hap" || report === "scheduled-vs-collected" ? { month } : {}) });
  client.setQueryData(reportQueryKey(report, query, IDENTITY), rows);
}

test("listing state treats unlisted as not listed", () => {
  const rentRoll = [
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u1", unitNumber: "A1", occupancy: "vacant", listing: "unlisted", daysVacant: 10 },
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u2", unitNumber: "A2", occupancy: "vacant", listing: "listed", daysVacant: 10 },
  ];
  const markup = renderWidget("listings", data({ rentRoll, vacancy: rentRoll }));
  assert.match(markup, /Listed<strong>1<\/strong>/);
  assert.match(markup, /Not listed<strong>1<\/strong>/);
  assert.match(markup, /Sun Cove A1/);
});

test("rent totals stay lower bounds when a property has unknown occupied rent", () => {
  const markup = renderWidget("rent-by-property", data({ propertyRows: [
    { propertyId: "p1", propertyName: "Sun Cove", occupied: 2, rent: 100000, rentUnknown: 1 },
    { propertyId: "p2", propertyName: "Lucia", occupied: 1, rent: 120000, rentUnknown: 0 },
  ] }));
  assert.match(markup, /Rent roll ≥ \$2,200 a month/);
  assert.doesNotMatch(markup, /Rent roll \$2,200 a month/);
});

test("long vacancy loss does not convert missing market rent to zero", () => {
  const vacancy = [{ propertyId: "p1", propertyName: "Sun Cove", unitId: "u1", unitNumber: "A1", occupancy: "vacant", daysVacant: 120, marketRentCents: undefined }];
  const markup = renderWidget("long-vacancies", data({ vacancy }));
  assert.match(markup, /about Unknown of rent lost so far/);
  assert.doesNotMatch(markup, /about \$0 of rent lost so far/);
});

test("tenant count includes future replacement tenancies from current rows", () => {
  const rentRoll = [
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u1", unitNumber: "A1", occupancy: "current", currentPersonId: "person-current", futurePersonId: "person-next", baseRentCents: 150000 },
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u2", unitNumber: "A2", occupancy: "future_preleased", futurePersonId: "person-future", baseRentCents: 125000 },
  ];
  const markup = renderWidget("tenant-count", data({ rentRoll }));
  assert.match(markup, /Moving in<\/span><strong>2<\/strong>/);
});

test("deposit widget counts grouped unknown source amounts once", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seedReport(client, "security-deposit", [
    { propertyId: "p1", propertyName: "Sun Cove", unitNumber: "A1", tenantName: "Known Resident", totalHeldCents: 100000, unknownHeldCount: 0 },
    { propertyId: "p1", propertyName: "Sun Cove", unitNumber: "A2", tenantName: "Unknown Resident", totalHeldCents: null, unknownHeldCount: 2 },
  ]);
  const markup = renderWidget("security-deposits", data(), client);
  assert.match(markup, /≥ \$1,000/);
  assert.match(markup, /2 records unresolved/);
  assert.doesNotMatch(markup, /3 records unresolved/);
});

test("deposit widget does not turn an all-unknown liability into zero", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seedReport(client, "security-deposit", [{ propertyId: "p1", propertyName: "Sun Cove", unitNumber: "A2", tenantName: "Unknown Resident", totalHeldCents: null, unknownHeldCount: 2 }]);
  const markup = renderWidget("security-deposits", data(), client);
  assert.match(markup, />Unknown<\/strong>/);
  assert.doesNotMatch(markup, />≥ \$0<\/strong>/);
});

test("deposit widget with unknown timing is not treated as an exact held total", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seedReport(client, "security-deposit", [{ propertyId: "p1", propertyName: "Sun Cove", unitNumber: "A1", tenantName: "Date Unverified", totalHeldCents: 100000, unknownHeldCount: 0, temporalUncertainty: true }]);
  const markup = renderWidget("security-deposits", data(), client);
  assert.match(markup, />Unknown<\/strong>/);
  assert.match(markup, /1 records unresolved/);
  assert.doesNotMatch(markup, />\$1,000<\/strong>/);
});

test("largest balances distinguishes unverified rows from no balances", () => {
  const markup = renderWidget("top-delinquents", data({ dueRows: [{ operationalBalanceCents: null }], knownDue: [], unverifiedDue: 1 }));
  assert.match(markup, /No verified balances/);
  assert.doesNotMatch(markup, /No balances due/);
});

test("credits remain a lower bound when another balance is unresolved", () => {
  const rentRoll = [
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u1", unitNumber: "A1", occupancy: "current", operationalBalanceCents: -25000 },
    { propertyId: "p1", propertyName: "Sun Cove", unitId: "u2", unitNumber: "A2", occupancy: "current", operationalBalanceCents: null },
  ];
  const markup = renderWidget("credits", data({ rentRoll }));
  assert.match(markup, />≥ \$250<\/strong>/);
  assert.match(markup, /1 balances not verified/);
  assert.doesNotMatch(markup, />\$250<\/strong>/);
});

test("partial scheduled-versus-collected rows show an unknown rate", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seedReport(client, "scheduled-vs-collected", [{
    propertyId: "p1", propertyName: "Sun Cove", month: AS_OF.slice(0, 7), scheduledCents: 100000,
    scheduledUncertainCents: 5000, scheduledUnknownAmountCount: 0, collectedCents: 80000,
    collectedUnknownAmountCount: 0, complete: false,
  }]);
  const markup = renderWidget("collection-rate", data(), client);
  assert.match(markup, /Collected of scheduled · Sep 2026/);
  assert.match(markup, /<strong[^>]*>Unknown<\/strong>/);
  assert.match(markup, /some properties incomplete/);
  assert.doesNotMatch(markup, /<strong>80%<\/strong>/);
});

test("scheduled-versus-collected rows without a completeness flag stay unknown", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  seedReport(client, "scheduled-vs-collected", [{
    propertyId: "p1", propertyName: "Sun Cove", month: AS_OF.slice(0, 7), scheduledCents: 100000,
    collectedCents: 80000,
  }]);
  const markup = renderWidget("collection-rate", data(), client);
  assert.match(markup, /<strong[^>]*>Unknown<\/strong>/);
  assert.doesNotMatch(markup, /<strong>80%<\/strong>/);
});

test("preleased rows do not present market rent as contracted rent", () => {
  const rentRoll = [{ propertyId: "p1", propertyName: "Sun Cove", unitId: "u1", unitNumber: "A1", occupancy: "future_preleased", futureTenantName: "Future Resident", marketRentCents: 120000 }];
  const markup = renderWidget("preleased", data({ rentRoll }));
  assert.match(markup, /Future Resident/);
  assert.match(markup, />—<\/span>/);
  assert.doesNotMatch(markup, /\$1,200/);
});
