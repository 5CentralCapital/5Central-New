import type { IsoDate, IsoMonth } from "../../../shared/rent-ops-contracts";

export const RENT_OPS_BUSINESS_TIME_ZONE = "America/New_York";

export function compareIsoDate(left?: string, right?: string): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right);
}

export function monthFromDate(date: string): IsoMonth {
  return date.slice(0, 7) as IsoMonth;
}

export function monthStart(month: IsoMonth): IsoDate {
  return `${month}-01` as IsoDate;
}

export function monthEnd(month: IsoMonth): IsoDate {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}` as IsoDate;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10) as IsoDate;
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const originalDay = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
  parsed.setUTCDate(Math.min(originalDay, lastDay));
  return parsed.toISOString().slice(0, 10) as IsoDate;
}

export function daysBetween(start: IsoDate, end: IsoDate): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  return Math.max(0, Math.floor((endMs - startMs) / 86_400_000));
}

export function nowIsoDate(now = new Date(), timeZone = RENT_OPS_BUSINESS_TIME_ZONE): IsoDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}` as IsoDate;
}

export function nowIsoTimestamp(now = new Date()): string {
  return now.toISOString();
}

export function isDateOnOrBefore(date: string | undefined, asOf: IsoDate): boolean {
  return !!date && date <= asOf;
}

export function isDateOnOrAfter(date: string | undefined, asOf: IsoDate): boolean {
  return !date || date >= asOf;
}

export function isEffectiveOn(
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate | undefined,
  asOf: IsoDate,
): boolean {
  return effectiveFrom <= asOf && (!effectiveTo || effectiveTo >= asOf);
}

export function rangesOverlap(
  leftStart: IsoDate,
  leftEnd: IsoDate | undefined,
  rightStart: IsoDate,
  rightEnd: IsoDate | undefined,
): boolean {
  const leftEndValue = leftEnd ?? "9999-12-31";
  const rightEndValue = rightEnd ?? "9999-12-31";
  return leftStart <= rightEndValue && rightStart <= leftEndValue;
}
