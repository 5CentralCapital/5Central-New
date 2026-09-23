// Headline figures for the dashboard summary strip.
import { reviewLabelForCodes, reviewReason, UNKNOWN_AMOUNT_LABEL, UNVERIFIED_LABEL } from "@shared/review-cases/reasons";
// Derived only from rows the dashboard already loads. Unknown inputs never render as zero.

type Row = Record<string, unknown>;

export type KpiTone = "normal" | "attention" | "review";

export interface DashboardKpi {
  key: "occupancy" | "rent" | "receipts" | "due";
  label: string;
  value: string;
  detail: string;
  tone: KpiTone;
  /** 0–1 share for an optional meter; omitted when not meaningful or unknown. */
  share?: number;
}

/** Unknown quantities read "Unknown", never zero; details carry the specific review label. */
const REVIEW = UNKNOWN_AMOUNT_LABEL;
const isCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

export function formatWholeDollars(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
}

/** Most material review label across the balance rows that are not known. */
function dueReviewLabel(rows: Row[]): string {
  const codes = rows.filter(row => !isCents(row.operationalBalanceCents))
    .flatMap(row => Array.isArray(row.balanceUncertaintyCodes) ? row.balanceUncertaintyCodes.filter((code): code is string => typeof code === "string") : []);
  return reviewLabelForCodes(codes);
}

function sum(rows: Row[] | undefined, key: string): number | undefined {
  if (!rows) return undefined;
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    if (!isCents(value)) return undefined;
    total += value;
  }
  return total;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  const month = match ? Number(match[2]) : 0;
  return match && month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${match[1]}` : period;
}

export function dashboardKpis(input: {
  propertyRows?: Row[];
  dueRows?: Row[];
  receipts?: Row[];
  period: string;
}): DashboardKpi[] {
  const { propertyRows, dueRows, receipts } = input;
  const period = formatPeriod(input.period);

  let units = 0, occupied = 0, vacant = 0, preleased = 0, unknown = 0, rentUnknown = 0;
  let occupancyKnown = Boolean(propertyRows);
  for (const row of propertyRows ?? []) {
    const values = [row.unitCount, row.occupied, row.vacant, row.preleased, row.unknown].map(count);
    if (values.some(value => value === undefined)) { occupancyKnown = false; break; }
    units += values[0]!; occupied += values[1]!; vacant += values[2]!; preleased += values[3]!; unknown += values[4]!;
    rentUnknown += count(row.rentUnknown) ?? 1;
  }
  const occupancy: DashboardKpi = !occupancyKnown || units === 0
    ? { key: "occupancy", label: "Occupancy", value: propertyRows && units === 0 && occupancyKnown ? "—" : REVIEW, detail: "Occupied units", tone: "review" }
    : {
        key: "occupancy",
        label: "Occupancy",
        value: `${Math.round((100 * occupied) / units)}%`,
        detail: `${occupied} of ${units} units · ${vacant} vacant${preleased ? ` · ${preleased} preleased` : ""}${unknown ? ` · ${unknown} unknown` : ""}`,
        tone: unknown ? "review" : "normal",
        share: occupied / units,
      };

  const rentTotal = sum(propertyRows, "rent");
  const rent: DashboardKpi = rentTotal === undefined || !occupancyKnown || rentUnknown || unknown
    ? { key: "rent", label: "Occupied base rent", value: REVIEW, detail: rentUnknown ? reviewReason("rent_amount_unknown").shortLabel : UNVERIFIED_LABEL, tone: "review" }
    : { key: "rent", label: "Occupied base rent", value: formatWholeDollars(rentTotal), detail: "Monthly, current tenancies", tone: "normal" };

  const receiptTotal = sum(receipts, "amountCents");
  const collected: DashboardKpi = receiptTotal === undefined
    ? { key: "receipts", label: "Rent received", value: REVIEW, detail: `Posted receipts · ${period}`, tone: "review" }
    : {
        key: "receipts",
        label: "Rent received",
        value: formatWholeDollars(receiptTotal),
        detail: `${receipts!.length} posted receipt${receipts!.length === 1 ? "" : "s"} · ${period}`,
        tone: "normal",
        ...(rentTotal !== undefined && rentTotal > 0 && rent.tone === "normal" ? { share: Math.min(1, receiptTotal / rentTotal) } : {}),
      };

  const dueTotal = sum(dueRows, "operationalBalanceCents");
  const accounts = dueRows?.length ?? 0;
  const due: DashboardKpi = !dueRows
    ? { key: "due", label: "Balances due", value: REVIEW, detail: "Delinquency not loaded", tone: "review" }
    : dueTotal === undefined
      ? { key: "due", label: "Balances due", value: REVIEW, detail: `${dueReviewLabel(dueRows)} · ${accounts} account${accounts === 1 ? "" : "s"}`, tone: "review" }
      : {
          key: "due",
          label: "Balances due",
          value: formatWholeDollars(dueTotal),
          detail: accounts ? `${accounts} account${accounts === 1 ? "" : "s"}` : "No open balances",
          tone: dueTotal > 0 ? "attention" : "normal",
        };

  return [occupancy, rent, collected, due];
}
