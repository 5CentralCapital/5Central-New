import { z } from "zod";
import { centsSchema, isoDateSchema } from "@shared/company";
import type { CompanyContext } from "@shared/company/context";
import {
  QBO_BALANCE_VERIFICATION_STATES,
  QBO_RECEIVABLE_DOCUMENT_TYPES,
  QBO_RECEIVABLE_EFFECT_KINDS,
  type QboCustomerLedger,
  type QboCustomerLedgerEntry,
  type QboReceivableDocumentType,
} from "@shared/accounting/receivables";
import { dateLabel, dateTimeLabel, formatCents } from "./format";
import type { AccountingConnection, AccountingEnvironment, AccountingMirror } from "./types";

/*
 * View model for a tenancy's QuickBooks customer ledger (plan QS04, manager
 * UI). Pure functions only: the response is validated here, and every amount
 * stays an exact cents string formatted through BigInt. Unknown or unread data
 * is labelled as such and never rendered as $0.00.
 */

const entrySchema = z.object({
  objectType: z.enum(QBO_RECEIVABLE_DOCUMENT_TYPES),
  objectId: z.string().min(1),
  version: z.string(),
  txnDate: isoDateSchema,
  dueDate: isoDateSchema.nullable(),
  docNumber: z.string().nullable(),
  kinds: z.array(z.enum(QBO_RECEIVABLE_EFFECT_KINDS)),
  amountCents: centsSchema,
  runningBalanceCents: centsSchema,
  openBalanceCents: centsSchema.nullable(),
  postingState: z.enum(["posted", "voided"]),
});

const ledgerSchema = z.object({
  scope: z.object({ organizationId: z.string(), legalEntityId: z.string(), environment: z.enum(["sandbox", "production"]), realmId: z.string() }),
  customer: z.object({ objectId: z.string().min(1), displayName: z.string().nullable(), active: z.boolean().nullable() }),
  asOf: isoDateSchema.nullable(),
  entries: z.array(entrySchema),
  totals: z.object({ chargesCents: centsSchema, creditsCents: centsSchema, paymentsCents: centsSchema, adjustmentsCents: centsSchema, endingBalanceCents: centsSchema }),
  openItems: z.array(z.object({
    objectType: z.enum(["Invoice", "CreditMemo", "Payment"]),
    objectId: z.string().min(1),
    docNumber: z.string().nullable(),
    txnDate: isoDateSchema,
    dueDate: isoDateSchema.nullable(),
    openBalanceCents: centsSchema,
    daysPastDue: z.number().int().nullable(),
  })),
  aging: z.object({ currentCents: centsSchema, days1To30Cents: centsSchema, days31To60Cents: centsSchema, days61To90Cents: centsSchema, over90Cents: centsSchema }).nullable(),
  verification: z.object({ state: z.enum(QBO_BALANCE_VERIFICATION_STATES), providerBalanceCents: centsSchema.nullable(), computedBalanceCents: centsSchema.nullable(), reason: z.string().nullable() }),
  coverage: z.object({ status: z.enum(["complete", "partial", "unavailable"]), reasons: z.array(z.string()), observedAt: z.string().nullable() }),
  page: z.object({ total: z.number().int().min(0), nextCursor: z.string().nullable() }),
});

/** Validates a customer-ledger response; throws on anything it cannot read exactly. */
export function parseCustomerLedger(value: unknown): QboCustomerLedger {
  return ledgerSchema.parse(value);
}

export type LedgerTone = "good" | "warning" | "error";

export const QBO_DOCUMENT_TYPE_LABELS: Readonly<Record<QboReceivableDocumentType, string>> = {
  Invoice: "Invoice",
  CreditMemo: "Credit memo",
  Payment: "Payment",
  SalesReceipt: "Sales receipt",
  RefundReceipt: "Refund receipt",
  JournalEntry: "Journal entry",
};

/** How long a complete read stays current before the view warns that it may be out of date. */
export const QBO_LEDGER_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Amount of the document already applied: invoice paid down, payment or credit
 * used. QuickBooks reports open balances only for invoices, credit memos and
 * payments; other documents have nothing to apply (null).
 */
export function appliedCents(entry: Pick<QboCustomerLedgerEntry, "amountCents" | "openBalanceCents" | "postingState">): string | null {
  if (entry.openBalanceCents === null || entry.postingState === "voided") return null;
  const amount = BigInt(entry.amountCents);
  const magnitude = amount < BigInt(0) ? -amount : amount;
  return (magnitude - BigInt(entry.openBalanceCents)).toString();
}

