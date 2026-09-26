import { z } from "zod";
import {
  centsFromBigInt,
  centsSchema,
  centsToBigInt,
  currencyCodeSchema,
  decimalPower10,
  isoDateSchema,
  parseDecimalParts,
  type MoneyCents,
} from "../company";
import { dueDateForMonth } from "./calculations";
import type {
  InvestorDayCount,
  InvestorInstrumentKind,
  InvestorMonthEndRule,
  InvestorObligationStatus,
  InvestorPaymentAmounts,
  InvestorPaymentKind,
  InvestorPaymentStatus,
  InvestorSchedule,
} from "./contracts";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const cents = centsSchema;
const nullableCents = centsSchema.nullable();
const monthSchema = isoDateSchema.refine((value) => value.endsWith("-01"), "Expected the first day of a calendar month");

function big(value: MoneyCents | string): bigint { return centsToBigInt(value); }
function pow(base: bigint, exponent: number): bigint {
  let result = ONE;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) result *= factor;
    factor *= factor;
    remaining = Math.floor(remaining / 2);
  }
  return result;
}
function out(value: bigint): MoneyCents { return centsFromBigInt(value); }

function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new RangeError("Rounding denominator must be positive");
  const negative = numerator < ZERO;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  if ((absolute % denominator) * TWO >= denominator) quotient += ONE;
  return negative ? -quotient : quotient;
}

export function addMonths(month: string, count: number): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(month);
  if (!match) throw new RangeError("Expected the first day of a calendar month");
  const index = Number(match[1]) * 12 + Number(match[2]) - 1 + count;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function monthDistance(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!);
}

function utcDays(from: string, to: string): bigint {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  return BigInt(days < 0 ? 0 : days);
}

function thirty360(from: string, to: string): bigint {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const days = (ty! - fy!) * 360 + (tm! - fm!) * 30 + Math.min(td!, 30) - Math.min(fd!, 30);
  return BigInt(days < 0 ? 0 : days);
}

/** Interest for one accrual period in exact cents, rounded half away from zero. */
export function periodInterestCents(principal: bigint, annualRate: string, dayCount: InvestorDayCount, startOn: string, endOn: string): bigint {
  if (principal <= ZERO) return ZERO;
  const rate = parseDecimalParts(annualRate);
  if (rate.sign < 0) throw new RangeError("Annual rate cannot be negative");
  const days = dayCount === "30_360" ? thirty360(startOn, endOn) : utcDays(startOn, endOn);
  const basis = dayCount === "actual_365" ? BigInt(365) : BigInt(360);
  return roundHalfAwayFromZero(principal * rate.coefficient * days, decimalPower10(rate.scale) * basis);
}

/**
 * Level payment for a fully amortizing balance: B·r·(1+r)^n / ((1+r)^n − 1)
 * with r = annualRate · intervalMonths / 12, computed on exact rationals.
 */
export function levelPaymentCents(balance: bigint, annualRate: string, periods: number, intervalMonths = 1): bigint {
  if (periods <= 0 || !Number.isSafeInteger(periods)) throw new RangeError("Amortization periods must be a positive integer");
  if (balance <= ZERO) return ZERO;
  const rate = parseDecimalParts(annualRate);
  if (rate.sign < 0) throw new RangeError("Annual rate cannot be negative");
  const a = rate.coefficient * BigInt(intervalMonths);
  const b = decimalPower10(rate.scale) * BigInt(12);
  if (a === ZERO) return roundHalfAwayFromZero(balance, BigInt(periods));
  const growth = pow(a + b, periods);
  const base = pow(b, periods);
  return roundHalfAwayFromZero(balance * a * growth, b * (growth - base));
}

export const AMORTIZATION_PHASES = ["interest_only", "amortizing", "maturity"] as const;
export const amortizationRowSchema = z.object({
  periodMonth: monthSchema,
  dueOn: isoDateSchema,
  phase: z.enum(AMORTIZATION_PHASES),
  openingCents: cents,
  interestCents: cents,
  principalCents: cents,
  balloonCents: cents,
  paymentCents: cents,
  closingCents: cents,
}).strict();
export type AmortizationRow = z.infer<typeof amortizationRowSchema>;
type AmortizationRowInput = z.input<typeof amortizationRowSchema>;

