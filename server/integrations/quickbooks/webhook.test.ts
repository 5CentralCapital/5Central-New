import assert from "node:assert/strict";
import test from "node:test";
import { parseQuickBooksWebhookPayload, quickBooksWebhookSignature, verifyQuickBooksWebhookSignature } from "./webhook";

test("webhook verification uses the exact raw body and rejects tampering", () => {
  const raw = Buffer.from('{"name":"é"}', "utf8");
  const verifier = "synthetic-verifier-token";
  const signature = quickBooksWebhookSignature(raw, verifier);
  assert.equal(verifyQuickBooksWebhookSignature(raw, signature, verifier), true);
  assert.equal(verifyQuickBooksWebhookSignature(Buffer.from('{"name":"e"}', "utf8"), signature, verifier), false);
  assert.equal(verifyQuickBooksWebhookSignature(raw, signature, "wrong-token"), false);
});

test("webhook payload parsing is separate from signature verification", () => {
  const payload = JSON.stringify([{ id: "event-1", intuitaccountid: "123", intuitentityid: "42", type: "qbo.account.updated.v1", data: { Id: "42" } }]);
  const events = parseQuickBooksWebhookPayload(payload);
  assert.deepEqual(events[0], { id: "event-1", intuitAccountId: "123", intuitEntityId: "42", type: "qbo.account.updated.v1", data: { Id: "42" } });
});
