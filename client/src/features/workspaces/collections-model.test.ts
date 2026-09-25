import assert from "node:assert/strict";
import test from "node:test";

import { balanceAge, balancesScopeSummary, groupBalances, rowScope, unverifiedReason } from "./collections-model";

const rows = [
  { tenantName: "Aliyana G.", tenancyStatus: "current", operationalBalanceCents: null, balanceUncertaintyCodes: ["balance_review_stale"] },
  { tenantName: "Elizabeth R.", tenancyStatus: "former", operationalBalanceCents: null },
  { tenantName: "Small", tenancyStatus: "current", operationalBalanceCents: 1000 },
  { tenantName: "Large", tenancyStatus: "current", operationalBalanceCents: 563900 },
  { tenantName: "Future", tenancyStatus: "future", operationalBalanceCents: 5000 },
  { tenantName: "Gone", tenancyStatus: "former", operationalBalanceCents: 20000 },
];

test("former tenants are split out; other statuses stay in the current view", () => {
  assert.equal(rowScope(rows[1]), "former");
  assert.equal(rowScope(rows[4]), "current");
  assert.equal(rowScope({ tenancyStatus: "unknown" }), "current");
});

test("known balances sort largest first and unknown balances form their own group", () => {
  const current = groupBalances(rows, "current");
  assert.deepEqual(current.known.map(row => row.tenantName), ["Large", "Future", "Small"]);
  assert.deepEqual(current.unverified.map(row => row.tenantName), ["Aliyana G."]);
  const former = groupBalances(rows, "former");
  assert.deepEqual(former.known.map(row => row.tenantName), ["Gone"]);
  assert.deepEqual(former.unverified.map(row => row.tenantName), ["Elizabeth R."]);
});

test("the heading keeps At least when any balance in scope is unknown, and never shows $0 for unknown", () => {
  assert.equal(balancesScopeSummary(groupBalances(rows, "current"), "current"), "current tenants · At least $5,699.00 across 4 accounts");
  const complete = groupBalances(rows.filter(row => row.operationalBalanceCents !== null), "current");
  assert.equal(balancesScopeSummary(complete, "current"), "current tenants · $5,699.00 across 3 accounts");
  const unknownOnly = groupBalances([rows[1]], "former");
  assert.equal(balancesScopeSummary(unknownOnly, "former"), "former tenants · 1 account not verified");
  assert.equal(balancesScopeSummary({ known: [], unverified: [] }, "current"), "current tenants · none");
});

test("unverified reason comes from uncertainty codes when present", () => {
  assert.equal(unverifiedReason(rows[0]), "Balance review stale");
  assert.equal(unverifiedReason(rows[1]), "Balance can't be confirmed until the ledger is reconciled");
});

test("balance age tones: warning from 30 days, error from 90", () => {
  assert.deepEqual(balanceAge("2026-06-01", "2026-09-24"), { days: 115, label: "115 days", tone: "error" });
  assert.equal(balanceAge("2026-08-20", "2026-09-24")?.tone, "warning");
  assert.deepEqual(balanceAge("2026-09-23", "2026-09-24"), { days: 1, label: "1 day", tone: "neutral" });
  assert.equal(balanceAge(undefined, "2026-09-24"), undefined);
});
