import {
  centsFromBigInt,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  legacyNumberToDecimal,
  parseDecimalParts,
  type CurrencyCode,
  type MoneyCents,
} from "../../../shared/company";
import type { QuickBooksJsonObject } from "../../../shared/accounting/quickbooks";
import type { FinancialProviderPaymentSubtype, FinancialSourceFlow, FinancialSourceLineRole } from "../../../shared/accounting/source";

const SUPPORTED_TRANSACTION_TYPES = ["Purchase", "Bill", "BillPayment", "Deposit", "JournalEntry"] as const;
export type SupportedQboTransactionType = (typeof SUPPORTED_TRANSACTION_TYPES)[number];

export interface NormalizedQboLine {
  readonly lineId: string;
  readonly lineNumber: number;
  readonly transactionType: SupportedQboTransactionType;
  readonly direction: "debit" | "credit";
  readonly flow: FinancialSourceFlow;
  readonly lineRole: FinancialSourceLineRole;
  readonly amountCents: MoneyCents;
  readonly currency: CurrencyCode;
  readonly postingState: "posted" | "voided" | "unknown";
  readonly postedOn: string;
  readonly settlementState: "unknown" | "unsettled" | "settled" | "voided";
  readonly settledOn: string | null;
  readonly settledAmountCents: MoneyCents | null;
  readonly accountObjectId: string | null;
  readonly counterpartyObjectId: string | null;
  readonly cashAccountObjectId: string | null;
  readonly paymentSubtype: FinancialProviderPaymentSubtype | null;
  readonly description: string | null;
}

export interface NormalizedQboObject {
  readonly objectType: SupportedQboTransactionType;
  readonly objectId: string;
  readonly version: string;
  readonly providerUpdatedAt: string;
  readonly transactionDate: string;
  readonly postingState: "posted" | "voided" | "unknown";
  readonly currency: CurrencyCode;
  readonly providerBody: QuickBooksJsonObject;
  readonly lines: readonly NormalizedQboLine[];
  readonly unsupportedReasons: readonly string[];
}

/** Home currency evidence read from the realm's Preferences.CurrencyPrefs. */
export interface QboCurrencyContext {
  readonly homeCurrency: string;
  readonly multiCurrencyEnabled: boolean | null;
}

export interface QboNormalizationResult {
  readonly value: NormalizedQboObject | null;
  readonly unsupportedReasons: readonly string[];
}

/**
 * Rejection reasons are persisted and shown to operators. They are built only
 * from normalizer-authored text plus provider identifiers, never from raw
 * provider values or third-party library messages.
 */
export class QboNormalizationError extends Error {}

function reject(message: string): never {
  throw new QboNormalizationError(message);
}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof QboNormalizationError ? error.message : fallback;
}

function record(value: unknown): QuickBooksJsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as QuickBooksJsonObject : null;
}

function text(value: unknown, field: string, max = 255): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    reject(`QBO ${field} is invalid`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, max = 255): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, max);
}

function providerTimestamp(value: unknown): string {
  const raw = text(value, "provider update timestamp", 100);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) reject("QBO provider update timestamp is invalid");
  return isoTimestampSchema.parse(parsed.toISOString());
}

/**
 * QBO amounts cross a strict decimal boundary. JSON numbers are admitted only
 * when they remain finite and within the safe integer envelope; all later
 * arithmetic uses decimal text and bigint cents.
 */
export function qboAmountToCents(value: unknown, field: string): MoneyCents {
  let decimal: string;
  if (typeof value === "string") decimal = value;
  else if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) reject(`QBO ${field} exceeds the safe numeric boundary`);
    decimal = legacyNumberToDecimal(value);
  } else reject(`QBO ${field} is missing or not a decimal`);
  let parts: ReturnType<typeof parseDecimalParts>;
  try {
    parts = parseDecimalParts(decimal);
  } catch {
    reject(`QBO ${field} is not a plain decimal`);
  }
  // QBO accounting amounts are represented at cent precision for this mirror.
  // Refuse hidden rounding instead of silently changing a provider amount.
  if (parts.scale > 2) reject(`QBO ${field} has unsupported sub-cent precision`);
  const cents = parts.coefficient * BigInt(100) / BigInt(10 ** parts.scale);
  return centsFromBigInt(parts.sign < 0 ? -cents : cents);
}

