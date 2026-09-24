import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAmounts } from "./list-totals";

test("summarizeAmounts adds cent strings exactly and groups currencies", () => {
  const result = summarizeAmounts([
    { currency: "USD", amountCents: "900719925474099100" },
    { currency: "USD", amountCents: "25" },
    { currency: "EUR", amountCents: "125" },
  ]);

  assert.deepEqual(result, [
    { currency: "EUR", totalCents: "125", count: 1, knownCount: 1, unknownCount: 0 },
    { currency: "USD", totalCents: "900719925474099125", count: 2, knownCount: 2, unknownCount: 0 },
  ]);
});

test("unknown amounts stay unknown and excluded rows do not become posted totals", () => {
  const result = summarizeAmounts([
    { currency: "USD", amountCents: "100", state: "posted", mirrored: true },
    { currency: "USD", amountCents: null, state: "posted", mirrored: true },
    { currency: "USD", amountCents: "900", state: "voided", mirrored: true },
    { currency: "USD", amountCents: "700", state: "posted", mirrored: false },
    { currency: "CAD", amountCents: "20", state: "voided", mirrored: true },
  ], { include: item => item.state === "posted" && item.mirrored });

  assert.deepEqual(result, [
    { currency: "CAD", totalCents: "0", count: 0, knownCount: 0, unknownCount: 0 },
    { currency: "USD", totalCents: null, count: 2, knownCount: 1, unknownCount: 1 },
  ]);
});

test("a custom amount selector preserves unknown open balances", () => {
  const result = summarizeAmounts([
    { currency: "USD", amountCents: "1000", openBalanceCents: "250" },
    { currency: "USD", amountCents: "500", openBalanceCents: null },
  ], { amount: item => item.openBalanceCents });

  assert.equal(result[0]?.totalCents, null);
  assert.equal(result[0]?.knownCount, 1);
  assert.equal(result[0]?.unknownCount, 1);
});

