import { useMemo, useState } from "react";
import type { AdminSnapshot, ViewFilters } from "../rent-ops/types";
import { EntityLink, RecordLink } from "../rent-ops/workspace/entity-link";
import { DataGrid, type GridColumn } from "../rent-ops/workspace/grid";
import { tenancyMovements } from "../rent-ops/workspace/dashboard-tiles";
import { UnitReadinessBadge, UnitReadinessProvider, useUnitReadiness } from "../rent-ops/workspace/unit-readiness";
import { unitReadinessDisplay } from "../rent-ops/workspace/unit-readiness-model";
import { addIsoDays, centsSortValue, formatCentsText, formatIsoDate, humanize } from "./format";
import { makeReadyRows, listingRows, movesFor, workByUnit, type ListingRow, type MakeReadyRow, type MoveView, type RentalRow } from "./models";
import { ErrorState, Loading, Segmented, selectOrganization, useCompanyContext } from "./page";
import { rentalRows, useRentalReport } from "./rental-reports";
import { useOpenWorkOrders } from "./work-data";

/** Tenants › Move-ins & move-outs: completed moves in the last 30 days and planned moves in the next 60. */
export function MovesPage({ snapshot, filters, canRecord, onRecordMove }: { snapshot: AdminSnapshot; filters: ViewFilters; canRecord: boolean; onRecordMove: (personId?: string) => void }) {
  const [view, setView] = useState<MoveView>("upcoming");
  const events = useMemo(() => tenancyMovements(snapshot, filters, addIsoDays(filters.asOfDate, -30), addIsoDays(filters.asOfDate, 60)), [snapshot, filters]);
  const rows = movesFor(events, view) as unknown as RentalRow[];
  const columns: GridColumn<RentalRow>[] = [
    { key: "date", label: "Date", render: row => formatIsoDate(row.date as string) },
    { key: "movement", label: "Move" },
    { key: "state", label: "Status" },
    { key: "tenantName", label: "Tenant", render: row => <EntityLink personId={row.personId as string} tab="tenancy">{String(row.tenantName || "Tenant")}</EntityLink> },
    { key: "propertyName", label: "Property", render: row => <RecordLink kind="property" recordId={row.propertyId as string}>{String(row.propertyName ?? "—")}</RecordLink> },
    { key: "unitNumber", label: "Unit", render: row => <RecordLink kind="unit" recordId={row.unitId as string}>{String(row.unitNumber ?? "—")}</RecordLink> },
    ...(canRecord ? [{ key: "action", label: "", render: (row: RentalRow) => row.actual ? null : <button type="button" className="rm-button rm-button--small" onClick={() => onRecordMove(row.personId as string)}>Record</button> }] : []),
  ];
  return <div className="ws-page">
    <div className="ws-toolbar">
      <Segmented label="Moves" value={view} onChange={setView} options={[["upcoming", "Upcoming"], ["recent", "Completed"], ["all", "All"]]} />
      {canRecord && <button type="button" className="rm-button rm-button-primary ws-toolbar-end" onClick={() => onRecordMove()}>Record move</button>}
    </div>
    <DataGrid<RentalRow> rows={rows} columns={columns} getRowKey={row => String(row.id)} storageKey="ws-moves"
      emptyMessage={view === "upcoming" ? "No planned moves in the next 60 days." : view === "recent" ? "No moves completed in the last 30 days." : "No moves in this window."} />
  </div>;
}

function useCompanyWork(identity: string, organizationId?: string) {
  const context = useCompanyContext(identity);
  const organization = context.data ? selectOrganization(context.data.organizations, organizationId) : undefined;
  const work = useOpenWorkOrders(identity, organization?.id);
  return { work: organization ? work : undefined, companyLoading: context.isLoading };
}