function referenceId(value: unknown): string | null {
  const ref = record(value);
  if (!ref) return null;
  const direct = optionalText(ref.value ?? ref.Id, "provider reference", 200);
  if (direct) return direct;
  // JournalEntryLineDetail.Entity is commonly shaped as
  // { Type, EntityRef: { value, name } } rather than a direct reference.
  return referenceId(ref.EntityRef ?? ref.Ref);
}

function currencyCode(value: unknown, field: string): CurrencyCode {
  const parsed = currencyCodeSchema.safeParse(text(value, field, 3).toUpperCase());
  if (!parsed.success) reject(`QBO ${field} is not an ISO currency code`);
  return parsed.data;
}

/**
 * CurrencyRef is authoritative when present. When it is absent, only a home
 * currency read from the realm's Preferences with multicurrency confirmed off
 * may be applied; a missing currency is never assumed to be USD.
 */
export function resolveQboCurrency(value: QuickBooksJsonObject, context: QboCurrencyContext | null | undefined): CurrencyCode {
  const supplied = record(value.CurrencyRef)?.value;
  if (supplied !== undefined && supplied !== null) return currencyCode(supplied, "CurrencyRef.value");
  if (!context) reject("QBO CurrencyRef is absent and no verified home currency is available");
  if (context.multiCurrencyEnabled !== false) reject("QBO CurrencyRef is absent in a realm where multicurrency is not verified off");
  return currencyCode(context.homeCurrency, "verified home currency");
}

function rawLineItems(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values;
}

function postingState(body: QuickBooksJsonObject): "posted" | "voided" | "unknown" {
  const status = body.TxnStatus ?? body.Status;
  if (typeof status === "string" && /void/i.test(status)) return "voided";
  if (typeof status === "string" && /post|paid|open|closed|bill/i.test(status)) return "posted";
  return "posted";
}

function transactionCounterparty(type: SupportedQboTransactionType, body: QuickBooksJsonObject): string | null {
  if (type === "Bill" || type === "BillPayment") return referenceId(body.VendorRef) ?? referenceId(body.EntityRef);
  // Purchase.EntityRef is the provider payee. CustomerRef belongs to a
  // reporting dimension and is intentionally not used as a payee identity.
  return referenceId(body.EntityRef) ?? referenceId(body.VendorRef);
}

function lineDescription(body: QuickBooksJsonObject, line: QuickBooksJsonObject): string | null {
  return optionalText(line.Description ?? line.Memo ?? body.PrivateNote ?? body.Memo, "line description", 500);
}

function paymentCashAccount(type: SupportedQboTransactionType, body: QuickBooksJsonObject): string | null {
  if (type === "BillPayment") {
    const checkPayment = record(body.CheckPayment);
    const creditCardPayment = record(body.CreditCardPayment);
    return referenceId(checkPayment?.BankAccountRef)
      ?? referenceId(creditCardPayment?.CCAccountRef)
      ?? referenceId(body.BankAccountRef)
      ?? referenceId(body.CCAccountRef);
  }
  if (type === "Deposit") return referenceId(body.DepositToAccountRef);
  if (type === "JournalEntry") return null;
  return referenceId(body.AccountRef);
}

function paymentSubtype(type: SupportedQboTransactionType, body: QuickBooksJsonObject): FinancialProviderPaymentSubtype | null {
  if (type === "BillPayment") return "BillPayment";
  if (type === "Deposit") return "Deposit";
  const value = body.PaymentType;
  return value === "Cash" || value === "Check" || value === "CreditCard" ? value : null;
}

function lineRole(type: SupportedQboTransactionType): FinancialSourceLineRole {
  if (type === "Deposit") return "receipt";
  if (type === "Bill") return "payable";
  if (type === "BillPayment") return "payment_source";
  return "expense";
}

function lineFlow(type: SupportedQboTransactionType, body: QuickBooksJsonObject): FinancialSourceFlow {
  // QBO marks a credit-card Purchase refund with Credit=true. The provider
  // line still points at the expense account, but its economic flow reverses
  // the original outgoing charge.
  if (type === "Purchase" && body.Credit === true) return "incoming";
  return type === "Deposit" ? "incoming" : "outgoing";
}

function lineDirection(type: SupportedQboTransactionType, body: QuickBooksJsonObject): "debit" | "credit" {
  // The line role carries the economic flow. A BillPayment line is a cash
  // credit only when its actual payment account is present; its generic Line
  // amount must never be treated as an AP debit by inference.
  if (type === "Purchase" && body.Credit === true) return "credit";
  return type === "BillPayment" ? "credit" : "debit";
}

