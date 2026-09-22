import { z } from "zod";

export const TENANT_PAYMENT_STATUSES = ["creating", "pending", "processing", "posted", "failed", "cancelled", "partially_refunded", "refunded", "disputed", "review_required"] as const;
export type TenantPaymentStatus = typeof TENANT_PAYMENT_STATUSES[number];
export const tenantCheckoutSchema = z.object({
  tenancyId: z.string().min(1).max(160),
  amountCents: z.number().int().min(50).max(99_999_999),
  requestId: z.string().uuid(),
}).strict();
export type TenantCheckoutInput = z.infer<typeof tenantCheckoutSchema>;
export interface TenantPaymentView {
  id: string;
  tenancyId: string;
  amountCents: number;
  currency: "usd";
  status: TenantPaymentStatus;
  createdAt: string;
  postedOn?: string;
}
export interface TenantPayableAccount {
  tenancyId: string;
  payableCents: number;
  pendingCents: number;
  available: boolean;
  reason?: string;
}
export interface TenantPaymentsView {
  available: boolean;
  reason?: "stripe_not_configured";
  payments: TenantPaymentView[];
  accounts: TenantPayableAccount[];
}
export interface TenantCheckoutResult { id: string; checkoutUrl: string; status: "pending" }
