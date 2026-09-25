import type { AccountingTransaction } from "./types";
import { sumCents } from "./format";

/** Bills and bill payments describe different stages of the same money. Keep types and states separate. */
export function transactionTotals(items: readonly AccountingTransaction[]) {
  const groups = new Map<string, { type: string; currency: string; state: string; count: number; amounts: string[] }>();
  for (const item of items) {
    const key = JSON.stringify([item.transactionType, item.currency, item.postingState]);
    const group = groups.get(key) ?? { type: item.transactionType, currency: item.currency, state: item.postingState, count: 0, amounts: [] };
    group.count += 1; group.amounts.push(item.amountCents); groups.set(key, group);
  }
  return Array.from(groups.values()).map(({ amounts, ...group }) => ({ ...group, amountCents: sumCents(amounts) }));
}
