import type { ReportColumn, ReportPeriod, ReportTotal } from "./contracts";

const CENTS_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

/** Exact decimal string for signed BIGINT cents ("-1234.56"). No float math. */
export function centsToDecimalString(cents: string): string {
  if (!CENTS_PATTERN.test(cents)) throw new Error("Expected canonical signed cents");
  const negative = cents.startsWith("-");
  const digits = (negative ? cents.slice(1) : cents).padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Display money exactly as the screen, printable view and HTML export show it. */
export function formatReportMoney(cents: string, currency?: string | null): string {
  const decimal = centsToDecimalString(cents);
  const negative = decimal.startsWith("-");
  const [whole, fraction] = (negative ? decimal.slice(1) : decimal).split(".");
  const amount = `${groupThousands(whole)}.${fraction}`;
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const symbol = code === "USD" ? "$" : `${code} `;
  return negative ? `−${symbol}${amount}` : `${symbol}${amount}`;
}

export function reportStatusLabel(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

/** Row currency: an explicit `currency` value, else a `<field>Currency` sibling. */
export function rowCurrency(values: Readonly<Record<string, unknown>>, columnId?: string): string | null {
  if (columnId) {
    const sibling = values[`${columnId.replace(/Cents$/, "")}Currency`];
    if (typeof sibling === "string") return sibling;
  }
  return typeof values.currency === "string" ? values.currency : null;
}

/** One display formatter shared by the workspace table and HTML/print export. */
export function formatReportValue(value: unknown, column: Pick<ReportColumn, "id" | "type">, values: Readonly<Record<string, unknown>> = {}, fallbackCurrency?: string | null): string {
  if (value === null || value === undefined || value === "") return "—";
  if (column.type === "money" && typeof value === "string" && CENTS_PATTERN.test(value)) return formatReportMoney(value, rowCurrency(values, column.id) ?? fallbackCurrency ?? null);
  if (column.type === "status" && typeof value === "string") return reportStatusLabel(value);
  if (column.type === "boolean") return value === true ? "Yes" : value === false ? "No" : String(value);
  if (column.type === "percent" && (typeof value === "string" || typeof value === "number")) return `${value}%`;
  if (column.type === "integer" && typeof value === "number") return value.toLocaleString("en-US");
  if (column.type === "duration" && typeof value === "number") return `${(value / 3600).toFixed(2)} h`;
  if (Array.isArray(value)) return value.map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function formatReportTotal(total: ReportTotal): string {
  if (total.amountCents === null) return total.state === "unknown" ? "Unknown" : "Unavailable";
  return formatReportMoney(total.amountCents, total.currency);
}

export function reportTotalLabel(key: string): string {
  return reportStatusLabel(key.replace(/[.-]/g, "_"));
}

export function describeReportPeriod(period: ReportPeriod): string {
  if (period.mode === "as_of") return `As of ${period.asOfDate}`;
  if (period.mode === "range") return `${period.fromDate} to ${period.toDate}`;
  if (period.mode === "month") return `Month ${period.month}`;
  if (period.fromDate && period.toDate) return `${period.fromDate} to ${period.toDate}`;
  if (period.asOfDate) return `As of ${period.asOfDate}`;
  if (period.month) return `Month ${period.month}`;
  return "All dates";
}
