import assert from "node:assert/strict";
import test from "node:test";
import { emptyRentOpsSnapshot, type RentOpsLedgerTransaction, type RentOpsFilters } from "../../../shared/rent-ops-contracts";
import { deriveAccountBalances } from "./account-balances";
import { deriveManagerAccountLedger, readAccountBalanceAllocations } from "./reports";

function fixture() {
  const s = emptyRentOpsSnapshot();
  for (const id of ["a", "b"]) {
    s.properties.push({ id, name: id, slug: id, address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: id === "a" ? "active" : "inactive" });
    s.units.push({ id: `u-${id}`, propertyId: id, unitNumber: "1", readiness: "ready", listing: "listed" });
  }
  s.people.push({ id: "alice", firstName: "Alice", lastName: "A" }, { id: "bob", firstName: "Bob", lastName: "B" });
  s.tenancies.push({ id: "old", primaryPersonId: "alice", propertyId: "a", unitId: "u-a", status: "past", actualMoveInOn: "2025-01-01", actualMoveOutOn: "2026-01-01", createdAt: "2025-01-01T00:00:00Z" },
    { id: "new", primaryPersonId: "alice", propertyId: "b", unitId: "u-b", status: "current", actualMoveInOn: "2026-01-01", createdAt: "2026-01-01T00:00:00Z" },
    { id: "bob-lease", primaryPersonId: "bob", propertyId: "a", unitId: "u-a", status: "current", actualMoveInOn: "2026-01-01", createdAt: "2026-01-01T00:00:00Z" });
  return s;
}
function tx(id: string, tenancyId: string, propertyId: string | null, personId: string, amountCents: number, kind: RentOpsLedgerTransaction["kind"] = "charge"): RentOpsLedgerTransaction {
  return { id, tenancyId, propertyId, personId, amountCents, kind, category: "base_rent", status: "posted", postedOn: "2026-08-01", dueOn: "2026-08-01", description: id };
}
const report = (s: ReturnType<typeof fixture>, filters: RentOpsFilters = {}) => deriveAccountBalances(s, { asOfDate: "2026-08-16", tenantStatus: "all", ...filters }, deriveManagerAccountLedger, readAccountBalanceAllocations);

test("historical property debt stays with its account and multiple leases do not repeat account totals", () => {
  const s = fixture();
  s.tenancies.push({ ...s.tenancies[0], id: "older", actualMoveOutOn: "2025-01-01" });
  s.ledgerTransactions.push(tx("old-debt", "old", "a", "alice", 10000), tx("new-debt", "new", "b", "alice", 20000), tx("bob-credit", "bob-lease", "a", "bob", 40000, "credit"));
  const rows = report(s);
  assert.equal(rows.length, 3);
  const aliceA = rows.find(r => r.personId === "alice" && r.propertyId === "a")!;
  assert.equal(aliceA.totalBalanceCents, 10000);
  assert.equal(aliceA.tenancyId, null);
  assert.equal(aliceA.tenancyStatus, "former");
  assert.equal(rows.find(r => r.personId === "alice" && r.propertyId === "b")!.totalBalanceCents, 20000);
  assert.equal(rows.find(r => r.personId === "bob")!.creditBalanceCents, 40000);
  assert.equal(report(s, { balanceStatus: "due" }).length, 2);
  assert.equal(report(s, { balanceStatus: "credit" }).length, 1);
  assert.equal(report(s, { propertyIds: ["b"] }).length, 1);
  assert.equal(report(s, { propertyScope: "active" }).length, 2);
});

test("unknown category preserves known total and unknown property is never split over leases", () => {
  const s = fixture();
  s.ledgerTransactions.push({ ...tx("uncategorized", "old", "a", "alice", 12300), category: null });
  let rows = report(s);
  const row = rows.find(r => r.personId === "alice" && r.propertyId === "a")!;
  assert.equal(row.totalBalanceCents, 12300);
  assert.equal(row.rentOnlyBalanceCents, null);
  assert.equal(row.balanceComplete, true);
  // Exercise account projection's unresolved-property grouping independently of
  // artifact admission, which is validated by the ledger reader's own tests.
  rows = deriveAccountBalances(s, { asOfDate: "2026-08-16", tenantStatus: "all" }, (_s, personId) => personId === "alice" ? [{ transaction: { ...tx("unassigned", "", null, "alice", 7000), tenancyId: null }, allocatedCents: 0, openCents: 7000, runningBalanceCents: 7000, balanceComplete: true }] : []);
  assert.equal(rows.find(r => r.personId === "alice" && r.propertyId === null)!.totalBalanceCents, 7000);
  assert.equal(rows.filter(r => r.personId === "alice").reduce((sum, r) => sum + r.totalBalanceCents!, 0), 7000);
});

