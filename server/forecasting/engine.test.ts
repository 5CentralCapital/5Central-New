import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { addDays, monthlyPeriods, periodIndexFor, weeklyPeriods } from "../../shared/forecasting/calendar";
import type { ForecastEvent, ForecastResult } from "../../shared/forecasting/result";
import { ForecastInputError, modeledProceedsViolations, runForecast, weeklyMonthlyDisagreements } from "./engine";
import { buildLoanSchedule, days360 } from "./debt";
import { allocate, applyBps, divideHalfEven, levelPayment, prorate } from "./money";
import { SYNTHETIC_FORECAST_CUTOFF, syntheticEngineInput } from "./testing/fixture";
import { forecastReportBounds, forecastReportRows } from "./reporting-port";

const big = (value: string | undefined | null) => BigInt(value ?? "0");
const run = (...args: Parameters<typeof syntheticEngineInput>) => runForecast(syntheticEngineInput(...args));
const lineTotal = (event: ForecastEvent, account: string) => event.entries.filter(entry => entry.a === account).reduce((total, entry) => total + big(entry.c), BigInt(0));
const cashOf = (event: ForecastEvent) => lineTotal(event, "cash_operating") + lineTotal(event, "cash_restricted");

function assertAllChecks(result: ForecastResult) {
  const failed = result.checks.filter(check => !check.passed);
  assert.deepEqual(failed, [], JSON.stringify(failed));
}

test("rounding is half to even and allocations conserve their total", () => {
  assert.equal(divideHalfEven(BigInt(5), BigInt(2)), BigInt(2));
  assert.equal(divideHalfEven(BigInt(7), BigInt(2)), BigInt(4));
  assert.equal(divideHalfEven(BigInt(-5), BigInt(2)), BigInt(-2));
  assert.equal(divideHalfEven(BigInt(-7), BigInt(2)), BigInt(-4));
  assert.equal(applyBps(BigInt(12345), 250), BigInt(309)); // 308.625
  assert.equal(prorate(BigInt(100000), 10, 31), BigInt(32258));
  const parts = allocate(BigInt(1000001), [3, 7, 7, 7, 1]);
  assert.equal(parts.reduce((total, part) => total + part, BigInt(0)), BigInt(1000001));
  assert.deepEqual(allocate(BigInt(-10), [1, 1, 1]).reduce((total, part) => total + part, BigInt(0)), BigInt(-10));
  // $100,000 at 6% over 30 years: $599.55.
  assert.equal(levelPayment(BigInt(10_000_000), 600, 360), BigInt(59_955));
  assert.equal(levelPayment(BigInt(1200), 0, 12), BigInt(100));
  assert.equal(days360("2027-01-31", "2027-02-28"), 28);
  assert.equal(days360("2027-01-01", "2027-02-01"), 30);
});

test("weekly and monthly periods do not overlap and bucket Jan 1 exactly once", () => {
  const weeks = weeklyPeriods("2026-12-28", 13);
  const months = monthlyPeriods("2026-12-28", 3);
  assert.equal(weeks[0]!.end, "2027-01-03");
  assert.equal(months[0]!.start, "2026-12-28");
  assert.equal(months[0]!.end, "2026-12-31");
  assert.equal(months[1]!.start, "2027-01-01");
  assert.equal(periodIndexFor(weeks, "2027-01-01"), 0);
  assert.equal(periodIndexFor(months, "2027-01-01"), 1);
  assert.equal(periodIndexFor(months, "2026-12-31"), 0);
  for (let index = 1; index < weeks.length; index += 1) assert.equal(weeks[index]!.start, addDays(weeks[index - 1]!.end, 1));
  assert.throws(() => weeklyPeriods("2026-12-29", 13), /Monday/);
});

