import type { DashboardCompany, EntityDirectory, PropertyDocuments, PropertyPerformanceRow } from "@shared/workspaces/contracts";
import type { ReportPackageRun } from "@shared/reporting";
import type { AdminSnapshot, AdminUnitView, ViewFilters } from "../rent-ops/types";
import { workspacePropertyMatches } from "../rent-ops/workspace/workspace-state";
import { daysBetween, formatCentsText, sumCentsTexts } from "./format";

/**
 * Pure view models for the workspace pages. Certainty rule: an unknown value
 * stays unknown (null/undefined) and never counts as zero.
 */
export type RentalRow = Record<string, unknown>;

export function legacyCents(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

export function occupancyPercent(row: Pick<PropertyPerformanceRow, "unitCount" | "occupiedUnits" | "unknownOccupancyUnits">): string {
  if (!row.unitCount) return "—";
  if (row.unknownOccupancyUnits) return "Unknown";
  return `${Math.round((row.occupiedUnits * 1000) / row.unitCount) / 10}%`;
}

/** Balance-due rows only: credits and settled accounts are not arrears. Unknown balances sort first. */
export function balancesDue(rows: readonly RentalRow[]): RentalRow[] {
  const amount = (row: RentalRow) => typeof row.operationalBalanceCents === "number" ? row.operationalBalanceCents : Number.MAX_SAFE_INTEGER;
  return rows.filter(row => typeof row.operationalBalanceCents !== "number" || row.operationalBalanceCents > 0)
    .sort((left, right) => amount(right) - amount(left));
}

/** One row per receipt; an unknown allocation amount makes that receipt's total unknown. */
export function receiptsByPayment(rows: readonly RentalRow[]): RentalRow[] {
  const groups = new Map<string, { row: RentalRow; parts: Array<string | null> }>();
  for (const row of rows) {
    const key = String(row.paymentTransactionId ?? `${row.personId}:${row.paymentOn}`);
    const group = groups.get(key) ?? { row, parts: [] };
    group.parts.push(legacyCents(row.amountCents));
    groups.set(key, group);
  }
  return Array.from(groups.values()).map(({ row, parts }): RentalRow => {
    const total = sumCentsTexts(parts);
    return { ...row, receiptCents: total.complete ? total.total : null };
  }).sort((left, right) => String(right.paymentOn ?? "").localeCompare(String(left.paymentOn ?? "")));
}

export type LeaseView = "expiring" | "month_to_month" | "all";
export function leaseRowsFor(rows: readonly RentalRow[], view: LeaseView): RentalRow[] {
  return rows.filter(row => view === "all" || row.actionStatus === view)
    .sort((left, right) => String(left.contractEndOn ?? "9999").localeCompare(String(right.contractEndOn ?? "9999")));
}

export interface MoveEvent { id: string; date?: string; movement: string; state: string; actual: boolean; [key: string]: unknown }
export type MoveView = "upcoming" | "recent" | "all";
/** Upcoming = planned or expected moves; recent = completed moves (on or before the workspace date). */
export function movesFor<T extends MoveEvent>(events: readonly T[], view: MoveView): T[] {
  return events.filter(event => view === "all" || (view === "upcoming" ? !event.actual : event.actual))
    .sort((left, right) => view === "recent" ? String(right.date).localeCompare(String(left.date)) : String(left.date).localeCompare(String(right.date)));
}

export interface MakeReadyRow extends RentalRow {
  unit: AdminUnitView; propertyName: string; occupancy: string; readiness: string; ready: boolean | undefined;
  daysVacant: number | null; openWorkOrders: number | null; workScheduledThrough: string | null;
}

export interface UnitWork { readonly count: number; readonly scheduledThrough: string | null }

/** Open work per unit; the latest scheduled date is when currently scheduled work should finish. */
export function workByUnit(items: ReadonlyArray<{ unitId: string | null; status: string; scheduledOn: string | null }>): Map<string, UnitWork> {
  const result = new Map<string, UnitWork>();
  for (const item of items) {
    if (!item.unitId || item.status === "completed" || item.status === "canceled") continue;
    const current = result.get(item.unitId) ?? { count: 0, scheduledThrough: null };
    const through = item.scheduledOn && (!current.scheduledThrough || item.scheduledOn > current.scheduledThrough) ? item.scheduledOn : current.scheduledThrough;
    result.set(item.unitId, { count: current.count + 1, scheduledThrough: through });
  }
  return result;
}

/**
 * Units that are vacant, turning (notice/expected move-out) or not ready.
 * Days vacant comes from the occupancy report; work counts come from open
 * work orders when the company records are available.
 */
export function makeReadyRows(snapshot: AdminSnapshot, filters: ViewFilters, input: {
  occupancy: ReadonlyMap<string, string>; daysVacant: ReadonlyMap<string, number | undefined>;
  readiness: (unit: AdminUnitView) => { label: string; ready: boolean | undefined };
  openWork: ReadonlyMap<string, UnitWork> | null; turning: ReadonlySet<string>;
}): MakeReadyRow[] {
  const properties = new Map(snapshot.snapshot.properties.map(property => [property.id, property]));
  return snapshot.snapshot.units.flatMap(unit => {
    const property = properties.get(unit.propertyId);
    if (!unit.id || !property || (filters.propertyScope === "active" && property.state !== "active") || !workspacePropertyMatches(filters, property.id)) return [];
    const occupancy = input.occupancy.get(unit.id) ?? "unknown";
    const readiness = input.readiness(unit);
    const turning = input.turning.has(unit.id);
    if (occupancy === "current" && !turning) return [];
    if (occupancy === "future_preleased" && readiness.ready === true) return [];
    return [{
      unit, propertyName: property.name ?? "Property", occupancy: turning && occupancy === "current" ? "turning" : occupancy,
      readiness: readiness.label, ready: readiness.ready,
      daysVacant: input.daysVacant.get(unit.id) ?? null,
      openWorkOrders: input.openWork ? input.openWork.get(unit.id)?.count ?? 0 : null,
      workScheduledThrough: input.openWork?.get(unit.id)?.scheduledThrough ?? null,
    }];
  }).sort((left, right) => (right.daysVacant ?? -1) - (left.daysVacant ?? -1) || left.propertyName.localeCompare(right.propertyName) || String(left.unit.unitNumber).localeCompare(String(right.unit.unitNumber), undefined, { numeric: true }));
}

export interface ListingRow extends RentalRow {
  unit: AdminUnitView; propertyName: string; listing: string; occupancy: string; askingRentCents: string | null; readiness: string;
}

/** Listing view for every unit: listing state, occupancy and asking (market) rent. */
export function listingRows(snapshot: AdminSnapshot, filters: ViewFilters, occupancy: ReadonlyMap<string, string>, readiness: (unit: AdminUnitView) => string): ListingRow[] {
  const properties = new Map(snapshot.snapshot.properties.map(property => [property.id, property]));
  return snapshot.snapshot.units.flatMap(unit => {
    const property = properties.get(unit.propertyId);
    if (!unit.id || !property || (filters.propertyScope === "active" && property.state !== "active") || !workspacePropertyMatches(filters, property.id)) return [];
    const unverified = ["unknown", "ambiguous", "inferred"].includes(String(unit.listingKnowledge ?? ""));
    return [{
      unit, propertyName: property.name ?? "Property",
      listing: unit.listing && !unverified ? unit.listing : "not_recorded",
      occupancy: occupancy.get(unit.id) ?? "unknown",
      askingRentCents: legacyCents(unit.marketRentCents),
      readiness: readiness(unit),
    }];
  }).sort((left, right) => left.propertyName.localeCompare(right.propertyName) || String(left.unit.unitNumber).localeCompare(String(right.unit.unitNumber), undefined, { numeric: true }));
}

export interface ScheduledWork { id: string; scheduledOn: string | null; status: string; priority: string; reportedOn: string; [key: string]: unknown }
export interface ScheduleGroup<T extends ScheduledWork> { key: string; label: string; items: T[] }

/** Agenda groups: overdue, then each scheduled day, then unscheduled open work. */
export function scheduleGroups<T extends ScheduledWork>(items: readonly T[], today: string, formatDay: (date: string) => string): ScheduleGroup<T>[] {
  const open = items.filter(item => item.status !== "completed" && item.status !== "canceled");
  const overdue = open.filter(item => item.scheduledOn !== null && item.scheduledOn < today);
  const days = new Map<string, T[]>();
  for (const item of open) if (item.scheduledOn !== null && item.scheduledOn >= today) days.set(item.scheduledOn, [...(days.get(item.scheduledOn) ?? []), item]);
  const priority = (item: T) => ["emergency", "high", "normal", "low"].indexOf(item.priority);
  const unscheduled = open.filter(item => item.scheduledOn === null).sort((left, right) => priority(left) - priority(right) || left.reportedOn.localeCompare(right.reportedOn));
  return [
    ...(overdue.length ? [{ key: "overdue", label: "Overdue", items: overdue.sort((left, right) => left.scheduledOn!.localeCompare(right.scheduledOn!)) }] : []),
    ...Array.from(days.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([day, dayItems]) => ({
      key: day, label: day === today ? `Today · ${formatDay(day)}` : daysBetween(today, day) === 1 ? `Tomorrow · ${formatDay(day)}` : formatDay(day), items: dayItems,
    })),
    ...(unscheduled.length ? [{ key: "unscheduled", label: "Not scheduled", items: unscheduled }] : []),
  ];
}

type QboBinding = EntityDirectory["entities"][number]["qbo"][number];

/** Remaining amount with certainty: an incomplete obligation shows its known minimum. */
export function obligationRemaining(item: DashboardCompany["obligations"]["items"][number]): string {
  const expected = item.expectedCents ?? item.knownMinimumCents;
  const remaining = BigInt(expected) - BigInt(item.paidCents);
  const text = formatCentsText((remaining < BigInt(0) ? BigInt(0) : remaining).toString(), item.currency);
  return item.amountComplete ? text : `At least ${text}`;
}

export interface ComplianceRow { propertyId: string; propertyName: string; insuranceDated: string | null; insuranceAgeDays: number | null; documentCount: number }

/**
 * Per property: company documents on file and the most recent insurance
 * document date. Documents carry a date, not an expiry, so an insurance
 * document older than a year is flagged for review rather than "expired".
 */
export function complianceRows(documents: PropertyDocuments["documents"], properties: ReadonlyArray<{ id?: string; name?: string }>, asOf: string): ComplianceRow[] {
  return properties.flatMap(property => {
    if (!property.id) return [];
    const own = documents.filter(document => document.propertyId === property.id);
    const insurance = own.filter(document => document.kind === "insurance" && document.documentDate).map(document => document.documentDate!).sort().at(-1) ?? null;
    return [{ propertyId: property.id, propertyName: property.name ?? "Property", insuranceDated: insurance, insuranceAgeDays: insurance ? daysBetween(insurance, asOf) : null, documentCount: own.length }];
  });
}

/** A package is complete only when the run is ready and every item produced a ready report. */
export function packageRunSummary(run: Pick<ReportPackageRun, "state" | "itemRuns">): string {
  if (run.state === "queued" || run.state === "running") return "Running";
  const failed = run.itemRuns.filter(item => item.state !== "ready").length;
  const complete = run.state === "ready" && failed === 0;
  return `${complete ? "Complete" : "Incomplete"} · ${run.itemRuns.length} report${run.itemRuns.length === 1 ? "" : "s"}${failed ? ` · ${failed} not ready` : ""}`;
}

export function qboStatusLabel(binding: Pick<QboBinding, "status" | "environment"> | undefined): { label: string; tone: "positive" | "warning" | "critical" | "neutral" | "info" } {
  if (!binding) return { label: "Not connected", tone: "neutral" };
  const environment = binding.environment === "sandbox" ? " · Sandbox" : "";
  switch (binding.status) {
    case "ready": return { label: `Connected${environment}`, tone: "positive" };
    case "connected": return { label: `Connected, not yet read${environment}`, tone: "info" };
    case "needs_reconnect": return { label: `Reconnect needed${environment}`, tone: "warning" };
    case "revoked": return { label: `Disconnected${environment}`, tone: "critical" };
    default: return { label: "Not connected", tone: "neutral" };
  }
}
