import { centsFromBigInt, currencyCodeSchema, type CurrencyCode, type IsoDate, type MoneyCents } from "../../shared/company";
import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import type { QuickBooksReportResponse, QuickBooksReportsClient } from "../integrations/quickbooks/reports";
import type { ReportColumn, ReportRow, ReportSourceCoverage, ReportingEngineContext, ReportingEngineResult } from "../../shared/reporting";
import { ReportingError } from "./errors";
import { sha256 } from "./utils";

const NATIVE_REPORTS = {
  "balance-sheet": "BalanceSheet",
  "cash-flow-statement": "CashFlow",
  "general-ledger": "GeneralLedger",
  "income-statement": "ProfitAndLoss",
  "income-statement-detailed": "ProfitAndLossDetail",
  "trial-balance": "TrialBalance",
} as const;
export const QUICKBOOKS_REPORT_IDS = Object.keys(NATIVE_REPORTS) as Array<keyof typeof NATIVE_REPORTS>;
const ACCOUNT_FILTER_REPORTS = new Set(["BalanceSheet", "GeneralLedger", "ProfitAndLoss", "ProfitAndLossDetail", "TrialBalance"]);
const SUMMARY_COLUMN_REPORTS = new Set(["BalanceSheet", "CashFlow", "ProfitAndLoss", "ProfitAndLossDetail"]);

export interface QuickBooksReportingEngineOptions {
  readonly resolveConnectionScope: (organizationId: string, legalEntityId: string) => QuickBooksConnectionScope | Promise<QuickBooksConnectionScope>;
  readonly createClient: (scope: QuickBooksConnectionScope) => QuickBooksReportsClient | Promise<QuickBooksReportsClient>;
  readonly ready?: boolean;
  readonly reason?: string;
}

function decimalToCents(value: string): MoneyCents | undefined {
  const normalized = value.trim().replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return centsFromBigInt(negative ? -cents : cents);
}

function headerOf(response: QuickBooksReportResponse): QuickBooksJsonObject {
  const header = response.raw.Header;
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new ReportingError("report_unavailable", "QuickBooks report response has no verifiable header", 409);
  return header as QuickBooksJsonObject;
}

function keyForTitle(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9]+(.)/g, (_match, character: string) => character.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
  const key = normalized ? normalized.replace(/^./, character => character.toLowerCase()) : fallback;
  return /^[a-z][A-Za-z0-9_.-]{0,119}$/.test(key) ? key : fallback;
}

interface ProviderColumn { readonly title: string; readonly type: string; }

function providerColumns(raw: QuickBooksJsonObject): ProviderColumn[] {
  const columns = raw.Columns;
  if (!columns || typeof columns !== "object" || Array.isArray(columns)) return [];
  const entries = (columns as QuickBooksJsonObject).Column;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const object = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as QuickBooksJsonObject : {};
    return { title: typeof object.ColTitle === "string" && object.ColTitle.trim() ? object.ColTitle : `Column ${index + 1}`, type: typeof object.ColType === "string" ? object.ColType : "String" };
  });
}

function providerCellValue(cell: unknown): unknown {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return null;
  const value = (cell as QuickBooksJsonObject).value;
  return value === "" || value === undefined ? null : value;
}

function addCells(values: Record<string, unknown>, cells: unknown, columns: readonly ProviderColumn[], prefix = ""): void {
  if (!Array.isArray(cells)) return;
  cells.forEach((cell, cellIndex) => {
    const value = providerCellValue(cell);
    const definition = columns[cellIndex];
    const title = definition?.title ?? `Column ${cellIndex + 1}`;
    const type = (definition?.type ?? "String").toLowerCase();
    const baseKey = keyForTitle(title, `${prefix}column${cellIndex + 1}`);
    const providerId = cell && typeof cell === "object" && !Array.isArray(cell) ? (cell as QuickBooksJsonObject).id : undefined;
    if (typeof providerId === "string" && providerId.length > 0) {
      const idKey = prefix ? `${prefix}${baseKey.replace(/^./, character => character.toUpperCase())}Id` : `${baseKey}Id`;
      values[idKey] = providerId;
    }
    if (value === null) { values[baseKey] = null; return; }
    if (/money|amount|currency/.test(type)) {
      const cents = typeof value === "string" ? decimalToCents(value) : undefined;
      values[`${baseKey}Cents`] = cents ?? null;
      return;
    }
    values[baseKey] = value;
  });
}

