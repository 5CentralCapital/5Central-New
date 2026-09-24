import { useState } from "react";
import type { AdminSnapshot, ViewFilters } from "../rent-ops/types";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { DataGrid, type GridColumn } from "../rent-ops/workspace/grid";
import { EmptyState, StatusLine } from "../rent-ops/workspace/ops-ui";
import { displayPersonName, formatTableDate } from "../../lib/rent-ops-formatters";
import { centsSortValue, daysBetween, formatCentsText } from "./format";
import { ErrorState, Loading, Segmented } from "./page";
import { matchesSearch, rentalRows, useRentalReport } from "./rental-reports";
import { leaseRowsFor, legacyCents, type LeaseView, type RentalRow } from "./models";

function tableDate(value: unknown): string {
  return formatTableDate(value) ?? "—";
}

/**
 * The view a manager lands on: Expiring when anything expires in the notice
 * window, otherwise All (an empty Expiring table says nothing useful).
 */
export function defaultLeaseView(counts: { expiring: number; all: number }): LeaseView {
  return counts.expiring === 0 && counts.all > 0 ? "all" : "expiring";
}

/** Tenants › Leases & renewals: expirations with a renewal link to the tenant's lease. */
export function LeasesRenewals({ identity, snapshot, filters }: { identity: string; snapshot: AdminSnapshot; filters: ViewFilters }) {
  const [chosenView, setView] = useState<LeaseView>();
  const report = useRentalReport(identity, "lease-expiration", filters, { asOfDate: filters.asOfDate });
  const all = rentalRows(report.data, snapshot, ["personId", "tenantName", "propertyId", "propertyName", "unitId", "unitNumber", "contractEndOn", "monthToMonth", "currentBaseRentCents", "noticeDeadlineOn", "actionStatus"]);
  if (report.error) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  if (!all) return <Loading label="Loading leases…" />;
  if (all.length === 0) return <div className="ws-page">
    <EmptyState title="No leases recorded">Lease terms added on a tenant's Lease &amp; charges tab appear here with their renewal dates.</EmptyState>
  </div>;
  const counts = { expiring: leaseRowsFor(all, "expiring").length, month_to_month: leaseRowsFor(all, "month_to_month").length, all: all.length };
  const view = chosenView ?? defaultLeaseView(counts);
  const rows = leaseRowsFor(all, view).filter(row => matchesSearch(row, filters.search, ["tenantName", "propertyName", "unitNumber"]));
  const columns: GridColumn<RentalRow>[] = [
    { key: "tenantName", label: "Tenant", render: row => <EntityLink personId={row.personId as string}>{displayPersonName(typeof row.tenantName === "string" ? row.tenantName : "") || "Tenant"}</EntityLink> },
    { key: "propertyName", label: "Property", render: row => <RecordLink kind="property" recordId={row.propertyId as string}>{String(row.propertyName ?? "—")}</RecordLink> },
    { key: "unitNumber", label: "Unit", render: row => <RecordLink kind="unit" recordId={row.unitId as string}>{String(row.unitNumber ?? "—")}</RecordLink> },
    { key: "contractEndOn", label: "Lease ends", render: row => row.monthToMonth ? "Month to month" : tableDate(row.contractEndOn) },
    { key: "daysLeft", label: "Days left", align: "right", render: row => typeof row.contractEndOn === "string" ? String(daysBetween(filters.asOfDate, row.contractEndOn)) : "—", sortValue: row => typeof row.contractEndOn === "string" ? daysBetween(filters.asOfDate, row.contractEndOn) : null },
    { key: "noticeDeadlineOn", label: "Notice by", render: row => tableDate(row.noticeDeadlineOn) },
    { key: "currentBaseRentCents", label: "Base rent", align: "right", render: row => formatCentsText(legacyCents(row.currentBaseRentCents)), sortValue: row => centsSortValue(legacyCents(row.currentBaseRentCents)) },
    { key: "renew", label: "", render: row => <EntityLink personId={row.personId as string} tab="tenancy" className="rm-button rm-button--small">Renew</EntityLink> },
  ];
  return <div className="ws-page">
    <div className="ws-toolbar">
      <Segmented label="Leases" value={view} onChange={setView} options={[["expiring", `Expiring · ${counts.expiring}`], ["month_to_month", `Month to month · ${counts.month_to_month}`], ["all", `All · ${counts.all}`]]} />
    </div>
    {counts.expiring === 0 && view !== "expiring" && <StatusLine tone="positive">No leases expire in the notice window.</StatusLine>}
    <DataGrid<RentalRow> rows={rows} columns={columns} getRowKey={(row, index) => `${row.personId}:${row.unitId}:${index}`} storageKey="ws-leases"
      emptyMessage={view === "expiring" ? "No leases expire in the notice window." : "No leases match these filters."} />
  </div>;
}
