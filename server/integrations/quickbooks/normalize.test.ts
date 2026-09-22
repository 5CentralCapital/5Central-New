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