export const amortizationScheduleSchema = z.object({
  status: z.enum(["ready", "principal_unknown", "unsupported_schedule"]),
  principalCents: nullableCents,
  levelPaymentCents: nullableCents,
  computedBalloonCents: nullableCents,
  documentedBalloonCents: nullableCents,
  balloonMatches: z.boolean().nullable(),
  totalInterestCents: cents,
  totalPrincipalCents: cents,
  rows: z.array(amortizationRowSchema).max(600),
  warnings: z.array(z.string().min(1).max(300)).max(20),
}).strict();
export type AmortizationSchedule = z.infer<typeof amortizationScheduleSchema>;

export interface AmortizationInput {
  /** Funded principal at the start of accrual; null keeps the schedule unresolved. */
  readonly principalCents: MoneyCents | string | null;
  readonly annualRate: string;
  readonly schedule: InvestorSchedule;
  readonly paymentDay: number | null;
  readonly monthEndRule: InvestorMonthEndRule;
  readonly accrualStartOn: string;
  readonly firstDueMonth: string | null;
  /** First amortizing month; earlier periods pay interest only. */
  readonly interestOnlyUntil: string | null;
  readonly amortizationMonths: number | null;
  readonly maturityOn: string | null;
  readonly balloonCents: MoneyCents | string | null;
  readonly dayCount: InvestorDayCount;
  readonly maxPeriods?: number;
}

const INTERVAL: Readonly<Record<InvestorSchedule, number>> = { monthly: 1, quarterly: 3, annual: 12, at_maturity: 0, custom: 0 };