function journalPostingType(line: QuickBooksJsonObject, detail: QuickBooksJsonObject): "debit" | "credit" {
  const postingType = line.PostingType ?? detail.PostingType;
  if (postingType === "Debit") return "debit";
  if (postingType === "Credit") return "credit";
  reject("QBO JournalEntry line has an unsupported PostingType");
}

interface LinkedTransaction {
  readonly txnId: string;
  readonly txnType: string;
}

function linkedTransactions(line: QuickBooksJsonObject, lineLabel: string): readonly LinkedTransaction[] {
  return rawLineItems(line.LinkedTxn).map((raw, index) => {
    const linked = record(raw);
    if (!linked) reject(`QBO ${lineLabel} LinkedTxn ${index + 1} is not a JSON object`);
    const txnId = text(linked.TxnId, `${lineLabel} LinkedTxn.TxnId`, 100);
    const txnType = text(linked.TxnType, `${lineLabel} LinkedTxn.TxnType`, 60);
    if (!/^[A-Za-z]{1,60}$/.test(txnType)) reject(`QBO ${lineLabel} LinkedTxn.TxnType is invalid`);
    return { txnId, txnType };
  });
}

/**
 * QBO omits Line.Id on BillPayment lines and on Deposit lines that move an
 * existing Payment/SalesReceipt out of Undeposited Funds. Those lines are
 * identified by their single linked transaction, which is stable across
 * provider revisions. A line with neither an Id nor exactly one link is
 * rejected rather than given a positional identity that could drift.
 */
function lineIdentity(type: SupportedQboTransactionType, line: QuickBooksJsonObject, index: number, links: readonly LinkedTransaction[]): string {
  if (line.Id !== undefined && line.Id !== null) return text(line.Id, `${type} line ${index + 1} Id`, 200);
  if (type !== "BillPayment" && type !== "Deposit") reject(`QBO ${type} line ${index + 1} has no Line.Id`);
  if (links.length !== 1) reject(`QBO ${type} line ${index + 1} has no Line.Id and ${links.length === 0 ? "no" : "more than one"} linked transaction`);
  return `linked:${links[0].txnType}:${links[0].txnId}`;
}

const DEPOSIT_LINKED_TYPES = new Set(["Payment", "SalesReceipt"]);
const CASH_BACK_LINE_ID = "synthetic:cashback";

function sumCents(values: readonly MoneyCents[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), BigInt(0));
}

function optionalAmount(value: unknown, field: string): MoneyCents | null {
  return value === undefined || value === null ? null : qboAmountToCents(value, field);
}

/**
 * Object-level checks that make a partially understood transaction
 * unsupported as a whole. Mirroring a subset of lines, or lines whose total
 * cannot be reconciled to the provider TotalAmt, would misstate cash.
 */
