export interface MoneyValue {
  readonly cents: string | null | undefined;
  readonly currency: string | null | undefined;
}

export interface CurrencyTotal {
  readonly currency: string;
  readonly cents: string | null;
  readonly knownCount: number;
  readonly unknownCount: number;
}

/** Group signed cents by uppercase three-letter currency-code bucket without converting through a JavaScript number. */
export function sumMoneyByCurrency(values: readonly MoneyValue[]): readonly CurrencyTotal[] {
  const totals = new Map<string, { total: bigint; knownCount: number; unknownCount: number }>();
  for (const value of values) {
    const currency = value.currency?.trim() ?? "";
    if (!/^[A-Z]{3}$/.test(currency)) {
      const unknown = totals.get("Unknown currency") ?? { total: BigInt(0), knownCount: 0, unknownCount: 0 };
      unknown.unknownCount += 1;
      totals.set("Unknown currency", unknown);
      continue;
    }
    const current = totals.get(currency) ?? { total: BigInt(0), knownCount: 0, unknownCount: 0 };
    if (value.cents === null || value.cents === undefined || value.cents === "" || !/^-?\d+$/.test(value.cents)) current.unknownCount += 1;
    else {
      current.total += BigInt(value.cents);
      current.knownCount += 1;
    }
    totals.set(currency, current);
  }
  return Array.from(totals.entries()).map(([currency, value]) => ({ currency, cents: value.knownCount ? value.total.toString() : null, knownCount: value.knownCount, unknownCount: value.unknownCount })).sort((left, right) => left.currency.localeCompare(right.currency));
}

/**
 * Money values for amounts that may be only partly known. A null exact amount
 * contributes its known minimum and is also counted as unknown, so totals read
 * "$X + 1 unknown" instead of presenting the minimum as an exact figure.
 */
export function partiallyKnownMoneyValues(items: readonly { readonly exactCents: string | null | undefined; readonly knownMinimumCents: string | null | undefined; readonly currency: string | null | undefined }[]): MoneyValue[] {
  return items.flatMap(item => item.exactCents === null || item.exactCents === undefined
    ? [{ cents: item.knownMinimumCents, currency: item.currency }, { cents: null, currency: item.currency }]
    : [{ cents: item.exactCents, currency: item.currency }]);
}
