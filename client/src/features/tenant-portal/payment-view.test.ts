import test from "node:test";
import assert from "node:assert/strict";
import { noPaymentDueMessage } from "./payment-view";
const account = { tenancyId: "tenant:test", payableCents: 0, pendingCents: 0, available: false, reason: "no_payable_balance" };
test("paid account says no payment due without masking genuine unavailable states", () => {
  assert.equal(noPaymentDueMessage(account), "No payment is due.");
  assert.match(noPaymentDueMessage({ ...account, pendingCents: 100 })!, /in progress/);
  assert.match(noPaymentDueMessage({ ...account, payableCents: 25 })!, /at least \$0.50/);
  assert.equal(noPaymentDueMessage({ ...account, reason: "incomplete_ledger" }), undefined);
  assert.equal(noPaymentDueMessage(undefined), undefined);
});
