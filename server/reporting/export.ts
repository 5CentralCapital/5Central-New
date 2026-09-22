import type { ReportRunRecord } from "../../shared/reporting";

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function csvCell(value: unknown): string {
  const text = scalar(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportReportCsv(run: ReportRunRecord): string {
  const header = ["rowId", ...run.columns.map(column => column.label)];
  const lines = [header.map(csvCell).join(",")];
  for (const row of run.rows) lines.push([row.rowId, ...run.columns.map(column => row.values[column.id])].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export function exportReportJson(run: ReportRunRecord): string {
  return JSON.stringify({ serviceVersion: run.serviceVersion, reportId: run.reportId, definitionVersion: run.definitionVersion, snapshotId: run.snapshotId, scope: run.scope, filters: run.filters, period: run.period, basis: run.basis, currency: run.currency, columns: run.columns, rows: run.rows, totals: run.totals, coverage: run.coverage, missingData: run.missingData });
}

export function exportReportHtml(run: ReportRunRecord): string {
  const escape = (value: unknown): string => scalar(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const headings = run.columns.map(column => `<th scope="col">${escape(column.label)}</th>`).join("");
  const rows = run.rows.map(row => `<tr><th scope="row">${escape(row.rowId)}</th>${run.columns.map(column => `<td>${escape(row.values[column.id])}</td>`).join("")}</tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(run.reportId)}</title><style>body{font-family:system-ui,sans-serif;color:#282828;background:#f7f1e4;padding:24px}table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #d8c8a5;padding:6px;text-align:left}th{background:#282828;color:#f7f1e4}</style></head><body><table><thead><tr><th scope="col">Row</th>${headings}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
