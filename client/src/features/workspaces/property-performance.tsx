import { useQuery } from "@tanstack/react-query";
import type { PropertyPerformanceRow } from "@shared/workspaces/contracts";
import { DataGrid, type GridColumn } from "../rent-ops/workspace/grid";
import { RecordLink } from "../rent-ops/workspace/entity-link";
import { selectedWorkspaceProperties } from "../rent-ops/workspace/workspace-state";
import type { ViewFilters } from "../rent-ops/types";
import { workspacesApi } from "./api";
import { centsSortValue, formatCentsText, formatMeasure, formatMonth, sumCentsTexts } from "./format";
import { ErrorState, Loading, StatePanel, selectOrganization, useCompanyContext } from "./page";
import { occupancyPercent } from "./models";

type Row = PropertyPerformanceRow & Record<string, unknown>;

/** Properties › Performance: one row per property for the selected month. */
export function PropertyPerformance({ identity, filters, organizationId, onOpenReport }: {
  identity: string; filters: ViewFilters; organizationId?: string; onOpenReport: (report: "rent-roll" | "collected-income" | "delinquency") => void;
}) {
  const context = useCompanyContext(identity);
  const organization = context.data ? selectOrganization(context.data.organizations, organizationId) : undefined;
  const month = filters.asOfDate.slice(0, 7);
  const propertyIds = selectedWorkspaceProperties(filters);
  const performance = useQuery({
    queryKey: ["rent-ops-workspace", "property-performance", identity, month, filters.asOfDate, filters.propertyScope, propertyIds, organization?.id ?? ""],
    queryFn: ({ signal }) => workspacesApi.propertyPerformance({ month, asOf: filters.asOfDate, scope: filters.propertyScope, propertyIds, organizationId: organization?.id }, signal),
    enabled: !context.isLoading,
    staleTime: 60_000, retry: false,
  });
  if (performance.error) return <ErrorState error={performance.error} onRetry={() => void performance.refetch()} />;
  if (!performance.data) return <Loading label="Loading property performance…" />;
  const rows = performance.data.rows as Row[];
  if (!rows.length) return <StatePanel title="No properties" message="No properties match the selected portfolio filters." />;
  const scheduled = sumCentsTexts(rows.map(row => row.scheduledRentComplete ? row.scheduledRentCents : null));
  const collected = sumCentsTexts(rows.map(row => row.collectedComplete ? row.collectedCents : null));
  const arrears = sumCentsTexts(rows.map(row => row.arrearsComplete ? row.arrearsCents : null));
  const units = rows.reduce((total, row) => total + row.unitCount, 0);
  const occupied = rows.reduce((total, row) => total + row.occupiedUnits, 0);
  const unknownUnits = rows.reduce((total, row) => total + row.unknownOccupancyUnits, 0);
  const company = performance.data.companyAvailable;
  const money = (value: string | null, complete: boolean) => formatMeasure(value, complete);
  const columns: GridColumn<Row>[] = [
    { key: "propertyName", label: "Property", render: row => <RecordLink kind="property" recordId={row.propertyId}>{row.propertyName}</RecordLink> },
    { key: "unitCount", label: "Units", align: "right" },
    { key: "occupancy", label: "Occupied", align: "right", render: row => `${row.occupiedUnits} · ${occupancyPercent(row)}`, sortValue: row => row.unitCount ? row.occupiedUnits / row.unitCount : null },
    { key: "scheduledRentCents", label: "Scheduled rent", align: "right", render: row => money(row.scheduledRentCents, row.scheduledRentComplete), sortValue: row => centsSortValue(row.scheduledRentCents) },
    { key: "collectedCents", label: `Collected · ${formatMonth(month)}`, align: "right", render: row => money(row.collectedCents, row.collectedComplete), sortValue: row => centsSortValue(row.collectedCents) },
    { key: "arrearsCents", label: "Arrears", align: "right", render: row => money(row.arrearsCents, row.arrearsComplete), sortValue: row => centsSortValue(row.arrearsCents) },
    ...(company ? [
      { key: "openWorkOrders", label: "Open work", align: "right", render: row => row.openWorkOrders ?? "Not mapped" },
      { key: "activeProjects", label: "Active projects", align: "right", render: row => row.activeProjects ?? "Not mapped" },
      { key: "projectEstimateCents", label: "Project estimate", align: "right", render: row => row.legalEntityName === null ? "Not mapped" : formatCentsText(row.projectEstimateCents), sortValue: row => centsSortValue(row.projectEstimateCents) },
      { key: "projectPostedCents", label: "Project costs posted", align: "right", render: row => row.legalEntityName === null ? "Not mapped" : formatMeasure(row.projectPostedCents, row.projectPostedComplete), sortValue: row => centsSortValue(row.projectPostedCents) },
    ] satisfies GridColumn<Row>[] : []),
  ];
  return <div className="ws-page">
    <dl className="ws-metrics" aria-label="Portfolio totals">
      <div><dt>Occupied units</dt><dd>{unknownUnits ? `${occupied} of ${units} · ${unknownUnits} unknown` : `${occupied} of ${units}`}</dd></div>
      <div><dt><button type="button" className="ws-link" onClick={() => onOpenReport("rent-roll")}>Scheduled rent</button></dt><dd>{money(scheduled.total, scheduled.complete)}</dd></div>
      <div><dt><button type="button" className="ws-link" onClick={() => onOpenReport("collected-income")}>Collected · {formatMonth(month)}</button></dt><dd>{money(collected.total, collected.complete)}</dd></div>
      <div><dt><button type="button" className="ws-link" onClick={() => onOpenReport("delinquency")}>Arrears</button></dt><dd>{money(arrears.total, arrears.complete)}</dd></div>
    </dl>
    {!company && <p className="ws-note">Open work and project exposure appear once you have company access.</p>}
    <DataGrid<Row> rows={rows} columns={columns} getRowKey={row => row.propertyId} storageKey="ws-property-performance" pageSize={50} />
  </div>;
}
