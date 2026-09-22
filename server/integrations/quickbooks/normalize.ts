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
import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../../shared/accounting/quickbooks";
import type { FinancialProviderPaymentSubtype, FinancialSourceFlow, FinancialSourceLineRole } from "../../../shared/accounting/source";

const SUPPORTED_TRANSACTION_TYPES = ["Purchase", "Bill", "BillPayment", "Deposit"] as const;
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

export interface QboNormalizationResult {
  readonly value: NormalizedQboObject | null;
  readonly unsupportedReasons: readonly string[];
}

function record(value: unknown): QuickBooksJsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as QuickBooksJsonObject : null;
}

function text(value: unknown, field: string, max = 255): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`QBO ${field} is invalid`);
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
  if (!Number.isFinite(parsed.getTime())) throw new Error("QBO provider update timestamp is invalid");
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
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error(`QBO ${field} exceeds the safe numeric boundary`);
    decimal = legacyNumberToDecimal(value);
  } else throw new Error(`QBO ${field} is missing or not a decimal`);
  const parts = parseDecimalParts(decimal);
  // QBO accounting amounts are represented at cent precision for this mirror.
  // Refuse hidden rounding instead of silently changing a provider amount.
  if (parts.scale > 2) throw new Error(`QBO ${field} has unsupported sub-cent precision`);
  const cents = parts.coefficient * BigInt(100) / BigInt(10 ** parts.scale);
  return centsFromBigInt(parts.sign < 0 ? -cents : cents);
}

function referenceId(value: unknown): string | null {
  const ref = record(value);
  return ref ? optionalText(ref.value ?? ref.Id, "provider reference", 200) : null;
}

function currency(value: QuickBooksJsonObject, fallback?: string | null): CurrencyCode {
  const supplied = record(value.CurrencyRef)?.value;
  if (supplied !== undefined && supplied !== null) return currencyCodeSchema.parse(text(supplied, "CurrencyRef.value", 3).toUpperCase());
  if (fallback !== undefined && fallback !== null) return currencyCodeSchema.parse(text(fallback, "verified HomeCurrency", 3).toUpperCase());
  throw new Error("QBO CurrencyRef is absent and no verified HomeCurrency is available");
}

function rawLineItems(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values;
}

function lineItems(value: unknown): readonly QuickBooksJsonObject[] {
  return rawLineItems(value).filter((item): item is QuickBooksJsonObject => Boolean(record(item)));
}

function postingState(body: QuickBooksJsonObject): "posted" | "voided" | "unknown" {
  const status = body.TxnStatus ?? body.Status;
  if (typeof status === "string" && /void/i.test(status)) return "voided";
  if (typeof status === "string" && /post|paid|open|closed|bill/i.test(status)) return "posted";
  return "posted";
}

function transactionAccount(type: SupportedQboTransactionType, body: QuickBooksJsonObject): string | null {
  if (type === "BillPayment") return paymentCashAccount(type, body);
  if (type === "Deposit") return referenceId(body.DepositToAccountRef) ?? referenceId(body.AccountRef);
  return referenceId(body.AccountRef);
}

function transactionCounterparty(type: SupportedQboTransactionType, body: QuickBooksJsonObject): string | null {
  if (type === "Bill" || type === "BillPayment") return referenceId(body.VendorRef) ?? referenceId(body.EntityRef);
  // Purchase.EntityRef is the provider payee. CustomerRef belongs to a
  // reporting dimension and is intentionally not used as a payee identity.
  return referenceId(body.EntityRef) ?? referenceId(body.VendorRef);
}

function lineAccount(type: SupportedQboTransactionType, body: QuickBooksJsonObject, line: QuickBooksJsonObject): string | null {
  const detail = record(line.AccountBasedExpenseLineDetail) ?? record(line.ItemBasedExpenseLineDetail) ?? record(line.Detail);
  return referenceId(detail?.AccountRef) ?? transactionAccount(type, body);
}

function lineCounterparty(type: SupportedQboTransactionType, body: QuickBooksJsonObject): string | null {
  return transactionCounterparty(type, body);
}

function depositLineCounterparty(line: QuickBooksJsonObject): string | null {
  const detail = record(line.DepositLineDetail);
  const entity = record(detail?.Entity) ?? record(detail?.EntityRef);
  return referenceId(entity);
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
      ?? referenceId(body.CCAccountRef)
      ?? referenceId(body.AccountRef);
  }
  if (type === "Deposit") return referenceId(body.DepositToAccountRef) ?? referenceId(body.AccountRef);
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