function objectLevelReasons(type: SupportedQboTransactionType, body: QuickBooksJsonObject, lines: readonly NormalizedQboLine[], rawLineCount: number): string[] {
  const reasons: string[] = [];
  const label = `QBO ${type}`;
  if (type === "Purchase" && body.Credit === true && body.PaymentType !== "CreditCard") reasons.push(`${label} credit/refund requires CreditCard PaymentType`);
  if (type === "Purchase" && body.PaymentType !== undefined && paymentSubtype(type, body) === null) reasons.push(`${label} has unsupported PaymentType`);
  if ((type === "BillPayment" || type === "Deposit") && paymentCashAccount(type, body) === null) reasons.push(`${label} has no actual cash account reference`);
  if (type === "BillPayment" && body.PayType !== undefined && body.PayType !== "Check" && body.PayType !== "CreditCard") reasons.push(`${label} has unsupported PayType`);
  let cashBack: MoneyCents | null = null;
  let totalTax: MoneyCents | null = null;
  let total: MoneyCents | null = null;
  try {
    total = optionalAmount(body.TotalAmt, `${type}.TotalAmt`);
    totalTax = optionalAmount(record(body.TxnTaxDetail)?.TotalTax, `${type}.TxnTaxDetail.TotalTax`);
    cashBack = type === "Deposit" ? optionalAmount(record(body.CashBack)?.Amount, "Deposit.CashBack.Amount") : null;
  } catch (error) {
    reasons.push(reasonOf(error, `${label} totals are invalid`));
  }
  if (totalTax !== null && BigInt(totalTax) !== BigInt(0)) reasons.push(`${label} carries transaction tax, which is not mirrored as a source line`);
  if (type === "Deposit" && body.CashBack !== undefined && body.CashBack !== null && !record(body.CashBack)) reasons.push(`${label} CashBack is not a JSON object`);
  if (type === "Deposit" && record(body.CashBack) && cashBack === null) reasons.push(`${label} CashBack.Amount is missing or invalid`);
  if (rawLineCount === 0) reasons.push(`${label} has no transaction lines`);
  const ids = lines.map(line => line.lineId);
  if (new Set(ids).size !== ids.length) reasons.push(`${label} has duplicate line identities`);
  // Reconcile only when every line was understood; otherwise the line-level
  // reasons already explain the gap.
  const expectedLineCount = rawLineCount + (type === "Deposit" && cashBack !== null && BigInt(cashBack) > BigInt(0) ? 1 : 0);
  if (total !== null && lines.length === expectedLineCount && rawLineCount > 0 && reasons.length === 0) {
    // Deposit.TotalAmt is net of CashBack. Keep every source line and
    // reconcile the signed cash flow instead of netting away the receipt or
    // inventing a negative source amount.
    const lineTotal = type === "Deposit"
      ? lines.reduce((sum, line) => sum + (line.flow === "outgoing" ? -BigInt(line.amountCents) : BigInt(line.amountCents)), BigInt(0))
      : sumCents(lines.map(line => line.amountCents));
    if (lineTotal !== BigInt(total)) reasons.push(`${label} line amounts do not reconcile to TotalAmt`);
  }
  if (type === "JournalEntry" && lines.length === rawLineCount && rawLineCount > 0 && reasons.length === 0) {
    const debitTotal = sumCents(lines.filter(line => line.direction === "debit").map(line => line.amountCents));
    const creditTotal = sumCents(lines.filter(line => line.direction === "credit").map(line => line.amountCents));
    if (debitTotal !== creditTotal) reasons.push(`${label} debit and credit lines do not balance`);
  }
  return reasons;
}

function normalizeCashBackLine(body: QuickBooksJsonObject, rawLineCount: number, date: string, currencyCode: CurrencyCode, state: "posted" | "voided" | "unknown"): NormalizedQboLine | null {
  const cashBack = record(body.CashBack);
  if (!cashBack) return null;
  const amount = optionalAmount(cashBack.Amount, "Deposit.CashBack.Amount");
  if (amount === null || BigInt(amount) === BigInt(0)) return null;
  if (BigInt(amount) < BigInt(0)) reject("QBO Deposit.CashBack.Amount is negative");
  const accountObjectId = referenceId(cashBack.AccountRef);
  if (accountObjectId === null) reject("QBO Deposit.CashBack has no AccountRef");
  const cashAccountObjectId = paymentCashAccount("Deposit", body);
  if (cashAccountObjectId === null) reject("QBO Deposit has no actual cash account reference");
  return {
    lineId: CASH_BACK_LINE_ID,
    lineNumber: rawLineCount + 1,
    transactionType: "Deposit",
    // CashBack.AccountRef is the account debited by the cash withdrawal. Its
    // account type is resolved later from the mirrored Account object; the
    // normalizer therefore keeps the role unknown rather than assuming this
    // is an expense or owner draw.
    direction: "debit",
    flow: "outgoing",
    lineRole: "unknown",
    amountCents: amount,
    currency: currencyCode,
    postingState: state,
    postedOn: date,
    ...(state === "voided"
      ? { settlementState: "voided" as const, settledOn: null, settledAmountCents: null }
      : { settlementState: "unknown" as const, settledOn: null, settledAmountCents: null }),
    accountObjectId,
    counterpartyObjectId: null,
    cashAccountObjectId,
    paymentSubtype: null,
    description: optionalText(cashBack.Memo ?? body.PrivateNote ?? body.Memo, "cashback description", 500),
  };
}

