import {EntityLink,RecordLink} from "./entity-link";
import { useReportSearch } from "./use-report-search";
import { useRentOpsAuth } from "../auth-ui";
import { useQueries } from "@tanstack/react-query";
import { loadRentOpsReport, type RentOpsWorkspaceDashboard } from "../api";
import { useMemo } from "react";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import type { GridColumn } from "./grid";
import { DataGrid } from "./grid";
import type { AdminSnapshot, DashboardSummary, ReportKey, ReportRow, TenantTab, ViewFilters } from "../types";
import {
  createReportViewModel,
  formatReportValue,
  formatReportCellValue,
  reportQueryKey,
  reportQueryFilters,
  reportRowKey,
  reportCellPersonId,
  readReportValue,
  type DisplayReportRow,
  type ReportColumnDefinition,
} from "./report-model";
import "./reports.css";

export interface DashboardWorkspaceProps {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  onReport: (report: ReportKey) => void;
  onOpenTenant?: (personId: string,tab?:TenantTab) => void;
  onOpenUnit?: (unitId: string) => void;
  onOpenProperty?: (propertyId:string)=>void;
  previews?: RentOpsWorkspaceDashboard["reports"];
  refreshing?: boolean;
}

type MetricTone = "normal" | "good" | "warn";

interface DashboardMetric {
  label: string;
  value: string;
  tone?: MetricTone;
  onClick?: () => void;
}

function isValidCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function countValue(value: unknown): string {
  return isValidCount(value) ? value.toLocaleString("en-US") : "Needs review";
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

function unknownOccupancyCount(summary: DashboardSummary): number | undefined {
  const { unitCount, occupiedUnits, futurePreleasedUnits, genuineVacantUnits } = summary;
  if (![unitCount, occupiedUnits, futurePreleasedUnits, genuineVacantUnits].every(isValidCount)) return undefined;
  const unknown = unitCount - occupiedUnits - futurePreleasedUnits - genuineVacantUnits;
  return isValidCount(unknown) ? unknown : undefined;
}

export function dashboardMetrics(summary: DashboardSummary, onReport: (report: ReportKey) => void): DashboardMetric[] {
  const scheduledKnown = summary.scheduledRentCadenceComplete === true && summary.scheduledRentComplete !== false
    && (typeof summary.scheduledRentConfirmedCents === "number" || summary.scheduledRentComplete === true);
  const scheduled = summary.scheduledRentConfirmedCents ?? (summary.scheduledRentComplete === true ? summary.scheduledRentCents : undefined);
  const delinquencyKnown = summary.operationalBalanceUnresolvedCount === 0 && typeof summary.operationalDelinquencyCents === "number";
  return [
    { label: "Occupied units", value: occupiedValue(summary), onClick: () => onReport("occupancy") },
    { label: "Physical occupancy", value: ratioValue(summary.physicalOccupancyPercent), onClick: () => onReport("occupancy") },
    { label: "Confirmed vacant", value: countValue(summary.genuineVacantUnits), onClick: () => onReport("occupancy") },
    { label: "Scheduled rent", value: moneyValue(scheduled, scheduledKnown), tone: scheduledKnown ? "normal" : "warn", onClick: () => onReport("scheduled-income") },
    { label: "Posted rent receipts", value: moneyValue(summary.collectedRentCents), onClick: () => onReport("collected-income") },
    { label: "Current balances due", value: moneyValue(summary.operationalDelinquencyCents, delinquencyKnown), tone: delinquencyKnown && summary.operationalDelinquencyCents ? "warn" : delinquencyKnown ? "good" : "warn", onClick: () => onReport("delinquency") },
    { label: "Applications", value: countValue(summary.applicationsSubmitted), onClick: () => onReport("applicant-pipeline") },
    { label: "Deposit liability", value: moneyValue(summary.securityDepositLiabilityCents), onClick: () => onReport("security-deposit") },
  ];
}

export function dashboardColumns(report: ReportKey, columns: readonly ReportColumnDefinition[]): ReportColumnDefinition[] {
  const keys = report === "rent-roll"
    ? ["propertyName", "unitNumber", "currentTenantName", "baseRentCents", "totalScheduledCents", "operationalBalanceCents"]
    : ["propertyName", "unitNumber", "tenantName", "operationalBalanceCents", "totalBalanceCents"];
  return keys.map(key => columns.find(column => column.key === key)).filter((column): column is ReportColumnDefinition => Boolean(column));
}

export function gridColumns(columns: readonly ReportColumnDefinition[], navigation: Pick<DashboardWorkspaceProps, "onOpenTenant" | "onOpenUnit" | "onOpenProperty"> = {}): GridColumn<DisplayReportRow>[] {
  return columns.map((column) => ({
    key: column.key,
    label: column.label,
    align: column.align,
    width: column.format === "currency" ? 132 : column.key === "description" ? 220 : undefined,
    render: (row) => {
      const label=formatReportCellValue(row, column);
      const id=(key:string)=>{const value=readReportValue(row.__source,key);return typeof value==='string'?value:undefined;};
      if(column.key==='unitNumber')return <RecordLink kind="unit" recordId={id('unitId')} onOpen={navigation.onOpenUnit}>{label}</RecordLink>;
      if(column.key==='propertyName')return <RecordLink kind="property" recordId={id('propertyId')} onOpen={navigation.onOpenProperty}>{label}</RecordLink>;
      const tenant=['tenantName','currentTenantName','futureTenantName'].includes(column.key);
      const recurring=['baseRentCents','recurringFeesCents','totalScheduledCents','subsidyCents'].includes(column.key);
      const balance=['operationalBalanceCents','balanceDueCents','totalBalanceCents','rentOnlyBalanceCents','nonRentBalanceCents','unappliedCashCents'].includes(column.key);
      return tenant||recurring||balance?<EntityLink personId={reportCellPersonId(row.__source,column.key)} tab={recurring?'charges':balance?'ledger':'summary'} onOpen={navigation.onOpenTenant}>{label}</EntityLink>:label;
    },
    sortValue: (row) => row[column.key] == null ? undefined : typeof row[column.key] === "number" ? row[column.key] as number : String(row[column.key]),
  }));
}

function MetricCard({ metric }: { metric: DashboardMetric }) {
  const content = <><span>{metric.label}</span><strong>{metric.value}</strong></>;
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
  onOpenProperty,
}: {
  report: ReportKey;
  rows?: ReportRow[];
  loading: boolean;
  error?: string;
  snapshot: AdminSnapshot;
  onReport: (report: ReportKey) => void;
  onOpenTenant?: (personId: string,tab?:TenantTab) => void;
  onOpenUnit?: (unitId: string) => void;
  onOpenProperty?: (propertyId:string)=>void;
}) {
  const view = useMemo(() => createReportViewModel(report, rows ?? [], snapshot), [report, rows, snapshot]);
  const columns = useMemo(() => dashboardColumns(report, view.columns), [report, view.columns]);
  const displayRows = view.displayRows;
  const title = report === "rent-roll" ? "Rent roll" : "Balances due";
  return (
    <section className="rm-panel rm-dashboard-widget" aria-label={title}>
      <header className="rm-panel-title">
        <h2>{title}</h2>
        <button type="button" className="rm-button" onClick={() => onReport(report)}>Open report <ArrowRight aria-hidden="true" /></button>
      </header>
      {error && <p className="rm-error" role="alert"><AlertCircle aria-hidden="true" /> {error}</p>}
      {loading && !rows && <div className="rm-empty"><Loader2 className="rm-spin" aria-hidden="true" /><p>Loading selected report…</p></div>}
      {rows && <DataGrid rows={displayRows} columns={gridColumns(columns, { onOpenTenant, onOpenUnit, onOpenProperty })} getRowKey={(row) => reportRowKey(row)} pageSize={6} emptyMessage="No records returned for this view." storageKey={`rent-ops-dashboard-${report}`} />}
    </section>
  );
}

