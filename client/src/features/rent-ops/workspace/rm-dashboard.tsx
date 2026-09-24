import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { loadBanking, loadDashboardCash, loadDashboardTrends, loadRentOpsReport, loadRentOpsWorkspaceCollection } from "../api";
import { useRentOpsAuth } from "../auth-ui";
import type { DashboardWorkspaceProps } from "./dashboard-workspace";
import { createReportViewModel, readReportValue, reportQueryFilters, reportQueryKey } from "./report-model";
import { workspaceApiFilters } from "./workspace-state";
import { useReportSearch } from "./use-report-search";
import { recentOnlineApplications, dashboardMovements } from "./dashboard-tiles";
import { ApplicationCaseDetail } from "../application-case-detail";
import { dashboardKpis, splitDueRows } from "./dashboard-kpis";
import { rentalAttentionItems } from "./dashboard-attention";
import { DashboardGrid } from "./dashboard-grid";
import { numeric, text, type DashboardData, type Row } from "./dashboard-widgets";
import type { TrendMetric } from "./dashboard-model";
import { formatMonthLabel } from "../../../lib/rent-ops-formatters";
import "./rm-dashboard.css";

/**
 * The dashboard: one data layer (the requests below) feeding a grid of
 * widgets the manager arranges (dashboard-grid.tsx, dashboard-widgets.tsx).
 */