function normalizeLine(type: SupportedQboTransactionType, body: QuickBooksJsonObject, line: QuickBooksJsonObject, index: number, date: string, currencyCode: CurrencyCode, state: "posted" | "voided" | "unknown"): NormalizedQboLine {
  const lineLabel = `${type} line ${index + 1}`;
  const links = linkedTransactions(line, lineLabel);
  const lineId = lineIdentity(type, line, index, links);
  const amount = qboAmountToCents(line.Amount, `${lineLabel} Amount`);
  if (BigInt(amount) < BigInt(0)) reject(`QBO ${lineLabel} amount is negative`);
  if (type === "JournalEntry") {
    const detail = record(line.JournalEntryLineDetail);
    if (!detail) reject(`QBO ${lineLabel} has unsupported DetailType`);
    const direction = journalPostingType(line, detail);
    const accountObjectId = referenceId(detail.AccountRef);
    if (accountObjectId === null) reject(`QBO ${lineLabel} has no AccountRef`);
    const counterpartyObjectId = referenceId(detail.Entity) ?? referenceId(detail.EntityRef) ?? referenceId(line.Entity) ?? referenceId(line.EntityRef);
    return {
      lineId,
      lineNumber: index + 1,
      transactionType: type,
      direction,
      // Journal lines do not prove cash movement. Keep both sides in the
      // cost role so a verified Expense/COGS/Fixed Asset Account can classify
      // either a debit cost or a credit refund; consumers use direction for
      // the signed amount and must apply their own incoming-credit policy.
      flow: direction === "debit" ? "outgoing" : "incoming",
      lineRole: "expense",
      amountCents: amount,
      currency: currencyCode,
      postingState: state,
      postedOn: date,
      ...(state === "voided"
        ? { settlementState: "voided" as const, settledOn: null, settledAmountCents: null }
        : { settlementState: "unknown" as const, settledOn: null, settledAmountCents: null }),
      accountObjectId,
      counterpartyObjectId,
      cashAccountObjectId: null,
      paymentSubtype: null,
      description: lineDescription(body, line),
    };
  }
  const cashAccount = paymentCashAccount(type, body);
  let accountObjectId: string | null;
  let counterpartyObjectId: string | null;
  if (type === "BillPayment") {
    // Only Bill applications move cash. Vendor credits or journal entries
    // applied inside a payment reduce its cash total and are not supported.
    if (links.length !== 1 || links[0].txnType !== "Bill") reject(`QBO ${lineLabel} applies a linked ${links.length === 1 ? links[0].txnType : "transaction set"}; only Bill applications are mirrored`);
    accountObjectId = cashAccount;
    counterpartyObjectId = transactionCounterparty(type, body);
  } else if (type === "Deposit") {
    const detail = record(line.DepositLineDetail);
    // Intuit returns linked Undeposited Funds lines with a DepositLineDetail
    // that carries only payment metadata (PaymentMethodRef, CheckNum). Only a
    // detail that names its own offset account or payer is a detail line.
    const detailHasPosting = detail !== null && (detail.AccountRef !== undefined || detail.Entity !== undefined || detail.EntityRef !== undefined);
    if (detail && detailHasPosting) {
      if (links.length > 0) reject(`QBO ${lineLabel} has both a posting DepositLineDetail and LinkedTxn`);
      // The deposit line's own AccountRef is the offset (income, equity,
      // liability...). The bank account is the separate cash account.
      accountObjectId = referenceId(detail.AccountRef);
      if (accountObjectId === null) reject(`QBO ${lineLabel} DepositLineDetail has no AccountRef`);
      counterpartyObjectId = referenceId(record(detail.Entity) ?? record(detail.EntityRef));
    } else {
      // A linked line moves an existing customer Payment or SalesReceipt out
      // of Undeposited Funds. Its income or receivable was recognized by that
      // linked transaction, so no offset account is inferred here.
      if (links.length !== 1 || !DEPOSIT_LINKED_TYPES.has(links[0].txnType)) reject(`QBO ${lineLabel} links ${links.length === 1 ? links[0].txnType : "an unsupported transaction set"}; only a single Payment or SalesReceipt link is mirrored`);
      accountObjectId = null;
      counterpartyObjectId = null;
    }
  } else {
    const accountDetail = record(line.AccountBasedExpenseLineDetail);
    const itemDetail = record(line.ItemBasedExpenseLineDetail);
    if (!accountDetail) {
      // ItemBasedExpenseLineDetail.ItemRef identifies a product or service,
      // not the expense account that receives the posting. Without the
      // provider's mirrored expense account, retaining the line would make a
      // complete transaction look classified while cost reads silently omit
      // it. An explicit ItemAccountRef is a line-level account override in
      // the provider response and is safe to carry by ID; ItemRef alone is
      // not. The common ItemRef-only shape remains unsupported until the
      // provider Item is fetched, its type-specific posting account is
      // resolved (for example ExpenseAccountRef for service items or the
      // inventory/COGS path for inventory), and the referenced Account
      // revision is mirrored.
      if (itemDetail) {
        if (referenceId(itemDetail.ItemRef) === null) reject(`QBO ${lineLabel} ItemBasedExpenseLineDetail has no ItemRef`);
        accountObjectId = referenceId(itemDetail.ItemAccountRef);
        if (accountObjectId === null) reject(`QBO ${lineLabel} uses ItemBasedExpenseLineDetail without a mirrored expense account`);
      } else reject(`QBO ${lineLabel} has unsupported DetailType`);
    } else {
      accountObjectId = referenceId(accountDetail.AccountRef);
    }
    counterpartyObjectId = transactionCounterparty(type, body);
  }
  return {
    lineId,
    lineNumber: index + 1,
    transactionType: type,
    direction: lineDirection(type, body),
    flow: lineFlow(type, body),
    lineRole: lineRole(type),
    amountCents: amount,
    currency: currencyCode,
    postingState: state,
    postedOn: date,
    // QBO posting and a payment method do not prove bank clearing. Settlement
    // is filled only by a separate bank/reconciliation evidence pipeline.
    ...(state === "voided"
      ? { settlementState: "voided" as const, settledOn: null, settledAmountCents: null }
      : { settlementState: "unknown" as const, settledOn: null, settledAmountCents: null }),
    accountObjectId,
    counterpartyObjectId,
    cashAccountObjectId: cashAccount,
    paymentSubtype: paymentSubtype(type, body),
    description: lineDescription(body, line),
  };
}

