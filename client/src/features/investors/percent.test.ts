import assert from "node:assert/strict";
import test from "node:test";
import { percentageToBasisPoints, percentageToRateDecimal } from "./percent";

test("ownership percentages convert to exact basis points", () => {
  assert.equal(percentageToBasisPoints("25"), 2500);
  assert.equal(percentageToBasisPoints("25.5"), 2550);
  assert.equal(percentageToBasisPoints("100.00"), 10_000);
  assert.throws(() => percentageToBasisPoints("25.001"), /at most 2 decimal places/);
  assert.throws(() => percentageToBasisPoints("100.01"), /between 0% and 100%/);
});

test("annual percentages convert to exact decimal rates without floating point", () => {
  assert.equal(percentageToRateDecimal("12"), "0.12");
  assert.equal(percentageToRateDecimal("12.5"), "0.125");
  assert.equal(percentageToRateDecimal("0.12"), "0.0012");
  assert.equal(percentageToRateDecimal("12.345678"), "0.12345678");
  assert.throws(() => percentageToRateDecimal("12.3456789"), /at most 6 decimal places/);
});