test("the base scenario passes every accounting invariant", () => {
  const result = run();
  assertAllChecks(result);
  assert.equal(result.weeks.length, 13);
  assert.equal(result.months.length, 24);
  for (const month of result.months) {
    assert.equal(big(month.totalAssetsCents), big(month.totalLiabilitiesCents) + big(month.totalEquityCents), `balance sheet balances in ${month.month}`);
    assert.equal(big(month.cashFlow.openingCashCents) + big(month.cashFlow.indirectNetChangeCents), big(month.cashFlow.closingCashCents));
    assert.equal(month.cashFlow.directNetChangeCents, month.cashFlow.indirectNetChangeCents, `direct = indirect in ${month.month}`);
    assert.equal(big(month.balance.cash_operating) + big(month.balance.cash_restricted), big(month.cashFlow.closingCashCents));
    assert.ok(big(month.balance.deposits_held) >= BigInt(0), "deposits remain a liability");
  }
  for (const [index, week] of result.weeks.entries()) {
    assert.equal(big(week.openingCashCents) + big(week.inflowsCents) - big(week.outflowsCents), big(week.closingCashCents));
    if (index > 0) assert.equal(week.openingCashCents, result.weeks[index - 1]!.closingCashCents);
    assert.equal(big(week.availableClosingCents) + big(week.restrictedClosingCents), big(week.closingCashCents));
  }
  // Retained earnings roll forward by net income with no plug.
  let retained = BigInt(0);
  const prePeriod = result.events.filter(event => event.date < result.scenario.startDate);
  assert.equal(prePeriod.length, 0, "cutoff is the day before the start in this fixture");
  for (const month of result.months) {
    retained += big(month.netIncomeCents);
    assert.equal(big(month.balance.retained_earnings), retained);
  }
  // Every event is a balanced journal.
  for (const event of result.events) assert.equal(event.entries.reduce((total, entry) => total + big(entry.c), BigInt(0)), BigInt(0), event.id);
});

test("the same inputs reproduce the same result hash; changed inputs do not", () => {
  const first = run();
  const second = run();
  assert.equal(canonicalJsonSha256(first), canonicalJsonSha256(second));
  const changed = run(draft => { draft.leasing!.badDebtBps = 200; });
  assert.notEqual(canonicalJsonSha256(first), canonicalJsonSha256(changed));
});

test("the week straddling Jan 1 and the month boundary counts each cash event once", () => {
  const result = run();
  const weeks = weeklyPeriods(result.scenario.startDate, 13);
  const months = monthlyPeriods(result.scenario.startDate, 24);
  const first = result.weeks[0]!;
  const eventsInFirstWeek = result.events.filter(event => event.date >= first.start && event.date <= first.end);
  assert.ok(eventsInFirstWeek.some(event => event.date === "2027-01-01"), "Jan 1 events land in the first week");
  assert.equal(eventsInFirstWeek.reduce((total, event) => total + cashOf(event), BigInt(0)), big(first.netCents));
  const december = result.months[0]!;
  const january = result.months[1]!;
  const januaryFirst = result.events.filter(event => event.date === "2027-01-01");
  assert.ok(januaryFirst.length > 0);
  const decemberCash = result.events.filter(event => event.date >= december.start && event.date <= december.end).reduce((total, event) => total + cashOf(event), BigInt(0));
  assert.equal(decemberCash, big(december.cashFlow.directNetChangeCents));
  assert.equal(big(january.cashFlow.openingCashCents), big(december.cashFlow.closingCashCents));
  // Summing either view over the weekly horizon gives the same movement.
  const lastWeekEnd = weeks.at(-1)!.end;
  const byMonth = new Map<number, bigint>();
  for (const event of result.events) if (event.date <= lastWeekEnd) byMonth.set(periodIndexFor(months, event.date), (byMonth.get(periodIndexFor(months, event.date)) ?? BigInt(0)) + cashOf(event));
  const weekTotal = result.weeks.reduce((total, week) => total + big(week.netCents), BigInt(0));
  assert.equal(Array.from(byMonth.values()).reduce((total, value) => total + value, BigInt(0)), weekTotal);
  assert.ok(!byMonth.has(-1));
});

