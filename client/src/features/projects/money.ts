import { BIGINT_CENTS_MAX, BIGINT_CENTS_MIN, centsFromBigInt, type MoneyCents } from "@shared/company/money";

const MONEY_INPUT = /^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;

export interface MoneyInputResult {
  readonly cents: MoneyCents;
  readonly normalized: string;
}

/**
 * Parse a dollars-and-cents field using bigint arithmetic.  The browser never
 * turns a monetary value into a JavaScript number, so large valid balances
 * remain exact from the input field through the command payload.
 */
export function parseMoneyInput(value: unknown, label = "Amount"): MoneyInputResult {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  if (!MONEY_INPUT.test(text)) {
    throw new Error(`${label} must use dollars with no more than two decimal places.`);
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart = "0", fractionPart = ""] = unsigned.split(".");
  const whole = BigInt(wholePart || "0");
  const fraction = BigInt((fractionPart || "").padEnd(2, "0") || "0");
  let cents = whole * BigInt(100) + fraction;
  if (negative) cents = -cents;
  if (cents < BIGINT_CENTS_MIN || cents > BIGINT_CENTS_MAX) {
    throw new Error(`${label} is outside the supported signed 64-bit range.`);
  }

  const canonical = centsFromBigInt(cents);
  return { cents: canonical, normalized: formatInputValue(canonical) };
}

/** Returns a stable editable value such as "1200.50" without floating point. */
export function formatInputValue(value: MoneyCents | string): string {
  const cents = BigInt(value);
  const negative = cents < BigInt(0);
  const absolute = negative ? -cents : cents;
  const whole = absolute / BigInt(100);
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/** Display money without routing cents through Number. */
export function formatMoney(value: MoneyCents | string | undefined, currency = "USD"): string {
  return formatMoneyExact(value, currency);
}

/** Add known signed cents without converting through a JavaScript number. */
export function sumCents(values: readonly (MoneyCents | string | null | undefined)[]): string | null {
  let total = BigInt(0);
  let known = false;
  let unknown = false;
  for (const value of values) {
    if (value === null || value === undefined || value === "" || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) { unknown = true; continue; }
    total += BigInt(value);
    known = true;
  }
  return known && !unknown ? total.toString() : null;
}

export interface CurrencyCentsTotal {
  readonly currency: string;
  readonly cents: string | null;
  readonly unknownCount: number;
}

/** Sum exact cents without crossing currency boundaries. */
export function sumCentsByCurrency(values: readonly { readonly cents: MoneyCents | string | null | undefined; readonly currency: string }[]): CurrencyCentsTotal[] {
  const totals = new Map<string, { total: bigint; known: number; unknown: number }>();
  for (const value of values) {
    const current = totals.get(value.currency) ?? { total: BigInt(0), known: 0, unknown: 0 };
    if (value.cents === null || value.cents === undefined || value.cents === "" || !/^-?(?:0|[1-9][0-9]*)$/.test(value.cents)) current.unknown += 1;
    else { current.total += BigInt(value.cents); current.known += 1; }
    totals.set(value.currency, current);
  }
  return Array.from(totals.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({ currency, cents: value.known ? value.total.toString() : null, unknownCount: value.unknown }));
}

/**
 * Currency display is intentionally assembled from bigint components. Using
 * Intl on the complete amount would require converting cents to a Number and
 * would lose precision for large project budgets.
 */
export function formatMoneyExact(value: MoneyCents | string | undefined, currency = "USD"): string {
  if (value === undefined || value === null || value === "") return "—";
  const cents = BigInt(value);
  const negative = cents < BigInt(0);
  const absolute = negative ? -cents : cents;
  const whole = absolute / BigInt(100);
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" ? "$" : currency === "CAD" ? "CA$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${groupedWhole}.${fraction}`;
}

/**
 * An amount qualified by how much of it is known: exact when complete,
 * "Known $X" when some contributors are missing (partial QuickBooks
 * coverage or unpriced labor), and "Unknown" when nothing could be read.
 * Unknown refunds can reduce a positive subtotal, so partial is not a minimum.
 */
export function formatQualifiedMoney(value: MoneyCents | string | null | undefined, completeness: "complete" | "partial" | "unavailable", currency = "USD"): string {
  if (value === null || value === undefined || completeness === "unavailable") return "Unknown";
  return completeness === "complete" ? formatMoney(value, currency) : `Known ${formatMoney(value, currency)}`;
}

/** Incurred on the cost summary: a known subtotal until coverage and labor are complete. */
export function incurredLabel(summary: { currency: string; completeness: "complete" | "partial" | "unavailable"; incurred: { totalCents: MoneyCents | string | null } }): string {
  return formatQualifiedMoney(summary.incurred.totalCents, summary.completeness, summary.currency);
}

/** Paid on the cost summary: unknown when unavailable, a known subtotal when partial. */
export function paidLabel(summary: { currency: string; paid: { cents: MoneyCents | string | null; knownCents: MoneyCents | string; coverage: "complete" | "partial" | "unavailable" } }): string {
  const { paid } = summary;
  return paid.coverage === "complete" && paid.cents !== null ? formatMoney(paid.cents, summary.currency) : formatQualifiedMoney(paid.knownCents, paid.coverage === "complete" ? "partial" : paid.coverage, summary.currency);
}