/** Scheduled debt service with interest-only periods, level amortization and a maturity balloon. */
export function buildAmortizationSchedule(input: AmortizationInput): AmortizationSchedule {
  const warnings: string[] = [];
  const empty = (status: AmortizationSchedule["status"]) => amortizationScheduleSchema.parse({ status, principalCents: input.principalCents === null ? null : out(big(input.principalCents)), levelPaymentCents: null, computedBalloonCents: null, documentedBalloonCents: input.balloonCents === null ? null : out(big(input.balloonCents)), balloonMatches: null, totalInterestCents: "0", totalPrincipalCents: "0", rows: [], warnings });
  if (input.schedule === "custom") { warnings.push("Custom schedules need an explicit schedule before debt service can be projected."); return empty("unsupported_schedule"); }
  if (input.principalCents === null) { warnings.push("Funded principal is not documented."); return empty("principal_unknown"); }
  const principal = big(input.principalCents);
  const maturityMonth = input.maturityOn ? monthOf(input.maturityOn) : null;
  const rows: AmortizationRowInput[] = [];
  let balance = principal;
  let totalInterest = ZERO;
  let totalPrincipal = ZERO;
  if (input.schedule === "at_maturity") {
    if (!input.maturityOn || !maturityMonth) { warnings.push("An at-maturity schedule needs a maturity date."); return empty("unsupported_schedule"); }
    const interest = periodInterestCents(balance, input.annualRate, input.dayCount, input.accrualStartOn, input.maturityOn);
    rows.push({ periodMonth: maturityMonth, dueOn: input.maturityOn, phase: "maturity", openingCents: out(balance), interestCents: out(interest), principalCents: "0" as MoneyCents, balloonCents: out(balance), paymentCents: out(interest + balance), closingCents: "0" as MoneyCents });
    return finalize(rows, principal, null, balance, interest, balance, input, warnings);
  }
  const interval = INTERVAL[input.schedule];
  const firstDue = input.firstDueMonth ?? addMonths(monthOf(input.accrualStartOn), interval);
  const amortizationStart = input.interestOnlyUntil ?? (input.amortizationMonths === null ? null : firstDue);
  const amortizingPeriods = input.amortizationMonths === null ? null : Math.max(1, Math.ceil(input.amortizationMonths / interval));
  const maxPeriods = Math.min(input.maxPeriods ?? 480, 600);
  let previousDue = input.accrualStartOn;
  let level: bigint | null = null;
  let amortizedCount = 0;
  let computedBalloon: bigint | null = null;
  for (let index = 0; index < maxPeriods && balance > ZERO; index += 1) {
    let periodMonth = addMonths(firstDue, index * interval);
    // Maturity between two scheduled due dates: the loan still ends on its
    // maturity date, with interest from the previous due date and the whole
    // remaining balance as the balloon.
    const offCycleMaturity = maturityMonth !== null && periodMonth > maturityMonth;
    if (offCycleMaturity) periodMonth = maturityMonth!;
    const isMaturity = maturityMonth !== null && periodMonth === maturityMonth;
    const dueOn = isMaturity && input.maturityOn ? input.maturityOn : dueDateForMonth(periodMonth, input.paymentDay, input.monthEndRule);
    const opening = balance;
    const interest = periodInterestCents(opening, input.annualRate, input.dayCount, previousDue, dueOn);
    const amortizing = !offCycleMaturity && amortizationStart !== null && amortizingPeriods !== null && periodMonth >= amortizationStart;
    let principalPart = ZERO;
    if (amortizing) {
      if (level === null) level = levelPaymentCents(opening, input.annualRate, amortizingPeriods!, interval);
      amortizedCount += 1;
      principalPart = amortizedCount >= amortizingPeriods! ? opening : level - interest;
      if (principalPart < ZERO) { warnings.push("A scheduled payment does not cover period interest."); principalPart = ZERO; }
      if (principalPart > opening) principalPart = opening;
    }
    let balloon = ZERO;
    if (isMaturity) { balloon = opening - principalPart; computedBalloon = balloon; }
    balance = opening - principalPart - balloon;
    totalInterest += interest;
    totalPrincipal += principalPart + balloon;
    rows.push({ periodMonth, dueOn, phase: isMaturity ? "maturity" : amortizing ? "amortizing" : "interest_only", openingCents: out(opening), interestCents: out(interest), principalCents: out(principalPart), balloonCents: out(balloon), paymentCents: out(interest + principalPart + balloon), closingCents: out(balance) });
    previousDue = dueOn;
    if (isMaturity) break;
  }
  if (balance > ZERO && maturityMonth === null) warnings.push("No maturity date; the schedule stops at the projection horizon.");
  return finalize(rows, principal, level, computedBalloon, totalInterest, totalPrincipal, input, warnings);
}

function finalize(rows: AmortizationRowInput[], principal: bigint, level: bigint | null, computedBalloon: bigint | null, totalInterest: bigint, totalPrincipal: bigint, input: AmortizationInput, warnings: string[]): AmortizationSchedule {
  const documented = input.balloonCents === null ? null : big(input.balloonCents);
  const matches = documented === null || computedBalloon === null ? null : documented === computedBalloon;
  if (matches === false) warnings.push("The documented balloon differs from the computed remaining principal at maturity.");
  return amortizationScheduleSchema.parse({
    status: "ready", principalCents: out(principal), levelPaymentCents: level === null ? null : out(level),
    computedBalloonCents: computedBalloon === null ? null : out(computedBalloon), documentedBalloonCents: documented === null ? null : out(documented),
    balloonMatches: matches, totalInterestCents: out(totalInterest), totalPrincipalCents: out(totalPrincipal), rows, warnings: Array.from(new Set(warnings)),
  });
}

export interface RollforwardPaymentInput {
  readonly id: string;
  readonly kind: InvestorPaymentKind;
  readonly status: InvestorPaymentStatus;
  readonly paymentOn: string;
  readonly currency: string;
  readonly amountCents: MoneyCents | string;
  readonly amounts: InvestorPaymentAmounts;
  readonly reversesPaymentId: string | null;
}