test("unknown opening items are listed and excluded, never zero", () => {
  const result = run();
  const investor = result.opening.items.find(item => item.key === "investor_obligations")!;
  assert.equal(investor.state, "unknown");
  assert.equal(investor.amountCents, null);
  assert.deepEqual(result.opening.unknown, ["Investor obligations due"]);
  assert.equal(result.completeness, "partial");
  assert.equal(result.opening.balances.investor_payable, "0");
  assert.ok(!result.events.some(event => event.ref === "opening.investor_obligations"));
  // An approved manual starting balance keeps its author and reason and completes the position.
  const overridden = run(draft => {
    draft.overrides = [{ id: "ov-inv", kind: "opening_balance", item: "investor_obligations", amountCents: "125000", asOf: SYNTHETIC_FORECAST_CUTOFF, reason: "Per signed note schedule", author: "demo-admin", setOn: "2026-12-28" }];
  });
  const item = overridden.opening.items.find(entry => entry.key === "investor_obligations")!;
  assert.equal(item.state, "manual");
  assert.equal(item.amountCents, "125000");
  assert.match(item.source, /demo-admin: Per signed note schedule/);
  assert.equal(overridden.completeness, "complete");
  assert.equal(overridden.opening.balances.investor_payable, "125000");
  assertAllChecks(overridden);
});

test("principal is not an expense and interest agrees with the loan schedules", () => {
  const result = run();
  const payments = result.events.filter(event => event.kind === "loan_payment" || event.kind === "loan_payoff");
  assert.ok(payments.length > 0);
  const principal = payments.reduce((total, event) => total + lineTotal(event, "debt"), BigInt(0));
  assert.ok(principal > BigInt(0));
  for (const event of result.events) {
    for (const entry of event.entries) {
      if (entry.a === "debt") assert.ok(["loan_payment", "loan_payoff", "loan_funding", "project_draw"].includes(event.kind), `${event.kind} touches debt`);
    }
  }
  const schedules = result.debt.loans;
  for (const month of result.months) {
    const scheduleInterest = schedules.flatMap(loan => loan.payments).filter(row => row.date >= month.start && row.date <= month.end).reduce((total, row) => total + big(row.interestCents), BigInt(0));
    assert.equal(big(month.income.interest_expense), scheduleInterest, `interest in ${month.month}`);
  }
  const amortizing = schedules.find(loan => loan.loanId === "loan-a")!;
  for (const row of amortizing.payments.filter(item => item.kind === "scheduled")) {
    assert.equal(big(row.interestCents) + big(row.principalCents), big(amortizing.payments[0]!.interestCents) + big(amortizing.payments[0]!.principalCents), "level P&I");
  }
  // The balloon beyond the 24-month view is still in the schedule.
  assert.equal(amortizing.maturityOn, "2029-06-01");
  const last = amortizing.payments.at(-1)!;
  assert.equal(last.kind, "balloon");
  assert.equal(last.balanceCents, "0");
  assert.equal(amortizing.balloonCents, last.principalCents);
  assert.ok(result.debt.ladder.some(row => row.year === "2029" && big(row.maturingCents) === big(last.principalCents)));
});

test("housing assistance is part of contract rent and is not double counted", () => {
  const result = run();
  const charges = result.events.filter(event => event.kind === "rent_charge" && event.id.startsWith("rent:a-1:"));
  assert.ok(charges.length >= 3);
  for (const charge of charges.slice(0, 3)) {
    assert.equal(-lineTotal(charge, "rental_income_tenant"), BigInt(90_000));
    assert.equal(-lineTotal(charge, "rental_income_subsidy"), BigInt(60_000));
  }
  const subsidyCharged = result.events.filter(event => event.kind === "rent_charge").reduce((total, event) => total - lineTotal(event, "rental_income_subsidy"), BigInt(0));
  const subsidyCollected = result.events.filter(event => event.kind === "subsidy_collection").reduce((total, event) => total - lineTotal(event, "subsidy_receivable"), BigInt(0));
  assert.ok(subsidyCollected <= subsidyCharged);
  // Prorated first-month rent with a subsidy still sums exactly to the prorated charge.
  const firstNew = result.events.find(event => event.kind === "rent_charge" && event.id.startsWith("rent:b-1:"))!;
  const total = -(lineTotal(firstNew, "rental_income_tenant") + lineTotal(firstNew, "rental_income_subsidy"));
  assert.equal(lineTotal(firstNew, "rent_receivable") + lineTotal(firstNew, "subsidy_receivable"), total);
});

