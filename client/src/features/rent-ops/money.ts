/**
 * Convert a user-entered dollar amount to integer cents without rounding.
 *
 * Monetary inputs in the admin and applicant surfaces are deliberately
 * strict: values with more than two fractional digits are invalid rather than
 * being silently changed by Math.round().
 */
export function parseCentsInput(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || !/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return undefined;

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const whole = Number(wholePart || "0");
  const fractional = Number((fractionalPart || "").padEnd(2, "0") || "0");
  const cents = whole * 100 + fractional;
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/**
 * Applied amounts for a payment correction, one per existing allocation.
 * "0" unapplies a charge; a blank field is an error, never a silent unapply.
 */
export function requireAppliedCents(values: readonly string[]): number[] {
  return values.map(value => requireCentsInput(value, "Applied amount"));
}

/**
 * Parse a required admin monetary field and fail before a request is sent.
 */
export function requireCentsInput(value: unknown, label = "Amount"): number {
  const text = typeof value === "string" ? value.trim() : "";
  const cents = parseCentsInput(value);
  if (cents === undefined) {
    throw new Error(text ? `${label} must use dollars with no more than two decimal places.` : `${label} is required.`);
  }
  return cents;
}
