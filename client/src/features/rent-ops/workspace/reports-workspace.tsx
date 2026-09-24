import { useRentOpsAuth } from "../auth-ui";
import { useQuery } from "@tanstack/react-query";
import { loadRentOpsReport } from "../api";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Download, Loader2, Printer, SlidersHorizontal } from "lucide-react";
import type { AdminSnapshot, ReportKey, ReportRow, TenantTab, ViewFilters } from "../types";
import { EntityLink, RecordLink } from "./entity-link";
import {
  createReportViewModel,
  emptyReportMessage,
  formatReportCellValue,
  formatReportValue,
  getReportConfig,
  groupReportRows,
  readReportValue,
  reportCellPersonId,
  reportKeys,
  reportQueryKey,
  reportPeriodLabel,
  reportRowKey,
  type DisplayReportRow,
  type ReportColumnDefinition,
} from "./report-model";
import { ReportExportDialog } from "./report-export-dialog";
import {
  applyReportSetupLocalFilters,
  createInitialReportSetup,
  normalizeReportSetup,
  reportSetupEqual,
  reportSetupFromUrlValue,
  reportSetupLocalFilters,
  reportSetupQueryFilters,
  reportSetupSearch,
  reportSetupToUrlValue,
  reportSetupUrlKey,
  validateReportSetup,
  type ReportSetupDirectory,
  type ReportSetupState,
} from "./report-setup-model";
import { ReportSetup } from "./report-setup";
import { ListTotals, exactCentsMetric } from "./list-totals";
import { summarizeExactCents, type CentsValue } from "./list-totals-model";
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
  /** Optional unscoped directory loaded for report reference controls. */
  directory?: ReportSetupDirectory;
  /** False while the report page only has the active global directory snapshot. */
  allowAllScope?: boolean;
}

const primaryReports: ReportKey[] = ["rent-roll", "occupancy", "delinquency"];

function reportCentsValue(value: unknown): CentsValue {
  return typeof value === "bigint" || typeof value === "number" || typeof value === "string" || value == null ? value : null;
}

function reportItemLabel(key: ReportKey): string {
  if (key === "rent-roll" || key === "occupancy" || key === "lease-expiration" || key === "security-deposit") return "unit row";
  if (key === "delinquency") return "account";
  if (key === "tenant-ledger") return "transaction";
  if (key === "applicant-pipeline") return "application";
  return "report row";
}

