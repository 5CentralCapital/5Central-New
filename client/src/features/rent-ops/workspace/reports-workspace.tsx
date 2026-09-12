import { useRentOpsAuth } from "../auth-ui";
import { useQuery } from "@tanstack/react-query";
import { loadRentOpsReport } from "../api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Download, Loader2, Printer, RefreshCw } from "lucide-react";
import type { GridColumn } from "./grid";
import { DataGrid } from "./grid";
import type { AdminSnapshot, ReportKey, ReportRow, ViewFilters } from "../types";
import {
  REPORT_PERIODS,
  buildPropertySubtotals,
  buildReportCsv,
  projectReportGridView,
  createReportViewModel,
  emptyReportMessage,
  formatReportValue,
  getReportConfig,
  reportQueryKey,
  reportPeriodLabel,
  reportQueryFilters,
  reportRowKey,
  reportKeys,
  toDisplayReportRows,
  validateReportPeriod,
  type DisplayReportRow,
  type ReportColumnDefinition,
} from "./report-model";
import "./reports.css";

export interface ReportsWorkspaceProps {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  selected: ReportKey;
  onSelect: (key: ReportKey) => void;
  onOpenTenant?: (personId: string) => void;
  onOpenUnit?: (unitId: string) => void;
}

function firstDayOfMonth(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(0, 7)}-01` : "";
}

function rowPersonId(row: ReportRow): string | undefined {
  const value = rowPersonValue(row);
  return typeof value === "string" && value.length ? value : undefined;
}

function rowPersonValue(row: ReportRow): unknown {
  if ("personId" in row && typeof row.personId === "string") return row.personId;
  if ("currentPersonId" in row && typeof row.currentPersonId === "string") return row.currentPersonId;
  if ("futurePersonId" in row && typeof row.futurePersonId === "string") return row.futurePersonId;
  if ("transaction" in row && row.transaction && typeof row.transaction.personId === "string") return row.transaction.personId;
  return undefined;
}

function rowUnitId(row: ReportRow): string | undefined {
  if ("unitId" in row && typeof row.unitId === "string") return row.unitId;
  if ("transaction" in row && row.transaction && typeof row.transaction.unitId === "string") return row.transaction.unitId;
  return undefined;
}

function openRow(row: DisplayReportRow, onOpenTenant?: (personId: string) => void, onOpenUnit?: (unitId: string) => void): void {
  const personId = rowPersonId(row.__source);
  if (personId && onOpenTenant) {
    onOpenTenant(personId);
    return;
  }
  const unitId = rowUnitId(row.__source);
  if (unitId && onOpenUnit) onOpenUnit(unitId);
}

function sortableValue(value: unknown, format: ReportColumnDefinition["format"]): string | number | null | undefined {
  if (value == null || value === "") return undefined;
  if (format === "currency" || format === "integer" || format === "percent") return typeof value === "number" ? value : undefined;
  return typeof value === "string" ? value : formatReportValue(value, format);
}

function makeGridColumns(columns: readonly ReportColumnDefinition[]): GridColumn<DisplayReportRow>[] {
  return columns.map((column) => ({
    key: column.key,
    label: column.label,
    align: column.align,
    width: column.format === "currency" ? 132 : column.key === "description" ? 230 : undefined,
    render: (row) => formatReportValue(row[column.key], column.format),
    sortValue: (row) => sortableValue(row[column.key], column.format),
  }));
}

function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ReportSubtotals({
  keyName,
  rows,
  columns,
  snapshot,
}: {
  keyName: ReportKey;
  rows: readonly ReportRow[];
  columns: readonly ReportColumnDefinition[];
  snapshot: AdminSnapshot;
}) {
  const subtotals = useMemo(() => buildPropertySubtotals(keyName, rows, snapshot), [keyName, rows, snapshot]);
  const subtotalColumns = columns.filter((column) => column.subtotal);
  if (!subtotals.length) return null;
  return (
    <div className="rm-report-subtotals" aria-label="Property subtotals">
      {subtotals.map((subtotal) => (
        <article key={subtotal.propertyId ?? subtotal.label}>
          <div><strong>{subtotal.label}</strong><span>{subtotal.count.toLocaleString("en-US")} {subtotal.count === 1 ? "row" : "rows"}</span></div>
          {subtotalColumns.map((column) => (
            <dl key={column.key}>
              <dt>{column.label}</dt>
              <dd>{formatReportValue(subtotal.amounts[column.key], column.format)}</dd>
            </dl>
          ))}
        </article>
      ))}
    </div>
  );
}

function ReportControls({
  selected,
  onSelect,
  asOfDate,
  month,
  fromDate,
  toDate,
  setAsOfDate,
  setMonth,
  setFromDate,
  setToDate,
  onReload,
  loading,
}: {
  selected: ReportKey;
  onSelect: (key: ReportKey) => void;
  asOfDate: string;
  month: string;
  fromDate: string;
  toDate: string;
  setAsOfDate: (value: string) => void;
  setMonth: (value: string) => void;
  setFromDate: (value: string) => void;
  setToDate: (value: string) => void;
  onReload: () => void;
  loading: boolean;
}) {
  const mode = REPORT_PERIODS[selected];
  return (
    <div className="rm-report-toolbar" aria-label="Report controls">
      <label className="rm-report-control rm-report-control-wide">Report
        <select value={selected} onChange={(event) => onSelect(event.target.value as ReportKey)}>
          {reportKeys().map((key) => <option key={key} value={key}>{getReportConfig(key).label}</option>)}
        </select>
      </label>
      <label className="rm-report-control">As of
        <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
      </label>
      {mode === "month" && <label className="rm-report-control">Month
        <input type="month" value={month} max={asOfDate.slice(0, 7)} onChange={(event) => setMonth(event.target.value)} />
      </label>}
      {mode === "range" && <>
        <label className="rm-report-control">From
          <input type="date" value={fromDate} max={asOfDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="rm-report-control">Through
          <input type="date" value={toDate} max={asOfDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
      </>}
      <button className="rm-button" type="button" onClick={onReload} disabled={loading}>
        <RefreshCw aria-hidden="true" className={loading ? "rm-spin" : undefined} /> {loading ? "Loading" : "Refresh"}
      </button>
    </div>
  );
}

export function ReportsWorkspace({ snapshot, filters, selected, onSelect, onOpenTenant, onOpenUnit }: ReportsWorkspaceProps) {
  const auth = useRentOpsAuth();
  const [asOfDate, setAsOfDate] = useState(filters.asOfDate);
  const [month, setMonth] = useState(filters.asOfDate.slice(0, 7));
  const [fromDate, setFromDate] = useState(firstDayOfMonth(filters.asOfDate));
  const [toDate, setToDate] = useState(filters.asOfDate);
  const [gridView, setGridView] = useState<ReturnType<typeof projectReportGridView>>();

  useEffect(() => {
    setAsOfDate(filters.asOfDate);
    setMonth(filters.asOfDate.slice(0, 7));
    setFromDate(firstDayOfMonth(filters.asOfDate));
    setToDate(filters.asOfDate);
  }, [filters.asOfDate]);

  useEffect(() => {
    setMonth(asOfDate.slice(0, 7));
    setFromDate(firstDayOfMonth(asOfDate));
    setToDate(asOfDate);

  }, [selected]);

  const periodError = validateReportPeriod(selected, asOfDate, month, fromDate, toDate);
  const queryFilters = useMemo(
    () => reportQueryFilters(filters, selected, { asOfDate, month, fromDate, toDate }),
    [filters.propertyId, filters.propertyScope, filters.search, filters.status, selected, asOfDate, month, fromDate, toDate],
  );
  const reportQuery = useQuery({
    queryKey: reportQueryKey(selected, queryFilters, auth.user?.id ?? ""),
    staleTime: 30_000,
    gcTime: 300_000,
    queryFn: ({ signal }) => loadRentOpsReport(selected, queryFilters, signal),
    enabled: auth.status === "authenticated" && Boolean(auth.user?.id) && !periodError,
  });
  const loadedRows = periodError ? undefined : reportQuery.data;
  const loading = !periodError && reportQuery.isFetching;
  const error = periodError ?? (reportQuery.error instanceof Error ? reportQuery.error.message : reportQuery.error ? "The selected report could not be loaded." : undefined);
  const visibleSourceRows = loadedRows ?? [];
  const view = useMemo(
    () => createReportViewModel(selected, visibleSourceRows, snapshot),
    [selected, visibleSourceRows, snapshot],
  );
  const gridColumns = useMemo(() => makeGridColumns(view.columns).map((column, index) => ({
    ...column, hidden: view.columns[index].curated === false,
  })), [view.columns]);
  const displayedRows = useMemo(() => toDisplayReportRows(selected, visibleSourceRows, snapshot), [selected, visibleSourceRows, snapshot]);
  const handleGridView = useCallback((rows: DisplayReportRow[], columns: GridColumn<DisplayReportRow>[]) => {
    const next = projectReportGridView(rows, columns.map(column => column.key));
    setGridView(current => current?.signature === next.signature ? current : next);
  }, []);
  const exportRows = gridView?.rows ?? displayedRows;
  const activeColumns = gridView
    ? gridView.columnKeys.map(key => view.columns.find(column => column.key === key)).filter((column): column is ReportColumnDefinition => Boolean(column))
    : view.curatedColumns;
  const rowHandler = onOpenTenant || onOpenUnit ? (row: DisplayReportRow) => openRow(row, onOpenTenant, onOpenUnit) : undefined;
  const periodLabel = reportPeriodLabel(selected, asOfDate, month, fromDate, toDate);
  const config = getReportConfig(selected);

  const saveCsv = () => downloadCsv(`rent-ops-${selected}-${asOfDate}.csv`, buildReportCsv(exportRows, activeColumns));

  return (
    <section className="rm-report-workspace" aria-label="Rent Operations reports">
      <ReportControls
        selected={selected}
        onSelect={onSelect}
        asOfDate={asOfDate}
        month={month}
        fromDate={fromDate}
        toDate={toDate}
        setAsOfDate={setAsOfDate}
        setMonth={setMonth}
        setFromDate={setFromDate}
        setToDate={setToDate}
        onReload={() => { void reportQuery.refetch(); }}
        loading={loading}
      />
      <section className="rm-panel rm-report-panel">
        <header className="rm-panel-title rm-report-heading">
          <div>
            <span className="rm-muted">{periodLabel}</span>
            <h2>{config.label}</h2>
          </div>
          <div className="rm-report-actions">
            <button className="rm-button" type="button" onClick={saveCsv} disabled={!loadedRows || !activeColumns.length}><Download aria-hidden="true" /> CSV</button>
            <button className="rm-button" type="button" onClick={() => window.print()} disabled={!loadedRows}><Printer aria-hidden="true" /> Print</button>
          </div>
        </header>

        {error && <p className="rm-error" role="alert"><AlertCircle aria-hidden="true" /> {error}</p>}
        {loading && !loadedRows && <div className="rm-empty"><Loader2 className="rm-spin" aria-hidden="true" /><p>{emptyReportMessage(false)}</p></div>}
        {loadedRows && (
          <>
            <ReportSubtotals keyName={selected} rows={visibleSourceRows} columns={activeColumns} snapshot={snapshot} />
            <div className="rm-report-screen-grid"><DataGrid
              key={selected}
              rows={displayedRows}
              onViewChange={handleGridView}
              columns={gridColumns}
              getRowKey={(row) => reportRowKey(row)}
              onRow={rowHandler}
              emptyMessage={emptyReportMessage(true)}
              pageSize={25}
              caption={`${config.label} · ${periodLabel}`}
              storageKey={`rent-ops-report-${selected}`}
            /></div>
            <table className="rm-table rm-report-print-table">
              <thead><tr>{activeColumns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead>
              <tbody>{exportRows.map(row => <tr key={reportRowKey(row)}>{activeColumns.map(column => <td key={column.key}>{formatReportValue(row[column.key], column.format)}</td>)}</tr>)}</tbody>
            </table>
          </>
        )}
        {!loading && !error && !loadedRows && <div className="rm-empty"><p>{emptyReportMessage(false)}</p></div>}
      </section>
    </section>
  );
}

export default ReportsWorkspace;
