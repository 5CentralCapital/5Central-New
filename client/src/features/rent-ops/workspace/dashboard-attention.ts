// Ranked "Needs attention" items for the dashboard (design audit D3).
// Built only from rows the dashboard already loads: money first, then
// vacancy, then moves. Unknown amounts are never counted as zero.
import { daysBetween, displayPersonName, formatTableDate } from "../../../lib/rent-ops-formatters";
import { formatExactDollars, splitDueRows } from "./dashboard-kpis";

type Row = Record<string, unknown>;
const isCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const text = (value: unknown) => typeof value === "string" ? value : value == null ? "" : String(value);

export type AttentionTone = "critical" | "warning" | "neutral" | "positive";
export interface AttentionItem {
  key: "balances" | "vacancy" | "moves";
  tone: AttentionTone;
  title: string;
  detail: string;
}

/** Days of vacancy that count as long-vacant on the dashboard. */
export const LONG_VACANCY_DAYS = 90;

function place(row: Row): string {
  const property = text(row.propertyName);
  const unit = text(row.unitNumber);
  return [property, unit].filter(Boolean).join(" · ");
}

export function balanceAttention(dueRows: Row[] | undefined, asOfDate: string): AttentionItem | undefined {
  if (!dueRows) return undefined;
  const split = splitDueRows(dueRows);
  if (!split.knownCount && !split.unverifiedCount) return undefined;
  const known = dueRows.filter(row => isCents(row.operationalBalanceCents) && row.operationalBalanceCents > 0);
  const oldest = [...known].filter(row => typeof row.oldestUnpaidRentOn === "string" && row.oldestUnpaidRentOn)
    .sort((a, b) => text(a.oldestUnpaidRentOn).localeCompare(text(b.oldestUnpaidRentOn)))[0];
  const oldestDays = oldest ? daysBetween(oldest.oldestUnpaidRentOn, asOfDate) : undefined;
  const title = split.knownCount
    ? `${split.knownCount} ${split.knownCount === 1 ? "tenant owes" : "tenants owe"} ${formatExactDollars(split.knownCents)}`
    : `${split.unverifiedCount} ${split.unverifiedCount === 1 ? "balance" : "balances"} not verified`;
  const parts: string[] = [];
  if (oldest) parts.push(`Oldest unpaid ${formatTableDate(oldest.oldestUnpaidRentOn, Number(asOfDate.slice(0, 4))) ?? text(oldest.oldestUnpaidRentOn)} · ${displayPersonName(text(oldest.tenantName)) || "Tenant"}${place(oldest) ? `, ${place(oldest)}` : ""}, ${formatExactDollars(oldest.operationalBalanceCents as number)}`);
  if (split.knownCount && split.unverifiedCount) parts.push(`${split.unverifiedCount} more not verified`);
  return { key: "balances", tone: split.knownCount && (oldestDays ?? 0) >= 30 ? "critical" : split.knownCount ? "warning" : "neutral", title, detail: parts.join(" · ") };
}

export function vacancyAttention(vacancy: Row[] | undefined): AttentionItem | undefined {
  if (!vacancy || !vacancy.length) return undefined;
  const vacant = vacancy.filter(row => row.occupancy !== "future_preleased");
  if (!vacant.length) return undefined;
  const withDays = vacant.filter(row => typeof row.daysVacant === "number" && Number.isFinite(row.daysVacant)) as Array<Row & { daysVacant: number }>;
  const long = withDays.filter(row => row.daysVacant >= LONG_VACANCY_DAYS).sort((a, b) => b.daysVacant - a.daysVacant);
  const longest = [...withDays].sort((a, b) => b.daysVacant - a.daysVacant)[0];
  const title = long.length
    ? `${long.length} of ${vacant.length} vacant units empty ${LONG_VACANCY_DAYS}+ days`
    : `${vacant.length} vacant ${vacant.length === 1 ? "unit" : "units"}`;
  const detail = longest ? `Longest: ${place(longest)}, ${longest.daysVacant} days` : "Days vacant not recorded";
  return { key: "vacancy", tone: long.length ? "warning" : "neutral", title, detail };
}

export function moveAttention(movements: Row[] | undefined, asOfDate: string): AttentionItem | undefined {
  const upcoming = (movements ?? []).filter(row => row.state !== "Completed" && text(row.date) >= asOfDate);
  if (!upcoming.length) return undefined;
  const outs = upcoming.filter(row => row.movement === "Move out");
  const ins = upcoming.filter(row => row.movement === "Move in");
  const last = upcoming.map(row => text(row.date)).sort().at(-1)!;
  const year = Number(asOfDate.slice(0, 4));
  const counts = [outs.length ? `${outs.length} move-out${outs.length === 1 ? "" : "s"}` : "", ins.length ? `${ins.length} move-in${ins.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  const detail = upcoming.slice(0, 3).map(row => `${text(row.unitNumber) || text(row.propertyName)} ${row.date === asOfDate ? "today" : `on ${formatTableDate(row.date, year) ?? text(row.date)}`}`).join(" · ");
  return { key: "moves", tone: outs.length ? "warning" : "neutral", title: `${counts} by ${formatTableDate(last, year) ?? last}`, detail };
}

export function rentalAttentionItems(input: { dueRows?: Row[]; vacancy?: Row[]; movements?: Row[]; asOfDate: string }): AttentionItem[] {
  return [balanceAttention(input.dueRows, input.asOfDate), vacancyAttention(input.vacancy), moveAttention(input.movements, input.asOfDate)]
    .filter((item): item is AttentionItem => Boolean(item));
}
