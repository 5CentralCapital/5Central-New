import assert from "node:assert/strict";
import test from "node:test";
import { runQboCatchUp, type QboCheckpointStore, type QboSyncCheckpoint } from "./sync";

const scope = { organizationId: "10000000-0000-4000-8000-000000000001", legalEntityId: "20000000-0000-4000-8000-000000000001", environment: "sandbox" as const, realmId: "123456" };

test("catch-up leaves the prior checkpoint when applying a fetched page fails", async () => {
  const before: QboSyncCheckpoint = { scope, stream: "transactions.purchase", watermark: "2026-09-20T00:00:00Z", cursor: "1", version: 4, updatedAt: "2026-09-20T00:00:00.000Z" };
  let saveCalled = false;
  const checkpoints: QboCheckpointStore = {
    async load() { return before; },
    async save() { saveCalled = true; return before; },
  };
  const result = await runQboCatchUp({
    executor: {
      query: async () => ({ rows: [] }),
      transaction: async work => work({ query: async () => ({ rows: [] }) }),
    },
    checkpointStore: checkpoints,
    scope,
    stream: "transactions.purchase",
    fetchPage: async () => ({ items: [{ id: "1" }], nextCursor: null, watermark: "2026-09-21T00:00:00Z" }),
    applyPage: async () => { throw new Error("synthetic apply failure"); },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.checkpoint, before);
  assert.equal(result.itemsApplied, 0);
  assert.equal(saveCalled, false);
});
