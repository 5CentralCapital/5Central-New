import assert from "node:assert/strict";
import test from "node:test";
import { journalEntryAccountIds, normalizeQboReceivable, type ReceivableNormalizationResult } from "./normalize-receivables";

const usd = { homeCurrency: "USD", multiCurrencyEnabled: false } as const;
const meta = { LastUpdatedTime: "2026-09-01T10:00:00-07:00" };

function supported(result: ReceivableNormalizationResult) {
  assert.equal(result.status, "supported", result.status === "unsupported" ? result.reasons.join("; ") : result.status);
  return (result as Extract<ReceivableNormalizationResult, { status: "supported" }>).document;
}

function reasons(result: ReceivableNormalizationResult): string {
  assert.equal(result.status, "unsupported");
  return (result as Extract<ReceivableNormalizationResult, { status: "unsupported" }>).reasons.join("; ");
}

const invoice = (overrides: Record<string, unknown> = {}) => ({
  Id: "130", SyncToken: "2", MetaData: meta, TxnDate: "2026-09-01", DueDate: "2026-09-05", DocNumber: "1037",
  CustomerRef: { value: "58", name: "Synthetic Tenant" }, CurrencyRef: { value: "USD" },
  ClassRef: { value: "5000000000000001" }, DepartmentRef: { value: "1" },
  TotalAmt: 1275, Balance: 1275, EmailStatus: "NotSet",
  AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowIPNPayment: false,
  Line: [
    { Id: "1", LineNum: 1, Amount: 1200, DetailType: "SalesItemLineDetail", Description: "Rent", SalesItemLineDetail: { ItemRef: { value: "10" }, ServiceDate: "2026-09-01" } },
    { Id: "2", LineNum: 2, Amount: 100, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "11" }, ClassRef: { value: "5000000000000002" } } },
    { Amount: 1300, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
    { Id: "3", Amount: 25, DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false, DiscountAccountRef: { value: "86" } } },
    { DetailType: "DescriptionOnly", Description: "Thank you", DescriptionLineDetail: {} },
  ],
  ...overrides,
});

test("an invoice becomes signed charge and discount effects that reconcile to TotalAmt", () => {
  const document = supported(normalizeQboReceivable("Invoice", invoice(), { currency: usd }));
  assert.equal(document.customerObjectId, "58");
  assert.equal(document.totalCents, "127500");
  assert.equal(document.openBalanceCents, "127500");
  assert.equal(document.dueDate, "2026-09-05");
  assert.equal(document.providerUpdatedAt, "2026-09-01T17:00:00.000Z");
  assert.deepEqual(document.effects.map(effect => [effect.effectId, effect.kind, effect.amountCents]), [["1", "charge", "120000"], ["2", "charge", "10000"], ["3", "discount", "-2500"]]);
  // Line class wins; otherwise the header class and department apply.
  assert.equal(document.effects[0]!.classObjectId, "5000000000000001");
  assert.equal(document.effects[1]!.classObjectId, "5000000000000002");
  assert.equal(document.effects[0]!.departmentObjectId, "1");
  assert.equal(document.effects[0]!.serviceDate, "2026-09-01");
  assert.deepEqual([document.emailStatus, document.allowOnlineCard, document.allowOnlineAch, document.allowIpn, document.billEmailPresent], ["NotSet", false, false, false, false]);
});

test("string decimals are accepted exactly and sub-cent precision is refused", () => {
  const exact = supported(normalizeQboReceivable("Invoice", invoice({ TotalAmt: "1275.00", Balance: "0", Line: [{ Id: "1", Amount: "1275.00", DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }] }), { currency: usd }));
  assert.equal(exact.openBalanceCents, "0");
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ TotalAmt: "1275.005", Line: [{ Id: "1", Amount: "1275.005", DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }] }), { currency: usd })), /sub-cent/);
});

test("an invoice is unsupported as a whole when anything is not understood", () => {
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ TotalAmt: 1300 }), { currency: usd })), /do not reconcile/);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ TxnTaxDetail: { TotalTax: 5 } }), { currency: usd })), /sales tax/);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ Line: [{ Id: "1", Amount: 1275, DetailType: "GroupLineDetail", GroupLineDetail: {} }] }), { currency: usd })), /unsupported DetailType GroupLineDetail/);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ Balance: 2000 }), { currency: usd })), /Balance is outside/);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ Balance: undefined }), { currency: usd })), /Balance is missing/);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ CustomerRef: undefined }), { currency: usd })), /CustomerRef is missing/);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ Deposit: 50 }), { currency: usd })), /deposit applied/);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ EmailStatus: "Queued" }), { currency: usd })), /EmailStatus/);
  const duplicate = invoice({ Line: [{ Id: "1", Amount: 600, DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }, { Id: "1", Amount: 675, DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }] });
  assert.match(reasons(normalizeQboReceivable("Invoice", duplicate, { currency: usd })), /duplicate line identities/);
});

