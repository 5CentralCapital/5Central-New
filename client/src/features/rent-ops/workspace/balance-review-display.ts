import type { AdminBalanceReviewView } from "../types";
import { formatLongDate, formatTableDate } from "../../../lib/rent-ops-formatters";
import { formatDate, formatMoney } from "./display";

/** The last balance review as a checkpoint (amount on its date); never a second balance. */
export function balanceReviewDisplay(review: AdminBalanceReviewView | undefined) {
  if (!review) return undefined;
  return {
    label: "Last balance review",
    amount: review.reviewedBalanceCents === null ? "Unknown" : formatMoney(review.reviewedBalanceCents),
    date: `As of ${formatDate(review.asOfDate)}`,
    reviewedOn: `Reviewed ${formatLongDate(review.asOfDate) ?? formatDate(review.asOfDate)}`,
    warning: undefined as string | undefined,
    qualification: review.qualifications.join(" · "),
    payerSplit: `Tenant: ${review.tenantBalanceCents === null ? "Unknown" : formatMoney(review.tenantBalanceCents)} · Agency: ${review.agencyBalanceCents === null ? "Unknown" : formatMoney(review.agencyBalanceCents)}`,
  };
}

/**
 * The account's one balance: the reviewed amount on its date, rolled forward
 * by posted activity dated after it. Null when it cannot be established.
 */
export function reviewedBalanceNowCents(review: AdminBalanceReviewView, postedCents: number | null): number | null {
  if (review.reviewedBalanceCents === null) return null;
  if (postedCents !== null && typeof review.postedAtReviewCents === "number") return review.reviewedBalanceCents + (postedCents - review.postedAtReviewCents);
  return review.stale ? null : review.reviewedBalanceCents;
}

/** Amount the ledger must be trued up by on the review date so the ledger alone shows the audited balance (0 when reconciled). */
export function ledgerTrueUpCents(review: AdminBalanceReviewView | undefined): number | null {
  if (!review || review.reviewedBalanceCents === null || typeof review.postedAtReviewCents !== "number") return null;
  return review.reviewedBalanceCents - review.postedAtReviewCents;
}

export function balanceReviewReportText(review: AdminBalanceReviewView | undefined): string {
  const display = balanceReviewDisplay(review);
  if (!display) return "Not reviewed";
  return [display.amount, display.date, display.warning, display.qualification, display.payerSplit].filter(Boolean).join(" · ");
}

/** The posted ledger balance as the tenant record already resolves it. */
export interface PostedBalanceInput {
  complete: boolean;
  amountCents: number | null;
  /** Label for an incomplete posted balance (the existing review-code label). */
  unknownLabel?: string;
  /** Longer explanation for an incomplete posted balance. */
  unknownReason?: string;
  asOfDate?: string;
  /** Formatter for posted amounts, so the header matches the ledger table. */
  format?: (cents: number) => string;
  /** The balances report's computed balance for this account; preferred so every screen shows the same number. */
  balanceCents?: number | null;
}

export interface TenantHeaderBalance {
  label: "Balance";
  /** Formatted amount, or undefined when the amount is not known (never shown as $0). */
  amount?: string;
  /** Text for the "Not verified" marker when the amount is unknown. */
  unknownLabel: string;
  unknownReason: string;
  /** Muted line under the amount: "Reviewed Sep 10, 2026 + later activity" or the as-of date. */
  detail: string;
  /** Present when the ledger before the review date still needs a true-up entry. */
  ledgerDifference?: { label: string; explanation: string };
}

/**
 * One balance for the tenant header: the reviewed balance rolled forward by
 * later ledger activity, or the ledger balance when no review exists. A
 * pre-review ledger gap is shown only as a reconcile action.
 */
export function tenantHeaderBalance(review: AdminBalanceReviewView | undefined, posted: PostedBalanceInput): TenantHeaderBalance {
  const format = (cents: number) => posted.format ? posted.format(cents) : formatMoney(cents);
  const ledgerKnown = posted.complete && posted.amountCents !== null && Number.isFinite(posted.amountCents);
  if (review) {
    const cents = typeof posted.balanceCents === "number" ? posted.balanceCents : reviewedBalanceNowCents(review, ledgerKnown ? posted.amountCents : null);
    const shortDate = formatTableDate(review.asOfDate) ?? formatDate(review.asOfDate);
    const trueUp = ledgerTrueUpCents(review);
    return {
      label: "Balance",
      amount: cents === null ? undefined : format(cents),
      unknownLabel: "Not verified",
      unknownReason: review.reviewedBalanceCents === null ? `The ${shortDate} review did not confirm an amount.` : "Ledger activity since the last review could not be read.",
      detail: `Reviewed ${shortDate}`,
      ledgerDifference: trueUp ? {
        label: `Ledger off by ${format(Math.abs(trueUp))}`,
        explanation: `The ledger before ${shortDate} is ${format(Math.abs(trueUp))} ${trueUp > 0 ? "lower" : "higher"} than the reviewed balance. Post a ${shortDate} adjustment so the ledger matches.`,
      } : undefined,
    };
  }
  const asOf = formatTableDate(posted.asOfDate ?? "") ?? formatLongDate(posted.asOfDate);
  return {
    label: "Balance",
    amount: ledgerKnown ? format(posted.amountCents!) : undefined,
    unknownLabel: posted.unknownLabel || "Not verified",
    unknownReason: posted.unknownReason || "The ledger balance is not complete.",
    detail: asOf ? `As of ${asOf}` : "",
  };
}
