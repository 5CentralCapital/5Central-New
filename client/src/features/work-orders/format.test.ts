import assert from "node:assert/strict";
import test from "node:test";
import { eventSummary, operatingToday, priorityClass, statusClass } from "./format";
import { PendingEnvelopes } from "./pending";

const event = { id: "5c978b3b-15da-4655-adda-5baad5278e36", fromStatus: null, toStatus: null, note: null, details: {}, recordRevision: 1, actorId: "demo", createdAt: "2026-09-22T12:00:00.000Z" } as const;

test("status and priority presentation keeps labels and tones consistent", () => {
  assert.match(statusClass("completed"), /rm-status--success/);
  assert.match(statusClass("on_hold"), /rm-status--warning/);
  assert.match(statusClass("canceled"), /rm-status--unknown/);
  assert.match(priorityClass("emergency") ?? "", /rm-status--error/);
  assert.equal(priorityClass("normal"), null);
});

test("activity summaries describe each history event", () => {
  assert.equal(eventSummary({ ...event, type: "status_changed", fromStatus: "new", toStatus: "on_hold" }), "New → On hold");
  assert.equal(eventSummary({ ...event, type: "updated", details: { fields: ["title", "tenancyId", "personId"] } }), "Updated title, tenant");
  assert.equal(eventSummary({ ...event, type: "chargeback_set", details: { ledgerTransactionId: null } }), "Chargeback intent recorded");
  assert.equal(eventSummary({ ...event, type: "chargeback_set", details: { ledgerTransactionId: "c1" } }), "Chargeback linked to a posted tenant charge");
  assert.equal(operatingToday(new Date("2026-09-23T02:00:00Z")), "2026-09-22");
});

test("an uncertain save reuses its envelope until the server answers", () => {
  const pending = new PendingEnvelopes<{ operationId: string }>();
  let created = 0;
  const key = PendingEnvelopes.key("work_order.note.add", { note: "x" }, 3);
  const first = pending.envelopeFor(key, () => ({ operationId: `op-${++created}` }));
  assert.equal(pending.envelopeFor(key, () => ({ operationId: `op-${++created}` })), first);
  pending.settle(key);
  assert.notEqual(pending.envelopeFor(key, () => ({ operationId: `op-${++created}` })), first);
  assert.notEqual(PendingEnvelopes.key("work_order.note.add", { note: "x" }, 4), key);
});
