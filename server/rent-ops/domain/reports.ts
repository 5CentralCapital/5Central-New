import { tenantAccountLedgerRows } from "./account-ledger";
import { isSourceAllocationReversal } from "./invariants";
import type {
  ApplicantPublicView,
  ApplicantPipelineRow,
  Cents,
  DashboardSummary,
  DelinquencyRow,
  DepositLiabilityRow,
  FixedReportName,
  HapRow,
  IsoDate,
  IsoMonth,
  LedgerRow,
  LeaseExpirationRow,
  OccupancyRow,
  OccupancyState,
  RentOpsFilters,
  RentOpsLeaseTerm,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsSubsidyContract,
  RentOpsTenancy,
  RentOpsUnit,
  RentRollRow,
  ScheduledIncomeRow,
  ScheduledVsCollectedRow,
  CollectedIncomeRow,
  TenantProfile,
} from "../../../shared/rent-ops-contracts";
import { activeTenancyViolations, assertNoOverlappingBaseRentSchedules, effectiveLedgerKind, effectiveSchedules, ledgerBalanceSign, RentOpsInvariantError } from "./invariants";
import { financialProjectionControls, projectFinancialSchedules, type FinancialProjectionControls } from "./financial-projection";
import { addDays, compareIsoDate, daysBetween, isDateOnOrBefore, isEffectiveOn, monthFromDate, monthStart, nowIsoDate } from "./dates";

// Subsidy/HAP is reported separately from tenant collected income. A base
// rent schedule represents the full contractual rent; adding a subsidy row to
// scheduled income would double count the same obligation.
const incomeCategories = new Set(["base_rent", "recurring_fee", "one_time_fee"]);
const balanceCategories = new Set(["base_rent", "recurring_fee", "one_time_fee", "subsidy", "other"]);

function asOfDate(filters: RentOpsFilters = {}): IsoDate {
  return filters.asOfDate ?? nowIsoDate();
}

function reportMonth(filters: RentOpsFilters = {}): IsoMonth {
  return filters.month ?? monthFromDate(asOfDate(filters));
}

function scopedProperties(snapshot: RentOpsSnapshot, filters: RentOpsFilters): RentOpsProperty[] {
  const selected = snapshot.properties.filter((property) => !filters.propertyId || property.id === filters.propertyId);
  // An explicit property selection is already a deliberate scope choice. The
  // active portfolio scope only narrows the unselected operational default;
  // omitted scope remains the complete imported snapshot for migration/audit
  // callers that need source totals.
  if (filters.propertyId || filters.propertyScope !== "active") return selected;
  return selected.filter((property) => property.state === "active");
}

function scopedPropertyIds(snapshot: RentOpsSnapshot, filters: RentOpsFilters): Set<string> {
  return new Set(scopedProperties(snapshot, filters).map((property) => property.id));
}

function matchesPropertyScope(propertyId: string | null | undefined, filters: RentOpsFilters, propertyIds: ReadonlySet<string>, includeUnassigned = false): boolean {
  if (filters.propertyId) return propertyId === filters.propertyId;
  // The full source view must retain unresolved property links and amounts.
  if (filters.propertyScope !== "active") return true;
  return propertyId ? propertyIds.has(propertyId) : includeUnassigned;
}

function scopedUnits(snapshot: RentOpsSnapshot, filters: RentOpsFilters): RentOpsUnit[] {
  const propertyIds = scopedPropertyIds(snapshot, filters);
  return snapshot.units.filter((unit) =>
    matchesPropertyScope(unit.propertyId, filters, propertyIds) &&
    (!filters.unitId || unit.id === filters.unitId) &&
    (!filters.readiness || filters.readiness.includes(unit.readiness)) &&
    (!filters.listing || filters.listing.includes(unit.listing)),
  );
}

function propertyMap(snapshot: RentOpsSnapshot): Map<string, RentOpsProperty> {
  return new Map(snapshot.properties.map((property) => [property.id, property]));
}

function unitMap(snapshot: RentOpsSnapshot): Map<string, RentOpsUnit> {
  return new Map(snapshot.units.map((unit) => [unit.id, unit]));
}

function personMap(snapshot: RentOpsSnapshot): Map<string, RentOpsPerson> {
  return new Map(snapshot.people.map((person) => [person.id, person]));
}

function occupancyMoveInOn(tenancy: RentOpsTenancy): IsoDate | undefined {
  // A future lease's MoveInDate is prospective unless RM returned an explicit
  // actual move-in field.  A v3 row carries date-knowledge markers; for that
  // shape, an actual date on a future tenancy is not occupancy evidence.  The
  // marker-free branch is retained solely for legacy v1/v2 snapshots.
  if (tenancy.status === "future") {
    if (tenancy.plannedMoveInOn) return tenancy.plannedMoveInOn;
    return tenancy.plannedMoveInKnowledge === undefined && tenancy.actualMoveInKnowledge === undefined
      ? tenancy.actualMoveInOn
      : undefined;
  }
  return tenancy.actualMoveInOn;
}

function knownAmount(value: unknown): value is Cents {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function compareOptionalTimestamp(left?: string | null, right?: string | null): number {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function unresolvedTenancyForUnit(snapshot: RentOpsSnapshot, unit: RentOpsUnit, asOf: IsoDate): string[] {
  const codes: string[] = [];
  for (const tenancy of snapshot.tenancies) {
    const status = tenancy.status as string | undefined;
    const knownStatus = ["current", "notice", "future", "past", "cancelled"].includes(status ?? "");
    const activeOrFuture = status === "current" || status === "notice" || status === "future";
    if (!knownStatus) {
      const sameUnit = tenancy.unitId === unit.id;
      const unknownUnit = !tenancy.unitId || tenancy.unitLinkKnowledge === "unknown" || tenancy.unitLinkKnowledge === "ambiguous";
      const sameProperty = tenancy.propertyId === unit.propertyId || !tenancy.propertyId || tenancy.propertyLinkKnowledge === "unknown" || tenancy.propertyLinkKnowledge === "ambiguous";
      if (sameUnit || (unknownUnit && sameProperty)) codes.push("tenancy_status_unknown");
      continue;
    }
    const sameUnit = tenancy.unitId === unit.id;
    const unknownUnit = !tenancy.unitId || tenancy.unitLinkKnowledge === "unknown" || tenancy.unitLinkKnowledge === "ambiguous";
    const sameProperty = tenancy.propertyId === unit.propertyId || !tenancy.propertyId || tenancy.propertyLinkKnowledge === "unknown" || tenancy.propertyLinkKnowledge === "ambiguous";
    if (!sameUnit && !(unknownUnit && sameProperty)) continue;
    if (unknownUnit) codes.push("unit_link_unknown");
    if (!status || !["current", "notice", "future", "past", "cancelled"].includes(status)) codes.push("tenancy_status_unknown");
    if ((status === "current" || status === "notice") && !occupancyMoveInOn(tenancy)) codes.push("actual_move_in_unknown");
    if (status === "future" && (!occupancyMoveInOn(tenancy) || occupancyMoveInOn(tenancy)! <= asOf)) codes.push("planned_move_in_unknown");
  }
  return Array.from(new Set(codes)).sort();
}

function displayName(person: RentOpsPerson | undefined): string {
  if (!person) return "Unknown applicant/tenant";
  return `${person.firstName} ${person.lastName}`.trim();
}

function currentTenanciesForUnit(snapshot: RentOpsSnapshot, unitId: string, asOf: IsoDate): RentOpsTenancy[] {
  return snapshot.tenancies.filter((tenancy) =>
    tenancy.unitId === unitId &&
    (tenancy.status === "current" || tenancy.status === "notice") &&
    isDateOnOrBefore(occupancyMoveInOn(tenancy), asOf) &&
    (!tenancy.actualMoveOutOn || tenancy.actualMoveOutOn > asOf),
  );
}

function futureTenanciesForUnit(snapshot: RentOpsSnapshot, unitId: string, asOf: IsoDate): RentOpsTenancy[] {
  return snapshot.tenancies.filter((tenancy) =>
    tenancy.unitId === unitId &&
    tenancy.status === "future" &&
    !!occupancyMoveInOn(tenancy) && occupancyMoveInOn(tenancy)! > asOf,
  );
}

function chooseLatestTenancy(tenancies: RentOpsTenancy[]): RentOpsTenancy | undefined {
  return [...tenancies].sort((left, right) => compareIsoDate(occupancyMoveInOn(right), occupancyMoveInOn(left)) || compareOptionalTimestamp(right.createdAt, left.createdAt) || right.id.localeCompare(left.id))[0];
}

function chooseUpcomingTenancy(tenancies: RentOpsTenancy[]): RentOpsTenancy | undefined {
  return [...tenancies].sort((left, right) => compareIsoDate(occupancyMoveInOn(left), occupancyMoveInOn(right)) || compareOptionalTimestamp(left.createdAt, right.createdAt) || left.id.localeCompare(right.id))[0];
}

function activeLeaseTerm(snapshot: RentOpsSnapshot, tenancyId: string, asOf: IsoDate): RentOpsLeaseTerm | undefined {
  const terms = snapshot.leaseTerms.filter((term) =>
    term.tenancyId === tenancyId &&
    // A null/unknown term status is not evidence of an operational lease.
    // Only explicit executed or month-to-month terms can prove occupancy.
    (term.status === "executed" || term.status === "month_to_month") &&
    !!term.contractStartOn && term.contractStartOn <= asOf &&
    (!term.contractEndOn || term.contractEndOn >= asOf),
  );
  return [...terms].sort((left, right) => right.contractStartOn!.localeCompare(left.contractStartOn!) || compareOptionalTimestamp(right.createdAt, left.createdAt) || right.id.localeCompare(left.id))[0];
}

function upcomingLeaseTerm(snapshot: RentOpsSnapshot, tenancyId: string, asOf: IsoDate): RentOpsLeaseTerm | undefined {
  const terms = snapshot.leaseTerms.filter((term) =>
    term.tenancyId === tenancyId &&
    // A draft is an explicit source state, but it is not an executed lease
    // and therefore cannot prove a current or future prelease in reports.
    (term.status === "executed" || term.status === "month_to_month") &&
    (!term.contractEndOn || term.contractEndOn >= asOf),
  );
  const future = terms.filter((term) => !!term.contractStartOn && term.contractStartOn >= asOf).sort((left, right) => left.contractStartOn!.localeCompare(right.contractStartOn!) || left.id.localeCompare(right.id));
  return future[0] ?? terms.filter((term) => !!term.contractStartOn && term.contractStartOn < asOf).sort((left, right) => right.contractStartOn!.localeCompare(left.contractStartOn!) || right.id.localeCompare(left.id))[0];
}

function effectiveSchedulesFor(
  snapshot: RentOpsSnapshot,
  tenancyId: string,
  date: IsoDate,
): RentOpsRecurringChargeSchedule[] {
  const tenancy = snapshot.tenancies.find((candidate) => candidate.id === tenancyId);
  const allowPersonScopedTenant = tenancy
    ? snapshot.tenancies.filter((candidate) =>
      candidate.id !== tenancy.id &&
      candidate.primaryPersonId === tenancy.primaryPersonId &&
      candidate.propertyId === tenancy.propertyId &&
      candidate.unitId === tenancy.unitId,
    ).length === 0
    : false;
  return effectiveSchedules(snapshot.recurringSchedules, tenancyId, date, tenancy ? {
    personId: tenancy.primaryPersonId,
    unitId: tenancy.unitId,
    propertyId: tenancy.propertyId,
    allowPersonScopedTenant,
  } : {});
}

function scheduledAmounts(snapshot: RentOpsSnapshot, tenancyId: string, date: IsoDate): { baseRentCents?: Cents; recurringFeesCents: Cents; subsidyCents: Cents } {
  // Property-scoped schedules are reported once at property level and are
  // intentionally excluded from a unit rent-roll amount.
  const schedules = effectiveSchedulesFor(snapshot, tenancyId, date).filter((schedule) => schedule.scopeType !== "property");
  const base = schedules.find((schedule) => schedule.category === "base_rent");
  return {
    baseRentCents: base && knownAmount(base.amountCents) ? base.amountCents : undefined,
    recurringFeesCents: schedules.filter((schedule) => schedule.category === "recurring_fee").reduce((sum, schedule) => sum + (knownAmount(schedule.amountCents) ? schedule.amountCents : 0), 0),
    subsidyCents: schedules.filter((schedule) => schedule.category === "subsidy").reduce((sum, schedule) => sum + (knownAmount(schedule.amountCents) ? schedule.amountCents : 0), 0),
  };
}

function isBalanceCategory(category: string | null): boolean {
  return category !== null && balanceCategories.has(category);
}

interface AccountBalance {
  rentOnlyBalanceCents: Cents;
  nonRentBalanceCents: Cents;
  totalBalanceCents: Cents;
  unappliedCashCents: Cents;
  prepaidCents: Cents;
  oldestUnpaidRentOn?: IsoDate;
}

function assertNoAmbiguousOccupancy(snapshot: RentOpsSnapshot, asOf = nowIsoDate()): void {
  const violations = activeTenancyViolations(snapshot);
  const futureByUnit = new Map<string, RentOpsTenancy[]>();
  for (const tenancy of snapshot.tenancies) {
    const moveInOn = occupancyMoveInOn(tenancy);
    if ((tenancy.status === "current" || tenancy.status === "notice") && !moveInOn) violations.push({ code: "current_move_in_missing", entityId: tenancy.id, message: `Current tenancy ${tenancy.id} has no actual move-in date` });
    if ((tenancy.status === "current" || tenancy.status === "notice") && moveInOn && moveInOn > asOf) violations.push({ code: "current_move_in_future", entityId: tenancy.id, message: `Current tenancy ${tenancy.id} starts after the report as-of date` });
    if ((tenancy.status === "current" || tenancy.status === "notice") && tenancy.actualMoveOutOn && tenancy.actualMoveOutOn <= asOf) violations.push({ code: "current_move_out_stale", entityId: tenancy.id, message: `Current tenancy ${tenancy.id} has already moved out as of the report date` });
    if (tenancy.status === "future" && !moveInOn) violations.push({ code: "future_move_in_missing", entityId: tenancy.id, message: `Future tenancy ${tenancy.id} has no scheduled move-in date` });
    if (tenancy.status === "future" && moveInOn && moveInOn <= asOf) violations.push({ code: "future_move_in_elapsed", entityId: tenancy.id, message: `Future tenancy ${tenancy.id} has reached its move-in date but is still marked future` });
    if (tenancy.status === "future" && moveInOn && moveInOn > asOf) {
      const terms = snapshot.leaseTerms.filter((term) => term.tenancyId === tenancy.id && term.status !== "cancelled" && (!term.contractEndOn || term.contractEndOn >= asOf));
      if (!terms.length) violations.push({ code: "future_lease_term_missing", entityId: tenancy.id, message: `Future tenancy ${tenancy.id} has no upcoming lease term` });
      const existing = futureByUnit.get(tenancy.unitId) ?? [];
      existing.push(tenancy);
      futureByUnit.set(tenancy.unitId, existing);
    }
  }
  for (const [unitId, futures] of Array.from(futureByUnit.entries())) {
    if (futures.length > 1) violations.push({ code: "multiple_future_tenancies", entityId: unitId, message: `Unit ${unitId} has ${futures.length} future tenancies` });
    const future = chooseUpcomingTenancy(futures);
    const current = chooseLatestTenancy(currentTenanciesForUnit(snapshot, unitId, asOf));
    if (future && current && (!current.expectedMoveOutOn || current.expectedMoveOutOn >= (occupancyMoveInOn(future) as IsoDate))) {
      violations.push({ code: "future_conflicts_current", entityId: future.id, message: `Future tenancy ${future.id} overlaps the current occupancy for unit ${unitId}` });
    }
  }
  if (violations.length > 0) throw new RentOpsInvariantError("Overlapping current tenancies or lease terms must be corrected before reporting", violations);
}

interface EffectiveAllocation {
  allocation: RentOpsSnapshot["paymentAllocations"][number] & { paymentTransactionId: string; chargeTransactionId: string; amountCents: Cents; allocatedOn: IsoDate };
  payment: RentOpsSnapshot["ledgerTransactions"][number] & { kind: "payment"; status: "posted"; amountCents: Cents; postedOn: IsoDate };
  charge: RentOpsSnapshot["ledgerTransactions"][number] & { kind: "charge"; status: "posted"; amountCents: Cents; postedOn: IsoDate };
}

interface ReversalSets {
  paymentIds: Set<string>;
  chargeIds: Set<string>;
  creditIds: Set<string>;
}

function reversalSets(snapshot: RentOpsSnapshot, asOf: IsoDate): ReversalSets {
  const transactions = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.id, transaction]));
  const paymentIds = new Set<string>();
  const chargeIds = new Set<string>();
  const creditIds = new Set<string>();
  for (const transaction of snapshot.ledgerTransactions) {
    if (transaction.kind !== "reversal" || transaction.status !== "posted" || !transaction.reversalOfId || !transaction.postedOn || transaction.postedOn > asOf) continue;
    const original = transactions.get(transaction.reversalOfId);
    if (!original) continue;
    const kind = effectiveLedgerKind(original, transactions);
    if (kind === "payment") paymentIds.add(original.id);
    else if (kind === "charge") chargeIds.add(original.id);
    else if (kind === "credit") creditIds.add(original.id);
  }
  return { paymentIds, chargeIds, creditIds };
}

