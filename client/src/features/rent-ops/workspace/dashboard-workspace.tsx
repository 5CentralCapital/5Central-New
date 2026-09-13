import { EntityLink, RecordLink } from "./entity-link";
import type { RentOpsWorkspaceDashboard } from "../api";
import type { GridColumn } from "./grid";
import type { AdminSnapshot, DashboardSummary, ReportKey, TenantTab, ViewFilters } from "../types";
import { formatReportValue, formatReportCellValue, reportCellPersonId, readReportValue,
  type DisplayReportRow, type ReportColumnDefinition } from "./report-model";

export interface DashboardWorkspaceProps {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  onReport: (report: ReportKey) => void;
  onOpenTenant?: (personId: string,tab?:TenantTab) => void;
  onOpenUnit?: (unitId: string) => void;
  onOpenProperty?: (propertyId:string)=>void;
  previews?: RentOpsWorkspaceDashboard["reports"];
  refreshing?: boolean;
  onManageMoves?: () => void;
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

export { RmDashboard as DashboardWorkspace } from "./rm-dashboard";
