import { useReportSearch } from "./use-report-search";
import { useRentOpsAuth } from "../auth-ui";
import { useQuery } from "@tanstack/react-query";
import { loadRentOpsReport } from "../api";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Download, Loader2, Printer, SlidersHorizontal } from "lucide-react";
import type { AdminSnapshot, ReportKey, ReportRow, TenantTab, ViewFilters } from "../types";
import { EntityLink, RecordLink } from "./entity-link";
import {
  REPORT_PERIODS, buildReportCsv, createReportViewModel, defaultReportOccupancy, emptyReportMessage, formatReportCellValue,
  filterRentRollRows, filterReportLocalRows, formatReportValue, getReportConfig,
  groupReportRows, readReportValue, reportCellPersonId, reportKeys, reportQueryFilters,
  reportQueryKey, reportRowKey, validateReportPeriod,
  type DisplayReportRow, type ReportBalanceFilter, type ReportColumnDefinition,
} from "./report-model";
import "./reports.css";
import "./reports-clean.css";

export interface ReportsWorkspaceProps {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  selected: ReportKey;
  onSelect: (key: ReportKey) => void;
  onOpenTenant?: (personId: string, tab?: TenantTab) => void;
  onOpenUnit?: (unitId: string) => void;
  onOpenProperty?: (propertyId: string) => void;
}
const primaryReports: ReportKey[] = ["rent-roll", "occupancy", "delinquency"];
const balanceOptions: [ReportBalanceFilter, string][] = [["all", "All balances"], ["due", "Balance due"], ["zero", "Zero balance"], ["credit", "Credit balance"], ["unverified", "Unverified balance"]];

