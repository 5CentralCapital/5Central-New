import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQboTransaction, qboAmountToCents } from "./normalize";

const updated = "2026-09-21T14:00:00Z";

test("normalizes provider Purchase, Bill, and BillPayment lines with exact cent text", () => {
  const purchase = normalizeQboTransaction("Purchase", {
    Id: "101", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" },
    PaymentType: "Check", EntityRef: { value: "vendor-1" }, AccountRef: { value: "bank-1" },
    MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: "125.40", Description: "Materials", AccountBasedExpenseLineDetail: { AccountRef: { value: "expense-1" } } }],
  });
  assert.ok(purchase.value);
  assert.equal(purchase.value.lines[0]?.amountCents, "12540");
  assert.equal(purchase.value.lines[0]?.settlementState, "unknown");
  assert.equal(purchase.value.lines[0]?.accountObjectId, "expense-1");
  assert.equal(purchase.value.lines[0]?.counterpartyObjectId, "vendor-1");

  const bill = normalizeQboTransaction("Bill", {
    Id: "102", SyncToken: "1", TxnDate: "2026-09-19", CurrencyRef: { value: "USD" },
    VendorRef: { value: "vendor-2" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: 90.5, AccountBasedExpenseLineDetail: { AccountRef: { value: "expense-2" } } }],
  });
  assert.ok(bill.value);
  assert.equal(bill.value.lines[0]?.amountCents, "9050");
  assert.equal(bill.value.lines[0]?.settlementState, "unknown");

  const payment = normalizeQboTransaction("BillPayment", {
    Id: "103", SyncToken: "2", TxnDate: "2026-09-21", CurrencyRef: { value: "USD" },
    VendorRef: { value: "vendor-2" }, APAccountRef: { value: "ap-1" }, CheckPayment: { BankAccountRef: { value: "bank-2" } }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: "90.50", LinkedTxn: [{ TxnId: "102", TxnType: "Bill" }] }],
  });
  assert.ok(payment.value);
  assert.equal(payment.value.lines[0]?.settlementState, "unknown");
  assert.equal(payment.value.lines[0]?.settledAmountCents, null);
  assert.equal(payment.value.lines[0]?.direction, "credit");
  assert.equal(payment.value.lines[0]?.flow, "outgoing");
});

test("normalizes JournalEntry debit cost and credit refund lines with exact source identities", () => {
  const result = normalizeQboTransaction("JournalEntry", {
    Id: "2949", SyncToken: "0", TxnDate: "2026-09-08", CurrencyRef: { value: "USD" },
    MetaData: { LastUpdatedTime: updated },
    Line: [
      { Id: "0", Amount: "1286.44", Description: "Inventory cost", DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "inventory-1" } } },
      { Id: "1", Amount: "1286.44", Description: "Refund", DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "refund-1" } } },
    ],
  });
  assert.deepEqual(result.unsupportedReasons, []);
  assert.deepEqual(result.value?.lines.map(line => ({
    lineId: line.lineId,
    accountObjectId: line.accountObjectId,
    amountCents: line.amountCents,
    direction: line.direction,
    flow: line.flow,
    lineRole: line.lineRole,
  })), [
    { lineId: "0", accountObjectId: "inventory-1", amountCents: "128644", direction: "debit", flow: "outgoing", lineRole: "expense" },
    { lineId: "1", accountObjectId: "refund-1", amountCents: "128644", direction: "credit", flow: "incoming", lineRole: "expense" },
  ]);
});

test("rejects an unbalanced JournalEntry instead of mirroring partial cost lines", () => {
  const result = normalizeQboTransaction("JournalEntry", {
    Id: "2950", SyncToken: "0", TxnDate: "2026-09-08", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: updated },
    Line: [
      { Id: "0", Amount: "100.00", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "inventory-1" } } },
      { Id: "1", Amount: "99.99", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "refund-1" } } },
    ],
  });
  assert.ok(result.unsupportedReasons.some(reason => /do not balance/.test(reason)));
  assert.equal(result.value?.lines.length, 2);
});

test("rejects sub-cent or unsafe provider amounts instead of rounding", () => {
  assert.throws(() => qboAmountToCents("1.001", "TotalAmt"), /sub-cent/);
  assert.throws(() => qboAmountToCents(Number.MAX_SAFE_INTEGER + 1, "TotalAmt"), /safe numeric/);
  const unsupported = normalizeQboTransaction("Bill", {
    Id: "104", SyncToken: "0", TxnDate: "2026-09-19", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: "1.001", AccountBasedExpenseLineDetail: { AccountRef: { value: "expense" } } }],
  });
  assert.ok(unsupported.value);
  assert.equal(unsupported.value.lines.length, 0);
  assert.equal(unsupported.unsupportedReasons.length, 1);
});

