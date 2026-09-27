import type { TenantPayableAccount } from "@shared/tenant-payment-contracts";
import { isQuickBooksHostedInvoiceUrl, type QboTenantPaymentLink, type QboTenantPaymentView } from "@shared/tenant-qbo-payment-contracts";

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

export const quickBooksUnavailableMessage = "Online payments are not available yet.";

export interface TenantPaymentSession {
  accountId: string;
  generation: number;
}

export function isCurrentTenantPaymentSession(current: TenantPaymentSession | null, started: TenantPaymentSession | null, accountId: string): boolean {
  return !!current && !!started && current.accountId === accountId && started.accountId === accountId && current.generation === started.generation;
}

function exactCents(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d{0,17})$/.test(value);
}

/** Keep untrusted server data out of payment controls and display only approved positive invoice balances. */
export function availableQuickBooksInvoices(view: QboTenantPaymentView | null | undefined): QboTenantPaymentView["invoices"] {
  if (view?.provider !== "quickbooks" || view.available !== true || !Array.isArray(view.invoices)) return [];
  return view.invoices.filter((invoice) =>
    !!invoice &&
    typeof invoice.id === "string" && invoice.id.length > 0 && invoice.id.length <= 160 &&
    typeof invoice.number === "string" && invoice.number.length > 0 && invoice.number.length <= 100 &&
    exactCents(invoice.balanceCents) && BigInt(invoice.balanceCents) > BigInt(0) &&
    (invoice.dueDate === null || typeof invoice.dueDate === "string"),
  );
}

/** Format exact decimal-string cents without converting through floating-point numbers. */
export function formatQuickBooksCents(value: string): string {
  if (!exactCents(value)) return "Unavailable";
  const cents = BigInt(value);
  const dollars = cents / BigInt(100);
  const remainder = String(cents % BigInt(100)).padStart(2, "0");
  return `$${new Intl.NumberFormat("en-US").format(dollars)}.${remainder}`;
}

/** The POST response must still match the selected invoice and the hosted QuickBooks origin. */
export function trustedQuickBooksInvoiceUrl(result: unknown, expectedInvoiceId: string): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const link = result as Partial<QboTenantPaymentLink>;
  return link.invoiceId === expectedInvoiceId && isQuickBooksHostedInvoiceUrl(link.url) ? link.url : undefined;
}

/** Navigate in the same tab while keeping the tenant portal URL out of the referrer. */
export function openQuickBooksInvoice(documentRef: Document, url: string): boolean {
  if (!isQuickBooksHostedInvoiceUrl(url)) return false;
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.rel = "noreferrer";
  anchor.referrerPolicy = "no-referrer";
  anchor.hidden = true;
  documentRef.body.appendChild(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); }
  return true;
}
