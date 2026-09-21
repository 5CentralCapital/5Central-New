import { z } from "zod";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

/** Canonical decimal output has no exponent, leading integer zeros, or -0. */
export type DecimalString = Brand<string, "DecimalString">;
export type DecimalRounding = "half_away_from_zero" | "half_even" | "toward_zero" | "floor" | "ceil";
export const DECIMAL_ROUNDING_MODES = ["half_away_from_zero", "half_even", "toward_zero", "floor", "ceil"] as const;

const DECIMAL_SYNTAX = /^(-?)(\d+)(?:\.(\d+))?$/;
export const MAX_DECIMAL_SCALE = 1_000;

export interface DecimalParts {
  readonly sign: 1 | -1;
  /** Always non-negative and reduced for trailing fractional zeros. */
  readonly coefficient: bigint;
  readonly scale: number;
  readonly canonical: DecimalString;
}

export function parseDecimalParts(value: unknown): DecimalParts {
  if (typeof value !== "string") throw new TypeError("Decimal values must be strings");
  const match = DECIMAL_SYNTAX.exec(value);
  if (!match) throw new RangeError("Expected a plain decimal string");

  let integer = match[2];
  let fraction = match[3] ?? "";
  if (fraction.length > MAX_DECIMAL_SCALE) {
    throw new RangeError(`Decimal scale cannot exceed ${MAX_DECIMAL_SCALE} places`);
  }
  fraction = fraction.replace(/0+$/, "");
  integer = integer.replace(/^0+(?=\d)/, "");
  const coefficientDigits = `${integer}${fraction}` || "0";
  const coefficient = BigInt(coefficientDigits);
  const sign: 1 | -1 = coefficient === BigInt(0) ? 1 : match[1] === "-" ? -1 : 1;
  const canonical = coefficient === BigInt(0)
    ? "0"
    : `${sign < 0 ? "-" : ""}${integer}${fraction.length > 0 ? `.${fraction}` : ""}`;

  return { sign, coefficient, scale: fraction.length, canonical: canonical as DecimalString };
}

export function canonicalizeDecimal(value: string): DecimalString {
  return parseDecimalParts(value).canonical;
}

export const decimalSchema = z.string()
  .refine((value) => {
    const match = DECIMAL_SYNTAX.exec(value);
    return match !== null && (match[3] === undefined || match[3].length <= MAX_DECIMAL_SCALE);
  }, "Expected a plain decimal string within the supported scale")
  .transform((value) => canonicalizeDecimal(value));

export function decimalPower10(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DECIMAL_SCALE) {
    throw new RangeError(`Decimal scale must be an integer from 0 to ${MAX_DECIMAL_SCALE}`);
  }
  return BigInt(`1${"0".repeat(scale)}`);
}

function expandExponential(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) return value;
  const sign = match[1];
  const integer = match[2];
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  if (!Number.isSafeInteger(exponent)) throw new RangeError("Legacy number exponent is too large");
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + exponent;
  if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

/** Explicit adapter for old JSON numbers; all later arithmetic uses text. */
export function legacyNumberToDecimal(value: number): DecimalString {
  if (!Number.isFinite(value)) throw new RangeError("Legacy decimal number must be finite");
  return canonicalizeDecimal(expandExponential(String(value)));
}

function roundRational(numerator: bigint, denominator: bigint, rounding: DecimalRounding): bigint {
  if (denominator <= BigInt(0)) throw new RangeError("Rounding denominator must be positive");
  if (!(DECIMAL_ROUNDING_MODES as readonly string[]).includes(rounding)) {
    throw new RangeError(`Unsupported decimal rounding mode: ${String(rounding)}`);
  }
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;

  if (remainder !== BigInt(0)) {
    if (rounding === "ceil" && !negative) quotient += BigInt(1);
    if (rounding === "floor" && negative) quotient += BigInt(1);
    if (rounding === "half_away_from_zero") {
      const doubled = remainder * BigInt(2);
      if (doubled >= denominator) quotient += BigInt(1);
    }
    if (rounding === "half_even") {
      const doubled = remainder * BigInt(2);
      if (doubled > denominator || (doubled === denominator && quotient % BigInt(2) !== BigInt(0))) {
        quotient += BigInt(1);
      }
    }
  }

  return negative ? -quotient : quotient;
}

/**
 * Multiply exact decimal quantity and rate, then round the dollar result to
 * cents. Rounding is explicit so negative half-cent behavior is deliberate.
 */
export function multiplyDecimalToCentsBigInt(
  quantity: string,
  rate: string,
  rounding: DecimalRounding = "half_away_from_zero",
): bigint {
  const quantityParts = parseDecimalParts(quantity);
  const rateParts = parseDecimalParts(rate);
  const signedCoefficient = (quantityParts.sign < 0 ? BigInt(-1) : BigInt(1)) * quantityParts.coefficient
    * (rateParts.sign < 0 ? BigInt(-1) : BigInt(1)) * rateParts.coefficient;
  const numerator = signedCoefficient * BigInt(100);
  const denominator = decimalPower10(quantityParts.scale + rateParts.scale);
  return roundRational(numerator, denominator, rounding);
}
