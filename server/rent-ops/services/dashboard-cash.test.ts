import assert from "node:assert/strict";
import test from "node:test";
import { readDashboardCash } from "./dashboard-cash";

const env = { PLAID_CLIENT_ID: "test-client", PLAID_SECRET: "test-secret", PLAID_ACCESS_TOKENS: "test-token", PLAID_ENV: "production" };
const account = (mask: string, current: number | null, available: number | null) => ({ account_id: `private-${mask}`, name: "Operating", mask, type: "depository", balances: { current, available, iso_currency_code: "USD" } });
test("cash response exposes only the selected real cash account and never credentials or other balances", async () => {
  const result = await readDashboardCash(env, (async () => new Response(JSON.stringify({ accounts: [account("5312", 990000, 880000), account("7772", 123.45, null)] }))) as typeof fetch);
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.equal(result.currentCents, 12345);
  assert.equal(result.availableCents, null);
  assert.equal(result.mask, "7772");
  assert.ok(!/test-token|test-secret|private-|5312|990000/.test(JSON.stringify(result)));
});
test("unconfigured, sandbox, ambiguous or failed bank reads never become zero cash", async () => {
  const unused = (async () => { throw new Error("must not call"); }) as typeof fetch;
  assert.deepEqual(await readDashboardCash({}, unused), { state: "unconfigured" });
  assert.deepEqual(await readDashboardCash({ ...env, PLAID_ENV: "sandbox" }, unused), { state: "unconfigured" });
  assert.deepEqual(await readDashboardCash(env, (async () => new Response("{}", { status: 500 })) as typeof fetch), { state: "unavailable" });
  assert.deepEqual(await readDashboardCash(env, (async () => new Response(JSON.stringify({ accounts: [account("7772", 1, 1), { ...account("7772", 2, 2), account_id: "second" }] }))) as typeof fetch), { state: "unavailable" });
});
