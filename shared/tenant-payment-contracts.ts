import { z } from "zod";

export const TENANT_PAYMENT_STATUSES = ["creating", "pending", "processing", "posted", "failed", "cancelled", "partially_refunded", "refunded", "disputed", "review_required"] as const;
export type TenantPaymentStatus = typeof TENANT_PAYMENT_STATUSES[number];
export const TENANT_PAYMENT_QUEUE_REASONS = ["review_required", "disputed", "stale_active"] as const;
export type TenantPaymentQueueReason = typeof TENANT_PAYMENT_QUEUE_REASONS[number];
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
export interface TenantPaymentReviewView extends TenantPaymentView {
  accountId: string;
  personId: string;
  propertyId: string;
  unitId: string;
  requestId: string;
  expiresAt: string;
  updatedAt: string;
  checkoutSessionId?: string;
  paymentIntentId?: string;
  currentLedgerCents: number;
  ledgerRevision: number;
  stale: boolean;
  queueReason: TenantPaymentQueueReason;
  adjustments: Array<{
    paymentId: string;
    providerObjectId: string;
    kind: "refund" | "dispute";
    amountCents: number;
    active: boolean;
    providerCreatedAt: number;
    terminal: boolean;
  }>;
}
