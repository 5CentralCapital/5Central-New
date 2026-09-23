import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { emptyRentOpsSnapshot, type DelinquencyRow, type RentRollRow } from "../../../shared/rent-ops-contracts";
import { classifyReviewCode, reviewLabelForCodes, reviewReason } from "../../../shared/review-cases";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { detectReviewCases, reviewCandidateKey } from "./review-detector";

const asOf = "2026-09-23";

function snapshotWithPeople(count: number) {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.properties = [
    { id: "p-a", name: "Synthetic A", slug: "synthetic-a" } as never,
    { id: "p-b", name: "Synthetic B", slug: "synthetic-b" } as never,
  ];
  snapshot.people = Array.from({ length: count }, (_, index) => ({ id: `person-${index}`, firstName: "Tenant", lastName: String(index) }) as never);
  return snapshot;
}

function delinquencyRow(personId: string, propertyId: string | null, codes: string[], extra: Partial<DelinquencyRow> = {}): DelinquencyRow {
  return {
    propertyId, propertyName: propertyId ?? "Unassigned account", tenancyId: null, personId, tenantName: personId,
    rentOnlyBalanceCents: null, nonRentBalanceCents: null, grossBalanceCents: null, totalBalanceCents: null, netAccountBalanceCents: null,
    unappliedCashCents: null, prepaidCents: null, hasPromiseOrHold: false, balanceComplete: codes.length === 0, balanceUncertaintyCodes: codes, ...extra,
  };
}

test("one missing import partition affecting 40 tenants is one case with 40 affected records", () => {
  const snapshot = snapshotWithPeople(40);
  const delinquency = snapshot.people.map((person, index) => delinquencyRow(person.id, index % 2 ? "p-a" : "p-b", ["imported_account_history_unverified"]));
  const candidates = detectReviewCases({ asOf, snapshot, reports: { rentRoll: [], delinquency, scheduledIncome: [], violations: [] } });
  const history = candidates.filter(candidate => candidate.reasonCode === "history_incomplete");
  assert.equal(history.length, 1);
  assert.equal(history[0]!.affectedCount, 40);
  assert.equal(history[0]!.affectedRecords.length, 40);
  assert.equal(history[0]!.scopeKey, "organization");
  assert.equal(history[0]!.causeKey, "imported_account_history_unverified");
  assert.equal(history[0]!.impactCents, null, "unknown impact is null, never zero");
  assert.equal(history[0]!.materiality, "high");
  assert.deepEqual(history[0]!.evidence, [{ code: "imported_account_history_unverified", count: 40, message: "imported account history unverified on 40 records" }]);
});

test("the same account observed by the rent roll and delinquency report is one case", () => {
  const snapshot = snapshotWithPeople(1);
  snapshot.units = [{ id: "u-1", propertyId: "p-a", unitNumber: "1A" } as never];
  snapshot.tenancies = [{ id: "t-1", propertyId: "p-a", unitId: "u-1", primaryPersonId: "person-0", status: "current" } as never];
  const rentRoll = [{ propertyId: "p-a", propertyName: "Synthetic A", unitId: "u-1", unitNumber: "1A", tenancyId: "t-1", currentPersonId: "person-0", occupancy: "current", readiness: "ready", listing: "unlisted", recurringFeesCents: 0, subsidyCents: 0, totalScheduledCents: null, balanceDueCents: null, exceptionCodes: ["lease_term_missing"], balanceUncertaintyCodes: ["ledger_amount_unknown", "ledger_date_unknown"] } as unknown as RentRollRow];
  const delinquency = [delinquencyRow("person-0", "p-a", ["ledger_amount_unknown"], { tenancyId: "t-1", unitId: "u-1" })];
  const candidates = detectReviewCases({ asOf, snapshot, reports: { rentRoll, delinquency, scheduledIncome: [], violations: [] } });
  const ledger = candidates.filter(candidate => candidate.reasonCode === "ledger_entry_incomplete");
  assert.equal(ledger.length, 1, "two codes of one reason on one account form one case");
  assert.equal(ledger[0]!.affectedCount, 1);
  assert.equal(ledger[0]!.scopeKey, "account:person-0@p-a");
  assert.deepEqual(ledger[0]!.codes, ["ledger_amount_unknown", "ledger_date_unknown"]);
  const lease = candidates.find(candidate => candidate.reasonCode === "lease_missing");
  assert.equal(lease?.scopeKey, "tenancy:t-1");
  assert.equal(lease?.scopeLabel, "Tenant 0 · Unit 1A · Synthetic A");
});