test("deposits are liabilities that move with leases, returns and transfers", () => {
  const result = run();
  const moveOut = result.events.find(event => event.kind === "deposit_returned" && event.id.startsWith("deposit-out:a-2:"))!;
  assert.equal(moveOut.date, "2027-03-15");
  assert.equal(lineTotal(moveOut, "deposits_held"), BigInt(140_000));
  const received = result.events.filter(event => event.kind === "deposit_received");
  assert.ok(received.length >= 2);
  for (const event of received) assert.ok(lineTotal(event, "deposits_held") < BigInt(0), "a received deposit credits a liability");
  for (const event of result.events) {
    if (event.entries.some(entry => entry.a === "deposits_held")) assert.ok(!event.entries.some(entry => entry.a.startsWith("rental_income")), "deposits never become revenue");
  }
});

test("moving a project completion date shifts readiness, rent, costs and cash coherently", () => {
  const base = run();
  const later = run(draft => { draft.projects![0]!.completionOn = "2027-06-30"; });
  assertAllChecks(later);
  const firstRent = (result: ForecastResult) => result.events.find(event => event.kind === "rent_charge" && event.id.startsWith("rent:b-1:"))!.date;
  // Ready = completion + 10 make-ready days; lease = ready + 20 vacancy days.
  assert.equal(firstRent(base), "2027-05-30");
  assert.equal(firstRent(later), "2027-07-30");
  const projectCip = (result: ForecastResult, kind: string) => result.events.filter(event => event.ref === "projects[proj-b]" && event.kind === kind)
    .reduce((total, event) => total + lineTotal(event, "cip"), BigInt(0));
  const projectCost = (result: ForecastResult) => projectCip(result, "project_cost") + projectCip(result, "project_labor");
  const laborActual = BigInt(90_000);
  // Non-labor cost is conserved exactly whatever the schedule; only the week
  // with approved time loses its labor estimate.
  assert.equal(projectCip(base, "project_cost"), BigInt(2_600_000));
  assert.equal(projectCip(later, "project_cost"), BigInt(2_600_000));
  assert.ok(projectCip(base, "project_labor") < BigInt(400_000));
  assert.ok(projectCip(later, "project_labor") < BigInt(400_000));
  const lastCostDate = (result: ForecastResult) => result.events.filter(event => event.ref === "projects[proj-b]" && event.kind === "project_cost").at(-1)!.date;
  assert.equal(lastCostDate(base), "2027-04-30");
  assert.equal(lastCostDate(later), "2027-06-30");
  const placed = (result: ForecastResult) => result.events.find(event => event.kind === "project_complete")!;
  assert.equal(placed(base).date, "2027-04-30");
  assert.equal(placed(later).date, "2027-06-30");
  assert.equal(lineTotal(placed(base), "fixed_assets"), BigInt(500_000) + projectCost(base) + laborActual);
  const firstDepreciation = (result: ForecastResult) => result.events.find(event => event.id.startsWith("depreciation:project:proj-b:"))!.date;
  assert.equal(firstDepreciation(base), "2027-05-31");
  assert.equal(firstDepreciation(later), "2027-07-31");
  const juneRevenue = (result: ForecastResult) => big(result.months.find(month => month.month === "2027-06")!.income.rental_income_tenant);
  assert.ok(juneRevenue(base) > juneRevenue(later), "delayed readiness delays rent");
  const cashAt = (result: ForecastResult, month: string) => big(result.months.find(item => item.month === month)!.cashFlow.closingCashCents);
  assert.notEqual(cashAt(base, "2027-03"), cashAt(later, "2027-03"), "cost timing changes liquidity");
});

test("approved time replaces estimated labor for the same week and never duplicates it", () => {
  const result = run();
  assertAllChecks(result);
  const projectWeek = result.events.filter(event => event.ref === "projects[proj-b]" && event.kind === "project_labor" && event.date >= "2027-01-11" && event.date <= "2027-01-17");
  assert.equal(projectWeek.length, 0, "estimate dropped in the week with approved time");
  assert.ok(result.events.some(event => event.id === "labor-actual:ta-1"));
  const maintWeek = result.events.filter(event => event.ref === "expenses[maint]" && event.date >= "2027-01-04" && event.date <= "2027-01-10");
  assert.equal(maintWeek.length, 0);
  assert.equal(result.events.filter(event => event.id === "labor-actual:ta-2").length, 1);
  assert.ok(!result.events.some(event => event.ref === "expenses[old-labor]"), "retired labor stays retired");
  assert.ok(result.warnings.some(warning => warning.code === "retired_item_excluded"));
  const withoutActuals = run(draft => { draft.timeActuals = []; });
  const estimateWeeks = withoutActuals.events.filter(event => event.ref === "projects[proj-b]" && event.kind === "project_labor" && event.date >= "2027-01-11" && event.date <= "2027-01-17");
  assert.equal(estimateWeeks.length, 1);
});

