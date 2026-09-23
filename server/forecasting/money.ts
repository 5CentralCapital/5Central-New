import { allocateCents, centsFromBigInt, centsToBigInt } from "../../shared/company";

/**
 * Exact integer money arithmetic for the forecast engine.
 *
 * Rounding policy (documented in docs/company/forecast-model.md): every
 * proration, percentage and interest calculation rounds once, half to even
 * ("banker's rounding"), on an exact rational. Spreads of one total across
 * several periods use the largest-remainder allocation from shared/company so
 * the parts always sum to the total.
 */
export const ZERO = BigInt(0);
export const ONE = BigInt(1);
const TWO = BigInt(2);
export const BPS = BigInt(10_000);

export function big(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("Integer expected");
    return BigInt(value);
  }
  return centsToBigInt(value);
}

export function text(value: bigint): string {
  return centsFromBigInt(value);
}

/** numerator / denominator rounded half to even. Denominator must be positive. */
export function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new RangeError("Denominator must be positive");
  const negative = numerator < ZERO;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const doubled = (absolute % denominator) * TWO;
  if (doubled > denominator || (doubled === denominator && quotient % TWO !== ZERO)) quotient += ONE;
  return negative ? -quotient : quotient;
}

/** amount × bps / 10,000, half to even. */
export function applyBps(amount: bigint, bps: number): bigint {
  return divideHalfEven(amount * BigInt(bps), BPS);
}

/** amount × (10,000 + bps) / 10,000, half to even. */
export function growByBps(amount: bigint, bps: number): bigint {
  return divideHalfEven(amount * (BPS + BigInt(bps)), BPS);
}

/** amount × part / whole, half to even. */
export function prorate(amount: bigint, part: number, whole: number): bigint {
  if (whole <= 0) throw new RangeError("Proration base must be positive");
  return divideHalfEven(amount * BigInt(part), BigInt(whole));
}

/** Split a total by integer weights; parts always sum to the total. */
export function allocate(total: bigint, weights: readonly (number | bigint)[]): bigint[] {
  if (!weights.length) return [];
  if (weights.every(weight => BigInt(weight) === ZERO)) return weights.map(() => ZERO);
  return allocateCents(text(total), weights.map(weight => BigInt(weight).toString())).map(value => BigInt(value));
}

export function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, ZERO);
}

export function minBig(left: bigint, right: bigint): bigint { return left < right ? left : right; }
export function maxBig(left: bigint, right: bigint): bigint { return left > right ? left : right; }

export function power(base: bigint, exponent: number): bigint {
  let result = ONE;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining & 1) result *= factor;
    factor *= factor;
    remaining >>= 1;
  }
  return result;
}

/**
 * Level monthly payment for principal P over n months at an annual rate in
 * basis points, computed on exact rationals: P·r·(1+r)^n / ((1+r)^n − 1) with
 * r = bps / 120,000. Rounded once, half to even.
 */
export function levelPayment(principal: bigint, annualRateBps: number, months: number): bigint {
  if (months <= 0) throw new RangeError("Amortization months must be positive");
  if (annualRateBps === 0) return divideHalfEven(principal, BigInt(months));
  const base = BigInt(120_000);
  const rate = BigInt(annualRateBps);
  const grown = power(base + rate, months);
  const flat = power(base, months);
  return divideHalfEven(principal * rate * grown, base * (grown - flat));
}