function MakeReadyContent({ identity, snapshot, filters, organizationId }: { identity: string; snapshot: AdminSnapshot; filters: ViewFilters; organizationId?: string }) {
  const readiness = useUnitReadiness();
  const occupancyReport = useRentalReport(identity, "occupancy", filters, { asOfDate: filters.asOfDate });
  const occupancyRows = rentalRows(occupancyReport.data, snapshot, ["unitId", "daysVacant"]);
  const { work } = useCompanyWork(identity, organizationId);
  const turning = useMemo(() => new Set(tenancyMovements(snapshot, filters, filters.asOfDate, addIsoDays(filters.asOfDate, 60))
    .filter(event => event.movement === "Move out" && !event.actual && event.unitId).map(event => event.unitId!)), [snapshot, filters]);
  if (occupancyReport.error) return <ErrorState error={occupancyReport.error} onRetry={() => void occupancyReport.refetch()} />;
  if (!readiness.occupancyReady || !occupancyRows) return readiness.occupancyError ? null : <Loading label="Loading unit readiness…" />;
  const daysVacant = new Map(occupancyRows.map(row => [String(row.unitId), typeof row.daysVacant === "number" ? row.daysVacant : undefined]));
  const openWork = work?.data ? workByUnit(work.data.items) : null;
  const rows = makeReadyRows(snapshot, filters, {
    occupancy: readiness.occupancy, daysVacant, turning, openWork,
    readiness: unit => { const display = unitReadinessDisplay(unit, readiness.occupancy.get(unit.id ?? "")); return { label: display.label, ready: display.status === "ready" ? true : display.status === "not_ready" ? false : undefined }; },
  });
  const query = filters.search.trim().toLocaleLowerCase();
  const visible = rows.filter(row => !query || `${row.propertyName} ${row.unit.unitNumber ?? ""}`.toLocaleLowerCase().includes(query));
  const columns: GridColumn<MakeReadyRow>[] = [
    { key: "propertyName", label: "Property", render: row => <RecordLink kind="property" recordId={row.unit.propertyId}>{row.propertyName}</RecordLink> },
    { key: "unit", label: "Unit", render: row => <RecordLink kind="unit" recordId={row.unit.id}>{row.unit.unitNumber ?? "—"}</RecordLink>, sortValue: row => row.unit.unitNumber ?? "" },
    { key: "occupancy", label: "Occupancy", render: row => row.occupancy === "turning" ? "Move-out expected" : humanize(row.occupancy) },
    { key: "readiness", label: "Readiness", render: row => <UnitReadinessBadge unit={row.unit} /> },
    { key: "daysVacant", label: "Days vacant", align: "right", render: row => row.daysVacant ?? "—" },
    { key: "openWorkOrders", label: "Open work", align: "right", render: row => row.openWorkOrders ?? "—" },
    { key: "workScheduledThrough", label: "Work scheduled through", render: row => row.openWorkOrders === null ? "—" : row.workScheduledThrough ? formatIsoDate(row.workScheduledThrough) : row.openWorkOrders ? "Not scheduled" : "No open work" },
  ];
  return <div className="ws-page">
    {work?.data?.truncated && <p className="ws-note">Showing the first 500 open work orders.</p>}
    <DataGrid<MakeReadyRow> rows={visible} columns={columns} getRowKey={row => row.unit.id!} storageKey="ws-make-ready" emptyMessage="Every unit is occupied or ready." />
  </div>;
}

/** Units › Make-ready: vacant and turning units with readiness, days vacant and open work. */
export function MakeReadyPage(props: { identity: string; snapshot: AdminSnapshot; filters: ViewFilters; organizationId?: string; readOnly: boolean }) {
  return <UnitReadinessProvider filters={props.filters} readOnly={props.readOnly}><MakeReadyContent {...props} /></UnitReadinessProvider>;
}

function ListingsContent({ snapshot, filters }: { snapshot: AdminSnapshot; filters: ViewFilters }) {
  const readiness = useUnitReadiness();
  const [view, setView] = useState<"available" | "listed" | "all">("available");
  if (!readiness.occupancyReady) return readiness.occupancyError ? null : <Loading label="Loading listings…" />;
  const all = listingRows(snapshot, filters, readiness.occupancy, unit => unitReadinessDisplay(unit, readiness.occupancy.get(unit.id ?? "")).label);
  const query = filters.search.trim().toLocaleLowerCase();
  const rows = all.filter(row => (view === "all" || (view === "listed" ? row.listing === "listed" : row.occupancy === "vacant" || row.occupancy === "future_preleased" || row.listing === "listed"))
    && (!query || `${row.propertyName} ${row.unit.unitNumber ?? ""}`.toLocaleLowerCase().includes(query)));
  const columns: GridColumn<ListingRow>[] = [
    { key: "propertyName", label: "Property", render: row => <RecordLink kind="property" recordId={row.unit.propertyId}>{row.propertyName}</RecordLink> },
    { key: "unit", label: "Unit", render: row => <RecordLink kind="unit" recordId={row.unit.id}>{row.unit.unitNumber ?? "—"}</RecordLink>, sortValue: row => row.unit.unitNumber ?? "" },
    { key: "layout", label: "Layout", render: row => row.unit.bedrooms != null ? `${row.unit.bedrooms} bd${row.unit.bathrooms != null ? ` · ${row.unit.bathrooms} ba` : ""}` : "—" },
    { key: "listing", label: "Listing", render: row => row.listing === "not_recorded" ? "Not recorded" : humanize(row.listing) },
    { key: "occupancy", label: "Occupancy", render: row => humanize(row.occupancy) },
    { key: "readiness", label: "Readiness", render: row => <UnitReadinessBadge unit={row.unit} /> },
    { key: "askingRentCents", label: "Asking rent", align: "right", render: row => formatCentsText(row.askingRentCents), sortValue: row => centsSortValue(row.askingRentCents) },
  ];
  return <div className="ws-page">
    <div className="ws-toolbar"><Segmented label="Units" value={view} onChange={setView} options={[["available", "Available"], ["listed", "Listed"], ["all", "All units"]]} /></div>
    <DataGrid<ListingRow> rows={rows} columns={columns} getRowKey={row => row.unit.id!} storageKey="ws-listings" emptyMessage={view === "listed" ? "No units are marked listed." : "No available units match these filters."} />
  </div>;
}

/** Units › Listings: listing state, occupancy and asking rent from unit records. */
export function ListingsPage({ snapshot, filters, readOnly }: { snapshot: AdminSnapshot; filters: ViewFilters; readOnly: boolean }) {
  return <UnitReadinessProvider filters={filters} readOnly={readOnly}><ListingsContent snapshot={snapshot} filters={filters} /></UnitReadinessProvider>;
}