export interface QboLedgerRow {
  readonly key: string;
  readonly date: string;
  readonly type: string;
  readonly number: string;
  readonly amount: string;
  readonly applied: string;
  readonly open: string;
  readonly balance: string;
  readonly voided: boolean;
}

export function customerLedgerRows(entries: readonly QboCustomerLedgerEntry[]): QboLedgerRow[] {
  return entries.map(entry => {
    const applied = appliedCents(entry);
    return {
      key: `${entry.objectType}:${entry.objectId}:${entry.version}`,
      date: dateLabel(entry.txnDate),
      type: QBO_DOCUMENT_TYPE_LABELS[entry.objectType],
      number: entry.docNumber?.trim() || "—",
      amount: formatCents(entry.amountCents),
      applied: applied === null ? "—" : formatCents(applied),
      open: entry.openBalanceCents === null ? "—" : formatCents(entry.openBalanceCents),
      balance: formatCents(entry.runningBalanceCents),
      voided: entry.postingState === "voided",
    };
  });
}

export interface CoverageDisplay {
  readonly tone: LedgerTone;
  readonly title: string;
  readonly reasons: readonly string[];
  readonly asOfLabel: string;
  readonly stale: boolean;
  /** False when nothing has been read yet: balances and totals must show as unknown. */
  readonly amountsKnown: boolean;
}

export function coverageDisplay(coverage: QboCustomerLedger["coverage"], now: Date): CoverageDisplay {
  const observed = coverage.observedAt ? Date.parse(coverage.observedAt) : Number.NaN;
  const asOfLabel = Number.isFinite(observed) ? dateTimeLabel(coverage.observedAt) : "Never";
  if (coverage.status === "unavailable") {
    return { tone: "error", title: "QuickBooks receivables have not been read yet", reasons: coverage.reasons.length ? coverage.reasons : ["Run a QuickBooks refresh for this company, then reload."], asOfLabel, stale: false, amountsKnown: false };
  }
  const stale = !Number.isFinite(observed) || now.getTime() - observed > QBO_LEDGER_STALE_AFTER_MS;
  const staleReason = `Last confirmed QuickBooks read: ${asOfLabel}. Newer QuickBooks activity may not be shown.`;
  if (coverage.status === "partial") {
    return { tone: "warning", title: "Partial QuickBooks coverage", reasons: stale ? [...coverage.reasons, staleReason] : coverage.reasons, asOfLabel, stale, amountsKnown: true };
  }
  if (stale) return { tone: "warning", title: "QuickBooks data may be out of date", reasons: [staleReason], asOfLabel, stale, amountsKnown: true };
  return { tone: "good", title: "Complete QuickBooks coverage", reasons: [], asOfLabel, stale, amountsKnown: true };
}

export interface VerificationDisplay {
  readonly tone: LedgerTone;
  readonly label: string;
  readonly detail: string | null;
}

export function verificationDisplay(verification: QboCustomerLedger["verification"]): VerificationDisplay {
  const provider = verification.providerBalanceCents;
  const computed = verification.computedBalanceCents;
  switch (verification.state) {
    case "verified":
      return { tone: "good", label: "Matches QuickBooks", detail: `QuickBooks customer balance ${formatCents(provider)}.` };
    case "mismatch": {
      const difference = provider !== null && computed !== null ? formatCents((BigInt(provider) - BigInt(computed)).toString()) : "Unknown";
      return { tone: "error", label: "Does not match QuickBooks", detail: `QuickBooks reports ${formatCents(provider)}; the mirrored history totals ${formatCents(computed)} (difference ${difference}).${verification.reason ? ` ${verification.reason}.` : ""}` };
    }
    case "unverified":
      return { tone: "warning", label: "Not verified", detail: [provider !== null ? `QuickBooks customer balance ${formatCents(provider)}.` : null, verification.reason ? `${verification.reason}.` : null].filter(Boolean).join(" ") || null };
    default:
      return { tone: "warning", label: "QuickBooks balance unavailable", detail: verification.reason ? `${verification.reason}.` : null };
  }
}

export interface LabeledAmount { readonly label: string; readonly amount: string }