function lineFlow(type: SupportedQboTransactionType): FinancialSourceFlow {
  return type === "Deposit" ? "incoming" : "outgoing";
}

function lineDirection(type: SupportedQboTransactionType): "debit" | "credit" {
  // The line role carries the economic flow. A BillPayment line is a cash
  // credit only when its actual payment account is present; its generic Line
  // amount must never be treated as an AP debit by inference.
  return type === "BillPayment" ? "credit" : "debit";
}

function settled(type: SupportedQboTransactionType, _body: QuickBooksJsonObject, _amount: MoneyCents, _date: string, state: "posted" | "voided" | "unknown") {
  if (state === "voided") return { settlementState: "voided" as const, settledOn: null, settledAmountCents: null };
  // QBO posting and a payment method do not prove bank clearing. Settlement
  // is filled only by a separate bank/reconciliation evidence pipeline.
  return { settlementState: "unknown" as const, settledOn: null, settledAmountCents: null };
}

function normalizeLine(type: SupportedQboTransactionType, body: QuickBooksJsonObject, line: QuickBooksJsonObject, index: number, date: string, currencyCode: CurrencyCode, state: "posted" | "voided" | "unknown"): NormalizedQboLine {
  const lineId = text(line.Id, "line Id", 200);
  const amount = qboAmountToCents(line.Amount, `line ${lineId} Amount`);
  if (BigInt(amount) < BigInt(0)) throw new Error(`QBO line ${lineId} amount is negative`);
  const typePaymentAccount = paymentCashAccount(type, body);
  if (type === "Purchase" && body.PaymentType !== undefined && paymentSubtype(type, body) === null) {
    throw new Error(`QBO Purchase has unsupported PaymentType`);
  }
  if ((type === "BillPayment" || type === "Deposit") && typePaymentAccount === null) {
    throw new Error(`QBO ${type} line ${lineId} has no actual cash account reference`);
  }
  return {
    lineId,
    lineNumber: index + 1,
    transactionType: type,
    direction: lineDirection(type),
    flow: lineFlow(type),
    lineRole: lineRole(type),
    amountCents: amount,
    currency: currencyCode,
    postingState: state,
    postedOn: date,
    ...settled(type, body, amount, date, state),
    accountObjectId: lineAccount(type, body, line),
    counterpartyObjectId: type === "Deposit" ? depositLineCounterparty(line) : lineCounterparty(type, body),
    cashAccountObjectId: typePaymentAccount,
    paymentSubtype: paymentSubtype(type, body),
    description: lineDescription(body, line),
  };
}

/** Normalize only provider-shaped QBO Purchase, Bill and BillPayment bodies. */
export function normalizeQboTransaction(type: string, input: unknown, options: { readonly defaultCurrency?: string | null } = {}): QboNormalizationResult {
  const unsupported: string[] = [];
  if (!(SUPPORTED_TRANSACTION_TYPES as readonly string[]).includes(type)) return { value: null, unsupportedReasons: [`Unsupported QBO object type ${type}`] };
  const objectType = type as SupportedQboTransactionType;
  const body = record(input);
  if (!body) return { value: null, unsupportedReasons: ["QBO provider object is not a JSON object"] };
  let objectId: string;
  let version: string;
  let updatedAt: string;
  let transactionDate: string;
  let currencyCode: CurrencyCode;
  try {
    objectId = text(body.Id, `${objectType}.Id`, 200);
    version = text(body.SyncToken, `${objectType}.SyncToken`, 120);
    updatedAt = providerTimestamp(record(body.MetaData)?.LastUpdatedTime);
    transactionDate = isoDateSchema.parse(text(body.TxnDate, `${objectType}.TxnDate`));
    currencyCode = currency(body, options.defaultCurrency);
  } catch (error) {
    return { value: null, unsupportedReasons: [error instanceof Error ? error.message : "QBO object identity is invalid"] };
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
      lines.push(normalizeLine(objectType, body, line, index, transactionDate, currencyCode, state));
    } catch (error) {
      unsupported.push(error instanceof Error ? error.message : `QBO ${objectType} line ${index + 1} is unsupported`);
    }
  });
  if (rawLines.length === 0) unsupported.push(`QBO ${objectType} has no transaction lines`);
  return {
    value: {
      objectType,
      objectId,
      version,
      providerUpdatedAt: updatedAt,
      transactionDate,
      postingState: state,
      currency: currencyCode,
      providerBody: body,
      lines,
      unsupportedReasons: unsupported,
    },
    unsupportedReasons: unsupported,
  };
}

export function qboSourceScope(scope: QuickBooksConnectionScope) {
  return scope;
}