function readPreference<T>(report: ReportKey, key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const value = new URLSearchParams(window.location.search).get(`r_${report}_${key}`);
  if (value === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(fallback)) return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed as T : fallback;
    if (fallback && typeof fallback === "object") return parsed && typeof parsed === "object" && "key" in parsed && typeof (parsed as { key?: unknown }).key === "string" && "direction" in parsed && ["asc", "desc"].includes(String((parsed as { direction?: unknown }).direction)) ? parsed as T : fallback;
    return typeof parsed === typeof fallback ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function savePreference(report: ReportKey, key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(`r_${report}_${key}`, JSON.stringify(value));
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function rowId(row: ReportRow, key: string): string | undefined {
  const value = readReportValue(row, key);
  return typeof value === "string" && value.length ? value : undefined;
}

function renderReportCell({ row, column, onOpenTenant, onOpenUnit, onOpenProperty }: {
  row: DisplayReportRow; column: ReportColumnDefinition;
} & Pick<ReportsWorkspaceProps, "onOpenTenant" | "onOpenUnit" | "onOpenProperty">) {
  const label = formatReportCellValue(row, column);
  const source = row.__source;
  if (column.key === "unitNumber") return <RecordLink kind="unit" recordId={rowId(source, "unitId")} onOpen={onOpenUnit}>{label}</RecordLink>;
  if (column.key === "propertyName") return <RecordLink kind="property" recordId={rowId(source, "propertyId")} onOpen={onOpenProperty}>{label}</RecordLink>;
  const tenantField = ["tenantName", "currentTenantName", "futureTenantName"].includes(column.key);
  const recurringField = ["baseRentCents", "recurringFeesCents", "totalScheduledCents", "subsidyCents"].includes(column.key);
  const balanceField = ["operationalBalanceCents", "balanceDueCents", "totalBalanceCents", "rentOnlyBalanceCents", "nonRentBalanceCents", "unappliedCashCents"].includes(column.key);
  if (tenantField || recurringField || balanceField) {
    const personId = reportCellPersonId(source, column.key);
    return <EntityLink personId={personId} tab={recurringField ? "charges" : balanceField ? "ledger" : "summary"} onOpen={onOpenTenant}>{label}</EntityLink>;
  }
  return label;
}

function directoryFromSnapshot(snapshot: AdminSnapshot): ReportSetupDirectory {
  return {
    properties: snapshot.snapshot.properties,
    units: snapshot.snapshot.units,
    people: snapshot.snapshot.people,
    tenancies: snapshot.snapshot.tenancies,
  };
}

function createReportRunToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Each report now waits for an explicit Run report submission. */
export function ReportsWorkspace(props: ReportsWorkspaceProps) {
  return <ReportWorkspaceView key={`${props.selected}:${props.directory ? "directory" : "scoped"}`} {...props} />;
}

function ReportWorkspaceView({ snapshot, filters, selected, onSelect, onOpenTenant, onOpenUnit, onOpenProperty, directory: providedDirectory, allowAllScope = false }: ReportsWorkspaceProps) {
  const auth = useRentOpsAuth();
  const directory = providedDirectory ?? directoryFromSnapshot(snapshot);
  // The report request may span properties outside the global workspace
  // snapshot. Use the unscoped report directory for labels and export
  // projection while retaining the other collections from the workspace.
  const reportSnapshot = useMemo<AdminSnapshot>(() => providedDirectory ? {
    ...snapshot,
    snapshot: {
      ...snapshot.snapshot,
      properties: [...providedDirectory.properties],
      units: [...providedDirectory.units],
      people: [...providedDirectory.people],
      tenancies: [...providedDirectory.tenancies],
    },
  } : snapshot, [providedDirectory, snapshot]);
  const [draft, setDraft] = useState<ReportSetupState>(() => {
    const fallback = createInitialReportSetup(selected, filters, directory);
    return reportSetupFromUrlValue(selected, new URLSearchParams(window.location.search).get(reportSetupUrlKey(selected)), fallback, directory);
  });
  const [applied, setApplied] = useState<ReportSetupState>();
  // A new token on every explicit submission prevents a previously completed
  // query from satisfying Run/Update from React Query's stale cache.
  const [runToken, setRunToken] = useState(createReportRunToken);

  useEffect(() => {
    const normalized = normalizeReportSetup(selected, draft, directory);
    if (!reportSetupEqual(normalized, draft)) setDraft(normalized);
  }, [directory, selected]);

  useEffect(() => {
    const restoreFromLocation = () => {
      const fallback = createInitialReportSetup(selected, filters, directory);
      setDraft(reportSetupFromUrlValue(selected, new URLSearchParams(window.location.search).get(reportSetupUrlKey(selected)), fallback, directory));
      setApplied(undefined);
      setRunToken(createReportRunToken());
    };
    window.addEventListener("popstate", restoreFromLocation);
    return () => window.removeEventListener("popstate", restoreFromLocation);
  }, [directory, filters, selected]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set(reportSetupUrlKey(selected), reportSetupToUrlValue(draft));
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [draft, selected]);

  const draftError = validateReportSetup(selected, draft);
  const dirty = !!applied && !reportSetupEqual(applied, draft);
  const queryFilters = useMemo(() => applied ? reportSetupQueryFilters(selected, applied) : undefined, [applied, selected]);
  const reportQuery = useQuery({
    queryKey: queryFilters && !dirty ? [...reportQueryKey(selected, queryFilters, auth.user?.id ?? ""), runToken] : ["rent-ops-workspace", "report-setup", auth.user?.id ?? "", selected],
    queryFn: ({ signal }) => loadRentOpsReport(selected, queryFilters!, signal),
    enabled: auth.status === "authenticated" && Boolean(auth.user?.id) && Boolean(applied) && !dirty && !draftError,
    staleTime: 30_000,
    gcTime: 300_000,
  });
  const loadedRows = applied && !dirty && !draftError ? reportQuery.data : undefined;
  const loading = !!applied && !dirty && !draftError && reportQuery.isFetching;
  const error = draftError ?? (reportQuery.error instanceof Error ? reportQuery.error.message : reportQuery.error ? "The selected report could not be loaded." : undefined);
  const submitted = applied ?? draft;
  const visibleRows = useMemo(() => loadedRows ? applyReportSetupLocalFilters(loadedRows, selected, submitted) : [], [loadedRows, selected, submitted]);
  const view = useMemo(() => createReportViewModel(selected, visibleRows, reportSnapshot), [selected, visibleRows, reportSnapshot]);
  const [extraColumnKeys, setExtraColumnKeys] = useState<string[]>(() => readPreference(selected, "columns", []));
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" }>(() => readPreference(selected, "sort", { key: "unitNumber", direction: "asc" }));
  const [activeExportFormat, setExportFormat] = useState<"csv" | "print" | null>(null);
  const activeColumns = useMemo(() => view.columns.filter(column => column.key !== "propertyName" && (column.curated !== false || extraColumnKeys.includes(column.key))), [view.columns, extraColumnKeys]);
  const optionalColumns = view.optionalColumns.filter(column => column.key !== "propertyName");
  const groups = useMemo(() => groupReportRows(selected, view.displayRows, reportSnapshot, sort), [selected, view.displayRows, reportSnapshot, sort]);
  const config = getReportConfig(selected);
  const reportTotalColumns = useMemo(() => activeColumns.filter(column => column.subtotal), [activeColumns]);
  const reportTotalMetrics = useMemo(() => reportTotalColumns.map((column) => exactCentsMetric(
    column.label,
    summarizeExactCents(view.displayRows.map((row) => reportCentsValue(column.read(row.__source, reportSnapshot)))),
  )), [reportSnapshot, reportTotalColumns, view.displayRows]);
  const localFilters = reportSetupLocalFilters(selected, submitted);
  const search = reportSetupSearch(selected, submitted);
  const changeColumns = (next: string[]) => { setExtraColumnKeys(next); savePreference(selected, "columns", next); };
  const changeSort = (next: { key: string; direction: "asc" | "desc" }) => { setSort(next); savePreference(selected, "sort", next); };

  const runReport = (next: ReportSetupState) => {
    const submittedState = normalizeReportSetup(selected, allowAllScope ? next : { ...next, propertyScope: "active" }, directory);
    setDraft(submittedState);
    setApplied(submittedState);
    setRunToken(createReportRunToken());
  };

  return <section className="rm-report-workspace rm-clean-report" aria-label="5Central Ops reports">
    <div className="rm-report-view-tabs" aria-label="Report views">
      {primaryReports.map(key => <button key={key} type="button" aria-pressed={selected === key} className={selected === key ? "active" : ""} onClick={() => onSelect(key)}>{getReportConfig(key).label}</button>)}
      <select aria-label="Other reports" value={primaryReports.includes(selected) ? "" : selected} onChange={event => onSelect(event.target.value as ReportKey)}>
        <option value="" disabled>Other reports</option>
        {reportKeys().filter(key => !primaryReports.includes(key)).map(key => <option key={key} value={key}>{getReportConfig(key).label}</option>)}
      </select>
    </div>
    <ReportSetup report={selected} value={draft} directory={directory} allowAllScope={allowAllScope} hasAppliedRun={!!applied} onChange={next => setDraft(normalizeReportSetup(selected, next, directory))} onRun={runReport} />
    {activeExportFormat && applied && !dirty && queryFilters && <ReportExportDialog report={selected} snapshot={reportSnapshot} queryFilters={queryFilters} format={activeExportFormat} onClose={() => setExportFormat(null)} localFilters={localFilters} search={search} extraColumns={extraColumnKeys} sort={sort} lockSelection />}
    {applied && !dirty && <header className="rm-report-print-title"><div className="rm-report-print-brand">5Central Capital</div><h2>{config.label}</h2><p>{submitted.propertyIds.length ? submitted.propertyIds.map(id => directory.properties.find(property => property.id === id)?.name ?? id).join(" · ") : submitted.propertyScope === "active" ? "Active portfolio" : "All properties"}</p><p>{reportPeriodLabel(selected, submitted.asOfDate, submitted.month, submitted.fromDate, submitted.toDate)}</p></header>}
    {error && applied && <p className="rm-error" role="alert"><AlertCircle aria-hidden="true" />{error}</p>}
    {loading && !loadedRows && <div className="rm-empty"><Loader2 className="rm-spin" aria-hidden="true" />{emptyReportMessage(false)}</div>}
    {applied && !dirty && <div data-report-results="true">
      <div className="rm-report-toolbar rm-report-results-toolbar" aria-label="Report actions">
        <div className="rm-report-toolbar-actions">
          {optionalColumns.length > 0 && <details className="rm-report-columns"><summary><SlidersHorizontal size={14} />Columns</summary><div className="rm-report-column-options">{optionalColumns.map(column => <label key={column.key}><input type="checkbox" checked={extraColumnKeys.includes(column.key)} onChange={event => { const next = event.target.checked ? [...extraColumnKeys, column.key] : extraColumnKeys.filter(key => key !== column.key); changeColumns(next); }} />{column.label}</label>)}</div></details>}
          <button className="rm-button" type="button" onClick={() => setExportFormat("csv")} disabled={!loadedRows}><Download size={14} />Export CSV</button>
          <button className="rm-button" type="button" onClick={() => setExportFormat("print")} disabled={!loadedRows}><Printer size={14} />Print / PDF</button>
        </div>
      </div>
      {loadedRows && <div className="rm-report-table-scroll"><table className="rm-table rm-grouped-report-table" aria-label={config.label}>
        <thead><tr>{activeColumns.map(column => <th key={column.key} className={column.align === "right" ? "rm-report-number" : undefined} aria-sort={sort.key === column.key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}><button type="button" onClick={() => { const next = { key: column.key, direction: sort.key === column.key && sort.direction === "asc" ? "desc" as const : "asc" as const }; changeSort(next); }}>{column.label}{sort.key === column.key && (sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>)}</tr></thead>
        {groups.map(group => <tbody key={group.propertyId ?? group.label}>
          <tr className="rm-report-property-heading"><th colSpan={activeColumns.length} scope="rowgroup"><RecordLink kind="property" recordId={group.propertyId} onOpen={onOpenProperty}>{group.label}</RecordLink></th></tr>
          {group.rows.map(row => <tr key={reportRowKey(row)}>{activeColumns.map(column => <td key={column.key} className={column.align === "right" ? "rm-report-number" : undefined}>{renderReportCell({ row, column, onOpenTenant, onOpenUnit, onOpenProperty })}</td>)}</tr>)}
          <tr className="rm-report-property-total">{activeColumns.map((column, index) => <td key={column.key} className={column.align === "right" ? "rm-report-number" : undefined}>{index === 0 ? `Subtotal · ${group.count} ${selected === "delinquency" ? "accounts" : selected === "rent-roll" || selected === "occupancy" ? "units" : "rows"}` : column.subtotal ? formatReportValue(group.amounts[column.key], column.format) : ""}</td>)}</tr>
        </tbody>)}
      </table>{!groups.length && <div className="rm-empty">{emptyReportMessage(true)}</div>}<ListTotals totalCount={loadedRows.length} visibleCount={view.displayRows.length} itemLabel={reportItemLabel(selected)} metrics={reportTotalMetrics} /></div>}
    </div>}
  </section>;
}

export default ReportsWorkspace;
