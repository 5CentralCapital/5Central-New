import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAmortizationSchedule,
  buildInstrumentRollforward,
  investorCalendarState,
  levelPaymentCents,
  type RollforwardPaymentInput,
} from "./rollforward";

const zeroAmounts = { principalCents: "0", interestCents: "0", returnOfCapitalCents: "0", distributionCents: "0", feeCents: "0", balloonCents: "0", unclassifiedCents: "0" };
let sequence = 0;
function payment(overrides: Partial<RollforwardPaymentInput> & { amounts?: Partial<typeof zeroAmounts> }): RollforwardPaymentInput {
  sequence += 1;
  const amounts = { ...zeroAmounts, ...(overrides.amounts ?? {}) } as RollforwardPaymentInput["amounts"];
  const amountCents = Object.values(amounts).reduce((total, value) => total + BigInt(value), BigInt(0)).toString();
  return { id: `p${sequence}`, kind: "principal", status: "manual_recorded", paymentOn: "2026-02-01", currency: "USD", reversesPaymentId: null, ...overrides, amounts, amountCents: overrides.amountCents ?? amountCents } as RollforwardPaymentInput;
}

test("level payment matches the standard amortization formula in exact cents", () => {
  assert.equal(levelPaymentCents(BigInt(10_000_000), "0.06", 360), BigInt(59_955));
  assert.equal(levelPaymentCents(BigInt(1_200), "0", 12), BigInt(100));
});

test("interest-only periods then level amortization clear the balance exactly", () => {
  const schedule = buildAmortizationSchedule({
    principalCents: "10000000", annualRate: "0.12", schedule: "monthly", paymentDay: 1, monthEndRule: "calendar_day_or_month_end",
    accrualStartOn: "2026-01-01", firstDueMonth: "2026-02-01", interestOnlyUntil: "2026-05-01", amortizationMonths: 12, maturityOn: null, balloonCents: null, dayCount: "30_360",
  });
  assert.equal(schedule.status, "ready");
  const phases = schedule.rows.map((row) => row.phase);
  assert.deepEqual(phases.slice(0, 3), ["interest_only", "interest_only", "interest_only"]);
  assert.equal(schedule.rows.length, 15);
  for (const row of schedule.rows.slice(0, 3)) {
    assert.equal(row.interestCents, "100000");
    assert.equal(row.principalCents, "0");
  }
  assert.equal(schedule.levelPaymentCents, "888488");
  const principalTotal = schedule.rows.reduce((total, row) => total + BigInt(row.principalCents) + BigInt(row.balloonCents), BigInt(0));
  assert.equal(principalTotal, BigInt(10_000_000));
  assert.equal(schedule.rows.at(-1)!.closingCents, "0");
  for (const row of schedule.rows) assert.equal(BigInt(row.openingCents) - BigInt(row.principalCents) - BigInt(row.balloonCents), BigInt(row.closingCents));
  for (const row of schedule.rows.slice(3, -1)) assert.equal(row.paymentCents, "888488");
});

test("a balloon at maturity carries the unamortized principal and flags a documented mismatch", () => {
  const schedule = buildAmortizationSchedule({
    principalCents: "20000000", annualRate: "0.075", schedule: "monthly", paymentDay: 15, monthEndRule: "calendar_day_or_month_end",
    accrualStartOn: "2026-01-15", firstDueMonth: "2026-02-01", interestOnlyUntil: null, amortizationMonths: 360, maturityOn: "2028-01-15", balloonCents: "19000000", dayCount: "30_360",
  });
  const last = schedule.rows.at(-1)!;
  assert.equal(last.phase, "maturity");
  assert.equal(last.dueOn, "2028-01-15");
  assert.equal(last.closingCents, "0");
  assert.ok(BigInt(last.balloonCents) > BigInt(19_000_000));
  assert.equal(schedule.computedBalloonCents, last.balloonCents);
  assert.equal(schedule.balloonMatches, false);
  assert.ok(schedule.warnings.some((warning) => /balloon/.test(warning)));
  const unknown = buildAmortizationSchedule({ principalCents: null, annualRate: "0.1", schedule: "monthly", paymentDay: 1, monthEndRule: "month_end", accrualStartOn: "2026-01-01", firstDueMonth: null, interestOnlyUntil: null, amortizationMonths: 12, maturityOn: null, balloonCents: null, dayCount: "30_360" });
  assert.equal(unknown.status, "principal_unknown");
  assert.equal(unknown.rows.length, 0);
});

