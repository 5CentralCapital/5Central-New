import assert from "node:assert/strict";
import test from "node:test";
import { readBanking, createBankingReader } from "./banking-read";
import { bankingSnapshotSchema } from "../../../shared/rent-ops-banking";
const env = { PLAID_ENV: "production", PLAID_CLIENT_ID: "SECRET_CLIENT", PLAID_SECRET: "SECRET_KEY", PLAID_ACCESS_TOKENS: "SECRET_TOKEN" };
const account = { account_id: "PRIVATE_ACCOUNT", name: "Operating", mask: "7772", type: "depository", balances: { current: 123.45, available: null, iso_currency_code: "USD" } };
const transaction = { transaction_id: "PRIVATE_TX", account_id: "PRIVATE_ACCOUNT", date: "2026-09-10", name: "Deposit", amount: -50.25, iso_currency_code: "USD", pending: false };
const now = new Date("2026-09-12T12:00:00Z");
test("banking is production-only, strips raw fields, keeps bank signs and nullable money", async () => {
 const noCall = (async () => { throw new Error("unexpected request"); }) as typeof fetch;
 assert.equal((await readBanking({}, noCall, now)).state, "unconfigured");
 assert.equal((await readBanking({ ...env, PLAID_ENV: "sandbox" }, noCall, now)).state, "unconfigured");
 const calls: string[] = [];
 const data = await readBanking(env, (async (url, init) => { calls.push(String(url)); const body = JSON.parse(String(init?.body)); assert.equal(body.access_token, "SECRET_TOKEN"); return new Response(JSON.stringify(String(url).endsWith("balance/get") ? { accounts: [account], access_token: "SECRET_UPSTREAM" } : { accounts: [account], transactions: [transaction, { ...transaction, transaction_id: "second", amount: 23, pending: true }], total_transactions: 2 })); }) as typeof fetch, now);
 assert.equal(data.state, "ready"); assert.ok(bankingSnapshotSchema.safeParse(data).success);
 assert.equal(data.fromDate, "2026-08-14"); assert.equal(data.connections[0].accounts[0].currentCents, 12345); assert.equal(data.connections[0].accounts[0].availableCents, null);
 assert.equal(data.connections[0].transactions[0].amountCents, -5025); assert.equal(data.connections[0].transactions[1].pending, true);
 assert.ok(!/SECRET|PRIVATE_ACCOUNT|PRIVATE_TX/.test(JSON.stringify(data))); assert.equal(calls.length, 2);
});
test("partial connection failures remain visible and never fabricate zero balances", async () => {
 const data = await readBanking({ ...env, PLAID_ACCESS_TOKENS: "good,bad" }, (async (url, init) => {
  const body = JSON.parse(String(init?.body)); if (body.access_token === "bad" || String(url).endsWith("balance/get")) return new Response("SECRET_UPSTREAM", { status: 500 });
  return new Response(JSON.stringify({ accounts: [account], transactions: [transaction], total_transactions: 1 }));
 }) as typeof fetch, now);
 assert.equal(data.state, "partial"); assert.equal(data.connections.length, 2); assert.equal(data.connections[0].balancesState, "unavailable"); assert.equal(data.connections[0].transactionsState, "ready"); assert.equal(data.connections[0].accounts[0].currentCents, null); assert.equal(data.connections[1].transactionsState, "unavailable");
});
test("transaction pagination is bounded, validates amounts, and labels incomplete results", async () => {
 let txCalls = 0;
 const data = await readBanking(env, (async url => { if (String(url).endsWith("balance/get")) return new Response(JSON.stringify({ accounts: [account] })); txCalls++; return new Response(JSON.stringify({ accounts: [account], transactions: [{ ...transaction, transaction_id: `tx-${txCalls}`, amount: 1e100 }], total_transactions: 100 })); }) as typeof fetch, now);
 assert.equal(txCalls, 10); assert.equal(data.state, "partial"); assert.equal(data.connections[0].transactionsState, "partial"); assert.equal(data.connections[0].transactions[0].amountCents, null);
});
test("cache coalesces concurrent reads and manual refresh cannot exceed five-minute minimum", async () => {
 let reads = 0; let time = 0;
 const read = createBankingReader(async () => { reads++; return readBanking({}, undefined, now); }, () => time);
 const results = await Promise.all([read(), read(), read()]); assert.equal(reads, 1); assert.deepEqual(results[0], results[1]);
 time = 299_999; await read(); assert.equal(reads, 1); time = 300_000; await read(); assert.equal(reads, 2);
});
