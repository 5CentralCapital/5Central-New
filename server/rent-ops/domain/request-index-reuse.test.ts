import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { validateSnapshot } from "./invariants";
import { deriveDashboardSummary, deriveRentRoll, deriveDelinquency } from "./reports";
import type { RentOpsFilters, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";

function indexReuseCases(): RentOpsSnapshot[] {
  const fixtures = [structuredClone(syntheticRentOpsSnapshot())];
  const mutate = (change: (snapshot: RentOpsSnapshot) => void) => {const snapshot = structuredClone(syntheticRentOpsSnapshot()); change(snapshot); fixtures.push(snapshot);};
  for (const [field, knowledge] of [["tenancyId", "tenancyLinkKnowledge"], ["propertyId", "propertyLinkKnowledge"], ["unitId", "unitLinkKnowledge"], ["personId", "personLinkKnowledge"]]) {
    for (const state of ["unknown", "exact"]) mutate(s => Object.assign(s.ledgerTransactions[0], {[field]: null, [knowledge]: state}));
  }
  for (const patch of [{amountCents: null}, {postedOn: null}, {status: "pending"}, {tenancyId: "missing"}, {personId: "demo-person-2", personLinkKnowledge: "exact"}]) mutate(s => Object.assign(s.ledgerTransactions[0], patch));
  for (const kind of ["payment", "charge"] as const) for (const postedOn of ["2026-08-01", "2026-08-10", "2026-09-01", null]) mutate(s => {
    const original = s.ledgerTransactions.find(row => row.kind === kind)!;
    s.ledgerTransactions.push({...original, id: `index-reversal-${kind}`, kind: "reversal", reversalOfId: original.id, postedOn});
  });
  mutate(s => {const original = s.ledgerTransactions[0]; const reversal = {...original, id: "index-reversal", kind: "reversal" as const, reversalOfId: original.id}; s.ledgerTransactions.push(reversal, {...reversal, id: "index-reversal-twice", reversalOfId: reversal.id}); s.paymentAllocations[0].chargeTransactionId = reversal.id;});
  mutate(s => s.ledgerTransactions.push({...s.ledgerTransactions[0], id: "orphan-reversal", kind: "reversal", reversalOfId: "missing"}));
  for (const patch of [{paymentTransactionId: null, paymentLinkKnowledge: "unknown"}, {chargeTransactionId: null, chargeLinkKnowledge: "ambiguous"}, {allocatedOn: null}, {allocatedOn: "2026-07-01"}, {allocatedOn: "2026-09-01"}, {amountCents: null}, {amountCents: -100, kind: "reversal"}]) mutate(s => Object.assign(s.paymentAllocations[0], patch));
  mutate(s => {const charge = s.ledgerTransactions[0]; const credit = {...charge, id: "index-credit", kind: "credit" as const}; s.ledgerTransactions.push(credit); Object.assign(s.paymentAllocations[0], {kind: "credit_allocation", paymentTransactionId: null, creditTransactionId: credit.id});});
  for (const sourceUpdatedAt of ["2026-08-01T12:00:00.000Z", "2026-08-20T12:00:00.000Z"]) mutate(s => {
    const allocation = s.paymentAllocations[0];
    const payment = s.ledgerTransactions.find(row => row.id === allocation.paymentTransactionId)!;
    Object.assign(allocation, {source: {system: "rent_manager", sourceId: "source-allocation", sourceUpdatedAt}, sourceArtifactSha256: "a".repeat(64), artifactObservationOn: "2026-08-25", paymentLinkKnowledge: "exact", chargeLinkKnowledge: "exact", allocatedOn: "2026-08-22", allocatedOnKnowledge: "source", amountKnowledge: "known"});
    s.ledgerTransactions.push({...payment, id: "source-date-reversal", kind: "reversal", reversalOfId: payment.id, postedOn: "2026-08-10"});
  });
  mutate(s => s.tenancies.push({...s.tenancies[0], primaryPersonId: "demo-person-2"}));
  return fixtures;
}

const indexReuseFilters: RentOpsFilters[] = ["2026-07-15", "2026-08-05", "2026-08-16", "2026-09-15"].flatMap(asOfDate => [{}, {propertyId: "demo-property-a"}, {propertyId: "demo-property-b"}, {unitId: "demo-unit-a-1"}, {balanceStatus: "due" as const}, {balanceStatus: "credit" as const}, {search: "no match"}].map(scope => ({...scope, asOfDate, month: asOfDate.slice(0,7)})));
function captureResult(work: () => unknown) {try {return {value: work()};} catch (error) {const value = error as {message?: string; violations?: unknown}; return {error: value.message, violations: value.violations};}}
function indexReuseResults(reports = {deriveDashboardSummary, deriveRentRoll, deriveDelinquency}, validate = validateSnapshot) {
  return indexReuseCases().map(snapshot => ({violations: validate(snapshot), reports: indexReuseFilters.map(filters => Object.values(reports).map(derive => captureResult(() => derive(snapshot, filters))))}));
}

test("request indexes preserve reviewed financial outputs and ordered violations", () => {
  // Compared with HEAD across 35 fixtures x 28 filters (980 calls), ordered
  // violations, rent-roll rows and standalone delinquency rows are unchanged.
  // The 714 changed dashboard summaries contain only the canonical current
  // account fields and the current tenantStatus drilldown; review-derived
  // operational fields remain excluded from this financial golden below.
  const baseline = structuredClone(syntheticRentOpsSnapshot());
  assert.equal(deriveDashboardSummary(baseline, {asOfDate: "2026-08-16"}).scheduledRentCadenceComplete, true);
  assert.equal(baseline.subsidyContracts[0].statusKnowledge, undefined);
  const payerRow = deriveRentRoll(baseline, {asOfDate: "2026-08-16"}).find(row => row.unitId === "demo-unit-a-1")!;
  assert.equal(payerRow.baseRentCents, 120000);
  assert.equal(payerRow.recurringFeesCents, 5000);
  assert.equal(payerRow.totalScheduledCents, 125000);
  assert.equal(payerRow.subsidyCents, null);
  assert.equal(payerRow.tenantPortionCents, undefined);
  assert.deepEqual(payerRow.exceptionCodes, ["subsidy_contract_unconfirmed"]);
  const confirmed = structuredClone(baseline);
  confirmed.subsidyContracts[0].statusKnowledge = "manual";
  const confirmedRow = deriveRentRoll(confirmed, {asOfDate: "2026-08-16"}).find(row => row.unitId === "demo-unit-a-1")!;
  assert.equal(confirmedRow.subsidyCents, 40000);
  assert.equal(confirmedRow.tenantPortionCents, 80000);
  assert.equal(confirmedRow.totalScheduledCents, payerRow.totalScheduledCents);
  assert.equal(confirmedRow.balanceDueCents, payerRow.balanceDueCents);
  assert.deepEqual(confirmedRow.exceptionCodes, []);
  baseline.tenancies.push({...baseline.tenancies[0], primaryPersonId: "demo-person-2"});
  assert.throws(() => deriveRentRoll(baseline, {asOfDate: "2026-08-16"}), /Overlapping/);
  const unverified = structuredClone(syntheticRentOpsSnapshot());
  unverified.ledgerTransactions[0].amountCents = null;
  const dueRows = deriveRentRoll(unverified, {asOfDate: "2026-08-16", balanceStatus: "due"});
  const reviewRows = deriveRentRoll(unverified, {asOfDate: "2026-08-16", balanceStatus: "unverified"});
  assert.ok(dueRows.every(row => row.balanceDueCents !== null && row.balanceDueCents > 0));
  assert.ok(reviewRows.some(row => row.unitId === "demo-unit-a-1" && row.balanceDueCents === null));
  assert.ok(!dueRows.some(row => row.unitId === "demo-unit-a-1"));
  const results = indexReuseResults();
  // Source-backed reviews are additive and tested separately. Preserve every
  // financial field and ordered violation after the canonical dashboard change.
  const financialOnly = JSON.stringify(results, (key, value) => ["operationalBalanceCents", "operationalDelinquencyCents", "operationalBalanceUnresolvedCount", "balanceReview"].includes(key) ? undefined : value);
  assert.equal(createHash("sha256").update(financialOnly).digest("hex"), "1428751590f1fbd4f5663f7d5a17b15c212d54edf9b26a5dd19e184843719e68");
});

test("separate calls observe changed reversal and allocation facts on the same snapshot", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const filters = {asOfDate: "2026-08-16"};
  const before = deriveDelinquency(snapshot, filters);
  const payment = snapshot.ledgerTransactions.find(row => row.kind === "payment")!;
  snapshot.ledgerTransactions.push({...payment, id: "fresh-reversal", kind: "reversal", reversalOfId: payment.id, postedOn: "2026-08-12"});
  const after = deriveDelinquency(snapshot, filters);
  assert.notDeepEqual(after, before);
  snapshot.paymentAllocations[0].allocatedOn = "2026-08-15";
  assert.ok(validateSnapshot(snapshot).some(row => row.code === "allocation_payment_reversed"));
});
