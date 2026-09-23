import assert from "node:assert/strict";
import test from "node:test";
import { filterNewQuickBooksWebhookEvents, parseQuickBooksWebhookPayload, quickBooksWebhookSignature, verifyQuickBooksWebhookSignature } from "./webhook";

test("webhook verification uses the exact raw body and rejects tampering", () => {
  const raw = Buffer.from('{"name":"é"}', "utf8");
  const verifier = "synthetic-verifier-token";
  const signature = quickBooksWebhookSignature(raw, verifier);
  assert.equal(verifyQuickBooksWebhookSignature(raw, signature, verifier), true);
  assert.equal(verifyQuickBooksWebhookSignature(Buffer.from('{"name":"e"}', "utf8"), signature, verifier), false);
  assert.equal(verifyQuickBooksWebhookSignature(raw, signature, "wrong-token"), false);
});

function cloudEvent(overrides: Record<string, unknown> = {}) {
  return {
    specversion: "1.0",
    id: "evt-1",
    source: "intuit.dsnBgbseACLLRZNxo2dfc4evmEJdxde58xeeYcZliOU=",
    type: "qbo.bill.created.v1",
    datacontenttype: "application/json",
    time: "2026-09-22T12:00:00.000Z",
    intuitentityid: "42",
    intuitaccountid: "4620816365001234567",
    data: {},
    ...overrides,
  };
}

test("CloudEvents array payloads parse after verification and collapse duplicate deliveries", () => {
  const payload = JSON.stringify([
    cloudEvent(),
    cloudEvent({ id: "evt-2", type: "qbo.vendor.updated.v1", intuitentityid: "7", data: undefined }),
    cloudEvent(),
  ]);
  const verifier = "synthetic-verifier-token";
  assert.equal(verifyQuickBooksWebhookSignature(payload, quickBooksWebhookSignature(payload, verifier), verifier), true);
  const events = parseQuickBooksWebhookPayload(payload);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { specVersion: "1.0", id: "evt-1", source: cloudEvent().source, type: "qbo.bill.created.v1", intuitAccountId: "4620816365001234567", time: "2026-09-22T12:00:00.000Z", intuitEntityId: "42", data: {} });
  assert.equal(events[1]?.type, "qbo.vendor.updated.v1");
  assert.equal("data" in events[1]!, false, "data may be absent");
});

test("legacy eventNotifications and incomplete CloudEvents are rejected", () => {
  assert.throws(() => parseQuickBooksWebhookPayload(JSON.stringify({ eventNotifications: [{ realmId: "123", dataChangeEvent: { entities: [] } }] })), /CloudEvents array/);
  for (const broken of [
    { specversion: undefined },
    { specversion: "0.3" },
    { id: "" },
    { type: "Bill.Create" },
    { intuitaccountid: "../123" },
    { intuitaccountid: undefined },
    { time: "yesterday" },
    { source: undefined },
  ]) {
    assert.throws(() => parseQuickBooksWebhookPayload(JSON.stringify([cloudEvent(broken)])), /webhook event/, JSON.stringify(broken));
  }
  assert.throws(() => parseQuickBooksWebhookPayload("[1]"), /event is invalid/);
});

test("replayed webhook deliveries are dropped by the per-realm event ledger", async () => {
  const accepted = new Set<string>();
  const ledger = { async recordIfNew(realmId: string, eventId: string) { const key = `${realmId}/${eventId}`; if (accepted.has(key)) return false; accepted.add(key); return true; } };
  const first = await filterNewQuickBooksWebhookEvents(parseQuickBooksWebhookPayload(JSON.stringify([cloudEvent(), cloudEvent({ id: "evt-2" })])), ledger);
  assert.deepEqual(first.map(event => event.id), ["evt-1", "evt-2"]);
  const replay = await filterNewQuickBooksWebhookEvents(parseQuickBooksWebhookPayload(JSON.stringify([cloudEvent({ id: "evt-2" }), cloudEvent({ id: "evt-3" })])), ledger);
  assert.deepEqual(replay.map(event => event.id), ["evt-3"]);
  const otherRealm = await filterNewQuickBooksWebhookEvents(parseQuickBooksWebhookPayload(JSON.stringify([cloudEvent({ intuitaccountid: "987" })])), ledger);
  assert.deepEqual(otherRealm.map(event => event.intuitAccountId), ["987"]);
});
