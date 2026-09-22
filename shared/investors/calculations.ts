import {
  centsFromBigInt,
  centsToBigInt,
  decimalPower10,
  parseDecimalParts,
  isoDateSchema,
  type MoneyCents,
} from "../company";
import type {
  InvestorContractTerms,
  InvestorObligationStatus,
  InvestorPaymentAmounts,
} from "./contracts";

const ZERO = BigInt(0);

function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new RangeError("Rounding denominator must be positive");
  const negative = numerator < ZERO;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  if ((absolute % denominator) * BigInt(2) >= denominator) quotient += BigInt(1);
  return negative ? -quotient : quotient;
}

/** Exact annual-rate interest in cents. Rate is a decimal fraction (0.1125 = 11.25%). */
export function annualRateToMonthlyInterestCents(principalCents: MoneyCents | string, annualRate: string, divisor = 12): MoneyCents {
  const rate = parseDecimalParts(annualRate);
  const numerator = centsToBigInt(principalCents) * (rate.sign < 0 ? -rate.coefficient : rate.coefficient);
  const denominator = decimalPower10(rate.scale) * BigInt(divisor);
  return centsFromBigInt(roundHalfAwayFromZero(numerator, denominator));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Apply the contract's month-end rule without using local time. */
export function dueDateForMonth(periodMonth: string, paymentDay: number | null, rule: "calendar_day_or_month_end" | "month_end"): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(periodMonth);
  if (!match) throw new RangeError("periodMonth must be the first day of a month");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError("periodMonth must contain a real calendar month");
  const day = rule === "month_end" ? daysInMonth(year, month) : Math.min(paymentDay ?? daysInMonth(year, month), daysInMonth(year, month));
  return `${periodMonth.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

export function emptyPaymentAmounts(): InvestorPaymentAmounts {
  return { principalCents: centsFromBigInt(ZERO), interestCents: centsFromBigInt(ZERO), returnOfCapitalCents: centsFromBigInt(ZERO), distributionCents: centsFromBigInt(ZERO), feeCents: centsFromBigInt(ZERO), balloonCents: centsFromBigInt(ZERO), unclassifiedCents: centsFromBigInt(ZERO) };
}

export function sumPaymentAmounts(value: InvestorPaymentAmounts): MoneyCents {
  return centsFromBigInt(
    centsToBigInt(value.principalCents)
      + centsToBigInt(value.interestCents)
      + centsToBigInt(value.returnOfCapitalCents)
      + centsToBigInt(value.distributionCents)
      + centsToBigInt(value.feeCents)
      + centsToBigInt(value.balloonCents)
      + centsToBigInt(value.unclassifiedCents),
  );
}

export function addPaymentAmounts(left: InvestorPaymentAmounts, right: InvestorPaymentAmounts): InvestorPaymentAmounts {
  return {
    principalCents: centsFromBigInt(centsToBigInt(left.principalCents) + centsToBigInt(right.principalCents)),
    interestCents: centsFromBigInt(centsToBigInt(left.interestCents) + centsToBigInt(right.interestCents)),
    returnOfCapitalCents: centsFromBigInt(centsToBigInt(left.returnOfCapitalCents) + centsToBigInt(right.returnOfCapitalCents)),
    distributionCents: centsFromBigInt(centsToBigInt(left.distributionCents) + centsToBigInt(right.distributionCents)),
    feeCents: centsFromBigInt(centsToBigInt(left.feeCents) + centsToBigInt(right.feeCents)),
    balloonCents: centsFromBigInt(centsToBigInt(left.balloonCents) + centsToBigInt(right.balloonCents)),
    unclassifiedCents: centsFromBigInt(centsToBigInt(left.unclassifiedCents) + centsToBigInt(right.unclassifiedCents)),
  };
}

export function negatePaymentAmounts(value: InvestorPaymentAmounts): InvestorPaymentAmounts {
  return {
    principalCents: centsFromBigInt(-centsToBigInt(value.principalCents)),
    interestCents: centsFromBigInt(-centsToBigInt(value.interestCents)),
    returnOfCapitalCents: centsFromBigInt(-centsToBigInt(value.returnOfCapitalCents)),
    distributionCents: centsFromBigInt(-centsToBigInt(value.distributionCents)),
    feeCents: centsFromBigInt(-centsToBigInt(value.feeCents)),
    balloonCents: centsFromBigInt(-centsToBigInt(value.balloonCents)),
    unclassifiedCents: centsFromBigInt(-centsToBigInt(value.unclassifiedCents)),
  };
}

export interface InvestorInterestPeriod {
  /** The accrual period, expressed as UTC calendar dates. */
  readonly startOn: string;
  readonly endOn: string;
}

function utcDay(value: string): number {
  const parsed = isoDateSchema.safeParse(value);
  if (!parsed.success) throw new RangeError("Interest period dates must be real ISO calendar dates");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed.data);
  if (!match) throw new RangeError("Interest period dates must be real ISO calendar dates");
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function actualDays(startOn: string, endOn: string): bigint {
  const start = utcDay(startOn);
  const end = utcDay(endOn);
  if (end <= start) throw new RangeError("Interest period end must follow its start");
  return BigInt(Math.round((end - start) / 86_400_000));
}

function thirty360Days(startOn: string, endOn: string): bigint {
  const parsedStart = isoDateSchema.safeParse(startOn);
  const parsedEnd = isoDateSchema.safeParse(endOn);
  const startMatch = parsedStart.success ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsedStart.data) : null;
  const endMatch = parsedEnd.success ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsedEnd.data) : null;
  if (!startMatch || !endMatch) throw new RangeError("Interest period dates must be ISO calendar dates");
  const startDay = Math.min(Number(startMatch[3]), 30);
  const endDay = Math.min(Number(endMatch[3]), 30);
  const days = (Number(endMatch[1]) - Number(startMatch[1])) * 360
    + (Number(endMatch[2]) - Number(startMatch[2])) * 30
    + endDay - startDay;
  if (days <= 0) throw new RangeError("Interest period end must follow its start");
  return BigInt(days);
}

function annualRateInterestCents(
  principalCents: bigint,
  annualRate: string,
  dayCount: InvestorContractTerms["dayCount"],
  period?: InvestorInterestPeriod,
): bigint {
  if (principalCents <= ZERO) return ZERO;
  const days = period === undefined
    ? (dayCount === "30_360" ? BigInt(30) : (() => { throw new RangeError("Actual day-count interest requires an accrual period"); })())
    : dayCount === "30_360" ? thirty360Days(period.startOn, period.endOn) : actualDays(period.startOn, period.endOn);
  const denominatorDays = dayCount === "actual_365" ? BigInt(365) : BigInt(360);
  const rate = parseDecimalParts(annualRate);
  const numerator = principalCents * (rate.sign < 0 ? -rate.coefficient : rate.coefficient) * days;
  return roundHalfAwayFromZero(numerator, decimalPower10(rate.scale) * denominatorDays);
}

/**
 * Derive one monthly obligation from the versioned contract terms. The caller
 * supplies the opening debt principal so the calculation never guesses a
 * balance from a display total. Explicit contract amounts win over derived
 * debt amounts; a balloon remains its own component.
 */
export interface InvestorObligationCalculation {
  readonly amounts: InvestorPaymentAmounts;
  readonly totalExpectedCents: MoneyCents | null;
  readonly knownMinimumCents: MoneyCents;
  readonly amountComplete: boolean;
  readonly unknownExpectedCents: MoneyCents;
  readonly unknownComponentKinds: readonly InvestorContractTerms["unknownComponentKinds"][number][];
}

/** Calculate both known component amounts and deliberately unclassified obligations. */
export function calculateInvestorObligation(
  terms: InvestorContractTerms,
  openingPrincipalCents: MoneyCents | string | null,
  isMaturity = false,
  period?: InvestorInterestPeriod,
): InvestorObligationCalculation {
  if (terms.annualRate !== null && openingPrincipalCents === null) {
    throw new RangeError("Opening funded principal is required to derive rate-based interest");
  }
  const opening = openingPrincipalCents === null ? ZERO : centsToBigInt(openingPrincipalCents);
  let interest = terms.interestPaymentCents === null
    ? terms.annualRate === null || opening === ZERO ? ZERO : annualRateInterestCents(opening, terms.annualRate, terms.dayCount, period)
    : centsToBigInt(terms.interestPaymentCents);
  let principal = terms.principalPaymentCents === null ? ZERO : centsToBigInt(terms.principalPaymentCents);
  const hasUnclassifiedInstallment = terms.thirdPartyInstallmentCents !== null;
  const hasExplicitInstallmentSplit = hasUnclassifiedInstallment && terms.principalPaymentCents !== null && terms.interestPaymentCents !== null;
  // The bank installment already represents the complete external payment.
  // Never add a separately derived rate amount to it; only an explicit
  // investor-side interest component may accompany that installment.
  if (hasUnclassifiedInstallment && !hasExplicitInstallmentSplit) {
    principal = ZERO;
    interest = ZERO;
  }
  if (terms.fixedPaymentCents !== null && !hasUnclassifiedInstallment) {
    const fixed = centsToBigInt(terms.fixedPaymentCents);
    if (terms.principalPaymentCents !== null && terms.interestPaymentCents === null) {
      interest = fixed - principal;
      if (interest < ZERO) throw new RangeError("Explicit principal cannot exceed the fixed payment");
    } else if (terms.principalPaymentCents === null && terms.interestPaymentCents !== null) {
      principal = fixed - interest;
      if (principal < ZERO) throw new RangeError("Explicit interest cannot exceed the fixed payment");
    } else if (terms.principalPaymentCents === null && terms.interestPaymentCents === null) {
      principal = fixed - interest;
      if (principal < ZERO) throw new RangeError("Derived interest exceeds the fixed payment");
    } else if (principal + interest !== fixed) {
      throw new RangeError("Fixed payment must equal explicit principal plus interest");
    }
  }
  if (terms.interestOnly && principal !== ZERO) throw new RangeError("Interest-only terms cannot include scheduled principal");
  if (terms.interestOnly) principal = ZERO;
  if (opening > ZERO && principal > opening) principal = opening;
  let balloon = isMaturity && terms.balloonCents !== null ? centsToBigInt(terms.balloonCents) : ZERO;
  if (opening === ZERO && balloon > ZERO && principal > ZERO) {
    throw new RangeError("Balloon and scheduled principal need a known opening balance");
  }
  if (opening > ZERO) balloon = balloon > opening - principal ? opening - principal : balloon;
  const returnOfCapital = terms.returnOfCapitalCents === null ? ZERO : centsToBigInt(terms.returnOfCapitalCents);
  let distribution = terms.distributionCents === null ? ZERO : centsToBigInt(terms.distributionCents);
  if (terms.investorSpreadCents !== null) distribution += centsToBigInt(terms.investorSpreadCents);
  let unknownExpected = hasExplicitInstallmentSplit ? ZERO : terms.thirdPartyInstallmentCents === null ? ZERO : centsToBigInt(terms.thirdPartyInstallmentCents);
  let amountComplete = true;
  const unknownKinds = new Set<InvestorContractTerms["unknownComponentKinds"][number]>(terms.unknownComponentKinds);
  if (hasExplicitInstallmentSplit) {
    unknownKinds.delete("principal");
    unknownKinds.delete("interest");
  }
  if (terms.thirdPartyInstallmentCents !== null && !hasExplicitInstallmentSplit) {
    unknownKinds.add("principal");
    unknownKinds.add("interest");
  }
  if (isMaturity) {
    const maturityTotal = terms.maturityTotalCents === null ? null : centsToBigInt(terms.maturityTotalCents);
    const fixedProfit = terms.fixedProfitCents === null ? null : centsToBigInt(terms.fixedProfitCents);
    const maturityPayoff = terms.maturityPayoffCents === null ? null : centsToBigInt(terms.maturityPayoffCents);
    if (fixedProfit !== null) distribution += fixedProfit;
    if (maturityTotal !== null) {
      // The documented maturity total is the authoritative amount for this
      // row. A payoff statement can explain that total, but it must never be
      // added on top of it. Keep the unresolved principal/interest portion in
      // one unclassified bucket so the amount and its classification remain
      // separate facts.
      if (maturityPayoff !== null && maturityPayoff > maturityTotal) {
        throw new RangeError("Maturity payoff cannot exceed the documented maturity total");
      }
      const classified = principal + interest + returnOfCapital + distribution + balloon;
      if (classified > maturityTotal) throw new RangeError("Known maturity components exceed the documented maturity total");
      unknownExpected = maturityTotal - classified;
      if (unknownExpected > ZERO && (maturityPayoff === null || fixedProfit === null)) {
        unknownKinds.add("principal");
        unknownKinds.add("interest");
      }
    } else if (maturityPayoff !== null) {
      // A supplied payoff is an exact amount even when the contract did not
      // document a maturity total. Its principal/interest classification is
      // still unresolved, so retain it as unclassified.
      unknownExpected += maturityPayoff;
      if (fixedProfit === null) unknownKinds.add("principal");
    } else {
      // The statement-dependent payoff is not documented. Keep the row open
      // even when the fixed return itself is known; amount certainty and
      // component classification are separate facts.
      amountComplete = false;
      unknownKinds.add("principal");
    }
  }
  const amounts: InvestorPaymentAmounts = {
    principalCents: centsFromBigInt(principal),
    interestCents: centsFromBigInt(interest),
    returnOfCapitalCents: centsFromBigInt(returnOfCapital),
    distributionCents: centsFromBigInt(distribution),
    feeCents: centsFromBigInt(ZERO),
    balloonCents: centsFromBigInt(balloon),
    unclassifiedCents: centsFromBigInt(unknownExpected),
  };
  const knownTotal = centsToBigInt(sumPaymentAmounts(amounts));
  // The unclassified installment is a known amount, while an unresolved
  // maturity payoff has no safe total until provider/bank evidence arrives.
  const knownMinimum = knownTotal;
  return {
    amounts,
    totalExpectedCents: amountComplete ? centsFromBigInt(knownTotal) : null,
    knownMinimumCents: centsFromBigInt(knownMinimum),
    amountComplete,
    unknownExpectedCents: centsFromBigInt(unknownExpected),
    unknownComponentKinds: Array.from(unknownKinds),
  };
}

export function calculateMonthlyObligationAmounts(
  terms: InvestorContractTerms,
  openingPrincipalCents: MoneyCents | string | null,
  isMaturity = false,
  period?: InvestorInterestPeriod,
): InvestorPaymentAmounts {
  return calculateInvestorObligation(terms, openingPrincipalCents, isMaturity, period).amounts;
}

export function obligationStatus(input: {
  expectedCents: MoneyCents | string | null;
  recordedCents: MoneyCents | string;
  postedCents: MoneyCents | string;
  settledCents: MoneyCents | string;
  amountComplete?: boolean;
  reversed?: boolean;
  reviewRequired?: boolean;
}): InvestorObligationStatus {
  const recorded = centsToBigInt(input.recordedCents);
  const posted = centsToBigInt(input.postedCents);
  const settled = centsToBigInt(input.settledCents);
  if (input.reversed) return "reversed";
  if (input.reviewRequired) return "review_required";
  if (input.amountComplete === false || input.expectedCents === null) {
    if (settled > ZERO) return "partially_settled";
    if (posted > ZERO) return "partially_posted";
    if (recorded > ZERO) return "partially_recorded";
    return "expected";
  }
  const expected = centsToBigInt(input.expectedCents);
  if (settled >= expected && settled > ZERO) return settled > expected ? "overpaid" : "bank_settled";
  if (posted >= expected && posted > ZERO) return posted > expected ? "overpaid" : "qbo_posted";
  if (recorded >= expected && recorded > ZERO) return recorded > expected ? "overpaid" : "manually_recorded";
  if (settled > ZERO) return "partially_settled";
  if (posted > ZERO) return "partially_posted";
  if (recorded > ZERO) return "partially_recorded";
  return "expected";
}