function effectiveAllocations(snapshot: RentOpsSnapshot, asOf: IsoDate, tenancyId?: string): EffectiveAllocation[] {
  const transactions = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.id, transaction]));
  const reversed = reversalSets(snapshot, asOf);
  const result: EffectiveAllocation[] = [];
  for (const allocation of snapshot.paymentAllocations) {
    if (allocation.kind === "transfer" || allocation.kind === "credit_allocation") continue;
    // Money/date-specific reports exclude unknown allocation dates or
    // amounts; the immutable allocation row remains in the snapshot.
    const paymentTransactionId = allocation.paymentTransactionId;
    const chargeTransactionId = allocation.chargeTransactionId;
    const allocatedOn = allocation.allocatedOn;
    const amountCents = allocation.amountCents;
    if (typeof amountCents === "number" && amountCents < 0 && !isSourceAllocationReversal(allocation)) continue;
    if (!paymentTransactionId || !chargeTransactionId || !allocatedOn || !knownAmount(amountCents) || allocatedOn > asOf) continue;
    const payment = transactions.get(paymentTransactionId);
    const charge = transactions.get(chargeTransactionId);
    if (!payment || !charge || payment.kind !== "payment" || charge.kind !== "charge") continue;
    if (payment.status !== "posted" || charge.status !== "posted") continue;
    const paymentPostedOn = payment.postedOn;
    const chargePostedOn = charge.postedOn;
    const paymentAmountCents = payment.amountCents;
    const chargeAmountCents = charge.amountCents;
    if (!paymentPostedOn || !chargePostedOn || !knownAmount(paymentAmountCents) || !knownAmount(chargeAmountCents) || paymentPostedOn > asOf || chargePostedOn > asOf) continue;
    if (reversed.paymentIds.has(payment.id) || reversed.chargeIds.has(charge.id)) continue;
    if (tenancyId && payment.tenancyId !== tenancyId && charge.tenancyId !== tenancyId) continue;
    result.push({
      allocation: { ...allocation, paymentTransactionId, chargeTransactionId, amountCents, allocatedOn },
      payment: { ...payment, kind: "payment", status: "posted", amountCents: paymentAmountCents, postedOn: paymentPostedOn },
      charge: { ...charge, kind: "charge", status: "posted", amountCents: chargeAmountCents, postedOn: chargePostedOn },
    });
  }
  return result;
}

function effectiveCreditAllocations(snapshot: RentOpsSnapshot, cutoff: IsoDate) {
  const transactions = new Map(snapshot.ledgerTransactions.map(row => [row.id, row]));
  const reversed = reversalSets(snapshot, cutoff);
  return snapshot.paymentAllocations.flatMap(allocation => {
    if (allocation.kind !== "credit_allocation" || allocation.paymentTransactionId || !allocation.creditTransactionId || !allocation.chargeTransactionId ||
      allocation.creditLinkKnowledge !== "exact" || allocation.chargeLinkKnowledge !== "exact" ||
      !knownAmount(allocation.amountCents) || allocation.amountCents <= 0 || !allocation.allocatedOn || allocation.allocatedOn > cutoff) return [];
    const credit = transactions.get(allocation.creditTransactionId);
    const charge = transactions.get(allocation.chargeTransactionId);
    if (!credit || credit.kind !== "credit" || !charge || charge.kind !== "charge" ||
      credit.status !== "posted" || charge.status !== "posted" || !credit.postedOn || !charge.postedOn ||
      credit.postedOn > cutoff || charge.postedOn > cutoff ||
      !knownAmount(credit.amountCents) || !knownAmount(charge.amountCents) ||
      reversed.creditIds.has(credit.id) || reversed.chargeIds.has(charge.id)) return [];
    return [{ allocation: { ...allocation, amountCents: allocation.amountCents, allocatedOn: allocation.allocatedOn }, effectiveOn: [credit.postedOn,allocation.allocatedOn,charge.postedOn].sort().at(-1)!, credit, charge }];
  });
}

/** A receipt remains one source transaction; property applications are views,
 * and the remainder belongs only to the shared root. */
export function deriveSharedPaymentApplications(snapshot: RentOpsSnapshot, filters: Pick<RentOpsFilters, "asOfDate"> = {}) {
  const cutoff = asOfDate(filters);
  const reversed = reversalSets(snapshot, cutoff);
  const allocations = effectiveAllocations(snapshot, cutoff);
  return snapshot.ledgerTransactions.filter((payment) =>
    payment.kind === "payment" && payment.allocationMode === "multi_property" &&
    payment.status === "posted" && payment.postedOn && payment.postedOn <= cutoff &&
    knownAmount(payment.amountCents) && !reversed.paymentIds.has(payment.id),
  ).map((payment) => {
    const byProperty = new Map<string, Cents>();
    for (const { allocation, charge, payment: parent } of allocations) {
      if (parent.id !== payment.id || !charge.propertyId) continue;
      byProperty.set(charge.propertyId, (byProperty.get(charge.propertyId) ?? 0) + allocation.amountCents);
    }
    const propertyApplications = Array.from(byProperty).sort(([left], [right]) => left.localeCompare(right))
      .map(([propertyId, allocatedCents]) => ({ propertyId, allocatedCents }));
    const allocatedCents = propertyApplications.reduce((sum, row) => sum + row.allocatedCents, 0);
    return { paymentTransactionId: payment.id, personId: payment.personId ?? null,
      paymentOn: payment.postedOn!, receiptAmountCents: payment.amountCents!,
      propertyApplications, allocatedCents, unappliedCents: payment.amountCents! - allocatedCents };
  });
}

