import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

// The component imports its stylesheet; stub .css so node can load the module under test.
register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`);
const banking = import("./rm-banking");

test("bank connections show the bank's name, never a Plaid placeholder", async () => {
  const { bankConnectionLabel } = await banking;
  assert.equal(bankConnectionLabel("Example Community Bank"), "Example Community Bank");
  assert.equal(bankConnectionLabel("Connection 1"), "Bank connection");
  assert.equal(bankConnectionLabel("  "), "Bank connection");
  assert.equal(bankConnectionLabel("Connection 2", 1, 2), "Bank connection 2");
});

test("accounts sort by current balance, largest first, with unknown balances last", async () => {
  const { sortAccountsByBalance } = await banking;
  const sorted = sortAccountsByBalance([
    { id: "zero", currentCents: 0 },
    { id: "unknown", currentCents: null },
    { id: "operating", currentCents: 1_250_000 },
    { id: "reserve", currentCents: 40_000 },
  ]);
  assert.deepEqual(sorted.map(account => account.id), ["operating", "reserve", "zero", "unknown"]);
});
