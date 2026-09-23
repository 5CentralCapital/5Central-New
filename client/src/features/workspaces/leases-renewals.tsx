import { useState } from "react";
import type { AdminSnapshot, ViewFilters } from "../rent-ops/types";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { DataGrid, type GridColumn } from "../rent-ops/workspace/grid";
import { centsSortValue, daysBetween, formatCentsText, formatIsoDate } from "./format";
import { ErrorState, Loading, Segmented } from "./page";
import { matchesSearch, rentalRows, useRentalReport } from "./rental-reports";
import { leaseRowsFor, legacyCents, type LeaseView, type RentalRow } from "./models";

/** Tenants › Leases & renewals: expirations with a renewal link to the tenant's lease. */
export function LeasesRenewals({ identity, snapshot, filters }: { identity: string; snapshot: AdminSnapshot; filters: ViewFilters }) {
  const [view, setView] = useState<LeaseView>("expiring");
  const report = useRentalReport(identity, "lease-expiration", filters, { asOfDate: filters.asOfDate });
  const all = rentalRows(report.data, snapshot, ["personId", "tenantName", "propertyId", "propertyName", "unitId", "unitNumber", "contractEndOn", "monthToMonth", "currentBaseRentCents", "noticeDeadlineOn", "actionStatus"]);
  if (report.error) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  if (!all) return <Loading label="Loading leases…" />;
  const rows = leaseRowsFor(all, view).filter(row => matchesSearch(row, filters.search, ["tenantName", "propertyName", "unitNumber"]));
  const counts = { expiring: leaseRowsFor(all, "expiring").length, month_to_month: leaseRowsFor(all, "month_to_month").length, all: all.length };
  const columns: GridColumn<RentalRow>[] = [
    { key: "tenantName", label: "Tenant", render: row => <EntityLink personId={row.personId as string}>{String(row.tenantName ?? "Tenant")}</EntityLink> },
    { key: "propertyName", label: "Property", render: row => <RecordLink kind="property" recordId={row.propertyId as string}>{String(row.propertyName ?? "—")}</RecordLink> },
    { key: "unitNumber", label: "Unit", render: row => <RecordLink kind="unit" recordId={row.unitId as string}>{String(row.unitNumber ?? "—")}</RecordLink> },
    { key: "contractEndOn", label: "Lease ends", render: row => row.monthToMonth ? "Month to month" : formatIsoDate(row.contractEndOn as string) },
    { key: "daysLeft", label: "Days left", align: "right", render: row => typeof row.contractEndOn === "string" ? String(daysBetween(filters.asOfDate, row.contractEndOn)) : "—", sortValue: row => typeof row.contractEndOn === "string" ? daysBetween(filters.asOfDate, row.contractEndOn) : null },
    { key: "noticeDeadlineOn", label: "Notice by", render: row => formatIsoDate(row.noticeDeadlineOn as string) },
    { key: "currentBaseRentCents", label: "Base rent", align: "right", render: row => formatCentsText(legacyCents(row.currentBaseRentCents)), sortValue: row => centsSortValue(legacyCents(row.currentBaseRentCents)) },
    { key: "renew", label: "", render: row => <EntityLink personId={row.personId as string} tab="tenancy" className="rm-button rm-button--small">Renew</EntityLink> },
  ];
  return <div className="ws-page">
    <div className="ws-toolbar">
      <Segmented label="Leases" value={view} onChange={setView} options={[["expiring", `Expiring · ${counts.expiring}`], ["month_to_month", `Month to month · ${counts.month_to_month}`], ["all", `All · ${counts.all}`]]} />
    </div>
    <DataGrid<RentalRow> rows={rows} columns={columns} getRowKey={(row, index) => `${row.personId}:${row.unitId}:${index}`} storageKey="ws-leases"
      emptyMessage={view === "expiring" ? "No leases expire in the notice window." : "No leases match these filters."} />
  </div>;
}