function accountBalance(snapshot: RentOpsSnapshot, tenancyId: string, asOf: IsoDate): AccountBalance {
  const transactions = snapshot.ledgerTransactions.filter((transaction) =>
    transaction.tenancyId === tenancyId && transaction.status === "posted" && !!transaction.postedOn && knownAmount(transaction.amountCents) && transaction.postedOn <= asOf,
  );
  const transactionMap = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.id, transaction]));
  const reversed = reversalSets(snapshot, asOf);
  const allocationsByCharge = new Map<string, number>();
  const allocationsByPayment = new Map<string, number>();
  for (const effective of effectiveAllocations(snapshot, asOf, tenancyId)) {
    allocationsByCharge.set(effective.charge.id, (allocationsByCharge.get(effective.charge.id) ?? 0) + effective.allocation.amountCents);
    allocationsByPayment.set(effective.payment.id, (allocationsByPayment.get(effective.payment.id) ?? 0) + effective.allocation.amountCents);
  }
  const allocationsByCredit = new Map<string, number>();
  for (const { allocation, credit, charge } of effectiveCreditAllocations(snapshot, asOf)) {
    if (charge.tenancyId === tenancyId) allocationsByCharge.set(charge.id, (allocationsByCharge.get(charge.id) ?? 0) + allocation.amountCents);
    if (credit.tenancyId === tenancyId) allocationsByCredit.set(credit.id, (allocationsByCredit.get(credit.id) ?? 0) + allocation.amountCents);
  }
  let rentOnly = 0;
  let nonRent = 0;
  let oldestUnpaidRentOn: IsoDate | undefined;
  let unappliedCashCents = 0;
  for (const transaction of transactions) {
    if (!isBalanceCategory(transaction.category)) continue;
    if (!knownAmount(transaction.amountCents)) continue;
    if (transaction.kind === "charge") {
      if (reversed.chargeIds.has(transaction.id)) continue;
      if (transaction.dueOn && transaction.dueOn > asOf) continue;
      const open = Math.max(0, transaction.amountCents - (allocationsByCharge.get(transaction.id) ?? 0));
      if (transaction.category === "base_rent") {
        rentOnly += open;
        if (open > 0 && transaction.dueOn && (!oldestUnpaidRentOn || transaction.dueOn < oldestUnpaidRentOn)) oldestUnpaidRentOn = transaction.dueOn;
      } else {
        nonRent += open;
      }
    } else if (transaction.kind === "credit") {
      if (reversed.creditIds.has(transaction.id)) continue;
      const remainingCredit = transaction.amountCents - (allocationsByCredit.get(transaction.id) ?? 0);
      if (transaction.category === "base_rent") rentOnly -= remainingCredit;
      else nonRent -= remainingCredit;
    } else if (transaction.kind === "adjustment") {
      const signed = transaction.adjustmentDirection === "credit" ? -transaction.amountCents : transaction.amountCents;
      if (transaction.category === "base_rent") rentOnly += signed;
      else nonRent += signed;
    } else if (transaction.kind === "reversal" && transaction.reversalOfId) {
      const original = transactionMap.get(transaction.reversalOfId);
      if (!original) continue;
      // Charge/credit reversals are handled by excluding the original fact.
      // Payment reversals reopen valid allocations through allocationsByCharge.
      if (original.kind === "adjustment") {
        const signed = original.adjustmentDirection === "credit" ? transaction.amountCents : -transaction.amountCents;
        if (transaction.category === "base_rent") rentOnly += signed;
        else nonRent += signed;
      }
    }
  }
  for (const transaction of transactions) {
    if (!knownAmount(transaction.amountCents)) continue;
    if (transaction.kind === "payment") {
      const allocated = allocationsByPayment.get(transaction.id) ?? 0;
      unappliedCashCents += transaction.amountCents - allocated;
    } else if (transaction.kind === "reversal" && transaction.reversalOfId) {
      const original = transactionMap.get(transaction.reversalOfId);
      if (original?.kind === "payment" && knownAmount(original.amountCents)) {
        const allocated = allocationsByPayment.get(original.id) ?? 0;
        unappliedCashCents -= original.amountCents - allocated;
      }
    }
  }
  unappliedCashCents = Math.max(0, unappliedCashCents);
  return { rentOnlyBalanceCents: rentOnly, nonRentBalanceCents: nonRent, totalBalanceCents: rentOnly + nonRent - unappliedCashCents, unappliedCashCents, prepaidCents: unappliedCashCents, oldestUnpaidRentOn };
}

function searchMatches(text: string, search?: string): boolean {
  if (!search) return true;
  return text.toLowerCase().includes(search.toLowerCase());
}

export function deriveRentRoll(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): RentRollRow[] {
  const asOf = asOfDate(filters);
  assertNoAmbiguousOccupancy(snapshot, asOf);
  assertNoOverlappingBaseRentSchedules(snapshot.recurringSchedules);
  const properties = propertyMap(snapshot);
  const people = personMap(snapshot);
  return scopedUnits(snapshot, filters).map((unit) => {
    const property = properties.get(unit.propertyId);
    const currentCandidates = currentTenanciesForUnit(snapshot, unit.id, asOf);
    const futureCandidates = futureTenanciesForUnit(snapshot, unit.id, asOf);
    const current = chooseLatestTenancy(currentCandidates);
    const future = chooseUpcomingTenancy(futureCandidates);
    const selected = current ?? future;
    const term = selected ? (current ? activeLeaseTerm(snapshot, selected.id, asOf) : upcomingLeaseTerm(snapshot, selected.id, asOf)) : undefined;
    const scheduleAsOf = current ? asOf : (term?.contractStartOn ?? (selected ? occupancyMoveInOn(selected) : undefined) ?? asOf);
    const amounts = selected ? scheduledAmounts(snapshot, selected.id, scheduleAsOf) : { baseRentCents: undefined, recurringFeesCents: 0, subsidyCents: 0 };
    const subsidyContract = selected ? snapshot.subsidyContracts.find((contract) => contract.tenancyId === selected.id && isEffectiveOn(contract.effectiveFrom, contract.effectiveTo, scheduleAsOf)) : undefined;
    const balance = current ? accountBalance(snapshot, current.id, asOf) : { rentOnlyBalanceCents: 0, nonRentBalanceCents: 0, totalBalanceCents: 0, unappliedCashCents: 0, prepaidCents: 0, oldestUnpaidRentOn: undefined };
    const unresolvedCodes = unresolvedTenancyForUnit(snapshot, unit, asOf);
    const occupancy: OccupancyState = current ? "current" : future ? "future_preleased" : unresolvedCodes.length > 0 ? "unknown" : "vacant";
    const exceptionCodes: string[] = [];
    if (currentCandidates.length > 1) exceptionCodes.push("multiple_current_tenancies");
    if (futureCandidates.length > 1) exceptionCodes.push("multiple_future_tenancies");
    if (unit.marketRentCents === undefined || unit.marketRentCents === null) exceptionCodes.push("market_rent_unknown");
    if (selected && !term) exceptionCodes.push("lease_term_missing");
    exceptionCodes.push(...unresolvedCodes);
    const tenant = current ? people.get(current.primaryPersonId) : undefined;
    const futureTenant = future ? people.get(future.primaryPersonId) : undefined;
    const searchText = `${property?.name ?? ""} ${unit.unitNumber} ${displayName(tenant)} ${displayName(futureTenant)}`;
    if (!searchMatches(searchText, filters.search)) return { ...({} as RentRollRow), propertyId: "__filtered__" };
    return {
      propertyId: unit.propertyId,
      propertyName: property?.name ?? "Unknown property",
      unitId: unit.id,
      unitNumber: unit.unitNumber,
      bedrooms: unit.bedrooms,
      bathrooms: unit.bathrooms,
      marketRentCents: unit.marketRentCents,
      readiness: unit.readiness,
      listing: unit.listing,
      occupancy,
      currentPersonId: current?.primaryPersonId,
      currentTenantName: tenant ? displayName(tenant) : undefined,
      futurePersonId: future?.primaryPersonId,
      futureTenantName: futureTenant ? displayName(futureTenant) : undefined,
      tenancyId: selected?.id,
      actualMoveInOn: selected?.actualMoveInOn,
      noticeOn: selected?.noticeOn,
      expectedMoveOutOn: selected?.expectedMoveOutOn,
      actualMoveOutOn: selected?.actualMoveOutOn,
      contractStartOn: term?.contractStartOn,
      contractEndOn: term?.contractEndOn,
      monthToMonth: term?.monthToMonth,
      baseRentCents: amounts.baseRentCents,
      recurringFeesCents: amounts.recurringFeesCents,
      subsidyCents: amounts.subsidyCents,
      tenantPortionCents: subsidyContract?.tenantObligationCents,
      totalScheduledCents: (amounts.baseRentCents ?? 0) + amounts.recurringFeesCents,
      balanceDueCents: balance.totalBalanceCents,
      oldestUnpaidRentOn: balance.oldestUnpaidRentOn,
      exceptionCodes,
    };
  }).filter((row) => row.propertyId !== "__filtered__").filter((row) => {
    if (!filters.occupancy || filters.occupancy.length === 0) return true;
    return filters.occupancy.includes(row.occupancy);
  }).filter((row) => {
    if (!filters.balanceStatus || filters.balanceStatus === "all") return true;
    if (filters.balanceStatus === "due") return row.balanceDueCents > 0;
    if (filters.balanceStatus === "credit") return row.balanceDueCents < 0;
    return row.balanceDueCents === 0;
  });
}

export function deriveOccupancy(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): OccupancyRow[] {
  const asOf = asOfDate(filters);
  assertNoAmbiguousOccupancy(snapshot, asOf);
  const properties = propertyMap(snapshot);
  return scopedUnits(snapshot, filters).map((unit) => {
    const current = chooseLatestTenancy(currentTenanciesForUnit(snapshot, unit.id, asOf));
    const future = chooseUpcomingTenancy(futureTenanciesForUnit(snapshot, unit.id, asOf));
    const selected = current ?? future;
    const lastPast = [...snapshot.tenancies]
      .filter((tenancy) => tenancy.unitId === unit.id && tenancy.actualMoveOutOn && tenancy.actualMoveOutOn <= asOf)
      .sort((left, right) => compareIsoDate(right.actualMoveOutOn, left.actualMoveOutOn))[0];
    const exceptionCodes = unresolvedTenancyForUnit(snapshot, unit, asOf);
    const occupancy: OccupancyState = current ? "current" : future ? "future_preleased" : exceptionCodes.length > 0 ? "unknown" : "vacant";
    return {
      propertyId: unit.propertyId,
      propertyName: properties.get(unit.propertyId)?.name ?? "Unknown property",
      unitId: unit.id,
      unitNumber: unit.unitNumber,
      occupancy,
      readiness: unit.readiness,
      listing: unit.listing,
      daysVacant: !selected && lastPast?.actualMoveOutOn ? daysBetween(lastPast.actualMoveOutOn, asOf) : undefined,
      tenancyId: selected?.id,
      exceptionCodes: exceptionCodes.length > 0 ? exceptionCodes : undefined,
    };
  }).filter((row) => !filters.occupancy || filters.occupancy.includes(row.occupancy));
}

/**
 * v8 report controls are kept alongside (rather than substituted for) the
 * established row DTOs.  The browser still receives the same array shape,
 * while callers that need reconciliation can read the explicit source and
 * uncertainty buckets through `financialReportControls`.
 */