test("fingerprints are stable for identical input and change when affected records change", () => {
  const snapshot = snapshotWithPeople(3);
  const run = (people: number) => detectReviewCases({ asOf, snapshot, reports: {
    rentRoll: [], scheduledIncome: [], violations: [],
    delinquency: snapshot.people.slice(0, people).map(person => delinquencyRow(person.id, "p-a", ["imported_account_history_unverified"])),
  } });
  const first = run(2); const second = run(2); const third = run(3);
  assert.deepEqual(first, second);
  assert.equal(reviewCandidateKey(first[0]!), reviewCandidateKey(third[0]!));
  assert.notEqual(first[0]!.sourceFingerprint, third[0]!.sourceFingerprint);
  const later = detectReviewCases({ asOf: "2026-10-01", snapshot, reports: { rentRoll: [], scheduledIncome: [], violations: [], delinquency: snapshot.people.slice(0, 2).map(person => delinquencyRow(person.id, "p-a", ["imported_account_history_unverified"])) } });
  assert.equal(later[0]!.sourceFingerprint, first[0]!.sourceFingerprint, "the as-of date alone does not change the fingerprint");
});

test("impact is summed only when every amount is known; otherwise null", () => {
  const snapshot = snapshotWithPeople(0);
  const known = detectReviewCases({ asOf, snapshot, reports: { rentRoll: [], delinquency: [], scheduledIncome: [], violations: [] }, intake: { packets: [{
    id: "packet-1", fileName: "owner-packet.json", propertyId: "p-a", lines: [
      { sourceLineKey: "l1", outcome: "held_missing_identity", amountCents: "125000", currency: "USD", sourceAccountId: "acct-1" },
      { sourceLineKey: "l2", outcome: "held_ambiguous_identity", amountCents: "-2500", currency: "USD", sourceAccountId: "acct-2" },
      { sourceLineKey: "l3", outcome: "matched", amountCents: "999", currency: "USD", sourceAccountId: "acct-3" },
    ],
  }] } });
  const missing = known.find(candidate => candidate.causeKey === "intake_held_missing_identity");
  const ambiguous = known.find(candidate => candidate.causeKey === "intake_held_ambiguous_identity");
  assert.equal(missing?.impactCents, "125000");
  assert.equal(missing?.materiality, "high", "a known impact of $1,000 or more is high materiality");
  assert.equal(ambiguous?.impactCents, "2500");
  assert.equal(known.length, 2, "matched lines produce no case");
  const stale = detectReviewCases({ asOf, snapshot: snapshotWithPeople(2), reports: { rentRoll: [], scheduledIncome: [], violations: [], delinquency: [
    delinquencyRow("person-0", "p-a", ["balance_review_stale"], { totalBalanceCents: 50_000, balanceReview: { reviewedBalanceCents: 20_000 } as never }),
    delinquencyRow("person-1", "p-a", ["balance_review_stale"], { totalBalanceCents: null, balanceReview: { reviewedBalanceCents: 20_000 } as never }),
  ] } });
  assert.equal(stale.find(candidate => candidate.scopeKey === "account:person-0@p-a")?.impactCents, "30000");
  assert.equal(stale.find(candidate => candidate.scopeKey === "account:person-1@p-a")?.impactCents, null);
  for (const candidate of [...known, ...stale]) assert.notEqual(candidate.impactCents, "0");
});

test("observations outside the organization's properties are ignored", () => {
  const snapshot = snapshotWithPeople(2);
  const candidates = detectReviewCases({ asOf, snapshot, propertyIds: new Set(["p-a"]), propertyEntities: new Map([["p-a", "20000000-0000-4000-8000-000000000001"]]), reports: {
    rentRoll: [], scheduledIncome: [], violations: [],
    delinquency: [delinquencyRow("person-0", "p-a", ["account_balance_unknown"]), delinquencyRow("person-1", "p-b", ["account_balance_unknown"])],
  } });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.propertyId, "p-a");
  assert.equal(candidates[0]!.legalEntityId, "20000000-0000-4000-8000-000000000001");
});