function readPreference<T>(report: ReportKey, key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const value = new URLSearchParams(window.location.search).get(`r_${report}_${key}`);
  if (value === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(fallback)) return (Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : fallback) as T;
    if (fallback && typeof fallback === "object") return (parsed && typeof parsed === "object" && "key" in parsed && typeof parsed.key === "string" && "direction" in parsed && ["asc", "desc"].includes(String(parsed.direction)) ? parsed : fallback) as T;
    return typeof parsed === typeof fallback ? parsed as T : fallback;
  } catch { return fallback; }
}
function savePreference(report: ReportKey, key: string, value: unknown): void {
  const url = new URL(window.location.href);
  url.searchParams.set(`r_${report}_${key}`, JSON.stringify(value));
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function downloadCsv(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}

function rowId(row: ReportRow, key: string): string | undefined {
  const value = readReportValue(row, key);
  return typeof value === "string" && value.length ? value : undefined;
}

function ReportCell({ row, column, onOpenTenant, onOpenUnit, onOpenProperty }: {
  row: DisplayReportRow; column: ReportColumnDefinition;
} & Pick<ReportsWorkspaceProps, "onOpenTenant" | "onOpenUnit" | "onOpenProperty">) {
  const label = formatReportCellValue(row, column);
  const source = row.__source;
  if (column.key === "unitNumber") return <RecordLink kind="unit" recordId={rowId(source, "unitId")} onOpen={onOpenUnit}>{label}</RecordLink>;
  if (column.key === "propertyName") return <RecordLink kind="property" recordId={rowId(source, "propertyId")} onOpen={onOpenProperty}>{label}</RecordLink>;
  const tenantField = ["tenantName", "currentTenantName", "futureTenantName"].includes(column.key);
  const recurringField = ["baseRentCents", "recurringFeesCents", "totalScheduledCents", "subsidyCents"].includes(column.key);
  const balanceField = ["balanceDueCents", "totalBalanceCents", "rentOnlyBalanceCents", "nonRentBalanceCents", "unappliedCashCents"].includes(column.key);
  if (tenantField || recurringField || balanceField) {
    const personId = reportCellPersonId(source, column.key);
    return <EntityLink personId={personId} tab={recurringField ? "charges" : balanceField ? "ledger" : "summary"} onOpen={onOpenTenant}>{label}</EntityLink>;
  }
  return <>{label}</>;
}

export function ReportsWorkspace({ snapshot, filters, selected, onSelect, onOpenTenant, onOpenUnit, onOpenProperty }: ReportsWorkspaceProps) {
  const auth = useRentOpsAuth();
  const core = primaryReports.includes(selected);
  const { debouncedSearch, searchPending } = useReportSearch(selected === "rent-roll" ? "" : filters.search);
  const asOfDate = filters.asOfDate;
  const [month, setMonth] = useState(asOfDate.slice(0, 7));
  const [fromDate, setFromDate] = useState(`${asOfDate.slice(0, 7)}-01`);
  const [toDate, setToDate] = useState(asOfDate);
  const [occupancy, setOccupancy] = useState(() => readPreference(selected, "occupancy", defaultReportOccupancy(selected, filters.status)));
  const [readiness, setReadiness] = useState("all");
  const [listing, setListing] = useState("all");
  const [balance, setBalance] = useState<ReportBalanceFilter>("all");
  const [tenancyStatus, setTenancyStatus] = useState<NonNullable<ViewFilters["tenantStatus"]>>("all");
  const [extraColumns, setExtraColumns] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" }>({ key: "unitNumber", direction: "asc" });
  useEffect(() => {
    setMonth(asOfDate.slice(0, 7)); setFromDate(`${asOfDate.slice(0, 7)}-01`); setToDate(asOfDate);
  }, [asOfDate]);
  useEffect(() => {
    setOccupancy(readPreference(selected, "occupancy", defaultReportOccupancy(selected, filters.status)));
    setReadiness(readPreference(selected, "readiness", filters.readiness?.[0] ?? "all")); setListing(readPreference(selected, "listing", "all"));
    setBalance(readPreference(selected, "balance", filters.balanceStatus ?? (selected === "delinquency" ? "due" : "all"))); setTenancyStatus(readPreference(selected, "tenantStatus", filters.tenantStatus ?? "all"));
    setExtraColumns(readPreference(selected, "columns", [])); setSort(readPreference(selected, "sort", { key: "unitNumber", direction: "asc" }));
  }, [selected, filters.status, filters.balanceStatus, filters.tenantStatus, filters.readiness]);

  const periodError = validateReportPeriod(selected, asOfDate, month, fromDate, toDate);
  const queryFilters = useMemo(() => ({
    ...reportQueryFilters({ ...filters, status: core ? "all" : filters.status, search: debouncedSearch,
      balanceStatus: selected === "delinquency" || selected === "rent-roll" ? balance : undefined,
      tenantStatus: selected === "delinquency" ? tenancyStatus : undefined,
      readiness: selected === "occupancy" && readiness !== "all" ? [readiness] : undefined,
    }, selected, { asOfDate, month, fromDate, toDate }),
    ...(selected === "occupancy" && occupancy !== "all" ? { occupancy: [occupancy] } : {}),
    ...(selected === "occupancy" && listing !== "all" ? { listing: [listing] } : {}),
  }), [filters.propertyId, filters.propertyIds, filters.propertyScope, debouncedSearch, filters.status, selected, core, asOfDate, month, fromDate, toDate, balance, tenancyStatus, readiness, occupancy, listing]);
  const reportQuery = useQuery({
    queryKey: reportQueryKey(selected, queryFilters, auth.user?.id ?? ""), staleTime: 30_000, gcTime: 300_000,
    queryFn: ({ signal }) => loadRentOpsReport(selected, queryFilters, signal),
    enabled: auth.status === "authenticated" && Boolean(auth.user?.id) && !periodError && !searchPending,
  });
  const loadedRows = periodError || searchPending ? undefined : reportQuery.data;
  const loading = !periodError && (searchPending || reportQuery.isFetching);
  const error = periodError ?? (searchPending ? undefined : reportQuery.error instanceof Error ? reportQuery.error.message : reportQuery.error ? "The selected report could not be loaded." : undefined);
  const visibleRows = useMemo(() => filterReportLocalRows(selected === "rent-roll" ? filterRentRollRows(loadedRows ?? [], filters.search) : loadedRows ?? [], selected,
    { propertyIds: filters.propertyIds, occupancy: selected === "rent-roll" || selected === "occupancy" ? occupancy : "all", readiness: selected === "occupancy" ? readiness : "all", listing: selected === "occupancy" ? listing : "all", balance: selected === "rent-roll" || selected === "delinquency" ? balance : "all", tenancyStatus: selected === "delinquency" ? tenancyStatus : "all" }),
    [loadedRows, selected, filters.search, filters.propertyIds, occupancy, readiness, listing, balance, tenancyStatus]);
  const view = useMemo(() => createReportViewModel(selected, visibleRows, snapshot), [selected, visibleRows, snapshot]);
  // Property identity is provided by each section, and retained explicitly in CSV.
  const activeColumns = useMemo(() => view.columns.filter(column => column.key !== "propertyName" && (column.curated !== false || extraColumns.includes(column.key))), [view.columns, extraColumns]);
  const optionalColumns = view.optionalColumns.filter(column => column.key !== "propertyName");
  const groups = useMemo(() => groupReportRows(selected, view.displayRows, snapshot, sort), [selected, view.displayRows, snapshot, sort]);
  const exportRows = groups.flatMap(group => group.rows);
  const propertyColumn = view.columns.find(column => column.key === "propertyName");
  const exportColumns = propertyColumn ? [propertyColumn, ...activeColumns] : activeColumns;
  const config = getReportConfig(selected);
  const mode = REPORT_PERIODS[selected];
  const readinessOptions = Array.from(new Set((loadedRows ?? []).map(row => readReportValue(row, "readiness")).filter((value): value is string => typeof value === "string"))).sort();
  const listingOptions = Array.from(new Set((loadedRows ?? []).map(row => readReportValue(row, "listing")).filter((value): value is string => typeof value === "string"))).sort();

  return <section className="rm-report-workspace rm-clean-report" aria-label="Rent Operations reports">
    <div className="rm-report-view-tabs" aria-label="Report views">
      {primaryReports.map(key => <button key={key} type="button" aria-pressed={selected === key} className={selected === key ? "active" : ""} onClick={() => onSelect(key)}>{getReportConfig(key).label}</button>)}
      <select aria-label="Other reports" value={core ? "" : selected} onChange={event => onSelect(event.target.value as ReportKey)}>
        <option value="" disabled>Other reports</option>
        {reportKeys().filter(key => !primaryReports.includes(key)).map(key => <option key={key} value={key}>{getReportConfig(key).label}</option>)}
      </select>
    </div>
    <div className="rm-report-toolbar" aria-label="Report controls">
      {(selected === "rent-roll" || selected === "occupancy") && <label>Occupancy<select value={occupancy} onChange={event => { setOccupancy(event.target.value); savePreference(selected, "occupancy", event.target.value); }}>
        <option value="all">All units</option><option value="current">Occupied</option><option value="vacant">Vacant</option><option value="future_preleased">Future preleased</option><option value="unknown">Unverified occupancy</option>
      </select></label>}
      {selected === "occupancy" && <>
        <label>Readiness<select value={readiness} onChange={event => { setReadiness(event.target.value); savePreference(selected, "readiness", event.target.value); }}><option value="all">All readiness</option>{readinessOptions.map(value => <option key={value} value={value}>{formatReportValue(value, "status")}</option>)}</select></label>
        <label>Listing<select value={listing} onChange={event => { setListing(event.target.value); savePreference(selected, "listing", event.target.value); }}><option value="all">All listing states</option>{listingOptions.map(value => <option key={value} value={value}>{formatReportValue(value, "status")}</option>)}</select></label>
      </>}
      {(selected === "rent-roll" || selected === "delinquency") && <label>Balance<select value={balance} onChange={event => { setBalance(event.target.value as ReportBalanceFilter); savePreference(selected, "balance", event.target.value); }}>{balanceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {selected === "delinquency" && <label>Tenant status<select value={tenancyStatus} onChange={event => { setTenancyStatus(event.target.value as NonNullable<ViewFilters["tenantStatus"]>); savePreference(selected, "tenantStatus", event.target.value); }}><option value="all">All tenants</option><option value="current">Current tenants</option><option value="former">Former tenants</option><option value="future">Future tenants</option><option value="unknown">Unverified status</option></select></label>}
      {mode === "month" && <label>Month<input type="month" value={month} max={asOfDate.slice(0, 7)} onChange={event => setMonth(event.target.value)} /></label>}
      {mode === "range" && <><label>From<input type="date" value={fromDate} max={asOfDate} onChange={event => setFromDate(event.target.value)} /></label><label>Through<input type="date" value={toDate} max={asOfDate} onChange={event => setToDate(event.target.value)} /></label></>}
      <div className="rm-report-toolbar-actions">
        {optionalColumns.length > 0 && <details className="rm-report-columns"><summary><SlidersHorizontal size={14} />Columns</summary><div className="rm-report-column-options">{optionalColumns.map(column => <label key={column.key}><input type="checkbox" checked={extraColumns.includes(column.key)} onChange={event => { const next = event.target.checked ? [...extraColumns, column.key] : extraColumns.filter(key => key !== column.key); setExtraColumns(next); savePreference(selected, "columns", next); }} />{column.label}</label>)}</div></details>}
        <button className="rm-button" type="button" onClick={() => downloadCsv(`rent-ops-${selected}-${asOfDate}.csv`, buildReportCsv(exportRows, exportColumns))} disabled={!loadedRows}><Download size={14} />CSV</button>
        <button className="rm-button" type="button" onClick={() => window.print()} disabled={!loadedRows}><Printer size={14} />Print</button>
      </div>
    </div>
    <h2 className="rm-report-print-title">{config.label} · {asOfDate}</h2>
    {error && <p className="rm-error" role="alert"><AlertCircle aria-hidden="true" />{error}</p>}
    {loading && !loadedRows && <div className="rm-empty"><Loader2 className="rm-spin" aria-hidden="true" />{emptyReportMessage(false)}</div>}
    {loadedRows && <div className="rm-report-table-scroll"><table className="rm-table rm-grouped-report-table" aria-label={config.label}>
      <thead><tr>{activeColumns.map(column => <th key={column.key} className={column.align === "right" ? "rm-report-number" : undefined} aria-sort={sort.key === column.key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}><button type="button" onClick={() => { const next = { key: column.key, direction: sort.key === column.key && sort.direction === "asc" ? "desc" as const : "asc" as const }; setSort(next); savePreference(selected, "sort", next); }}>{column.label}{sort.key === column.key && (sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>)}</tr></thead>
      {groups.map(group => <tbody key={group.propertyId ?? group.label}>
        <tr className="rm-report-property-heading"><th colSpan={activeColumns.length} scope="rowgroup"><RecordLink kind="property" recordId={group.propertyId} onOpen={onOpenProperty}>{group.label}</RecordLink></th></tr>
        {group.rows.map(row => <tr key={reportRowKey(row)}>{activeColumns.map(column => <td key={column.key} className={column.align === "right" ? "rm-report-number" : undefined}><ReportCell row={row} column={column} onOpenTenant={onOpenTenant} onOpenUnit={onOpenUnit} onOpenProperty={onOpenProperty} /></td>)}</tr>)}
        <tr className="rm-report-property-total">{activeColumns.map((column, index) => <td key={column.key} className={column.align === "right" ? "rm-report-number" : undefined}>{index === 0 ? `Subtotal · ${group.count} ${selected === "delinquency" ? "accounts" : selected === "rent-roll" || selected === "occupancy" ? "units" : "rows"}` : column.subtotal ? formatReportValue(group.amounts[column.key], column.format) : ""}</td>)}</tr>
      </tbody>)}
    </table>{!groups.length && <div className="rm-empty">{emptyReportMessage(true)}</div>}</div>}
  </section>;
}
export default ReportsWorkspace;