export interface FinancialReportControls extends FinancialProjectionControls {
  collectedKnownCount?: number;
  collectedUncertainCount?: number;
  collectedUnknownAmountCount?: number;
  collectedKnownCents?: Cents;
  collectedUncertainCents?: Cents;
  collectedUnknownAmountCents?: Cents;
  uncertaintyCodes?: string[];
}

const reportControls = new WeakMap<object, FinancialReportControls>();

export function financialReportControls(rows: readonly unknown[]): FinancialReportControls | undefined {
  return reportControls.get(rows as object);
}

function truthMonth(filters: RentOpsFilters): IsoMonth {
  return reportMonth(filters);
}

function truthObservationMonth(snapshot: RentOpsSnapshot, filters: RentOpsFilters): IsoMonth | undefined {
  // Model-v3 artifact roots carry their own immutable observation boundary;
  // the projection uses it for the observation month and forward projections.
  // This fallback exists only for legacy synthetic snapshots that predate the
  // artifact-bound lineage contract.
  if (snapshot.modelVersion === 3) return undefined;
  const asOf = asOfDate(filters);
  const month = truthMonth(filters);
  // Legacy unknown-open rows are usable only in their current configuration
  // month because they have no per-row artifact observation evidence.
  return month === monthFromDate(asOf) ? month : undefined;
}

function isPositiveIncomeCategory(category: ScheduledIncomeRow["category"]): boolean {
  return category === null || incomeCategories.has(category);
}

function attachReportControls(rows: readonly unknown[], controls: FinancialReportControls): void {
  reportControls.set(rows as object, controls);
}

function deriveTruthScheduledIncome(snapshot: RentOpsSnapshot, filters: RentOpsFilters): ScheduledIncomeRow[] {
  const month = truthMonth(filters);
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const projection = projectFinancialSchedules(snapshot, month, {
    propertyId: filters.propertyId,
    unitId: filters.unitId,
    observationMonth: truthObservationMonth(snapshot, filters),
  });
  const rows = projection.rows
    // Subsidy/deposit schedules are controlled by their dedicated reports.
    // An unknown category remains visible as an explicitly unclassified row;
    // it is never silently reinterpreted as rent or a fee.
    .filter((row) => isPositiveIncomeCategory(row.category))
    .filter((row) => matchesPropertyScope(row.propertyId, filters, propertyIds))
    .filter((row) => !filters.tenancyId || row.tenancyId === filters.tenancyId)
    .filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber ?? ""} ${row.tenantName ?? ""}`, filters.search));
  const projectionControls = financialProjectionControls(projection);
  const controls: FinancialReportControls = {
    ...projectionControls,
    sourceRowCount: projection.sourceRowCount,
    // The projection includes subsidy/deposit source rows in conservation;
    // the positive scheduled-income view exposes their exclusion explicitly.
    uncertaintyCodes: projection.exceptionCodes,
  };
  attachReportControls(rows, controls);
  return rows;
}

interface TruthCollectedResult {
  rows: CollectedIncomeRow[];
  controls: Pick<FinancialReportControls, "collectedKnownCount" | "collectedUncertainCount" | "collectedUnknownAmountCount" | "collectedKnownCents" | "collectedUncertainCents" | "collectedUnknownAmountCents" | "uncertaintyCodes"> & { sourceRowCount: number };
}

function deriveTruthCollectedIncome(snapshot: RentOpsSnapshot, filters: RentOpsFilters): TruthCollectedResult {
  const month = truthMonth(filters);
  const cutoff = filters.asOfDate ?? ("9999-12-31" as IsoDate);
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const people = personMap(snapshot);
  const transactions = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.id, transaction]));
  const postedReversals = new Set(snapshot.ledgerTransactions
    .filter((transaction) => transaction.kind === "reversal" && transaction.status === "posted" && transaction.reversalOfId && transaction.postedOn && transaction.postedOn <= cutoff)
    .map((transaction) => transaction.reversalOfId!));
  const rows: CollectedIncomeRow[] = [];
  let knownCount = 0;
  let uncertainCount = 0;
  let unknownAmountCount = 0;
  let knownCents = 0;
  let uncertainCents = 0;
  const uncertaintyCodes = new Set<string>();
  for (const allocation of snapshot.paymentAllocations) {
    if (allocation.kind === "transfer" || allocation.kind === "credit_allocation") continue;
    // Application visibility follows its own date, while receipt-month
    // attribution remains tied to the original payment date.
    if (allocation.allocatedOn && allocation.allocatedOn > cutoff) continue;
    const payment = allocation.paymentTransactionId ? transactions.get(allocation.paymentTransactionId) : undefined;
    const charge = allocation.chargeTransactionId ? transactions.get(allocation.chargeTransactionId) : undefined;
    const propertyId = charge?.propertyId ?? payment?.propertyId;
    const paymentOn = payment?.postedOn ?? null;
    const sourceHasKnownProperty = typeof propertyId === "string" && propertyIds.has(propertyId);
    if (!sourceHasKnownProperty) {
      if (propertyId === null || propertyId === undefined) { uncertainCount += 1; uncertaintyCodes.add("collected_property_unknown"); }
      continue;
    }
    if (filters.unitId && (charge?.unitId ?? payment?.unitId) !== filters.unitId) continue;
    const category = charge?.category ?? null;
    if (allocation.kind === "reversal" && (!isSourceAllocationReversal(allocation) || !allocation.allocatedOn || allocation.allocatedOn > cutoff)) continue;
    const amountKnown = typeof allocation.amountCents === "number" && Number.isSafeInteger(allocation.amountCents) && allocation.amountKnowledge !== "unknown";
    const postedKnown = payment?.kind === "payment" && payment.status === "posted" && typeof paymentOn === "string" && paymentOn <= cutoff;
    const chargeKnown = charge?.kind === "charge" && charge.status === "posted" && typeof charge.postedOn === "string" && charge.postedOn <= cutoff;
    const linksKnown = Boolean(payment && charge && allocation.paymentLinkKnowledge !== "unknown" && allocation.paymentLinkKnowledge !== "ambiguous" && allocation.chargeLinkKnowledge !== "unknown" && allocation.chargeLinkKnowledge !== "ambiguous");
    const exactCategory = category !== null && incomeCategories.has(category);
    const monthMatches = postedKnown && monthFromDate(paymentOn!) === month;
    const reversed = Boolean((payment && postedReversals.has(payment.id)) || (charge && postedReversals.has(charge.id)));
    // A known non-income allocation is not a collected-income row, but it is
    // still a source control when its category is missing/unknown.
    if (exactCategory === false && category !== null) continue;
    if (!monthMatches && postedKnown) continue;
    if (reversed) {
      uncertaintyCodes.add("collected_reversal_excluded");
      continue;
    }
    const uncertainty: string[] = [];
    if (!allocation.allocatedOn) uncertainty.push("collected_allocation_date_unknown");
    if (!amountKnown) { unknownAmountCount += 1; uncertainty.push("collected_amount_unknown"); }
    if (!postedKnown) uncertainty.push("collected_payment_posted_unknown");
    if (!chargeKnown) uncertainty.push("collected_charge_posted_unknown");
    if (!linksKnown) uncertainty.push("collected_link_unknown");
    if (category === null) uncertainty.push("collected_category_unknown");
    if (uncertainty.length > 0) {
      uncertainCount += 1;
      uncertainty.forEach((code) => uncertaintyCodes.add(code));
      if (amountKnown) uncertainCents += allocation.amountCents!;
    } else {
      knownCount += 1;
      knownCents += allocation.amountCents!;
    }
    const unit = units.get(charge?.unitId ?? payment?.unitId ?? "");
    const person = people.get(charge?.personId ?? payment?.personId ?? "");
    rows.push({
      propertyId: propertyId as string,
      propertyName: properties.get(propertyId as string)?.name ?? "Unknown property",
      unitId: unit?.id,
      unitNumber: unit?.unitNumber,
      tenancyId: charge?.tenancyId ?? payment?.tenancyId,
      personId: charge?.personId ?? payment?.personId,
      tenantName: person ? displayName(person) : undefined,
      paymentTransactionId: payment?.id ?? null,
      chargeTransactionId: charge?.id ?? null,
      paymentOn,
      category,
      amountCents: amountKnown ? allocation.amountCents : null,
      description: charge?.description ?? null,
    });
  }
  const filteredRows = rows.filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber ?? ""} ${row.tenantName ?? ""}`, filters.search));
  return {
    rows: filteredRows,
    controls: {
      sourceRowCount: snapshot.paymentAllocations.length,
      collectedKnownCount: knownCount,
      collectedUncertainCount: uncertainCount,
      collectedUnknownAmountCount: unknownAmountCount,
      collectedKnownCents: knownCents,
      collectedUncertainCents: uncertainCents,
      collectedUnknownAmountCents: 0,
      uncertaintyCodes: Array.from(uncertaintyCodes).sort(),
    },
  };
}