test("does not classify a posted Bill as cash settlement", () => {
  const result = normalizeQboTransaction("Bill", {
    Id: "105", SyncToken: "0", TxnDate: "2026-09-19", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: "10.00", AccountBasedExpenseLineDetail: { AccountRef: { value: "expense" } } }],
  });
  assert.equal(result.value?.postingState, "posted");
  assert.equal(result.value?.lines[0]?.settlementState, "unknown");
});

const usd = { homeCurrency: "USD", multiCurrencyEnabled: false } as const;

test("BillPayment lines without Line.Id are identified by their single linked Bill", () => {
  const result = normalizeQboTransaction("BillPayment", {
    Id: "201", SyncToken: "0", TxnDate: "2026-09-21", CurrencyRef: { value: "USD" }, TotalAmt: 150,
    VendorRef: { value: "56" }, PayType: "Check", CheckPayment: { BankAccountRef: { value: "35" } }, MetaData: { LastUpdatedTime: updated },
    Line: [
      { Amount: 100, LinkedTxn: [{ TxnId: "34", TxnType: "Bill" }] },
      { Amount: "50.00", LinkedTxn: [{ TxnId: "35", TxnType: "Bill" }] },
    ],
  });
  assert.deepEqual(result.unsupportedReasons, []);
  assert.deepEqual(result.value?.lines.map(line => [line.lineId, line.amountCents, line.accountObjectId, line.cashAccountObjectId]), [
    ["linked:Bill:34", "10000", "35", "35"],
    ["linked:Bill:35", "5000", "35", "35"],
  ]);
});

test("BillPayment that applies a vendor credit is rejected as a whole, not partially mirrored", () => {
  const result = normalizeQboTransaction("BillPayment", {
    Id: "202", SyncToken: "0", TxnDate: "2026-09-21", CurrencyRef: { value: "USD" }, TotalAmt: 70,
    VendorRef: { value: "56" }, PayType: "CreditCard", CreditCardPayment: { CCAccountRef: { value: "41" } }, MetaData: { LastUpdatedTime: updated },
    Line: [
      { Amount: 100, LinkedTxn: [{ TxnId: "34", TxnType: "Bill" }] },
      { Amount: 30, LinkedTxn: [{ TxnId: "90", TxnType: "VendorCredit" }] },
    ],
  });
  assert.ok(result.unsupportedReasons.some(reason => /VendorCredit/.test(reason)));
});

test("BillPayment line totals must reconcile to TotalAmt", () => {
  const result = normalizeQboTransaction("BillPayment", {
    Id: "203", SyncToken: "0", TxnDate: "2026-09-21", CurrencyRef: { value: "USD" }, TotalAmt: 99,
    VendorRef: { value: "56" }, CheckPayment: { BankAccountRef: { value: "35" } }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Amount: 100, LinkedTxn: [{ TxnId: "34", TxnType: "Bill" }] }],
  });
  assert.ok(result.unsupportedReasons.some(reason => /do not reconcile/.test(reason)));
});

test("Deposit detail lines keep their own offset account; linked Payment lines have no inferred account", () => {
  const result = normalizeQboTransaction("Deposit", {
    Id: "301", SyncToken: "1", TxnDate: "2026-09-21", TotalAmt: "425.00", DepositToAccountRef: { value: "35" }, MetaData: { LastUpdatedTime: updated },
    Line: [
      { Id: "1", Amount: 400, DetailType: "DepositLineDetail", DepositLineDetail: { AccountRef: { value: "79" }, Entity: { value: "3", type: "CUSTOMER" } } },
      { Amount: 25, LinkedTxn: [{ TxnId: "120", TxnType: "Payment", TxnLineId: "0" }] },
    ],
  }, { currency: usd });
  assert.deepEqual(result.unsupportedReasons, []);
  assert.equal(result.value?.currency, "USD");
  assert.deepEqual(result.value?.lines.map(line => [line.lineId, line.accountObjectId, line.cashAccountObjectId, line.counterpartyObjectId]), [
    ["1", "79", "35", "3"],
    ["linked:Payment:120", null, "35", null],
  ]);
});

