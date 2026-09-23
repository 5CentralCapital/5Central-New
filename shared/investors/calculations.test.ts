import assert from "node:assert/strict";
import test from "node:test";
import { centsToBigInt } from "../company";
import {
  calculateInvestorObligation,
  calculateMonthlyObligationAmounts,
  obligationStatus,
} from "./calculations";
import { investorContractTermsSchema } from "./contracts";

const baseTerms = {
  schedule: "monthly" as const,
  paymentDay: 31,
  monthEndRule: "calendar_day_or_month_end" as const,
  annualRate: "0.12",
  preferredReturnRate: null,
  returnMultiple: null,
  fixedPaymentCents: null,
  principalPaymentCents: "1000",
  interestPaymentCents: null,
  returnOfCapitalCents: null,
  distributionCents: null,
  balloonCents: "500",
  originalPrincipalCents: "10000",
  interestOnly: false,
  dayCount: "actual_365" as const,
};

test("rate interest uses the supplied accrual dates and caps a maturity balloon", () => {
  const terms = investorContractTermsSchema.parse(baseTerms);
  const amounts = calculateMonthlyObligationAmounts(terms, "10000", true, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(amounts.interestCents, "102");
  assert.equal(amounts.principalCents, "1000");
  assert.equal(amounts.balloonCents, "500");
  assert.equal(centsToBigInt(amounts.principalCents) + centsToBigInt(amounts.balloonCents), BigInt(1500));
});

test("actual/360 and 30/360 use a 360-day denominator", () => {
  const actual360 = investorContractTermsSchema.parse({ ...baseTerms, dayCount: "actual_360" });
  const thirty360 = investorContractTermsSchema.parse({ ...baseTerms, dayCount: "30_360" });
  assert.equal(calculateMonthlyObligationAmounts(actual360, "10000", false, { startOn: "2026-01-01", endOn: "2026-02-01" }).interestCents, "103");
  assert.equal(calculateMonthlyObligationAmounts(thirty360, "10000", false, { startOn: "2026-01-01", endOn: "2026-02-01" }).interestCents, "100");
  assert.throws(() => calculateMonthlyObligationAmounts(actual360, "10000", false, { startOn: "2026-02-31", endOn: "2026-03-01" }), /real ISO/);
});

test("rate derivation refuses an unknown opening funded principal", () => {
  const terms = investorContractTermsSchema.parse(baseTerms);
  assert.throws(() => calculateMonthlyObligationAmounts(terms, null, false, { startOn: "2026-01-01", endOn: "2026-02-01" }), /Opening funded principal/);
});

test("interest-only fixed terms require an explicit interest basis", () => {
  assert.throws(() => investorContractTermsSchema.parse({ ...baseTerms, annualRate: null, originalPrincipalCents: null, principalPaymentCents: null, balloonCents: null, interestOnly: true, fixedPaymentCents: "1000" }));
});

test("fixed payment terms preserve explicit principal and interest only when they reconcile", () => {
  const terms = investorContractTermsSchema.parse({ ...baseTerms, annualRate: null, originalPrincipalCents: "10000", fixedPaymentCents: "1000", principalPaymentCents: "600", interestPaymentCents: "400", balloonCents: null });
  const calculation = calculateInvestorObligation(terms, null, false, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(calculation.amounts.principalCents, "600");
  assert.equal(calculation.amounts.interestCents, "400");
  assert.throws(() => investorContractTermsSchema.parse({ ...terms, interestPaymentCents: "500" }), /Fixed payment must equal explicit principal plus interest/);
});

test("posted obligations expose a distinct partial posted state", () => {
  assert.equal(obligationStatus({ expectedCents: "1000", recordedCents: "500", postedCents: "500", settledCents: "0" }), "partially_posted");
});

test("a documented maturity total absorbs payoff classification without double counting", () => {
  const terms = investorContractTermsSchema.parse({
    ...baseTerms,
    schedule: "monthly",
    principalPaymentCents: null,
    annualRate: null,
    originalPrincipalCents: "10000",
    thirdPartyInstallmentCents: "2500",
    investorSpreadCents: "300",
    unknownComponentKinds: ["principal", "interest"],
    maturityTotalCents: "20000",
    fixedProfitCents: "10000",
    maturityPayoffCents: null,
  });
  const monthly = calculateInvestorObligation(terms, null, false, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(monthly.unknownExpectedCents, "2500");
  assert.equal(monthly.amounts.distributionCents, "300");
  assert.deepEqual(monthly.unknownComponentKinds.sort(), ["interest", "principal"]);
  const maturity = calculateInvestorObligation(terms, null, true, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(maturity.unknownExpectedCents, "9200");
  assert.equal(maturity.totalExpectedCents, "20000");
  assert.equal(maturity.amountComplete, true);
  assert.equal(maturity.knownMinimumCents, "20000");
  assert.equal(maturity.amounts.distributionCents, "10300");
});

test("a known third-party installment remains allocatable without inventing principal", () => {
  const terms = investorContractTermsSchema.parse({
    ...baseTerms,
    annualRate: null,
    principalPaymentCents: null,
    fixedPaymentCents: "2800",
    thirdPartyInstallmentCents: "2500",
    investorSpreadCents: "300",
    unknownComponentKinds: ["principal", "interest"],
  });
  const calculation = calculateInvestorObligation(terms, null, false, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(calculation.amounts.unclassifiedCents, "2500");
  assert.equal(calculation.totalExpectedCents, "2800");
  assert.equal(calculation.knownMinimumCents, "2800");
  assert.equal(calculation.amountComplete, true);
  assert.equal(obligationStatus({ expectedCents: calculation.totalExpectedCents, amountComplete: calculation.amountComplete, recordedCents: "2800", postedCents: "2800", settledCents: "0" }), "qbo_posted");
});

test("an evidenced third-party principal and interest split reconciles to the installment once", () => {
  const terms = investorContractTermsSchema.parse({
    ...baseTerms,
    annualRate: null,
    principalPaymentCents: "1800",
    interestPaymentCents: "700",
    fixedPaymentCents: "2800",
    thirdPartyInstallmentCents: "2500",
    investorSpreadCents: "300",
    unknownComponentKinds: [],
  });
  const calculation = calculateInvestorObligation(terms, null, false, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(calculation.amounts.principalCents, "1800");
  assert.equal(calculation.amounts.interestCents, "700");
  assert.equal(calculation.amounts.unclassifiedCents, "0");
  assert.equal(calculation.amounts.distributionCents, "300");
  assert.equal(calculation.totalExpectedCents, "2800");
  assert.deepEqual(calculation.unknownComponentKinds, []);
  assert.throws(() => investorContractTermsSchema.parse({ ...terms, interestPaymentCents: "800" }), /explicit third-party principal and interest split/);
});

test("an unknown maturity payoff stays incomplete without a documented total", () => {
  const terms = investorContractTermsSchema.parse({
    ...baseTerms,
    annualRate: null,
    principalPaymentCents: null,
    balloonCents: null,
    maturityTotalCents: null,
    fixedProfitCents: "10000",
    maturityPayoffCents: null,
  });
  const calculation = calculateInvestorObligation(terms, null, true, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(calculation.totalExpectedCents, null);
  assert.equal(calculation.knownMinimumCents, "10000");
  assert.equal(calculation.amountComplete, false);
  assert.equal(obligationStatus({ expectedCents: calculation.totalExpectedCents, amountComplete: calculation.amountComplete, recordedCents: "10000", postedCents: "10000", settledCents: "10000" }), "partially_settled");
});

test("an undocumented maturity payoff keeps the full amount unresolved", () => {
  const terms = investorContractTermsSchema.parse({
    ...baseTerms,
    annualRate: null,
    principalPaymentCents: null,
    balloonCents: null,
    fixedProfitCents: null,
    maturityTotalCents: null,
    maturityPayoffCents: null,
  });
  const calculation = calculateInvestorObligation(terms, null, true, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(calculation.totalExpectedCents, null);
  assert.equal(calculation.amountComplete, false);
  assert.equal(calculation.knownMinimumCents, "0");
});

test("documented maturity totals support a complete unclassified payoff and explicit breakdown", () => {
  const totalOnly = investorContractTermsSchema.parse({ ...baseTerms, annualRate: null, principalPaymentCents: null, balloonCents: null, maturityTotalCents: "20000", fixedProfitCents: null, maturityPayoffCents: null });
  const totalCalculation = calculateInvestorObligation(totalOnly, null, true, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(totalCalculation.totalExpectedCents, "20000");
  assert.equal(totalCalculation.amounts.unclassifiedCents, "20000");
  assert.equal(totalCalculation.amounts.distributionCents, "0");
  const explicit = investorContractTermsSchema.parse({ ...totalOnly, fixedProfitCents: "10000", maturityPayoffCents: "10000" });
  const explicitCalculation = calculateInvestorObligation(explicit, null, true, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(explicitCalculation.totalExpectedCents, "20000");
  assert.equal(explicitCalculation.amounts.unclassifiedCents, "10000");
  assert.equal(explicitCalculation.amounts.distributionCents, "10000");
  assert.throws(() => investorContractTermsSchema.parse({ ...explicit, maturityPayoffCents: "9000" }), /maturity total must equal/);
});

test("a maturity payoff without fixed profit is included once in the documented total", () => {
  const terms = investorContractTermsSchema.parse({ ...baseTerms, annualRate: null, principalPaymentCents: null, balloonCents: null, maturityTotalCents: "20000", fixedProfitCents: null, maturityPayoffCents: "8000" });
  const calculation = calculateInvestorObligation(terms, null, true, { startOn: "2026-01-01", endOn: "2026-02-01" });
  assert.equal(calculation.totalExpectedCents, "20000");
  assert.equal(calculation.amounts.unclassifiedCents, "20000");
  assert.equal(calculation.amountComplete, true);
});

test("contract rates must be non-negative and fit the stored numeric(18,12) precision", () => {
  assert.equal(investorContractTermsSchema.parse({ ...baseTerms, annualRate: "0.112500000000" }).annualRate, "0.1125");
  assert.equal(investorContractTermsSchema.safeParse({ ...baseTerms, annualRate: "999999.123456789012" }).success, true);
  for (const annualRate of ["-0.12", "0.1234567890123", "1000000"]) {
    assert.equal(investorContractTermsSchema.safeParse({ ...baseTerms, annualRate }).success, false, annualRate);
  }
  assert.equal(investorContractTermsSchema.safeParse({ ...baseTerms, returnMultiple: "-1.5" }).success, false);
  assert.equal(investorContractTermsSchema.safeParse({ ...baseTerms, preferredReturnRate: "-0.08" }).success, false);
});