test("as-of status uses occupancy dates and never treats unknown status as current", () => {
  const s = fixture();
  assert.equal(report(s, { asOfDate: "2025-08-16" }).find(r => r.personId === "alice" && r.propertyId === "a")!.tenancyStatus, "current");
  s.tenancies[1] = { ...s.tenancies[1], status: "future", actualMoveInOn: undefined, plannedMoveInOn: "2026-09-01" };
  assert.equal(report(s, { tenantStatus: "future" }).length, 1);
  s.tenancies[1] = { ...s.tenancies[1], statusKnowledge: "unknown" };
  assert.equal(report(s, { tenantStatus: "unknown" }).length, 1);
  s.people[0].sourceAccountFacts = { status: "past", statusKnowledge: "source", rawStatus: "past", observedOn: "2026-08-01", artifactSha256: "a".repeat(64), postingStartOn: null, postingEndOn: null, postingStartKnowledge: "unknown", postingEndKnowledge: "unknown" };
  assert.equal(report(s, { tenantStatus: "former" }).filter(r => r.personId === "alice").length, 2);
});

test("unverified account evidence is not shown as zero or due", () => {
  const s = fixture();
  const read = () => [{ transaction: tx("bad", "old", "a", "alice", 10), allocatedCents: null, openCents: null, runningBalanceCents: null, balanceComplete: false, balanceUncertaintyCodes: ["account_ledger_link_unknown"] }];
  const rows = deriveAccountBalances(s, { tenantStatus: "all", balanceStatus: "unverified" }, read);
  assert.ok(rows.length);
  assert.ok(rows.every(r => r.totalBalanceCents === null));
  assert.equal(deriveAccountBalances(s, { tenantStatus: "all", balanceStatus: "zero" }, read).length, 0);
});

test("shared receipt applications lower only the named resident and property", () => {
  const s = fixture();
  s.ledgerTransactions.push(tx("alice-charge", "old", "a", "alice", 10000), tx("bob-charge", "bob-lease", "a", "bob", 20000),
    { ...tx("shared-receipt", "", null, "agency", 50000, "payment"), tenancyId: null, personId: null, payer: "agency", allocationMode: "multi_property" });
  s.paymentAllocations.push({ id: "alice-application", paymentTransactionId: "shared-receipt", chargeTransactionId: "alice-charge", allocatedOn: "2026-08-02", amountCents: 6000 },
    { id: "bob-application", paymentTransactionId: "shared-receipt", chargeTransactionId: "bob-charge", allocatedOn: "2026-08-02", amountCents: 7000 });
  const rows = report(s);
  const alice = rows.find(r => r.personId === "alice" && r.propertyId === "a")!;
  const bob = rows.find(r => r.personId === "bob")!;
  assert.equal(alice.totalBalanceCents, 4000);
  assert.equal(alice.rentOnlyBalanceCents, 4000);
  assert.equal(bob.totalBalanceCents, 13000);
  assert.equal(alice.unappliedCashCents, 0);
  assert.equal(bob.unappliedCashCents, 0);
});

test("an imported account without admitted history remains unverified", () => {
  const s = fixture();
  s.people[0].source = { system: "rent_manager", entityType: "person", sourceId: "123" };
  s.tenancies = s.tenancies.filter(t => t.primaryPersonId !== "alice");
  const row = report(s).find(r => r.personId === "alice")!;
  assert.equal(row.propertyId, null);
  assert.equal(row.totalBalanceCents, null);
  assert.equal(row.balanceComplete, false);
  assert.ok(row.balanceUncertaintyCodes?.includes("imported_account_history_unverified"));
});

