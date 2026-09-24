/** Exact, display-ready summaries for accounting lists.
 *
 * Amounts remain decimal cent strings at the UI boundary. A null or malformed
 * amount is carried through as unknown rather than being treated as zero.
 */

export type AmountCents = string | null | undefined;

export interface AmountSummary {
  readonly currency: string;
  /** Null means at least one included amount was unknown. */
  readonly totalCents: string | null;
  /** Number of items included by the predicate. */
  readonly count: number;
  readonly knownCount: number;
  readonly unknownCount: number;
}

export interface SummarizeAmountsOptions<T> {
  readonly amount?: (item: T) => AmountCents;
  readonly currency?: (item: T) => string;
  /** Excluded items still establish a currency group, with a zero total. */
  readonly include?: (item: T) => boolean;
}

function isCents(value: AmountCents): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value);
}

/**
 * Sums amounts exactly by currency. BigInt is used for every addition, and a
 * group becomes unknown when any included item lacks a valid cent amount.
 */
export function summarizeAmounts<T extends { readonly amountCents: AmountCents; readonly currency: string }>(
  items: readonly T[],
  options: SummarizeAmountsOptions<T> = {},
): readonly AmountSummary[] {
  const amount = options.amount ?? ((item: T) => item.amountCents);
  const currency = options.currency ?? ((item: T) => item.currency);
  const groups = new Map<string, { total: bigint; count: number; knownCount: number; unknownCount: number }>();

  for (const item of items) {
    const code = currency(item);
    const group = groups.get(code) ?? { total: BigInt(0), count: 0, knownCount: 0, unknownCount: 0 };
    groups.set(code, group);
    if (options.include && !options.include(item)) continue;

    group.count += 1;
    const value = amount(item);
    if (!isCents(value)) {
      group.unknownCount += 1;
      continue;
    }
    group.knownCount += 1;
    group.total += BigInt(value);
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, group]) => ({
      currency: code,
      totalCents: group.unknownCount > 0 ? null : group.total.toString(),
      count: group.count,
      knownCount: group.knownCount,
      unknownCount: group.unknownCount,
    }));
}