test("rollforward conserves opening + funded − repaid = closing across months", () => {
  const rollforward = buildInstrumentRollforward({
    instrumentKind: "private_loan", currency: "USD", effectiveFrom: "2026-01-01", maturityOn: "2027-12-31", asOf: "2026-06-30",
    documentedFundedCents: null, manualOutstandingCents: "9500000", guaranteedReturnCents: null,
    payments: [
      payment({ kind: "contribution", paymentOn: "2026-01-05", status: "bank_settled", amounts: { principalCents: "10000000" } }),
      payment({ kind: "principal", paymentOn: "2026-02-01", status: "qbo_posted", amounts: { principalCents: "200000", interestCents: "100000" } }),
      payment({ kind: "principal", paymentOn: "2026-03-01", amounts: { principalCents: "300000", interestCents: "98000" } }),
    ],
    obligations: [
      { periodMonth: "2026-02-01", principalCents: "200000", interestCents: "100000", balloonCents: "0", totalExpectedCents: "300000" },
      { periodMonth: "2026-03-01", principalCents: "200000", interestCents: "98000", balloonCents: "0", totalExpectedCents: "298000" },
    ],
    fromMonth: "2026-02-01", throughMonth: "2026-04-01",
  });
  assert.equal(rollforward.basis, "payments");
  assert.equal(rollforward.openingCents, "10000000");
  assert.deepEqual(rollforward.rows.map((row) => [row.openingCents, row.principalRepaidCents, row.closingCents]), [
    ["10000000", "200000", "9800000"],
    ["9800000", "300000", "9500000"],
    ["9500000", "0", "9500000"],
  ]);
  assert.equal(rollforward.conserved, true);
  assert.equal(rollforward.derivedOutstandingCents, "9500000");
  assert.equal(rollforward.reconciliation, "matches");
  assert.equal(rollforward.rows[0]!.postedCents, "300000");
  assert.equal(rollforward.rows[1]!.postedCents, "0", "a manual record is not posted");
  assert.equal(rollforward.unverifiedPaymentCount, 1);
  assert.equal(rollforward.rows[1]!.expectedPrincipalCents, "200000");
});

test("partial payment, reversal and unknown split keep principal honest", () => {
  const original = payment({ kind: "principal", paymentOn: "2026-02-10", status: "qbo_posted", amounts: { principalCents: "50000" } });
  const reversal = payment({ kind: "correction", status: "reversed", paymentOn: "2026-02-20", reversesPaymentId: original.id, amounts: { principalCents: "-50000" } });
  const bankInstallment = payment({ kind: "principal", paymentOn: "2026-02-25", amounts: { unclassifiedCents: "123456" } });
  const rollforward = buildInstrumentRollforward({
    instrumentKind: "member_loan", currency: "USD", effectiveFrom: "2026-01-01", maturityOn: null, asOf: "2026-03-01",
    documentedFundedCents: null, manualOutstandingCents: "1000000", guaranteedReturnCents: null,
    payments: [payment({ kind: "contribution", paymentOn: "2026-01-02", amounts: { principalCents: "1000000" } }), original, reversal, bankInstallment],
    obligations: [], fromMonth: "2026-02-01", throughMonth: "2026-02-01",
  });
  const row = rollforward.rows[0]!;
  assert.equal(row.principalRepaidCents, "0", "the reversal nets the reversed principal to zero");
  assert.equal(row.unclassifiedCents, "123456");
  assert.equal(row.closingCents, "1000000", "an unknown bank split never reduces principal");
  assert.equal(row.postedCents, "0", "the reversal offsets the posted evidence of the reversed payment");
  assert.equal(rollforward.unclassifiedTotalCents, "123456");
  assert.equal(rollforward.reconciliation, "matches");
});

