import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingProjectCommandError, PendingProjectCommandStore } from "./pending-command";

test("a lost response retries the same operation envelope", async () => {
  const store = new PendingProjectCommandStore();
  const scope = { organizationId: "org-1", legalEntityId: "entity-1", propertyId: "property-1" } as never;
  const payload = { projectId: "project-1", name: "Kitchen" };
  const first = store.getOrCreate("project.update", scope, payload, 4);
  let calls = 0;
  let recordedBody = "";

  const mockFetch = async (envelope: typeof first): Promise<void> => {
    calls += 1;
    const body = JSON.stringify(envelope);
    if (calls === 1) {
      recordedBody = body;
      throw new TypeError("response lost");
    }
    assert.equal(body, recordedBody);
  };

  await assert.rejects(() => mockFetch(first));
  const retry = store.getOrCreate("project.update", scope, payload, 4);
  await mockFetch(retry);

  assert.equal(calls, 2);
  assert.equal(retry.operationId, first.operationId);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
});

test("an unresolved command blocks a changed payload until the original is resolved", () => {
  const store = new PendingProjectCommandStore();
  const scope = { organizationId: "org-1", legalEntityId: "entity-1", propertyId: "property-1" } as never;
  store.getOrCreate("project.update", scope, { projectId: "project-1", name: "Kitchen" }, 4);
  assert.throws(
    () => store.getOrCreate("project.update", scope, { projectId: "project-1", name: "Bath" }, 4),
    PendingProjectCommandError,
  );
});

test("execution commands keep one envelope for a retry", () => {
  const store = new PendingProjectCommandStore();
  const scope = { organizationId: "org-1", legalEntityId: "entity-1", propertyId: "property-1" } as never;
  const first = store.getOrCreate("project.assignment.update", scope, { assignmentId: "assignment-1", status: "accepted" }, 7);
  const retry = store.getOrCreate("project.assignment.update", scope, { assignmentId: "assignment-1", status: "accepted" }, 7);
  assert.equal(retry.operationId, first.operationId);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
});