function rowsOf(raw: QuickBooksJsonObject): unknown[] {
  const rows = raw.Rows;
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) return [];
  const columns = providerColumns(raw);
  const output: unknown[] = [];
  const visit = (node: QuickBooksJsonObject, path: string): void => {
    const entries = node.Row;
    if (!Array.isArray(entries)) return;
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const object = entry as QuickBooksJsonObject;
      const base = `${path}.${index}`;
      const cells = object.ColData;
      const header = object.Header;
      const summary = object.Summary;
      const values: Record<string, unknown> = { providerPath: base, rowKind: "detail" };
      if (header && typeof header === "object" && !Array.isArray(header)) {
        values.rowKind = "section";
        addCells(values, (header as QuickBooksJsonObject).ColData, columns, "section");
      }
      if (Array.isArray(cells)) addCells(values, cells, columns);
      const hasSummary = Boolean(summary && typeof summary === "object" && !Array.isArray(summary));
      // Statement order: section header, its detail rows, then its total.
      if (header || (Array.isArray(cells) && !hasSummary)) output.push(values);
      const nested = object.Rows;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) visit(nested as QuickBooksJsonObject, `${path}.${index}`);
      if (hasSummary) {
        const summaryValues: Record<string, unknown> = { providerPath: `${base}.summary`, rowKind: "summary" };
        addCells(summaryValues, (summary as QuickBooksJsonObject).ColData, columns);
        output.push(summaryValues);
      }
    });
  };
  visit(rows as QuickBooksJsonObject, "rows");
  return output;
}

function columnsFor(rows: readonly ReportRow[]): ReportColumn[] {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.values)) keys.add(key);
  return Array.from(keys).sort().map(key => ({
    id: key,
    label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, value => value.toUpperCase()),
    type: key.endsWith("Cents") ? "money" : key === "rowKind" ? "status" : "text",
    sortable: key !== "providerPath",
    filterable: true,
    sensitive: false,
  } satisfies ReportColumn));
}

function requestFor(context: ReportingEngineContext, currency: CurrencyCode, reportName: string): { startDate?: string; endDate?: string; reportDate?: string; accountingMethod: "Cash" | "Accrual"; expectedCurrency: string; account?: string; summarizeColumnBy?: string } {
  if (context.request.basis !== "cash" && context.request.basis !== "accrual") {
    throw new ReportingError("report_unavailable", "The native QuickBooks report adapter requires one explicit accounting basis", 409, { basis: context.request.basis });
  }
  const accountingMethod = context.request.basis === "cash" ? "Cash" : "Accrual";
  const accountIds = context.request.filters.accountIds;
  const account = Array.isArray(accountIds) && accountIds.length ? accountIds.join(",") : undefined;
  if (account && !ACCOUNT_FILTER_REPORTS.has(reportName)) throw new ReportingError("report_unavailable", `QuickBooks ${reportName} does not support account filters in this adapter`, 409);
  const grouping = context.request.filters.grouping;
  const groupingValue = typeof grouping === "string" && grouping !== "none" ? ({ month: "Month", quarter: "Quarter", year: "Year" } as const)[grouping as "month" | "quarter" | "year"] : undefined;
  if (groupingValue && !SUMMARY_COLUMN_REPORTS.has(reportName)) throw new ReportingError("report_unavailable", `QuickBooks ${reportName} does not support grouped columns in this adapter`, 409);
  const extras = { ...(account ? { account } : {}), ...(groupingValue ? { summarizeColumnBy: groupingValue } : {}) };
  const period = context.request.period;
  if (period.mode === "range") return { startDate: period.fromDate, endDate: period.toDate, accountingMethod, expectedCurrency: currency, ...extras };
  if (period.mode === "as_of") return { endDate: period.asOfDate, accountingMethod, expectedCurrency: currency, ...extras };
  if (period.mode === "month") {
    const [year, month] = period.month.split("-").map(Number);
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    return { startDate: `${period.month}-01`, endDate: monthEnd, accountingMethod, expectedCurrency: currency, ...extras };
  }
  if (period.fromDate && period.toDate) return { startDate: period.fromDate, endDate: period.toDate, accountingMethod, expectedCurrency: currency, ...extras };
  if (period.asOfDate) return { endDate: period.asOfDate, accountingMethod, expectedCurrency: currency, ...extras };
  throw new ReportingError("report_validation", "QuickBooks reports require a verifiable date period", 400);
}