export interface RollforwardObligationInput {
  readonly periodMonth: string;
  readonly principalCents: MoneyCents | string;
  readonly interestCents: MoneyCents | string;
  readonly balloonCents: MoneyCents | string;
  readonly totalExpectedCents: MoneyCents | string | null;
}

export interface InstrumentRollforwardInput {
  readonly instrumentKind: InvestorInstrumentKind;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly maturityOn: string | null;
  readonly asOf: string;
  /** Documented funded principal, used only when no contribution has been recorded. */
  readonly documentedFundedCents: MoneyCents | string | null;
  readonly manualOutstandingCents: MoneyCents | string | null;
  /** Fixed contractual return that survives prepayment (contract fixed profit). */
  readonly guaranteedReturnCents: MoneyCents | string | null;
  readonly payments: readonly RollforwardPaymentInput[];
  readonly obligations: readonly RollforwardObligationInput[];
  readonly fromMonth: string;
  readonly throughMonth: string;
}

export const rollforwardRowSchema = z.object({
  periodMonth: monthSchema,
  openingCents: nullableCents,
  fundedCents: cents,
  principalRepaidCents: cents,
  returnOfCapitalCents: cents,
  adjustmentCents: cents,
  closingCents: nullableCents,
  expectedPrincipalCents: cents,
  interestExpectedCents: cents,
  interestPaidCents: cents,
  distributionPaidCents: cents,
  unclassifiedCents: cents,
  recordedCents: cents,
  postedCents: cents,
  settledCents: cents,
}).strict();
export type RollforwardRow = z.infer<typeof rollforwardRowSchema>;
type RollforwardRowInput = z.input<typeof rollforwardRowSchema>;

export const OUTSTANDING_RECONCILIATION_STATES = ["matches", "mismatch", "manual_missing", "unknown"] as const;
export const instrumentRollforwardSchema = z.object({
  currency: currencyCodeSchema,
  basis: z.enum(["payments", "documented_funding", "unknown"]),
  rows: z.array(rollforwardRowSchema).max(600),
  openingCents: nullableCents,
  closingCents: nullableCents,
  derivedOutstandingCents: nullableCents,
  manualOutstandingCents: nullableCents,
  differenceCents: nullableCents,
  reconciliation: z.enum(OUTSTANDING_RECONCILIATION_STATES),
  conserved: z.boolean(),
  prepaid: z.boolean(),
  unverifiedPaymentCount: z.number().int().nonnegative(),
  unclassifiedTotalCents: cents,
  guaranteedReturn: z.object({ returnCents: cents, paidCents: cents, remainingCents: cents }).strict().nullable(),
}).strict();
export type InstrumentRollforward = z.infer<typeof instrumentRollforwardSchema>;

interface Flows { funded: bigint; repaid: bigint; roc: bigint; adjustment: bigint; interest: bigint; distribution: bigint; unclassified: bigint; recorded: bigint; posted: bigint; settled: bigint }
const emptyFlows = (): Flows => ({ funded: ZERO, repaid: ZERO, roc: ZERO, adjustment: ZERO, interest: ZERO, distribution: ZERO, unclassified: ZERO, recorded: ZERO, posted: ZERO, settled: ZERO });
const POSTED: ReadonlySet<InvestorPaymentStatus> = new Set<InvestorPaymentStatus>(["qbo_posted", "bank_settled"]);

/**
 * Monthly balance rollforward for one instrument:
 *   closing = opening + funded − principal repaid − return of capital ± adjustments.
 * Reversals are signed rows attributed to the reversed payment's kind, so a
 * reversed payment nets to zero. An unknown bank split (unclassified cents)
 * never reduces principal. The derived outstanding balance is compared with
 * the manual value and a difference is flagged, never overwritten.
 */