export function deriveScheduledIncome(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): ScheduledIncomeRow[] {
  if (snapshot.modelVersion === 3) return deriveTruthScheduledIncome(snapshot, filters);
  const asOf = asOfDate(filters);
  assertNoAmbiguousOccupancy(snapshot, asOf);
  assertNoOverlappingBaseRentSchedules(snapshot.recurringSchedules);
  const month = reportMonth(filters);
  const start = monthStart(month);
  const currentConfiguration = month === monthFromDate(asOf);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const people = personMap(snapshot);
  const propertyIds = new Set(scopedProperties(snapshot, filters).map((property) => property.id));
  const rows: ScheduledIncomeRow[] = [];
  for (const tenancy of snapshot.tenancies) {
    if (!propertyIds.has(tenancy.propertyId) || (tenancy.status !== "current" && tenancy.status !== "future" && tenancy.status !== "notice")) continue;
    const unit = units.get(tenancy.unitId);
    const person = people.get(tenancy.primaryPersonId);
    if (!unit || !person) continue;
    if (filters.unitId && tenancy.unitId !== filters.unitId) continue;
    const schedules = effectiveSchedulesFor(snapshot, tenancy.id, start);
    for (const schedule of schedules) {
      if (schedule.scopeType === "property") continue;
      if (schedule.category !== "base_rent" && schedule.category !== "recurring_fee") continue;
      if (!knownAmount(schedule.amountCents)) continue;
      const description = schedule.description ?? "";
      const uncertaintyCodes = [
        schedule.active === undefined ? "active_state_unknown" : undefined,
        !schedule.description ? "description_unknown" : undefined,
        !schedule.effectiveFrom && !currentConfiguration ? "unknown_open_start_historical" : undefined,
        schedule.effectiveFromKnowledge === "unknown_open_start" && currentConfiguration ? "unknown_open_start_current_configuration" : undefined,
      ].filter((code): code is string => Boolean(code));
      const temporalUncertainty = uncertaintyCodes.length > 0;
      rows.push({
        propertyId: tenancy.propertyId,
        propertyName: properties.get(tenancy.propertyId)?.name ?? "Unknown property",
        unitId: unit.id,
        unitNumber: unit.unitNumber,
        tenancyId: tenancy.id,
        personId: person.id,
        tenantName: displayName(person),
        month,
        category: schedule.category,
        description,
        amountCents: schedule.amountCents,
        scheduleId: schedule.id,
        scopeType: schedule.scopeType,
        chargeDefinitionId: schedule.chargeDefinitionId,
        effectiveFromKnowledge: schedule.effectiveFromKnowledge,
        temporalUncertainty,
        exceptionCodes: uncertaintyCodes.length > 0 ? uncertaintyCodes : undefined,
      });
    }
  }
  // Property schedules are not allocated to units. Emit each applicable
  // property definition once, regardless of the number of units/tenancies.
  for (const propertyId of Array.from(propertyIds)) {
    const propertySchedules = snapshot.recurringSchedules.filter((schedule) =>
      schedule.active !== false && schedule.scopeType === "property" && schedule.propertyId === propertyId &&
      (schedule.category === "base_rent" || schedule.category === "recurring_fee") &&
      (!schedule.effectiveFrom || schedule.effectiveFrom <= start) && (!schedule.effectiveTo || schedule.effectiveTo >= start),
    );
    const groups = new Map<string, RentOpsRecurringChargeSchedule[]>();
    for (const schedule of propertySchedules) {
      const key = `${schedule.category}:${schedule.chargeDefinitionId ?? `unknown:${schedule.id}`}`;
      const existing = groups.get(key) ?? [];
      existing.push(schedule);
      groups.set(key, existing);
    }
    for (const schedules of Array.from(groups.values())) {
      const schedule = [...schedules].sort((left, right) => {
        if (left.effectiveFrom && right.effectiveFrom) {
          return right.effectiveFrom.localeCompare(left.effectiveFrom) || left.id.localeCompare(right.id);
        }
        if (left.effectiveFrom) return -1;
        if (right.effectiveFrom) return 1;
        return left.id.localeCompare(right.id);
      })[0];
      if (!knownAmount(schedule.amountCents)) continue;
      const description = schedule.description ?? "";
      const uncertaintyCodes = [
        schedule.active === undefined ? "active_state_unknown" : undefined,
        !schedule.description ? "description_unknown" : undefined,
        !schedule.effectiveFrom && !currentConfiguration ? "unknown_open_start_historical" : undefined,
        schedule.effectiveFromKnowledge === "unknown_open_start" && currentConfiguration ? "unknown_open_start_current_configuration" : undefined,
      ].filter((code): code is string => Boolean(code));
      const temporalUncertainty = uncertaintyCodes.length > 0;
      rows.push({
        propertyId,
        propertyName: properties.get(propertyId)?.name ?? "Unknown property",
        month,
        category: schedule.category as "base_rent" | "recurring_fee",
        description,
        amountCents: schedule.amountCents,
        scheduleId: schedule.id,
        scopeType: "property",
        chargeDefinitionId: schedule.chargeDefinitionId,

        effectiveFromKnowledge: schedule.effectiveFromKnowledge,
        temporalUncertainty,
        exceptionCodes: uncertaintyCodes.length > 0 ? uncertaintyCodes : undefined,
      });
    }
  }
  return rows.filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber} ${row.tenantName}`, filters.search));
}

export function deriveCollectedIncome(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): CollectedIncomeRow[] {
  if (snapshot.modelVersion === 3) {
    const collected = deriveTruthCollectedIncome(snapshot, filters);
    const rows = collected.rows;
    const controls: FinancialReportControls = {
      sourceRowCount: collected.controls.sourceRowCount,
      knownCount: collected.controls.collectedKnownCount ?? 0,
      uncertainCount: collected.controls.collectedUncertainCount ?? 0,
      unclassifiedCount: rows.filter((row) => row.category === null).length,
      unknownAmountCount: collected.controls.collectedUnknownAmountCount ?? 0,
      unassignedCount: 0,
      knownCents: collected.controls.collectedKnownCents ?? 0,
      uncertainCents: collected.controls.collectedUncertainCents ?? 0,
      unclassifiedCents: 0,
      unknownAmountCents: collected.controls.collectedUnknownAmountCents ?? 0,
      unassignedCents: 0,
      complete: (collected.controls.collectedUncertainCount ?? 0) === 0 && (collected.controls.collectedUnknownAmountCount ?? 0) === 0,
      collectedKnownCount: collected.controls.collectedKnownCount,
      collectedUncertainCount: collected.controls.collectedUncertainCount,
      collectedUnknownAmountCount: collected.controls.collectedUnknownAmountCount,
      collectedKnownCents: collected.controls.collectedKnownCents,
      collectedUncertainCents: collected.controls.collectedUncertainCents,
      collectedUnknownAmountCents: collected.controls.collectedUnknownAmountCents,
      uncertaintyCodes: collected.controls.uncertaintyCodes,
    };
    attachReportControls(rows, controls);
    return rows;
  }
  const month = reportMonth(filters);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const people = personMap(snapshot);
  // Collected income is attributed by payment date. Historical allocations
  // may be posted after month-end, so the default report includes all known
  // allocations; an explicit as-of date remains the audit cutoff.
  const reportCutoff = filters.asOfDate ?? ("9999-12-31" as IsoDate);
  const propertyIds = new Set(scopedProperties(snapshot, filters).map((property) => property.id));
  const rows: CollectedIncomeRow[] = [];
  for (const { allocation, payment, charge } of effectiveAllocations(snapshot, reportCutoff)) {
    if (!charge.propertyId || monthFromDate(payment.postedOn) !== month || !charge.category || !incomeCategories.has(charge.category) || !propertyIds.has(charge.propertyId)) continue;
    const unit = units.get(charge.unitId ?? payment.unitId ?? "");
    const person = people.get(charge.personId ?? payment.personId ?? "");
    rows.push({
      propertyId: charge.propertyId,
      propertyName: properties.get(charge.propertyId)?.name ?? "Unknown property",
      unitId: unit?.id,
      unitNumber: unit?.unitNumber,
      tenancyId: charge.tenancyId ?? payment.tenancyId,
      personId: charge.personId ?? payment.personId,
      tenantName: person ? displayName(person) : undefined,
      paymentTransactionId: payment.id,
      chargeTransactionId: charge.id,
      paymentOn: payment.postedOn,
      category: charge.category as CollectedIncomeRow["category"],
      amountCents: allocation.amountCents,
      description: charge.description,
    });
  }
  return rows.filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber ?? ""} ${row.tenantName ?? ""}`, filters.search));
}

export function deriveScheduledVsCollected(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): ScheduledVsCollectedRow[] {
  if (snapshot.modelVersion === 3) {
    const scheduledRows = deriveTruthScheduledIncome(snapshot, filters);
    const scheduledControls = financialReportControls(scheduledRows);
    const collected = deriveTruthCollectedIncome(snapshot, filters);
    const month = truthMonth(filters);
    const properties = propertyMap(snapshot);
    const grouped = new Map<string, ScheduledVsCollectedRow>();
    // A null property is a portfolio-level bucket.  JSON keeps it distinct
    // from a literal property id such as "null" and does not invent a name.
    const groupKey = (propertyId: string | null, rowMonth: IsoMonth): string => JSON.stringify([propertyId, rowMonth]);
    const uncertaintyCodes = new Set<string>([
      ...(scheduledControls?.uncertaintyCodes ?? []),
      ...(collected.controls.uncertaintyCodes ?? []),
    ]);
    const empty = (propertyId: string | null, propertyName: string | null, month: IsoMonth): ScheduledVsCollectedRow => ({
      propertyId,
      propertyName,
      month,
      scheduledCents: 0,
      collectedCents: 0,
      varianceCents: null,
      scheduledKnownCents: 0,
      scheduledUncertainCents: 0,
      scheduledUnknownAmountCount: 0,
      collectedKnownCents: 0,
      collectedUncertainCents: 0,
      collectedUnknownAmountCount: 0,
      complete: true,
      uncertaintyCodes: [],
    });
    for (const row of scheduledRows) {
      const key = groupKey(row.propertyId, row.month);
      const existing = grouped.get(key) ?? empty(row.propertyId, row.propertyName, row.month);
      if (row.known === true && typeof row.amountCents === "number") {
        existing.scheduledKnownCents = (existing.scheduledKnownCents ?? 0) + row.amountCents;
        existing.scheduledCents = existing.scheduledKnownCents;
      } else {
        if (typeof row.amountCents === "number") existing.scheduledUncertainCents = (existing.scheduledUncertainCents ?? 0) + row.amountCents;
        if (row.amountCents === null) existing.scheduledUnknownAmountCount = (existing.scheduledUnknownAmountCount ?? 0) + 1;
        existing.complete = false;
      }
      if (row.unclassified) { existing.complete = false; uncertaintyCodes.add("scheduled_category_unknown"); }
      row.exceptionCodes?.forEach((code) => uncertaintyCodes.add(code));
      grouped.set(key, existing);
    }
    for (const row of collected.rows) {
      if (!row.paymentOn) continue;
      const key = groupKey(row.propertyId, month);
      const propertyName = row.propertyId === null ? null : properties.get(row.propertyId)?.name ?? row.propertyName;
      const existing = grouped.get(key) ?? empty(row.propertyId, propertyName, month);
      if (typeof row.amountCents === "number" && row.category !== null) {
        existing.collectedKnownCents = (existing.collectedKnownCents ?? 0) + row.amountCents;
        existing.collectedCents = existing.collectedKnownCents;
      } else if (typeof row.amountCents === "number") {
        existing.collectedUncertainCents = (existing.collectedUncertainCents ?? 0) + row.amountCents;
        existing.complete = false;
      } else {
        existing.collectedUnknownAmountCount = (existing.collectedUnknownAmountCount ?? 0) + 1;
        existing.complete = false;
      }
      grouped.set(key, existing);
    }
    return Array.from(grouped.values()).map((row) => {
      const complete = Boolean(row.complete)
        && (scheduledControls?.complete ?? false)
        && (collected.controls.collectedUncertainCount ?? 0) === 0
        && (collected.controls.collectedUnknownAmountCount ?? 0) === 0;
      return {
        ...row,
        collectedKnownCents: row.collectedKnownCents ?? 0,
        collectedUncertainCents: row.collectedUncertainCents ?? 0,
        collectedUnknownAmountCount: Math.max(row.collectedUnknownAmountCount ?? 0, collected.controls.collectedUnknownAmountCount ?? 0),
        complete,
        varianceCents: complete ? (row.collectedKnownCents ?? 0) - (row.scheduledKnownCents ?? 0) : null,
        uncertaintyCodes: uncertaintyCodes.size > 0 ? Array.from(uncertaintyCodes).sort() : undefined,
      };
    });
  }
  const scheduled = deriveScheduledIncome(snapshot, filters);
  const collected = deriveCollectedIncome(snapshot, filters);
  const properties = propertyMap(snapshot);
  const grouped = new Map<string, ScheduledVsCollectedRow>();
  const groupKey = (propertyId: string | null, rowMonth: IsoMonth): string => JSON.stringify([propertyId, rowMonth]);
  for (const row of scheduled) {
    if (row.temporalUncertainty) continue;
    const key = groupKey(row.propertyId, row.month);
    const existing = grouped.get(key) ?? { propertyId: row.propertyId, propertyName: row.propertyName, month: row.month, scheduledCents: 0, collectedCents: 0, varianceCents: 0 };
    if (knownAmount(row.amountCents)) existing.scheduledCents += row.amountCents;
    grouped.set(key, existing);
  }
  const month = reportMonth(filters);
  for (const row of collected) {
    const key = groupKey(row.propertyId, month);
    const propertyName = row.propertyId === null ? null : properties.get(row.propertyId)?.name ?? row.propertyName;
    const existing = grouped.get(key) ?? { propertyId: row.propertyId, propertyName, month, scheduledCents: 0, collectedCents: 0, varianceCents: 0 };
    if (knownAmount(row.amountCents)) existing.collectedCents += row.amountCents;
    grouped.set(key, existing);
  }
  return Array.from(grouped.values()).map((row) => ({ ...row, varianceCents: row.collectedCents - row.scheduledCents }));
}