test("a missing currency is never assumed", () => {
  const body = invoice({ CurrencyRef: undefined });
  assert.match(reasons(normalizeQboReceivable("Invoice", body, { currency: null })), /CurrencyRef is absent/);
  assert.match(reasons(normalizeQboReceivable("Invoice", body, { currency: { homeCurrency: "USD", multiCurrencyEnabled: null } })), /not verified off/);
  assert.equal(supported(normalizeQboReceivable("Invoice", body, { currency: usd })).currency, "USD");
});

test("foreign currency and explicit nonzero voids are excluded from the receivables mirror", () => {
  const foreign = normalizeQboReceivable("Invoice", invoice({ CurrencyRef: { value: "CAD" } }), { currency: usd });
  assert.match(reasons(foreign), /differs from verified home currency/);
  const nonEntity = normalizeQboReceivable("Invoice", invoice(), { currency: usd, entityCurrency: "CAD" });
  assert.match(reasons(nonEntity), /differs from legal entity currency/);
  const voided = supported(normalizeQboReceivable("Invoice", invoice({ TxnStatus: "Voided" }), { currency: usd }));
  assert.equal(voided.postingState, "voided");
});

test("a credit memo reduces the balance and keeps its remaining credit", () => {
  const document = supported(normalizeQboReceivable("CreditMemo", {
    Id: "77", SyncToken: "0", MetaData: meta, TxnDate: "2026-09-10", CustomerRef: { value: "58" }, CurrencyRef: { value: "USD" },
    TotalAmt: 50, RemainingCredit: 20,
    Line: [{ Id: "1", Amount: 50, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "12" } } }],
  }, { currency: usd }));
  assert.deepEqual(document.effects.map(effect => [effect.kind, effect.amountCents]), [["credit", "-5000"]]);
  assert.equal(document.openBalanceCents, "2000");
});

test("a payment credits the customer by TotalAmt and records its applications", () => {
  const document = supported(normalizeQboReceivable("Payment", {
    Id: "200", SyncToken: "1", MetaData: meta, TxnDate: "2026-09-03", CustomerRef: { value: "58" }, CurrencyRef: { value: "USD" },
    TotalAmt: 1300, UnappliedAmt: 5, PaymentRefNum: "4412", DepositToAccountRef: { value: "4" },
    Line: [
      { Amount: 1275, LinkedTxn: [{ TxnId: "130", TxnType: "Invoice" }] },
      { Amount: 20, LinkedTxn: [{ TxnId: "90", TxnType: "JournalEntry" }] },
      { Amount: 70, LinkedTxn: [{ TxnId: "77", TxnType: "CreditMemo" }] },
      { Amount: 70, LinkedTxn: [{ TxnId: "131", TxnType: "Invoice" }] },
    ],
  }, { currency: usd }));
  assert.deepEqual(document.effects.map(effect => [effect.effectId, effect.kind, effect.amountCents, effect.accountObjectId, effect.description]), [["payment", "payment", "-130000", "4", "Ref 4412"]]);
  assert.deepEqual(document.applications.map(application => [application.applicationId, application.targetType, application.amountCents]), [
    ["linked:Invoice:130", "Invoice", "127500"], ["linked:JournalEntry:90", "JournalEntry", "2000"], ["linked:CreditMemo:77", "CreditMemo", "7000"], ["linked:Invoice:131", "Invoice", "7000"],
  ]);
  assert.equal(document.openBalanceCents, "500");
});

test("a payment whose applications do not explain its total, or that applies an unsupported type, is refused", () => {
  const base = { Id: "201", SyncToken: "0", MetaData: meta, TxnDate: "2026-09-03", CustomerRef: { value: "58" }, CurrencyRef: { value: "USD" } };
  assert.match(reasons(normalizeQboReceivable("Payment", { ...base, TotalAmt: 100, UnappliedAmt: 0, Line: [{ Amount: 90, LinkedTxn: [{ TxnId: "1", TxnType: "Invoice" }] }] }, { currency: usd })), /do not reconcile/);
  assert.match(reasons(normalizeQboReceivable("Payment", { ...base, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "1", TxnType: "Deposit" }] }] }, { currency: usd })), /not a supported receivable target/);
  assert.match(reasons(normalizeQboReceivable("Payment", { ...base, TotalAmt: 100, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "1", TxnType: "Invoice" }, { TxnId: "2", TxnType: "Invoice" }] }] }, { currency: usd })), /more than one/);
  // A voided payment has no effect and no applications.
  const voided = supported(normalizeQboReceivable("Payment", { ...base, TotalAmt: 0, UnappliedAmt: 0, PrivateNote: "Voided", Line: [] }, { currency: usd }));
  assert.deepEqual([voided.effects.length, voided.postingState], [0, "voided"]);
});

