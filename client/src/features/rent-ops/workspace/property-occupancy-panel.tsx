import { useState } from "react";
import type { AdminLeaseTermView, AdminSnapshot, AdminUnitView } from "../types";
import { formatDate, formatLabel } from "./display";
import { EntityLink, RecordLink } from "./entity-link";
import { knownLink, propertyUnitFieldUnverified } from "./property-unit-model";
import { occupancyRowsForFilter, occupancyViewForUnits, type OccupancyDisplayStatus, type OccupancyViewFilter, type OccupancyViewRecord } from "./occupancy-view-model";
import { useUnitReadiness } from "./unit-readiness";
import "./property-occupancy-panel.css";

const labels: Record<OccupancyDisplayStatus, string> = { current: "Current", past: "Past", future: "Future", unknown: "Unverified", vacant: "Vacant" };
function RecordedDate({ value, knowledge }: { value?: string; knowledge?: string }) {
  return <>{value ? formatDate(value) : "—"}{value && propertyUnitFieldUnverified(knowledge) && <small className="rm-occupancy-unverified">Unverified</small>}</>;
}
function leaseStatus(lease?: AdminLeaseTermView): string {
  if (!lease) return "Not recorded";
  if (!lease.status || lease.status === "unknown" || propertyUnitFieldUnverified(lease.statusKnowledge)) return "Unverified";
  return formatLabel(lease.status);
}
function LeaseTerm({ lease }: { lease?: AdminLeaseTermView }) {
  if (!lease) return <span className="rm-muted">Not recorded</span>;
  return <><RecordedDate value={lease.contractStartOn} knowledge={lease.contractStartKnowledge} /><span aria-hidden="true"> → </span><RecordedDate value={lease.contractEndOn} knowledge={lease.contractEndKnowledge} />{lease.monthToMonth && <small className="rm-occupancy-unverified">Month to month{propertyUnitFieldUnverified(lease.monthToMonthKnowledge) ? " · Unverified" : ""}</small>}</>;
}
function LeaseHistory({ row }: { row: OccupancyViewRecord }) {
  if (!row.leaseHistory.length) return null;
  return <details className="rm-occupancy-lease-history"><summary>{row.leaseHistory.length === 1 ? "View recorded lease" : `View ${row.leaseHistory.length} recorded leases`}</summary><ul>{row.leaseHistory.map((lease, index) => <li key={lease.id ?? index}><LeaseTerm lease={lease} /><small>{leaseStatus(lease)}{lease.renewalOfId ? " · Renewal" : ""}</small>{lease.signedOn && <small>Signed <RecordedDate value={lease.signedOn} knowledge={lease.signedOnKnowledge} /></small>}</li>)}</ul></details>;
}
function OccupancyTable({ rows, onSelect, caption }: { rows: OccupancyViewRecord[]; onSelect: (unitId: string) => void; caption: string }) {
  return <div className="rm-occupancy-table-scroll"><table className="rm-occupancy-table"><caption className="sr-only">{caption}</caption><thead><tr><th scope="col">Unit</th><th scope="col">Tenant</th><th scope="col">Occupancy</th><th scope="col">Move in</th><th scope="col">Move out</th><th scope="col">Lease term</th><th scope="col">Lease status</th></tr></thead><tbody>{rows.map(row => {
    const tenancy = row.tenancy;
    const actualMoveIn = tenancy?.actualMoveInOn ?? row.authoritativeReport?.actualMoveInOn;
    return <tr key={row.key}><td><RecordLink kind="unit" recordId={row.unit.id} onOpen={onSelect}>{row.unit.unitNumber ?? "—"}</RecordLink></td><td><EntityLink personId={knownLink(tenancy?.primaryPersonId, tenancy?.primaryPersonLinkKnowledge) ? tenancy?.primaryPersonId : undefined}>{row.occupantName ?? "Name not recorded"}</EntityLink></td><td><span className={`rm-status ${row.displayStatus}`} title={row.statusReason}>{labels[row.displayStatus]}</span>{row.displayStatus === "past" && !tenancy?.actualMoveOutOn && <small className="rm-occupancy-unverified">{row.statusReason}</small>}</td><td><RecordedDate value={actualMoveIn ?? (row.displayStatus === "future" ? tenancy?.plannedMoveInOn : undefined)} knowledge={actualMoveIn ? tenancy?.actualMoveInKnowledge : tenancy?.plannedMoveInKnowledge} />{!actualMoveIn && row.displayStatus === "future" && tenancy?.plannedMoveInOn && <small className="rm-occupancy-unverified">Planned</small>}</td><td><RecordedDate value={tenancy?.actualMoveOutOn} knowledge={tenancy?.actualMoveOutKnowledge} /></td><td><LeaseTerm lease={row.lease} /><LeaseHistory row={row} /></td><td><span className="rm-muted">{leaseStatus(row.lease)}</span></td></tr>;
  })}</tbody></table></div>;
}
export function PropertyOccupancyPanel({ snapshot, units, asOfDate, onSelect, unresolvedLinks = 0 }: { snapshot: AdminSnapshot; units: AdminUnitView[]; asOfDate: string; onSelect: (unitId: string) => void; unresolvedLinks?: number }) {
  const [filter, setFilter] = useState<OccupancyViewFilter>("current");
  const { occupancyRows, occupancyReady, occupancyError } = useUnitReadiness();
  if (occupancyError) return <section className="rm-property-unit-tab-panel"><h3>Occupancy</h3><p role="alert">Occupancy could not be loaded for {formatDate(asOfDate)}. Retry using the occupancy notice above.</p></section>;
  if (!occupancyReady) return <section className="rm-property-unit-tab-panel"><h3>Occupancy</h3><p role="status">Loading occupancy for {formatDate(asOfDate)}…</p></section>;
  const allRows = occupancyViewForUnits(snapshot, units, occupancyRows, asOfDate);
  const rows = occupancyRowsForFilter(allRows, filter);
  const groups: OccupancyDisplayStatus[] = filter === "all" ? ["current", "past", "future", "unknown"] : [filter];
  const unknownUnits = allRows.filter(row => row.currentUnitState && row.displayStatus === "unknown").length;
  return <section className="rm-property-unit-tab-panel rm-occupancy-panel"><div className="rm-property-unit-panel-heading"><div><h3>Occupancy</h3><p>As of {formatDate(asOfDate)}</p></div><div className="rm-occupancy-filter" role="group" aria-label="Tenant occupancy filter">{(["current", "all", "past"] as const).map(option => <button type="button" key={option} className={`rm-button${filter === option ? " rm-button-primary" : ""}`} aria-pressed={filter === option} onClick={() => setFilter(option)}>{formatLabel(option)} <span>{occupancyRowsForFilter(allRows, option).length}</span></button>)}</div></div>
    {unresolvedLinks > 0 && <p className="rm-warning">{unresolvedLinks} tenancy relationship{unresolvedLinks === 1 ? " needs" : "s need"} verification before a unit can be assigned.</p>}
    {unknownUnits > 0 && <p className="rm-muted">Current occupancy is unverified for {unknownUnits} unit{unknownUnits === 1 ? "" : "s"}.</p>}
    {!rows.length && <p className="rm-occupancy-empty">{filter === "current" ? "No confirmed current tenants for this date." : filter === "past" ? "No confirmed past tenancies for this date." : "No linked tenant history is available."}</p>}
    {groups.map(status => { const group = rows.filter(row => row.displayStatus === status); return group.length ? <section className={`rm-occupancy-group rm-occupancy-group-${status}`} key={status} aria-label={`${labels[status]} tenants`}>{filter === "all" && <h4>{labels[status]} tenants <span>{group.length}</span></h4>}<OccupancyTable rows={group} onSelect={onSelect} caption={`${labels[status]} tenants as of ${asOfDate}`} /></section> : null; })}
  </section>;
}
