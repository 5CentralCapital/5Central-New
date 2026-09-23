import {
  OPENING_ITEM_KEYS,
  OPENING_ITEM_LABELS,
  forecastAssumptionsSchema,
  type ExpenseAssumption,
  type ForecastAssumptions,
  type LoanTerms,
  type OpeningItemKey,
  type ProjectAssumption,
  type Recurrence,
  type UnitAssumption,
} from "../../shared/forecasting/assumptions";
import {
  addDays,
  addMonths,
  addMonthsToDate,
  dayNumber,
  daysInMonth,
  isMonday,
  isoWeekday,
  maxDate,
  minDate,
  monthEndDate,
  monthOf,
  monthStartDate,
  monthlyPeriods,
  periodIndexFor,
  weeklyPeriods,
  type ForecastPeriod,
} from "../../shared/forecasting/calendar";
import {
  FORECAST_ACCOUNT_BY_KEY,
  FORECAST_ACCOUNTS,
  FORECAST_MODEL_VERSION,
  type CashCategory,
  type ForecastCheck,
  type ForecastCoverageRow,
  type ForecastEvent,
  type ForecastEventKind,
  type ForecastLoanSchedule,
  type ForecastMonthRow,
  type ForecastOpeningItem,
  type ForecastOwnerView,
  type ForecastRefinanceResult,
  type ForecastResult,
  type ForecastSaleResult,
  type ForecastStatementLine,
  type ForecastWarning,
  type ForecastWeekRow,
} from "../../shared/forecasting/result";
import { balanceOn, buildLoanSchedule, type LoanSchedule } from "./debt";
import { ZERO, allocate, applyBps, big, growByBps, minBig, prorate, text } from "./money";

export class ForecastInputError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) {
    super(message);
    this.name = "ForecastInputError";
  }
}

export interface ForecastScenarioParameters {
  readonly name: string;
  readonly kind: string;
  readonly startDate: string;
  readonly horizonWeeks: number;
  readonly horizonMonths: number;
  readonly reserveFloorCents: string;
  readonly currency: string;
}

/** Opening facts read from company sources, as of the actuals cutoff. */
export interface ForecastSourceData {
  readonly items: readonly ForecastOpeningItem[];
  /** Outstanding principal of company debt records, keyed by company_investor_debt id. */
  readonly debtBalances: Readonly<Record<string, { readonly principalCents: string | null; readonly sourceIds: readonly string[] }>>;
}

export interface ForecastEngineInput {
  readonly scenario: ForecastScenarioParameters;
  readonly assumptions: ForecastAssumptions;
  readonly sources: ForecastSourceData;
}

type Line = readonly [account: string, cents: bigint, sub?: string];
interface EventHeader {
  readonly id: string;
  readonly date: string;
  readonly kind: ForecastEventKind;
  readonly label: string;
  readonly cashCategory: CashCategory | null;
  readonly cashFlowClass: "operating" | "investing" | "financing";
  readonly modeled?: boolean;
  readonly ref: string;
  readonly propertyId?: string;
  readonly sourceIds?: readonly string[];
}
interface InternalEvent extends EventHeader { readonly lines: readonly Line[] }

const CASH_ACCOUNTS = new Set(["cash_operating", "cash_restricted"]);
const MAX_ITERATIONS = 2_000;

function mondayOf(date: string): string { return addDays(date, -isoWeekday(date)); }
function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const start = maxDate(aStart, bStart);
  const end = minDate(aEnd, bEnd);
  return end < start ? 0 : dayNumber(end) - dayNumber(start) + 1;
}

/** Occurrence dates of a recurring item within (after, until]. */
export function occurrences(frequency: Recurrence, firstOn: string, endOn: string | undefined, after: string, until: string): string[] {
  const last = endOn ? minDate(endOn, until) : until;
  const dates: string[] = [];
  if (frequency === "once") return firstOn > after && firstOn <= last ? [firstOn] : [];
  for (let index = 0; index < 100_000; index += 1) {
    const date = frequency === "weekly" ? addDays(firstOn, index * 7)
      : addMonthsToDate(firstOn, index * (frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12));
    if (date > last) break;
    if (date > after) dates.push(date);
  }
  return dates;
}

/** Count anniversaries of `from` on or before `date` (for annual growth steps). */
function anniversaries(from: string, date: string): number {
  let count = 0;
  while (count < 200 && addMonthsToDate(from, (count + 1) * 12) <= date) count += 1;
  return count;
}

function grown(amount: bigint, bps: number, steps: number): bigint {
  let value = amount;
  for (let index = 0; index < steps; index += 1) value = growByBps(value, bps);
  return value;
}

class Journal {
  readonly events: InternalEvent[] = [];
  private readonly ids = new Set<string>();
  constructor(private readonly cutoff: string, private readonly end: string) {}

  within(date: string): boolean { return date > this.cutoff && date <= this.end; }

  post(header: EventHeader, lines: readonly Line[]): boolean {
    if (!this.within(header.date)) return false;
    const kept = lines.filter(line => line[1] !== ZERO);
    if (!kept.length) return false;
    let total = ZERO;
    for (const line of kept) total += line[1];
    if (total !== ZERO) throw new Error(`Forecast event ${header.id} is unbalanced by ${total}`);
    if (this.ids.has(header.id)) throw new Error(`Duplicate forecast event ${header.id}`);
    this.ids.add(header.id);
    this.events.push({ ...header, lines: kept });
    return true;
  }
}

interface LeaseSegment {
  readonly start: string;
  /** Contract end; may extend beyond the calendar. */
  readonly end: string;
  readonly rent: bigint;
  readonly subsidy: bigint;
  readonly kind: "existing" | "renewal" | "new";
  readonly deposit: bigint;
}

interface UnitPlan {
  readonly unit: UnitAssumption;
  readonly ownedFrom: string;
  readonly ownedUntil: string;
  readonly segments: LeaseSegment[];
  depositAtSale: bigint;
}

function naturalSign(account: string, debit: bigint): bigint {
  const definition = FORECAST_ACCOUNT_BY_KEY[account];
  if (!definition) throw new Error(`Unknown forecast account ${account}`);
  if (definition.type === "asset" || definition.type === "expense") return debit;
  if (account === "distributions") return debit;
  return -debit;
}

/**
 * Run the deterministic model. The same scenario parameters, assumption
 * document and source data always produce the same result, byte for byte.
 */
