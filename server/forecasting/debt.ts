import type { LoanTerms } from "../../shared/forecasting/assumptions";
import { addMonthsToDate, dayNumber } from "../../shared/forecasting/calendar";
import { ZERO, divideHalfEven, levelPayment, maxBig, minBig } from "./money";

export interface LoanRow {
  readonly date: string;
  readonly interest: bigint;
  /** Positive reduces the balance (payment); negative increases it (funding or draw). */
  readonly principal: bigint;
  readonly balance: bigint;
  readonly kind: "scheduled" | "balloon" | "payoff" | "draw";
}

export interface LoanScheduleInput {
  readonly terms: LoanTerms;
  /** Balance at the start of the first accrual period (0 for a loan funded later). */
  readonly openingBalance: bigint;
  /** Exclusive start of the first accrual period. */
  readonly accrualStart: string;
  /** Fundings and construction draws, positive amounts. */
  readonly draws: readonly { readonly date: string; readonly amount: bigint }[];
  readonly payoffOn?: string;
}

export interface LoanSchedule {
  readonly rows: readonly LoanRow[];
  readonly balloon: bigint | null;
  readonly paidOffOn: string | null;
  readonly level: bigint | null;
}

/** US 30/360 day count between two dates (end exclusive of start). */
export function days360(from: string, to: string): number {
  const [y1, m1, rawD1] = from.split("-").map(Number) as [number, number, number];
  const [y2, m2, rawD2] = to.split("-").map(Number) as [number, number, number];
  const d1 = Math.min(rawD1, 30);
  const d2 = rawD2 === 31 && d1 === 30 ? 30 : rawD2;
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
}

function dayCount(terms: LoanTerms, from: string, to: string): number {
  return terms.dayCount === "30_360" ? days360(from, to) : dayNumber(to) - dayNumber(from);
}

function basis(terms: LoanTerms): bigint {
  return BigInt(terms.dayCount === "actual_365" ? 365 : 360);
}

/** Payment dates from the first payment through maturity (maturity is always the last). */
export function paymentDates(terms: LoanTerms): string[] {
  const dates: string[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const date = addMonthsToDate(terms.firstPaymentOn, index, terms.paymentDay);
    if (date >= terms.maturityOn) break;
    dates.push(date);
  }
  dates.push(terms.maturityOn);
  return dates;
}

/**
 * Build a loan schedule to maturity (or payoff), independent of the view
 * horizon so balloons are never truncated. Interest accrues on the exact
 * daily balance between payment dates and rounds once per period, half to
 * even; principal is the level payment less interest, so P + I is exact.
 */
export function buildLoanSchedule(input: LoanScheduleInput): LoanSchedule {
  const { terms } = input;
  const rate = BigInt(terms.annualRateBps);
  const denominator = BigInt(10_000) * basis(terms);
  const draws = [...input.draws].filter(draw => draw.amount > ZERO).sort((left, right) => left.date < right.date ? -1 : left.date > right.date ? 1 : 0);
  const rows: LoanRow[] = [];
  let balance = input.openingBalance;
  let previous = input.accrualStart;
  let level: bigint | null = null;
  let drawIndex = 0;
  const payoffOn = input.payoffOn && input.payoffOn <= terms.maturityOn ? input.payoffOn : undefined;
  const dates = paymentDates(terms).filter(date => date > input.accrualStart);
  const events: { date: string; kind: "pay" | "payoff" }[] = [];
  for (const date of dates) {
    if (payoffOn && date >= payoffOn) break;
    events.push({ date, kind: "pay" });
  }
  if (payoffOn) events.push({ date: payoffOn, kind: "payoff" });

  const accrue = (to: string): bigint => {
    // Sum balance × days over sub-intervals split at draw dates in (previous, to].
    let numerator = ZERO;
    let cursor = previous;
    while (drawIndex < draws.length && draws[drawIndex]!.date <= to) {
      const draw = draws[drawIndex]!;
      if (draw.date > cursor) {
        numerator += balance * BigInt(dayCount(terms, cursor, draw.date));
        cursor = draw.date;
      }
      balance += draw.amount;
      rows.push({ date: draw.date, interest: ZERO, principal: -draw.amount, balance, kind: "draw" });
      drawIndex += 1;
    }
    numerator += balance * BigInt(Math.max(0, dayCount(terms, cursor, to)));
    return divideHalfEven(numerator * rate, denominator);
  };

  for (const event of events) {
    const interest = accrue(event.date);
    previous = event.date;
    if (event.kind === "payoff") {
      rows.push({ date: event.date, interest, principal: balance, balance: ZERO, kind: "payoff" });
      balance = ZERO;
      break;
    }
    const final = event.date === terms.maturityOn;
    const amortizing = terms.amortizationMonths !== undefined && (terms.interestOnlyUntil === undefined || event.date > terms.interestOnlyUntil);
    let principal = ZERO;
    if (amortizing) {
      if (level === null) level = levelPayment(balance, terms.annualRateBps, terms.amortizationMonths!);
      principal = minBig(maxBig(level - interest, ZERO), balance);
    }
    if (final) {
      const regular = principal;
      principal = balance;
      balance = ZERO;
      rows.push({ date: event.date, interest, principal, balance, kind: principal > regular ? "balloon" : "scheduled" });
      break;
    }
    balance -= principal;
    rows.push({ date: event.date, interest, principal, balance, kind: "scheduled" });
  }
  // Draws dated after the last payment still fund the loan in the schedule.
  while (drawIndex < draws.length && (!payoffOn || draws[drawIndex]!.date <= payoffOn) && draws[drawIndex]!.date <= terms.maturityOn) {
    const draw = draws[drawIndex]!;
    balance += draw.amount;
    rows.push({ date: draw.date, interest: ZERO, principal: -draw.amount, balance, kind: "draw" });
    drawIndex += 1;
  }
  const last = rows.at(-1);
  const balloonRow = last && last.date === terms.maturityOn && last.kind !== "payoff" && last.kind !== "draw" ? last : undefined;
  return {
    rows,
    balloon: balloonRow ? balloonRow.principal : null,
    paidOffOn: payoffOn ?? null,
    level,
  };
}

/** Balance immediately after all rows dated on or before `date`. */
export function balanceOn(schedule: LoanSchedule, openingBalance: bigint, date: string): bigint {
  let balance = openingBalance;
  for (const row of schedule.rows) {
    if (row.date > date) break;
    balance = row.balance;
  }
  return balance;
}
