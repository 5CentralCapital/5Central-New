import type { RentOpsLedgerTransaction, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";
import type { TenantPayableAccount, TenantPaymentStatus } from "../../../shared/tenant-payment-contracts";
import { presentTenantHome, tenantAccountLedgerRows, eligibleTenantTenancies } from "../tenant-portal/presentation";
import { validateAllocation } from "../domain/invariants";
import { deriveTenantLedger } from "../domain/reports";

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
  const pendingCents = payments.filter((row) => row.personId === identity.personId && paymentIsReserved(row, now)).reduce((sum, row) => sum + row.amountCents, 0);
  const blocked = (reason: string): TenantPayableAccount => ({ tenancyId: identity.tenancyId, payableCents: 0, pendingCents, available: false, reason });
  if (snapshot.people.find(row => row.id === identity.personId)?.paymentReviewReason === "assistance_responsibility_unverified") return blocked("assistance_responsibility_unverified");
  const home = presentTenantHome(snapshot, { ...identity, id: "payment-check", email: "", status: "active" }, asOf);
  if (!home?.balance.complete || home.balance.amountCents === null) return blocked("balance_review_required");
  const entries = tenantAccountLedgerRows(snapshot, identity);
  const grant = exactPaymentTenancy(snapshot, identity).tenancy;
  const foreign = entries.filter(row => row.propertyId !== grant.propertyId || (!!row.unitId && row.unitId !== grant.unitId));
  const unknownCharges = new Set(entries.filter(row => row.kind === "charge" && (!row.category || row.categoryKnowledge === "unknown")).map(row => row.id));
  const transactions = new Map(snapshot.ledgerTransactions.map(row => [row.id,row]));
  const accountIds = new Set(entries.map(row => row.id));
  const foreignIds = new Set(foreign.map(row=>row.id));
  const allocationProof = snapshot.paymentAllocations.filter(allocation => {
    if (!unknownCharges.has(allocation.chargeTransactionId ?? "") && !foreignIds.has(allocation.chargeTransactionId ?? "") && !foreignIds.has((allocation.kind === "credit_allocation" ? allocation.creditTransactionId : allocation.paymentTransactionId) ?? "")) return true;
    if (!accountIds.has(allocation.chargeTransactionId ?? "") || !accountIds.has((allocation.kind === "credit_allocation" ? allocation.creditTransactionId : allocation.paymentTransactionId) ?? "")) return false;
    const strict = snapshot.modelVersion === 3 || !!allocation.source;
    const known = (value: string | null | undefined, allowed: string[]) => allowed.includes(value ?? "") || (!strict && value === undefined);
    if (!known(allocation.amountKnowledge,["known"]) || !known(allocation.allocatedOnKnowledge,["source","manual"]) || !known(allocation.chargeLinkKnowledge,["exact","manual"]) || !known(allocation.kind === "credit_allocation" ? allocation.creditLinkKnowledge : allocation.paymentLinkKnowledge,["exact","manual"])) return false;
    return validateAllocation(allocation,transactions.get(allocation.paymentTransactionId ?? ""),transactions.get(allocation.chargeTransactionId ?? ""),snapshot.ledgerTransactions,true,snapshot.paymentAllocations).length === 0;
  });
  const openById = new Map(deriveTenantLedger({...snapshot,ledgerTransactions:entries,paymentAllocations:allocationProof},identity.tenancyId,{asOfDate:asOf},new Set(entries.map(row=>row.id))).map(row=>[row.transaction.id,row.openCents]));
  if (entries.some(row => row.kind === "charge" && (!row.unitId || [row.propertyLinkKnowledge,row.unitLinkKnowledge].some(value => value !== "exact" && value !== "manual" && (!!row.source || snapshot.modelVersion === 3 || value !== undefined))) && openById.get(row.id) !== 0)) return blocked("account_scope_payment_review_required");
  if (foreign.some(row => {
    const exact = (value: string | null | undefined) => value === "exact" || (!row.source && value === "manual");
    const unit = snapshot.units.find(unit=>unit.id===row.unitId);
    if (row.propertyId !== grant.propertyId || !unit || unit.propertyId !== grant.propertyId || !exact(row.personLinkKnowledge) || !exact(row.propertyLinkKnowledge) || !exact(row.unitLinkKnowledge) || !["exact","manual"].includes(unit.propertyLinkKnowledge ?? "")) return true;
    if (!["charge","payment","credit","reversal"].includes(row.kind ?? "")) return true;
    return openById.get(row.id) !== 0;
  })) return blocked("account_scope_payment_review_required");
  if (entries.some((row) => (!row.postedOn || row.postedOn <= asOf) && (row.status === null || (row.status === "posted" && (!Number.isSafeInteger(row.amountCents) || !row.postedOn || !row.kind ||
    (row.kind === "charge" && (!row.category || row.categoryKnowledge === "unknown") && openById.get(row.id) !== 0) ||
    (row.kind === "adjustment" && (!row.category || row.categoryKnowledge === "unknown" || !row.adjustmentDirection))))))) return blocked("balance_review_required");

  // An RM gross charge can include agency obligation. Never ask a resident to
  // pay that share until a dedicated HAP-to-tenant allocation is available.
  if (snapshot.subsidyContracts.some((row) => row.tenancyId === identity.tenancyId && row.status !== "ended")) return blocked("housing_assistance_review_required");
  if (payments.some((row) => row.status === "review_required")) return blocked("payment_review_required");
  // Use the complete account net: removing deposit charges but retaining their
  // applied receipts would subtract deposit money from rent a second time.
  // The open eligible-charge cap below prevents collecting deposits as rent.
  const net = home.balance.amountCents;
  const open = eligibleCharges(snapshot, identity.tenancyId, asOf).reduce((sum, row) => sum + row.openCents, 0);
  const amount = Math.max(0, Math.min(net, open) - pendingCents);
  return { tenancyId: identity.tenancyId, payableCents: amount, pendingCents, available: amount >= 50, ...(amount < 50 ? { reason: "no_payable_balance" } : {}) };
}
export function eligibleCharges(snapshot: RentOpsSnapshot, tenancyId: string, asOf: string): { transaction: RentOpsLedgerTransaction; openCents: number }[] {
  const tenancy = snapshot.tenancies.find(row => row.id === tenancyId);
  const scopedIds = new Set(tenancy ? tenantAccountLedgerRows(snapshot, {tenancyId, personId: tenancy.primaryPersonId}).map(row => row.id) : []);
  return deriveTenantLedger({...snapshot,ledgerTransactions:snapshot.ledgerTransactions.filter(row=>scopedIds.has(row.id))}, tenancyId, { asOfDate: asOf }, scopedIds).filter((row): row is typeof row & { openCents: number } => typeof row.openCents === "number").filter(({ transaction: row, openCents }) => row.propertyId === tenancy?.propertyId && row.unitId === tenancy?.unitId && [row.propertyLinkKnowledge,row.unitLinkKnowledge].every(value => value === "exact" || value === "manual" || (!row.source && snapshot.modelVersion !== 3 && value === undefined)) && row.kind === "charge" && row.status === "posted" && row.category && payableCategories.has(row.category) && row.payer !== "agency" && (!row.dueOn || row.dueOn <= asOf) && openCents > 0)
    .sort((a, b) => (a.transaction.dueOn ?? a.transaction.postedOn ?? "").localeCompare(b.transaction.dueOn ?? b.transaction.postedOn ?? "") || a.transaction.id.localeCompare(b.transaction.id));
}

/** Read-only import/operator gate. Unknown balances never become payable defaults. */
export function tenantFinancialReadiness(snapshot: RentOpsSnapshot, now: Date) {
  return eligibleTenantTenancies(snapshot).filter(row => row.status === "current" || row.status === "notice").map(identity => {
    const entries = tenantAccountLedgerRows(snapshot, identity);
    const home = presentTenantHome(snapshot, {...identity,id:"readiness",email:identity.email ?? "",status:"active"},businessDate(now));
    const payable = payableAccount(snapshot,identity,[],now);
    return {personId:identity.personId,tenancyId:identity.tenancyId,ledgerRows:entries.length,
      balanceComplete:home?.balance.complete === true,balanceCents:home?.balance.amountCents ?? null,
      paymentAvailable:payable.available,payableCents:payable.payableCents,paymentReason:payable.reason ?? null};
  });
}