export function deriveDelinquency(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): DelinquencyRow[] {
  const asOf = asOfDate(filters);
  assertNoAmbiguousOccupancy(snapshot, asOf);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const people = personMap(snapshot);
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const reversedPaymentIds = reversalSets(snapshot, asOf).paymentIds;
  const rows: DelinquencyRow[] = [];
  for (const tenancy of snapshot.tenancies) {
    if (tenancy.status !== "current" && tenancy.status !== "notice") continue;
    if (!matchesPropertyScope(tenancy.propertyId, filters, propertyIds)) continue;
    if (filters.unitId && tenancy.unitId !== filters.unitId) continue;
    const balance = accountBalance(snapshot, tenancy.id, asOf);
    if (filters.balanceStatus === "due" && balance.rentOnlyBalanceCents <= 0 && balance.nonRentBalanceCents <= 0) continue;
    if (filters.balanceStatus === "credit" && balance.totalBalanceCents >= 0) continue;
    if (filters.balanceStatus === "zero" && balance.totalBalanceCents !== 0) continue;
    const unit = units.get(tenancy.unitId);
    const person = people.get(tenancy.primaryPersonId);
    const activity = snapshot.activityEvents.some((event) =>
      event.tenancyId === tenancy.id && (event.type === "promise_to_pay" || event.type === "hold"),
    );
    const lastPayment = [...snapshot.ledgerTransactions]
      .filter((transaction) => transaction.tenancyId === tenancy.id && transaction.kind === "payment" && transaction.status === "posted" && !!transaction.postedOn && knownAmount(transaction.amountCents) && transaction.postedOn <= asOf && !reversedPaymentIds.has(transaction.id))
      .sort((left, right) => compareOptionalTimestamp(right.postedOn, left.postedOn) || right.id.localeCompare(left.id))[0];
    rows.push({
      propertyId: tenancy.propertyId,
      propertyName: properties.get(tenancy.propertyId)?.name ?? "Unknown property",
      unitId: unit?.id,
      unitNumber: unit?.unitNumber,
      tenancyId: tenancy.id,
      personId: tenancy.primaryPersonId,
      tenantName: displayName(person),
      rentOnlyBalanceCents: balance.rentOnlyBalanceCents,
      nonRentBalanceCents: balance.nonRentBalanceCents,
      grossBalanceCents: balance.rentOnlyBalanceCents + balance.nonRentBalanceCents,
      totalBalanceCents: balance.totalBalanceCents,
      netAccountBalanceCents: balance.totalBalanceCents,
      unappliedCashCents: balance.unappliedCashCents,
      prepaidCents: balance.prepaidCents,
      oldestUnpaidRentOn: balance.oldestUnpaidRentOn,
      lastPaymentOn: lastPayment?.postedOn ?? undefined,
      hasPromiseOrHold: activity,
      noticeStatus: tenancy.status === "notice" ? "notice_given" : undefined,
    });
  }
  return rows.filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber ?? ""} ${row.tenantName}`, filters.search));
}

export function deriveTenantLedger(snapshot: RentOpsSnapshot, tenancyId: string, filters: RentOpsFilters = {}, accountTransactionIds?: ReadonlySet<string>): LedgerRow[] {
  const allocationCutoff = filters.asOfDate ?? ("9999-12-31" as IsoDate);
  const transactions = snapshot.ledgerTransactions
    .filter((transaction) => (accountTransactionIds ? accountTransactionIds.has(transaction.id) : transaction.tenancyId === tenancyId) && !!transaction.postedOn && knownAmount(transaction.amountCents) && (!filters.asOfDate || transaction.postedOn <= filters.asOfDate))
    .sort((left, right) => compareOptionalTimestamp(left.postedOn, right.postedOn) || left.id.localeCompare(right.id));
  const transactionMap = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const reversed = reversalSets(snapshot, allocationCutoff);
  const allocationByCharge = new Map<string, number>();
  const allocationByPayment = new Map<string, number>();
  for (const { allocation, payment, charge } of effectiveAllocations(snapshot, allocationCutoff, accountTransactionIds ? undefined : tenancyId)) {
    if (!transactionMap.has(charge.id)) continue;
    if (!transactionMap.has(payment.id)) {
      if (payment.allocationMode !== "multi_property") continue;
      // Read-only application event: never persist a second receipt or give
      // the scoped account any of the shared root's unapplied cash.
      transactions.push({ ...payment, id: `shared-application:${allocation.id}`,
        source: undefined, propertyId: charge.propertyId, unitId: charge.unitId,
        tenancyId: charge.tenancyId, personId: charge.personId ?? payment.personId,
        postedOn: allocation.allocatedOn, amountCents: allocation.amountCents,
        allocationMode: null, description: `Application of shared receipt ${payment.id}` });
      allocationByPayment.set(`shared-application:${allocation.id}`, allocation.amountCents);
    }
    allocationByCharge.set(charge.id, (allocationByCharge.get(charge.id) ?? 0) + allocation.amountCents);
    allocationByPayment.set(payment.id, (allocationByPayment.get(payment.id) ?? 0) + allocation.amountCents);
  }
  const allocationByCredit = new Map<string, number>();
  for (const { allocation, credit, charge } of effectiveCreditAllocations(snapshot, allocationCutoff)) {
    if (transactionMap.has(credit.id)) allocationByCredit.set(credit.id, (allocationByCredit.get(credit.id) ?? 0) + allocation.amountCents);
    if (!transactionMap.has(charge.id)) continue;
    allocationByCharge.set(charge.id, (allocationByCharge.get(charge.id) ?? 0) + allocation.amountCents);

  }
  transactions.sort((left, right) => compareOptionalTimestamp(left.postedOn, right.postedOn) || left.id.localeCompare(right.id));
  let running = 0;
  return transactions.map((transaction) => {
    const amountCents = transaction.amountCents;
    if (!knownAmount(amountCents)) return { transaction, allocatedCents: 0, openCents: 0, runningBalanceCents: running };
    const allocatedCents = transaction.kind === "charge" ? allocationByCharge.get(transaction.id) ?? 0 : transaction.kind === "payment" ? allocationByPayment.get(transaction.id) ?? 0 : transaction.kind === "credit" ? allocationByCredit.get(transaction.id) ?? 0 : 0;
    const openCents = transaction.kind === "charge"
      ? (reversed.chargeIds.has(transaction.id) ? 0 : amountCents - allocatedCents)
      : transaction.kind === "payment"
        ? (reversed.paymentIds.has(transaction.id) ? 0 : amountCents - allocatedCents)
        : transaction.kind === "credit"
          ? (reversed.creditIds.has(transaction.id) ? 0 : -(amountCents - allocatedCents))
          : transaction.kind === "reversal" ? 0 : 0;
    if (transaction.status === "posted") running += ledgerBalanceSign(transaction, transactionMap) * amountCents;
    return { transaction, allocatedCents, openCents, runningBalanceCents: running };
  });
}

/** Account entries remain account-scoped; never assign them to one of the
 * account's leases merely to make them visible in a manager report. */
export function deriveManagerAccountLedger(snapshot: RentOpsSnapshot, personId: string, tenancyIds: readonly string[], filters: RentOpsFilters = {}): LedgerRow[] {
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const selectedTenancyIds = new Set(tenancyIds);
  const candidateIds = new Set(tenantAccountLedgerRows(snapshot, { personId }).map(row => row.id));
  for (const row of snapshot.ledgerTransactions) if (row.tenancyId && selectedTenancyIds.has(row.tenancyId)) candidateIds.add(row.id);
  const scopedIds = new Set(snapshot.ledgerTransactions.filter(row => {
    if (!candidateIds.has(row.id)) return false;
    const tenancy = row.tenancyId ? snapshot.tenancies.find(candidate => candidate.id === row.tenancyId) : undefined;
    const propertyId = row.propertyId ?? tenancy?.propertyId;
    return matchesPropertyScope(propertyId, filters, propertyIds) && (!filters.unitId || (row.unitId ?? tenancy?.unitId) === filters.unitId);
  }).map(row => row.id));
  return deriveTenantLedger(snapshot, "", filters, scopedIds);
}

export function deriveLeaseExpirations(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): LeaseExpirationRow[] {
  const asOf = asOfDate(filters);
  assertNoAmbiguousOccupancy(snapshot, asOf);
  assertNoOverlappingBaseRentSchedules(snapshot.recurringSchedules);
  const cutoff = addDays(asOf, 90);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const people = personMap(snapshot);
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const rows: LeaseExpirationRow[] = [];
  for (const tenancy of snapshot.tenancies) {
    if (tenancy.status !== "current" && tenancy.status !== "notice") continue;
    if (!matchesPropertyScope(tenancy.propertyId, filters, propertyIds)) continue;
    const term = activeLeaseTerm(snapshot, tenancy.id, asOf);
    if (!term) continue;
    const unit = units.get(tenancy.unitId);
    const person = people.get(tenancy.primaryPersonId);
    const monthToMonth = term.monthToMonth || term.status === "month_to_month";
    const expiring = !!term.contractEndOn && term.contractEndOn >= asOf && term.contractEndOn <= cutoff;
    if (filters.status?.length && !filters.status.includes(monthToMonth ? "month_to_month" : expiring ? "expiring" : "not_due")) continue;
    const amounts = scheduledAmounts(snapshot, tenancy.id, asOf);
    rows.push({
      propertyId: tenancy.propertyId,
      propertyName: properties.get(tenancy.propertyId)?.name ?? "Unknown property",
      unitId: tenancy.unitId,
      unitNumber: unit?.unitNumber ?? "Unknown unit",
      tenancyId: tenancy.id,
      personId: tenancy.primaryPersonId,
      tenantName: displayName(person),
      contractEndOn: term.contractEndOn,
      monthToMonth,
      currentBaseRentCents: amounts.baseRentCents,
      noticeDeadlineOn: term.contractEndOn ? addDays(term.contractEndOn, -60) : undefined,
      actionStatus: monthToMonth ? "month_to_month" : expiring ? "expiring" : "not_due",
    });
  }
  return rows.filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber} ${row.tenantName}`, filters.search));
}