/**
 * Normalize provider-shaped QBO Purchase, Bill, BillPayment and Deposit
 * bodies. A result with any unsupported reason must be treated as unsupported
 * as a whole: callers must not mirror its partial line list.
 */
export function normalizeQboTransaction(type: string, input: unknown, options: { readonly currency?: QboCurrencyContext | null } = {}): QboNormalizationResult {
  const unsupported: string[] = [];
  if (!(SUPPORTED_TRANSACTION_TYPES as readonly string[]).includes(type)) return { value: null, unsupportedReasons: [`Unsupported QBO object type ${type}`] };
  const objectType = type as SupportedQboTransactionType;
  const body = record(input);
  if (!body) return { value: null, unsupportedReasons: ["QBO provider object is not a JSON object"] };
  let objectId: string;
  let version: string;
  let updatedAt: string;
  let transactionDate: string;
  let currencyCodeValue: CurrencyCode;
  try {
    objectId = text(body.Id, `${objectType}.Id`, 200);
    version = text(body.SyncToken, `${objectType}.SyncToken`, 120);
    updatedAt = providerTimestamp(record(body.MetaData)?.LastUpdatedTime);
    const date = isoDateSchema.safeParse(text(body.TxnDate, `${objectType}.TxnDate`));
    if (!date.success) reject(`QBO ${objectType}.TxnDate is not a calendar date`);
    transactionDate = date.data;
    currencyCodeValue = resolveQboCurrency(body, options.currency);
  } catch (error) {
    return { value: null, unsupportedReasons: [reasonOf(error, "QBO object identity is invalid")] };
  }
  const state = postingState(body);
  const lines: NormalizedQboLine[] = [];
  const rawLines = rawLineItems(body.Line);
  rawLines.forEach((rawLine, index) => {
    const line = record(rawLine);
    if (!line) {
      unsupported.push(`QBO ${objectType} line ${index + 1} is not a JSON object`);
      return;
    }
    try {
      lines.push(normalizeLine(objectType, body, line, index, transactionDate, currencyCodeValue, state));
    } catch (error) {
      unsupported.push(reasonOf(error, `QBO ${objectType} line ${index + 1} is unsupported`));
    }
  });
  if (objectType === "Deposit") {
    try {
      const cashBackLine = normalizeCashBackLine(body, rawLines.length, transactionDate, currencyCodeValue, state);
      if (cashBackLine) lines.push(cashBackLine);
    } catch (error) {
      unsupported.push(reasonOf(error, "QBO Deposit cash back is unsupported"));
    }
  }
  unsupported.push(...objectLevelReasons(objectType, body, lines, rawLines.length));
  return {
    value: {
      objectType,
      objectId,
      version,
      providerUpdatedAt: updatedAt,
      transactionDate,
      postingState: state,
      currency: currencyCodeValue,
      providerBody: body,
      lines,
      unsupportedReasons: unsupported,
    },
    unsupportedReasons: unsupported,
  };
}