function coverage(context: ReportingEngineContext, response: QuickBooksReportResponse, rows: readonly ReportRow[]): ReportSourceCoverage {
  const period = context.request.period;
  const monthStart = period.mode === "month" ? `${period.month}-01` as IsoDate : null;
  const monthEnd = period.mode === "month" ? (() => {
    const [year, month] = period.month.split("-").map(Number);
    return `${period.month}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}` as IsoDate;
  })() : null;
  return {
    source: "quickbooks_online_reports",
    state: response.truncated ? "partial" : "complete",
    evidence: "live_provider_readback",
    basis: context.request.basis,
    watermark: response.intuitTid ?? null,
    observedAt: context.now,
    coveredFrom: period.mode === "range" ? period.fromDate : monthStart,
    coveredThrough: period.mode === "range" ? period.toDate : period.mode === "as_of" ? period.asOfDate : period.mode === "month" ? monthEnd : period.toDate ?? period.asOfDate ?? null,
    rowCount: rows.length,
    reason: response.truncated ? "QuickBooks truncated this provider response at its supported cell limit; narrow the period or report columns." : null,
  };
}

/** Native QBO statements. The connection and realm mapping are injected so
 * no report can silently pick a company by name or guess a consolidation. */
export function createQuickBooksReportingEngine(options: QuickBooksReportingEngineOptions) {
  const ready = options.ready ?? true;
  return {
    key: "quickbooks.native-reports",
    reportIds: QUICKBOOKS_REPORT_IDS,
    ready,
    reason: options.reason,
    async run(context: ReportingEngineContext): Promise<ReportingEngineResult> {
      const reportName = NATIVE_REPORTS[context.definition.id as keyof typeof NATIVE_REPORTS];
      if (!reportName) throw new ReportingError("report_unavailable", `QuickBooks report ${context.definition.id} is not supported by the native adapter`, 409);
      if (context.request.scope.legalEntityIds.length !== 1) throw new ReportingError("report_validation", "Native QuickBooks reports require exactly one explicit legal entity", 400);
      if (context.request.scope.propertyIds.length) throw new ReportingError("report_unavailable", "Native QuickBooks report property allocation requires an approved entity mapping", 409);
      const currency = currencyCodeSchema.parse(context.request.currency);
      const connectionScope = await options.resolveConnectionScope(context.request.scope.organizationId, context.request.scope.legalEntityIds[0]);
      if (connectionScope.organizationId !== context.request.scope.organizationId || connectionScope.legalEntityId !== context.request.scope.legalEntityIds[0]) throw new ReportingError("report_unavailable", "QuickBooks connection identity did not match the requested legal entity", 409);
      const client = await options.createClient(connectionScope);
      const response = await client.getReport(reportName, requestFor(context, currency, reportName));
      if (response.accountingMethod !== (context.request.basis === "cash" ? "Cash" : "Accrual")) throw new ReportingError("report_unavailable", "QuickBooks provider basis was not verifiable", 409);
      if (response.currency !== currency) throw new ReportingError("report_unavailable", "QuickBooks provider currency was not verifiable", 409, { expected: currency, received: response.currency ?? null });
      const rawRows = rowsOf(response.raw);
      if (rawRows.length === 0 && !response.noReportData) throw new ReportingError("report_unavailable", "QuickBooks returned no rows without a provider-declared NoReportData marker", 409, { reportId: context.definition.id });
      const rows = rawRows.map((raw, index) => ({ rowId: `${context.definition.id}:${sha256(raw).slice(0, 32)}:${index}`, values: raw as Record<string, unknown> } satisfies ReportRow));
      const missingData = response.noReportData ? [{ code: "qbo_no_report_data", state: "verified_zero" as const, message: "QuickBooks explicitly reported no data for the selected period and scope." }] : response.truncated ? [{ code: "qbo_response_truncated", state: "partial" as const, message: "QuickBooks truncated the report response; the result is incomplete." }] : [];
      return { columns: columnsFor(rows), rows, totals: [], coverage: [coverage(context, response, rows)], missingData, drilldowns: [] };
    },
  } as const;
}