export function RmDashboard({ snapshot, filters, onReport, onOpenTenant, onOpenUnit, onOpenProperty, previews, refreshing = false, onManageMoves, companyPanels }: DashboardWorkspaceProps) {
  const auth = useRentOpsAuth();
  const enabled = auth.status === "authenticated" && !!auth.user?.id;
  const identity = auth.user?.id ?? "";
  const apiFilters = workspaceApiFilters(filters);
  const { debouncedSearch, searchPending } = useReportSearch(filters.search);
  const bundled = !!previews && !filters.search.trim() && filters.status === "all";
  const reports = ["rent-roll", "delinquency", "collected-income", "occupancy"] as const;
  const requests = useQueries({ queries: reports.map(report => {
    const query = reportQueryFilters({ ...filters, search: debouncedSearch }, report, { asOfDate: filters.asOfDate });
    return { queryKey: reportQueryKey(report, query, identity), queryFn: ({ signal }: { signal: AbortSignal }) => loadRentOpsReport(report, query, signal), enabled: enabled && !searchPending && !(bundled && (report === "rent-roll" || report === "delinquency")), staleTime: 30_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: true };
  }) });
  const rowsFor = (report: typeof reports[number]): Row[] | undefined => {
    if (searchPending) return undefined;
    const raw = bundled && (report === "rent-roll" || report === "delinquency") ? previews![report] : requests[reports.indexOf(report)].data;
    return raw ? createReportViewModel(report, raw, snapshot).displayRows.map(row => ({ ...row, ...Object.fromEntries(["propertyId", "unitId", "personId", "tenancyId", "currentPersonId", "futurePersonId", "occupancy", "operationalBalanceCents", "actualMoveInOn", "expectedMoveOutOn", "oldestUnpaidRentOn"].map(key => [key, readReportValue(row.__source, key)])) })) : undefined;
  };
  const rentRoll = rowsFor("rent-roll");
  const dueRows = rowsFor("delinquency")?.filter(row => !numeric(row.operationalBalanceCents) || row.operationalBalanceCents > 0).sort((a, b) => (numeric(b.operationalBalanceCents) ? b.operationalBalanceCents : -1) - (numeric(a.operationalBalanceCents) ? a.operationalBalanceCents : -1));
  const dueSplit = dueRows ? splitDueRows(dueRows) : undefined;
  const receiptRows = rowsFor("collected-income");
  const receiptGroups = new Map<string, Row>();
  for (const row of receiptRows ?? []) {
    if (row.category !== "base_rent") continue;
    const key = `${row.personId ?? row.tenantName}:${row.propertyId}:${row.paymentOn}`;
    const previous = receiptGroups.get(key);
    receiptGroups.set(key, previous ? { ...previous, amountCents: numeric(previous.amountCents) && numeric(row.amountCents) ? previous.amountCents + row.amountCents : null } : row);
  }
  const receipts = receiptRows ? Array.from(receiptGroups.values()).sort((a, b) => text(b.paymentOn).localeCompare(text(a.paymentOn))) : undefined;
  const applicationQuery = useQuery({ queryKey: ["rent-ops-workspace", "collection", "applications", identity, filters.propertyScope, filters.propertyId, [...(filters.propertyIds ?? [])].sort(), filters.asOfDate], queryFn: ({ signal }) => loadRentOpsWorkspaceCollection("applications", apiFilters, signal), enabled, staleTime: 60_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: true });
  const applications = applicationQuery.data ? recentOnlineApplications(applicationQuery.data, snapshot, filters) : undefined;
  const [applicationId, setApplicationId] = useState<string>();
  const selectedApplication = applications?.find(application => application.id === applicationId);
  const occupancy = rowsFor("occupancy");
  const daysVacant = new Map(occupancy?.map(row => [row.unitId, row.daysVacant]) ?? []);
  const vacancy = rentRoll?.filter(row => row.occupancy === "vacant" || row.occupancy === "future_preleased").map(row => {
    const unit = snapshot.snapshot.units.find(unit => unit.id === row.unitId);
    const layout = unit?.bedrooms != null && unit?.bathrooms != null ? `${unit.bedrooms}B/${unit.bathrooms}B` : unit?.bedrooms != null ? `${unit.bedrooms} bed` : unit?.bathrooms != null ? `${unit.bathrooms} bath` : "";
    return { ...row, daysVacant: daysVacant.get(row.unitId), type: layout || unit?.unitType };
  });
  const propertyRows = useMemo(() => {
    if (!rentRoll) return undefined;
    const groups = new Map<string, Row>();
    for (const row of rentRoll) {
      const id = String(row.propertyId);
      const group = groups.get(id) ?? { propertyId: id, propertyName: row.propertyName, unitCount: 0, occupied: 0, vacant: 0, unknown: 0, preleased: 0, rent: 0, rentUnknown: 0 };
      group.unitCount = Number(group.unitCount) + 1;
      if (row.occupancy === "current") { group.occupied = Number(group.occupied) + 1; if (numeric(row.baseRentCents)) group.rent = Number(group.rent) + row.baseRentCents; else group.rentUnknown = Number(group.rentUnknown) + 1; }
      else if (row.occupancy === "vacant" || row.occupancy === "future_preleased") { group.vacant = Number(group.vacant) + 1; if (row.occupancy === "future_preleased") group.preleased = Number(group.preleased) + 1; }
      else group.unknown = Number(group.unknown) + 1;
      groups.set(id, group);
    }
    return Array.from(groups.values()).map<Row>(row => ({ ...row, vacancyRate: row.unknown ? null : 100 * Number(row.vacant) / Number(row.unitCount) }));
  }, [rentRoll]);
  const trends = useQuery({ queryKey: ["rent-ops-workspace", "dashboard-trends", identity, apiFilters], queryFn: ({ signal }) => loadDashboardTrends(apiFilters, signal), enabled, staleTime: 60_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: true });
  const cash = useQuery({ queryKey: ["rent-ops-workspace", "dashboard-cash", identity], queryFn: ({ signal }) => loadDashboardCash(signal), enabled, staleTime: 60_000, gcTime: 60_000, retry: false, refetchOnWindowFocus: true });
  const banking = useQuery({ queryKey: ["rent-ops-workspace", "dashboard-banking", identity], queryFn: ({ signal }) => loadBanking(signal), enabled, staleTime: 120_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: false });
  const movements = dashboardMovements(snapshot, filters);
  const errors = requests.flatMap((request, index) => request.error && !(bundled && index < 2) ? [reports[index]] : []);
  const attention = rentalAttentionItems({ dueRows, vacancy, movements, asOfDate: filters.asOfDate });
  const knownDue = dueRows?.filter(row => numeric(row.operationalBalanceCents));
  const unverifiedDue = dueRows ? dueRows.length - (knownDue?.length ?? 0) : 0;
  const vacancySorted = vacancy ? [...vacancy].sort((a, b) => (numeric(b.daysVacant) ? b.daysVacant : -1) - (numeric(a.daysVacant) ? a.daysVacant : -1)) : undefined;
  const kpis = dashboardKpis({ propertyRows, dueRows, receipts, period: filters.asOfDate.slice(0, 7) });
  const monthLabel = formatMonthLabel(filters.asOfDate.slice(0, 7)) ?? filters.asOfDate.slice(0, 7);
  const [metric, setMetric] = useState<TrendMetric>("vacancy");
  const data: DashboardData = {
    snapshot, filters, identity, year: Number(filters.asOfDate.slice(0, 4)), monthLabel, kpis, attention, companyPanels,
    rentRoll, dueRows, knownDue, unverifiedDue, dueSplit, receipts, vacancy, vacancySorted, propertyRows, movements,
    applications, applicationsError: !!applicationQuery.error, onOpenApplication: setApplicationId,
    trends: { data: trends.data, loading: trends.isFetching, error: trends.error?.message, retry: () => void trends.refetch(), metric, setMetric },
    cash: { data: cash.data, error: cash.error?.message, fetching: cash.isFetching, refetch: () => void cash.refetch() },
    banking: { data: banking.data, error: banking.error?.message, loading: banking.isFetching, refetch: () => void banking.refetch() },
    onReport, onOpenTenant, onOpenUnit, onOpenProperty, onManageMoves,
  };
  return <section className="rm-dashboard-workspace rmd-dashboard rops-dash" aria-label="Dashboard">
    {errors.length > 0 && <div className="rmd-load-error" role="alert">Some tables could not be loaded. <button onClick={() => { requests.forEach(request => { if (request.error) void request.refetch(); }); }}>Retry</button></div>}
    <DashboardGrid data={data} />
    {applicationId && selectedApplication && <ApplicationCaseDetail key={applicationId} applicationId={applicationId} summary={selectedApplication} onClose={() => setApplicationId(undefined)} />}
    {refreshing && <div className="rmd-refreshing" role="status">Refreshing dashboard…</div>}
  </section>;
}
