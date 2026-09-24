import type { AdminBalanceReviewView } from "../types";
import { formatLongDate, formatTableDate } from "../../../lib/rent-ops-formatters";
import { formatDate, formatMoney } from "./display";

/** Reviewed observations never replace the posted ledger or imply a payer split. */
export function balanceReviewDisplay(review: AdminBalanceReviewView | undefined) {
  if (!review) return undefined;
  return {
    label: review.stale ? "Historical reviewed balance" : "Reviewed operational balance",
    amount: review.reviewedBalanceCents === null ? "Unknown" : formatMoney(review.reviewedBalanceCents),
    date: `As of ${formatDate(review.asOfDate)}`,
    reviewedOn: `Reviewed ${formatLongDate(review.asOfDate) ?? formatDate(review.asOfDate)}`,
    warning: review.stale ? "New ledger activity since review — review again." : undefined,
    qualification: review.qualifications.join(" · "),
    payerSplit: `Tenant: ${review.tenantBalanceCents === null ? "Unknown" : formatMoney(review.tenantBalanceCents)} · Agency: ${review.agencyBalanceCents === null ? "Unknown" : formatMoney(review.agencyBalanceCents)}`,
  };
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
}

export interface TenantHeaderBalance {
  label: "Balance due";
  /** Formatted amount, or undefined when the amount is not known (never shown as $0). */
  amount?: string;
  /** Text for the "Not verified" marker when the amount is unknown. */
  unknownLabel: string;
  unknownReason: string;
  /** Muted line under the amount: "Reviewed Sep 10, 2026" or the posted-ledger date. */
  detail: string;
  /** Stale-review warning, carried over unchanged. */
  warning?: string;
  /** Present when the posted ledger is known and differs from the reviewed balance. */
  ledgerDifference?: { label: string; explanation: string };
}

/**
 * One balance for the tenant header. A reviewed operational balance is the
 * tenant's balance due; the posted ledger is shown only as a difference to
 * reconcile. Without a review the posted ledger balance is shown as before.
 * Values are only formatted here — nothing is recomputed.
 */
export function tenantHeaderBalance(review: AdminBalanceReviewView | undefined, posted: PostedBalanceInput): TenantHeaderBalance {
  if (review) {
    const shown = balanceReviewDisplay(review)!;
    const known = review.reviewedBalanceCents !== null;
    const ledgerKnown = posted.complete && posted.amountCents !== null && Number.isFinite(posted.amountCents);
    const differs = known && ledgerKnown && posted.amountCents !== review.reviewedBalanceCents;
    const shortDate = formatTableDate(review.asOfDate) ?? formatDate(review.asOfDate);
    return {
      label: "Balance due",
      amount: known ? shown.amount : undefined,
      unknownLabel: "Not verified",
      unknownReason: `The ${shortDate} review did not confirm an amount.`,
      detail: shown.reviewedOn,
      warning: shown.warning,
      ledgerDifference: differs ? {
        label: `Ledger shows ${posted.format ? posted.format(posted.amountCents!) : formatMoney(posted.amountCents)}`,
        explanation: `The posted ledger differs from the ${shortDate} review. Reconcile on the Ledger tab.`,
      } : undefined,
    };
  }
  const known = posted.complete && posted.amountCents !== null && Number.isFinite(posted.amountCents);
  const asOf = formatLongDate(posted.asOfDate);
  return {
    label: "Balance due",
    amount: known ? (posted.format ? posted.format(posted.amountCents!) : formatMoney(posted.amountCents)) : undefined,
    unknownLabel: posted.unknownLabel || "Not verified",
    unknownReason: posted.unknownReason || "The posted ledger balance is not complete.",
    detail: asOf ? `Posted ledger · as of ${asOf}` : "Posted ledger",
  };
}
