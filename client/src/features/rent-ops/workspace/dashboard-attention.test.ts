import test from "node:test";
import assert from "node:assert/strict";
import { balanceAttention, moveAttention, rentalAttentionItems, vacancyAttention } from "./dashboard-attention";

test("balances lead with the known total and the oldest unpaid account", () => {
  const item = balanceAttention([
    { operationalBalanceCents: 563900, oldestUnpaidRentOn: "2026-06-01", tenantName: "jadore brown", propertyName: "Grove", unitNumber: "613" },
    { operationalBalanceCents: 263000, oldestUnpaidRentOn: "2026-08-01", tenantName: "Kenneth L", propertyName: "Cove", unitNumber: "Lot 1" },
    { operationalBalanceCents: null },
  ], "2026-09-24")!;
  assert.equal(item.title, "2 tenants owe $8,269.00");
  assert.equal(item.detail, "Oldest unpaid Jun 1 · Jadore Brown, Grove · 613, $5,639.00 · 1 more not verified");
  assert.equal(item.tone, "critical");
});

test("unknown balances are never counted as money owed", () => {
  const item = balanceAttention([{ operationalBalanceCents: null }, { operationalBalanceCents: undefined }], "2026-09-24")!;
  assert.equal(item.title, "2 balances not verified");
  assert.equal(item.tone, "neutral");
  assert.equal(balanceAttention([], "2026-09-24"), undefined);
});

test("vacancy names long-vacant units and the longest one", () => {
  const item = vacancyAttention([
    { occupancy: "vacant", daysVacant: 218, propertyName: "Lucia", unitNumber: "669 - 7" },
    { occupancy: "vacant", daysVacant: 25, propertyName: "Hickory", unitNumber: "619" },
    { occupancy: "vacant", daysVacant: null, propertyName: "Lucia", unitNumber: "672" },
    { occupancy: "future_preleased", daysVacant: 400 },
  ])!;
  assert.equal(item.title, "1 of 3 vacant units empty 90+ days");
  assert.equal(item.detail, "Longest: Lucia · 669 - 7, 218 days");
});

test("moves list upcoming move-outs by their last date", () => {
  const item = moveAttention([
    { movement: "Move out", state: "Expected", date: "2026-09-24", unitNumber: "615" },
    { movement: "Move out", state: "Expected", date: "2026-09-30", unitNumber: "669 - 1" },
    { movement: "Move in", state: "Completed", date: "2026-09-01", unitNumber: "C4" },
  ], "2026-09-24")!;
  assert.equal(item.title, "2 move-outs by Sep 30");
  assert.equal(item.detail, "615 today · 669 - 1 on Sep 30");
});

test("items are ranked money, vacancy, moves", () => {
  const items = rentalAttentionItems({ asOfDate: "2026-09-24", dueRows: [{ operationalBalanceCents: 100 }], vacancy: [{ occupancy: "vacant", daysVacant: 5 }], movements: [{ movement: "Move in", state: "Planned", date: "2026-09-28" }] });
  assert.deepEqual(items.map(item => item.key), ["balances", "vacancy", "moves"]);
});
