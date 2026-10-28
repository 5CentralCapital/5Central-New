import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WORKER_CYCLE_MS, workerAliveWindowMs, workerCycleMs } from "./worker-cycle";

test("worker cycle defaults to 30 minutes, accepts 0 to poll continuously, and rejects out-of-range values", () => {
  assert.equal(workerCycleMs({}), DEFAULT_WORKER_CYCLE_MS);
  assert.equal(workerCycleMs({ WORKER_CYCLE_MS: "0" }), 0);
  assert.equal(workerCycleMs({ WORKER_CYCLE_MS: "3600000" }), 3_600_000);
  assert.equal(workerCycleMs({ WORKER_CYCLE_MS: "5" }), DEFAULT_WORKER_CYCLE_MS);
  assert.equal(workerCycleMs({ WORKER_CYCLE_MS: "nope" }), DEFAULT_WORKER_CYCLE_MS);
});

test("a sleeping worker still counts as alive between bursts", () => {
  assert.equal(workerAliveWindowMs({}), 2 * DEFAULT_WORKER_CYCLE_MS + 60_000);
  assert.equal(workerAliveWindowMs({ WORKER_CYCLE_MS: "0" }), 2 * 60_000);
});
