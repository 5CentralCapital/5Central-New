/**
 * Display helpers used by the manager workspace.  Values arrive from the
 * browser API as presentation data, so an absent value must remain visibly
 * absent instead of being turned into a plausible zero or date.
 */

const NEEDS_REVIEW = "Needs review";

function integerCents(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }

  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }

  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Format an integer amount in cents as US dollars. */
export function formatMoney(value: unknown): string {
  const cents = integerCents(value);
  if (cents === undefined) return NEEDS_REVIEW;

  // Avoid displaying a negative sign for the otherwise equivalent -0 value.
  const normalizedCents = Object.is(cents, -0) ? 0 : cents;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(normalizedCents / 100);
}

function dateFromValue(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;

  // Date-only API values should be interpreted at UTC midnight.  Constructing
  // them with `new Date("YYYY-MM-DD")` is also UTC in modern engines, but the
  // explicit form keeps the intended behavior clear and consistent.
  if (typeof value === "string") {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (dateOnly) {
      const year = Number(dateOnly[1]);
      const month = Number(dateOnly[2]);
      const day = Number(dateOnly[3]);
      const timestamp = Date.UTC(year, month - 1, day);
      const date = new Date(timestamp);
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        return undefined;
      }
      return date;
    }
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Format an API date as a readable, timezone-stable calendar date. */
export function formatDate(value: unknown): string {
  const date = dateFromValue(value);
  if (!date) return NEEDS_REVIEW;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function titleWord(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Turn API enum/camel-case values into readable labels. */
export function formatLabel(value: unknown): string {
  if (value === null || value === undefined || value === "") return NEEDS_REVIEW;
  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (Array.isArray(value)) {
    return value.length ? value.map(formatLabel).join(", ") : NEEDS_REVIEW;
  }

  if (typeof value !== "string") return NEEDS_REVIEW;
  const normalized = value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[\s_-]+/g, " ")
    .trim();

  return normalized ? normalized.split(" ").map(titleWord).join(" ") : NEEDS_REVIEW;
}
