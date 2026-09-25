import { daysBetween } from "../../lib/rent-ops-formatters";
import { compareCentsText, formatMeasure, humanize, sumCentsTexts } from "./format";
import { legacyCents, type RentalRow } from "./models";

/**
 * Collections › Balances due view model (presentation only). Rows come from
 * `balancesDue`; this splits them by the report's tenancy status and groups
 * known balances ahead of balances that cannot be verified yet.
 */
export type TenantScope = "current" | "former";

/** Former tenants are rows the report marks "former"; every other status stays in the current view so no row is hidden. */
export function rowScope(row: RentalRow): TenantScope {
  return row.tenancyStatus === "former" ? "former" : "current";
}

export interface BalanceGroups { known: RentalRow[]; unverified: RentalRow[] }

function tenantKey(row: RentalRow): string {
  return String(row.tenantName ?? "").toLocaleLowerCase();
}

/** Known balances by amount (largest first); unknown balances in their own group, by tenant. */
export function groupBalances(rows: readonly RentalRow[], scope: TenantScope): BalanceGroups {
  const inScope = rows.filter(row => rowScope(row) === scope);
  const known = inScope.filter(row => legacyCents(row.operationalBalanceCents) !== null)
    .sort((left, right) => compareCentsText(legacyCents(right.operationalBalanceCents), legacyCents(left.operationalBalanceCents)) || tenantKey(left).localeCompare(tenantKey(right)));
  const unverified = inScope.filter(row => legacyCents(row.operationalBalanceCents) === null)
    .sort((left, right) => tenantKey(left).localeCompare(tenantKey(right)));
  return { known, unverified };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "current tenants · $22,039.79 across 14 accounts"; "At least" stays when any balance is unknown. */
export function balancesScopeSummary(groups: BalanceGroups, scope: TenantScope): string {
  const label = scope === "current" ? "current tenants" : "former tenants";
  const rows = [...groups.known, ...groups.unverified];
  if (!rows.length) return `${label} · none`;
  const total = sumCentsTexts(rows.map(row => legacyCents(row.operationalBalanceCents)));
  if (total.total === null) return `${label} · ${plural(rows.length, "account")} not verified`;
  return `${label} · ${formatMeasure(total.total, total.complete)} across ${plural(rows.length, "account")}`;
}

/** Tooltip reason for a balance that cannot be confirmed, from the report's uncertainty codes. */
export function unverifiedReason(row: RentalRow): string {
  const codes = Array.isArray(row.balanceUncertaintyCodes) ? row.balanceUncertaintyCodes.filter((code): code is string => typeof code === "string" && !!code.trim()) : [];
  return codes.length ? codes.map(code => humanize(code)).join(", ") : "Balance can't be confirmed until the ledger is reconciled";
}

export interface BalanceAge { days: number; label: string; tone: "neutral" | "warning" | "error" }

/** Age of the oldest unpaid charge against the page's as-of date; undefined when either date is missing. */
export function balanceAge(oldestUnpaidOn: unknown, asOfDate: string): BalanceAge | undefined {
  const days = daysBetween(oldestUnpaidOn, asOfDate);
  if (days === undefined || days < 0) return undefined;
  return { days, label: plural(days, "day"), tone: days >= 90 ? "error" : days >= 30 ? "warning" : "neutral" };
}
