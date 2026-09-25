import assert from "node:assert/strict";
import test from "node:test";
import type { CompanyContext } from "@shared/company/context";
import {
  agingRows,
  appliedCents,
  coverageDisplay,
  customerLedgerRows,
  customerOptionLabel,
  filterCustomers,
  ledgerTotals,
  openItemRows,
  parseCustomerLedger,
  qboConnectionState,
  qboTargetForProperty,
  QBO_LEDGER_STALE_AFTER_MS,
  verificationDisplay,
} from "./customer-ledger";
import type { AccountingConnection, AccountingMirror } from "./types";

const NOW = new Date("2026-09-23T15:00:00Z");

function ledgerPayload(overrides: Record<string, unknown> = {}) {
  return {
    scope: { organizationId: "org-synthetic", legalEntityId: "entity-a", environment: "sandbox", realmId: "9130" },
    customer: { objectId: "58", displayName: "Synthetic Resident · 12 Oak B", active: true },
    asOf: null,
    entries: [
      { objectType: "Invoice", objectId: "101", version: "2", txnDate: "2026-08-01", dueDate: "2026-08-05", docNumber: "1001", kinds: ["charge"], amountCents: "150000", runningBalanceCents: "150000", openBalanceCents: "25000", postingState: "posted" },
      { objectType: "Payment", objectId: "201", version: "0", txnDate: "2026-08-03", dueDate: null, docNumber: null, kinds: ["payment"], amountCents: "-125000", runningBalanceCents: "25000", openBalanceCents: "0", postingState: "posted" },
      { objectType: "JournalEntry", objectId: "301", version: "1", txnDate: "2026-08-10", dueDate: null, docNumber: "JE-7", kinds: ["adjustment"], amountCents: "1", runningBalanceCents: "25001", openBalanceCents: null, postingState: "posted" },
    ],
    totals: { chargesCents: "150000", creditsCents: "0", paymentsCents: "-125000", adjustmentsCents: "1", endingBalanceCents: "25001" },
    openItems: [{ objectType: "Invoice", objectId: "101", docNumber: "1001", txnDate: "2026-08-01", dueDate: "2026-08-05", openBalanceCents: "25000", daysPastDue: 49 }],
    aging: { currentCents: "0", days1To30Cents: "0", days31To60Cents: "25000", days61To90Cents: "0", over90Cents: "0" },
    verification: { state: "verified", providerBalanceCents: "25001", computedBalanceCents: "25001", reason: null },
    coverage: { status: "complete", reasons: [], observedAt: "2026-09-23T14:30:00.000Z" },
    page: { total: 3, nextCursor: null },
    ...overrides,
  };
}

test("parses the server ledger and refuses inexact or malformed amounts", () => {
  const ledger = parseCustomerLedger(ledgerPayload());
  assert.equal(ledger.entries.length, 3);
  assert.equal(ledger.totals.endingBalanceCents, "25001");
  assert.throws(() => parseCustomerLedger(ledgerPayload({ totals: { chargesCents: 1500.5, creditsCents: "0", paymentsCents: "0", adjustmentsCents: "0", endingBalanceCents: "0" } })));
  assert.throws(() => parseCustomerLedger(ledgerPayload({ totals: { chargesCents: "15.00", creditsCents: "0", paymentsCents: "0", adjustmentsCents: "0", endingBalanceCents: "0" } })));
  assert.throws(() => parseCustomerLedger(ledgerPayload({ coverage: { status: "maybe", reasons: [], observedAt: null } })));
});

test("document rows carry exact running balances and applied amounts", () => {
  const rows = customerLedgerRows(parseCustomerLedger(ledgerPayload()).entries);
  assert.deepEqual(rows.map(row => [row.type, row.number, row.amount, row.applied, row.open, row.balance]), [
    ["Invoice", "1001", "$1,500.00", "$1,250.00", "$250.00", "$1,500.00"],
    ["Payment", "—", "−$1,250.00", "$1,250.00", "$0.00", "$250.00"],
    ["Journal entry", "JE-7", "$0.01", "—", "—", "$250.01"],
  ]);
  // Beyond double precision the digits survive untouched.
  assert.equal(appliedCents({ amountCents: "-9007199254740993" as never, openBalanceCents: "2" as never, postingState: "posted" }), "9007199254740991");
  assert.equal(appliedCents({ amountCents: "5000" as never, openBalanceCents: "0" as never, postingState: "voided" }), null);
});

test("coverage is explicit: complete, stale, partial and never-read", () => {
  const complete = coverageDisplay({ status: "complete", reasons: [], observedAt: "2026-09-23T14:30:00.000Z" }, NOW);
  assert.equal(complete.tone, "good");
  assert.equal(complete.amountsKnown, true);

  const staleAt = new Date(NOW.getTime() - QBO_LEDGER_STALE_AFTER_MS - 60_000).toISOString();
  const stale = coverageDisplay({ status: "complete", reasons: [], observedAt: staleAt }, NOW);
  assert.equal(stale.tone, "warning");
  assert.equal(stale.stale, true);
  assert.match(stale.reasons[0]!, /Newer QuickBooks activity may not be shown/);

  const partial = coverageDisplay({ status: "partial", reasons: ["receivables.payment: rate limited"], observedAt: "2026-09-23T14:30:00.000Z" }, NOW);
  assert.equal(partial.tone, "warning");
  assert.deepEqual(partial.reasons, ["receivables.payment: rate limited"]);

  const never = coverageDisplay({ status: "unavailable", reasons: [], observedAt: null }, NOW);
  assert.equal(never.tone, "error");
  assert.equal(never.amountsKnown, false);
  assert.equal(never.asOfLabel, "Never");
});

