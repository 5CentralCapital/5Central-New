import assert from "node:assert/strict";
import test from "node:test";
import { decodeBalanceReview } from "../api";
import type { AdminBalanceReviewView, RentRollRow } from "../types";
import { balanceReviewDisplay, balanceReviewReportText } from "./balance-review-display";
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
