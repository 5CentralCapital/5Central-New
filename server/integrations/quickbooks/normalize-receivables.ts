import { centsFromBigInt, isoDateSchema, isoTimestampSchema, type CurrencyCode, type IsoDate, type MoneyCents } from "../../../shared/company";
import type { QuickBooksJsonObject } from "../../../shared/accounting/quickbooks";
import {
  QBO_RECEIVABLE_APPLICATION_TARGETS,
  QBO_RECEIVABLE_DOCUMENT_TYPES,
  type QboReceivableApplication,
  type QboReceivableApplicationTarget,
  type QboReceivableDocument,
  type QboReceivableDocumentType,
  type QboReceivableEffect,
  type QboReceivableEffectKind,
} from "../../../shared/accounting/receivables";
import { QboNormalizationError, qboAmountToCents, resolveQboCurrency, type QboCurrencyContext } from "./normalize";

/*
 * Normalizes QuickBooks customer-linked transactions into receivable
 * effects. The rules follow how QuickBooks computes a customer's balance:
 *
 *   Invoice        +line amounts (discount lines negative)          = +TotalAmt
 *   CreditMemo     −line amounts                                    = −TotalAmt
 *   Payment        −TotalAmt; its lines only APPLY money to invoices/credits
 *   SalesReceipt   +line amounts and −TotalAmt receipt              = 0 (paid at sale)
 *   RefundReceipt  −line amounts and +TotalAmt refund paid out      = 0
 *   JournalEntry   Accounts Receivable lines with a Customer entity: debit +, credit −
 *
 * Anything that cannot be understood completely (tax, bundles, unknown
 * detail types, totals that do not reconcile) makes the whole revision
 * unsupported: callers must never mirror a partial document, because a
 * missing line would misstate what a tenant owes.
 */

export interface ReceivableNormalizationOptions {
  readonly currency?: QboCurrencyContext | null;
  /** Currency recorded on the bound legal entity; foreign documents are not summed into it. */
  readonly entityCurrency?: string | null;
  /** AccountType by Account Id, from the mirrored Account revisions. Needed for JournalEntry. */
  readonly accountTypes?: ReadonlyMap<string, string>;
}

export type ReceivableNormalizationResult =
  | { readonly status: "supported"; readonly document: QboReceivableDocument }
  /** Identity was readable; the revision is not mirrorable and must be reported. */
  | { readonly status: "unsupported"; readonly identity: ReceivableIdentity | null; readonly reasons: readonly string[] }
  /** Not customer receivable activity at all (e.g. a cash sale with no customer, a JournalEntry with no A/R line). */
  | { readonly status: "not_receivable"; readonly identity: ReceivableIdentity; readonly reason: string };

export interface ReceivableIdentity {
  readonly objectType: QboReceivableDocumentType;
  readonly objectId: string;
  readonly version: string;
  readonly providerUpdatedAt: string;
}

const ACCOUNTS_RECEIVABLE = "Accounts Receivable";
const SALES_DETAIL = "SalesItemLineDetail";
const DISCOUNT_DETAIL = "DiscountLineDetail";
const SUBTOTAL_DETAIL = "SubTotalLineDetail";
const DESCRIPTION_ONLY = "DescriptionOnly";
const JOURNAL_DETAIL = "JournalEntryLineDetail";

function reject(message: string): never {
  throw new QboNormalizationError(message);
}

function record(value: unknown): QuickBooksJsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as QuickBooksJsonObject : null;
}

function text(value: unknown, field: string, max = 255): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) reject(`QBO ${field} is invalid`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max = 255): string | null {
  return value === undefined || value === null || value === "" ? null : text(value, field, max);
}

function referenceId(value: unknown, field: string): string | null {
  const ref = record(value);
  return ref ? optionalText(ref.value, `${field}.value`, 200) : null;
}

function optionalDate(value: unknown, field: string): IsoDate | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = isoDateSchema.safeParse(text(value, field, 10));
  if (!parsed.success) reject(`QBO ${field} is not a calendar date`);
  return parsed.data;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") reject(`QBO ${field} is not a boolean`);
  return value;
}

function optionalAmount(value: unknown, field: string): MoneyCents | null {
  return value === undefined || value === null ? null : qboAmountToCents(value, field);
}