test("sales and refund receipts net to zero and cash sales without a customer are not receivables", () => {
  const receipt = supported(normalizeQboReceivable("SalesReceipt", {
    Id: "300", SyncToken: "0", MetaData: meta, TxnDate: "2026-09-04", CustomerRef: { value: "58" }, CurrencyRef: { value: "USD" }, TotalAmt: 35, DepositToAccountRef: { value: "4" },
    Line: [{ Id: "1", Amount: 35, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "15" } } }],
  }, { currency: usd }));
  assert.deepEqual(receipt.effects.map(effect => [effect.kind, effect.amountCents]), [["charge", "3500"], ["receipt", "-3500"]]);
  const refund = supported(normalizeQboReceivable("RefundReceipt", {
    Id: "301", SyncToken: "0", MetaData: meta, TxnDate: "2026-09-04", CustomerRef: { value: "58" }, CurrencyRef: { value: "USD" }, TotalAmt: 35, DepositToAccountRef: { value: "4" },
    Line: [{ Id: "1", Amount: 35, DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }],
  }, { currency: usd }));
  assert.deepEqual(refund.effects.map(effect => [effect.kind, effect.amountCents]), [["credit", "-3500"], ["refund", "3500"]]);
  const cash = normalizeQboReceivable("SalesReceipt", { Id: "302", SyncToken: "0", MetaData: meta, TxnDate: "2026-09-04", CurrencyRef: { value: "USD" }, TotalAmt: 5, Line: [] }, { currency: usd });
  assert.equal(cash.status, "not_receivable");
});

test("journal entries contribute only Accounts Receivable lines tagged with a customer", () => {
  const body = {
    Id: "90", SyncToken: "3", MetaData: meta, TxnDate: "2026-08-31", CurrencyRef: { value: "USD" },
    Line: [
      { Id: "0", Amount: 150, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "84" }, Entity: { Type: "Customer", EntityRef: { value: "58" } } } },
      { Id: "1", Amount: 40, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "84" }, Entity: { Type: "Customer", EntityRef: { value: "59" } } } },
      { Id: "2", Amount: 110, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
    ],
  };
  assert.deepEqual(journalEntryAccountIds(body), ["84", "79"]);
  const types = new Map([["84", "Accounts Receivable"], ["79", "Income"]]);
  const document = supported(normalizeQboReceivable("JournalEntry", body, { currency: usd, accountTypes: types }));
  assert.equal(document.customerObjectId, null);
  assert.deepEqual(document.effects.map(effect => [effect.customerObjectId, effect.kind, effect.amountCents]), [["58", "adjustment", "15000"], ["59", "adjustment", "-4000"]]);
  assert.equal(document.totalCents, "11000");
  // Without the account's type a customer-tagged line cannot be classified.
  assert.match(reasons(normalizeQboReceivable("JournalEntry", body, { currency: usd, accountTypes: new Map([["79", "Income"]]) })), /not mirrored yet/);
  // Unbalanced journals are refused; journals without A/R lines are not receivables.
  const unbalanced = { ...body, Line: body.Line.slice(0, 2) };
  assert.match(reasons(normalizeQboReceivable("JournalEntry", unbalanced, { currency: usd, accountTypes: types })), /do not balance/);
  const expenseOnly = { ...body, Line: [
    { Id: "0", Amount: 10, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "79" } } },
    { Id: "1", Amount: 10, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
  ] };
  assert.equal(normalizeQboReceivable("JournalEntry", expenseOnly, { currency: usd, accountTypes: types }).status, "not_receivable");
});

test("unknown types and malformed identities are reported, never guessed", () => {
  assert.equal(normalizeQboReceivable("Estimate", {}).status, "unsupported");
  const noToken = normalizeQboReceivable("Invoice", { ...invoice(), SyncToken: undefined }, { currency: usd });
  assert.equal(noToken.status, "unsupported");
  assert.equal((noToken as { identity: unknown }).identity, null);
  assert.match(reasons(normalizeQboReceivable("Invoice", invoice({ TxnDate: "2026-02-30" }), { currency: usd })), /calendar date/);
});
