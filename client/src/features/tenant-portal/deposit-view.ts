import { usdCurrencyFormatter } from '../../lib/rent-ops-formatters';
/** A signed source balance does not establish the amount of cash held. */
export function depositMoney(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? usdCurrencyFormatter.format(value / 100)
    : "Unavailable";
}

export function depositAmounts(deposit: { amountHeldCents?: number | null; sourceBalanceCents?: number | null }) {
  return {
    held: depositMoney(deposit.amountHeldCents),
    sourceBalance: typeof deposit.sourceBalanceCents === "number" && Number.isSafeInteger(deposit.sourceBalanceCents)
      ? depositMoney(deposit.sourceBalanceCents) : undefined,
  };
}