function negate(value: MoneyCents): MoneyCents {
  return centsFromBigInt(-BigInt(value));
}

function sum(values: readonly MoneyCents[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), BigInt(0));
}

function lines(body: QuickBooksJsonObject): readonly unknown[] {
  const value = body.Line;
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function identityOf(type: QboReceivableDocumentType, body: QuickBooksJsonObject): ReceivableIdentity {
  const metadata = record(body.MetaData);
  const updated = text(metadata?.LastUpdatedTime, `${type}.MetaData.LastUpdatedTime`, 100);
  const parsed = new Date(updated);
  if (!Number.isFinite(parsed.getTime())) reject(`QBO ${type}.MetaData.LastUpdatedTime is invalid`);
  return {
    objectType: type,
    objectId: text(body.Id, `${type}.Id`, 200),
    version: text(body.SyncToken, `${type}.SyncToken`, 120),
    providerUpdatedAt: isoTimestampSchema.parse(parsed.toISOString()),
  };
}

function emailStatus(value: unknown): QboReceivableDocument["emailStatus"] {
  if (value === undefined || value === null) return null;
  if (value === "NotSet" || value === "NeedToSend" || value === "EmailSent") return value;
  reject("QBO EmailStatus has an unrecognized value");
}

interface SalesLineContext {
  readonly type: QboReceivableDocumentType;
  readonly customerObjectId: string;
  readonly headerClass: string | null;
  readonly department: string | null;
  readonly txnDescription: string | null;
}

/**
 * Sales-form lines shared by Invoice, CreditMemo, SalesReceipt and
 * RefundReceipt. `sign` is +1 when the line increases what the customer owes.
 */
function salesLineEffects(body: QuickBooksJsonObject, context: SalesLineContext, sign: 1 | -1, chargeKind: QboReceivableEffectKind): QboReceivableEffect[] {
  const effects: QboReceivableEffect[] = [];
  lines(body).forEach((raw, index) => {
    const label = `${context.type} line ${index + 1}`;
    const line = record(raw);
    if (!line) reject(`QBO ${label} is not a JSON object`);
    const detailType = text(line.DetailType, `${label} DetailType`, 60);
    if (detailType === SUBTOTAL_DETAIL) return; // a subtotal restates other lines
    if (detailType === DESCRIPTION_ONLY) {
      const amount = optionalAmount(line.Amount, `${label} Amount`);
      if (amount !== null && BigInt(amount) !== BigInt(0)) reject(`QBO ${label} is a description line with an amount`);
      return;
    }
    const amount = qboAmountToCents(line.Amount, `${label} Amount`);
    const lineId = text(line.Id, `${label} Id`, 200);
    const description = optionalText(line.Description, `${label} Description`, 500) ?? context.txnDescription;
    if (detailType === SALES_DETAIL) {
      const detail = record(line.SalesItemLineDetail);
      if (!detail) reject(`QBO ${label} has no SalesItemLineDetail`);
      effects.push({
        effectId: lineId,
        lineNumber: index + 1,
        customerObjectId: context.customerObjectId,
        kind: chargeKind,
        amountCents: sign === 1 ? amount : negate(amount),
        accountObjectId: null,
        itemObjectId: referenceId(detail.ItemRef, `${label} ItemRef`),
        classObjectId: referenceId(detail.ClassRef, `${label} ClassRef`) ?? context.headerClass,
        departmentObjectId: context.department,
        serviceDate: optionalDate(detail.ServiceDate, `${label} ServiceDate`),
        description,
      });
      return;
    }
    if (detailType === DISCOUNT_DETAIL) {
      const detail = record(line.DiscountLineDetail);
      if (BigInt(amount) < BigInt(0)) reject(`QBO ${label} discount amount is negative`);
      // A discount reduces the document in the opposite direction of its charges.
      effects.push({
        effectId: lineId,
        lineNumber: index + 1,
        customerObjectId: context.customerObjectId,
        kind: "discount",
        amountCents: sign === 1 ? negate(amount) : amount,
        accountObjectId: referenceId(detail?.DiscountAccountRef, `${label} DiscountAccountRef`),
        itemObjectId: null,
        classObjectId: referenceId(detail?.ClassRef, `${label} ClassRef`) ?? context.headerClass,
        departmentObjectId: context.department,
        serviceDate: null,
        description,
      });
      return;
    }
    reject(`QBO ${label} has unsupported DetailType ${/^[A-Za-z]{1,60}$/.test(detailType) ? detailType : "(invalid)"}`);
  });
  return effects;
}

function assertNoTaxOrDeposit(type: QboReceivableDocumentType, body: QuickBooksJsonObject): void {
  const tax = optionalAmount(record(body.TxnTaxDetail)?.TotalTax, `${type}.TxnTaxDetail.TotalTax`);
  if (tax !== null && BigInt(tax) !== BigInt(0)) reject(`QBO ${type} carries sales tax, which the receivables mirror does not model`);
  const deposit = optionalAmount(body.Deposit, `${type}.Deposit`);
  if (deposit !== null && BigInt(deposit) !== BigInt(0)) reject(`QBO ${type} has a deposit applied on the form, which is not modeled`);
}

function reconcile(type: QboReceivableDocumentType, effects: readonly QboReceivableEffect[], expected: bigint, label: string): void {
  if (sum(effects.map(effect => effect.amountCents)) !== expected) reject(`QBO ${type} line amounts do not reconcile to ${label}`);
}

function looksVoided(body: QuickBooksJsonObject, total: MoneyCents): boolean {
  // QuickBooks usually zeroes a void and adds a note, but the explicit status
  // is authoritative when present. A nonzero void must never contribute to a
  // customer's balance merely because the provider retained its old amount.
  const status = body.TxnStatus ?? body.Status;
  return (typeof status === "string" && /^(?:void|voided)$/i.test(status.trim()))
    || (BigInt(total) === BigInt(0) && typeof body.PrivateNote === "string" && /^voided\b/i.test(body.PrivateNote.trim()));
}

function resolveReceivableCurrency(body: QuickBooksJsonObject, context: QboCurrencyContext | null | undefined, entityCurrency: string | null | undefined): CurrencyCode {
  const currency = resolveQboCurrency(body, context);
  if (!context) reject(`QBO receivable currency ${currency} cannot be checked without verified Preferences home currency`);
  if (currency !== context.homeCurrency.toUpperCase()) reject(`QBO receivable currency ${currency} differs from verified home currency ${context.homeCurrency.toUpperCase()}; foreign-currency receivables are excluded`);
  if (entityCurrency !== undefined) {
    if (entityCurrency === null) reject("QBO receivable currency cannot be checked because the bound legal entity currency is unavailable");
    if (currency !== entityCurrency.toUpperCase()) reject(`QBO receivable currency ${currency} differs from legal entity currency ${entityCurrency.toUpperCase()}; foreign-currency receivables are excluded`);
  }
  return currency;
}

function documentBase(type: QboReceivableDocumentType, body: QuickBooksJsonObject, identity: ReceivableIdentity, currency: CurrencyCode, total: MoneyCents) {
  return {
    ...identity,
    txnDate: (() => {
      const date = optionalDate(body.TxnDate, `${type}.TxnDate`);
      if (!date) reject(`QBO ${type}.TxnDate is missing`);
      return date;
    })(),
    docNumber: optionalText(body.DocNumber, `${type}.DocNumber`, 40),
    currency,
    totalCents: total,
    postingState: looksVoided(body, total) ? "voided" as const : "posted" as const,
    emailStatus: emailStatus(body.EmailStatus),
    allowOnlineCard: optionalBoolean(body.AllowOnlineCreditCardPayment, `${type}.AllowOnlineCreditCardPayment`),
    allowOnlineAch: optionalBoolean(body.AllowOnlineACHPayment, `${type}.AllowOnlineACHPayment`),
    allowIpn: optionalBoolean(body.AllowIPNPayment, `${type}.AllowIPNPayment`),
    billEmailPresent: typeof record(body.BillEmail)?.Address === "string" && String(record(body.BillEmail)!.Address).trim().length > 0,
  };
}

function salesContext(type: QboReceivableDocumentType, body: QuickBooksJsonObject, customerObjectId: string): SalesLineContext {
  return {
    type,
    customerObjectId,
    headerClass: referenceId(body.ClassRef, `${type}.ClassRef`),
    department: referenceId(body.DepartmentRef, `${type}.DepartmentRef`),
    txnDescription: null,
  };
}

function normalizeSalesForm(type: "Invoice" | "CreditMemo" | "SalesReceipt" | "RefundReceipt", body: QuickBooksJsonObject, identity: ReceivableIdentity, currency: CurrencyCode): QboReceivableDocument | { notReceivable: string } {
  const customer = referenceId(body.CustomerRef, `${type}.CustomerRef`);
  if (!customer) {
    if (type === "SalesReceipt" || type === "RefundReceipt") return { notReceivable: `QBO ${type} names no customer` };
    reject(`QBO ${type}.CustomerRef is missing`);
  }
  assertNoTaxOrDeposit(type, body);
  const total = qboAmountToCents(body.TotalAmt, `${type}.TotalAmt`);
  if (BigInt(total) < BigInt(0)) reject(`QBO ${type}.TotalAmt is negative`);
  const context = salesContext(type, body, customer);
  const base = documentBase(type, body, identity, currency, total);
  if (type === "Invoice") {
    const effects = salesLineEffects(body, context, 1, "charge");
    reconcile(type, effects, BigInt(total), "TotalAmt");
    const balance = optionalAmount(body.Balance, "Invoice.Balance");
    if (balance === null) reject("QBO Invoice.Balance is missing");
    if (BigInt(balance) < BigInt(0) || BigInt(balance) > BigInt(total)) reject("QBO Invoice.Balance is outside 0..TotalAmt");
    return { ...base, customerObjectId: customer, dueDate: optionalDate(body.DueDate, "Invoice.DueDate"), openBalanceCents: balance, effects, applications: [] };
  }
  if (type === "CreditMemo") {
    const effects = salesLineEffects(body, context, -1, "credit");
    reconcile(type, effects, -BigInt(total), "−TotalAmt");
    const remaining = optionalAmount(body.Balance ?? body.RemainingCredit, "CreditMemo remaining credit");
    if (remaining !== null && (BigInt(remaining) < BigInt(0) || BigInt(remaining) > BigInt(total))) reject("QBO CreditMemo remaining credit is outside 0..TotalAmt");
    return { ...base, customerObjectId: customer, dueDate: null, openBalanceCents: remaining, effects, applications: [] };
  }
  const chargeSign: 1 | -1 = type === "SalesReceipt" ? 1 : -1;
  const effects = salesLineEffects(body, context, chargeSign, type === "SalesReceipt" ? "charge" : "credit");
  reconcile(type, effects, chargeSign === 1 ? BigInt(total) : -BigInt(total), chargeSign === 1 ? "TotalAmt" : "−TotalAmt");
  // The cash side settles the same document: a receipt at sale, or money paid back out.
  effects.push({
    effectId: type === "SalesReceipt" ? "receipt" : "refund",
    lineNumber: effects.length + 1,
    customerObjectId: customer,
    kind: type === "SalesReceipt" ? "receipt" : "refund",
    amountCents: type === "SalesReceipt" ? negate(total) : total,
    accountObjectId: referenceId(body.DepositToAccountRef, `${type}.DepositToAccountRef`),
    itemObjectId: null,
    classObjectId: context.headerClass,
    departmentObjectId: context.department,
    serviceDate: null,
    description: null,
  });
  return { ...base, customerObjectId: customer, dueDate: null, openBalanceCents: null, effects, applications: [] };
}

function linkedTarget(line: QuickBooksJsonObject, label: string): { targetType: QboReceivableApplicationTarget; targetId: string } {
  const raw = line.LinkedTxn;
  const links = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  if (links.length !== 1) reject(`QBO ${label} applies ${links.length === 0 ? "no" : "more than one"} linked transaction`);
  const linked = record(links[0]);
  if (!linked) reject(`QBO ${label} LinkedTxn is not a JSON object`);
  const targetType = text(linked.TxnType, `${label} LinkedTxn.TxnType`, 60);
  if (!(QBO_RECEIVABLE_APPLICATION_TARGETS as readonly string[]).includes(targetType)) reject(`QBO ${label} applies a ${/^[A-Za-z]{1,60}$/.test(targetType) ? targetType : "transaction"}, which is not a supported receivable target`);
  return { targetType: targetType as QboReceivableApplicationTarget, targetId: text(linked.TxnId, `${label} LinkedTxn.TxnId`, 200) };
}

function normalizePayment(body: QuickBooksJsonObject, identity: ReceivableIdentity, currency: CurrencyCode): QboReceivableDocument {
  const customer = referenceId(body.CustomerRef, "Payment.CustomerRef");
  if (!customer) reject("QBO Payment.CustomerRef is missing");
  const total = qboAmountToCents(body.TotalAmt, "Payment.TotalAmt");
  if (BigInt(total) < BigInt(0)) reject("QBO Payment.TotalAmt is negative");
  const unapplied = optionalAmount(body.UnappliedAmt, "Payment.UnappliedAmt");
  if (unapplied !== null && (BigInt(unapplied) < BigInt(0) || BigInt(unapplied) > BigInt(total))) reject("QBO Payment.UnappliedAmt is outside 0..TotalAmt");
  const applications: QboReceivableApplication[] = [];
  lines(body).forEach((raw, index) => {
    const label = `Payment line ${index + 1}`;
    const line = record(raw);
    if (!line) reject(`QBO ${label} is not a JSON object`);
    const amount = qboAmountToCents(line.Amount, `${label} Amount`);
    if (BigInt(amount) < BigInt(0)) reject(`QBO ${label} amount is negative`);
    const target = linkedTarget(line, label);
    // Payment lines usually have no Line.Id; the single linked transaction is their stable identity.
    const applicationId = line.Id === undefined || line.Id === null ? `linked:${target.targetType}:${target.targetId}` : text(line.Id, `${label} Id`, 200);
    applications.push({ applicationId, ...target, amountCents: amount });
  });
  const ids = applications.map(application => `${application.applicationId}\u0000${application.targetType}\u0000${application.targetId}`);
  if (new Set(ids).size !== ids.length) reject("QBO Payment has duplicate applications");
  // Money applied to invoices/journals, less credit memos consumed, plus the unapplied remainder, is the cash received.
  const applied = applications.reduce((total, application) => total + (application.targetType === "CreditMemo" ? -BigInt(application.amountCents) : BigInt(application.amountCents)), BigInt(0));
  if (applied + BigInt(unapplied ?? "0") !== BigInt(total)) reject("QBO Payment applications and UnappliedAmt do not reconcile to TotalAmt");
  const base = documentBase("Payment", body, identity, currency, total);
  const reference = optionalText(body.PaymentRefNum, "Payment.PaymentRefNum", 100);
  const effects: QboReceivableEffect[] = BigInt(total) === BigInt(0) ? [] : [{
    effectId: "payment",
    lineNumber: 1,
    customerObjectId: customer,
    kind: "payment",
    amountCents: negate(total),
    accountObjectId: referenceId(body.DepositToAccountRef, "Payment.DepositToAccountRef"),
    itemObjectId: null,
    classObjectId: null,
    departmentObjectId: referenceId(body.DepartmentRef, "Payment.DepartmentRef"),
    serviceDate: null,
    description: reference === null ? null : `Ref ${reference}`,
  }];
  return { ...base, customerObjectId: customer, dueDate: null, openBalanceCents: unapplied, effects, applications };
}

function normalizeJournalEntry(body: QuickBooksJsonObject, identity: ReceivableIdentity, currency: CurrencyCode, accountTypes: ReadonlyMap<string, string> | undefined): QboReceivableDocument | { notReceivable: string } {
  const effects: QboReceivableEffect[] = [];
  let debits = BigInt(0);
  let credits = BigInt(0);
  lines(body).forEach((raw, index) => {
    const label = `JournalEntry line ${index + 1}`;
    const line = record(raw);
    if (!line) reject(`QBO ${label} is not a JSON object`);
    const detailType = text(line.DetailType, `${label} DetailType`, 60);
    if (detailType === DESCRIPTION_ONLY) return;
    if (detailType !== JOURNAL_DETAIL) reject(`QBO ${label} has unsupported DetailType`);
    const detail = record(line.JournalEntryLineDetail);
    if (!detail) reject(`QBO ${label} has no JournalEntryLineDetail`);
    const posting = detail.PostingType;
    if (posting !== "Debit" && posting !== "Credit") reject(`QBO ${label} PostingType is invalid`);
    const amount = qboAmountToCents(line.Amount, `${label} Amount`);
    if (BigInt(amount) < BigInt(0)) reject(`QBO ${label} amount is negative`);
    if (posting === "Debit") debits += BigInt(amount); else credits += BigInt(amount);
    const account = referenceId(detail.AccountRef, `${label} AccountRef`);
    if (!account) reject(`QBO ${label} has no AccountRef`);
    const entity = record(detail.Entity);
    const entityType = entity ? optionalText(entity.Type, `${label} Entity.Type`, 40) : null;
    const accountType = accountTypes?.get(account);
    const customer = entityType === "Customer" ? referenceId(entity!.EntityRef, `${label} Entity.EntityRef`) : null;
    if (accountType === undefined) {
      // Only a customer-tagged line could be receivable; without its account type it cannot be classified.
      if (customer) reject(`QBO ${label} names a customer on account ${account}, whose type is not mirrored yet`);
      return;
    }
    if (accountType !== ACCOUNTS_RECEIVABLE) return;
    if (!customer) reject(`QBO ${label} posts to Accounts Receivable without a customer`);
    effects.push({
      effectId: text(line.Id, `${label} Id`, 200),
      lineNumber: index + 1,
      customerObjectId: customer,
      kind: "adjustment",
      amountCents: posting === "Debit" ? amount : negate(amount),
      accountObjectId: account,
      itemObjectId: null,
      classObjectId: referenceId(detail.ClassRef, `${label} ClassRef`),
      departmentObjectId: referenceId(detail.DepartmentRef, `${label} DepartmentRef`),
      serviceDate: null,
      description: optionalText(line.Description, `${label} Description`, 500),
    });
  });
  if (debits !== credits) reject("QBO JournalEntry debits and credits do not balance");
  if (effects.length === 0) return { notReceivable: "QBO JournalEntry has no Accounts Receivable line" };
  const total = centsFromBigInt(sum(effects.map(effect => effect.amountCents)));
  const base = documentBase("JournalEntry", body, identity, currency, total);
  return { ...base, customerObjectId: null, dueDate: null, openBalanceCents: null, effects, applications: [] };
}

export function isQboReceivableType(type: string): type is QboReceivableDocumentType {
  return (QBO_RECEIVABLE_DOCUMENT_TYPES as readonly string[]).includes(type);
}

/** Account Ids referenced by a JournalEntry body, for the caller's AccountType lookup. */
export function journalEntryAccountIds(input: unknown): readonly string[] {
  const body = record(input);
  if (!body) return [];
  const ids = new Set<string>();
  for (const raw of lines(body)) {
    const value = record(record(record(raw)?.JournalEntryLineDetail)?.AccountRef)?.value;
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value)) ids.add(value);
  }
  return Array.from(ids);
}