export function deriveDepositLiability(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): DepositLiabilityRow[] {
  const asOf = asOfDate(filters);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const people = personMap(snapshot);
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const grouped = new Map<string, DepositLiabilityRow>();
  for (const deposit of snapshot.securityDeposits) {
    if (!matchesPropertyScope(deposit.propertyId, filters, propertyIds)) continue;
    if (filters.unitId && deposit.unitId !== filters.unitId) continue;
    // A known future receipt is excluded at the as-of boundary. Unknown
    // receipt dates remain in held liability and are explicitly flagged.
    if (deposit.receivedOn && deposit.receivedOn > asOf) continue;
    const unit = deposit.unitId ? units.get(deposit.unitId) : undefined;
    const person = people.get(deposit.personId);
    const groupKey = deposit.tenancyId
      ? `tenancy:${deposit.tenancyId}`
      : deposit.unitId
        ? `person-unit:${deposit.personId}:${deposit.unitId}`
        : `person-property:${deposit.personId}:${deposit.propertyId}`;
    const existing = grouped.get(groupKey) ?? {
      propertyId: deposit.propertyId,
      propertyName: properties.get(deposit.propertyId)?.name ?? "Unknown property",
      unitId: deposit.unitId,
      unitNumber: unit?.unitNumber,
      tenancyId: deposit.tenancyId,
      personId: deposit.personId,
      tenantName: displayName(person),
      securityHeldCents: 0,
      refundablePetHeldCents: 0,
      otherRefundableHeldCents: 0,
      totalHeldCents: 0,
      dispositionStatus: "none" as const,
      unknownReceiptCount: 0,
      hasUnknownReceiptDate: false,
      temporalUncertainty: false,
      unknownHeldCount: 0,
      sourceBalanceCents: undefined,
    };
    const unknownReceipt = !deposit.receivedOn;
    const disposedByAsOf = (deposit.dispositionStatus === "disposed" || deposit.dispositionStatus === "returned") && !!deposit.disposedOn && deposit.disposedOn <= asOf;
    const held = deposit.amountHeldCents === null ? null : disposedByAsOf ? 0 : deposit.amountHeldCents;
    const statusAtAsOf = !disposedByAsOf && (deposit.dispositionStatus === "disposed" || deposit.dispositionStatus === "returned") ? "held" : deposit.dispositionStatus;
    if (deposit.sourceBalanceCents != null) existing.sourceBalanceCents = (existing.sourceBalanceCents ?? 0) + deposit.sourceBalanceCents;
    if (held === null) {
      existing.unknownHeldCount = (existing.unknownHeldCount ?? 0) + 1;
      existing.securityHeldCents = existing.refundablePetHeldCents = existing.otherRefundableHeldCents = existing.totalHeldCents = null;
      existing.temporalUncertainty = true;
    } else {
      if (deposit.type === "security" && existing.securityHeldCents !== null) existing.securityHeldCents += held;
      else if (deposit.type === "refundable_pet" && existing.refundablePetHeldCents !== null) existing.refundablePetHeldCents += held;
      else if (deposit.type === "other_refundable" && existing.otherRefundableHeldCents !== null) existing.otherRefundableHeldCents += held;
      else existing.temporalUncertainty = true;
      if (existing.totalHeldCents !== null) existing.totalHeldCents += held;
    }
    if (unknownReceipt) {
      existing.unknownReceiptCount += 1;
      existing.hasUnknownReceiptDate = true;
      existing.temporalUncertainty = true;
    }
    // A disposition without a known disposition date is not ordered before
    // the as-of date; retain it as held while surfacing the uncertainty.
    if ((deposit.dispositionStatus === "disposed" || deposit.dispositionStatus === "returned") && !deposit.disposedOn) existing.temporalUncertainty = true;
    if (existing.dispositionStatus === "none" || statusAtAsOf === "partially_disposed" || statusAtAsOf === "held" && existing.dispositionStatus !== "partially_disposed") existing.dispositionStatus = statusAtAsOf;
    grouped.set(groupKey, existing);
  }
  return Array.from(grouped.values()).filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber} ${row.tenantName}`, filters.search));
}

export function deriveHap(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): HapRow[] {
  const month = reportMonth(filters);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const people = personMap(snapshot);
  const propertyIds = scopedPropertyIds(snapshot, filters);
  // Match collected income: payment date selects the month, while an
  // explicit as-of date controls historical visibility of allocations.
  const reportCutoff = filters.asOfDate ?? nowIsoDate();
  const rows: HapRow[] = [];
  const effectiveContracts = snapshot.subsidyContracts.filter((contract) =>
    matchesPropertyScope(contract.propertyId, filters, propertyIds) &&
    contract.status !== "pending" &&
    !!contract.status && (!filters.status?.length || filters.status.includes(contract.status)) &&
    // An ended contract remains reportable only through its explicit end date.
    // A missing end date on an ended import is treated as an exception and is
    // not projected indefinitely.
    !(contract.status === "ended" && !contract.effectiveTo) &&
    isEffectiveOn(contract.effectiveFrom, contract.effectiveTo, monthStart(month)),
  );
  // A non-null source contract with no normalized status cannot be safely
  // classified as active/ended/pending. Do not silently turn it into zero
  // HAP; the caller must resolve the artifact-bound status crosswalk first.
  if (snapshot.subsidyContracts.some((contract) => !contract.status && matchesPropertyScope(contract.propertyId, filters, propertyIds))) {
    throw new RentOpsInvariantError("HAP report is blocked by an unknown subsidy contract status");
  }
  const contractsByTenancy = new Map<string, RentOpsSubsidyContract[]>();
  for (const contract of effectiveContracts) {
    const existing = contractsByTenancy.get(contract.tenancyId) ?? [];
    existing.push(contract);
    contractsByTenancy.set(contract.tenancyId, existing);
  }
  const duplicates = Array.from(contractsByTenancy.entries()).filter(([, contracts]) => contracts.length > 1);
  if (duplicates.length) {
    throw new RentOpsInvariantError("More than one housing-assistance contract is effective for a tenancy and month", duplicates.flatMap(([tenancyId, contracts]) => contracts.map((contract) => ({ code: "overlapping_hap_contract", entityId: contract.id, message: `Tenancy ${tenancyId} has overlapping HAP contract ${contract.id}` }))));
  }
  for (const contract of effectiveContracts) {
    if (filters.propertyId && filters.propertyId !== contract.propertyId) continue;
    if (!isEffectiveOn(contract.effectiveFrom, contract.effectiveTo, monthStart(month))) continue;
    const tenancy = snapshot.tenancies.find((candidate) => candidate.id === contract.tenancyId);
    const person = tenancy ? people.get(tenancy.primaryPersonId) : undefined;
    const unit = units.get(contract.unitId);
    const uncertaintyCodes = new Set<string>();
    let receivedAgencyCents = 0;
    let receiptCount = 0;
    let knownReceiptCount = 0;
    let unknownReceiptCount = 0;
    const childReceipts = snapshot.subsidyPayments.filter((payment) =>
      payment.subsidyContractId === contract.id &&
      (!payment.propertyId || payment.propertyId === contract.propertyId) &&
      (!payment.tenancyId || payment.tenancyId === contract.tenancyId),
    );
    if (childReceipts.length > 0) {
      // Child rows are the authoritative HAP receipt projection whenever they
      // exist. This prevents a directly linked generic ledger allocation from
      // being counted a second time.
      const seenReceiptIds = new Set<string>();
      for (const receipt of childReceipts) {
        if (seenReceiptIds.has(receipt.id)) {
          uncertaintyCodes.add("duplicate_subsidy_payment_id");
          unknownReceiptCount += 1;
          continue;
        }
        seenReceiptIds.add(receipt.id);
        if (receipt.status === "pending" || receipt.status === "voided" || receipt.status === "reversed") continue;
        receiptCount += 1;
        if (receipt.status !== "received") {
          unknownReceiptCount += 1;
          uncertaintyCodes.add("subsidy_payment_status_unknown");
          continue;
        }
        if (!knownAmount(receipt.amountCents)) {
          unknownReceiptCount += 1;
          uncertaintyCodes.add("subsidy_payment_amount_unknown");
          continue;
        }
        if (!receipt.paymentOn) {
          unknownReceiptCount += 1;
          uncertaintyCodes.add("subsidy_payment_date_unknown");
          continue;
        }
        if (receipt.paymentOn > reportCutoff) continue;
        if (monthFromDate(receipt.paymentOn) !== month) continue;
        receivedAgencyCents += receipt.amountCents;
        knownReceiptCount += 1;
      }
    } else {
      const candidateAllocations = effectiveAllocations(snapshot, reportCutoff)
        .filter(({ payment, charge }) => payment.propertyId === contract.propertyId
          && charge.propertyId === contract.propertyId
          && payment.tenancyId === contract.tenancyId
          && charge.tenancyId === contract.tenancyId
          && (charge.category === "subsidy" || charge.category === "base_rent")
          && monthFromDate(payment.postedOn) === month);
      const unknownPayerCount = candidateAllocations.filter(({ payment }) => payment.payer === "unknown" || !payment.payer).length;
      if (unknownPayerCount > 0) {
        unknownReceiptCount += unknownPayerCount;
        uncertaintyCodes.add("generic_payment_payer_unknown");
      }
      for (const { payment, allocation } of candidateAllocations) {
        if (payment.payer !== "agency") continue;
        receiptCount += 1;
        knownReceiptCount += 1;
        receivedAgencyCents += allocation.amountCents;
      }
    }
    const uncertainty = uncertaintyCodes.size > 0 || unknownReceiptCount > 0;
    rows.push({
      propertyId: contract.propertyId,
      propertyName: properties.get(contract.propertyId)?.name ?? "Unknown property",
      unitId: contract.unitId,
      unitNumber: unit?.unitNumber ?? "Unknown unit",
      tenancyId: contract.tenancyId,
      tenantName: displayName(person),
      agencyName: contract.agencyName,
      month,
      agencyObligationCents: contract.agencyObligationCents,
      tenantObligationCents: contract.tenantObligationCents,
      expectedTotalCents: contract.agencyObligationCents + contract.tenantObligationCents,
      receivedAgencyCents,
      varianceCents: receivedAgencyCents - contract.agencyObligationCents,
      exception: contract.status === "exception" || receivedAgencyCents < contract.agencyObligationCents || uncertainty,
      receiptCount,
      knownReceiptCount,
      unknownReceiptCount,
      uncertainty,
      uncertaintyCodes: uncertaintyCodes.size > 0 ? Array.from(uncertaintyCodes).sort() : undefined,
  });
  }
  return rows.filter((row) => searchMatches(`${row.propertyName} ${row.unitNumber} ${row.tenantName} ${row.agencyName}`, filters.search));
}

export function deriveApplicantPipeline(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): ApplicantPipelineRow[] {
  const asOf = asOfDate(filters);
  const properties = propertyMap(snapshot);
  const units = unitMap(snapshot);
  const propertyIds = scopedPropertyIds(snapshot, filters);
  return snapshot.applications
    .filter((application) => matchesPropertyScope(application.propertyId, filters, propertyIds, true))
    .filter((application) => !filters.status?.length || filters.status.includes(application.status))
    .map((application): ApplicantPipelineRow | undefined => {
      const property = application.propertyId ? properties.get(application.propertyId) : undefined;
      const unit = application.unitId ? units.get(application.unitId) : undefined;
      const requirements = snapshot.applicationRequirements.filter((requirement) => requirement.applicationId === application.id);
      const missingItems = requirements.filter((requirement) => requirement.status === "requested" || requirement.status === "rejected").map((requirement) => requirement.label);
      const stageDate = application.submittedOn ?? (application.updatedAt ? application.updatedAt.slice(0, 10) as IsoDate : undefined);
      if (!stageDate) return undefined;
      return {
        id: application.id,
        displayName: `${application.firstName} ${application.lastName}`.trim(),
        propertyId: application.propertyId,
        propertyName: property?.name,
        unitId: application.unitId,
        unitInterest: unit?.unitNumber,
        submittedOn: application.submittedOn,
        status: application.status,
        missingItems,
        daysInStage: daysBetween(stageDate, asOf),
        source: application.sourceType,
      };
    })
    .filter((row): row is ApplicantPipelineRow => Boolean(row))
    .filter((row) => searchMatches(`${row.displayName} ${row.propertyName ?? ""} ${row.unitInterest ?? ""}`, filters.search));
}

export function deriveDashboardSummary(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}): DashboardSummary {
  const asOf = asOfDate(filters);
  const rentRoll = deriveRentRoll(snapshot, filters);
  const occupancy = deriveOccupancy(snapshot, filters);
  const scheduled = deriveScheduledIncome(snapshot, filters);
  const collected = deriveCollectedIncome(snapshot, filters);
  const delinquency = deriveDelinquency(snapshot, filters);
  const expirations = deriveLeaseExpirations(snapshot, filters);
  const deposits = deriveDepositLiability(snapshot, filters);
  const propertyIds = new Set(scopedProperties(snapshot, filters).map((property) => property.id));
  const activeApplications = snapshot.applications.filter((application) =>
    (application.status === "submitted" || application.status === "under_review" || application.status === "approved" || application.status === "missing_information") &&
    matchesPropertyScope(application.propertyId, filters, propertyIds, true),
  );
  const activeUnits = occupancy.filter((row) => propertyIds.has(row.propertyId));
  const occupiedUnits = activeUnits.filter((row) => row.occupancy === "current").length;
  const futurePreleasedUnits = activeUnits.filter((row) => row.occupancy === "future_preleased").length;
  const genuineVacantUnits = activeUnits.filter((row) => row.occupancy === "vacant").length;
  const scheduledRentCents = scheduled.filter((row) => row.category === "base_rent" || row.category === "recurring_fee").reduce((sum, row) => sum + (knownAmount(row.amountCents) ? row.amountCents : 0), 0);
  const collectedRentCents = collected.filter((row) => row.category === "base_rent" || row.category === "recurring_fee").reduce((sum, row) => sum + (knownAmount(row.amountCents) ? row.amountCents : 0), 0);
  const expiringIn30Days = expirations.filter((row) => row.actionStatus === "expiring" && row.contractEndOn && row.contractEndOn <= addDays(asOf, 30)).length;
  const expiringIn60Days = expirations.filter((row) => row.actionStatus === "expiring" && row.contractEndOn && row.contractEndOn <= addDays(asOf, 60)).length;
  const expiringIn90Days = expirations.filter((row) => row.actionStatus === "expiring").length;
  return {
    asOfDate: asOf,
    propertyCount: propertyIds.size,
    unitCount: activeUnits.length,
    occupiedUnits,
    futurePreleasedUnits,
    genuineVacantUnits,
    readyVacantUnits: activeUnits.filter((row) => row.occupancy === "vacant" && row.readiness === "ready").length,
    notReadyUnits: activeUnits.filter((row) => row.occupancy === "vacant" && row.readiness === "not_ready").length,
    offMarketUnits: activeUnits.filter((row) => row.readiness === "off_market" || row.listing === "off_market").length,
    physicalOccupancyPercent: activeUnits.length ? occupiedUnits / activeUnits.length : 0,
    scheduledRentCents,
    collectedRentCents,
    rentOnlyDelinquencyCents: delinquency.reduce((sum, row) => sum + Math.max(0, row.rentOnlyBalanceCents), 0),
    totalDelinquencyCents: delinquency.reduce((sum, row) => sum + Math.max(0, row.totalBalanceCents), 0),
    unappliedCashCents: delinquency.reduce((sum, row) => sum + row.unappliedCashCents, 0),
    expiringIn30Days,
    expiringIn60Days,
    expiringIn90Days,
    monthToMonthCount: expirations.filter((row) => row.monthToMonth).length,
    applicationsSubmitted: activeApplications.filter((application) => application.status === "submitted" || application.status === "under_review").length,
    applicationsMissingInformation: activeApplications.filter((application) => application.status === "missing_information").length,
    securityDepositLiabilityCents: deposits.some(row => row.totalHeldCents === null) ? null : deposits.reduce((sum, row) => sum + row.totalHeldCents!, 0),
    drilldowns: {
      occupiedUnits: { report: "occupancy", filters: { ...filters, occupancy: ["current"] } },
      futurePreleasedUnits: { report: "rent-roll", filters: { ...filters, occupancy: ["future_preleased"] } },
      genuineVacantUnits: { report: "occupancy", filters: { ...filters, occupancy: ["vacant"] } },
      rentOnlyDelinquencyCents: { report: "delinquency", filters: { ...filters, balanceStatus: "due" } },
      securityDepositLiabilityCents: { report: "deposits", filters },
    },
  };
}

export function deriveTenantProfile(snapshot: RentOpsSnapshot, personId: string, filters: RentOpsFilters = {}): TenantProfile | undefined {
  const person = snapshot.people.find((candidate) => candidate.id === personId);
  if (!person) return undefined;
  const asOf = asOfDate(filters);
  const profileMemberships = snapshot.householdMemberships.filter((membership) => membership.personId === personId || membership.accountPersonId === personId);
  const membershipTenancyIds = new Set(profileMemberships.filter((membership) => membership.tenancyId).map((membership) => membership.tenancyId!));
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const tenancies = [...snapshot.tenancies]
    .filter((candidate) => (candidate.primaryPersonId === personId || membershipTenancyIds.has(candidate.id)) && matchesPropertyScope(candidate.propertyId, filters, propertyIds))
    .sort((left, right) => compareOptionalTimestamp(right.createdAt, left.createdAt) || right.id.localeCompare(left.id));
  const effective = tenancies.filter((candidate) => candidate.status !== "cancelled" && occupancyMoveInOn(candidate) && occupancyMoveInOn(candidate)! <= asOf && (!candidate.actualMoveOutOn || candidate.actualMoveOutOn > asOf));
  const future = tenancies.filter((candidate) => candidate.status === "future" && occupancyMoveInOn(candidate) && occupancyMoveInOn(candidate)! > asOf);
  const tenancy = chooseLatestTenancy(effective) ?? chooseUpcomingTenancy(future) ?? tenancies[0];
  const tenancyIds = new Set(tenancies.map((candidate) => candidate.id));
  const asOfEnd = `${asOf}T23:59:59.999Z`;
  return {
    person,
    household: snapshot.householdMemberships.filter((membership) => membership.personId === personId || membership.accountPersonId === personId || (membership.tenancyId && tenancyIds.has(membership.tenancyId))),
    tenancy,
    tenancies,
    leaseTerms: snapshot.leaseTerms.filter((term) => tenancyIds.has(term.tenancyId)),
    schedules: snapshot.recurringSchedules.filter((schedule) =>
      tenancyIds.has(schedule.tenancyId ?? "") ||
      schedule.personId === personId ||
      schedule.scopeType === "property" && !!tenancy && schedule.propertyId === tenancy.propertyId ||
      schedule.scopeType === "unit" && !!tenancy && schedule.unitId === tenancy.unitId,
    ),
    ledger: deriveManagerAccountLedger(snapshot, personId, tenancies.map(candidate => candidate.id), filters),
    deposits: snapshot.securityDeposits
      .filter((deposit) => (deposit.personId === personId || tenancyIds.has(deposit.tenancyId ?? "")) && (!deposit.receivedOn || deposit.receivedOn <= asOf))
      .map((deposit) => deposit.disposedOn && deposit.disposedOn > asOf && (deposit.dispositionStatus === "disposed" || deposit.dispositionStatus === "returned") ? { ...deposit, dispositionStatus: "held" as const, disposedOn: undefined, dispositionNotes: undefined } : deposit),
    subsidyContracts: snapshot.subsidyContracts.filter((contract) => tenancyIds.has(contract.tenancyId) && !!contract.effectiveFrom && contract.effectiveFrom <= asOf),
    documents: snapshot.documents.filter((document) => (document.personId === personId || (document.tenancyId && tenancyIds.has(document.tenancyId))) && !!document.uploadedAt && document.uploadedAt <= asOfEnd),
    activity: snapshot.activityEvents.filter((event) => (event.personId === personId || (event.tenancyId && tenancyIds.has(event.tenancyId))) && !!event.occurredAt && event.occurredAt <= asOfEnd).sort((left, right) => compareOptionalTimestamp(right.occurredAt, left.occurredAt) || right.id.localeCompare(left.id)),
  };
}

export function toApplicantPublicView(snapshot: RentOpsSnapshot, application: RentOpsSnapshot["applications"][number]): ApplicantPublicView {
  return {
    id: application.id,
    status: application.status,
    email: application.email,
    firstName: application.firstName,
    lastName: application.lastName,
    phone: application.phone,
    propertyId: application.propertyId,
    unitId: application.unitId,
    submittedOn: application.submittedOn,
    certificationAcceptedOn: application.certificationAcceptedOn,
    rentalHistory: application.rentalHistory,
    employment: application.employment,
    householdSummary: application.householdSummary,
    preferences: application.preferences,
    voucher: application.voucher,
    pets: application.pets,
    vehicles: application.vehicles,
    emergencyContact: application.emergencyContact,
    householdMembers: snapshot.applicationHouseholdMembers.filter((member) => member.applicationId === application.id),
    requirements: snapshot.applicationRequirements.filter((requirement) => requirement.applicationId === application.id),
    documents: snapshot.documents.filter((document) => document.applicationId === application.id).map(({ id, type, state, fileName, mimeType, sizeBytes, uploadedAt }) => ({ id, type, state, fileName, mimeType, sizeBytes, uploadedAt })),
  };
}

export function deriveFixedReport(snapshot: RentOpsSnapshot, report: FixedReportName, filters: RentOpsFilters = {}): unknown[] {
  switch (report) {
    case "rent-roll": return deriveRentRoll(snapshot, filters);
    case "occupancy": return deriveOccupancy(snapshot, filters);
    case "scheduled-income": return deriveScheduledIncome(snapshot, filters);
    case "collected-income": return deriveCollectedIncome(snapshot, filters);
    case "scheduled-vs-collected": return deriveScheduledVsCollected(snapshot, filters);
    case "delinquency": return deriveDelinquency(snapshot, filters);
    case "tenant-ledger": {
      const propertyIds = scopedPropertyIds(snapshot, filters);
      const tenancies = snapshot.tenancies.filter((tenancy) =>
        (!filters.tenancyId || tenancy.id === filters.tenancyId) &&
        matchesPropertyScope(tenancy.propertyId, filters, propertyIds),
      );
      const accounts = new Map<string, string[]>();
      for (const tenancy of tenancies) {
        if (filters.personId && tenancy.primaryPersonId !== filters.personId) continue;
        accounts.set(tenancy.primaryPersonId, [...(accounts.get(tenancy.primaryPersonId) ?? []), tenancy.id]);
      }
      // Source account rows can exist without any canonical lease record.
      if (!filters.tenancyId) for (const person of snapshot.people) {
        if ((!filters.personId || person.id === filters.personId) && !accounts.has(person.id)) accounts.set(person.id, []);
      }
      const rows = new Map<string, LedgerRow>();
      for (const [personId, tenancyIds] of Array.from(accounts.entries())) for (const row of deriveManagerAccountLedger(snapshot, personId, tenancyIds, filters)) {
        if (!rows.has(row.transaction.id)) rows.set(row.transaction.id, row);
      }
      return Array.from(rows.values());
    }
    case "lease-expirations": return deriveLeaseExpirations(snapshot, filters);
    case "lease-expiration": return deriveLeaseExpirations(snapshot, filters);
    case "deposits": return deriveDepositLiability(snapshot, filters);
    case "security-deposit": return deriveDepositLiability(snapshot, filters);
    case "applicant-pipeline": return deriveApplicantPipeline(snapshot, filters);
    case "hap": return deriveHap(snapshot, filters);
    default: return [];
  }
}
