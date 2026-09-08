import type { TenantPayableAccount } from "@shared/tenant-payment-contracts";

export function noPaymentDueMessage(account: TenantPayableAccount | undefined): string | undefined {
  if (!account || account.reason !== "no_payable_balance" || account.payableCents >= 50) return undefined;
  if (account.pendingCents > 0) return "Your outstanding balance is covered by payments in progress.";
  if (account.payableCents > 0) return "Online payments require at least $0.50. Contact management about this remaining balance.";
  return "No payment is due.";
}

export function paymentReviewMessage(account: TenantPayableAccount | undefined): string | undefined {
  if (account?.reason === "assistance_responsibility_unverified") return "Management is confirming your share of the account balance and any housing assistance. Online payment will be available after that review.";
  return undefined;
}
