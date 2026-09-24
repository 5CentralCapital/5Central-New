import assert from "node:assert/strict";
import test from "node:test";
import { sumWorkOrderMoneyByCurrency } from "./totals";

test("work-order totals do not subtotal amounts without a valid currency", () => {
  assert.deepEqual(sumWorkOrderMoneyByCurrency([
    { cents: "2500", currency: "USD" },
    { cents: "1250", currency: "USD" },
    { cents: "3000", currency: "GBP" },
    { cents: "4500", currency: "usd" },
  ]), [
    { currency: "GBP", cents: "3000", knownCount: 1, unknownCount: 0 },
    { currency: "Unknown currency", cents: null, knownCount: 0, unknownCount: 1 },
    { currency: "USD", cents: "3750", knownCount: 2, unknownCount: 0 },
  ]);
});
