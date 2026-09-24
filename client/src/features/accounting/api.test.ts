import assert from "node:assert/strict";
import test from "node:test";
import { parseTransaction } from "./api";

const line = {
  source: {
    provider: "qbo",
    organizationId: "11111111-1111-4111-8111-111111111111",
    legalEntityId: "22222222-2222-4222-8222-222222222222",
    environment: "production",
    realmId: "1234567890",
    objectType: "Purchase",
    objectId: "purchase-1",
    lineId: "line-1",
    version: "1",
  },
  direction: "debit",
  flow: "outgoing",
  lineRole: "expense",
  amountCents: "9007199254740993",
  currency: "USD",
  transactionType: "Purchase",
  accountObjectId: "expense-account",
  counterpartyObjectId: null,
  description: "Provider purchase",
  postingState: "posted",
  postedOn: "2026-09-24",
  settlement: { state: "unknown", settledOn: null, settledAmountCents: null },
  watermark: { value: "sync-1", observedAt: "2026-09-24T12:00:00Z" },
};

test("transaction parser preserves exact bigint cents strings", () => {
  assert.equal(parseTransaction(line).amountCents, "9007199254740993");
});

test("transaction parser rejects a missing or malformed amount instead of treating it as zero", () => {
  assert.throws(() => parseTransaction({ ...line, amountCents: null }), /unexpected shape/);
  assert.throws(() => parseTransaction({ ...line, amountCents: 0 }), /unexpected shape/);
  assert.throws(() => parseTransaction({ ...line, amountCents: "" }), /unexpected shape/);
});
