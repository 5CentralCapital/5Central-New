import { parseDecimalParts, decimalPower10 } from "./decimal";
import { centsFromBigInt, centsToBigInt, parseCents, type MoneyCents } from "./money";

export const MAX_ALLOCATION_ITEMS = 10_000;

/**
 * Allocate a signed total by exact non-negative decimal weights. The largest
 * remainder method and original index tie-breaker make repeated runs stable.
 */
export function allocateCents(totalCents: MoneyCents | string, weights: readonly string[]): MoneyCents[] {
  const total = centsToBigInt(parseCents(totalCents));
  if (weights.length === 0) throw new RangeError("At least one allocation weight is required");
  if (weights.length > MAX_ALLOCATION_ITEMS) throw new RangeError(`At most ${MAX_ALLOCATION_ITEMS} allocations are supported`);

  const parts = weights.map((weight) => parseDecimalParts(weight));
  if (parts.some((part) => part.sign < 0)) throw new RangeError("Allocation weights cannot be negative");
  if (parts.every((part) => part.coefficient === BigInt(0))) throw new RangeError("At least one allocation weight must be positive");

  const commonScale = parts.reduce((maximum, part) => Math.max(maximum, part.scale), 0);
  const weightNumerators = parts.map((part) => part.coefficient * decimalPower10(commonScale - part.scale));
  const weightTotal = weightNumerators.reduce((sum, weight) => sum + weight, BigInt(0));
  if (weightTotal <= BigInt(0)) throw new RangeError("Allocation weights must sum to a positive value");

  const negative = total < BigInt(0);
  const absoluteTotal = negative ? -total : total;
  const rows = weightNumerators.map((weight, index) => {
    const numerator = absoluteTotal * weight;
    return {
      index,
      floor: numerator / weightTotal,
      remainder: numerator % weightTotal,
    };
  });
  const floorTotal = rows.reduce((sum, row) => sum + row.floor, BigInt(0));
  const remainderCents = absoluteTotal - floorTotal;
  // Since each fractional part is below one, the remainder is strictly less
  // than the item count and is therefore safe to use as an array index.
  const remainderCount = Number(remainderCents);
  if (!Number.isSafeInteger(remainderCount) || remainderCount < 0 || remainderCount >= weights.length + 1) {
    throw new Error("Allocation remainder invariant failed");
  }

  const order = [...rows].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });
  const extras = new Set(order.slice(0, remainderCount).map((row) => row.index));
  const result = rows.map((row) => {
    let amount = row.floor + (extras.has(row.index) ? BigInt(1) : BigInt(0));
    if (negative) amount = -amount;
    return centsFromBigInt(amount);
  });

  // Keep the invariant executable at the contract boundary, including for a
  // negative total where rounding direction is easy to get subtly wrong.
  const resultTotal = result.reduce((sum, value) => sum + centsToBigInt(value), BigInt(0));
  if (resultTotal !== total) throw new Error("Allocation results do not sum to the requested total");
  return result;
}

export const allocateCentsByWeights = allocateCents;

export function assertAllocationSum(totalCents: MoneyCents | string, allocation: readonly (MoneyCents | string)[]): void {
  const expected = centsToBigInt(parseCents(totalCents));
  const actual = allocation.reduce((sum, value) => sum + centsToBigInt(value), BigInt(0));
  if (actual !== expected) throw new Error("Allocation does not sum to its total");
}