for (const kind of ["payment", "credit"] as const) test(`cross-property ${kind} applications follow charges, conserve cents, and reverse`, () => {
  const s = fixture();
  const parent = tx("parent", "old", "a", "alice", 25000, kind);
  s.ledgerTransactions.push(tx("charge-a", "old", "a", "alice", 10000), tx("charge-b", "new", "b", "alice", 10000), parent);
  for (const property of ["a", "b"]) s.paymentAllocations.push({ id: `allocation-${property}`, kind: kind === "credit" ? "credit_allocation" : "allocation", paymentTransactionId: kind === "payment" ? "parent" : null, creditTransactionId: kind === "credit" ? "parent" : null, chargeTransactionId: `charge-${property}`, creditLinkKnowledge: "exact", chargeLinkKnowledge: "exact", amountCents: 10000, allocatedOn: "2026-08-02" });
  let rows = report(s).filter(r => r.personId === "alice");
  assert.equal(rows.find(r => r.propertyId === "a")!.totalBalanceCents, -5000);
  assert.equal(rows.find(r => r.propertyId === "b")!.totalBalanceCents, 0);
  assert.equal(rows.reduce((sum, r) => sum + r.totalBalanceCents!, 0), -5000);
  assert.equal(rows.find(r => r.propertyId === "b")!.rentOnlyBalanceCents, 0);
  // An application made later cannot rewrite the earlier balance.
  rows = report(s, { asOfDate: "2026-08-01" }).filter(r => r.personId === "alice");
  assert.equal(rows.find(r => r.propertyId === "b")!.totalBalanceCents, 10000);
  // Returning the source restores both properties' own debt.
  s.ledgerTransactions.push({ ...parent, id: "returned-parent", kind: "reversal", reversalOfId: "parent", postedOn: "2026-08-03" });
  rows = report(s).filter(r => r.personId === "alice");
  assert.deepEqual(rows.map(r => r.totalBalanceCents), [10000, 10000]);
  assert.equal(rows.reduce((sum, r) => sum + r.totalBalanceCents!, 0), 20000);
});

test("unit filter selects exact transaction unit within the same account and property", () => {
  const s = fixture();
  s.units.push({ ...s.units[0], id: "u-a2", unitNumber: "2" });
  s.tenancies[1] = { ...s.tenancies[1], propertyId: "a", unitId: "u-a2" };
  s.ledgerTransactions.push(tx("first-unit", "old", "a", "alice", 10000), tx("second-unit", "new", "a", "alice", 30000));
  const first = report(s, { personId: "alice", unitId: "u-a" });
  const second = report(s, { personId: "alice", unitId: "u-a2" });
  assert.equal(first.length, 1); assert.equal(second.length, 1);
  assert.equal(first[0].totalBalanceCents, 10000); assert.equal(second[0].totalBalanceCents, 30000);
  assert.equal(first[0].tenancyId, "old"); assert.equal(second[0].tenancyId, "new");
});

test("new confirmed occupancy supersedes old future observation and transfer preserves former property", () => {
  const s = fixture();
  s.people[0].sourceAccountFacts = { status: "future", statusKnowledge: "source", rawStatus: "future", observedOn: "2025-12-01", artifactSha256: "a".repeat(64), postingStartOn: null, postingEndOn: null, postingStartKnowledge: "unknown", postingEndKnowledge: "unknown" };
  const rows = report(s).filter(r => r.personId === "alice");
  assert.equal(rows.find(r => r.propertyId === "a")!.tenancyStatus, "former");
  assert.equal(rows.find(r => r.propertyId === "b")!.tenancyStatus, "current");
  s.people[0].sourceAccountFacts.status = "current";
  s.people[0].sourceAccountFacts.observedOn = "2026-07-01";
  assert.equal(report(s).find(r => r.personId === "alice" && r.propertyId === "a")!.tenancyStatus, "former");
});

test("partial application of an unassigned root moves only its applied cents to the charge property", () => {
  const s = fixture();
  s.people[0].source = { system: "rent_manager", entityType: "person", sourceId: "123" };
  s.ledgerTransactions.push(tx("partial-charge", "old", "a", "alice", 10000),
    { ...tx("unassigned-root", "", null, "alice", 15000, "payment"), tenancyId: null, personLinkKnowledge: "exact", source: { system: "rent_manager", entityType: "ledger_transaction", sourceId: "receipt:123" }, sourceArtifactSha256: "a".repeat(64) });
  s.paymentAllocations.push({ id: "partial", paymentTransactionId: "unassigned-root", chargeTransactionId: "partial-charge", amountCents: 6000, allocatedOn: "2026-08-02" });
  const rows = report(s).filter(r => r.personId === "alice");
  assert.equal(rows.find(r => r.propertyId === "a")!.totalBalanceCents, 4000);
  assert.equal(rows.find(r => r.propertyId === null)!.totalBalanceCents, -9000);
  assert.equal(rows.find(r => r.propertyId === null)!.unappliedCashCents, 9000);
  assert.equal(rows.reduce((sum, r) => sum + r.totalBalanceCents!, 0), -5000);
});
