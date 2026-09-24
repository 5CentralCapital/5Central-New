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

/** Display a subtotal when unknown rows may be signed and therefore are not a lower bound. */
export function formatKnownSubtotal(value: string | null, complete: boolean, currency = "USD"): string {
  if (value === null) return "Unknown";
  return complete ? formatCentsText(value, currency) : `Known subtotal ${formatCentsText(value, currency)} + unknown`;
}

export function compareCentsText(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const difference = BigInt(left) - BigInt(right);
  return difference === BigInt(0) ? 0 : difference < BigInt(0) ? -1 : 1;
}

/** Keep cent sort keys as integer strings so the grid model can compare them as BigInts. */
export function centsSortValue(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!/^-?\d+$/.test(normalized)) return null;
  try {
    BigInt(normalized);
    return normalized;
  } catch {
    return null;
  }
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

/**
 * File types a browser tab may render from a same-origin blob URL. Anything
 * else (HTML, SVG, XML, unknown) could run script with the app's origin, so it
 * is saved as a download instead of opened.
 */
export function opensInline(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "application/pdf" || type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp";
}
