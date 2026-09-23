import { z } from "zod";
import type { CurrencyCode, IsoDate, MoneyCents } from "../company";

/**
 * QuickBooks receivables as the posted authority for tenant financial
 * history (QBO Financial Source Plan, QS02/QS04). Amounts are exact signed
 * cents encoded as decimal strings; a positive effect increases what the
 * customer owes, a negative effect reduces it.
 */
export const QBO_RECEIVABLE_DOCUMENT_TYPES = ["Invoice", "CreditMemo", "Payment", "SalesReceipt", "RefundReceipt", "JournalEntry"] as const;
export type QboReceivableDocumentType = (typeof QBO_RECEIVABLE_DOCUMENT_TYPES)[number];
export const qboReceivableDocumentTypeSchema = z.enum(QBO_RECEIVABLE_DOCUMENT_TYPES);

export const QBO_RECEIVABLE_EFFECT_KINDS = ["charge", "discount", "credit", "payment", "receipt", "refund", "adjustment"] as const;
export type QboReceivableEffectKind = (typeof QBO_RECEIVABLE_EFFECT_KINDS)[number];

export const QBO_RECEIVABLE_APPLICATION_TARGETS = ["Invoice", "CreditMemo", "JournalEntry"] as const;
export type QboReceivableApplicationTarget = (typeof QBO_RECEIVABLE_APPLICATION_TARGETS)[number];

/** Checkpoint streams for the receivables mirror; customers carry names and provider balances. */
export const QBO_RECEIVABLE_STREAMS = [
  "receivables.invoice",
  "receivables.creditmemo",
  "receivables.payment",
  "receivables.salesreceipt",
  "receivables.refundreceipt",
  "receivables.journalentry",
  "customers",
] as const;
export type QboReceivableStream = (typeof QBO_RECEIVABLE_STREAMS)[number];

export function receivableStreamFor(type: QboReceivableDocumentType | "Customer"): QboReceivableStream {
  return type === "Customer" ? "customers" : `receivables.${type.toLowerCase()}` as QboReceivableStream;
}

export interface QboReceivableEffect {
  readonly effectId: string;
  readonly lineNumber: number;
  readonly customerObjectId: string;
  readonly kind: QboReceivableEffectKind;
  readonly amountCents: MoneyCents;
  readonly accountObjectId: string | null;
  readonly itemObjectId: string | null;
  readonly classObjectId: string | null;
  readonly departmentObjectId: string | null;
  readonly serviceDate: IsoDate | null;
  readonly description: string | null;
}

export interface QboReceivableApplication {
  readonly applicationId: string;
  readonly targetType: QboReceivableApplicationTarget;
  readonly targetId: string;
  readonly amountCents: MoneyCents;
}

/** One provider revision of a receivable document, fully understood. */
export interface QboReceivableDocument {
  readonly objectType: QboReceivableDocumentType;
  readonly objectId: string;
  readonly version: string;
  readonly providerUpdatedAt: string;
  readonly txnDate: IsoDate;
  readonly dueDate: IsoDate | null;
  readonly docNumber: string | null;
  /** Null only for a JournalEntry; its effects name their customers. */
  readonly customerObjectId: string | null;
  readonly currency: CurrencyCode;
  readonly totalCents: MoneyCents;
  readonly openBalanceCents: MoneyCents | null;
  readonly postingState: "posted" | "voided";
  readonly emailStatus: "NotSet" | "NeedToSend" | "EmailSent" | null;
  readonly allowOnlineCard: boolean | null;
  readonly allowOnlineAch: boolean | null;
  readonly allowIpn: boolean | null;
  readonly billEmailPresent: boolean;
  readonly effects: readonly QboReceivableEffect[];
  readonly applications: readonly QboReceivableApplication[];
}

/** Verified state of a displayed balance; never a silent zero. */
export const QBO_BALANCE_VERIFICATION_STATES = ["verified", "mismatch", "unverified", "unavailable"] as const;
export type QboBalanceVerificationState = (typeof QBO_BALANCE_VERIFICATION_STATES)[number];

export interface QboCustomerLedgerEntry {
  readonly objectType: QboReceivableDocumentType;
  readonly objectId: string;
  readonly version: string;
  readonly txnDate: IsoDate;
  readonly dueDate: IsoDate | null;
  readonly docNumber: string | null;
  readonly kinds: readonly QboReceivableEffectKind[];
  /** Net effect of this document on this customer. */
  readonly amountCents: MoneyCents;
  /** Running balance after this document, over the customer's complete history. */
  readonly runningBalanceCents: MoneyCents;
  readonly openBalanceCents: MoneyCents | null;
  readonly postingState: "posted" | "voided";
}

export interface QboAgingBuckets {
  readonly currentCents: MoneyCents;
  readonly days1To30Cents: MoneyCents;
  readonly days31To60Cents: MoneyCents;
  readonly days61To90Cents: MoneyCents;
  readonly over90Cents: MoneyCents;
}

export interface QboCustomerLedger {
  readonly scope: { readonly organizationId: string; readonly legalEntityId: string; readonly environment: "sandbox" | "production"; readonly realmId: string };
  readonly customer: { readonly objectId: string; readonly displayName: string | null; readonly active: boolean | null };
  readonly asOf: IsoDate | null;
  readonly entries: readonly QboCustomerLedgerEntry[];
  readonly totals: {
    readonly chargesCents: MoneyCents;
    readonly creditsCents: MoneyCents;
    readonly paymentsCents: MoneyCents;
    readonly adjustmentsCents: MoneyCents;
    readonly endingBalanceCents: MoneyCents;
  };
  readonly openItems: readonly { readonly objectType: "Invoice" | "CreditMemo" | "Payment"; readonly objectId: string; readonly docNumber: string | null; readonly txnDate: IsoDate; readonly dueDate: IsoDate | null; readonly openBalanceCents: MoneyCents; readonly daysPastDue: number | null }[];
  readonly aging: QboAgingBuckets | null;
  readonly verification: {
    readonly state: QboBalanceVerificationState;
    readonly providerBalanceCents: MoneyCents | null;
    readonly computedBalanceCents: MoneyCents | null;
    readonly reason: string | null;
  };
  readonly coverage: {
    readonly status: "complete" | "partial" | "unavailable";
    readonly reasons: readonly string[];
    readonly observedAt: string | null;
  };
  readonly page: { readonly total: number; readonly nextCursor: string | null };
}