test("refinance proceeds are modeled, net of payoff, costs and reserves, and never actual cash", () => {
  const result = run();
  const refinance = result.capital.refinances[0]!;
  const payoff = result.events.find(event => event.id === "payoff:loan-b")!;
  assert.equal(big(refinance.payoffCents), -cashOf(payoff));
  assert.equal(big(refinance.netUsableCents), big(refinance.grossProceedsCents) - big(refinance.payoffCents) - big(refinance.costsCents) - big(refinance.reservesCents));
  const funding = result.events.find(event => event.id === "refinance:refi-b:funding")!;
  assert.equal(funding.modeled, true);
  const reserve = result.events.find(event => event.id === "refinance:refi-b:reserves")!;
  assert.equal(lineTotal(reserve, "cash_restricted"), BigInt(150_000));
  assert.ok(result.events.filter(event => event.kind === "project_draw").every(event => event.modeled));
  // The opening (actual) cash is the sourced amount only.
  assert.equal(result.opening.balances.cash_operating, "12000000");
  // A refinance dated inside the actual period is excluded, not counted.
  const early = run(draft => { draft.refinances![0]!.closeOn = "2026-12-01"; });
  assert.equal(early.capital.refinances[0]!.excluded, true);
  assert.ok(!early.events.some(event => event.ref === "refinances[refi-b]"));
  assert.ok(early.warnings.some(warning => warning.code === "modeled_event_before_cutoff"));
  assertAllChecks(early);
});

test("a sale removes book value, pays off debt, transfers deposits and stops operations", () => {
  const result = run(draft => {
    draft.sales = [{ id: "sell-a", label: "Sell Example Court", propertyId: "prop-a", closeOn: "2028-03-01", priceCents: "110000000", sellingCostsCents: "3300000", payoffLoanIds: ["loan-a"], transferDeposits: true }];
  });
  assertAllChecks(result);
  const sale = result.capital.sales[0]!;
  assert.equal(big(sale.gainCents), big(sale.priceCents) - big(sale.sellingCostsCents) - big(sale.netBookValueCents));
  const saleEvent = result.events.find(event => event.id === "sale:sell-a")!;
  assert.equal(saleEvent.modeled, true);
  assert.ok(!result.events.some(event => event.kind === "rent_charge" && event.id.startsWith("rent:a-") && event.date >= "2028-03-01"));
  assert.ok(!result.events.some(event => event.ref === "expenses[util-a]" && event.kind === "expense_incurred" && event.date >= "2028-03-01"));
  assert.ok(result.events.some(event => event.id === "payoff:loan-a"));
  const transfers = result.events.filter(event => event.kind === "deposit_transfer");
  assert.equal(transfers.reduce((total, event) => total + lineTotal(event, "deposits_held"), BigInt(0)), big(sale.depositsTransferredCents));
  const march = result.months.find(month => month.month === "2028-03")!;
  assert.ok(big(march.balance.fixed_assets) < BigInt(90_000_000), "sold property's basis is removed");
  const investingGain = march.cashFlow.investing.find(line => line.key === "gain_on_sale");
  assert.equal(big(investingGain?.cents), big(sale.gainCents));
});

test("owner planning cash never enters company statements", () => {
  const withOwner = run();
  const withoutOwner = run(draft => { draft.ownerItems = []; });
  assert.ok(withOwner.owner);
  assert.equal(withoutOwner.owner, null);
  const { owner: _a, ...company } = withOwner;
  const { owner: _b, ...companyWithout } = withoutOwner;
  assert.equal(canonicalJsonSha256(company), canonicalJsonSha256(companyWithout));
  assert.equal(withOwner.owner!.months[1]!.netCents, "-250000");
});

