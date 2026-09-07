import type { RentOpsLedgerTransaction, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";
import type { TenantPayableAccount, TenantPaymentStatus } from "../../../shared/tenant-payment-contracts";
import { presentTenantHome } from "../tenant-portal/presentation";
import { deriveTenantLedger } from "../domain/reports";
import { ledgerBalanceSign } from "../domain/invariants";

export interface TenantPayment {
  id: string; accountId: string; personId: string; tenancyId: string; propertyId: string; unitId: string;
  requestId: string; amountCents: number; currency: "usd"; status: TenantPaymentStatus;
  checkoutSessionId?: string; paymentIntentId?: string; checkoutUrl?: string;
  expiresAt: string; createdAt: string; updatedAt: string; postedOn?: string;
  currentLedgerId?: string; currentLedgerCents: number; ledgerRevision: number;
}
export interface PaymentAdjustment { paymentId: string; providerObjectId: string; kind: "refund" | "dispute"; amountCents: number; active: boolean; providerCreatedAt: number; terminal: boolean }
export interface ProcessorEvent {
  id: string; type: string; created: number; live: boolean;
  paymentId?: string; paymentIntentId?: string; checkoutSessionId?: string;
  state: "success" | "processing" | "failed" | "cancelled" | "adjustment" | "ignored";
  amountCents?: number; currency?: string; method?: "ach" | "card" | "other";
  adjustment?: Omit<PaymentAdjustment, "paymentId" | "providerCreatedAt">;
}
export interface PaymentReceipt { id: string; eventType: string; paymentId?: string; providerCreatedAt: number; outcome: "processed" | "ignored" | "review_required"; receivedAt: string }
export class TenantPaymentError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "TenantPaymentError"; }
}
export function businessDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
const payableCategories = new Set(["base_rent", "recurring_fee", "one_time_fee", "other"]);
export function exactPaymentTenancy(snapshot: RentOpsSnapshot, identity: Pick<TenantIdentity, "personId" | "tenancyId">) {
  const tenancy = snapshot.tenancies.find((row) => row.id === identity.tenancyId && row.primaryPersonId === identity.personId && row.status !== "cancelled");
  const unit = tenancy && snapshot.units.find((row) => row.id === tenancy.unitId && row.propertyId === tenancy.propertyId);
  if (!tenancy || !unit || !snapshot.people.some((row) => row.id === identity.personId)) throw new TenantPaymentError("tenant_account_unavailable", 403);
  return { tenancy, unit };
}
export function paymentIsReserved(payment: TenantPayment, now: Date): boolean {
  return payment.status === "processing" || payment.status === "review_required" || ((payment.status === "creating" || payment.status === "pending") && payment.expiresAt > now.toISOString());
}
export function payableAccount(snapshot: RentOpsSnapshot, identity: Pick<TenantIdentity, "personId" | "tenancyId">, payments: TenantPayment[], now: Date): TenantPayableAccount {
  exactPaymentTenancy(snapshot, identity);
  const asOf = businessDate(now);
  const pendingCents = payments.filter((row) => row.tenancyId === identity.tenancyId && paymentIsReserved(row, now)).reduce((sum, row) => sum + row.amountCents, 0);
  const blocked = (reason: string): TenantPayableAccount => ({ tenancyId: identity.tenancyId, payableCents: 0, pendingCents, available: false, reason });
  if (!presentTenantHome(snapshot, { ...identity, id: "payment-check", email: "", status: "active" }, asOf)?.balance.complete) return blocked("balance_review_required");
  const entries = snapshot.ledgerTransactions.filter((row) => row.tenancyId === identity.tenancyId);
  if (entries.some((row) => row.status === null || (row.status === "posted" && (!Number.isSafeInteger(row.amountCents) || !row.postedOn || !row.kind || !row.category || row.categoryKnowledge === "unknown" || (row.kind === "adjustment" && !row.adjustmentDirection))))) return blocked("balance_review_required");
  // An RM gross charge can include agency obligation. Never ask a resident to
  // pay that share until a dedicated HAP-to-tenant allocation is available.
  if (snapshot.subsidyContracts.some((row) => row.tenancyId === identity.tenancyId && row.status !== "ended")) return blocked("housing_assistance_review_required");
  if (payments.some((row) => row.status === "review_required")) return blocked("payment_review_required");
  const transactions = new Map(entries.map((row) => [row.id, row]));
  const relevant = entries.filter((row) => row.status === "posted" && row.postedOn && row.postedOn <= asOf && row.category && payableCategories.has(row.category) && row.payer !== "agency");
  const net = relevant.reduce((sum, row) => sum + ledgerBalanceSign(row, transactions) * (row.amountCents ?? 0), 0);
  const open = eligibleCharges(snapshot, identity.tenancyId, asOf).reduce((sum, row) => sum + row.openCents, 0);
  const amount = Math.max(0, Math.min(net, open) - pendingCents);
  return { tenancyId: identity.tenancyId, payableCents: amount, pendingCents, available: amount >= 50, ...(amount < 50 ? { reason: "no_payable_balance" } : {}) };
}
export function eligibleCharges(snapshot: RentOpsSnapshot, tenancyId: string, asOf: string): { transaction: RentOpsLedgerTransaction; openCents: number }[] {
  return deriveTenantLedger(snapshot, tenancyId, { asOfDate: asOf }).filter(({ transaction: row, openCents }) => row.kind === "charge" && row.status === "posted" && row.category && payableCategories.has(row.category) && row.payer !== "agency" && (!row.dueOn || row.dueOn <= asOf) && openCents > 0)
    .sort((a, b) => (a.transaction.dueOn ?? a.transaction.postedOn ?? "").localeCompare(b.transaction.dueOn ?? b.transaction.postedOn ?? "") || a.transaction.id.localeCompare(b.transaction.id));
}
