import assert from "node:assert/strict";
import test from "node:test";
import { shouldInvalidateAccountingQuery, waitForAccountingRefresh } from "./refresh";

test("accounting refresh leaves native ledger snapshots and their cursors bound to one run", () => {
  assert.equal(shouldInvalidateAccountingQuery(["accounting", "general-ledger"]), false);
  assert.equal(shouldInvalidateAccountingQuery(["accounting", "general-ledger-page"]), false);
  assert.equal(shouldInvalidateAccountingQuery(["accounting", "financial-dashboard"]), true);
  assert.equal(shouldInvalidateAccountingQuery(["accounting", "transactions"]), true);
  assert.equal(shouldInvalidateAccountingQuery(["accounting", "payables"]), true);
});

test("accounting refresh polling invalidates only after success and is bounded", async () => {
  const states = ["queued", "running", "succeeded"] as const;
  let index = 0;
  const outcome = await waitForAccountingRefresh(() => Promise.resolve({ state: states[index++] ?? "succeeded" }), { intervalMs: 10, timeoutMs: 30, sleep: async () => undefined });
  assert.equal(outcome, "succeeded");
  assert.equal(index, 3);

  let polls = 0;
  const timedOut = await waitForAccountingRefresh(() => { polls += 1; return Promise.resolve({ state: "running" as const }); }, { intervalMs: 10, timeoutMs: 25, sleep: async () => undefined });
  assert.equal(timedOut, "timed_out");
  assert.equal(polls, 4);
});
