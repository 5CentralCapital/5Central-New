import { z } from "zod";
import {
  type DecimalRounding,
  multiplyDecimalToCentsBigInt,
} from "./decimal";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

/** API/database boundary type for PostgreSQL BIGINT cents. */
export type MoneyCents = Brand<string, "MoneyCents">;
export type CurrencyCode = Brand<string, "CurrencyCode">;

export const POSTGRES_SIGNED_64_MIN = BigInt("-9223372036854775808");
export const POSTGRES_SIGNED_64_MAX = BigInt("9223372036854775807");
export const POSTGRES_BIGINT_MIN = POSTGRES_SIGNED_64_MIN;
export const POSTGRES_BIGINT_MAX = POSTGRES_SIGNED_64_MAX;
export const BIGINT_CENTS_MIN = POSTGRES_SIGNED_64_MIN;
export const BIGINT_CENTS_MAX = POSTGRES_SIGNED_64_MAX;
export const LEGACY_SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);

const CANONICAL_CENTS = /^(0|-?[1-9]\d*)$/;

export function isCanonicalCents(value: unknown): value is MoneyCents {
  if (typeof value !== "string" || value.length > 20 || !CANONICAL_CENTS.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= POSTGRES_SIGNED_64_MIN && parsed <= POSTGRES_SIGNED_64_MAX;
}

export const centsSchema = z.string()
  .refine(isCanonicalCents, "Expected canonical signed-64-bit cents")
  .transform((value) => value as MoneyCents);

export function parseCents(value: unknown): MoneyCents {
  if (typeof value !== "string") throw new TypeError("Cents must be a canonical decimal string");
  if (!isCanonicalCents(value)) throw new RangeError("Cents must fit PostgreSQL signed BIGINT and use canonical text");
  return value;
}

export function centsFromBigInt(value: bigint): MoneyCents {
  if (value < POSTGRES_SIGNED_64_MIN || value > POSTGRES_SIGNED_64_MAX) {
    throw new RangeError("Cents exceed PostgreSQL signed BIGINT bounds");
  }
  return value.toString() as MoneyCents;
}

export function centsToBigInt(value: MoneyCents | string): bigint {
  return BigInt(parseCents(value));
}

/** Legacy cents numbers are admitted only when the conversion is exact. */
export function legacyNumberToCents(value: number): MoneyCents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Legacy cents number must be a safe integer");
  }
  return centsFromBigInt(BigInt(value));
}

export const centsFromLegacyNumber = legacyNumberToCents;

/** Conversion back to a legacy number is refused when it could lose cents. */
export function centsToLegacyNumber(value: MoneyCents | string): number {
  const parsed = centsToBigInt(value);
  if (parsed < -LEGACY_SAFE_INTEGER_MAX || parsed > LEGACY_SAFE_INTEGER_MAX) {
    throw new RangeError("Cents cannot be represented exactly as a JavaScript number");
  }
  return Number(parsed);
}

export const centsToSafeNumber = centsToLegacyNumber;

export const currencyCodeSchema = z.string()
  .regex(/^[A-Z]{3}$/, "Expected an upper-case ISO-4217 currency code")
  .transform((value) => value as CurrencyCode);

export const moneySchema = z.object({
  amountCents: centsSchema,
  currency: currencyCodeSchema,
}).strict();

export type Money = z.infer<typeof moneySchema>;

export function sumCents(values: readonly (MoneyCents | string)[]): MoneyCents {
  let total = BigInt(0);
  for (const value of values) total += centsToBigInt(value);
  return centsFromBigInt(total);
}

export function multiplyDecimalToCents(
  quantity: string,
  rate: string,
  rounding: DecimalRounding = "half_away_from_zero",
): MoneyCents {
  return centsFromBigInt(multiplyDecimalToCentsBigInt(quantity, rate, rounding));
}

export const multiplyQuantityRateToCents = multiplyDecimalToCents;