export function buildInstrumentRollforward(input: InstrumentRollforwardInput): InstrumentRollforward {
  const currency = currencyCodeSchema.parse(input.currency);
  const asOf = isoDateSchema.parse(input.asOf);
  const fromMonth = monthSchema.parse(input.fromMonth);
  const throughMonth = monthSchema.parse(input.throughMonth);
  if (throughMonth < fromMonth) throw new RangeError("throughMonth must be on or after fromMonth");
  if (monthDistance(fromMonth, throughMonth) > 480) throw new RangeError("Rollforward range is limited to 480 months");
  // Keep the complete history available for resolving reversal links, while
  // applying the requested as-of cutoff to economic flows. A later payoff or
  // correction must never rewrite an earlier balance snapshot.
  const byId = new Map(input.payments.map((payment) => [payment.id, payment]));
  const paymentsAtAsOf = input.payments.filter((payment) => payment.paymentOn <= asOf);
  const monthly = new Map<string, Flows>();
  const before = emptyFlows();
  let allFlows = emptyFlows();
  let contributionCount = 0;
  let unverified = 0;
  for (const payment of paymentsAtAsOf) {
    if (payment.currency !== currency) continue;
    const original = payment.reversesPaymentId ? byId.get(payment.reversesPaymentId) : undefined;
    // A correction cannot take effect before its original payment exists in
    // the as-of view. This also keeps malformed or backdated reversal rows
    // from creating a balance reduction for a future payment.
    if (original && original.paymentOn > asOf) continue;
    const kind = original ? original.kind : payment.kind;
    const amounts = payment.amounts;
    const flows = emptyFlows();
    if (kind === "contribution") { flows.funded = big(payment.amountCents); if (!original) contributionCount += 1; }
    else if (kind === "correction") flows.adjustment = -(big(amounts.principalCents) + big(amounts.balloonCents));
    else { flows.repaid = big(amounts.principalCents) + big(amounts.balloonCents); flows.roc = big(amounts.returnOfCapitalCents); }
    if (kind !== "contribution") { flows.interest = big(amounts.interestCents); flows.distribution = big(amounts.distributionCents); flows.unclassified = big(amounts.unclassifiedCents); }
    flows.recorded = big(payment.amountCents);
    const evidenceStatus = original ? original.status : payment.status;
    if (POSTED.has(evidenceStatus)) flows.posted = big(payment.amountCents);
    if (evidenceStatus === "bank_settled") flows.settled = big(payment.amountCents);
    if (!original && payment.status === "manual_recorded") unverified += 1;
    const month = monthOf(payment.paymentOn);
    const target = month < fromMonth ? before : month > throughMonth ? null : monthly.get(month) ?? emptyFlows();
    if (target) { addFlows(target, flows); if (target !== before) monthly.set(month, target); }
    allFlows = addFlows(allFlows, flows);
  }
  const basis: InstrumentRollforward["basis"] = contributionCount > 0 ? "payments" : input.documentedFundedCents !== null ? "documented_funding" : "unknown";
  const documentedFunding = basis === "documented_funding" ? big(input.documentedFundedCents!) : ZERO;
  const fundingMonth = monthOf(input.effectiveFrom);
  if (basis === "documented_funding" && input.effectiveFrom <= asOf) {
    if (fundingMonth < fromMonth) before.funded += documentedFunding;
    else if (fundingMonth <= throughMonth) { const flows = monthly.get(fundingMonth) ?? emptyFlows(); flows.funded += documentedFunding; monthly.set(fundingMonth, flows); }
    allFlows.funded += documentedFunding;
  }
  const expected = new Map<string, { principal: bigint; interest: bigint }>();
  for (const obligation of input.obligations) {
    const current = expected.get(obligation.periodMonth) ?? { principal: ZERO, interest: ZERO };
    current.principal += big(obligation.principalCents) + big(obligation.balloonCents);
    current.interest += big(obligation.interestCents);
    expected.set(obligation.periodMonth, current);
  }
  const known = basis !== "unknown";
  const opening = known ? before.funded - before.repaid - before.roc + before.adjustment : null;
  let balance = opening;
  const rows: RollforwardRowInput[] = [];
  let flowSum = ZERO;
  for (let month: string = fromMonth; month <= throughMonth; month = addMonths(month, 1)) {
    const flows = monthly.get(month) ?? emptyFlows();
    const change = flows.funded - flows.repaid - flows.roc + flows.adjustment;
    flowSum += change;
    const rowOpening = balance;
    balance = balance === null ? null : balance + change;
    const plan = expected.get(month) ?? { principal: ZERO, interest: ZERO };
    rows.push({
      periodMonth: month, openingCents: rowOpening === null ? null : out(rowOpening), fundedCents: out(flows.funded), principalRepaidCents: out(flows.repaid),
      returnOfCapitalCents: out(flows.roc), adjustmentCents: out(flows.adjustment), closingCents: balance === null ? null : out(balance),
      expectedPrincipalCents: out(plan.principal), interestExpectedCents: out(plan.interest), interestPaidCents: out(flows.interest), distributionPaidCents: out(flows.distribution),
      unclassifiedCents: out(flows.unclassified), recordedCents: out(flows.recorded), postedCents: out(flows.posted), settledCents: out(flows.settled),
    });
  }
  const derived = known ? allFlows.funded - allFlows.repaid - allFlows.roc + allFlows.adjustment : null;
  const conserved = opening === null || balance === null ? true : balance === opening + flowSum;
  const manual = input.manualOutstandingCents === null ? null : big(input.manualOutstandingCents);
  const isDebt = input.instrumentKind === "private_loan" || input.instrumentKind === "member_loan";
  const reconciliation: InstrumentRollforward["reconciliation"] = derived === null ? "unknown" : !isDebt ? "unknown" : manual === null ? "manual_missing" : manual === derived ? "matches" : "mismatch";
  const prepaid = derived !== null && derived === ZERO && allFlows.funded > ZERO && (input.maturityOn === null || input.asOf < input.maturityOn);
  const guaranteed = input.guaranteedReturnCents === null ? null : (() => {
    const promised = big(input.guaranteedReturnCents!);
    const paid = allFlows.interest + allFlows.distribution;
    return { returnCents: out(promised), paidCents: out(paid), remainingCents: out(promised > paid ? promised - paid : ZERO) };
  })();
  return instrumentRollforwardSchema.parse({
    currency, basis, rows, openingCents: opening === null ? null : out(opening), closingCents: balance === null ? null : out(balance),
    derivedOutstandingCents: derived === null ? null : out(derived), manualOutstandingCents: manual === null ? null : out(manual),
    differenceCents: derived === null || manual === null ? null : out(manual - derived), reconciliation, conserved, prepaid,
    unverifiedPaymentCount: unverified, unclassifiedTotalCents: out(allFlows.unclassified), guaranteedReturn: guaranteed,
  });
}

