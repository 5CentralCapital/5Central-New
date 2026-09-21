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

export function assertCanonicalCents(value: string): MoneyCents {
  const parsed = BigInt(value);
  if (parsed < BIGINT_CENTS_MIN || parsed > BIGINT_CENTS_MAX || !/^(0|-?[1-9]\d*)$/.test(value)) {
    throw new Error("Expected canonical signed cents.");
  }
  return value as MoneyCents;
}
