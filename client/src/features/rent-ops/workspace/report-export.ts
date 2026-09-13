import type { AdminSnapshot, ApiFilters, ReportKey, ReportRow } from "../types";
import { REPORT_PERIODS, buildReportCsv, createReportViewModel, defaultReportTenantStatus, filterRentRollRows, filterReportLocalRows, formatReportCellValue, formatReportValue, groupReportRows, isTenantStatusReport, readReportValue, validateReportPeriod, type ReportLocalFilters } from "./report-model";

export interface ReportExportSelection {
  propertyIds: string[]; // Empty means every property within the chosen scope.
  propertyScope: "active" | "all";
  asOfDate: string;
  month: string;
  fromDate: string;
  toDate: string;
  tenantStatus: NonNullable<ApiFilters["tenantStatus"]>;
}
export function initialExportPropertyScope(base: ApiFilters, snapshot: AdminSnapshot): "active" | "all" {
  const ids = base.propertyIds ?? (base.propertyId && base.propertyId !== "all" ? [base.propertyId] : []);
  const selectedInactive = snapshot.snapshot.properties.some(property => property.id && ids.includes(property.id) && property.state !== "active");
  return base.propertyScope === "all" || selectedInactive ? "all" : "active";
}
export function exportPropertyOptions(snapshot: AdminSnapshot, scope: "active" | "all") {
  return snapshot.snapshot.properties.filter(property => property.id && (scope === "all" || property.state === "active"))
    .sort((left, right) => Number(right.state === "active") - Number(left.state === "active") || (left.name ?? left.id ?? "").localeCompare(right.name ?? right.id ?? "", undefined, { numeric: true }));
}
export function exportQueryFilters(report: ReportKey, base: ApiFilters, selection: ReportExportSelection): ApiFilters {
  const { propertyId, propertyIds, propertyScope, asOfDate, month, fromDate, toDate, ...other } = base;
  return { ...other, propertyScope: selection.propertyScope, ...(selection.propertyIds.length ? { propertyIds: [...selection.propertyIds].sort() } : {}),
    asOfDate: selection.asOfDate,
    ...(REPORT_PERIODS[report] === "month" ? { month: selection.month } : {}),
    ...(REPORT_PERIODS[report] === "range" ? { fromDate: selection.fromDate, toDate: selection.toDate } : {}),
    ...(isTenantStatusReport(report) ? { tenantStatus: defaultReportTenantStatus(report, selection.tenantStatus) } : {}),
  };
}
export function exportSelectionError(report: ReportKey, selection: ReportExportSelection): string | undefined {
  return validateReportPeriod(report, selection.asOfDate, selection.month, selection.fromDate, selection.toDate);
}
export function exportPeriodLabel(report: ReportKey, selection: ReportExportSelection): string {
  return REPORT_PERIODS[report] === "range" ? `From ${selection.fromDate} through ${selection.toDate} (inclusive)`
    : REPORT_PERIODS[report] === "month" ? `Month ${selection.month} · As of ${selection.asOfDate}` : `As of ${selection.asOfDate}`;
}
export function prepareReportExport(report: ReportKey, rows: ReportRow[], snapshot: AdminSnapshot, selection: ReportExportSelection,
  options: { localFilters?: ReportLocalFilters; search?: string; extraColumns?: string[]; sort?: { key: string; direction: "asc" | "desc" } } = {}) {
  // Ledger opening balances are person-level rows returned by the already scoped
  // server query. Retain them even though their transaction has no property ID.
  const scopedRows = rows.filter(row => filterReportLocalRows([row], report, { propertyIds: selection.propertyIds }).length > 0
    || (report === "tenant-ledger" && readReportValue(row, "rowType") === "opening_balance" && !readReportValue(row, "propertyId")));
  const filtered = filterReportLocalRows(report === "rent-roll" ? filterRentRollRows(scopedRows, options.search ?? "") : scopedRows, report,
    { ...options.localFilters, propertyIds: undefined, ...(report === "delinquency" ? { tenancyStatus: selection.tenantStatus } : {}) });
  const view = createReportViewModel(report, filtered, snapshot);
  const columns = view.columns.filter(column => column.curated !== false || options.extraColumns?.includes(column.key));
  const groups = groupReportRows(report, view.displayRows, snapshot, options.sort);
  if (report === "tenant-ledger") {
    for (const group of groups) {
      if (!group.propertyId && group.rows.every(row => readReportValue(row.__source, "rowType") === "opening_balance")) {
        group.label = "Account opening balances · selected report scope";
        for (const row of group.rows) row.propertyName = "Account opening balance · selected report scope";
      }
    }
  }
  return { columns, groups, rows: groups.flatMap(group => group.rows) };
}
export interface ReportExportHeader { title: string; properties: string; period: string; tenantStatus?: string }
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const metadataCell = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? "'" : "") + value.replace(/"/g, '""')}"`;
export function brandedReportCsv(header: ReportExportHeader, result: ReturnType<typeof prepareReportExport>): string {
  return ["5Central Capital", header.title, header.properties, header.period, ...(header.tenantStatus ? [header.tenantStatus] : [])].map(metadataCell).join("\n") + "\n\n" + buildReportCsv(result.rows, result.columns);
}
export function brandedReportHtml(header: ReportExportHeader, result: ReturnType<typeof prepareReportExport>): string {
  const columns = result.columns.filter(column => column.key !== "propertyName");
  const cell = (text: string, right = false, tag = "td") => `<${tag}${right ? ' class="number"' : ""}>${escapeHtml(text)}</${tag}>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(header.title)} · 5Central Capital</title><style>
  @page{size:landscape;margin:12mm}*{box-sizing:border-box}body{font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202022;margin:0}header{border-bottom:2px solid #D4A843;padding:0 0 14px;margin-bottom:18px}.brand{font-size:22px;font-weight:700;color:#3A3A3C}h1{font-size:19px;margin:12px 0 8px}header p{margin:4px 0}table{width:100%;border-collapse:collapse}thead{display:table-header-group}th,td{padding:7px 6px;border-bottom:1px solid #ddd;text-align:left}thead th,.total td{background:#F5F0E8}.property th{padding-top:18px;font-size:14px;color:#3A3A3C}.number{text-align:right;font-variant-numeric:tabular-nums}tr{break-inside:avoid}.property{break-after:avoid}.total{font-weight:600}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  </style></head><body><header><div class="brand">5Central Capital</div><h1>${escapeHtml(header.title)}</h1><p>${escapeHtml(header.properties)}</p><p>${escapeHtml(header.period)}</p>${header.tenantStatus ? `<p>${escapeHtml(header.tenantStatus)}</p>` : ""}</header><table><thead><tr>${columns.map(c => cell(c.label, c.align === "right", "th")).join("")}</tr></thead>${result.groups.map(group => `<tbody><tr class="property"><th colspan="${columns.length}">${escapeHtml(group.label)}</th></tr>${group.rows.map(row => `<tr>${columns.map(c => cell(formatReportCellValue(row, c), c.align === "right")).join("")}</tr>`).join("")}<tr class="total">${columns.map((c, i) => cell(i === 0 ? `Subtotal · ${group.count} records` : c.subtotal ? formatReportValue(group.amounts[c.key], c.format) : "", c.align === "right")).join("")}</tr></tbody>`).join("")}</table>${result.rows.length ? "" : "<p>No records returned for the selected filters.</p>"}</body></html>`;
}

/** Print a standalone document so navigation, stale grid rows and modal controls cannot leak into the PDF. */
export function printReportDocument(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.title = "5Central report print preview";
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;";
    frame.onload = () => {
      const target = frame.contentWindow;
      if (!target) { frame.remove(); reject(new Error("The print preview could not be opened.")); return; }
      target.addEventListener("afterprint", () => frame.remove(), { once: true });
      target.focus(); target.print(); resolve();
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}
