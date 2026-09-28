import { z } from "zod";

export interface QboTenantPaymentInvoice {
  id: string;
  number: string;
  /** Exact USD cents, never converted through floating-point arithmetic. */
  balanceCents: string;
  dueDate: string | null;
}

export interface QboTenantPaymentView {
  provider: "quickbooks";
  available: boolean;
  reasons: string[];
  invoices: QboTenantPaymentInvoice[];
}

export interface QboTenantPaymentLink {
  invoiceId: string;
  url: string;
}

export const qboTenantPaymentLinkSchema = z.object({
  invoiceId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
}).strict();

/** Only a provider-returned hosted invoice is accepted; never a supplied redirect. */
export function isQuickBooksHostedInvoiceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "connect.intuit.com" || url.port || url.username || url.password || url.hash) return false;
    if (!/^\/portal\/app\/CommerceNetwork\/view\/[A-Za-z0-9_-]+$/.test(url.pathname)) return false;
    let safeQuery = true;
    url.searchParams.forEach((_value, name) => { if (/redirect|return|next|callback|url/i.test(name)) safeQuery = false; });
    return safeQuery;
  } catch { return false; }
}
