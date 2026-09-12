import type { AdminRecurringScheduleView } from "../types";

export interface ScheduleDisplayInterval {
  schedule: AdminRecurringScheduleView;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  state: "current" | "future" | "ended" | "unknown";
  uncertaintyCodes: string[];
}

function date(value?: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

/** The server validates the complete immutable chain and supplies its inclusive display end.
 * Never infer a replacement boundary from a filtered browser collection or mutate source dates.
 */
export function scheduleDisplayInterval(schedule: AdminRecurringScheduleView, asOfDate: string): ScheduleDisplayInterval {
  const uncertaintyCodes: string[] = [];
  const confirmed = schedule.lineageState === "valid" && schedule.resolvedEffectiveTo !== undefined;
  if (!confirmed) uncertaintyCodes.push("schedule_lineage_unconfirmed");
  const effectiveTo = confirmed ? schedule.resolvedEffectiveTo : undefined;
  const start = date(schedule.effectiveFrom);
  const end = date(effectiveTo);
  const asOf = date(asOfDate);
  if (!asOf || !start || effectiveTo && !end || ["unknown", "inferred", "ambiguous", "unknown_open_start"].includes(schedule.effectiveFromKnowledge ?? "")) uncertaintyCodes.push("schedule_dates_unconfirmed");
  if (schedule.active == null || ["unknown", "inferred", "ambiguous"].includes(schedule.activeKnowledge ?? "")) uncertaintyCodes.push("active_status_unknown");
  let state: ScheduleDisplayInterval["state"] = "unknown";
  if (!uncertaintyCodes.length) {
    if (start! > asOf!) state = "future";
    else if (schedule.active === false || end && end < asOf!) state = "ended";
    else state = "current";
  }
  return { schedule, effectiveFrom: schedule.effectiveFrom, effectiveTo, state, uncertaintyCodes };
}

export function buildScheduleDisplayIntervals(schedules: readonly AdminRecurringScheduleView[], asOfDate: string): ScheduleDisplayInterval[] {
  return schedules.map(schedule => scheduleDisplayInterval(schedule, asOfDate));
}