test("as-of rollforwards exclude later payoffs and apply reversals at their own date", () => {
  const funding = payment({ kind: "contribution", paymentOn: "2026-01-02", amounts: { principalCents: "100000" } });
  const payoff = payment({ kind: "principal", paymentOn: "2026-02-10", amounts: { principalCents: "100000" } });
  const reversal = payment({ kind: "correction", status: "reversed", paymentOn: "2026-03-05", reversesPaymentId: payoff.id, amounts: { principalCents: "-100000" }, amountCents: "-100000" });
  const build = (asOf: string) => buildInstrumentRollforward({
    instrumentKind: "private_loan", currency: "USD", effectiveFrom: "2026-01-01", maturityOn: null, asOf,
    documentedFundedCents: null, manualOutstandingCents: null, guaranteedReturnCents: null,
    payments: [funding, payoff, reversal], obligations: [], fromMonth: "2026-01-01", throughMonth: `${asOf.slice(0, 7)}-01`,
  });

  assert.equal(build("2026-01-31").derivedOutstandingCents, "100000", "a later payoff cannot rewrite the January snapshot");
  assert.equal(build("2026-02-15").derivedOutstandingCents, "0", "the payoff applies once its date is inside the snapshot");
  assert.equal(build("2026-03-15").derivedOutstandingCents, "100000", "the reversal restores the balance only after its own date");
});

test("derived outstanding that differs from the manual value is flagged, not overwritten", () => {
  const rollforward = buildInstrumentRollforward({
    instrumentKind: "private_loan", currency: "USD", effectiveFrom: "2026-01-01", maturityOn: null, asOf: "2026-06-01",
    documentedFundedCents: "500000", manualOutstandingCents: "480000", guaranteedReturnCents: null,
    payments: [payment({ kind: "principal", paymentOn: "2026-03-01", amounts: { principalCents: "40000" } })],
    obligations: [], fromMonth: "2026-01-01", throughMonth: "2026-03-01",
  });
  assert.equal(rollforward.basis, "documented_funding");
  assert.equal(rollforward.rows[0]!.fundedCents, "500000");
  assert.equal(rollforward.derivedOutstandingCents, "460000");
  assert.equal(rollforward.manualOutstandingCents, "480000");
  assert.equal(rollforward.differenceCents, "20000");
  assert.equal(rollforward.reconciliation, "mismatch");
  const unknown = buildInstrumentRollforward({ instrumentKind: "private_loan", currency: "USD", effectiveFrom: "2026-01-01", maturityOn: null, asOf: "2026-06-01", documentedFundedCents: null, manualOutstandingCents: "1", guaranteedReturnCents: null, payments: [], obligations: [], fromMonth: "2026-01-01", throughMonth: "2026-01-01" });
  assert.equal(unknown.closingCents, null, "an undocumented balance stays unknown");
  assert.equal(unknown.reconciliation, "unknown");
});

test("prepayment keeps the guaranteed interest due", () => {
  const rollforward = buildInstrumentRollforward({
    instrumentKind: "private_loan", currency: "USD", effectiveFrom: "2026-01-01", maturityOn: "2027-01-01", asOf: "2026-04-15",
    documentedFundedCents: null, manualOutstandingCents: "0", guaranteedReturnCents: "1200000",
    payments: [
      payment({ kind: "contribution", paymentOn: "2026-01-01", amounts: { principalCents: "10000000" } }),
      payment({ kind: "interest", paymentOn: "2026-02-01", amounts: { interestCents: "100000" } }),
      payment({ kind: "interest", paymentOn: "2026-03-01", amounts: { interestCents: "100000" } }),
      payment({ kind: "principal", paymentOn: "2026-04-01", amounts: { principalCents: "10000000", interestCents: "100000" } }),
    ],
    obligations: [], fromMonth: "2026-01-01", throughMonth: "2026-04-01",
  });
  assert.equal(rollforward.derivedOutstandingCents, "0");
  assert.equal(rollforward.prepaid, true);
  assert.deepEqual(rollforward.guaranteedReturn, { returnCents: "1200000", paidCents: "300000", remainingCents: "900000" });
});

