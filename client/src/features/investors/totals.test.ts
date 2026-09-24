import assert from "node:assert/strict";
import test from "node:test";
import { sumMoneyByCurrency } from "./totals";

test("investor totals preserve bigint cents, currencies, and unknown values", () => {
  assert.deepEqual(sumMoneyByCurrency([
    { cents: "9223372036854775800", currency: "USD" },
    { cents: "7", currency: "USD" },
    { cents: null, currency: "USD" },
    { cents: "12", currency: "CAD" },
  ]), [
    { currency: "CAD", cents: "12", knownCount: 1, unknownCount: 0 },
    { currency: "USD", cents: "9223372036854775807", knownCount: 2, unknownCount: 1 },
  ]);
});

test("investor totals never add amounts whose currency is unknown", () => {
  assert.deepEqual(sumMoneyByCurrency([
    { cents: "100", currency: null },
    { cents: "200", currency: "EUR" },
    { cents: "300", currency: "USD" },
    { cents: "400", currency: "not-a-currency" },
  ]), [
    { currency: "EUR", cents: "200", knownCount: 1, unknownCount: 0 },
    { currency: "Unknown currency", cents: null, knownCount: 0, unknownCount: 2 },
    { currency: "USD", cents: "300", knownCount: 1, unknownCount: 0 },
  ]);
});
