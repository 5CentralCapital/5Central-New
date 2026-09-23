/**
 * Display helpers for exact decimal-string cents. Amounts are never passed
 * through floating point; a null amount renders as "Unknown", never $0.00.
 */
const CENTS = /^(-?)(\d+)$/;

export function formatCentsText(value: string | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined) return "Unknown";
  const match = CENTS.exec(value);
  if (!match) return "Unknown";
  const negative = match[1] === "-" && /[1-9]/.test(match[2]);
  const digits = match[2].replace(/^0+(?=\d)/, "").padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "−" : ""}${symbol}${whole}.${digits.slice(-2)}`;
}

/** An amount qualified by its certainty: "$1,200.00", "At least $1,200.00" or "Unknown". */
export function formatMeasure(value: string | null, complete: boolean, currency = "USD"): string {
  if (value === null) return "Unknown";
  return complete ? formatCentsText(value, currency) : `At least ${formatCentsText(value, currency)}`;
}

export function compareCentsText(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const difference = BigInt(left) - BigInt(right);
  return difference === BigInt(0) ? 0 : difference < BigInt(0) ? -1 : 1;
}

/** Sort key for grids that sort numbers: exact for |cents| below 2^53, which covers display ordering. */
export function centsSortValue(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatIsoDate(value: string | null | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "—";
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

/** Whole days from `from` to `to` (both ISO dates); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function addIsoDays(date: string, days: number): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const text = value.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Exact total of decimal-string cents; `complete` is false when any contributor is unknown. */
export function sumCentsTexts(values: ReadonlyArray<string | null>): { total: string | null; complete: boolean } {
  let total = BigInt(0); let known = 0; let unknown = 0;
  for (const value of values) {
    if (value === null || !/^-?\d+$/.test(value)) { unknown += 1; continue; }
    total += BigInt(value); known += 1;
  }
  return { total: known === 0 && unknown > 0 ? null : total.toString(), complete: unknown === 0 };
}