test("QuickBooks gaps are connection cases, one per legal entity or stream", () => {
  const entity = "20000000-0000-4000-8000-000000000001";
  const other = "20000000-0000-4000-8000-000000000002";
  const candidates = detectReviewCases({ asOf, snapshot: snapshotWithPeople(0), reports: { rentRoll: [], delinquency: [], scheduledIncome: [], violations: [] }, qbo: {
    connections: [
      { legalEntityId: entity, legalEntityName: "Example Property LLC", environment: "sandbox", realmId: "1", status: "needs_reconnect" },
      { legalEntityId: other, environment: "sandbox", realmId: "2", status: "revoked" },
      { legalEntityId: other, environment: "sandbox", realmId: "3", status: "active" },
    ],
    syncExceptions: [
      { legalEntityId: entity, stream: "transactions", objectType: "JournalEntry", objectId: "10", exceptionKind: "unsupported", reasons: ["unsupported line"] },
      { legalEntityId: entity, stream: "transactions", objectType: "JournalEntry", objectId: "11", exceptionKind: "unsupported", reasons: ["unsupported line"] },
    ],
  } });
  const disconnected = candidates.filter(candidate => candidate.reasonCode === "qbo_disconnected");
  assert.equal(disconnected.length, 1, "an entity with an active connection is not disconnected");
  assert.equal(disconnected[0]!.legalEntityId, entity);
  assert.equal(disconnected[0]!.scopeLabel, "Example Property LLC");
  const sync = candidates.filter(candidate => candidate.reasonCode === "sync_exception");
  assert.equal(sync.length, 1);
  assert.equal(sync[0]!.affectedCount, 2);
});

test("the detector runs end to end on a synthetic snapshot and is deterministic", () => {
  const snapshot = syntheticRentOpsSnapshot();
  const first = detectReviewCases({ asOf, snapshot });
  const second = detectReviewCases({ asOf, snapshot });
  assert.deepEqual(first, second);
  const keys = first.map(reviewCandidateKey);
  assert.equal(new Set(keys).size, keys.length, "one candidate per reason, cause and scope");
  for (const candidate of first) {
    assert.match(candidate.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(candidate.affectedCount >= 1);
    assert.ok(candidate.impactCents === null || candidate.impactCents !== "0");
  }
});

test("every uncertainty and violation code in the rental domain maps to a specific review reason", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)));
  const files = readdirSync(root).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "review-detector.ts").map(name => join(root, name));
  files.push(join(root, "..", "import", "account-history-coverage.ts"));
  const codePattern = /(?:code:\s*"([a-z][a-z0-9_]+)"|(?:Codes?|codes|uncertainty|reasons)\.(?:push|add)\("([a-z][a-z0-9_]+)"|exceptionCodes:\s*\["([a-z][a-z0-9_]+)"\]|return \["([a-z][a-z0-9_]+)"\]|\? "([a-z][a-z0-9_]+_(?:unknown|unverified|ambiguous|unconfirmed|missing|conflict|stale|elapsed|invalid))")/g;
  const codes = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of Array.from(source.matchAll(codePattern))) codes.add(match.slice(1).find(Boolean)!);
  }
  for (const kind of ["charges", "payments", "credits", "allocations"]) for (const suffix of ["collection_incomplete", "missing_from_target", "duplicate_identity"]) codes.add(`${kind}_${suffix}`);
  assert.ok(codes.size > 100, `expected the domain to emit many codes, found ${codes.size}`);
  const unmapped = Array.from(codes).filter(code => classifyReviewCode(code).matchedBy === "fallback").sort();
  assert.deepEqual(unmapped, [], `unmapped review codes: ${unmapped.join(", ")}`);
});

test("short labels come from the reason registry; Unverified only without a code", () => {
  assert.equal(reviewLabelForCodes(["lease_term_missing"]), "Lease missing");
  assert.equal(reviewLabelForCodes(["ledger_amount_unknown", "imported_account_history_unverified"]), "History incomplete");
  assert.equal(reviewLabelForCodes(["account_balance_unknown"]), "Balance unverified");
  assert.equal(reviewLabelForCodes([]), "Unverified");
  assert.equal(reviewLabelForCodes(undefined), "Unverified");
  assert.equal(reviewReason(classifyReviewCode("current_move_in_missing").reason).shortLabel, "Move-in date missing");
  assert.equal(reviewReason(classifyReviewCode("schedule_lineage_branch").reason).shortLabel, "Charge schedule unconfirmed");
});