test("overrides replace a driver in one period with their reason preserved", () => {
  const result = run(draft => {
    draft.overrides = [
      { id: "ov-rent", kind: "unit_rent", unitId: "b-2", month: "2027-02", amountCents: "100000", reason: "Agreed hardship reduction", author: "demo-admin", setOn: "2026-12-28" },
      { id: "ov-util", kind: "expense_amount", expenseId: "util-a", month: "2027-02", amountCents: "60000", reason: "Leak repair surcharge", author: "demo-admin", setOn: "2026-12-28" },
    ];
  });
  assertAllChecks(result);
  const february = result.events.find(event => event.id === "rent:b-2:2027-02-01")!;
  assert.equal(-lineTotal(february, "rental_income_tenant"), BigInt(100_000));
  assert.equal(february.ref, "overrides[unit_rent:b-2:2027-02]");
  const march = result.events.find(event => event.id === "rent:b-2:2027-03-01")!;
  assert.equal(-lineTotal(march, "rental_income_tenant"), BigInt(120_000));
  const utility = result.events.find(event => event.id === "expense:util-a:2027-02-15")!;
  assert.equal(lineTotal(utility, "opex_utilities"), BigInt(60_000));
});

test("existing tenancies are not recharged for the month already billed before the cutoff", () => {
  const result = run(undefined, { startDate: "2027-01-11" });
  // Cutoff is Dec 27 and start Jan 11: the gap (Dec 28 – Jan 10) is forecast and rolls into the opening of the view.
  assert.ok(result.events.some(event => event.id === "rent:b-2:2027-01-01"));
  assert.ok(!result.events.some(event => event.id.startsWith("rent:b-2:2026-12")));
  assertAllChecks(result);
  assert.notEqual(result.weeks[0]!.openingCashCents, "13000000", "the view opens after the gap's forecast events");
});

test("invalid scenario inputs are refused with stable codes", () => {
  assert.throws(() => run(undefined, { startDate: "2026-12-29" }), (error: unknown) => error instanceof ForecastInputError && error.code === "forecast_start_not_monday");
  assert.throws(() => run(draft => { draft.actualsCutoff = "2026-12-28"; }), (error: unknown) => error instanceof ForecastInputError && error.code === "forecast_cutoff_after_start");
  assert.throws(() => run(draft => { draft.leasing!.collectionsBps = 9_950; draft.leasing!.badDebtBps = 100; }), /100%/);
  assert.throws(() => run(draft => { draft.units![0]!.propertyId = "missing"; }), /Unknown property/);
});

test("loan schedules accrue interest on draws by actual days and pay off exactly", () => {
  const schedule = buildLoanSchedule({
    terms: { label: "Line", principalCents: "0", annualRateBps: 900, dayCount: "actual_360", paymentDay: 1, firstPaymentOn: "2027-02-01", maturityOn: "2027-06-01", escrowMonthlyCents: "0" } as never,
    openingBalance: BigInt(0), accrualStart: "2027-01-01",
    draws: [{ date: "2027-01-11", amount: BigInt(1_000_000) }, { date: "2027-01-21", amount: BigInt(500_000) }],
    payoffOn: "2027-04-15",
  });
  const first = schedule.rows.find(row => row.kind === "scheduled")!;
  // 1,000,000 × 10 days + 1,500,000 × 11 days at 9% / 360.
  assert.equal(first.interest, divideHalfEven(BigInt(1_000_000 * 10 + 1_500_000 * 11) * BigInt(900), BigInt(3_600_000)));
  const payoff = schedule.rows.at(-1)!;
  assert.equal(payoff.kind, "payoff");
  assert.equal(payoff.principal, BigInt(1_500_000));
  assert.equal(payoff.balance, BigInt(0));
  assert.equal(schedule.balloon, null);
});

test("an unknown loan balance is excluded and surfaced instead of treated as zero", () => {
  const result = run(draft => { draft.loans![0]!.principalCents = null; });
  const loan = result.debt.loans.find(item => item.loanId === "loan-a")!;
  assert.equal(loan.principalKnown, false);
  assert.equal(loan.payments.length, 0);
  assert.ok(result.opening.unknown.includes("Example Court mortgage principal"));
  assert.ok(result.warnings.some(warning => warning.code === "loan_principal_unknown"));
  assertAllChecks(result);
});

