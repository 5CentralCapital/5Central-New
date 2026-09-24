import assert from "node:assert/strict";
import test from "node:test";
import { formatInputValue, formatMoneyExact, parseMoneyInput, sumCents } from "./money";

test("project money input preserves large exact cents", () => {
  const parsed = parseMoneyInput("92233720368547758.07", "Budget");
  assert.equal(parsed.cents, "9223372036854775807");
  assert.equal(parsed.normalized, "92233720368547758.07");
  assert.equal(formatInputValue(parsed.cents), "92233720368547758.07");
});

test("project money input supports signed values without floating point", () => {
  assert.equal(parseMoneyInput("-12.5").cents, "-1250");
  assert.equal(parseMoneyInput(".05").cents, "5");
  assert.equal(formatMoneyExact("-1250", "USD"), "-$12.50");
});

test("project money input rejects fractions beyond cents and overflow", () => {
  assert.throws(() => parseMoneyInput("1.005"), /no more than two decimal places/);
  assert.throws(() => parseMoneyInput("92233720368547758.08"), /signed 64-bit range/);
  assert.throws(() => parseMoneyInput("1e3"), /no more than two decimal places/);
});

test("project list totals add exact cents and keep an all-unknown total unknown", () => {
  assert.equal(sumCents(["9223372036854775800", "7", null]), "9223372036854775807");
  assert.equal(sumCents([null, undefined]), null);
});

test("cost summary incurred and paid carry their QuickBooks qualifiers", async () => {
  const { incurredLabel, paidLabel, formatQualifiedMoney } = await import("./money");
  const base = { currency: "USD", incurred: { totalCents: "150000" } };
  assert.equal(incurredLabel({ ...base, completeness: "complete" }), "$1,500.00");
  assert.equal(incurredLabel({ ...base, completeness: "partial" }), "At least $1,500.00", "partial QuickBooks coverage makes incurred a minimum");
  assert.equal(incurredLabel({ currency: "USD", completeness: "unavailable", incurred: { totalCents: null } }), "Unknown");
  assert.equal(paidLabel({ currency: "USD", paid: { cents: "90000", knownCents: "90000", coverage: "complete" } }), "$900.00");
  assert.equal(paidLabel({ currency: "USD", paid: { cents: null, knownCents: "90000", coverage: "partial" } }), "At least $900.00");
  assert.equal(paidLabel({ currency: "USD", paid: { cents: null, knownCents: "0", coverage: "unavailable" } }), "Unknown", "unavailable QuickBooks is Unknown, not At least $0.00");
  assert.equal(formatQualifiedMoney("5", "unavailable"), "Unknown");
});
