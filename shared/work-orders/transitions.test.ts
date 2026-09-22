import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ORDER_STATUSES,
  WORK_ORDER_TRANSITIONS,
  allowedWorkOrderTransitions,
  isOpenWorkOrderStatus,
  workOrderTransitionProblem,
  workOrderTransitionRequiresNote,
} from "./transitions";
import {
  changeWorkOrderStatusPayloadSchema,
  createWorkOrderPayloadSchema,
  setWorkOrderChargebackPayloadSchema,
  updateWorkOrderPayloadSchema,
  workOrderReference,
} from "./contracts";

const base = { reportedOn: "2026-09-01" };
const id = "a6966c22-1234-4abc-8def-0123456789ab";

test("every status has a defined, non-reflexive transition list", () => {
  for (const status of WORK_ORDER_STATUSES) {
    assert.ok(Array.isArray(WORK_ORDER_TRANSITIONS[status]));
    assert.ok(!WORK_ORDER_TRANSITIONS[status].includes(status));
  }
  assert.deepEqual(allowedWorkOrderTransitions("completed"), ["in_progress"]);
  assert.deepEqual(allowedWorkOrderTransitions("canceled"), ["new"]);
  assert.equal(isOpenWorkOrderStatus("on_hold"), true);
  assert.equal(isOpenWorkOrderStatus("completed"), false);
});

test("normal lifecycle is allowed without notes", () => {
  assert.equal(workOrderTransitionProblem({ ...base, from: "new", to: "scheduled", scheduledOn: "2026-09-03" }), null);
  assert.equal(workOrderTransitionProblem({ ...base, from: "scheduled", to: "in_progress", scheduledOn: "2026-09-03" }), null);
  assert.equal(workOrderTransitionProblem({ ...base, from: "in_progress", to: "completed", completedOn: "2026-09-04" }), null);
});

test("holds, cancellations and reopening require a note", () => {
  assert.equal(workOrderTransitionRequiresNote("in_progress", "on_hold"), true);
  assert.equal(workOrderTransitionProblem({ ...base, from: "in_progress", to: "on_hold" }), "note_required");
  assert.equal(workOrderTransitionProblem({ ...base, from: "in_progress", to: "on_hold", note: "  " }), "note_required");
  assert.equal(workOrderTransitionProblem({ ...base, from: "in_progress", to: "on_hold", note: "Waiting on parts" }), null);
  assert.equal(workOrderTransitionProblem({ ...base, from: "new", to: "canceled" }), "note_required");
  assert.equal(workOrderTransitionProblem({ ...base, from: "completed", to: "in_progress" }), "note_required");
  assert.equal(workOrderTransitionProblem({ ...base, from: "canceled", to: "new", note: "Tenant reported again" }), null);
});

test("invalid transitions, missing schedule dates and early completion are rejected", () => {
  assert.equal(workOrderTransitionProblem({ ...base, from: "new", to: "new" }), "same_status");
  assert.equal(workOrderTransitionProblem({ ...base, from: "completed", to: "canceled", note: "x" }), "transition_not_allowed");
  assert.equal(workOrderTransitionProblem({ ...base, from: "canceled", to: "completed", note: "x" }), "transition_not_allowed");
  assert.equal(workOrderTransitionProblem({ ...base, from: "new", to: "scheduled" }), "scheduled_date_required");
  assert.equal(workOrderTransitionProblem({ ...base, from: "new", to: "completed", completedOn: "2026-08-31" }), "completed_date_before_reported");
});

test("payload contracts validate categories, money and required fields", () => {
  const created = createWorkOrderPayloadSchema.parse({ propertyId: "demo-property-a", title: "  Leak  ", description: "" });
  assert.equal(created.title, "Leak");
  assert.equal(created.description, null);
  assert.equal(created.category, "general");
  assert.equal(created.priority, "normal");
  assert.equal(created.status, "new");
  assert.equal(created.entryPermitted, false);
  assert.throws(() => createWorkOrderPayloadSchema.parse({ propertyId: "p", title: "x", category: "roofing" }));
  assert.throws(() => createWorkOrderPayloadSchema.parse({ propertyId: "p", title: "x", estimatedCostCents: 12.5 }));
  assert.throws(() => createWorkOrderPayloadSchema.parse({ propertyId: "p", title: "x", estimatedCostCents: "-1" }));
  assert.throws(() => createWorkOrderPayloadSchema.parse({ propertyId: "p", title: "x", status: "scheduled" }), /scheduledOn/);
  assert.throws(() => createWorkOrderPayloadSchema.parse({ propertyId: "p", title: "" }));
  assert.throws(() => updateWorkOrderPayloadSchema.parse({ workOrderId: id }), /At least one/);
  assert.throws(() => updateWorkOrderPayloadSchema.parse({ workOrderId: id, status: "completed" }), /Unrecognized/);
  assert.throws(() => changeWorkOrderStatusPayloadSchema.parse({ workOrderId: id, status: "done" }));
  assert.throws(() => setWorkOrderChargebackPayloadSchema.parse({ workOrderId: id, amountCents: "0", description: "x" }));
  assert.equal(setWorkOrderChargebackPayloadSchema.parse({ workOrderId: id, amountCents: "9223372036854775807", description: "x" }).amountCents, "9223372036854775807");
  assert.equal(workOrderReference(id), "WO-A6966C22");
});