export function normalizeQboReceivable(type: string, input: unknown, options: ReceivableNormalizationOptions = {}): ReceivableNormalizationResult {
  if (!isQboReceivableType(type)) return { status: "unsupported", identity: null, reasons: [`Unsupported QBO receivable type ${/^[A-Za-z]{1,60}$/.test(type) ? type : "(invalid)"}`] };
  const body = record(input);
  if (!body) return { status: "unsupported", identity: null, reasons: ["QBO provider object is not a JSON object"] };
  let identity: ReceivableIdentity;
  try {
    identity = identityOf(type, body);
  } catch (error) {
    return { status: "unsupported", identity: null, reasons: [error instanceof QboNormalizationError ? error.message : "QBO object identity is invalid"] };
  }
  try {
    const currency = resolveReceivableCurrency(body, options.currency, options.entityCurrency);
    const result = type === "Payment"
      ? normalizePayment(body, identity, currency)
      : type === "JournalEntry"
        ? normalizeJournalEntry(body, identity, currency, options.accountTypes)
        : normalizeSalesForm(type, body, identity, currency);
    if ("notReceivable" in result) return { status: "not_receivable", identity, reason: result.notReceivable };
    const effectIds = result.effects.map(effect => effect.effectId);
    if (new Set(effectIds).size !== effectIds.length) reject(`QBO ${type} has duplicate line identities`);
    return { status: "supported", document: result };
  } catch (error) {
    return { status: "unsupported", identity, reasons: [error instanceof QboNormalizationError ? error.message : `QBO ${type} could not be normalized`] };
  }
}
