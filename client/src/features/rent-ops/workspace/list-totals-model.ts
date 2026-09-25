/**
 * Exact arithmetic for list summaries.
 *
 * API amounts currently arrive as safe integer numbers.  Summaries use bigint
 * internally so adding several safe values cannot silently round the result;
 * decimal strings are also accepted at this UI boundary for future API
 * responses that carry cents as strings.
 */

export type CentsValue = bigint | number | string | null | undefined;

export interface ExactCentsSummary {
  /** A total is null when at least one included amount is unknown. */
  total: bigint | null;
  /** Sum of values that were known, useful for diagnostics and tests. */
  knownTotal: bigint;
  knownCount: number;
  unknownCount: number;
}

export function parseExactCents(value: CentsValue): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

export function summarizeExactCents(values: readonly CentsValue[]): ExactCentsSummary {
  let knownTotal = BigInt(0);
  let knownCount = 0;
  let unknownCount = 0;
  for (const value of values) {
    const parsed = parseExactCents(value);
    if (parsed === null) {
      unknownCount += 1;
      continue;
    }
    knownTotal += parsed;
    knownCount += 1;
  }
  return {
    total: unknownCount === 0 ? knownTotal : null,
    knownTotal,
    knownCount,
    unknownCount,
  };
}

export interface RecurringChargeListRow {
  amountCents?: CentsValue;
  billingFrequency?: string | null;
  category?: string | null;
  scopeType?: string | null;
}

/** Sum only current monthly rent/fee schedules; other frequencies and shared property rates stay separate. */
export function summarizeCurrentMonthlyCharges(rows: readonly RecurringChargeListRow[]): ExactCentsSummary | null {
  const values = rows
    .filter((row) => row.billingFrequency === "monthly"
      && (row.category === "base_rent" || row.category === "recurring_fee")
      && row.scopeType !== "property")
    .map((row) => row.amountCents);
  return values.length ? summarizeExactCents(values) : null;
}

function groupedInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format an exact cents value without converting it back to a JS number. */
export function formatExactCents(value: CentsValue): string {
  const cents = parseExactCents(value);
  if (cents === null) return "Unknown";
  const negative = cents < BigInt(0);
  const absolute = negative ? -cents : cents;
  const raw = absolute.toString().padStart(3, "0");
  const dollars = raw.slice(0, -2) || "0";
  const centsPart = raw.slice(-2);
  return `${negative ? "-" : ""}$${groupedInteger(dollars)}.${centsPart}`;
}

export interface LedgerListRow {
  chargeCents?: CentsValue;
  paymentCents?: CentsValue;
  runningBalanceCents?: CentsValue;
  /** Display date used to select the latest running balance when rows are descending. */
  postedOn?: string | null;
}

export interface LedgerListTotals {
  charge: ExactCentsSummary;
  payment: ExactCentsSummary;
  /** The last displayed running balance, never a sum of running balances. */
  endingBalance: ExactCentsSummary;
}

function latestLedgerRow(rows: readonly LedgerListRow[]): LedgerListRow | undefined {
  if (!rows.length) return undefined;
  // The ledger API may return newest-first. Choose by date rather than array
  // position so a filtered or descending list still reports its latest balance.
  let latest = rows[rows.length - 1];
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (!row.postedOn) continue;
    const time = Date.parse(row.postedOn);
    if (!Number.isFinite(time) || time < latestTime) continue;
    latest = row;
    latestTime = time;
  }
  return latest;
}

export function summarizeLedgerRows(rows: readonly LedgerListRow[]): LedgerListTotals {
  const charges = rows.map((row) => row.chargeCents);
  const payments = rows.map((row) => row.paymentCents);
  // A missing value in a column that does not apply to a row is not an
  // unknown amount.  The ledger caller passes only applicable amounts for
  // charge and payment columns, so those arrays are safe to summarize.
  const charge = summarizeExactCents(charges.filter((value) => value !== undefined));
  const payment = summarizeExactCents(payments.filter((value) => value !== undefined));

  const last = latestLedgerRow(rows);
  const endingValue = last ? last.runningBalanceCents : undefined;
  const endingBalance = last
    ? summarizeExactCents([endingValue])
    : { total: null, knownTotal: BigInt(0), knownCount: 0, unknownCount: 0 };

  return { charge, payment, endingBalance };
}