export function runForecast(input: ForecastEngineInput): ForecastResult {
  const assumptions = forecastAssumptionsSchema.parse(input.assumptions);
  const { scenario } = input;
  const cutoff = assumptions.actualsCutoff;
  if (!isMonday(scenario.startDate)) throw new ForecastInputError("forecast_start_not_monday", "Forecast weeks run Monday to Sunday; choose a Monday start date.", "startDate");
  if (cutoff >= scenario.startDate) throw new ForecastInputError("forecast_cutoff_after_start", "The actuals cutoff must be before the forecast start date.", "actualsCutoff");
  if (dayNumber(scenario.startDate) - dayNumber(cutoff) > 366) throw new ForecastInputError("forecast_cutoff_too_old", "The actuals cutoff must be within a year of the forecast start.", "actualsCutoff");
  if (assumptions.currency !== scenario.currency) throw new ForecastInputError("forecast_currency_mismatch", "Assumptions and scenario must use the same currency.", "currency");
  const weeks = weeklyPeriods(scenario.startDate, scenario.horizonWeeks);
  const months = monthlyPeriods(scenario.startDate, scenario.horizonMonths);
  const calendarEnd = maxDate(weeks.at(-1)!.end, months.at(-1)!.end);
  const first = addDays(cutoff, 1);
  const journal = new Journal(cutoff, calendarEnd);
  const warnings: ForecastWarning[] = [];
  const warn = (code: string, message: string, ref?: string) => warnings.push(ref ? { code, message, ref } : { code, message });
  const leasing = assumptions.leasing;
  const properties = new Map(assumptions.properties.map(property => [property.propertyId, property]));
  const projects = new Map(assumptions.projects.map(project => [project.projectId, project]));
  const expenses = new Map(assumptions.expenses.map(expense => [expense.id, expense]));

  // ---------------------------------------------------------------- sales
  const saleExcluded = new Set<string>();
  const saleDate = new Map<string, string>();
  for (const sale of assumptions.sales) {
    if (sale.closeOn <= cutoff) {
      saleExcluded.add(sale.id);
      warn("modeled_event_before_cutoff", `${sale.label} is dated on or before the actuals cutoff and is excluded; modeled proceeds never become actual cash.`, `sales[${sale.id}]`);
      continue;
    }
    saleDate.set(sale.propertyId, sale.closeOn);
  }
  /** Last day the company owns the property within the calendar. */
  const ownedUntil = (propertyId: string | undefined): string => {
    if (!propertyId) return calendarEnd;
    const sold = saleDate.get(propertyId);
    return sold ? minDate(calendarEnd, addDays(sold, -1)) : calendarEnd;
  };
  const refinanceExcluded = new Set<string>();
  for (const refinance of assumptions.refinances) {
    if (refinance.closeOn <= cutoff) {
      refinanceExcluded.add(refinance.id);
      warn("modeled_event_before_cutoff", `${refinance.label} is dated on or before the actuals cutoff and is excluded; modeled proceeds never become actual cash.`, `refinances[${refinance.id}]`);
    } else if (refinance.newLoan.principalCents === null) {
      refinanceExcluded.add(refinance.id);
      warn("refinance_amount_unknown", `${refinance.label} has no loan amount and is excluded.`, `refinances[${refinance.id}]`);
    }
  }

  // ---------------------------------------------------------------- opening position
  const openingOverrides = new Map(assumptions.overrides.flatMap(override => override.kind === "opening_balance" ? [[override.item, override] as const] : []));
  const sourced = new Map(input.sources.items.map(item => [item.key, item]));
  const openingItems: ForecastOpeningItem[] = [];
  const openingDebit = new Map<string, bigint>();
  const subOpening = new Map<string, bigint>();
  const addOpening = (account: string, debit: bigint, sub?: string) => {
    openingDebit.set(account, (openingDebit.get(account) ?? ZERO) + debit);
    if (sub) subOpening.set(`${account}|${sub}`, (subOpening.get(`${account}|${sub}`) ?? ZERO) + debit);
  };
  const OPENING_ACCOUNTS: Readonly<Record<OpeningItemKey, { account: string; credit: boolean } | null>> = {
    cash_operating: { account: "cash_operating", credit: false },
    cash_restricted: { account: "cash_restricted", credit: false },
    rental_receivables: { account: "rent_receivable", credit: false },
    pm_held_funds: { account: "pm_held_funds", credit: false },
    accounts_payable: { account: "accounts_payable", credit: true },
    deposits_held: { account: "deposits_held", credit: true },
    investor_obligations: { account: "investor_payable", credit: true },
    project_commitments: null,
  };
  const openingAmount = new Map<string, bigint | null>();
  for (const key of OPENING_ITEM_KEYS) {
    const override = openingOverrides.get(key);
    const source = sourced.get(key);
    const mapping = OPENING_ACCOUNTS[key];
    let item: ForecastOpeningItem;
    if (override) {
      item = { key, label: OPENING_ITEM_LABELS[key], amountCents: override.amountCents, asOf: override.asOf, state: "manual",
        source: `Approved override by ${override.author}: ${override.reason}`, sourceIds: [`override:${override.id}`], ...(mapping ? {} : { memo: true }) };
    } else if (source && source.amountCents !== null && (source.state === "sourced" || source.state === "manual" || source.state === "partial")) {
      item = { ...source, label: OPENING_ITEM_LABELS[key], ...(mapping ? {} : { memo: true }) };
    } else {
      item = { key, label: OPENING_ITEM_LABELS[key], amountCents: null, asOf: null, state: "unknown",
        source: source?.source ?? "No connected source", sourceIds: source?.sourceIds ?? [], ...(source?.note ? { note: source.note } : {}), ...(mapping ? {} : { memo: true }) };
    }
    openingItems.push(item);
    const amount = item.amountCents === null ? null : big(item.amountCents);
    openingAmount.set(key, amount);
    if (mapping && amount !== null) addOpening(mapping.account, mapping.credit ? -amount : amount);
  }
  for (const property of assumptions.properties) {
    const key = `property:${property.propertyId}`;
    if (!property.fixedAsset) {
      openingItems.push({ key, label: `${property.name} book basis`, amountCents: null, asOf: null, state: "unknown", source: "Not in assumptions", sourceIds: [] });
      continue;
    }
    const cost = big(property.fixedAsset.costBasisCents);
    const accumulated = big(property.fixedAsset.accumulatedDepreciationCents);
    addOpening("fixed_assets", cost, property.propertyId);
    addOpening("accumulated_depreciation", -accumulated, property.propertyId);
    openingItems.push({ key, label: `${property.name} net book value`, amountCents: text(cost - accumulated), asOf: cutoff, state: "manual", source: "Scenario assumptions", sourceIds: [] });
  }
  for (const project of assumptions.projects) {
    if (project.retired) continue;
    const cip = big(project.openingCipCents);
    if (cip !== ZERO) {
      addOpening("cip", cip, project.projectId);
      openingItems.push({ key: `project:${project.projectId}`, label: `${project.name} construction in progress`, amountCents: text(cip), asOf: cutoff, state: "manual", source: "Scenario assumptions", sourceIds: [] });
    }
  }
  const loanOpening = new Map<string, bigint | null>();
  for (const loan of assumptions.loans) {
    const key = `loan:${loan.id}`;
    const sourcedDebt = loan.sourceDebtId ? input.sources.debtBalances[loan.sourceDebtId] : undefined;
    if (loan.principalCents !== null) {
      loanOpening.set(loan.id, big(loan.principalCents));
      openingItems.push({ key, label: `${loan.label} principal`, amountCents: loan.principalCents, asOf: cutoff, state: "manual", source: "Scenario assumptions", sourceIds: [] });
    } else if (sourcedDebt?.principalCents) {
      loanOpening.set(loan.id, big(sourcedDebt.principalCents));
      openingItems.push({ key, label: `${loan.label} principal`, amountCents: sourcedDebt.principalCents, asOf: cutoff, state: "sourced", source: "Company debt records", sourceIds: sourcedDebt.sourceIds });
    } else {
      loanOpening.set(loan.id, null);
      openingItems.push({ key, label: `${loan.label} principal`, amountCents: null, asOf: null, state: "unknown", source: loan.sourceDebtId ? "Company debt record has no supported balance" : "Not in assumptions", sourceIds: sourcedDebt?.sourceIds ?? [] });
      warn("loan_principal_unknown", `${loan.label} has no known principal; its debt service is excluded until the balance is supported.`, `loans[${loan.id}]`);
    }
    const principal = loanOpening.get(loan.id);
    if (principal !== null && principal !== undefined) addOpening("debt", -principal, loan.id);
  }
  // Opening equity is derived from the known opening items only; it is the
  // opening position's book equity, not a balancing plug in any forecast period.
  let openingNet = ZERO;
  openingDebit.forEach(value => { openingNet += value; });
  addOpening("opening_equity", -openingNet);
  const unknown = openingItems.filter(item => item.state === "unknown").map(item => item.label);

  // ---------------------------------------------------------------- time actuals
  const replacedLabor = new Set<string>();
  for (const actual of assumptions.timeActuals) {
    if (actual.workedOn <= cutoff) {
      warn("time_actual_in_opening", `Time actual ${actual.id} is on or before the cutoff and is already in the opening position.`, `timeActuals[${actual.id}]`);
      continue;
    }
    const key = actual.projectId ? `project:${actual.projectId}` : `expense:${actual.expenseId}`;
    replacedLabor.add(`${key}|${mondayOf(actual.workedOn)}`);
  }
  const laborReplacements: string[] = [];

  // ---------------------------------------------------------------- leasing and rent
  const renewalGrowth = leasing.annualRentGrowthBps;
  const marketRentAt = (unit: UnitAssumption, date: string) => grown(big(unit.marketRentCents), renewalGrowth, anniversaries(scenario.startDate, date));
  const rentOverride = new Map(assumptions.overrides.flatMap(override => override.kind === "unit_rent" ? [[`${override.unitId}|${override.month}`, big(override.amountCents)] as const] : []));
  const expenseOverride = new Map(assumptions.overrides.flatMap(override => override.kind === "expense_amount" ? [[`${override.expenseId}|${override.month}`, big(override.amountCents)] as const] : []));
  const pmCollections = new Map<string, bigint>();
  const unitPlans: UnitPlan[] = [];

  const newLease = (unit: UnitAssumption, start: string): LeaseSegment => {
    const rent = marketRentAt(unit, start);
    const subsidy = minBig(big(unit.newLeaseSubsidyCents), rent);
    return { start, end: addDays(addMonthsToDate(start, leasing.newLeaseTermMonths), -1), rent, subsidy, kind: "new",
      deposit: unit.depositCents !== undefined ? big(unit.depositCents) : rent * BigInt(leasing.depositMonths) };
  };

  for (const unit of assumptions.units) {
    const property = properties.get(unit.propertyId)!;
    const managed = property.propertyManager.managed;
    const last = ownedUntil(unit.propertyId);
    const plan: UnitPlan = { unit, ownedFrom: first, ownedUntil: last, segments: [], depositAtSale: ZERO };
    unitPlans.push(plan);
    const renew = unit.renewOnExpiry ?? leasing.renewOnExpiry;
    const ref = `units[${unit.unitId}]`;
    let segment: LeaseSegment | null = null;
    if (unit.status === "occupied") {
      let end = unit.leaseEndOn ?? "9999-12-31";
      if (end < first) {
        warn("lease_expired_treated_month_to_month", `Unit ${unit.label}'s lease ended before the cutoff; it is treated as month to month.`, ref);
        end = "9999-12-31";
      }
      const rent = big(unit.currentRentCents);
      segment = { start: first, end, rent, subsidy: minBig(big(unit.subsidyCents), rent), kind: "existing",
        deposit: unit.depositCents !== undefined ? big(unit.depositCents) : rent * BigInt(leasing.depositMonths) };
    } else if (unit.status === "vacant") {
      const ready = unit.availableOn ?? addDays(first, leasing.makeReadyDays);
      segment = newLease(unit, addDays(maxDate(ready, first), leasing.vacancyDays));
    } else {
      const project = unit.projectId ? projects.get(unit.projectId) : undefined;
      if (!project || project.retired) {
        warn("offline_unit_without_project", `Unit ${unit.label} is offline without an active project; it stays offline.`, ref);
      } else {
        const ready = addDays(project.completionOn, leasing.makeReadyDays);
        segment = newLease(unit, addDays(maxDate(ready, first), leasing.vacancyDays));
      }
    }
    let iterations = 0;
    while (segment && segment.start <= last) {
      if ((iterations += 1) > MAX_ITERATIONS) throw new Error(`Lease schedule for ${unit.unitId} did not terminate`);
      plan.segments.push(segment);
      if (segment.end >= last) break;
      if (renew) {
        const start = addDays(segment.end, 1);
        segment = { start, end: addDays(addMonthsToDate(start, leasing.renewalTermMonths), -1), rent: growByBps(segment.rent, renewalGrowth), subsidy: segment.subsidy, kind: "renewal", deposit: segment.deposit };
      } else {
        const returnOn = addDays(segment.end, leasing.depositReturnDays);
        journal.post({ id: `deposit-out:${unit.unitId}:${segment.end}`, date: returnOn, kind: "deposit_returned", label: `Deposit returned · ${unit.label}`, cashCategory: "deposits", cashFlowClass: "operating", ref, propertyId: unit.propertyId },
          [["deposits_held", segment.deposit, unit.unitId], ["cash_operating", -segment.deposit]]);
        segment = newLease(unit, addDays(segment.end, 1 + leasing.makeReadyDays + leasing.vacancyDays));
      }
    }
    // Rent schedule by month for every segment within the owned period.
    for (const lease of plan.segments) {
      const chargeEnd = minDate(lease.end, last);
      if (lease.kind === "new") {
        journal.post({ id: `deposit-in:${unit.unitId}:${lease.start}`, date: lease.start, kind: "deposit_received", label: `Deposit received · ${unit.label}`, cashCategory: "deposits", cashFlowClass: "operating", ref, propertyId: unit.propertyId },
          [["cash_operating", lease.deposit], ["deposits_held", -lease.deposit, unit.unitId]]);
      }
      // An existing tenancy's current-month rent was charged before the cutoff
      // and sits in opening receivables; its next charge is the next 1st.
      const chargeFrom = lease.kind === "existing" && lease.start.slice(8) !== "01" ? monthStartDate(addMonths(monthOf(lease.start), 1)) : lease.start;
      let month = monthOf(chargeFrom);
      let firstCharge = true;
      for (let guard = 0; chargeFrom <= chargeEnd && month <= monthOf(chargeEnd) && guard < 1_200; guard += 1, month = addMonths(month, 1)) {
        const periodStart = maxDate(chargeFrom, monthStartDate(month));
        const periodEnd = minDate(chargeEnd, monthEndDate(month));
        const days = dayNumber(periodEnd) - dayNumber(periodStart) + 1;
        const dim = daysInMonth(month);
        const base = rentOverride.get(`${unit.unitId}|${month}`) ?? lease.rent;
        const subsidyBase = minBig(lease.subsidy, base);
        const charge = days === dim ? base : prorate(base, days, dim);
        const [tenant, subsidy] = base > ZERO ? allocate(charge, [base - subsidyBase, subsidyBase]) as [bigint, bigint] : [ZERO, ZERO];
        const eventRef = rentOverride.has(`${unit.unitId}|${month}`) ? `overrides[unit_rent:${unit.unitId}:${month}]` : ref;
        journal.post({ id: `rent:${unit.unitId}:${periodStart}`, date: periodStart, kind: "rent_charge", label: `Rent charged · ${unit.label}`, cashCategory: null, cashFlowClass: "operating", ref: eventRef, propertyId: unit.propertyId },
          [["rent_receivable", tenant], ["subsidy_receivable", subsidy], ["rental_income_tenant", -tenant], ["rental_income_subsidy", -subsidy]]);
        let concession = ZERO;
        if (firstCharge && lease.kind === "new") {
          concession = minBig(big(leasing.newLeaseConcessionCents), tenant);
          journal.post({ id: `concession:${unit.unitId}:${lease.start}`, date: periodStart, kind: "concession", label: `Move-in concession · ${unit.label}`, cashCategory: null, cashFlowClass: "operating", ref, propertyId: unit.propertyId },
            [["concessions", concession], ["rent_receivable", -concession]]);
        }
        firstCharge = false;
        const tenantDue = tenant - concession;
        const collected = applyBps(tenantDue, leasing.collectionsBps);
        const writtenOff = applyBps(tenantDue, leasing.badDebtBps);
        const collectedOn = addDays(periodStart, leasing.collectionLagDays);
        const subsidyOn = addDays(periodStart, leasing.subsidyLagDays);
        const receiving = managed ? "pm_held_funds" : "cash_operating";
        if (journal.post({ id: `collect:${unit.unitId}:${periodStart}`, date: collectedOn, kind: "tenant_collection", label: `Tenant rent received · ${unit.label}`, cashCategory: managed ? null : "tenant_receipts", cashFlowClass: "operating", ref, propertyId: unit.propertyId },
          [[receiving, collected], ["rent_receivable", -collected]]) && managed) {
          const key = `${unit.propertyId}|${monthOf(collectedOn)}`;
          pmCollections.set(key, (pmCollections.get(key) ?? ZERO) + collected);
        }
        journal.post({ id: `bad-debt:${unit.unitId}:${periodStart}`, date: collectedOn, kind: "bad_debt", label: `Bad debt · ${unit.label}`, cashCategory: null, cashFlowClass: "operating", ref, propertyId: unit.propertyId },
          [["bad_debt", writtenOff], ["rent_receivable", -writtenOff]]);
        if (journal.post({ id: `subsidy:${unit.unitId}:${periodStart}`, date: subsidyOn, kind: "subsidy_collection", label: `Housing assistance received · ${unit.label}`, cashCategory: managed ? null : "subsidy_receipts", cashFlowClass: "operating", ref, propertyId: unit.propertyId },
          [[receiving, subsidy], ["subsidy_receivable", -subsidy]]) && managed) {
          const key = `${unit.propertyId}|${monthOf(subsidyOn)}`;
          pmCollections.set(key, (pmCollections.get(key) ?? ZERO) + subsidy);
        }
      }
    }
    const sold = saleDate.get(unit.propertyId);
    if (sold) {
      const active = plan.segments.find(lease => lease.start <= addDays(sold, -1) && lease.end >= addDays(sold, -1));
      plan.depositAtSale = active ? active.deposit : ZERO;
    }
  }
  // Property-manager remittances: collections of each month, net of fees.
  for (const [key, gross] of Array.from(pmCollections.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [propertyId, month] = key.split("|") as [string, string];
    const manager = properties.get(propertyId)!.propertyManager;
    const fee = applyBps(gross, manager.feeBps);
    journal.post({ id: `pm-remit:${propertyId}:${month}`, date: addDays(monthEndDate(month), manager.remittanceLagDays), kind: "pm_remittance", label: `Manager remittance · ${properties.get(propertyId)!.name} · ${month}`, cashCategory: "pm_remittances", cashFlowClass: "operating", ref: `properties[${propertyId}].propertyManager`, propertyId },
      [["cash_operating", gross - fee], ["pm_fees", fee], ["pm_held_funds", -gross]]);
  }
  const openingPm = openingAmount.get("pm_held_funds");
  if (openingPm && openingPm !== ZERO) {
    const lag = assumptions.properties.find(property => property.propertyManager.managed)?.propertyManager.remittanceLagDays ?? 10;
    journal.post({ id: "opening:pm_held_funds", date: maxDate(addDays(monthEndDate(monthOf(cutoff)), lag), first), kind: "pm_remittance", label: "Opening manager-held funds remitted", cashCategory: "pm_remittances", cashFlowClass: "operating", ref: "opening.pm_held_funds" },
      [["cash_operating", openingPm], ["pm_held_funds", -openingPm]]);
  }
  const openingAp = openingAmount.get("accounts_payable");
  if (openingAp && openingAp !== ZERO) {
    journal.post({ id: "opening:accounts_payable", date: addDays(cutoff, 30), kind: "expense_paid", label: "Opening payables paid", cashCategory: "operating_expenses", cashFlowClass: "operating", ref: "opening.accounts_payable" },
      [["accounts_payable", openingAp], ["cash_operating", -openingAp]]);
  }
  const openingInvestor = openingAmount.get("investor_obligations");
  if (openingInvestor && openingInvestor !== ZERO) {
    journal.post({ id: "opening:investor_obligations", date: first, kind: "investor_flow", label: "Investor obligations due at cutoff paid", cashCategory: "investor", cashFlowClass: "financing", ref: "opening.investor_obligations" },
      [["investor_payable", openingInvestor], ["cash_operating", -openingInvestor]]);
  }

  // ---------------------------------------------------------------- operating expenses
  const postExpense = (expense: ExpenseAssumption, date: string, amount: bigint, ref: string, id: string) => {
    const account = `opex_${expense.category}`;
    const cash = expense.paidFromEscrow ? "cash_restricted" : "cash_operating";
    const category: CashCategory = expense.category === "payroll" ? "payroll" : "operating_expenses";
    if (expense.paymentLagDays === 0) {
      journal.post({ id, date, kind: "expense_paid", label: expense.label, cashCategory: category, cashFlowClass: "operating", ref, ...(expense.propertyId ? { propertyId: expense.propertyId } : {}) }, [[account, amount], [cash, -amount]]);
      return;
    }
    journal.post({ id, date, kind: "expense_incurred", label: expense.label, cashCategory: null, cashFlowClass: "operating", ref, ...(expense.propertyId ? { propertyId: expense.propertyId } : {}) }, [[account, amount], ["accounts_payable", -amount]]);
    journal.post({ id: `${id}:paid`, date: addDays(date, expense.paymentLagDays), kind: "expense_paid", label: `${expense.label} paid`, cashCategory: category, cashFlowClass: "operating", ref, ...(expense.propertyId ? { propertyId: expense.propertyId } : {}) }, [["accounts_payable", amount], [cash, -amount]]);
  };
  for (const expense of assumptions.expenses) {
    const ref = `expenses[${expense.id}]`;
    if (expense.retired) { warn("retired_item_excluded", `${expense.label} is retired and excluded from the model.`, ref); continue; }
    for (const date of occurrences(expense.frequency, expense.firstOn, expense.endOn, cutoff, ownedUntil(expense.propertyId))) {
      if (expense.laborEstimate && replacedLabor.has(`expense:${expense.id}|${mondayOf(date)}`)) { laborReplacements.push(`expense:${expense.id}|${mondayOf(date)}`); continue; }
      const month = monthOf(date);
      const override = expenseOverride.get(`${expense.id}|${month}`);
      const amount = override ?? grown(big(expense.amountCents), expense.annualGrowthBps, anniversaries(expense.firstOn, date));
      postExpense(expense, date, amount, override !== undefined ? `overrides[expense_amount:${expense.id}:${month}]` : ref, `expense:${expense.id}:${date}`);
    }
  }
  for (const actual of assumptions.timeActuals) {
    if (actual.workedOn <= cutoff) continue;
    const amount = big(actual.amountCents);
    const ref = `timeActuals[${actual.id}]`;
    if (actual.expenseId) {
      const expense = expenses.get(actual.expenseId)!;
      journal.post({ id: `labor-actual:${actual.id}`, date: actual.workedOn, kind: "labor_actual", label: `Approved time · ${expense.label}`, cashCategory: "payroll", cashFlowClass: "operating", ref, sourceIds: [actual.sourceId], ...(expense.propertyId ? { propertyId: expense.propertyId } : {}) },
        [[`opex_${expense.category}`, amount], ["cash_operating", -amount]]);
    }
  }

  // ---------------------------------------------------------------- projects
  interface Draw { loanId: string; date: string; amount: bigint; id: string; label: string; ref: string; propertyId: string }
  const draws: Draw[] = [];
  const depreciationLayers: { propertyId: string; basis: bigint; accumulated: bigint; startMonth: string; life: number; ref: string; id: string }[] = [];
  for (const property of assumptions.properties) {
    if (property.fixedAsset) {
      depreciationLayers.push({ propertyId: property.propertyId, basis: big(property.fixedAsset.depreciableBasisCents), accumulated: big(property.fixedAsset.accumulatedDepreciationCents),
        startMonth: monthOf(property.fixedAsset.placedInServiceOn), life: property.fixedAsset.usefulLifeMonths, ref: `properties[${property.propertyId}].fixedAsset`, id: `base:${property.propertyId}` });
    }
  }
  const projectCosts = (project: ProjectAssumption) => {
    const ref = `projects[${project.projectId}]`;
    const last = ownedUntil(project.propertyId);
    const rangeStart = maxDate(project.costStartOn, first);
    const rangeEnd = maxDate(project.completionOn, rangeStart);
    if (project.completionOn <= cutoff) warn("project_completed_before_cutoff", `${project.name} completed before the cutoff; remaining cost is spent and placed in service by ${rangeEnd}.`, ref);
    const chunks: { start: string; end: string; days: number }[] = [];
    for (let cursor = rangeStart; cursor <= rangeEnd && chunks.length < 5_000;) {
      const end = minDate(addDays(mondayOf(cursor), 6), rangeEnd);
      chunks.push({ start: cursor, end, days: dayNumber(end) - dayNumber(cursor) + 1 });
      cursor = addDays(end, 1);
    }
    const labor = big(project.laborEstimateCents);
    const nonLabor = big(project.remainingCostCents) - labor;
    const weights = chunks.map(chunk => chunk.days);
    const laborParts = allocate(labor, weights);
    const costParts = allocate(nonLabor, weights);
    let retainage = ZERO;
    chunks.forEach((chunk, index) => {
      if (chunk.end > last) return;
      const week = mondayOf(chunk.start);
      let incurred = ZERO;
      const laborPart = laborParts[index]!;
      if (laborPart !== ZERO) {
        if (replacedLabor.has(`project:${project.projectId}|${week}`)) laborReplacements.push(`project:${project.projectId}|${week}`);
        else if (journal.post({ id: `project-labor:${project.projectId}:${chunk.start}`, date: chunk.end, kind: "project_labor", label: `Estimated labor · ${project.name}`, cashCategory: "payroll", cashFlowClass: "investing", ref, propertyId: project.propertyId },
          [["cip", laborPart, project.projectId], ["cash_operating", -laborPart]])) incurred += laborPart;
      }
      const cost = costParts[index]!;
      if (cost !== ZERO) {
        const held = applyBps(cost, project.retainageBps);
        if (journal.post({ id: `project-cost:${project.projectId}:${chunk.start}`, date: chunk.end, kind: "project_cost", label: `Project cost · ${project.name}`, cashCategory: null, cashFlowClass: "investing", ref, propertyId: project.propertyId },
          [["cip", cost, project.projectId], ["project_payables", -(cost - held)], ["retainage_payable", -held]])) {
          retainage += held;
          incurred += cost;
          journal.post({ id: `project-pay:${project.projectId}:${chunk.start}`, date: addDays(chunk.end, project.paymentLagDays), kind: "project_payment", label: `Project payment · ${project.name}`, cashCategory: "project_costs", cashFlowClass: "investing", ref, propertyId: project.propertyId },
            [["project_payables", cost - held], ["cash_operating", -(cost - held)]]);
        }
      }
      if (project.drawLoanId && project.drawBps > 0 && incurred !== ZERO) {
        const amount = applyBps(incurred, project.drawBps);
        if (amount !== ZERO) draws.push({ loanId: project.drawLoanId, date: addDays(chunk.end, project.drawLagDays), amount, id: `project-draw:${project.projectId}:${chunk.start}`, label: `Construction draw · ${project.name}`, ref, propertyId: project.propertyId });
      }
    });
    journal.post({ id: `retainage:${project.projectId}`, date: addDays(rangeEnd, project.retainageReleaseDays), kind: "retainage_release", label: `Retainage released · ${project.name}`, cashCategory: "project_costs", cashFlowClass: "investing", ref, propertyId: project.propertyId },
      [["retainage_payable", retainage], ["cash_operating", -retainage]]);
    return rangeEnd;
  };
  const completions: { project: ProjectAssumption; date: string }[] = [];
  for (const project of assumptions.projects) {
    if (project.retired) { warn("retired_item_excluded", `${project.name} is retired and excluded from the model.`, `projects[${project.projectId}]`); continue; }
    completions.push({ project, date: projectCosts(project) });
  }
  // Time actuals for projects are known labor; they replace the estimate for the same week.
  for (const actual of assumptions.timeActuals) {
    if (actual.workedOn <= cutoff || !actual.projectId) continue;
    const project = projects.get(actual.projectId)!;
    const completion = completions.find(item => item.project.projectId === actual.projectId);
    const placed = completion && actual.workedOn > completion.date;
    const amount = big(actual.amountCents);
    journal.post({ id: `labor-actual:${actual.id}`, date: actual.workedOn, kind: "labor_actual", label: `Approved time · ${project.name}`, cashCategory: "payroll", cashFlowClass: "investing", ref: `timeActuals[${actual.id}]`, sourceIds: [actual.sourceId], propertyId: project.propertyId },
      [[placed ? "fixed_assets" : "cip", amount, placed ? project.propertyId : project.projectId], ["cash_operating", -amount]]);
  }
  for (const { project, date } of completions) {
    if (!journal.within(date) || date > ownedUntil(project.propertyId)) continue;
    let placed = subOpening.get(`cip|${project.projectId}`) ?? ZERO;
    for (const event of journal.events) {
      if (event.date > date) continue;
      for (const [account, cents, sub] of event.lines) if (account === "cip" && sub === project.projectId) placed += cents;
    }
    if (journal.post({ id: `complete:${project.projectId}`, date, kind: "project_complete", label: `Placed in service · ${project.name}`, cashCategory: null, cashFlowClass: "investing", ref: `projects[${project.projectId}]`, propertyId: project.propertyId },
      [["fixed_assets", placed, project.propertyId], ["cip", -placed, project.projectId]])) {
      depreciationLayers.push({ propertyId: project.propertyId, basis: placed, accumulated: ZERO, startMonth: addMonths(monthOf(date), 1), life: project.usefulLifeMonths, ref: `projects[${project.projectId}]`, id: `project:${project.projectId}` });
    }
  }

  // ---------------------------------------------------------------- depreciation (straight line, month end)
  for (const layer of depreciationLayers) {
    let accumulated = layer.accumulated;
    const propertyName = properties.get(layer.propertyId)?.name ?? layer.propertyId;
    for (let month = maxDate(monthOf(first), layer.startMonth); monthEndDate(month) <= calendarEnd; month = addMonths(month, 1)) {
      const end = monthEndDate(month);
      if (end <= cutoff || end > ownedUntil(layer.propertyId)) continue;
      const remaining = layer.basis - accumulated;
      if (remaining <= ZERO) break;
      const elapsed = (Number(month.slice(0, 4)) - Number(layer.startMonth.slice(0, 4))) * 12 + Number(month.slice(5)) - Number(layer.startMonth.slice(5));
      const regular = layer.basis / BigInt(layer.life);
      const amount = elapsed + 1 >= layer.life ? remaining : minBig(regular, remaining);
      if (journal.post({ id: `depreciation:${layer.id}:${month}`, date: end, kind: "depreciation", label: `Depreciation · ${propertyName}`, cashCategory: null, cashFlowClass: "operating", ref: layer.ref, propertyId: layer.propertyId },
        [["depreciation", amount], ["accumulated_depreciation", -amount, layer.propertyId]])) accumulated += amount;
    }
  }

  // ---------------------------------------------------------------- debt
  const payoffOn = new Map<string, { date: string; ref: string }>();
  const notePayoff = (loanId: string, date: string, ref: string) => {
    const existing = payoffOn.get(loanId);
    if (existing && existing.date <= date) { warn("duplicate_payoff", `Loan ${loanId} is already paid off by ${existing.ref}.`, ref); return; }
    payoffOn.set(loanId, { date, ref });
  };
  for (const refinance of assumptions.refinances) if (!refinanceExcluded.has(refinance.id)) for (const loanId of refinance.payoffLoanIds) notePayoff(loanId, refinance.closeOn, `refinances[${refinance.id}]`);
  for (const sale of assumptions.sales) if (!saleExcluded.has(sale.id)) for (const loanId of sale.payoffLoanIds) notePayoff(loanId, sale.closeOn, `sales[${sale.id}]`);

  interface LoanPlan { id: string; terms: LoanTerms; origin: "existing" | "refinance"; opening: bigint | null; schedule: LoanSchedule | null; fundedOn: string | null; ref: string; propertyId?: string }
  const loanPlans: LoanPlan[] = [];
  for (const loan of assumptions.loans) {
    const opening = loanOpening.get(loan.id) ?? null;
    const ref = `loans[${loan.id}]`;
    if (opening === null) { loanPlans.push({ id: loan.id, terms: loan, origin: "existing", opening, schedule: null, fundedOn: null, ref, ...(loan.propertyId ? { propertyId: loan.propertyId } : {}) }); continue; }
    if (loan.maturityOn <= cutoff) warn("loan_matured_before_cutoff", `${loan.label} matured before the cutoff but still has a balance.`, ref);
    let accrualStart = addMonthsToDate(loan.firstPaymentOn, -1, loan.paymentDay);
    for (let index = 0; index < 1_000; index += 1) {
      const date = addMonthsToDate(loan.firstPaymentOn, index, loan.paymentDay);
      if (date > cutoff || date >= loan.maturityOn) break;
      accrualStart = date;
    }
    if (loan.dayCount === "30_360" && draws.some(draw => draw.loanId === loan.id)) warn("draws_on_30_360", `${loan.label} receives draws; interest on 30/360 is accrued on the draw-weighted balance.`, ref);
    const schedule = buildLoanSchedule({ terms: loan, openingBalance: opening, accrualStart, draws: draws.filter(draw => draw.loanId === loan.id && draw.date > cutoff), ...(payoffOn.has(loan.id) ? { payoffOn: payoffOn.get(loan.id)!.date } : {}) });
    loanPlans.push({ id: loan.id, terms: loan, origin: "existing", opening, schedule, fundedOn: null, ref, ...(loan.propertyId ? { propertyId: loan.propertyId } : {}) });
  }
  for (const refinance of assumptions.refinances) {
    if (refinanceExcluded.has(refinance.id)) continue;
    const loan = refinance.newLoan;
    const gross = big(loan.principalCents!);
    const schedule = buildLoanSchedule({ terms: loan, openingBalance: ZERO, accrualStart: refinance.closeOn,
      draws: [{ date: refinance.closeOn, amount: gross }, ...draws.filter(draw => draw.loanId === loan.id && draw.date > refinance.closeOn)],
      ...(payoffOn.has(loan.id) ? { payoffOn: payoffOn.get(loan.id)!.date } : {}) });
    loanPlans.push({ id: loan.id, terms: loan, origin: "refinance", opening: ZERO, schedule, fundedOn: refinance.closeOn, ref: `refinances[${refinance.id}]`, ...(loan.propertyId ? { propertyId: loan.propertyId } : {}) });
  }
  for (const plan of loanPlans) {
    if (!plan.schedule) continue;
    const escrow = big(plan.terms.escrowMonthlyCents);
    // Draw rows appear in the schedule in the same (stable, date) order as the
    // draws passed to it; the refinance funding is the first draw of a new loan.
    const planDraws = [
      ...(plan.origin === "refinance" ? [null] : []),
      ...draws.filter(draw => draw.loanId === plan.id && draw.amount > ZERO && draw.date > (plan.fundedOn ?? cutoff))
        .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0)),
    ];
    let drawIndex = 0;
    for (const row of plan.schedule.rows) {
      if (row.kind === "draw") {
        const draw = planDraws[drawIndex++];
        if (!draw) continue;
        journal.post({ id: draw.id, date: draw.date, kind: "project_draw", label: draw.label, cashCategory: "loan_proceeds", cashFlowClass: "financing", modeled: true, ref: draw.ref, propertyId: draw.propertyId },
          [["cash_operating", draw.amount], ["debt", -draw.amount, plan.id]]);
        continue;
      }
      if (row.kind === "payoff") {
        const payoff = payoffOn.get(plan.id)!;
        journal.post({ id: `payoff:${plan.id}`, date: row.date, kind: "loan_payoff", label: `Loan payoff · ${plan.terms.label}`, cashCategory: "loan_payoffs", cashFlowClass: "financing", ref: payoff.ref, ...(plan.propertyId ? { propertyId: plan.propertyId } : {}) },
          [["interest_expense", row.interest], ["debt", row.principal, plan.id], ["cash_operating", -(row.interest + row.principal)]]);
        continue;
      }
      journal.post({ id: `loan-payment:${plan.id}:${row.date}`, date: row.date, kind: "loan_payment", label: `${row.kind === "balloon" ? "Balloon payment" : "Loan payment"} · ${plan.terms.label}`, cashCategory: "debt_service", cashFlowClass: "financing", ref: plan.ref, ...(plan.propertyId ? { propertyId: plan.propertyId } : {}) },
        [["interest_expense", row.interest], ["debt", row.principal, plan.id], ["cash_operating", -(row.interest + row.principal)]]);
      if (row.kind === "scheduled" && escrow !== ZERO) {
        journal.post({ id: `escrow:${plan.id}:${row.date}`, date: row.date, kind: "escrow_deposit", label: `Escrow deposit · ${plan.terms.label}`, cashCategory: null, cashFlowClass: "operating", ref: plan.ref, ...(plan.propertyId ? { propertyId: plan.propertyId } : {}) },
          [["cash_restricted", escrow], ["cash_operating", -escrow]]);
      }
    }
  }
  const scheduleFor = (loanId: string) => loanPlans.find(plan => plan.id === loanId);
  const payoffAmount = (loanId: string): bigint => {
    const row = scheduleFor(loanId)?.schedule?.rows.find(item => item.kind === "payoff");
    return row ? row.principal + row.interest : ZERO;
  };

  // ---------------------------------------------------------------- refinances
  const refinanceResults: ForecastRefinanceResult[] = [];
  for (const refinance of assumptions.refinances) {
    const ref = `refinances[${refinance.id}]`;
    const excluded = refinanceExcluded.has(refinance.id);
    const gross = refinance.newLoan.principalCents === null ? ZERO : big(refinance.newLoan.principalCents);
    const payoff = excluded ? ZERO : refinance.payoffLoanIds.reduce((total, loanId) => payoffOn.get(loanId)?.ref === ref ? total + payoffAmount(loanId) : total, ZERO);
    const costs = big(refinance.closingCostsCents) + big(refinance.prepaymentCostsCents);
    const reserves = big(refinance.reserveCents);
    refinanceResults.push({ id: refinance.id, label: refinance.label, closeOn: refinance.closeOn, grossProceedsCents: text(gross), payoffCents: text(payoff), costsCents: text(costs), reservesCents: text(reserves), netUsableCents: text(gross - payoff - costs - reserves), modeled: true, excluded });
    if (excluded) continue;
    journal.post({ id: `refinance:${refinance.id}:funding`, date: refinance.closeOn, kind: "loan_funding", label: `Refinance proceeds · ${refinance.label}`, cashCategory: "loan_proceeds", cashFlowClass: "financing", modeled: true, ref },
      [["cash_operating", gross], ["debt", -gross, refinance.newLoan.id]]);
    journal.post({ id: `refinance:${refinance.id}:costs`, date: refinance.closeOn, kind: "financing_cost", label: `Closing and prepayment costs · ${refinance.label}`, cashCategory: "financing_costs", cashFlowClass: "financing", ref },
      [["financing_costs", costs], ["cash_operating", -costs]]);
    journal.post({ id: `refinance:${refinance.id}:reserves`, date: refinance.closeOn, kind: "reserve_funding", label: `Lender reserves funded · ${refinance.label}`, cashCategory: null, cashFlowClass: "financing", ref },
      [["cash_restricted", reserves], ["cash_operating", -reserves]]);
  }

  // ---------------------------------------------------------------- sales
  const saleResults: ForecastSaleResult[] = [];
  for (const sale of assumptions.sales) {
    const ref = `sales[${sale.id}]`;
    const excluded = saleExcluded.has(sale.id);
    const property = properties.get(sale.propertyId)!;
    if (!property.fixedAsset) warn("sale_basis_unknown", `${property.name} has no book basis; the gain on sale is overstated until the basis is supplied.`, ref);
    const beforeClose = (account: string, sub: string) => {
      let value = subOpening.get(`${account}|${sub}`) ?? ZERO;
      for (const event of journal.events) if (event.date <= sale.closeOn) for (const [lineAccount, cents, lineSub] of event.lines) if (lineAccount === account && lineSub === sub) value += cents;
      return value;
    };
    const cost = beforeClose("fixed_assets", sale.propertyId);
    const accumulated = -beforeClose("accumulated_depreciation", sale.propertyId);
    const cipLines = assumptions.projects.filter(project => project.propertyId === sale.propertyId && !project.retired).map(project => [project.projectId, beforeClose("cip", project.projectId)] as const).filter(([, value]) => value !== ZERO);
    const cip = cipLines.reduce((total, [, value]) => total + value, ZERO);
    const price = big(sale.priceCents);
    const sellingCosts = big(sale.sellingCostsCents);
    const netBook = cost - accumulated + cip;
    const gain = price - sellingCosts - netBook;
    const payoff = excluded ? ZERO : sale.payoffLoanIds.reduce((total, loanId) => payoffOn.get(loanId)?.ref === ref ? total + payoffAmount(loanId) : total, ZERO);
    const deposits = sale.transferDeposits ? unitPlans.filter(plan => plan.unit.propertyId === sale.propertyId).reduce((total, plan) => total + plan.depositAtSale, ZERO) : ZERO;
    saleResults.push({ id: sale.id, label: sale.label, propertyId: sale.propertyId, closeOn: sale.closeOn, priceCents: text(price), sellingCostsCents: text(sellingCosts), netBookValueCents: text(netBook), gainCents: text(gain),
      payoffCents: text(payoff), depositsTransferredCents: text(deposits), netProceedsCents: text(price - sellingCosts - payoff - deposits), modeled: true, excluded });
    if (excluded) continue;
    journal.post({ id: `sale:${sale.id}`, date: sale.closeOn, kind: "sale", label: `Sale · ${sale.label}`, cashCategory: "sale_proceeds", cashFlowClass: "investing", modeled: true, ref, propertyId: sale.propertyId },
      [["cash_operating", price - sellingCosts], ["accumulated_depreciation", accumulated, sale.propertyId], ["fixed_assets", -cost, sale.propertyId],
        ...cipLines.map(([projectId, value]) => ["cip", -value, projectId] as const), ["gain_on_sale", -gain]]);
    for (const plan of unitPlans.filter(item => item.unit.propertyId === sale.propertyId && item.depositAtSale !== ZERO && sale.transferDeposits)) {
      journal.post({ id: `deposit-transfer:${sale.id}:${plan.unit.unitId}`, date: sale.closeOn, kind: "deposit_transfer", label: `Deposit transferred to buyer · ${plan.unit.label}`, cashCategory: "deposits", cashFlowClass: "operating", ref, propertyId: sale.propertyId },
        [["deposits_held", plan.depositAtSale, plan.unit.unitId], ["cash_operating", -plan.depositAtSale]]);
    }
  }

  // ---------------------------------------------------------------- investor flows
  for (const flow of assumptions.investorFlows) {
    const ref = `investorFlows[${flow.id}]`;
    for (const date of occurrences(flow.frequency, flow.firstOn, flow.endOn, cutoff, calendarEnd)) {
      const amount = big(flow.amountCents);
      const header = { id: `investor:${flow.id}:${date}`, date, kind: "investor_flow" as const, label: flow.label, cashCategory: "investor" as const, ref };
      if (flow.kind === "distribution") journal.post({ ...header, cashFlowClass: "financing" }, [["distributions", amount], ["cash_operating", -amount]]);
      else if (flow.kind === "contribution") journal.post({ ...header, cashFlowClass: "financing" }, [["cash_operating", amount], ["contributed_capital", -amount]]);
      else if (flow.kind === "investor_interest") journal.post({ ...header, cashFlowClass: "operating" }, [["interest_expense", amount], ["cash_operating", -amount]]);
      else journal.post({ ...header, cashFlowClass: "financing" }, [["contributed_capital", amount], ["cash_operating", -amount]]);
    }
  }

  // ---------------------------------------------------------------- views
  const events = [...journal.events].sort((left, right) => left.date < right.date ? -1 : left.date > right.date ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const cashNet = (event: InternalEvent) => event.lines.reduce((total, [account, cents]) => CASH_ACCOUNTS.has(account) ? total + cents : total, ZERO);
  const openingCash = (openingDebit.get("cash_operating") ?? ZERO) + (openingDebit.get("cash_restricted") ?? ZERO);
  const floor = big(scenario.reserveFloorCents);

  // Weekly treasury schedule (direct method).
  const weekRows: ForecastWeekRow[] = [];
  {
    let pointer = 0;
    let operating = openingDebit.get("cash_operating") ?? ZERO;
    let restricted = openingDebit.get("cash_restricted") ?? ZERO;
    const apply = (event: InternalEvent) => {
      for (const [account, cents] of event.lines) {
        if (account === "cash_operating") operating += cents;
        if (account === "cash_restricted") restricted += cents;
      }
    };
    while (pointer < events.length && events[pointer]!.date < weeks[0]!.start) apply(events[pointer++]!);
    for (const week of weeks) {
      const opening = operating + restricted;
      let inflows = ZERO; let outflows = ZERO; let modeledInflows = ZERO;
      const categories: Record<string, bigint> = {};
      while (pointer < events.length && events[pointer]!.date <= week.end) {
        const event = events[pointer++]!;
        const net = cashNet(event);
        apply(event);
        if (net === ZERO) continue;
        if (net > ZERO) { inflows += net; if (event.modeled) modeledInflows += net; } else outflows -= net;
        const category = event.cashCategory ?? "other";
        categories[category] = (categories[category] ?? ZERO) + net;
      }
      const closing = operating + restricted;
      weekRows.push({ key: week.key, start: week.start, end: week.end, openingCashCents: text(opening), inflowsCents: text(inflows), outflowsCents: text(outflows),
        netCents: text(inflows - outflows), closingCashCents: text(closing), restrictedClosingCents: text(restricted), availableClosingCents: text(operating),
        modeledInflowsCents: text(modeledInflows), belowReserveFloor: operating < floor,
        categories: Object.fromEntries(Object.entries(categories).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => [key, text(value)])) });
    }
  }

  // Monthly statements.
  const monthRows: ForecastMonthRow[] = [];
  const balanceAccounts = FORECAST_ACCOUNTS.filter(account => account.cashFlowClass !== "income_statement");
  const incomeAccounts = FORECAST_ACCOUNTS.filter(account => account.cashFlowClass === "income_statement");
  const checks: ForecastCheck[] = [];
  const failures = new Map<string, string[]>();
  const fail = (code: string, detail: string) => { const list = failures.get(code) ?? []; if (list.length < 5) list.push(detail); failures.set(code, list); };
  {
    const running = new Map<string, bigint>(balanceAccounts.map(account => [account.key, openingDebit.get(account.key) ?? ZERO]));
    let retained = ZERO;
    let pointer = 0;
    const applyBalances = (event: InternalEvent) => {
      for (const [account, cents] of event.lines) {
        if (running.has(account)) running.set(account, running.get(account)! + cents);
        else retained -= cents;
      }
    };
    while (pointer < events.length && events[pointer]!.date < months[0]!.start) applyBalances(events[pointer++]!);
    let previousRetained = retained;
    for (const month of months) {
      const openingCashMonth = running.get("cash_operating")! + running.get("cash_restricted")!;
      const income = new Map<string, bigint>();
      const operatingAdjustments = new Map<string, bigint>();
      const investing = new Map<string, bigint>();
      const financing = new Map<string, bigint>();
      const direct = new Map<string, bigint>();
      let netIncome = ZERO;
      let scheduledRent = ZERO;
      let saleReclass = ZERO;
      const addTo = (map: Map<string, bigint>, key: string, value: bigint) => map.set(key, (map.get(key) ?? ZERO) + value);
      while (pointer < events.length && events[pointer]!.date <= month.end) {
        const event = events[pointer++]!;
        const net = cashNet(event);
        if (net !== ZERO) addTo(direct, event.cashCategory ?? "other", net);
        for (const [account, cents] of event.lines) {
          const definition = FORECAST_ACCOUNT_BY_KEY[account]!;
          if (definition.cashFlowClass === "cash") continue;
          if (definition.cashFlowClass === "income_statement") {
            addTo(income, account, definition.type === "income" ? -cents : cents);
            netIncome -= cents;
            if (event.kind === "sale") { saleReclass += cents; addTo(investing, account, -cents); }
            if (event.kind === "rent_charge") scheduledRent -= cents;
            continue;
          }
          const cashClass = event.kind === "sale" && (account === "accumulated_depreciation" || account === "fixed_assets" || account === "cip") ? "investing" : definition.cashFlowClass;
          if (cashClass === "operating") addTo(operatingAdjustments, account, -cents);
          else if (cashClass === "investing") addTo(investing, account, -cents);
          else addTo(financing, account, -cents);
        }
        applyBalances(event);
      }
      const closingCash = running.get("cash_operating")! + running.get("cash_restricted")!;
      const line = (key: string, cents: bigint, label?: string): ForecastStatementLine => ({ key, label: label ?? FORECAST_ACCOUNT_BY_KEY[key]?.label ?? key, cents: text(cents) });
      const operatingLines: ForecastStatementLine[] = [line("net_income", netIncome, "Net income")];
      if (saleReclass !== ZERO) operatingLines.push(line("gain_on_sale", saleReclass, "Less gain on sale (investing)"));
      for (const account of balanceAccounts) {
        const value = operatingAdjustments.get(account.key);
        if (value !== undefined && value !== ZERO) operatingLines.push(line(account.key, value, account.key === "accumulated_depreciation" ? "Depreciation" : `Change in ${account.label.toLowerCase()}`));
      }
      const sectionLines = (map: Map<string, bigint>) => Array.from(map.entries()).filter(([, value]) => value !== ZERO)
        .sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => line(key, value));
      const operatingTotal = operatingLines.reduce((total, item) => total + big(item.cents), ZERO);
      const investingTotal = Array.from(investing.values()).reduce((total, value) => total + value, ZERO);
      const financingTotal = Array.from(financing.values()).reduce((total, value) => total + value, ZERO);
      const directTotal = Array.from(direct.values()).reduce((total, value) => total + value, ZERO);
      const indirect = operatingTotal + investingTotal + financingTotal;
      if (indirect !== directTotal) fail("direct_equals_indirect", `${month.label}: direct ${directTotal} vs indirect ${indirect}`);
      if (openingCashMonth + directTotal !== closingCash) fail("cash_rollforward", `${month.label}: opening + movement ≠ closing`);
      if (retained !== previousRetained + netIncome) fail("retained_earnings_rollforward", `${month.label}: retained earnings do not roll forward by net income`);
      previousRetained = retained;

      const balance: Record<string, string> = {};
      let assets = ZERO; let liabilities = ZERO; let equity = ZERO;
      for (const account of balanceAccounts) {
        const natural = naturalSign(account.key, running.get(account.key)!);
        balance[account.key] = text(natural);
        if (account.type === "asset") assets += natural;
        else if (account.type === "contra_asset") assets -= natural;
        else if (account.type === "liability") liabilities += natural;
        else if (account.key === "distributions") equity -= natural;
        else equity += natural;
      }
      balance.retained_earnings = text(retained);
      equity += retained;
      if (assets !== liabilities + equity) fail("balance_sheet_balances", `${month.label}: assets ${assets} ≠ liabilities ${liabilities} + equity ${equity}`);
      if (running.get("deposits_held")! > ZERO && openingAmount.get("deposits_held") !== null) fail("deposits_are_liabilities", `${month.label}: deposits held fell below zero`);

      const incomeRecord: Record<string, string> = {};
      for (const account of incomeAccounts) incomeRecord[account.key] = text(income.get(account.key) ?? ZERO);
      const revenue = (income.get("rental_income_tenant") ?? ZERO) + (income.get("rental_income_subsidy") ?? ZERO) - (income.get("concessions") ?? ZERO);
      const operatingExpenses = incomeAccounts.filter(account => account.group === "operating_expense").reduce((total, account) => total + (income.get(account.key) ?? ZERO), ZERO);

      let unitDays = 0; let occupiedDays = 0; let occupiedAtEnd = 0; let unitsAtEnd = 0;
      for (const plan of unitPlans) {
        unitDays += overlapDays(plan.ownedFrom, plan.ownedUntil, month.start, month.end);
        const ownedAtEnd = plan.ownedFrom <= month.end && plan.ownedUntil >= month.end;
        if (ownedAtEnd) unitsAtEnd += 1;
        for (const lease of plan.segments) {
          const end = minDate(lease.end, plan.ownedUntil);
          occupiedDays += overlapDays(lease.start, end, month.start, month.end);
          if (ownedAtEnd && lease.start <= month.end && end >= month.end) occupiedAtEnd += 1;
        }
      }
      monthRows.push({
        key: month.key, month: month.label, start: month.start, end: month.end, income: incomeRecord,
        revenueCents: text(revenue), operatingExpensesCents: text(operatingExpenses), noiCents: text(revenue - operatingExpenses), netIncomeCents: text(netIncome),
        balance, totalAssetsCents: text(assets), totalLiabilitiesCents: text(liabilities), totalEquityCents: text(equity),
        cashFlow: {
          openingCashCents: text(openingCashMonth), netIncomeCents: text(netIncome), operating: operatingLines,
          investing: sectionLines(investing), financing: sectionLines(financing),
          operatingCents: text(operatingTotal), investingCents: text(investingTotal), financingCents: text(financingTotal),
          indirectNetChangeCents: text(indirect),
          direct: Array.from(direct.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, label: key, cents: text(value) })),
          directNetChangeCents: text(directTotal), closingCashCents: text(closingCash),
        },
        operations: { unitDays, occupiedUnitDays: occupiedDays, occupancyBps: unitDays === 0 ? null : Math.floor((occupiedDays * 10_000) / unitDays),
          scheduledRentCents: text(scheduledRent), occupiedUnitsAtEnd: occupiedAtEnd, unitsAtEnd },
      });
    }
  }

  // ---------------------------------------------------------------- invariant checks
  weekRows.forEach((week, index) => {
    if (big(week.openingCashCents) + big(week.netCents) !== big(week.closingCashCents)) fail("cash_rollforward", `${week.start}: opening + net ≠ closing`);
    const previous = weekRows[index - 1];
    if (previous && previous.closingCashCents !== week.openingCashCents) fail("cash_rollforward", `${week.start}: opening ≠ prior closing`);
  });
  monthRows.forEach((month, index) => {
    const previous = monthRows[index - 1];
    if (previous && previous.cashFlow.closingCashCents !== month.cashFlow.openingCashCents) fail("cash_rollforward", `${month.month}: opening ≠ prior closing`);
  });
  // Weekly and monthly views bucket the same events exactly once each.
  {
    const lastWeekEnd = weeks.at(-1)!.end;
    const weekTotal = weekRows.reduce((total, week) => total + big(week.netCents), ZERO);
    const monthTotals = new Map<number, bigint>();
    for (const event of events) {
      if (event.date < weeks[0]!.start || event.date > lastWeekEnd) continue;
      const index = periodIndexFor(months, event.date);
      monthTotals.set(index, (monthTotals.get(index) ?? ZERO) + cashNet(event));
    }
    const viaMonths = Array.from(monthTotals.values()).reduce((total, value) => total + value, ZERO);
    if (weekTotal !== viaMonths) fail("weekly_monthly_agree", `weekly ${weekTotal} vs monthly ${viaMonths}`);
    const overlapping = months.filter((month, index) => index > 0 && month.start <= months[index - 1]!.end);
    if (overlapping.length) fail("weekly_monthly_agree", "Monthly periods overlap");
  }
  // Debt: the journal's loan balances equal the loan schedules at every month end.
  for (const month of monthRows) {
    let scheduled = ZERO;
    for (const plan of loanPlans) if (plan.schedule && plan.opening !== null) scheduled += balanceOn(plan.schedule, plan.opening, minDate(month.end, calendarEnd));
    if (big(month.balance.debt!) !== scheduled) fail("debt_rollforward", `${month.month}: loans payable ${month.balance.debt} vs schedules ${scheduled}`);
  }
  // Subsidy is part of contract rent, never an addition to it.
  for (const event of events) {
    if (event.kind !== "rent_charge") continue;
    const tenant = event.lines.find(line => line[0] === "rental_income_tenant")?.[1] ?? ZERO;
    const subsidy = event.lines.find(line => line[0] === "rental_income_subsidy")?.[1] ?? ZERO;
    const receivable = event.lines.filter(line => line[0] === "rent_receivable" || line[0] === "subsidy_receivable").reduce((total, line) => total + line[1], ZERO);
    if (receivable !== -(tenant + subsidy) || -subsidy < ZERO || -tenant < ZERO) fail("subsidy_not_duplicated", `${event.id}: tenant and subsidy portions do not sum to the charge`);
  }
  for (const key of Array.from(new Set(laborReplacements))) {
    const [target, week] = key.split("|") as [string, string];
    const [kind, id] = target.split(":") as [string, string];
    const duplicate = events.some(event => mondayOf(event.date) === week && (kind === "project" ? event.kind === "project_labor" && event.ref === `projects[${id}]` : event.kind !== "labor_actual" && event.ref === `expenses[${id}]` && expenses.get(id)?.laborEstimate));
    if (duplicate) fail("labor_not_duplicated", `${key}: estimated labor posted alongside approved time`);
  }
  if (events.some(event => event.modeled && event.date <= cutoff)) fail("modeled_proceeds_not_actual", "A modeled capital event is dated inside the actual period");
  const CHECKS: readonly [string, string][] = [
    ["journal_balanced", "Every forecast event is a balanced journal entry."],
    ["balance_sheet_balances", "Assets equal liabilities plus equity in every month."],
    ["cash_rollforward", "Opening cash plus net movement equals closing cash in every week and month."],
    ["direct_equals_indirect", "Direct cash receipts and payments equal the indirect cash-flow statement."],
    ["retained_earnings_rollforward", "Retained earnings roll forward by net income."],
    ["debt_rollforward", "Loan balances agree with their amortization schedules."],
    ["deposits_are_liabilities", "Security deposits stay liabilities and never turn into an asset."],
    ["subsidy_not_duplicated", "Housing assistance is a portion of contract rent, not an addition."],
    ["weekly_monthly_agree", "Weekly and monthly views count each cash event exactly once."],
    ["labor_not_duplicated", "Approved time replaces estimated labor for the same week."],
    ["modeled_proceeds_not_actual", "Modeled refinance, sale and draw proceeds are never actual cash."],
  ];
  for (const [code, description] of CHECKS) {
    const failed = failures.get(code);
    checks.push({ code, passed: !failed, detail: failed ? failed.join("; ") : description });
  }

  // ---------------------------------------------------------------- debt views
  const loanSchedules: ForecastLoanSchedule[] = loanPlans.map(plan => ({
    loanId: plan.id, label: plan.terms.label, lender: plan.terms.lender ?? null, origin: plan.origin, principalKnown: plan.opening !== null,
    openingPrincipalCents: plan.opening === null ? null : text(plan.opening), annualRateBps: plan.terms.annualRateBps, maturityOn: plan.terms.maturityOn,
    balloonCents: plan.schedule?.balloon === null || plan.schedule === null ? null : text(plan.schedule.balloon),
    fundedOn: plan.fundedOn, paidOffOn: plan.schedule?.paidOffOn ?? null,
    payments: (plan.schedule?.rows ?? []).map(row => ({ date: row.date, interestCents: text(row.interest), principalCents: text(row.principal), balanceCents: text(row.balance), kind: row.kind })),
  }));
  const coverage: ForecastCoverageRow[] = monthRows.map(month => {
    let service = ZERO;
    for (const plan of loanPlans) for (const row of plan.schedule?.rows ?? []) if (row.kind === "scheduled" && row.date >= month.start && row.date <= month.end) service += row.interest + row.principal;
    const noi = big(month.noiCents);
    return { month: month.month, noiCents: month.noiCents, debtServiceCents: text(service), dscrBps: service === ZERO ? null : Number((noi * BigInt(10_000)) / service) };
  });
  const ladderMap = new Map<string, { maturing: bigint; scheduled: bigint }>();
  for (const plan of loanPlans) {
    for (const row of plan.schedule?.rows ?? []) {
      const year = row.date.slice(0, 4);
      const entry = ladderMap.get(year) ?? { maturing: ZERO, scheduled: ZERO };
      if (row.kind === "balloon" || (row.kind === "scheduled" && row.date === plan.terms.maturityOn)) entry.maturing += row.principal;
      else if (row.kind === "scheduled") entry.scheduled += row.principal;
      ladderMap.set(year, entry);
    }
  }
  const ladder = Array.from(ladderMap.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([year, value]) => ({ year, maturingCents: text(value.maturing), scheduledPrincipalCents: text(value.scheduled) }));

  // ---------------------------------------------------------------- owner planning view (never in company statements)
  let owner: ForecastOwnerView | null = null;
  if (assumptions.ownerItems.length) {
    const dated = assumptions.ownerItems.flatMap(item => occurrences(item.frequency, item.firstOn, item.endOn, cutoff, calendarEnd).map(date => ({ date, amount: big(item.amountCents) })));
    const bucket = (periods: readonly ForecastPeriod[]) => {
      let cumulative = ZERO;
      return periods.map(period => {
        const net = dated.filter(item => item.date >= period.start && item.date <= period.end).reduce((total, item) => total + item.amount, ZERO);
        cumulative += net;
        return { key: period.key, netCents: text(net), cumulativeCents: text(cumulative) };
      });
    };
    owner = { weeks: bucket(weeks), months: bucket(months) };
  }

  // ---------------------------------------------------------------- summary
  let minAvailable: bigint | null = null; let minWeek: string | null = null;
  for (const week of weekRows) {
    const available = big(week.availableClosingCents);
    if (minAvailable === null || available < minAvailable) { minAvailable = available; minWeek = week.start; }
  }
  const complete = unknown.length === 0 && !warnings.some(item => item.code === "sale_basis_unknown");
  const publicEvents: ForecastEvent[] = events.map(event => ({
    id: event.id, date: event.date, kind: event.kind, label: event.label, cashCategory: event.cashCategory, cashFlowClass: event.cashFlowClass,
    modeled: event.modeled === true, ref: event.ref, ...(event.propertyId ? { propertyId: event.propertyId } : {}), ...(event.sourceIds?.length ? { sourceIds: [...event.sourceIds] } : {}),
    entries: event.lines.map(([account, cents, sub]) => (sub ? { a: account, c: text(cents), s: sub } : { a: account, c: text(cents) })),
  }));
  const openingBalances: Record<string, string> = {};
  for (const account of balanceAccounts) openingBalances[account.key] = text(naturalSign(account.key, openingDebit.get(account.key) ?? ZERO));
  return {
    modelVersion: FORECAST_MODEL_VERSION,
    currency: assumptions.currency,
    scenario: { name: scenario.name, kind: scenario.kind, startDate: scenario.startDate, horizonWeeks: scenario.horizonWeeks, horizonMonths: scenario.horizonMonths, reserveFloorCents: text(floor) },
    actualsCutoff: cutoff,
    calendarEnd,
    rounding: "half_even",
    completeness: complete ? "complete" : "partial",
    opening: { asOf: cutoff, items: openingItems, complete: unknown.length === 0, unknown, balances: openingBalances },
    weeks: weekRows,
    months: monthRows,
    debt: { loans: loanSchedules, coverage, ladder },
    capital: { refinances: refinanceResults, sales: saleResults },
    owner,
    checks,
    warnings,
    summary: {
      minAvailableCashCents: minAvailable === null ? null : text(minAvailable), minAvailableWeek: minWeek,
      endingCashCents: monthRows.at(-1)?.cashFlow.closingCashCents ?? null,
      weeksBelowFloor: weekRows.filter(week => week.belowReserveFloor).length,
      totalNoiCents: text(monthRows.reduce((total, month) => total + big(month.noiCents), ZERO)),
      totalNetIncomeCents: text(monthRows.reduce((total, month) => total + big(month.netIncomeCents), ZERO)),
      eventCount: publicEvents.length,
    },
    events: publicEvents,
  };
}

