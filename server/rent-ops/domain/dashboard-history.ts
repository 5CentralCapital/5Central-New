import type { RentOpsSnapshot, RentOpsTenancy } from "../../../shared/rent-ops-contracts";

function sourceActualInterval(tenancy: RentOpsTenancy): boolean {
  const validDate = (date: string | null | undefined): date is string => !!date
    && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
  return tenancy.source?.system === "rent_manager" && tenancy.status == null
    && tenancy.statusKnowledge === "unknown"
    && tenancy.actualMoveInKnowledge === "source" && tenancy.actualMoveOutKnowledge === "source"
    && validDate(tenancy.actualMoveInOn) && validDate(tenancy.actualMoveOutOn)
    && tenancy.actualMoveInOn < tenancy.actualMoveOutOn;
}

/** Historical chart read only. Explicit RM actual dates establish a completed
 * occupancy interval even when RM omitted the lease-status field. No current
 * status, contract dates, schedules, or persisted records are changed. */
export function dashboardHistoricalSnapshot(snapshot: RentOpsSnapshot, asOfDate: string): RentOpsSnapshot {
  return {
    ...snapshot,
    tenancies: snapshot.tenancies.flatMap(tenancy => {
      if (!sourceActualInterval(tenancy)) return [tenancy];
      const outsideInterval = asOfDate < tenancy.actualMoveInOn! || asOfDate >= tenancy.actualMoveOutOn!;
      const unitUnresolved = !tenancy.unitId || !["exact", "manual"].includes(tenancy.unitLinkKnowledge ?? "");
      // An unlinked historical record cannot contaminate every unit forever.
      // While its actual interval overlaps the report date, uncertainty remains.
      if (outsideInterval && unitUnresolved) return [];
      return [{ ...tenancy, status: "past" as const, statusKnowledge: "source" as const }];
    }),
  };
}
