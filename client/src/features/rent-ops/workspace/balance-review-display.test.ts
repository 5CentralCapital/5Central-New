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
  assert.equal(stale?.label, "Last balance review", "a review is a checkpoint, never a second balance");
  assert.equal(stale?.warning, undefined);
  assert.match(stale?.date ?? "", /2026/);
});

test("rent roll shows one balance; the last review is an optional note that never subtotals", () => {
  const rows: RentRollRow[] = [{ propertyId: "property:one", unitId: "unit:one", balanceComplete: true, balanceDueCents: 99900, balanceReview: review, operationalBalanceCents: 12500 }];
  const view = createReportViewModel("rent-roll", rows);
  assert.match(String(view.displayRows[0].reviewedOperationalBalance), /\$125.00/);
  assert.deepEqual(view.columns.filter(column => /balance/i.test(column.label) && column.format === "currency").map(column => column.label), ["Balance"]);
  assert.ok(view.columns.some(column => column.label === "Last balance review"));
  assert.equal(view.columns.some(column => column.key === "balanceDueCents"), false, "no second (posted) balance column");
  assert.equal(view.optionalColumns.some(column => column.key === "balanceReview"), false);
  const totals = buildPropertySubtotals("rent-roll", rows)[0].amounts;
  assert.equal(totals.operationalBalanceCents, 12500);
  assert.equal(totals.reviewedOperationalBalance, undefined);
});

test("closed review decoder accepts nulls and rejects missing amounts or source references", () => {
  assert.deepEqual(decodeBalanceReview(review), review);
  assert.equal(decodeBalanceReview({ ...review, postedAtReviewCents: -2500 }).postedAtReviewCents, -2500, "the review-date ledger balance passes through");
  assert.equal(decodeBalanceReview({ ...review, postedAtReviewCents: null }).postedAtReviewCents, null);
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

test("tenant header shows one balance: the review rolled forward by later ledger activity", () => {
  const zero = { ...review, asOfDate: "2026-09-10", reviewedBalanceCents: 0, postedAtReviewCents: 140000 };
  const header = tenantHeaderBalance(zero, { complete: true, amountCents: 140000 });
  assert.equal(header.label, "Balance");
  assert.equal(header.amount, "$0.00", "no activity since the review");
  assert.match(header.detail, /^Reviewed Sep 10/);
  assert.equal(header.ledgerDifference?.label, "Ledger off by $1,400.00", "the pre-review gap is a reconcile action, not a second balance");
  assert.equal(tenantHeaderBalance(zero, { complete: true, amountCents: 150000 }).amount, "$100.00", "a $100 charge after the review rolls forward");
  assert.equal(tenantHeaderBalance({ ...zero, postedAtReviewCents: 0 }, { complete: true, amountCents: 0 }).ledgerDifference, undefined);
  assert.equal(tenantHeaderBalance(zero, { complete: true, amountCents: 1, balanceCents: 777 }).amount, "$7.77", "the report's balance wins so every screen agrees");
  assert.equal(tenantHeaderBalance(zero, { complete: true, amountCents: 1, balanceCents: null }).amount, undefined, "an unknown report balance is never replaced by a local guess");
  const unknown = tenantHeaderBalance({ ...zero, reviewedBalanceCents: null }, { complete: true, amountCents: 140000 });
  assert.equal(unknown.amount, undefined, "an unknown review is never shown as $0");
  assert.equal(unknown.unknownLabel, "Not verified");
  assert.equal(tenantHeaderBalance({ ...zero, postedAtReviewCents: undefined, stale: true }, { complete: true, amountCents: 0 }).amount, undefined, "a changed ledger without a baseline is not guessed");
});

test("tenant header without a review keeps the ledger balance and its unknown label", () => {
  const known = tenantHeaderBalance(undefined, { complete: true, amountCents: 5000, asOfDate: "2026-09-24" });
  assert.equal(known.amount, "$50.00");
  assert.match(known.detail, /^As of Sep 24/);
  assert.equal(known.ledgerDifference, undefined);
  const incomplete = tenantHeaderBalance(undefined, { complete: false, amountCents: null, unknownLabel: "Unapplied cash" });
  assert.equal(incomplete.amount, undefined);
  assert.equal(incomplete.unknownLabel, "Unapplied cash");
});
