import { reportRunRequestSchema, type ReportPage, type ReportRow, type ReportRunRequest } from "@shared/reporting";
import type { ReportingApi } from "../reporting/types";

export type FinancialReport = "income-statement" | "balance-sheet";
export interface DashboardSetup { from: string; through: string; basis: "cash" | "accrual" }
export interface DashboardReport { page: ReportPage; generatedAt: string }
export const PROFIT_LINES = [
  ["Income", "Income"], ["COGS", "Cost of goods sold"], ["GrossProfit", "Gross profit"],
  ["Expenses", "Operating expenses"], ["NetOperatingIncome", "Operating income"],
  ["OtherIncome", "Other income"], ["OtherExpenses", "Other expenses"], ["NetIncome", "Net income"],
] as const;
export const BALANCE_LINES = [["Assets", "Assets"], ["Liabilities", "Liabilities"], ["Equity", "Equity"], ["LiabilitiesAndEquity", "Liabilities & equity"]] as const;

export function financialRequest(organizationId: string, legalEntityId: string, currency: string, reportId: FinancialReport, setup: DashboardSetup): ReportRunRequest {
  return reportRunRequestSchema.parse({ reportId, definitionVersion: "1", scope: { organizationId, legalEntityIds: [legalEntityId] }, filters: { grouping: "none" },
    period: reportId === "balance-sheet" ? { mode: "as_of", asOfDate: setup.through } : { mode: "range", fromDate: setup.from, toDate: setup.through }, basis: setup.basis, currency });
}

/** One provider run, then bounded snapshot paging. Never a sum of detail and subtotal rows. */
export async function loadDashboardReport(api: ReportingApi, request: ReportRunRequest, signal?: AbortSignal): Promise<DashboardReport> {
  const first = await api.run(request.scope.organizationId, request);
  const rows: ReportRow[] = [...first.page.rows];
  let page = first.page;
  const seen = new Set<string>();
  while (page.nextCursor) {
    if (signal?.aborted) throw new Error("Report request cancelled.");
    if (seen.has(page.nextCursor) || rows.length >= 10_000) throw new Error("This report is too large for the dashboard. Open the full report.");
    seen.add(page.nextCursor);
    page = await api.page(request.scope.organizationId, first.run.id, page.nextCursor, 1000);
    if (page.runId !== first.page.runId || page.snapshotId !== first.page.snapshotId) throw new Error("The report changed while loading. Refresh the dashboard.");
    rows.push(...page.rows);
  }
  if (rows.length !== first.page.totalRows || new Set(rows.map(row => row.rowId)).size !== rows.length) throw new Error("The full report could not be loaded. Refresh the dashboard.");
  return { page: { ...first.page, rows, rowCount: rows.length, nextCursor: null }, generatedAt: first.run.generatedAt };
}

export function reportIsComplete(report: DashboardReport): boolean {
  return report.page.coverage.some(item => item.source === "quickbooks_online_reports" && item.state === "complete") &&
    report.page.coverage.every(item => item.state === "complete") && report.page.missingData.every(item => item.state === "verified_zero");
}

/** Stable Intuit section identities, not editable account names or localized labels. */
export function financialFigure(report: DashboardReport | undefined, group: string): string | null {
  if (!report || !reportIsComplete(report)) return null;
  if (!report.page.rows.length && report.page.missingData.some(item => item.code === "qbo_no_report_data" && item.state === "verified_zero")) return "0";
  const summaries = report.page.rows.filter(row => row.values.providerGroup === group && row.values.rowKind === "summary");
  // Some standalone report totals (e.g. net income) are data rows with their own group.
  const candidates = summaries.length ? summaries : report.page.rows.filter(row => row.values.providerGroup === group && row.values.rowKind === "detail");
  if (candidates.length !== 1) return null;
  const value = candidates[0]!.values.providerTotalCents ?? candidates[0]!.values.totalCents;
  return typeof value === "string" && /^-?\d+$/.test(value) ? value : null;
}
