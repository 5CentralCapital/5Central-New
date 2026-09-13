import type { AdminLeaseTermView, AdminSnapshot, AdminTenancyView, AdminUnitView, RentRollRow } from "../types";
import { knownLeaseTermsForTenancy, knownLink, occupancyHistoryForUnit, type OccupancyHistoryRecord } from "./property-unit-model";

export type OccupancyDisplayStatus = "current" | "past" | "future" | "unknown" | "vacant";
export type OccupancyViewFilter = "current" | "all" | "past";
export interface OccupancyViewRecord extends OccupancyHistoryRecord {
  displayStatus: OccupancyDisplayStatus;
  statusReason: string;
  /** Complete unmodified terms, including renewals not selected for display. */
  leaseHistory: AdminLeaseTermView[];
  authoritativeReport?: RentRollRow;
  /** The report's as-of unit state, rather than a historical tenant row. */
  currentUnitState: boolean;
}

const confirmed = (knowledge?: string) => knowledge === undefined || knowledge === "source" || knowledge === "manual";
function date(value?: string): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : undefined;
}
function moveIn(tenancy?: AdminTenancyView): string | undefined {
  return tenancy && confirmed(tenancy.actualMoveInKnowledge) ? date(tenancy.actualMoveInOn) : undefined;
}
function selectLease(terms: AdminLeaseTermView[], asOf: string, status: OccupancyDisplayStatus): AdminLeaseTermView | undefined {
  const operational = terms.filter(term => ["executed", "month_to_month"].includes(term.status ?? "") && confirmed(term.statusKnowledge) && confirmed(term.contractStartKnowledge) && date(term.contractStartOn));
  const newest = (a: AdminLeaseTermView, b: AdminLeaseTermView) => (b.contractStartOn ?? "").localeCompare(a.contractStartOn ?? "") || (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || (b.id ?? "").localeCompare(a.id ?? "");
  const recorded = terms.filter(term => confirmed(term.contractStartKnowledge) && date(term.contractStartOn));
  if (status === "future") {
    const upcoming = (candidates: AdminLeaseTermView[]) => candidates.filter(term => term.contractStartOn! > asOf).sort((a, b) => -newest(a, b))[0];
    return upcoming(operational) ?? upcoming(recorded);
  }
  const effective = (candidates: AdminLeaseTermView[]) => candidates.filter(term => term.contractStartOn! <= asOf).sort(newest).find(term => !term.contractEndOn || (confirmed(term.contractEndKnowledge) && term.contractEndOn >= asOf));
  const lastStarted = (candidates: AdminLeaseTermView[]) => candidates.filter(term => term.contractStartOn! <= asOf).sort(newest)[0];
  // Prefer an effective confirmed term. A recorded renewal with unknown
  // execution remains useful date evidence ahead of an expired old term;
  // preserve its original status/knowledge so the UI cannot imply execution.
  // Lease expiration never changes occupancy, including holdovers.
  return effective(operational) ?? effective(recorded) ?? lastStarted(operational) ?? lastStarted(recorded)
    ?? terms.filter(term => !term.contractStartOn).sort(newest)[0];
}
function historicalStatus(tenancy: AdminTenancyView, reports: readonly RentRollRow[], asOf: string): Pick<OccupancyViewRecord, "displayStatus" | "statusReason"> {
  const out = confirmed(tenancy.actualMoveOutKnowledge) ? date(tenancy.actualMoveOutOn) : undefined;
  if (out && out <= asOf) return { displayStatus: "past", statusReason: `Moved out ${out}` };
  const start = moveIn(tenancy);
  const planned = confirmed(tenancy.plannedMoveInKnowledge) ? date(tenancy.plannedMoveInOn) : undefined;
  if ((start && start > asOf) || (confirmed(tenancy.statusKnowledge) && tenancy.status === "future" && planned && planned > asOf)) return { displayStatus: "future", statusReason: `Move-in after ${asOf}` };
  // A source status alone is undated. Require positive temporal evidence before
  // using a replacement or transfer to classify an imported uncertain tenancy.
  if (start && start <= asOf) {
    const successor = reports.find(report => report.occupancy === "current" && report.tenancyId && report.tenancyId !== tenancy.id && date(report.actualMoveInOn) && report.actualMoveInOn! > start && report.actualMoveInOn! <= asOf && (
      report.unitId === tenancy.unitId || (knownLink(tenancy.primaryPersonId, tenancy.primaryPersonLinkKnowledge) && report.currentPersonId === tenancy.primaryPersonId)
    ));
    if (successor) return { displayStatus: "past", statusReason: successor.unitId === tenancy.unitId ? `Replaced by the current tenancy beginning ${successor.actualMoveInOn}` : `Same tenant moved to another unit on ${successor.actualMoveInOn}` };
  }
  return { displayStatus: "unknown", statusReason: `Occupancy history is not confirmed as of ${asOf}` };
}

/** Pure presentation projection. Callers must supply the rent roll for asOfDate,
 * without tenant/occupancy filters. No financial or persisted source fields change. */
export function occupancyViewForUnits(snapshot: AdminSnapshot, units: readonly AdminUnitView[], rentRollRows: readonly RentRollRow[], asOfDate: string): OccupancyViewRecord[] {
  if (!date(asOfDate)) throw new Error("Occupancy view requires a valid as-of date");
  const result: OccupancyViewRecord[] = [];
  for (const unit of units) {
    const report = rentRollRows.find(row => !!unit.id && row.unitId === unit.id);
    const history = occupancyHistoryForUnit(snapshot, unit);
    const tenancies = new Map<string | AdminTenancyView, OccupancyHistoryRecord>();
    for (const row of history) if (row.tenancy) tenancies.set(row.tenancy.id ?? row.tenancy, row);
    let hasReportTenancy = false;
    for (const row of Array.from(tenancies.values())) {
      const authoritative = !!report?.tenancyId && row.tenancy?.id === report.tenancyId && ["current", "future_preleased"].includes(report.occupancy ?? "");
      const status = authoritative ? { displayStatus: (report!.occupancy === "current" ? "current" : "future") as OccupancyDisplayStatus, statusReason: `Rent roll as of ${asOfDate}` } : historicalStatus(row.tenancy!, rentRollRows, asOfDate);
      const leaseHistory = knownLeaseTermsForTenancy(snapshot, row.tenancy?.id);
      result.push({ ...row, key: `occupancy:${unit.id}:${row.tenancy?.id ?? result.length}`, ...status, occupantName: row.occupantName ?? (authoritative ? report?.currentTenantName ?? report?.futureTenantName : undefined), occupancyStatus: status.displayStatus, lease: selectLease(leaseHistory, asOfDate, status.displayStatus), leaseHistory, authoritativeReport: authoritative ? report : undefined, currentUnitState: authoritative });
      if (authoritative) hasReportTenancy = true;
    }
    if (!hasReportTenancy) {
      const displayStatus: OccupancyDisplayStatus = report?.occupancy === "current" && report.tenancyId ? "current" : report?.occupancy === "future_preleased" && report.tenancyId ? "future" : report?.occupancy === "vacant" ? "vacant" : "unknown";
      // Report identity remains reviewable even if the catalog has not loaded
      // its tenancy. Never attach an unrelated historical tenant to this row.
      const tenancy = report?.tenancyId && ["current", "future"].includes(displayStatus) ? snapshot.snapshot.tenancies.find(t => t.id === report.tenancyId) ?? { id: report.tenancyId, unitId: unit.id, primaryPersonId: report.currentPersonId ?? report.futurePersonId } : undefined;
      const leaseHistory = knownLeaseTermsForTenancy(snapshot, tenancy?.id);
      result.push({ key: `unit:${unit.id}:as-of`, unit, tenancy, occupantName: displayStatus === "current" ? report?.currentTenantName : displayStatus === "future" ? report?.futureTenantName : undefined, displayStatus, occupancyStatus: displayStatus, statusReason: report ? `Rent roll as of ${asOfDate}` : `No rent-roll evidence as of ${asOfDate}`, lease: selectLease(leaseHistory, asOfDate, displayStatus), leaseHistory, authoritativeReport: report, currentUnitState: true });
    }
  }
  const rank: Record<OccupancyDisplayStatus, number> = { current: 0, past: 1, future: 2, vacant: 3, unknown: 4 };
  return result.sort((a, b) => rank[a.displayStatus] - rank[b.displayStatus] || (a.unit.unitNumber ?? "").localeCompare(b.unit.unitNumber ?? "", "en", { numeric: true }) || a.key.localeCompare(b.key));
}
export function occupancyRowsForFilter(rows: readonly OccupancyViewRecord[], filter: OccupancyViewFilter = "current"): OccupancyViewRecord[] {
  return rows.filter(row => filter === "all" ? !!row.tenancy : row.displayStatus === filter);
}
