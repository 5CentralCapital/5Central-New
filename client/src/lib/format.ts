// Shared display helpers for the public site and legacy dashboards.

/**
 * Formats a calendar date: a "YYYY-MM-DD" string or a date stored as UTC
 * midnight (acquisition, effective and maturity dates). `new Date(value)` puts
 * those at UTC midnight, so formatting them in a US time zone shows the
 * previous day; formatting in UTC keeps the stored day. Missing or invalid
 * values return `fallback` instead of "Invalid Date".
 */
export function formatCalendarDate(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
  fallback = "—",
): string {
  if (value == null || value === "") return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

/** Today's date (or `date`) as "YYYY-MM-DD" in the viewer's time zone, for date-input defaults.
 * `toISOString()` is UTC, which is already tomorrow on a US evening. */
export function localIsoDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** Whole-dollar display for decimal strings or numbers. A missing or unreadable
 * amount is shown as "—", never as $0. */
export function formatWholeUsd(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? wholeUsd.format(amount) : "—";
}
