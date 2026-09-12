import { useRentOpsAuth } from "../auth-ui";
import { useQueries } from "@tanstack/react-query";
import { loadRentOpsReport } from "../api";
import { useMemo } from "react";
import { AlertCircle, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import type { GridColumn } from "./grid";
import { DataGrid } from "./grid";
import type { AdminSnapshot, DashboardSummary, ReportKey, ReportRow, ViewFilters } from "../types";
import {
  createReportViewModel,
  formatReportValue,
  reportQueryKey,
  reportQueryFilters,
  reportRowKey,
  type DisplayReportRow,
  type ReportColumnDefinition,
} from "./report-model";
import "./reports.css";

export interface DashboardWorkspaceProps {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  onReport: (report: ReportKey) => void;
  onOpenTenant?: (personId: string) => void;
  onOpenUnit?: (unitId: string) => void;
}

type MetricTone = "normal" | "good" | "warn";

interface DashboardMetric {
  label: string;
  value: string;
  detail?: string;
  tone?: MetricTone;
  onClick?: () => void;
}

function countValue(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "Needs review";
}

function ratioValue(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "Needs review";
  return `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
}

function moneyValue(value: unknown, known = true): string {
  return known ? formatReportValue(value, "currency") : "Needs review";
}

function occupiedValue(summary: DashboardSummary): string {
  if (!Number.isSafeInteger(summary.occupiedUnits) || !Number.isSafeInteger(summary.unitCount) || summary.occupiedUnits < 0 || summary.unitCount < 0) return "Needs review";
  return `${summary.occupiedUnits.toLocaleString("en-US")} / ${summary.unitCount.toLocaleString("en-US")}`;
}

export function dashboardMetrics(summary: DashboardSummary, onReport: (report: ReportKey) => void): DashboardMetric[] {
  const scheduledKnown = summary.scheduledRentCadenceComplete === true && summary.scheduledRentComplete !== false
    && (typeof summary.scheduledRentConfirmedCents === "number" || summary.scheduledRentComplete === true);
  const scheduled = summary.scheduledRentConfirmedCents ?? (summary.scheduledRentComplete === true ? summary.scheduledRentCents : undefined);
  const delinquencyKnown = summary.balanceComplete !== false && summary.rentOnlyDelinquencyCents !== null && summary.rentOnlyDelinquencyCents !== undefined;
  const vacancies = typeof summary.genuineVacantUnits === "number" && typeof summary.readyVacantUnits === "number"
    ? `${countValue(summary.genuineVacantUnits)} total · ${countValue(summary.readyVacantUnits)} ready`
    : "Needs review";
  return [
    { label: "Occupied units", value: occupiedValue(summary), detail: "Current / total", onClick: () => onReport("occupancy") },
    { label: "Physical occupancy", value: ratioValue(summary.physicalOccupancyPercent), onClick: () => onReport("occupancy") },
    { label: "Vacant units", value: vacancies, detail: summary.notReadyUnits !== undefined ? `${countValue(summary.notReadyUnits)} not ready` : undefined, tone: summary.readyVacantUnits ? "warn" : "good", onClick: () => onReport("occupancy") },
    { label: "Scheduled rent", value: moneyValue(scheduled, scheduledKnown), detail: scheduledKnown ? "Confirmed configuration" : "Configuration needs review", tone: scheduledKnown ? "normal" : "warn", onClick: () => onReport("scheduled-income") },
    { label: "Collected rent", value: moneyValue(summary.collectedRentCents), detail: "Posted receipts", onClick: () => onReport("collected-income") },
    { label: "Rent delinquency", value: moneyValue(summary.rentOnlyDelinquencyCents, delinquencyKnown), detail: delinquencyKnown ? "Rent-only balance" : "Balance needs review", tone: delinquencyKnown && summary.rentOnlyDelinquencyCents ? "warn" : delinquencyKnown ? "good" : "warn", onClick: () => onReport("delinquency") },
    { label: "Applications", value: countValue(summary.applicationsSubmitted), detail: summary.applicationsMissingInformation === undefined ? undefined : `${countValue(summary.applicationsMissingInformation)} missing information`, onClick: () => onReport("applicant-pipeline") },
    { label: "Deposit liability", value: moneyValue(summary.securityDepositLiabilityCents), detail: "Held liability", onClick: () => onReport("security-deposit") },
  ];
}

function rowPersonId(row: ReportRow): string | undefined {
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
  const source = row.__source;
  const personId = rowPersonId(source);
  if (personId && onOpenTenant) {
    onOpenTenant(personId);
    return;
  }
  const unitId = rowUnitId(source);
  if (unitId && onOpenUnit) onOpenUnit(unitId);
}

function gridColumns(columns: readonly ReportColumnDefinition[]): GridColumn<DisplayReportRow>[] {
  return columns.map((column) => ({
    key: column.key,
    label: column.label,
    align: column.align,
    width: column.format === "currency" ? 132 : column.key === "description" ? 220 : undefined,
    render: (row) => formatReportValue(row[column.key], column.format),
    sortValue: (row) => row[column.key] == null ? undefined : typeof row[column.key] === "number" ? row[column.key] as number : String(row[column.key]),
  }));
}

function MetricCard({ metric }: { metric: DashboardMetric }) {
  const content = <><span>{metric.label}</span><strong>{metric.value}</strong>{metric.detail && <small>{metric.detail}</small>}</>;
  return metric.onClick
    ? <button type="button" className={`rm-stat rm-stat-${metric.tone ?? "normal"}`} onClick={metric.onClick}>{content}</button>
    : <div className={`rm-stat rm-stat-${metric.tone ?? "normal"}`}>{content}</div>;
}

function Widget({
  report,
  rows,
  loading,
  error,
  snapshot,
  onReport,
  onOpenTenant,
  onOpenUnit,
}: {
  report: ReportKey;
  rows?: ReportRow[];
  loading: boolean;
  error?: string;
  snapshot: AdminSnapshot;
  onReport: (report: ReportKey) => void;
  onOpenTenant?: (personId: string) => void;
  onOpenUnit?: (unitId: string) => void;
}) {
  const view = useMemo(() => createReportViewModel(report, rows ?? [], snapshot), [report, rows, snapshot]);
  const columns = useMemo(() => view.curatedColumns.slice(0, 8), [view.curatedColumns]);
  const displayRows = view.displayRows;
  const handler = onOpenTenant || onOpenUnit ? (row: DisplayReportRow) => openRow(row, onOpenTenant, onOpenUnit) : undefined;
  const title = report === "rent-roll" ? "Rent roll preview" : "Delinquency preview";
  return (
    <section className="rm-panel rm-dashboard-widget">
      <header className="rm-panel-title">
        <div><span className="rm-muted">{rows ? `${rows.length.toLocaleString("en-US")} rows` : "Selected report"}</span><h2>{title}</h2></div>
        <button type="button" className="rm-button" onClick={() => onReport(report)}>Open report <ArrowRight aria-hidden="true" /></button>
      </header>
      {error && <p className="rm-error" role="alert"><AlertCircle aria-hidden="true" /> {error}</p>}
      {loading && !rows && <div className="rm-empty"><Loader2 className="rm-spin" aria-hidden="true" /><p>Loading selected report…</p></div>}
      {rows && <DataGrid rows={displayRows} columns={gridColumns(columns)} getRowKey={(row) => reportRowKey(row)} onRow={handler} pageSize={6} emptyMessage="No records returned for this view." caption={title} storageKey={`rent-ops-dashboard-${report}`} />}
    </section>
  );
}

export function DashboardWorkspace({ snapshot, filters, onReport, onOpenTenant, onOpenUnit }: DashboardWorkspaceProps) {
  const auth = useRentOpsAuth();
  const widgetReports = ["rent-roll", "delinquency"] as const;
  const queries = useQueries({ queries: widgetReports.map((report) => {
    const query = reportQueryFilters(filters, report, { asOfDate: filters.asOfDate });
    return { queryKey: reportQueryKey(report, query, auth.user?.id ?? ""), staleTime: 30_000, gcTime: 300_000, enabled: auth.status === "authenticated" && Boolean(auth.user?.id), queryFn: ({ signal }: { signal: AbortSignal }) => loadRentOpsReport(report, query, signal) };
  }) });
  const widgetRows = { "rent-roll": queries[0].data, delinquency: queries[1].data };
  const widgetErrors = { "rent-roll": queries[0].error?.message, delinquency: queries[1].error?.message };
  const loading = queries.some((query) => query.isFetching);

  const metrics = useMemo(() => dashboardMetrics(snapshot.summary, onReport), [snapshot.summary, onReport]);
  const vacancyDetail = [
    ["Future preleased", countValue(snapshot.summary.futurePreleasedUnits)],
    ["Genuine vacant", countValue(snapshot.summary.genuineVacantUnits)],
    ["Ready vacant", countValue(snapshot.summary.readyVacantUnits)],
    ["Not ready", countValue(snapshot.summary.notReadyUnits)],
    ["Off market", countValue(snapshot.summary.offMarketUnits)],
  ];

  return (
    <section className="rm-dashboard-workspace" aria-label="Rent Operations dashboard">
      <header className="rm-dashboard-heading">
        <div><span className="rm-muted">Operating summary · as of {snapshot.summary.asOfDate || "Needs review"}</span><h2>Dashboard</h2></div>
        {loading && <span className="rm-status"><RefreshCw className="rm-spin" aria-hidden="true" /> Refreshing previews</span>}
      </header>
      <div className="rm-dashboard-grid">{metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}</div>
      {(snapshot.summary.balanceComplete === false || snapshot.summary.scheduledRentComplete === false) && <p className="rm-warning" role="status"><AlertCircle aria-hidden="true" /> {snapshot.summary.balanceComplete === false ? "Some account balances need review because the available history is incomplete." : "Some recurring income facts need review before the scheduled total is confirmed."}</p>}
      <section className="rm-panel rm-dashboard-vacancy">
        <header className="rm-panel-title"><div><span className="rm-muted">Unit status</span><h2>Vacancy and pipeline</h2></div><button type="button" className="rm-button" onClick={() => onReport("occupancy")}>Open occupancy <ArrowRight aria-hidden="true" /></button></header>
        <div className="rm-dashboard-counts">{vacancyDetail.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <div className="rm-dashboard-links"><button type="button" className="rm-button" onClick={() => onReport("applicant-pipeline")}>Review applications <ArrowRight aria-hidden="true" /></button><button type="button" className="rm-button" onClick={() => onReport("lease-expiration")}>Review lease dates <ArrowRight aria-hidden="true" /></button></div>
      </section>
      <div className="rm-dashboard-widget-grid">
        <Widget report="rent-roll" rows={widgetRows["rent-roll"]} loading={loading} error={widgetErrors["rent-roll"]} snapshot={snapshot} onReport={onReport} onOpenTenant={onOpenTenant} onOpenUnit={onOpenUnit} />
        <Widget report="delinquency" rows={widgetRows.delinquency} loading={loading} error={widgetErrors.delinquency} snapshot={snapshot} onReport={onReport} onOpenTenant={onOpenTenant} onOpenUnit={onOpenUnit} />
      </div>
    </section>
  );
}

export default DashboardWorkspace;
