import type { AdminBalanceReviewView } from "../types";
import { formatDate, formatMoney } from "./display";

/** Reviewed observations never replace the posted ledger or imply a payer split. */
export function balanceReviewDisplay(review: AdminBalanceReviewView | undefined) {
  if (!review) return undefined;
  return {
    label: review.stale ? "Historical reviewed balance" : "Reviewed operational balance",
    amount: review.reviewedBalanceCents === null ? "Unknown" : formatMoney(review.reviewedBalanceCents),
    date: `As of ${formatDate(review.asOfDate)}`,
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
