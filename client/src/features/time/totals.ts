export interface TimeMoneyValue {
  readonly cents: string | null | undefined;
  readonly currency: string | null | undefined;
}

export interface TimeCurrencyTotal {
  readonly currency: string;
  readonly cents: string | null;
  readonly knownCount: number;
  readonly unknownCount: number;
}

/** Group exact time amounts by uppercase three-letter currency-code bucket; an unknown currency is never subtotaled. */
export function sumTimeMoneyByCurrency(values: readonly TimeMoneyValue[]): readonly TimeCurrencyTotal[] {
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
