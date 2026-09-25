import { getReportingDefinition, type ReportRunRecord } from "../../shared/reporting";
import { centsToDecimalString, describeReportPeriod, formatReportTotal, formatReportValue, reportStatusLabel, reportTotalLabel } from "../../shared/reporting/format";

const CENTS_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMERIC_COLUMN_TYPES = new Set(["integer", "decimal", "percent"]);

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Spreadsheet applications evaluate a cell that starts with =, +, -, @, tab
 * or carriage return as a formula. Such text is prefixed with an apostrophe.
 * Canonical money values are exported as exact decimal numbers, so a
 * negative amount stays numeric instead of being treated as text.
 */
export function neutralizeCsvFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: unknown, options: { readonly numeric?: boolean } = {}): string {
  const raw = scalar(value);
  const text = options.numeric && PLAIN_NUMBER.test(raw) ? raw : neutralizeCsvFormula(raw);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function moneyCell(value: unknown): string {
  return typeof value === "string" && CENTS_PATTERN.test(value) ? csvCell(centsToDecimalString(value), { numeric: true }) : csvCell(value);
}

function titleFor(run: ReportRunRecord): string {
  return getReportingDefinition(run.reportId, run.definitionVersion)?.title ?? run.reportId;
}

/**
 * CSV rows carry the same values as the API; money columns are exact decimal
 * amounts. Report totals follow the rows in a labeled section so the export
 * total is the service total, never a spreadsheet re-sum.
 */
export function exportReportCsv(run: ReportRunRecord): string {
  const header = ["Row", ...run.columns.map(column => column.type === "money" ? `${column.label} (amount)` : column.label)];
  const lines = [header.map(value => csvCell(value)).join(",")];
  for (const row of run.rows) {
    // Numeric columns keep a plain signed number numeric (e.g. -3154.40);
    // any other text in them is still neutralized.
    lines.push([csvCell(row.rowId), ...run.columns.map(column => column.type === "money" ? moneyCell(row.values[column.id]) : csvCell(row.values[column.id], { numeric: NUMERIC_COLUMN_TYPES.has(column.type) }))].join(","));
  }
  if (run.totals.length) {
    lines.push("");
    lines.push([csvCell("Total"), csvCell("Amount"), csvCell("Currency"), csvCell("State")].join(","));
    for (const total of run.totals) lines.push([csvCell(reportTotalLabel(total.key)), total.amountCents === null ? "" : moneyCell(total.amountCents), csvCell(total.currency ?? ""), csvCell(total.state)].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function exportReportJson(run: ReportRunRecord): string {
  return JSON.stringify({ serviceVersion: run.serviceVersion, reportId: run.reportId, title: titleFor(run), definitionVersion: run.definitionVersion, runId: run.id, snapshotId: run.snapshotId, generatedAt: run.generatedAt, scope: run.scope, filters: run.filters, period: run.period, basis: run.basis, currency: run.currency, consolidation: run.consolidation, forecast: run.forecast, columns: run.columns, rows: run.rows, totals: run.totals, coverage: run.coverage, missingData: run.missingData });
}

function escapeHtml(value: unknown): string {
  return scalar(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Printable, self-contained HTML. It uses the same formatter as the
 * workspace table and lists totals, coverage and missing data so the printed
 * page cannot read as more complete than the run.
 */
export function exportReportHtml(run: ReportRunRecord): string {
  const title = titleFor(run);
  const headings = run.columns.map(column => `<th scope="col"${column.type === "money" || column.type === "integer" || column.type === "decimal" ? ' class="num"' : ""}>${escapeHtml(column.label)}</th>`).join("");
  const rows = run.rows.map(row => `<tr>${run.columns.map(column => `<td${column.type === "money" || column.type === "integer" || column.type === "decimal" ? ' class="num"' : ""}>${escapeHtml(formatReportValue(row.values[column.id], column, row.values, run.currency))}</td>`).join("")}</tr>`).join("");
  const totals = run.totals.length ? `<section><h2>Totals</h2><table class="totals"><tbody>${run.totals.map(total => `<tr><th scope="row">${escapeHtml(reportTotalLabel(total.key))}</th><td class="num">${escapeHtml(formatReportTotal(total))}</td><td>${escapeHtml(reportStatusLabel(total.state))}</td></tr>`).join("")}</tbody></table></section>` : "";
  const coverage = run.coverage.length ? `<section><h2>Source coverage</h2><ul>${run.coverage.map(item => `<li>${escapeHtml(reportStatusLabel(item.source))}: ${escapeHtml(reportStatusLabel(item.state))}${item.reason ? ` — ${escapeHtml(item.reason)}` : ""}</li>`).join("")}</ul></section>` : "";
  const missing = run.missingData.length ? `<section><h2>Missing or incomplete data</h2><ul>${run.missingData.map(item => `<li>${escapeHtml(item.message)}</li>`).join("")}</ul></section>` : "";
  const meta = [describeReportPeriod(run.period), run.basis === "not_applicable" ? null : `${reportStatusLabel(run.basis)} basis`, `Generated ${run.generatedAt.slice(0, 16).replace("T", " ")} UTC`].filter(Boolean).join(" · ");
  const style = "body{font:13px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Inter,system-ui,sans-serif;color:#1d1d1f;background:#fff;margin:32px}h1{font-size:22px;margin:0 0 4px;font-weight:600}h2{font-size:14px;margin:24px 0 8px}.meta{color:#6e6e73;margin:0 0 20px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid rgba(58,50,38,.14);padding:6px 8px;text-align:left;vertical-align:top}thead th{border-bottom:1px solid rgba(58,50,38,.4);font-weight:600}.num{text-align:right;white-space:nowrap}table.totals{width:auto;min-width:320px}ul{padding-left:18px;margin:0}@media print{body{margin:12mm}thead{display:table-header-group}tr{break-inside:avoid}}";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><header><h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(meta)}</p></header><table><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table>${totals}${coverage}${missing}</body></html>`;
}
