import assert from "node:assert/strict";
import test from "node:test";
import { formatInputValue, formatMoneyExact, parseMoneyInput } from "./money";

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