test("Deposit with cash back is an explicit exception rather than overstated cash", () => {
  const result = normalizeQboTransaction("Deposit", {
    Id: "302", SyncToken: "0", TxnDate: "2026-09-21", CurrencyRef: { value: "USD" }, TotalAmt: 80, DepositToAccountRef: { value: "35" },
    CashBack: { AccountRef: { value: "36" }, Amount: 20 }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: 100, DepositLineDetail: { AccountRef: { value: "79" } } }],
  });
  assert.ok(result.unsupportedReasons.some(reason => /cash back/.test(reason)));
});

test("missing CurrencyRef is never assumed: needs verified home currency with multicurrency off", () => {
  const body = {
    Id: "303", SyncToken: "0", TxnDate: "2026-09-21", TotalAmt: 10, DepositToAccountRef: { value: "35" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: 10, DepositLineDetail: { AccountRef: { value: "79" } } }],
  };
  assert.equal(normalizeQboTransaction("Deposit", body).value, null);
  assert.equal(normalizeQboTransaction("Deposit", body, { currency: { homeCurrency: "USD", multiCurrencyEnabled: null } }).value, null);
  assert.equal(normalizeQboTransaction("Deposit", body, { currency: { homeCurrency: "CAD", multiCurrencyEnabled: false } }).value?.currency, "CAD");
});

test("purchase refunds and taxed transactions are explicit exceptions", () => {
  const credit = normalizeQboTransaction("Purchase", {
    Id: "401", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" }, PaymentType: "CreditCard", Credit: true, TotalAmt: 12,
    AccountRef: { value: "41" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: 12, AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }],
  });
  assert.ok(credit.unsupportedReasons.some(reason => /refund/.test(reason)));
  const taxed = normalizeQboTransaction("Bill", {
    Id: "402", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" }, TotalAmt: 107, TxnTaxDetail: { TotalTax: 7 },
    MetaData: { LastUpdatedTime: updated }, Line: [{ Id: "1", Amount: 100, AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }],
  });
  assert.ok(taxed.unsupportedReasons.some(reason => /tax/.test(reason)));
});

test("an item-based expense line never borrows the payment account as its expense account", () => {
  const result = normalizeQboTransaction("Purchase", {
    Id: "403", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" }, PaymentType: "Cash", TotalAmt: 5,
    AccountRef: { value: "bank-9" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Id: "1", Amount: 5, ItemBasedExpenseLineDetail: { ItemRef: { value: "11" } } }],
  });
  assert.deepEqual(result.unsupportedReasons, []);
  assert.equal(result.value?.lines[0]?.accountObjectId, null);
});

test("rejection reasons never echo provider values", () => {
  const result = normalizeQboTransaction("Bill", {
    Id: "404", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "secret-looking-value" }, MetaData: { LastUpdatedTime: updated }, Line: [],
  });
  assert.equal(result.value, null);
  assert.ok(result.unsupportedReasons.every(reason => !reason.includes("secret-looking-value")));
});

test("a linked Deposit line whose DepositLineDetail carries only payment metadata is a linked line (sandbox shape)", () => {
  const result = normalizeQboTransaction("Deposit", {
    Id: "102", SyncToken: "0", TxnDate: "2026-08-26", CurrencyRef: { value: "USD" }, TotalAmt: "408.00", DepositToAccountRef: { value: "35" }, MetaData: { LastUpdatedTime: updated },
    Line: [
      { Amount: "108.00", LinkedTxn: [{ TxnId: "31", TxnType: "Payment", TxnLineId: "0" }], DepositLineDetail: { PaymentMethodRef: { value: "2" }, CheckNum: "5000" } },
      { Amount: "300.00", LinkedTxn: [{ TxnId: "32", TxnType: "Payment", TxnLineId: "0" }], DepositLineDetail: { PaymentMethodRef: { value: "2" } } },
    ],
  });
  assert.deepEqual(result.unsupportedReasons, []);
  assert.deepEqual(result.value?.lines.map(line => [line.lineId, line.amountCents, line.accountObjectId]), [["linked:Payment:31", "10800", null], ["linked:Payment:32", "30000", null]]);
  const ambiguous = normalizeQboTransaction("Deposit", {
    Id: "103", SyncToken: "0", TxnDate: "2026-08-26", CurrencyRef: { value: "USD" }, TotalAmt: "5.00", DepositToAccountRef: { value: "35" }, MetaData: { LastUpdatedTime: updated },
    Line: [{ Amount: "5.00", LinkedTxn: [{ TxnId: "33", TxnType: "Payment" }], DepositLineDetail: { AccountRef: { value: "79" } } }],
  });
  assert.ok(ambiguous.unsupportedReasons.some(reason => /both a posting DepositLineDetail and LinkedTxn/.test(reason)));
});