test("calendar states separate scheduled, overdue, posted and settled", () => {
  assert.equal(investorCalendarState({ status: "expected", dueOn: "2026-10-01" }, "2026-09-23"), "scheduled");
  assert.equal(investorCalendarState({ status: "expected", dueOn: "2026-09-01" }, "2026-09-23"), "overdue");
  assert.equal(investorCalendarState({ status: "partially_posted", dueOn: "2026-09-01" }, "2026-09-23"), "partial");
  assert.equal(investorCalendarState({ status: "qbo_posted", dueOn: "2026-09-01" }, "2026-09-23"), "posted");
  assert.equal(investorCalendarState({ status: "bank_settled", dueOn: "2026-09-01" }, "2026-09-23"), "settled");
  assert.equal(investorCalendarState({ status: "reversed", dueOn: "2026-09-01" }, "2026-09-23"), "reversed");
});

test("a maturity between scheduled due dates still ends the loan with a balloon on the maturity date", () => {
  const schedule = buildAmortizationSchedule({
    principalCents: "10000000", annualRate: "0.08", schedule: "quarterly", paymentDay: 15, monthEndRule: "calendar_day_or_month_end",
    accrualStartOn: "2025-10-15", firstDueMonth: "2026-01-01", interestOnlyUntil: null, amortizationMonths: null,
    maturityOn: "2026-11-15", balloonCents: "10000000", dayCount: "actual_360",
  });
  assert.equal(schedule.status, "ready");
  assert.deepEqual(schedule.rows.map(row => [row.dueOn, row.phase]), [
    ["2026-01-15", "interest_only"], ["2026-04-15", "interest_only"], ["2026-07-15", "interest_only"], ["2026-10-15", "interest_only"], ["2026-11-15", "maturity"],
  ]);
  const last = schedule.rows.at(-1)!;
  assert.equal(last.periodMonth, "2026-11-01");
  assert.equal(last.balloonCents, "10000000");
  assert.equal(last.closingCents, "0");
  // 31 days of interest from the previous due date: 10,000,000 × 0.08 × 31 / 360 = 68,888.89 → 68,889 cents.
  assert.equal(last.interestCents, "68889");
  assert.equal(schedule.computedBalloonCents, "10000000");
  assert.equal(schedule.balloonMatches, true);
  assert.equal(schedule.totalPrincipalCents, "10000000", "principal is conserved");

  // Amortizing loan with an off-cycle maturity: the balloon is exactly the remaining balance.
  const amortizing = buildAmortizationSchedule({
    principalCents: "1200000", annualRate: "0.06", schedule: "quarterly", paymentDay: 1, monthEndRule: "calendar_day_or_month_end",
    accrualStartOn: "2026-01-01", firstDueMonth: "2026-04-01", interestOnlyUntil: null, amortizationMonths: 60,
    maturityOn: "2026-12-10", balloonCents: null, dayCount: "30_360",
  });
  const final = amortizing.rows.at(-1)!;
  assert.equal(final.dueOn, "2026-12-10"); assert.equal(final.phase, "maturity"); assert.equal(final.principalCents, "0");
  assert.equal(final.closingCents, "0");
  assert.equal(BigInt(final.balloonCents), BigInt(amortizing.rows.at(-2)!.closingCents));
  assert.equal(amortizing.totalPrincipalCents, "1200000");
});
