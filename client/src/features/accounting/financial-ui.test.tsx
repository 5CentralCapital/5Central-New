import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { workspaceToday } from "../rent-ops/workspace/workspace-date";
import type { ReportingApi } from "../reporting/types";
(globalThis as { React?: typeof React }).React = React;
const org = "11111111-1111-4111-8111-111111111111", entity = "22222222-2222-4222-8222-222222222222";
const setup = () => { const today = workspaceToday(); return { from: `${today.slice(0, 4)}-01-01`, through: today, basis: "cash" }; };
const api = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as ReportingApi;
test("full general ledger renders journal entries, provider totals and paging without internal identifiers", async () => {
 const { FullGeneralLedger } = await import("./full-ledger");
 const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
 client.setQueryData(["accounting", "general-ledger", org, entity, "CAD", setup()], { run: { id: org }, page: { rows: [
 { rowId: "je", values: { rowKind: "detail", date: "2026-09-01", transactionType: "Journal Entry", amountCents: "10001", balanceCents: "10001", accountId: "PRIVATE-ID" } },
 { rowId: "summary", values: { rowKind: "summary", transactionType: "Total bank", amountCents: "10001", balanceCents: "10001" } },
 ], totalRows: 300, nextCursor: "more", columns: [{ id: "date", label: "Date", type: "text" }, { id: "transactionType", label: "Type", type: "text" }, { id: "amountCents", label: "Amount", type: "money" }, { id: "balanceCents", label: "Balance", type: "money" }, { id: "accountId", label: "Account id", type: "text" }], coverage: [{ state: "complete" }] } });
 const html = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(FullGeneralLedger, { organizationId: org, legalEntityId: entity, currency: "CAD", api }))).replace(/<!-- -->/g, "");
 assert.match(html, /Journal Entry/);
 assert.match(html, /CAD 100\.01/);
 assert.match(html, /2 of 300 report rows/);
 assert.match(html, /Next/);
 assert.match(html, /accounting-provider-total/);
 assert.doesNotMatch(html, /PRIVATE-ID/);
 client.clear();
});
test("dashboard is entity-scoped and shows unavailable rather than zero without a report", async () => {
 const { FinancialDashboard } = await import("./dashboard");
 const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
 for (const reportId of ["income-statement", "balance-sheet"]) client.setQueryData(["accounting", "financial-dashboard", org, entity, "USD", reportId, setup()], { generatedAt: "2026-09-24T12:00:00Z", page: { rows: [], coverage: [{ source: "quickbooks_online_reports", state: "partial" }], missingData: [] } });
 const html = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(FinancialDashboard, { organizationId: org, legalEntityId: entity, currency: "USD", connected: true, onConnections: () => undefined, api })));
 assert.match(html, /Unavailable/);
 assert.match(html, /incomplete report/);
 assert.doesNotMatch(html, /\$0\.00/);
 assert.match(html, /reportId=general-ledger/);
 client.clear();
});
