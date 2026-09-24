import assert from "node:assert/strict";
import test from "node:test";
import { formatExactCents, parseExactCents, summarizeCurrentMonthlyCharges, summarizeExactCents, summarizeLedgerRows } from "./list-totals-model";

test("exact cents summaries retain integer precision and mark unknown amounts", () => {
  assert.equal(parseExactCents(125050), BigInt(125050));
  assert.equal(parseExactCents("9007199254740993"), BigInt("9007199254740993"));
  assert.deepEqual(summarizeExactCents([125050, "250", null]), {
    total: null,
    knownTotal: BigInt(125300),
    knownCount: 2,
    unknownCount: 1,
  });
  assert.equal(formatExactCents(BigInt("9007199254740993")), "$90,071,992,547,409.93");
  assert.equal(formatExactCents(-25), "-$0.25");
});

test("ledger summaries separate charges and payments and use the ending balance once", () => {
  const totals = summarizeLedgerRows([
    { chargeCents: 10000, paymentCents: undefined, runningBalanceCents: 10000, postedOn: "2026-09-01" },
    { chargeCents: undefined, paymentCents: 2500, runningBalanceCents: 7500, postedOn: "2026-09-02" },
    { chargeCents: 500, paymentCents: undefined, runningBalanceCents: 8000, postedOn: "2026-09-03" },
  ]);
  assert.equal(totals.charge.total, BigInt(10500));
  assert.equal(totals.payment.total, BigInt(2500));
  assert.equal(totals.endingBalance.total, BigInt(8000));
  assert.notEqual(totals.endingBalance.total, BigInt(25500));
});

test("ledger ending balance follows the latest posted date even when rows are newest first", () => {
  const totals = summarizeLedgerRows([
    { runningBalanceCents: 8000, postedOn: "2026-09-03" },
    { runningBalanceCents: 7500, postedOn: "2026-09-02" },
    { runningBalanceCents: 10000, postedOn: "2026-09-01" },
  ]);
  assert.equal(totals.endingBalance.total, BigInt(8000));
});

test("an unknown final ledger balance stays unknown", () => {
  const totals = summarizeLedgerRows([{ chargeCents: 100, runningBalanceCents: null }]);
  assert.equal(totals.endingBalance.total, null);
  assert.equal(totals.endingBalance.unknownCount, 1);
});

test("recurring totals only combine current monthly rent and fees", () => {
  const summary = summarizeCurrentMonthlyCharges([
    { amountCents: 100000, billingFrequency: "monthly", category: "base_rent", scopeType: "tenant" },
    { amountCents: 2500, billingFrequency: "monthly", category: "recurring_fee", scopeType: "unit" },
    { amountCents: 90000, billingFrequency: "annual", category: "base_rent", scopeType: "tenant" },
    { amountCents: 125000, billingFrequency: "monthly", category: "base_rent", scopeType: "property" },
  ]);
  assert.equal(summary?.total, BigInt(102500));
  assert.equal(summarizeCurrentMonthlyCharges([{ amountCents: null, billingFrequency: "monthly", category: "base_rent", scopeType: "tenant" }])?.total, null);
  assert.equal(summarizeCurrentMonthlyCharges([{ amountCents: 100, billingFrequency: "weekly", category: "base_rent", scopeType: "tenant" }]), null);
});