test("unread QuickBooks data shows Unknown, never $0.00", () => {
  const ledger = parseCustomerLedger(ledgerPayload({ entries: [], totals: { chargesCents: "0", creditsCents: "0", paymentsCents: "0", adjustmentsCents: "0", endingBalanceCents: "0" }, coverage: { status: "unavailable", reasons: [], observedAt: null } }));
  const known = coverageDisplay(ledger.coverage, NOW).amountsKnown;
  assert.ok(ledgerTotals(ledger, known).every(item => item.amount === "Unknown"));
  const full = parseCustomerLedger(ledgerPayload());
  assert.deepEqual(ledgerTotals(full, true).at(-1), { label: "Ending balance", amount: "$250.01" });
});

test("verification against QuickBooks Customer.Balance", () => {
  assert.deepEqual(verificationDisplay({ state: "verified", providerBalanceCents: "25001" as never, computedBalanceCents: "25001" as never, reason: null }), { tone: "good", label: "Matches QuickBooks", detail: "QuickBooks customer balance $250.01." });
  const mismatch = verificationDisplay({ state: "mismatch", providerBalanceCents: "30000" as never, computedBalanceCents: "25001" as never, reason: "Some activity is not mirrored" });
  assert.equal(mismatch.tone, "error");
  assert.match(mismatch.detail!, /QuickBooks reports \$300\.00; the mirrored history totals \$250\.01 \(difference \$49\.99\)/);
  assert.equal(verificationDisplay({ state: "unavailable", providerBalanceCents: null, computedBalanceCents: null, reason: "The QuickBooks customer has not been mirrored" }).label, "QuickBooks balance unavailable");
  assert.equal(verificationDisplay({ state: "unverified", providerBalanceCents: null, computedBalanceCents: "1" as never, reason: null }).detail, null);
});

test("open items and aging", () => {
  const ledger = parseCustomerLedger(ledgerPayload());
  assert.deepEqual(openItemRows(ledger.openItems).map(row => [row.type, row.number, row.open, row.pastDue]), [["Invoice", "1001", "$250.00", "49 days"]]);
  assert.equal(agingRows(ledger.aging)?.[2]?.amount, "$250.00");
  assert.equal(agingRows(null), null);
});

test("property resolves to its legal entity and linking needs a finance role", () => {
  const context: CompanyContext = { organizations: [
    { id: "org-1", name: "Synthetic Co", role: "read_only_reviewer", entities: [{ id: "entity-x", name: "X LLC", currency: "USD", properties: [{ id: "prop-x", name: "X", units: [] }] }] },
    { id: "org-2", name: "Other Co", role: "finance", entities: [{ id: "entity-y", name: "Y LLC", currency: "USD", properties: [{ id: "prop-y", name: "Y", units: [] }] }] },
  ] };
  assert.deepEqual(qboTargetForProperty(context, "prop-y"), { organizationId: "org-2", organizationName: "Other Co", legalEntityId: "entity-y", entityName: "Y LLC", canLink: true });
  assert.equal(qboTargetForProperty(context, "prop-x")?.canLink, false);
  assert.equal(qboTargetForProperty(context, "prop-missing"), null);
  assert.equal(qboTargetForProperty(undefined, "prop-x"), null);
});

test("connection state distinguishes not configured, not connected and reconnect", () => {
  const connection = (status: AccountingConnection["status"], environment: "sandbox" | "production" = "sandbox"): AccountingConnection => ({ scope: { organizationId: "org", legalEntityId: "entity", environment, realmId: "1" }, name: "Books", status, version: 1, accessTokenExpiresAt: "", refreshTokenExpiresAt: null, refreshTokenHardExpiresAt: null, updatedAt: "" });
  assert.deepEqual(qboConnectionState({ configured: false, environment: null }, []), { kind: "not-configured" });
  assert.deepEqual(qboConnectionState({ configured: true, environment: "sandbox" }, []), { kind: "not-connected" });
  assert.deepEqual(qboConnectionState({ configured: true, environment: "sandbox" }, [connection("ready", "production")]), { kind: "not-connected" });
  const ready = qboConnectionState({ configured: true, environment: "sandbox" }, [connection("ready")]);
  assert.equal(ready.kind === "ready" && ready.needsReconnect, false);
  const reconnect = qboConnectionState({ configured: true, environment: "sandbox" }, [connection("needs_reconnect")]);
  assert.equal(reconnect.kind === "ready" && reconnect.needsReconnect, true);
});

test("customer picker filters by name or exact QuickBooks id, active first", () => {
  const customer = (id: string, name: string, active = true): AccountingMirror => ({ kind: "customers", objectType: "Customer", providerObjectId: id, displayName: name, active, version: "0", providerUpdatedAt: null });
  const customers = [customer("7", "Alder Resident", false), customer("8", "Alder Resident 2"), customer("9", "Birch Resident")];
  assert.deepEqual(filterCustomers(customers, "alder").map(item => item.providerObjectId), ["8", "7"]);
  assert.deepEqual(filterCustomers(customers, "9").map(item => item.providerObjectId), ["9"]);
  assert.equal(filterCustomers(customers, "").length, 3);
  assert.equal(customerOptionLabel(customers[0]!), "Alder Resident · QuickBooks #7 (inactive)");
});