function addFlows(target: Flows, flows: Flows): Flows {
  target.funded += flows.funded; target.repaid += flows.repaid; target.roc += flows.roc; target.adjustment += flows.adjustment;
  target.interest += flows.interest; target.distribution += flows.distribution; target.unclassified += flows.unclassified;
  target.recorded += flows.recorded; target.posted += flows.posted; target.settled += flows.settled;
  return target;
}

export const INVESTOR_CALENDAR_STATES = ["scheduled", "overdue", "partial", "recorded", "posted", "settled", "overpaid", "review", "reversed"] as const;
export type InvestorCalendarState = (typeof INVESTOR_CALENDAR_STATES)[number];
export const investorCalendarStateSchema = z.enum(INVESTOR_CALENDAR_STATES);

/** Payment calendar state. Scheduled is explicit future state; posting is not settlement. */
export function investorCalendarState(obligation: { readonly status: InvestorObligationStatus; readonly dueOn: string }, today: string): InvestorCalendarState {
  switch (obligation.status) {
    case "expected": return obligation.dueOn < today ? "overdue" : "scheduled";
    case "partially_recorded": case "partially_posted": case "partially_settled": return "partial";
    case "manually_recorded": return "recorded";
    case "qbo_posted": return "posted";
    case "bank_settled": return "settled";
    case "overpaid": return "overpaid";
    case "review_required": return "review";
    case "reversed": return "reversed";
  }
}
