import assert from "node:assert/strict";
import test from "node:test";
import { sumTimeMoneyByCurrency } from "./totals";

test("time totals keep mixed or missing currencies unknown", () => {
  assert.deepEqual(sumTimeMoneyByCurrency([
    { cents: "125", currency: "USD" },
    { cents: "75", currency: "USD" },
    { cents: "500", currency: "CAD" },
    { cents: "900", currency: null },
    { cents: "1000", currency: "EUR" },
  ]), [
    { currency: "CAD", cents: "500", knownCount: 1, unknownCount: 0 },
    { currency: "EUR", cents: "1000", knownCount: 1, unknownCount: 0 },
    { currency: "Unknown currency", cents: null, knownCount: 0, unknownCount: 1 },
    { currency: "USD", cents: "200", knownCount: 2, unknownCount: 0 },
  ]);
});
