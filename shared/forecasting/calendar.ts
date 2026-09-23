/**
 * Pure calendar arithmetic for the forecast engine and its views. Dates are
 * ISO calendar dates with no time zone; day numbers count days since
 * 1970-01-01 so arithmetic never touches local time or DST.
 */
const MS_PER_DAY = 86_400_000;

export function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Invalid ISO date ${date}`);
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY);
}

export function dateFromDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateFromDay(dayNumber(date) + days);
}

/** 0 = Monday … 6 = Sunday. */
export function isoWeekday(date: string): number {
  // 1970-01-01 was a Thursday (index 3).
  return (((dayNumber(date) + 3) % 7) + 7) % 7;
}

export function isMonday(date: string): boolean {
  return isoWeekday(date) === 0;
}

export function mondayOnOrAfter(date: string): string {
  const weekday = isoWeekday(date);
  return weekday === 0 ? date : addDays(date, 7 - weekday);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, number!, 0)).getUTCDate();
}

export function monthStartDate(month: string): string {
  return `${month}-01`;
}

export function monthEndDate(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

export function addMonths(month: string, count: number): string {
  const [year, number] = month.split("-").map(Number);
  const index = year! * 12 + (number! - 1) + count;
  const nextYear = Math.floor(index / 12);
  const nextMonth = index - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

/** Same day-of-month in a later month, clamped to that month's end. */
export function addMonthsToDate(date: string, count: number, day = Number(date.slice(8, 10))): string {
  const month = addMonths(monthOf(date), count);
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

export function monthsBetween(fromMonth: string, toMonth: string): number {
  const [fy, fm] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!);
}

export function minDate(left: string, right: string): string { return left <= right ? left : right; }
export function maxDate(left: string, right: string): string { return left >= right ? left : right; }

export interface ForecastPeriod {
  /** Stable period key: `W:<start>` or `M:<YYYY-MM>`. */
  readonly key: string;
  readonly start: string;
  readonly end: string;
  readonly label: string;
}

/**
 * Weekly buckets are Monday–Sunday and begin on the scenario start date
 * (a Monday). Buckets never overlap, so each dated event belongs to exactly
 * one week.
 */
export function weeklyPeriods(startDate: string, horizonWeeks: number): ForecastPeriod[] {
  if (!isMonday(startDate)) throw new RangeError("Weekly forecast periods start on a Monday");
  return Array.from({ length: horizonWeeks }, (_, index) => {
    const start = addDays(startDate, index * 7);
    return { key: `W:${start}`, start, end: addDays(start, 6), label: start };
  });
}

/**
 * Monthly buckets are calendar months beginning with the month that contains
 * the start date; the first month begins on the start date itself so the
 * monthly view never reaches back before the weekly view.
 */
export function monthlyPeriods(startDate: string, horizonMonths: number): ForecastPeriod[] {
  const first = monthOf(startDate);
  return Array.from({ length: horizonMonths }, (_, index) => {
    const month = addMonths(first, index);
    const start = index === 0 ? startDate : monthStartDate(month);
    return { key: `M:${month}`, start, end: monthEndDate(month), label: month };
  });
}

/** Find the period that contains the date, by binary search over sorted, nonoverlapping periods. */
export function periodIndexFor(periods: readonly ForecastPeriod[], date: string): number {
  let low = 0;
  let high = periods.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const period = periods[middle]!;
    if (date < period.start) high = middle - 1;
    else if (date > period.end) low = middle + 1;
    else return middle;
  }
  return -1;
}
