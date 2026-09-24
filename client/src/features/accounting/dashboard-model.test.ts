import test from "node:test";
import assert from "node:assert/strict";
import { financialFigure, financialRequest, loadDashboardReport, type DashboardReport } from "./dashboard-model";
import { transactionTotals } from "./transaction-totals";
import type { AccountingTransaction } from "./types";
import type { ReportingApi } from "../reporting/types";
const org = "11111111-1111-4111-8111-111111111111", entity = "22222222-2222-4222-8222-222222222222";
function report(rows: DashboardReport["page"]["rows"]): DashboardReport {
  return { generatedAt: "2026-09-24T12:00:00Z", page: { runId: org as never, snapshotId: entity as never, rows, rowCount: rows.length, totalRows: rows.length, nextCursor: null, columns: [], totals: [], coverage: [{ source: "quickbooks_online_reports", state: "complete", evidence: "live_provider_readback", basis: "cash", watermark: null, observedAt: "2026-09-24T12:00:00Z" as never, coveredFrom: null, coveredThrough: null, rowCount: rows.length, reason: null }], missingData: [] } };
}
test("dashboard uses provider section totals, never sums nested accounts or matches editable labels", () => {
 const data = report([
  { rowId: "1", values: { rowKind: "section", providerGroup: "Income", totalCents: null } },
  { rowId: "2", values: { rowKind: "detail", account: "Total Income", totalCents: "800" } },
  { rowId: "3", values: { rowKind: "summary", providerGroup: "Income", totalCents: "900719925474099312" } },
  { rowId: "4", values: { rowKind: "summary", providerGroup: "NetIncome", totalCents: "-1001" } },
 ]);
 assert.equal(financialFigure(data, "Income"), "900719925474099312");
 assert.equal(financialFigure(data, "NetIncome"), "-1001");
 assert.equal(financialFigure(data, "Expenses"), null);
 assert.equal(financialFigure({ ...data, page: { ...data.page, coverage: data.page.coverage.map(c => ({ ...c, state: "partial" })) } }, "Income"), null);
 assert.equal(financialFigure(report([...data.page.rows, data.page.rows[2]!]), "Income"), null);
});
test("only provider verified no-data becomes zero; missing or incomplete is unavailable", () => {
 const empty = report([]);
 assert.equal(financialFigure(empty, "Income"), null);
 assert.equal(financialFigure({ ...empty, page: { ...empty.page, missingData: [{ code: "qbo_no_report_data", state: "verified_zero", message: "No data" }] } }, "Income"), "0");
 assert.equal(financialFigure(undefined, "Assets"), null);
});
test("dashboard requests the exact legal entity, basis and periods", () => {
 const setup = { from: "2026-01-01", through: "2026-09-24", basis: "accrual" as const };
 const pnl = financialRequest(org, entity, "USD", "income-statement", setup);
 const bs = financialRequest(org, entity, "USD", "balance-sheet", setup);
 assert.deepEqual(pnl.scope.legalEntityIds, [entity]);
 assert.deepEqual(pnl.period, { mode: "range", fromDate: setup.from, toDate: setup.through });
 assert.deepEqual(bs.period, { mode: "as_of", asOfDate: setup.through });
 assert.equal(bs.basis, "accrual");
 assert.deepEqual(bs.filters, { grouping: "none" });
});
test("dashboard reads all snapshot pages so a later net-income row is not lost", async () => {
 const data = report([{ rowId: "later", values: { rowKind: "summary", providerGroup: "NetIncome", totalCents: "12345" } }]);
 const request = financialRequest(org, entity, "USD", "income-statement", { from: "2026-01-01", through: "2026-09-24", basis: "cash" });
 let pages = 0;
 const api = { run: async () => ({ run: { id: org, generatedAt: data.generatedAt }, page: { ...data.page, rows: [], rowCount: 0, nextCursor: "next" } }), page: async () => { pages++; return data.page; } } as unknown as ReportingApi;
 assert.equal(financialFigure(await loadDashboardReport(api, request), "NetIncome"), "12345");
 assert.equal(pages, 1);
 await assert.rejects(loadDashboardReport({ ...api, page: async () => ({ ...data.page, snapshotId: org as never }) }, request), /changed while loading/);
});
test("transaction page totals keep types, currency, and posting states separate and exact", () => {
 const row = (transactionType: string, amountCents: string, currency = "USD", postingState = "posted") => ({ transactionType, amountCents, currency, postingState }) as AccountingTransaction;
 const totals = transactionTotals([row("Bill", "900719925474099312"), row("Bill", "1"), row("BillPayment", "100"), row("Bill", "50", "CAD"), row("Bill", "60", "USD", "voided")]);
 assert.equal(totals.length, 4);
 assert.equal(totals[0]!.amountCents, "900719925474099313");
 assert.equal(totals[0]!.count, 2);
 assert.equal(transactionTotals([row("Bill", "invalid")])[0]!.amountCents, null);
 assert.deepEqual(transactionTotals([]), []);
});

test("full-report links preserve the selected company, dates and basis and reject mismatched scope", async () => {
 const { financialReportHref, requestFromFinancialLink } = await import("./report-links");
 const company = { id: org, entities: [{ id: entity, currency: "USD" }] } as never;
 const href = financialReportHref(org, entity, "general-ledger", { from: "2026-02-01", through: "2026-03-31", basis: "accrual" });
 const search = new URL(href, "https://example.test").search;
 const seed = requestFromFinancialLink(search, company, "general-ledger")!;
 assert.deepEqual(seed.scope.legalEntityIds, [entity]);
 assert.deepEqual(seed.period, { mode: "range", fromDate: "2026-02-01", toDate: "2026-03-31" });
 assert.equal(seed.basis, "accrual");
 assert.equal(requestFromFinancialLink(search.replace(entity, org), company, "general-ledger"), undefined);
 assert.equal(requestFromFinancialLink(search, company, "balance-sheet"), undefined);
});