export function ledgerTotals(ledger: QboCustomerLedger, amountsKnown: boolean): LabeledAmount[] {
  const show = (value: string) => amountsKnown ? formatCents(value) : "Unknown";
  return [
    { label: "Charges", amount: show(ledger.totals.chargesCents) },
    { label: "Credits", amount: show(ledger.totals.creditsCents) },
    { label: "Payments and refunds", amount: show(ledger.totals.paymentsCents) },
    { label: "Adjustments", amount: show(ledger.totals.adjustmentsCents) },
    { label: "Ending balance", amount: show(ledger.totals.endingBalanceCents) },
  ];
}

/** Aging buckets, or null when QuickBooks open balances cannot age the requested date. */
export function agingRows(aging: QboCustomerLedger["aging"]): LabeledAmount[] | null {
  if (!aging) return null;
  return [
    { label: "Current", amount: formatCents(aging.currentCents) },
    { label: "1–30 days", amount: formatCents(aging.days1To30Cents) },
    { label: "31–60 days", amount: formatCents(aging.days31To60Cents) },
    { label: "61–90 days", amount: formatCents(aging.days61To90Cents) },
    { label: "Over 90 days", amount: formatCents(aging.over90Cents) },
  ];
}

export interface OpenItemRow {
  readonly key: string;
  readonly type: string;
  readonly number: string;
  readonly date: string;
  readonly due: string;
  readonly open: string;
  readonly pastDue: string;
}

export function openItemRows(items: QboCustomerLedger["openItems"]): OpenItemRow[] {
  return items.map(item => ({
    key: `${item.objectType}:${item.objectId}`,
    type: item.objectType === "Invoice" ? "Invoice" : item.objectType === "CreditMemo" ? "Unused credit" : "Unapplied payment",
    number: item.docNumber?.trim() || "—",
    date: dateLabel(item.txnDate),
    due: dateLabel(item.dueDate),
    open: formatCents(item.openBalanceCents),
    pastDue: item.daysPastDue === null ? "—" : item.daysPastDue === 0 ? "Not past due" : `${item.daysPastDue} day${item.daysPastDue === 1 ? "" : "s"}`,
  }));
}

export interface QboTarget {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly legalEntityId: string;
  readonly entityName: string;
  /** Owner, admin and finance may link a tenancy; other roles read only. */
  readonly canLink: boolean;
}

const LINK_ROLES: readonly string[] = ["owner", "admin", "finance"];

/** The company and legal entity that own a property in the signed-in manager's authorized context. */
export function qboTargetForProperty(context: CompanyContext | undefined, propertyId: string | null | undefined): QboTarget | null {
  if (!context || !propertyId) return null;
  for (const organization of context.organizations) {
    const entity = organization.entities.find(candidate => candidate.properties.some(property => property.id === propertyId));
    if (entity) return { organizationId: organization.id, organizationName: organization.name, legalEntityId: entity.id, entityName: entity.name, canLink: LINK_ROLES.includes(organization.role) };
  }
  return null;
}

export type QboConnectionState =
  | { readonly kind: "not-configured" }
  | { readonly kind: "not-connected" }
  | { readonly kind: "ready"; readonly environment: AccountingEnvironment; readonly connections: readonly AccountingConnection[]; readonly needsReconnect: boolean };

export function qboConnectionState(configuration: { readonly configured: boolean; readonly environment: AccountingEnvironment | null }, connections: readonly AccountingConnection[]): QboConnectionState {
  if (!configuration.configured || !configuration.environment) return { kind: "not-configured" };
  const matching = connections.filter(connection => connection.scope.environment === configuration.environment);
  if (!matching.length) return { kind: "not-connected" };
  return { kind: "ready", environment: configuration.environment, connections: matching, needsReconnect: matching.every(connection => connection.status === "needs_reconnect") };
}

/** Customers matching a search on name or QuickBooks id; active customers first. */
export function filterCustomers(customers: readonly AccountingMirror[], search: string, limit = 100): AccountingMirror[] {
  const needle = search.trim().toLowerCase();
  const matches = customers.filter(customer => !needle || customer.displayName.toLowerCase().includes(needle) || customer.providerObjectId.toLowerCase() === needle);
  return [...matches.filter(customer => customer.active), ...matches.filter(customer => !customer.active)].slice(0, limit);
}

export function customerOptionLabel(customer: AccountingMirror): string {
  return `${customer.displayName} · QuickBooks #${customer.providerObjectId}${customer.active ? "" : " (inactive)"}`;
}