// ---------------------------------------------------------------- audit regressions
function withUnknownOpeningCash(input = syntheticEngineInput()) {
  return { ...input, sources: { ...input.sources, items: input.sources.items.map(item => item.key === "cash_operating" ? { ...item, amountCents: null, asOf: null, state: "unknown" as const, sourceIds: [] } : item) } };
}

test("unknown opening cash leaves liquidity figures unknown instead of treating the balance as zero", () => {
  const known = run();
  const result = runForecast(withUnknownOpeningCash());
  assertAllChecks(result);
  assert.equal(known.summary.openingCashKnown, true);
  assert.equal(result.summary.openingCashKnown, false);
  assert.equal(result.summary.minAvailableCashCents, null);
  assert.equal(result.summary.endingCashCents, null);
  assert.equal(result.summary.weeksBelowFloor, null);
  assert.ok(result.weeks.every(week => week.belowReserveFloor === null));
  // Relative movements stay exact; the lowest week does not depend on the unknown constant.
  assert.deepEqual(result.weeks.map(week => week.netCents), known.weeks.map(week => week.netCents));
  assert.equal(result.summary.minAvailableWeek, known.summary.minAvailableWeek);
  assert.ok(result.opening.unknown.includes("Operating cash"));
  assert.ok(typeof known.summary.weeksBelowFloor === "number");
});

test("a loan past maturity at the cutoff falls due on the first forecast day and the debt rollforward holds", () => {
  const result = run(draft => {
    draft.loans![0] = { ...draft.loans![0]!, firstPaymentOn: "2024-01-01", maturityOn: "2026-12-01" };
    draft.sales = [];
  });
  assertAllChecks(result);
  const loan = result.debt.loans.find(item => item.loanId === "loan-a")!;
  assert.equal(loan.pastMaturity, true);
  assert.equal(loan.maturityOn, "2026-12-01");
  assert.equal(loan.payments.length, 1);
  assert.equal(loan.payments[0]!.date, "2026-12-28");
  assert.equal(loan.payments[0]!.principalCents, "50000000");
  assert.equal(loan.payments[0]!.balanceCents, "0");
  assert.equal(result.debt.ladder[0]!.year, "overdue");
  assert.equal(result.debt.ladder[0]!.maturingCents, "50000000");
  assert.ok(!result.debt.ladder.some(row => row.year !== "overdue" && row.maturingCents === "50000000"));
  const due = result.events.find(event => event.id === "loan-payment:loan-a:2026-12-28")!;
  assert.equal(lineTotal(due, "debt"), BigInt(50_000_000));
  assert.ok(result.warnings.some(warning => warning.code === "loan_matured_before_cutoff"));
});

test("paying off a loan whose principal is unknown leaves payoff and net proceeds unknown, never zero", () => {
  const refinance = run(draft => { draft.loans![1]!.principalCents = null; });
  const refi = refinance.capital.refinances[0]!;
  assert.equal(refi.payoffUnknown, true);
  assert.equal(refi.payoffCents, null);
  assert.equal(refi.netUsableCents, null);
  assert.deepEqual(refi.payoffLoanIds, ["loan-b"]);
  assert.ok(refinance.warnings.some(warning => warning.code === "refinance_payoff_unknown"));
  const sale = run(draft => {
    draft.loans![0]!.principalCents = null;
    draft.sales = [{ id: "sell-a", label: "Sell Example Court", propertyId: "prop-a", closeOn: "2028-06-01", priceCents: "110000000", sellingCostsCents: "3300000", payoffLoanIds: ["loan-a"], transferDeposits: true }];
  });
  const sold = sale.capital.sales[0]!;
  assert.equal(sold.payoffUnknown, true);
  assert.equal(sold.payoffCents, null);
  assert.equal(sold.netProceedsCents, null);
  assert.ok(sale.warnings.some(warning => warning.code === "sale_payoff_unknown"));
  const known = run().capital.refinances[0]!;
  assert.equal(known.payoffUnknown, false);
  assert.ok(known.netUsableCents !== null);
});

