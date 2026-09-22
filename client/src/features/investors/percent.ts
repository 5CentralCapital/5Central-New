import { canonicalizeDecimal } from "@shared/company";

function percentageParts(value: string, label: string, maxFractionDigits?: number): { whole: string; fraction: string } {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`${label} must be a non-negative percentage.`);
  const whole = match[1]!.replace(/^0+(?=\d)/, "") || "0";
  const fraction = match[2] ?? "";
  if (maxFractionDigits !== undefined && fraction.length > maxFractionDigits) {
    throw new Error(`${label} supports at most ${maxFractionDigits} decimal places.`);
  }
  return { whole, fraction };
}

/** Convert the displayed ownership percentage to the integer basis points used by the API. */
export function percentageToBasisPoints(value: string): number {
  const { whole, fraction } = percentageParts(value, "Ownership", 2);
  const basisPoints = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (basisPoints > BigInt(10_000)) throw new Error("Ownership must be between 0% and 100%.");
  return Number(basisPoints);
}

/** Convert a displayed annual percentage to the exact decimal fraction expected by the API. */
export function percentageToRateDecimal(value: string): string {
  const { whole, fraction } = percentageParts(value, "Annual rate", 6);
  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length - 2;
  const raw = decimalPosition <= 0
    ? `0.${"0".repeat(-decimalPosition)}${digits}`
    : decimalPosition >= digits.length
      ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
      : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return canonicalizeDecimal(raw);
}
