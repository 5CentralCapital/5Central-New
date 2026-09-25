import { formatMoneyExact } from "../projects/money";

/** Exact money display (no Number conversion). */
export function money(cents: string | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "Unknown";
  return formatMoneyExact(cents, currency);
}

/** Whole-dollar display for dense tables; rounds half away from zero on exact integers. */
export function moneyWhole(cents: string | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "Unknown";
  const value = BigInt(cents);
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const dollars = (absolute + BigInt(50)) / BigInt(100);
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "−" : ""}${symbol}${grouped}`;
}

/**
 * Chart geometry only: a cents string becomes a dollars Number for pixel
 * positions and axis ticks. Displayed amounts always use the exact formatters.
 */
export function chartDollars(cents: string | null | undefined): number {
  if (cents === null || cents === undefined) return 0;
  const value = BigInt(cents);
  return Number(value / BigInt(100)) + Number(value % BigInt(100)) / 100;
}

export function compactDollars(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function bpsToPercentText(bps: number | null | undefined, digits = 1): string {
  if (bps === null || bps === undefined) return "—";
  const scaled = Math.round(bps / 10 ** (2 - digits));
  const whole = Math.trunc(scaled / 10 ** digits);
  const fraction = Math.abs(scaled % 10 ** digits).toString().padStart(digits, "0");
  return digits > 0 ? `${whole}.${fraction}%` : `${whole}%`;
}

/** DSCR from basis points (12,500 → "1.25x"). */
export function dscr(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "—";
  return `${(bps / 10_000).toFixed(2)}x`;
}

/** Percent text ("3.25") to integer basis points, exactly. */
export function percentInputToBps(value: string): number {
  const text = value.trim().replace(/%$/, "");
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error("Use a percentage with up to two decimals.");
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function bpsToPercentInput(bps: number | undefined): string {
  if (bps === undefined) return "";
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
}

export function dateLabel(value: string | null | undefined, style: "short" | "long" = "short"): string {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", style === "long" ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function monthLabel(month: string, withYear = false): string {
  const date = new Date(`${month.slice(0, 7)}-15T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", withYear ? { month: "short", year: "numeric", timeZone: "UTC" } : { month: "short", timeZone: "UTC" }).format(date);
}

export function timestampLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

export function periodLabel(period: string): string {
  if (period.startsWith("W:")) return `Week of ${dateLabel(period.slice(2), "long")}`;
  if (period.startsWith("M:")) return monthLabel(period.slice(2), true);
  return period;
}

/** Next Monday on or after a date (for new scenarios). */
export function nextMonday(from = new Date()): string {
  const date = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const weekday = (date.getUTCDay() + 6) % 7;
  if (weekday !== 0) date.setUTCDate(date.getUTCDate() + 7 - weekday);
  return date.toISOString().slice(0, 10);
}