test("collections plus bad debt never exceed the tenant amount due", () => {
  const result = run(draft => {
    draft.leasing!.collectionsBps = 5_000;
    draft.leasing!.badDebtBps = 5_000;
    draft.units!.find(unit => unit.unitId === "b-2")!.currentRentCents = "150003";
  });
  assertAllChecks(result);
  let checked = 0;
  for (const event of result.events.filter(item => item.kind === "rent_charge" && item.id.startsWith("rent:b-2:"))) {
    const period = event.id.slice("rent:b-2:".length);
    const due = lineTotal(event, "rent_receivable");
    const collected = result.events.find(item => item.id === `collect:b-2:${period}`);
    const writtenOff = result.events.find(item => item.id === `bad-debt:b-2:${period}`);
    const cleared = -(collected ? lineTotal(collected, "rent_receivable") : BigInt(0)) - (writtenOff ? lineTotal(writtenOff, "rent_receivable") : BigInt(0));
    assert.ok(cleared <= due, `${period}: cleared ${cleared} > due ${due}`);
    if (due === BigInt(150_003) && collected && writtenOff) { assert.equal(cleared, due); checked += 1; }
  }
  assert.ok(checked > 0, "full-month charges were checked");
});

test("the weekly/monthly and modeled-proceeds checks detect real disagreements", () => {
  const result = run();
  const events = result.events.map(event => ({ date: event.date, cashCents: cashOf(event) }));
  assert.deepEqual(weeklyMonthlyDisagreements(result.weeks, result.months, events), []);
  const tampered = result.months.map((month, index) => index === 1 ? { ...month, cashFlow: { ...month.cashFlow, closingCashCents: (big(month.cashFlow.closingCashCents) + BigInt(1)).toString() } } : month);
  assert.equal(weeklyMonthlyDisagreements(result.weeks, tampered, events).length, 1);
  const modeled = result.events.map(event => ({ id: event.id, date: event.date, kind: event.kind, modeled: event.modeled, cashCents: cashOf(event) }));
  assert.deepEqual(modeledProceedsViolations(modeled, SYNTHETIC_FORECAST_CUTOFF), []);
  const funding = modeled.find(event => event.kind === "loan_funding")!;
  assert.equal(modeledProceedsViolations([{ ...funding, modeled: false }], SYNTHETIC_FORECAST_CUTOFF).length, 1);
  assert.equal(modeledProceedsViolations([{ ...funding, date: SYNTHETIC_FORECAST_CUTOFF }], SYNTHETIC_FORECAST_CUTOFF).length, 1);
  const rent = modeled.find(event => event.kind === "tenant_collection")!;
  assert.equal(modeledProceedsViolations([{ ...rent, modeled: true }], SYNTHETIC_FORECAST_CUTOFF).length, 1);
});

test("a loan paid off by a sale on a refinance's closing day is not reported as refinanced", () => {
  const { events: _events, ...view } = run(draft => {
    draft.sales = [{ id: "sell-a", label: "Sell Example Court", propertyId: "prop-a", closeOn: "2027-09-15", priceCents: "110000000", sellingCostsCents: "3300000", payoffLoanIds: ["loan-a"], transferDeposits: true }];
  });
  assert.deepEqual(view.capital.refinances[0]!.payoffLoanIds, ["loan-b"]);
  assert.deepEqual(view.capital.sales[0]!.payoffLoanIds, ["loan-a"]);
  const meta = { id: "99999999-9999-4999-8999-999999999991", scenarioId: "99999999-9999-4999-8999-999999999992", assumptionVersion: 1, modelVersion: view.modelVersion, createdAt: "2026-12-28T00:00:00.000Z" } as never;
  const rows = forecastReportRows(meta, view);
  const loanA = rows.debt!.find(line => line.debtId === "loan-a")!;
  const loanB = rows.debt!.find(line => line.debtId === "loan-b")!;
  assert.equal(view.debt.loans.find(loan => loan.loanId === "loan-a")!.paidOffOn, "2027-09-15");
  assert.equal(loanA.refinanceBalanceCents, null, "paid off by the sale, not refinanced");
  assert.notEqual(loanB.refinanceBalanceCents, null);
  assert.deepEqual(forecastReportBounds({ mode: "month", month: "2027-02" } as never), { from: "2027-02-01", through: "2027-02-28" });
  assert.deepEqual(forecastReportBounds({ mode: "custom", asOfDate: "2027-05-03" } as never), { from: "2027-05-03", through: "2027-05-03" });
});
