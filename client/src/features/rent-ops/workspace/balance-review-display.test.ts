import assert from "node:assert/strict";
import test from "node:test";
import { decodeBalanceReview } from "../api";
import type { AdminBalanceReviewView, RentRollRow } from "../types";
import { balanceReviewDisplay, balanceReviewReportText, tenantHeaderBalance } from "./balance-review-display";
import { createReportViewModel, buildPropertySubtotals } from "./report-model";

const review: AdminBalanceReviewView = {
  schema: "balance_review_v1", id: "review:one", tenancyId: "tenancy:one", personId: "person:one", propertyId: "property:one", unitId: "unit:one",
  asOfDate: "2026-09-12", reviewedAt: "2026-09-12T12:00:00Z", reviewedBy: "Manager",
  reviewedBalanceCents: 12500, tenantBalanceCents: null, agencyBalanceCents: null, qualifications: ["Agency payment pending confirmation"], stale: false,
};

test("review display keeps unknown amounts distinct from zero and preserves qualifications", () => {
  assert.equal(balanceReviewDisplay(undefined), undefined);
  assert.equal(balanceReviewDisplay({ ...review, reviewedBalanceCents: null })?.amount, "Unknown");
  assert.equal(balanceReviewDisplay({ ...review, reviewedBalanceCents: 0 })?.amount, "$0.00");
  assert.equal(balanceReviewDisplay(review)?.payerSplit, "Tenant: Unknown · Agency: Unknown");
  assert.match(balanceReviewReportText(review), /Agency payment pending confirmation/);
  const stale = balanceReviewDisplay({ ...review, stale: true });
  assert.equal(stale?.label, "Historical reviewed balance");
  assert.match(stale?.warning ?? "", /New ledger activity/);
  assert.match(stale?.date ?? "", /2026/);
});

test("review columns preserve posted balances and do not contribute to ledger subtotals", () => {
  const rows: RentRollRow[] = [{ propertyId: "property:one", unitId: "unit:one", balanceComplete: true, balanceDueCents: 99900, balanceReview: review }];
  const view = createReportViewModel("rent-roll", rows);
  assert.equal(view.displayRows[0].balanceDueCents, 99900);
  assert.match(String(view.displayRows[0].reviewedOperationalBalance), /\$125.00/);
  assert.equal(view.columns.find(column => column.key === "balanceDueCents")?.label, "Posted ledger balance");
  assert.equal(view.optionalColumns.some(column => column.key === "balanceReview"), false);
  const totals = buildPropertySubtotals("rent-roll", rows)[0].amounts;
  assert.equal(totals.balanceDueCents, 99900);
  assert.equal(totals.reviewedOperationalBalance, undefined);
});

test("closed review decoder accepts nulls and rejects missing amounts or source references", () => {
  assert.deepEqual(decodeBalanceReview(review), review);
  assert.throws(() => decodeBalanceReview({ ...review, reviewedBalanceCents: undefined }));
  assert.throws(() => decodeBalanceReview({ ...review, reviewedBalanceCents: "0" }));
  assert.throws(() => decodeBalanceReview({ ...review, sourceRefs: ["private evidence"] }));
});


test("operational report subtotal honors reviewed amount independently of posted completeness and propagates unknown", () => {
  const rows: RentRollRow[] = [{ propertyId: "property:one", unitId: "unit:one", balanceComplete: false, balanceDueCents: null, balanceReview: review, operationalBalanceCents: 12500 }];
  assert.equal(buildPropertySubtotals("rent-roll", rows)[0].amounts.operationalBalanceCents, 12500);
  rows.push({ propertyId: "property:one", unitId: "unit:two", balanceComplete: true, balanceDueCents: 0, balanceReview: { ...review, reviewedBalanceCents: null }, operationalBalanceCents: null });
  assert.equal(buildPropertySubtotals("rent-roll", rows)[0].amounts.operationalBalanceCents, null);
});

test("tenant header shows the reviewed balance as balance due and flags a differing posted ledger", () => {
  const zero = { ...review, asOfDate: "2026-09-10", reviewedBalanceCents: 0 };
  const header = tenantHeaderBalance(zero, { complete: true, amountCents: 140000 });
  assert.equal(header.label, "Balance due");
  assert.equal(header.amount, "$0.00");
  assert.equal(header.detail, "Reviewed Sep 10, 2026");
  assert.equal(header.ledgerDifference?.label, "Ledger shows $1,400.00");
  assert.match(header.ledgerDifference?.explanation ?? "", /posted ledger differs from the Sep 10(, 2026)? review\. Reconcile on the Ledger tab\./);
  assert.equal(tenantHeaderBalance(zero, { complete: true, amountCents: 0 }).ledgerDifference, undefined);
  assert.equal(tenantHeaderBalance(zero, { complete: false, amountCents: null }).ledgerDifference, undefined, "an incomplete ledger is not a known difference");
  const unknown = tenantHeaderBalance({ ...zero, reviewedBalanceCents: null }, { complete: true, amountCents: 140000 });
  assert.equal(unknown.amount, undefined, "an unknown review is never shown as $0");
  assert.equal(unknown.unknownLabel, "Not verified");
  assert.match(tenantHeaderBalance({ ...zero, stale: true }, { complete: true, amountCents: 0 }).warning ?? "", /New ledger activity/);
});

test("tenant header without a review keeps the posted ledger balance and its unknown label", () => {
  const known = tenantHeaderBalance(undefined, { complete: true, amountCents: 5000, asOfDate: "2026-09-24" });
  assert.equal(known.amount, "$50.00");
  assert.equal(known.detail, "Posted ledger · as of Sep 24, 2026");
  assert.equal(known.ledgerDifference, undefined);
  const incomplete = tenantHeaderBalance(undefined, { complete: false, amountCents: null, unknownLabel: "Unapplied cash" });
  assert.equal(incomplete.amount, undefined);
  assert.equal(incomplete.unknownLabel, "Unapplied cash");
});
