import assert from "node:assert/strict";
import test from "node:test";
import { toPropertyCard } from "./property-cards";
import { buildRentRoll, fetchRMPayments } from "./rentmanager";
import { syncPlaidItem } from "./plaid-sync";

test("property cards compute cap rate on current value and yield on cost on basis", () => {
  const card = toPropertyCard({ id: "p1", name: "Example", units: 10, noi: "100000", acquisitionPrice: "800000", rehabCosts: "200000", currentValue: "1250000", currentDebt: "600000" });
  assert.equal(card.yieldOnCost, 10);
  assert.equal(card.capRate, 8);
});

test("a failed Rent Manager payments read is an error, not zero payments", async () => {
  const original = globalThis.fetch;
  const previousToken = process.env.RM_API_TOKEN;
  process.env.RM_API_TOKEN = "synthetic-token";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/Payments")) return new Response("unavailable", { status: 503 });
    const body = url.includes("/Tenants") ? [{ TenantID: 7, FirstName: "Example", LastName: "Tenant", PropertyID: 30, Status: "Current" }]
      : url.includes("/Charges") ? [{ AccountID: 7, AccountType: "Customer", Amount: 1200, ChargeTypeID: 2, TransactionDate: "2026-09-01" }]
      : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await assert.rejects(() => fetchRMPayments({ tenantId: "7" }), /RM API error \(503/);
    // Without payments the rent roll would report the full charge as owed.
    await assert.rejects(() => buildRentRoll("30"), /RM API error \(503/);
  } finally {
    globalThis.fetch = original;
    if (previousToken === undefined) delete process.env.RM_API_TOKEN; else process.env.RM_API_TOKEN = previousToken;
  }
});

test("a failed Plaid sync keeps the last committed cursor instead of restarting from scratch", async () => {
  const saved: { cursor: string | null; error: string | null }[] = [];
  const deps = {
    client: {
      async accountsBalanceGet() { return { data: { accounts: [] } }; },
      async transactionsSync() { throw new Error("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"); },
    },
    upsertBankAccounts() {}, upsertTransactions() {}, removeTransactions() {},
    updatePlaidItemSync(_id: string, cursor: string | null, error: string | null) { saved.push({ cursor, error }); },
  };
  await syncPlaidItem({ id: "pi_1", access_token: "synthetic", institution_name: "Example Bank", cursor: "cursor-42" }, deps);
  assert.deepEqual(saved, [{ cursor: "cursor-42", error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }]);
});