export function DashboardWorkspace({ snapshot, filters, onReport, onOpenTenant, onOpenUnit, onOpenProperty, previews, refreshing = false }: DashboardWorkspaceProps) {
  const auth = useRentOpsAuth();
  const { debouncedSearch, searchPending } = useReportSearch(filters.search);
  const bundledPreviews = Boolean(previews) && filters.status === "all" && !filters.search.trim();
  const widgetReports = ["rent-roll", "delinquency"] as const;
  const queries = useQueries({ queries: widgetReports.map((report) => {
    const query = reportQueryFilters({ ...filters, search: debouncedSearch }, report, { asOfDate: filters.asOfDate });
    return { queryKey: reportQueryKey(report, query, auth.user?.id ?? ""), staleTime: 30_000, gcTime: 300_000, enabled: auth.status === "authenticated" && Boolean(auth.user?.id) && !bundledPreviews && !searchPending, queryFn: ({ signal }: { signal: AbortSignal }) => loadRentOpsReport(report, query, signal) };
  }) });
  const widgetRows = searchPending ? { "rent-roll": undefined, delinquency: undefined } : bundledPreviews ? previews! : { "rent-roll": queries[0].data, delinquency: queries[1].data };
  const widgetErrors = searchPending || bundledPreviews ? { "rent-roll": undefined, delinquency: undefined } : { "rent-roll": queries[0].error?.message, delinquency: queries[1].error?.message };
  const loading = searchPending || refreshing || queries.some((query) => query.isFetching);

  const metrics = useMemo(() => dashboardMetrics(snapshot.summary, onReport), [snapshot.summary, onReport]);
  const vacancyDetail = [
    ["Future preleased", countValue(snapshot.summary.futurePreleasedUnits)],
    ["Occupancy unknown", countValue(unknownOccupancyCount(snapshot.summary))],
    ["Confirmed vacant", countValue(snapshot.summary.genuineVacantUnits)],
    ["Ready vacant", countValue(snapshot.summary.readyVacantUnits)],
    ["Not ready", countValue(snapshot.summary.notReadyUnits)],
    ["Off market", countValue(snapshot.summary.offMarketUnits)],
  ];

  return (
    <section className="rm-dashboard-workspace" aria-label="Rent Operations dashboard">
      <div className="rm-dashboard-grid">{metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}</div>
      <section className="rm-panel rm-dashboard-vacancy">
        <header className="rm-panel-title"><h2>Vacancies</h2><button type="button" className="rm-button" onClick={() => onReport("occupancy")}>Open report <ArrowRight aria-hidden="true" /></button></header>
        <div className="rm-dashboard-counts">{vacancyDetail.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <div className="rm-dashboard-links"><button type="button" className="rm-button" onClick={() => onReport("applicant-pipeline")}>Review applications <ArrowRight aria-hidden="true" /></button><button type="button" className="rm-button" onClick={() => onReport("lease-expiration")}>Review lease dates <ArrowRight aria-hidden="true" /></button></div>
      </section>
      <div className="rm-dashboard-widget-grid">
        <Widget report="rent-roll" rows={widgetRows["rent-roll"]} loading={loading} error={widgetErrors["rent-roll"]} snapshot={snapshot} onReport={onReport} onOpenTenant={onOpenTenant} onOpenUnit={onOpenUnit} onOpenProperty={onOpenProperty} />
        <Widget report="delinquency" rows={widgetRows.delinquency} loading={loading} error={widgetErrors.delinquency} snapshot={snapshot} onReport={onReport} onOpenTenant={onOpenTenant} onOpenUnit={onOpenUnit} onOpenProperty={onOpenProperty} />
      </div>
    </section>
  );
}

export default DashboardWorkspace;
