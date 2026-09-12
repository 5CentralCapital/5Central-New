import { hasOperationalEndOn } from "./tenancy-occupancy";
import type {
  Cents,
  IsoDate,
  IsoMonth,
  RentOpsLedgerTransaction,
  RentOpsPaymentAllocation,
  RentOpsDocument,
  RentOpsRecurringChargeSchedule,
  RentOpsSnapshot,
  ApplicationStatus,
} from "../../../shared/rent-ops-contracts";
import { isoDateSchema, POSTGRES_INTEGER_MAX, POSTGRES_INTEGER_MIN } from "../../../shared/rent-ops-contracts";
import { addDays, rangesOverlap, nowIsoDate } from "./dates";
import { resolveEffectiveScheduleVersions } from "./financial-projection";

export interface InvariantViolation {
  code: string;
  message: string;
  entityId?: string;
}

export class RentOpsInvariantError extends Error {
  readonly violations: InvariantViolation[];

  constructor(message: string, violations: InvariantViolation[] = []) {
    super(message);
    this.name = "RentOpsInvariantError";
    this.violations = violations;
  }
}

import { APPLICATION_STATUS_TRANSITIONS } from "../../../shared/application-status-transitions";
export { APPLICATION_STATUS_TRANSITIONS } from "../../../shared/application-status-transitions";

export function assertApplicationStatusTransition(current: ApplicationStatus, next: ApplicationStatus): void {
  if (current === next) return;
  if (!APPLICATION_STATUS_TRANSITIONS[current].includes(next)) {
    throw new RentOpsInvariantError(`Application status cannot change from ${current} to ${next}`);
  }
}

/** Storage references are opaque relative keys, never URLs or filesystem paths. */
export function assertPrivateStorageKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new RentOpsInvariantError("Document storage key must be a non-empty private relative key");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RentOpsInvariantError("Document storage key must be a private relative key, not a URL or filesystem path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new RentOpsInvariantError("Document storage key contains an unsafe path segment");
  }
}

export function documentReferenceViolations(snapshot: RentOpsSnapshot, document: RentOpsDocument): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const parentCount = [document.propertyId, document.unitId, document.personId, document.tenancyId, document.applicationId].filter(Boolean).length;
  if (parentCount === 0 && !document.availability) violations.push({ code: "document_parent_missing", entityId: document.id, message: `Document ${document.id} must reference a property, unit, resident, tenancy, or application` });
  const property = document.propertyId ? snapshot.properties.find((candidate) => candidate.id === document.propertyId) : undefined;
  const unit = document.unitId ? snapshot.units.find((candidate) => candidate.id === document.unitId) : undefined;
  const person = document.personId ? snapshot.people.find((candidate) => candidate.id === document.personId) : undefined;
  const tenancy = document.tenancyId ? snapshot.tenancies.find((candidate) => candidate.id === document.tenancyId) : undefined;
  const application = document.applicationId ? snapshot.applications.find((candidate) => candidate.id === document.applicationId) : undefined;
  if (document.propertyId && !property) violations.push({ code: "document_property_missing", entityId: document.id, message: `Document ${document.id} references a missing property` });
  if (document.unitId && !unit) violations.push({ code: "document_unit_missing", entityId: document.id, message: `Document ${document.id} references a missing unit` });
  if (document.personId && !person) violations.push({ code: "document_person_missing", entityId: document.id, message: `Document ${document.id} references a missing resident` });
  if (document.tenancyId && !tenancy) violations.push({ code: "document_tenancy_missing", entityId: document.id, message: `Document ${document.id} references a missing tenancy` });
  if (document.applicationId && !application) violations.push({ code: "document_application_missing", entityId: document.id, message: `Document ${document.id} references a missing application` });
  if (property && unit && unit.propertyId !== property.id) violations.push({ code: "document_property_unit_mismatch", entityId: document.id, message: `Document ${document.id} property and unit do not match` });
  if (tenancy && property && tenancy.propertyId !== property.id) violations.push({ code: "document_property_tenancy_mismatch", entityId: document.id, message: `Document ${document.id} property and tenancy do not match` });
  if (tenancy && unit && tenancy.unitId !== unit.id) violations.push({ code: "document_unit_tenancy_mismatch", entityId: document.id, message: `Document ${document.id} unit and tenancy do not match` });
  if (tenancy && person && tenancy.primaryPersonId !== person.id && !snapshot.householdMemberships.some((membership) => membership.tenancyId === tenancy.id && membership.personId === person.id)) {
    violations.push({ code: "document_person_tenancy_mismatch", entityId: document.id, message: `Document ${document.id} resident is not linked to the tenancy` });
  }
  if (application && property && application.propertyId && application.propertyId !== property.id) violations.push({ code: "document_property_application_mismatch", entityId: document.id, message: `Document ${document.id} property and application do not match` });
  if (application && unit && application.unitId && application.unitId !== unit.id) violations.push({ code: "document_unit_application_mismatch", entityId: document.id, message: `Document ${document.id} unit and application do not match` });
  return violations;
}

export function assertCents(value: unknown, label = "amountCents"): asserts value is Cents {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < POSTGRES_INTEGER_MIN || value > POSTGRES_INTEGER_MAX) {
    throw new RentOpsInvariantError(`${label} must be a safe PostgreSQL integer number of cents`);
  }
}

export function assertPositiveCents(value: unknown, label = "amountCents"): asserts value is Cents {
  assertCents(value, label);
  if (value <= 0) throw new RentOpsInvariantError(`${label} must be greater than zero`);
}

function knownScheduleFact(value: string | null | undefined): boolean {
  return value === "source" || value === "manual";
}

function knownScheduleLink(value: string | null | undefined): boolean {
  return value === "exact" || value === "manual";
}

interface KnownScheduleScope {
  type: "tenant" | "unit" | "property";
  id: string;
}

function knownScheduleScope(schedule: RentOpsRecurringChargeSchedule): KnownScheduleScope | undefined {
  if (schedule.scopeType === null || schedule.scopeType === undefined || schedule.scopeId === null || schedule.scopeId === undefined) return undefined;
  if (!knownScheduleFact(schedule.scopeTypeKnowledge) || !knownScheduleLink(schedule.scopeLinkKnowledge)) return undefined;
  return { type: schedule.scopeType, id: schedule.scopeId };
}

export interface EffectiveScheduleInterval {
  schedule: RentOpsRecurringChargeSchedule;
  effectiveFrom: IsoDate | null | undefined;
  effectiveTo: IsoDate | null | undefined;
}

function scheduleLineageKey(schedule: RentOpsRecurringChargeSchedule): string {
  return schedule.lineageRootId ? `lineage:${schedule.lineageRootId}` : `legacy:${schedule.id}`;
}

/**
 * Return the full-date obligation interval for each row.  Immutable schedule
 * versions retain the predecessor's original end date, so comparing their
 * stored ranges directly makes every valid replacement look like an overlap.
 * The projection resolver is used only as a structural lineage gate here;
 * interval selection remains date based and is never reduced to one month.
 *
 * An invalid or forked lineage deliberately falls back to each row's stored
 * range.  That is conservative: bad lineage metadata can report a conflict,
 * but cannot hide one by suppressing a predecessor.
 */
export function effectiveScheduleIntervals(schedules: RentOpsRecurringChargeSchedule[]): Map<RentOpsRecurringChargeSchedule, EffectiveScheduleInterval> {
  if (schedules.length === 0) return new Map();

  // The month is intentionally only a validation anchor. The resolver's
  // invalid-lineage result is independent of its selected month; the complete
  // interval calculation below handles every effective date in the rows.
  const lineageValidation = resolveEffectiveScheduleVersions(schedules, "9999-12" as IsoMonth, { strictLineage: true });
  const invalidIds = new Set(lineageValidation.invalidSchedules.map((schedule) => schedule.id));
  const rowsByLineage = new Map<string, RentOpsRecurringChargeSchedule[]>();
  const rowsById = new Map<string, RentOpsRecurringChargeSchedule[]>();
  for (const schedule of schedules) {
    const lineageKey = scheduleLineageKey(schedule);
    const lineageRows = rowsByLineage.get(lineageKey) ?? [];
    lineageRows.push(schedule);
    rowsByLineage.set(lineageKey, lineageRows);
    const idRows = rowsById.get(schedule.id) ?? [];
    idRows.push(schedule);
    rowsById.set(schedule.id, idRows);
  }

  const successorsByPredecessor = new Map<string, RentOpsRecurringChargeSchedule[]>();
  for (const schedule of schedules) {
    if (!schedule.supersedesId) continue;
    const successors = successorsByPredecessor.get(schedule.supersedesId) ?? [];
    successors.push(schedule);
    successorsByPredecessor.set(schedule.supersedesId, successors);
  }

  // Keep an explicit unsafe set for malformed edges even if a future change
  // to the projection resolver classifies a malformed row differently.
  const unsafeLineages = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule.supersedesId) continue;
    const predecessorRows = rowsById.get(schedule.supersedesId) ?? [];
    if (predecessorRows.length !== 1) {
      unsafeLineages.add(scheduleLineageKey(schedule));
      for (const predecessor of predecessorRows) unsafeLineages.add(scheduleLineageKey(predecessor));
      continue;
    }
    const predecessor = predecessorRows[0];
    if (scheduleLineageKey(predecessor) !== scheduleLineageKey(schedule)) {
      unsafeLineages.add(scheduleLineageKey(predecessor));
      unsafeLineages.add(scheduleLineageKey(schedule));
    }
  }
  for (const [predecessorId, successors] of Array.from(successorsByPredecessor.entries())) {
    if (successors.length <= 1) continue;
    for (const successor of successors) unsafeLineages.add(scheduleLineageKey(successor));
    for (const predecessor of rowsById.get(predecessorId) ?? []) unsafeLineages.add(scheduleLineageKey(predecessor));
  }

  const intervals = new Map<RentOpsRecurringChargeSchedule, EffectiveScheduleInterval>();
  for (const schedule of schedules) {
    const lineageKey = scheduleLineageKey(schedule);
    const lineageRows = rowsByLineage.get(lineageKey) ?? [schedule];
    const lineageInvalid = unsafeLineages.has(lineageKey) || lineageRows.some((row) => invalidIds.has(row.id));
    let effectiveTo = schedule.effectiveTo;
    if (!lineageInvalid) {
      const successors = successorsByPredecessor.get(schedule.id) ?? [];
      const successor = successors.length === 1 && scheduleLineageKey(successors[0]) === lineageKey ? successors[0] : undefined;
      if (successor?.effectiveFrom) {
        const predecessorBoundary = addDays(successor.effectiveFrom, -1);
        if (effectiveTo === null || effectiveTo === undefined || predecessorBoundary < effectiveTo) effectiveTo = predecessorBoundary;
      }
    }
    intervals.set(schedule, { schedule, effectiveFrom: schedule.effectiveFrom, effectiveTo });
  }
  return intervals;
}

export function baseRentScheduleViolations(schedules: RentOpsRecurringChargeSchedule[]): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const intervals = effectiveScheduleIntervals(schedules);
  const grouped = new Map<string, RentOpsRecurringChargeSchedule[]>();
  for (const schedule of schedules) {
    if (schedule.active !== true || !knownScheduleFact(schedule.activeKnowledge) || schedule.category !== "base_rent" || !knownScheduleFact(schedule.categoryKnowledge)) continue;
    const scope = knownScheduleScope(schedule);
    if (!scope) continue;
    // An unknown definition is not evidence that two source rows share one
    // obligation. Keep it isolated by immutable schedule identity.
    const definition = schedule.chargeDefinitionId !== null
      && schedule.chargeDefinitionId !== undefined
      && knownScheduleLink(schedule.chargeDefinitionLinkKnowledge)
      ? schedule.chargeDefinitionId
      : `unknown:${schedule.id}`;
    const scopeKey = `${scope.type}:${scope.id}:${definition}`;
    const existing = grouped.get(scopeKey) ?? [];
    existing.push(schedule);
    grouped.set(scopeKey, existing);
  }

  for (const [scopeKey, tenancySchedules] of Array.from(grouped.entries())) {
    const ordered = [...tenancySchedules].sort((left, right) => {
      const leftInterval = intervals.get(left)!;
      const rightInterval = intervals.get(right)!;
      return compareOptionalDate(leftInterval.effectiveFrom, rightInterval.effectiveFrom) || left.id.localeCompare(right.id);
    });
    for (let index = 0; index < ordered.length; index += 1) {
      for (let next = index + 1; next < ordered.length; next += 1) {
        const left = intervals.get(ordered[index])!;
        const right = intervals.get(ordered[next])!;
        if (!optionalRangesOverlap(left.effectiveFrom, left.effectiveTo, right.effectiveFrom, right.effectiveTo)) continue;
        violations.push({
          code: "overlapping_base_rent_schedule",
          entityId: ordered[next].id,
          message: `Scope ${scopeKey} has overlapping base-rent schedules ${ordered[index].id} and ${ordered[next].id}`,
        });
      }
    }
  }
  return violations;
}

export function assertNoOverlappingBaseRentSchedules(schedules: RentOpsRecurringChargeSchedule[]): void {
  const violations = baseRentScheduleViolations(schedules);
  if (violations.length > 0) {
    throw new RentOpsInvariantError("Overlapping base-rent schedules must be corrected before reporting scheduled income", violations);
  }
}

export function effectiveSchedules(
  schedules: RentOpsRecurringChargeSchedule[],
  tenancyId: string,
  asOf: string,
  scope: { personId?: string; unitId?: string; propertyId?: string; allowPersonScopedTenant?: boolean } = {},
): RentOpsRecurringChargeSchedule[] {
  return createEffectiveScheduleSelector(schedules)(tenancyId, asOf, scope);
}

export type EffectiveScheduleSelector = (
  tenancyId: string,
  asOf: string,
  scope?: { personId?: string; unitId?: string; propertyId?: string; allowPersonScopedTenant?: boolean },
) => RentOpsRecurringChargeSchedule[];

/** Reuse only within a synchronous derivation over this unchanged complete array. */
export function createEffectiveScheduleSelector(schedules: RentOpsRecurringChargeSchedule[]): EffectiveScheduleSelector {
  const intervals = effectiveScheduleIntervals(schedules);
  return (tenancyId, asOf, scope = {}) => selectEffectiveSchedules(schedules, intervals, tenancyId, asOf, scope);
}

function selectEffectiveSchedules(
  schedules: RentOpsRecurringChargeSchedule[],
  intervals: ReadonlyMap<RentOpsRecurringChargeSchedule, EffectiveScheduleInterval>,
  tenancyId: string,
  asOf: string,
  scope: { personId?: string; unitId?: string; propertyId?: string; allowPersonScopedTenant?: boolean },
): RentOpsRecurringChargeSchedule[] {
  const candidateRows = schedules.filter((schedule) => {
    // Explicit inactive is excluded.  An omitted active flag is retained as
    // an uncertain schedule and must not disappear from reconciliation.
    if (schedule.active === false) return false;
    const interval = intervals.get(schedule);
    if (interval?.effectiveFrom && interval.effectiveFrom > asOf) return false;
    if (interval?.effectiveTo && interval.effectiveTo < asOf) return false;
    const canonicalScope = knownScheduleScope(schedule);
    if (canonicalScope?.type === "tenant") {
      // A tenancy-scoped row is never widened to the resident's other
      // tenancy.  Person-only rows are accepted only when the caller has
      // proved that the resident/property/unit context is unambiguous.
      if (schedule.tenancyId) return schedule.tenancyId === tenancyId &&
        (!scope.propertyId || !schedule.propertyId || schedule.propertyId === scope.propertyId) &&
        (!scope.unitId || !schedule.unitId || schedule.unitId === scope.unitId) &&
        (!scope.personId || !schedule.personId || schedule.personId === scope.personId);
      return Boolean(
        scope.allowPersonScopedTenant && scope.personId &&
        canonicalScope.id === scope.personId &&
        (!schedule.propertyId || schedule.propertyId === scope.propertyId) &&
        (!schedule.unitId || schedule.unitId === scope.unitId),
      );
    }
    if (canonicalScope?.type === "unit") return Boolean(scope.unitId && canonicalScope.id === scope.unitId);
    if (canonicalScope?.type === "property") return Boolean(scope.propertyId && canonicalScope.id === scope.propertyId);
    if (canonicalScope) return false;
    // Explicit v8 scope evidence that is null/unknown/ambiguous cannot be
    // silently upgraded from copied convenience fields.
    if (schedule.scopeTypeKnowledge !== undefined || schedule.scopeLinkKnowledge !== undefined || schedule.scopeType !== undefined || schedule.scopeId !== undefined) return false;
    // Legacy v1 rows were tenancy-scoped even before scopeType was added.
    return schedule.tenancyId === tenancyId;
  });
  const grouped = new Map<string, RentOpsRecurringChargeSchedule[]>();
  for (const schedule of candidateRows) {
    const categoryKnown = schedule.category !== null && knownScheduleFact(schedule.categoryKnowledge);
    const definitionKnown = schedule.chargeDefinitionId !== null
      && schedule.chargeDefinitionId !== undefined
      && knownScheduleLink(schedule.chargeDefinitionLinkKnowledge);
    const key = categoryKnown && definitionKnown
      ? `${schedule.category}:${schedule.chargeDefinitionId}`
      : `unknown:${schedule.id}`;
    const existing = grouped.get(key) ?? [];
    existing.push(schedule);
    grouped.set(key, existing);
  }
  const selected: RentOpsRecurringChargeSchedule[] = [];
  for (const candidates of Array.from(grouped.values())) {
    const rank = (schedule: RentOpsRecurringChargeSchedule): number => {
      const canonicalScope = knownScheduleScope(schedule);
      if (canonicalScope?.type === "tenant") return schedule.tenancyId === tenancyId ? 4 : 3;
      if (canonicalScope?.type === "unit") return 2;
      if (canonicalScope?.type === "property") return 1;
      return schedule.tenancyId === tenancyId ? 4 : 0;
    };
    const highest = Math.max(...candidates.map(rank));
    // One active definition resolves to one schedule at a time. An exact
    // tenancy binding overrides a person-only fallback, then unit/property, instead of
    // summing with it; equal-rank overlaps are deterministic and remain
    // visible to the base-rent overlap invariant for correction.
    const highestRows = candidates.filter((schedule) => rank(schedule) === highest).sort((left, right) => compareOptionalDate(right.effectiveFrom, left.effectiveFrom) || left.id.localeCompare(right.id));
    if (highestRows[0]) selected.push(highestRows[0]);
  }
  return selected;
}

function compareOptionalDate(left: string | null | undefined, right: string | null | undefined): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left.localeCompare(right);
}

function optionalRangesOverlap(leftStart: string | null | undefined, leftEnd: string | null | undefined, rightStart: string | null | undefined, rightEnd: string | null | undefined): boolean {
  // A null start is explicitly unknown, not an infinite-past default. The
  // invariant cannot prove an overlap from it.
  if (leftStart === null || rightStart === null) return false;
  if (leftEnd !== null && leftEnd !== undefined && rightStart !== undefined && rightStart > leftEnd) return false;
  if (rightEnd !== null && rightEnd !== undefined && leftStart !== undefined && leftStart > rightEnd) return false;
  return true;
}

/** Only a complete artifact-bound RM reverse allocation may carry a negative amount. */
export function isSourceAllocationReversal(allocation: RentOpsPaymentAllocation): boolean {
  return allocation.kind === "reversal" && typeof allocation.amountCents === "number" && Number.isSafeInteger(allocation.amountCents) && allocation.amountCents < 0
    && allocation.source?.system === "rent_manager" && !!allocation.source.sourceId
    && /^[a-f0-9]{64}$/.test(allocation.sourceArtifactSha256 ?? "") && isoDateSchema.safeParse(allocation.artifactObservationOn).success
    && !!allocation.paymentTransactionId && allocation.paymentLinkKnowledge === "exact"
    && !!allocation.chargeTransactionId && allocation.chargeLinkKnowledge === "exact"
    && allocation.amountKnowledge === "known" && allocation.allocatedOnKnowledge === "source" && isoDateSchema.safeParse(allocation.allocatedOn).success;
}

export function isSourceAllocationTransfer(allocation: RentOpsPaymentAllocation): boolean {
  return allocation.kind === "transfer" && typeof allocation.amountCents === "number" && allocation.amountCents > 0
    && isSourceAllocationReversal({...allocation, kind:"reversal", amountCents:-allocation.amountCents});
}

export function postedReversalTargets(transactions: RentOpsLedgerTransaction[]): Set<string> {
  return new Set(transactions.filter(row => row.kind === "reversal" && row.status === "posted" && row.reversalOfId).map(row => row.reversalOfId!));
}

/** Source cancellation can precede a future application which already existed in RM.
 * This proves recorded history only; neither effective date is rewritten. */
function recordedFutureAllocationAmount(row: RentOpsPaymentAllocation, history: RentOpsPaymentAllocation[], transactions: RentOpsLedgerTransaction[]): number {
  if (!isSourceAllocationReversal(row) || !transactions.some(t=>t.kind==='reversal' && t.status==='posted' && t.reversalOfId===row.paymentTransactionId && t.postedOn===row.allocatedOn)) return 0;
  return history.filter(a=>a.kind!=="reversal" && a.kind!=="transfer" && a.kind!=="credit_allocation" && a.source?.system==='rent_manager' && a.sourceArtifactSha256===row.sourceArtifactSha256
    && a.paymentTransactionId===row.paymentTransactionId && a.chargeTransactionId===row.chargeTransactionId && a.paymentLinkKnowledge==='exact' && a.chargeLinkKnowledge==='exact'
    && a.amountKnowledge==='known' && typeof a.amountCents==='number' && a.amountCents>0 && !!a.allocatedOn && a.allocatedOn>row.allocatedOn!
    && !!a.source.sourceUpdatedAt && Number.isFinite(Date.parse(a.source.sourceUpdatedAt)) && isoDateSchema.safeParse(a.source.sourceUpdatedAt.slice(0,10)).success && a.source.sourceUpdatedAt.slice(0,10)<row.allocatedOn!)
    .reduce((sum,a)=>sum+a.amountCents!,0);
}

export function validateAllocation(
  allocation: RentOpsPaymentAllocation,
  payment: RentOpsLedgerTransaction | undefined,
  charge: RentOpsLedgerTransaction | undefined,
  transactions: RentOpsLedgerTransaction[] = [],
  historical = false,
  allocationHistory: RentOpsPaymentAllocation[] = [],
): InvariantViolation[] {
  return validateAllocationWithReversals(allocation, payment, charge, transactions, historical, allocationHistory);
}

type AllocationReversalIndex = ReadonlyMap<string | null | undefined, readonly RentOpsLedgerTransaction[]>;

function validateAllocationWithReversals(
  allocation: RentOpsPaymentAllocation,
  payment: RentOpsLedgerTransaction | undefined,
  charge: RentOpsLedgerTransaction | undefined,
  transactions: RentOpsLedgerTransaction[],
  historical: boolean,
  allocationHistory: RentOpsPaymentAllocation[],
  reversalIndex?: AllocationReversalIndex,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  if (allocation.kind === "credit_allocation") {
    const credit = transactions.find(row => row.id === allocation.creditTransactionId);
    const bound = historical && allocation.source?.system === "rent_manager" && /^[a-f0-9]{64}$/.test(allocation.sourceArtifactSha256 ?? "") && !!allocation.artifactObservationOn
      && allocation.paymentTransactionId === null && allocation.creditLinkKnowledge === "exact" && allocation.chargeLinkKnowledge === "exact" && allocation.amountKnowledge === "known" && allocation.allocatedOnKnowledge === "source";
    if (!bound) violations.push({code:"credit_allocation_source_invalid",entityId:allocation.id,message:"Credit application requires exact artifact-bound source evidence"});
    if (!credit || credit.kind !== "credit") violations.push({code:"credit_allocation_credit_invalid",entityId:allocation.id,message:"Credit application requires its original credit ledger entry"});
    else {
      const creditView = {...credit, kind:"payment" as const};
      const sourceAssociation = bound && credit.source?.system==='rent_manager' && charge?.source?.system==='rent_manager'
        && credit.sourceArtifactSha256===allocation.sourceArtifactSha256 && charge.sourceArtifactSha256===allocation.sourceArtifactSha256
        && !!credit.personId && credit.personId===charge.personId && credit.personLinkKnowledge==='exact' && charge.personLinkKnowledge==='exact'
        && !!allocation.sourcePropertyId && [credit.propertyId,charge.propertyId].includes(allocation.sourcePropertyId);
      const parentChecks = validateAllocationWithReversals({...allocation,kind:"allocation",creditTransactionId:null,paymentTransactionId:credit.id,paymentLinkKnowledge:allocation.creditLinkKnowledge},creditView,charge,transactions,historical,[],reversalIndex);
      const updated = charge?.source?.sourceUpdatedAt;
      const recordedFutureCharge = sourceAssociation && typeof updated==='string' && Number.isFinite(Date.parse(updated)) && isoDateSchema.safeParse(updated.slice(0,10)).success && !!allocation.allocatedOn && updated.slice(0,10)<=allocation.allocatedOn;
      violations.push(...parentChecks.filter(v=>!(sourceAssociation && v.code==='allocation_property_mismatch') && !(recordedFutureCharge && v.code==='allocation_predates_charge')));
      if (allocation.sourcePropertyId && charge && ![credit.propertyId,charge.propertyId].includes(allocation.sourcePropertyId)) violations.push({code:'credit_allocation_property_unbound',entityId:allocation.id,message:'Source credit allocation property is unrelated to its exact parents'});
      if (credit.personId && charge?.personId && credit.personId !== charge.personId) violations.push({code:"credit_allocation_person_mismatch",entityId:allocation.id,message:"Credit and charge belong to different source accounts"});
    }
    return violations;
  }
  if (allocation.creditTransactionId) violations.push({code:"allocation_parent_union_invalid",entityId:allocation.id,message:"Only credit applications may reference a credit parent"});
  if (allocation.kind === "transfer" && (!historical || !isSourceAllocationTransfer(allocation))) violations.push({code:"allocation_transfer_source_invalid",entityId:allocation.id,message:"Transfer movement requires exact artifact-bound source evidence"});
  const paymentUnknown = allocation.paymentLinkKnowledge === "unknown" || allocation.paymentLinkKnowledge === "ambiguous";
  const chargeUnknown = allocation.chargeLinkKnowledge === "unknown" || allocation.chargeLinkKnowledge === "ambiguous";
  if (!payment && !paymentUnknown) violations.push({ code: "allocation_payment_missing", entityId: allocation.id, message: `Payment ${String(allocation.paymentTransactionId ?? "") } is missing` });
  else if (payment && payment.kind !== "payment" && payment.kind !== null) violations.push({ code: "allocation_payment_not_payment", entityId: allocation.id, message: `Transaction ${payment.id} is not a payment` });
  else if (payment && payment.status !== "posted" && payment.status !== null) violations.push({ code: "allocation_payment_not_posted", entityId: allocation.id, message: `Payment ${payment.id} is not posted` });
  if (!charge && !chargeUnknown) violations.push({ code: "allocation_charge_missing", entityId: allocation.id, message: `Charge ${String(allocation.chargeTransactionId ?? "") } is missing` });
  else if (charge && charge.kind !== "charge" && charge.kind !== null) violations.push({ code: "allocation_charge_not_charge", entityId: allocation.id, message: `Transaction ${charge.id} is not a charge` });
  else if (charge && charge.status !== "posted" && charge.status !== null) violations.push({ code: "allocation_charge_not_posted", entityId: allocation.id, message: `Charge ${charge.id} is not posted` });
  if (payment && charge && payment.propertyId !== null && charge.propertyId !== null && payment.propertyId !== charge.propertyId) violations.push({ code: "allocation_property_mismatch", entityId: allocation.id, message: `Payment ${payment.id} and charge ${charge.id} belong to different properties` });
  if (payment && charge && payment.tenancyId && charge.tenancyId && payment.tenancyId !== charge.tenancyId) violations.push({ code: "allocation_tenancy_mismatch", entityId: allocation.id, message: `Payment ${payment.id} and charge ${charge.id} belong to different tenancies` });
  const allocatedOn = allocation.allocatedOn;
  const allocatedOnKnown = typeof allocatedOn === "string" && allocatedOn.length > 0;
  if (allocatedOnKnown && !isoDateSchema.safeParse(allocatedOn).success) violations.push({ code: "allocation_date_invalid", entityId: allocation.id, message: "Allocation date must be a real calendar date" });
  if (allocatedOnKnown && payment && typeof payment.postedOn === "string" && allocatedOn < payment.postedOn) violations.push({ code: "allocation_predates_payment", entityId: allocation.id, message: `Allocation ${allocation.id} predates payment ${payment.id}` });
  if (allocatedOnKnown && charge && typeof charge.postedOn === "string" && allocatedOn < charge.postedOn && !(historical && recordedFutureAllocationAmount(allocation, allocationHistory, transactions) >= -(allocation.amountCents ?? 0) && isSourceAllocationReversal(allocation))) violations.push({ code: "allocation_predates_charge", entityId: allocation.id, message: `Allocation ${allocation.id} predates charge ${charge.id}` });
  // A source allocation can have a future effective date while its immutable source
  // update proves it already existed before a reversal. Keep both dates intact.
  const sourceUpdatedAt = allocation.source?.sourceUpdatedAt;
  const sourceHistoryDate = allocation.source?.system === "rent_manager" && /^[a-f0-9]{64}$/.test(allocation.sourceArtifactSha256 ?? "")
    && allocation.paymentLinkKnowledge === "exact" && allocation.chargeLinkKnowledge === "exact"
    && typeof sourceUpdatedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(sourceUpdatedAt) && Number.isFinite(Date.parse(sourceUpdatedAt))
    && isoDateSchema.safeParse(sourceUpdatedAt.slice(0, 10)).success ? sourceUpdatedAt.slice(0, 10) : undefined;
  const invalidReversal = (id: string) => (reversalIndex ? reversalIndex.get(id) ?? [] : transactions).some(transaction => transaction.kind === "reversal" && transaction.status === "posted" && transaction.reversalOfId === id && (!historical || !transaction.postedOn || (!allocatedOnKnown || allocatedOn > transaction.postedOn) && (!sourceHistoryDate || sourceHistoryDate > transaction.postedOn)));
  if (payment && invalidReversal(payment.id)) violations.push({ code: "allocation_payment_reversed", entityId: allocation.id, message: `Payment ${payment.id} has already been reversed` });
  if (charge && invalidReversal(charge.id)) violations.push({ code: "allocation_charge_reversed", entityId: allocation.id, message: `Charge ${charge.id} has already been reversed` });
  if ((allocation.kind === "reversal" && (!historical || !isSourceAllocationReversal(allocation))) || (typeof allocation.amountCents === "number" && allocation.amountCents <= 0 && !(historical && isSourceAllocationReversal(allocation)))) violations.push({ code: "allocation_non_positive", entityId: allocation.id, message: "Allocation amount must be greater than zero" });
  return violations;
}

export function activeTenancyViolations(snapshot: RentOpsSnapshot): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const grouped = new Map<string, typeof snapshot.tenancies>();
  for (const tenancy of snapshot.tenancies) {
    if (tenancy.status !== "current" && tenancy.status !== "notice") continue;
    if (hasOperationalEndOn(tenancy, nowIsoDate())) continue;
    if (!tenancy.unitId || tenancy.unitLinkKnowledge === "unknown" || tenancy.unitLinkKnowledge === "ambiguous") continue;
    const existing = grouped.get(tenancy.unitId) ?? [];
    existing.push(tenancy);
    grouped.set(tenancy.unitId, existing);
  }
  for (const [unitId, tenancies] of Array.from(grouped.entries())) {
    if (tenancies.length > 1) violations.push({ code: "overlapping_current_tenancies", entityId: unitId, message: `Unit ${unitId} has ${tenancies.length} current/notice tenancies` });
  }
  const termsByTenancy = new Map<string, typeof snapshot.leaseTerms>();
  for (const term of snapshot.leaseTerms) {
    if (term.status === "cancelled") continue;
    if (!term.tenancyId || term.tenancyLinkKnowledge === "unknown" || term.tenancyLinkKnowledge === "ambiguous") continue;
    if (!term.contractStartOn || term.contractStartKnowledge === "unknown" || term.contractStartKnowledge === "ambiguous") continue;
    const existing = termsByTenancy.get(term.tenancyId) ?? [];
    existing.push(term);
    termsByTenancy.set(term.tenancyId, existing);
  }
  for (const [tenancyId, terms] of Array.from(termsByTenancy.entries())) {
    for (let index = 0; index < terms.length; index += 1) {
      for (let next = index + 1; next < terms.length; next += 1) {
        if (!rangesOverlap(terms[index].contractStartOn, terms[index].contractEndOn, terms[next].contractStartOn, terms[next].contractEndOn)) continue;
        violations.push({ code: "overlapping_lease_terms", entityId: tenancyId, message: `Tenancy ${tenancyId} has overlapping lease terms ${terms[index].id} and ${terms[next].id}` });
      }
    }
  }
  return violations;
}

export function effectiveLedgerKind(
  transaction: RentOpsLedgerTransaction,
  transactions: Map<string, RentOpsLedgerTransaction>,
): "charge" | "payment" | "credit" | "adjustment" | "unknown" {
  let current = transaction;
  const visited = new Set<string>();
  while (current.kind === "reversal" && current.reversalOfId) {
    if (visited.has(current.id)) return "credit";
    visited.add(current.id);
    const original = transactions.get(current.reversalOfId);
    if (!original) return "credit";
    current = original;
  }
  return current.kind === "reversal" ? "credit" : current.kind ?? "unknown";
}

export function ledgerBalanceSign(
  transaction: RentOpsLedgerTransaction,
  transactions: Map<string, RentOpsLedgerTransaction>,
): number {
  if (transaction.kind === "reversal" && transaction.reversalOfId) {
    const original = transactions.get(transaction.reversalOfId);
    if (!original || original.kind === "reversal") return 0;
    return -ledgerBalanceSign(original, transactions);
  }
  if (transaction.kind === "charge") return 1;
  if (transaction.kind === "payment" || transaction.kind === "credit") return -1;
  if (transaction.kind === "adjustment") return transaction.adjustmentDirection === "credit" ? -1 : 1;
  return -1;
}

export function validateSnapshot(snapshot: RentOpsSnapshot): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const v3 = snapshot.modelVersion === 3;
  for (const collection of [
    snapshot.properties,
    snapshot.units,
    snapshot.people,
    snapshot.householdMemberships,
    snapshot.tenancies,
    snapshot.leaseTerms,
    snapshot.recurringSchedules,
    snapshot.ledgerTransactions,
    snapshot.paymentAllocations,
    snapshot.securityDeposits,
    snapshot.subsidyContracts,
    snapshot.subsidyTenants,
    snapshot.subsidyPayments,
    snapshot.applications,
    snapshot.applicationHouseholdMembers,
    snapshot.applicationRequirements,
    snapshot.documents,
    snapshot.activityEvents,
    snapshot.sourceRecords,
    snapshot.importRuns,
  ] as Array<Array<{ id: string }>>) {
    const ids = new Set<string>();
    for (const entity of collection) {
      if (!entity.id) violations.push({ code: "missing_id", message: "Entity is missing an id" });
      else if (ids.has(entity.id)) violations.push({ code: "duplicate_id", entityId: entity.id, message: `Entity ID ${entity.id} is duplicated within its entity type` });
      else ids.add(entity.id);
    }
  }
  const propertyIds = new Set(snapshot.properties.map((entity) => entity.id));
  const units = new Map(snapshot.units.map((entity) => [entity.id, entity]));
  const personIds = new Set(snapshot.people.map((entity) => entity.id));
  const tenancies = new Map(snapshot.tenancies.map((entity) => [entity.id, entity]));
  const applicationIds = new Set(snapshot.applications.map((entity) => entity.id));
  for (const unit of snapshot.units) {
    if (!unit.propertyId && v3 && (unit.propertyLinkKnowledge === "unknown" || unit.propertyLinkKnowledge === "ambiguous")) continue;
    if (!propertyIds.has(unit.propertyId)) violations.push({ code: "unit_property_missing", entityId: unit.id, message: `Unit ${unit.id} references a missing property` });
  }
  for (const tenancy of snapshot.tenancies) {
    const unit = units.get(tenancy.unitId);
    const propertyValid = tenancy.propertyId ? propertyIds.has(tenancy.propertyId) : v3 && tenancy.propertyLinkKnowledge === "unknown";
    const unitValid = tenancy.unitId ? Boolean(unit && (!tenancy.propertyId || unit.propertyId === tenancy.propertyId)) : v3 && tenancy.unitLinkKnowledge === "unknown";
    const personValid = tenancy.primaryPersonId ? personIds.has(tenancy.primaryPersonId) : v3 && tenancy.primaryPersonLinkKnowledge === "unknown";
    // Unknown source-absent links do not bypass validation of present links.
    if (!propertyValid || !unitValid || !personValid) violations.push({ code: "tenancy_reference_invalid", entityId: tenancy.id, message: `Tenancy ${tenancy.id} has an invalid property, unit, or primary person reference` });
  }
  for (const membership of snapshot.householdMemberships) {
    if (!personIds.has(membership.personId) || membership.accountPersonId && !personIds.has(membership.accountPersonId) || membership.tenancyId && !tenancies.has(membership.tenancyId) || membership.applicationId && !applicationIds.has(membership.applicationId) || (!membership.tenancyId && !membership.applicationId && !membership.accountPersonId)) {
      violations.push({ code: "household_reference_invalid", entityId: membership.id, message: `Household membership ${membership.id} has an invalid reference` });
    }
  }
  for (const term of snapshot.leaseTerms) {
    if (v3 && !term.tenancyId && (term.tenancyLinkKnowledge === "unknown" || term.tenancyLinkKnowledge === "ambiguous")) continue;
    if (!tenancies.has(term.tenancyId)) violations.push({ code: "lease_tenancy_missing", entityId: term.id, message: `Lease term ${term.id} references a missing tenancy` });
  }
  for (const schedule of snapshot.recurringSchedules) {
    const tenancy = schedule.tenancyId !== null && schedule.tenancyId !== undefined ? tenancies.get(schedule.tenancyId) : undefined;
    const unit = schedule.unitId !== null && schedule.unitId !== undefined ? units.get(schedule.unitId) : undefined;
    const canonicalScope = knownScheduleScope(schedule);
    const knownTypeMissingValue = knownScheduleFact(schedule.scopeTypeKnowledge) && (schedule.scopeType === null || schedule.scopeType === undefined);
    const knownLinkMissingValue = knownScheduleLink(schedule.scopeLinkKnowledge) && (schedule.scopeId === null || schedule.scopeId === undefined);
    let canonicalScopeInvalid = false;
    if (canonicalScope?.type === "property") {
      canonicalScopeInvalid = !propertyIds.has(canonicalScope.id)
        || (schedule.propertyId !== null && schedule.propertyId !== canonicalScope.id);
    } else if (canonicalScope?.type === "unit") {
      const scopedUnit = units.get(canonicalScope.id);
      canonicalScopeInvalid = !scopedUnit
        || (schedule.propertyId !== null && scopedUnit.propertyId !== schedule.propertyId)
        || (schedule.unitId !== null && schedule.unitId !== undefined && schedule.unitId !== canonicalScope.id);
    } else if (canonicalScope?.type === "tenant") {
      canonicalScopeInvalid = !personIds.has(canonicalScope.id)
        || (schedule.personId !== null && schedule.personId !== undefined && schedule.personId !== canonicalScope.id);
    }
    const copiedPropertyInvalid = schedule.propertyId !== null && !propertyIds.has(schedule.propertyId);
    const copiedUnitInvalid = schedule.unitId !== null && schedule.unitId !== undefined && !unit;
    const copiedPropertyUnitMismatch = Boolean(unit && schedule.propertyId !== null && unit.propertyId !== schedule.propertyId);
    const sourceDateMissing = (schedule.effectiveFromKnowledge === "source" || schedule.effectiveFromKnowledge === "manual")
      && (schedule.effectiveFrom === null || schedule.effectiveFrom === undefined);
    const unknownOpenStartHasDate = schedule.effectiveFromKnowledge === "unknown_open_start"
      && schedule.effectiveFrom !== null
      && schedule.effectiveFrom !== undefined;
    const invertedDates = schedule.effectiveFrom !== null
      && schedule.effectiveFrom !== undefined
      && schedule.effectiveTo !== null
      && schedule.effectiveTo !== undefined
      && schedule.effectiveTo < schedule.effectiveFrom;
    if (knownTypeMissingValue || knownLinkMissingValue || canonicalScopeInvalid || copiedPropertyInvalid || copiedUnitInvalid || copiedPropertyUnitMismatch || sourceDateMissing || unknownOpenStartHasDate || invertedDates) {
      violations.push({ code: "schedule_reference_invalid", entityId: schedule.id, message: `Recurring schedule ${schedule.id} has inconsistent scope, property, unit, or effective-date references` });
    }
    if (schedule.tenancyId !== null && schedule.tenancyId !== undefined && !tenancy) {
      violations.push({ code: "schedule_tenancy_missing", entityId: schedule.id, message: `Recurring schedule ${schedule.id} references a missing tenancy` });
    } else if (tenancy && (
      (schedule.propertyId !== null && tenancy.propertyId !== schedule.propertyId)
      || (schedule.unitId !== null && schedule.unitId !== undefined && tenancy.unitId !== schedule.unitId)
      || (schedule.personId !== null && schedule.personId !== undefined && tenancy.primaryPersonId !== schedule.personId)
      || (canonicalScope?.type === "tenant" && tenancy.primaryPersonId !== canonicalScope.id)
    )) {
      violations.push({ code: "schedule_tenancy_mismatch", entityId: schedule.id, message: `Recurring schedule ${schedule.id} has inconsistent tenancy, property, unit, or person references` });
    }
    if (canonicalScope?.type === "unit" && schedule.tenancyId !== null && schedule.tenancyId !== undefined) violations.push({ code: "schedule_unit_tenancy_unexpected", entityId: schedule.id, message: `Unit recurring schedule ${schedule.id} must not leak a tenant tenancy reference` });
    if (canonicalScope?.type === "property" && (
      schedule.unitId !== null && schedule.unitId !== undefined
      || schedule.tenancyId !== null && schedule.tenancyId !== undefined
      || schedule.personId !== null && schedule.personId !== undefined
    )) violations.push({ code: "schedule_property_scope_leak", entityId: schedule.id, message: `Property recurring schedule ${schedule.id} must remain property-scoped` });
  }
  for (const application of snapshot.applications) {
    const unit = application.unitId ? units.get(application.unitId) : undefined;
    if (application.propertyId && !propertyIds.has(application.propertyId) || application.unitId && (!unit || !!application.propertyId && unit.propertyId !== application.propertyId)) violations.push({ code: "application_reference_invalid", entityId: application.id, message: `Application ${application.id} has an invalid property or unit reference` });
  }
  for (const member of snapshot.applicationHouseholdMembers) if (!applicationIds.has(member.applicationId)) violations.push({ code: "application_member_reference_invalid", entityId: member.id, message: `Application member ${member.id} references a missing application` });
  for (const requirement of snapshot.applicationRequirements) if (!applicationIds.has(requirement.applicationId)) violations.push({ code: "application_requirement_reference_invalid", entityId: requirement.id, message: `Application requirement ${requirement.id} references a missing application` });
  const transactionMap = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.id, transaction]));
  const postedReversalsByOriginal = new Map<string, RentOpsLedgerTransaction[]>();
  for (const transaction of snapshot.ledgerTransactions) {
    const unknownProperty = !transaction.propertyId && (transaction.propertyLinkKnowledge === "unknown" || transaction.propertyLinkKnowledge === "ambiguous");
    const unknownUnit = !transaction.unitId && (transaction.unitLinkKnowledge === "unknown" || transaction.unitLinkKnowledge === "ambiguous");
    const unknownTenancy = !transaction.tenancyId && (transaction.tenancyLinkKnowledge === "unknown" || transaction.tenancyLinkKnowledge === "ambiguous");
    const unknownPerson = !transaction.personId && (transaction.personLinkKnowledge === "unknown" || transaction.personLinkKnowledge === "ambiguous");
    const invalidProperty = transaction.propertyId ? !propertyIds.has(transaction.propertyId) : !unknownProperty;
    if (invalidProperty || transaction.unitId && !units.has(transaction.unitId) || (!transaction.unitId && !unknownUnit) || transaction.tenancyId && !tenancies.has(transaction.tenancyId) || (!transaction.tenancyId && !unknownTenancy) || transaction.personId && !personIds.has(transaction.personId) || (!transaction.personId && !unknownPerson)) violations.push({ code: "ledger_reference_invalid", entityId: transaction.id, message: `Ledger transaction ${transaction.id} has an invalid property, unit, tenancy, or person reference` });
    if (transaction.amountCents !== null && transaction.amountCents !== undefined && (!Number.isSafeInteger(transaction.amountCents) || transaction.amountCents < 0 || transaction.amountCents > POSTGRES_INTEGER_MAX)) violations.push({ code: "invalid_ledger_amount", entityId: transaction.id, message: "Ledger amounts must be non-negative PostgreSQL integer cents" });
    if (transaction.postedOn !== null && transaction.postedOn !== undefined && !isoDateSchema.safeParse(transaction.postedOn).success) violations.push({ code: "ledger_date_invalid", entityId: transaction.id, message: "Ledger posted date must be a real calendar date" });
    if (transaction.dueOn && !isoDateSchema.safeParse(transaction.dueOn).success) violations.push({ code: "ledger_due_date_invalid", entityId: transaction.id, message: "Ledger due date must be a real calendar date" });
    if (transaction.kind === "reversal") {
      if (!transaction.reversalOfId) {
        violations.push({ code: "reversal_missing_link", entityId: transaction.id, message: "Reversals must link to the corrected transaction" });
      } else {
        const original = transactionMap.get(transaction.reversalOfId);
        if (!original) violations.push({ code: "reversal_target_missing", entityId: transaction.id, message: `Reversal target ${transaction.reversalOfId} is missing` });
        else if (original.kind === "reversal") violations.push({ code: "reversal_of_reversal", entityId: transaction.id, message: "A reversal cannot reverse another reversal" });
        else {
          if (transaction.postedOn && original.postedOn && transaction.postedOn < original.postedOn) violations.push({ code: "reversal_predates_original", entityId: transaction.id, message: "A reversal cannot predate its original transaction" });
          if ((transaction.amountCents !== null && transaction.amountCents !== undefined && original.amountCents !== null && original.amountCents !== undefined && transaction.amountCents !== original.amountCents) || transaction.category !== original.category || (transaction.propertyId && original.propertyId && transaction.propertyId !== original.propertyId) || (transaction.unitId && original.unitId && transaction.unitId !== original.unitId) || (transaction.tenancyId && original.tenancyId && transaction.tenancyId !== original.tenancyId) || (transaction.personId && original.personId && transaction.personId !== original.personId)) violations.push({ code: "reversal_payload_mismatch", entityId: transaction.id, message: "Reversal amount, category, and scope must match the original transaction" });
          if (transaction.status === "posted") {
            const existing = postedReversalsByOriginal.get(original.id) ?? [];
            existing.push(transaction);
            postedReversalsByOriginal.set(original.id, existing);
          }
        }
      }
    } else if (transaction.reversalOfId) violations.push({ code: "non_reversal_has_link", entityId: transaction.id, message: "Only reversal transactions may link to an original" });
    if (transaction.kind === "adjustment" && !transaction.adjustmentDirection) violations.push({ code: "adjustment_direction_missing", entityId: transaction.id, message: "Adjustments must specify debit or credit direction" });
    if (transaction.kind !== "adjustment" && transaction.adjustmentDirection) violations.push({ code: "adjustment_direction_unexpected", entityId: transaction.id, message: "Only adjustments may specify an adjustment direction" });
  }
  for (const deposit of snapshot.securityDeposits) {
    const signedUnknownHeld = deposit.amountHeldCents === null && deposit.source?.system === "rent_manager" && Number.isSafeInteger(deposit.sourceBalanceCents) && deposit.sourceBalanceCents! < 0;
    if (!signedUnknownHeld && (!Number.isSafeInteger(deposit.amountHeldCents) || deposit.amountHeldCents! < 0)) violations.push({code:"deposit_amount_invalid",entityId:deposit.id,message:"Held deposit amount must be known nonnegative cents or a signed source exception"});
    if (deposit.sourceBalanceCents != null && (!deposit.source || !Number.isSafeInteger(deposit.sourceBalanceCents))) violations.push({code:"deposit_source_balance_invalid",entityId:deposit.id,message:"Signed source balance requires exact source cents"});
    const tenancy = deposit.tenancyId ? tenancies.get(deposit.tenancyId) : undefined;
    const unit = deposit.unitId ? units.get(deposit.unitId) : undefined;
    const propertyLinkKnowledge = (deposit as { propertyLinkKnowledge?: string }).propertyLinkKnowledge;
    const personLinkKnowledge = (deposit as { personLinkKnowledge?: string }).personLinkKnowledge;
    const unknownProperty = !deposit.propertyId && (propertyLinkKnowledge === "unknown" || propertyLinkKnowledge === "ambiguous");
    const unknownPerson = !deposit.personId && (personLinkKnowledge === "unknown" || personLinkKnowledge === "ambiguous");
    const unitLinkKnowledge = (deposit as { unitLinkKnowledge?: string }).unitLinkKnowledge;
    const unknownUnit = !deposit.unitId && (unitLinkKnowledge === "unknown" || unitLinkKnowledge === "ambiguous");
    const propertyInvalid = deposit.propertyId ? !propertyIds.has(deposit.propertyId) : !unknownProperty;
    const personInvalid = deposit.personId ? !personIds.has(deposit.personId) : !unknownPerson;
    const unitInvalid = deposit.unitId
      ? !unit || Boolean(deposit.propertyId && unit.propertyId !== deposit.propertyId)
      : unitLinkKnowledge === "exact" || !unknownUnit;
    const tenancyMismatch = tenancy && (
      Boolean(deposit.propertyId && tenancy.propertyId !== deposit.propertyId) ||
      Boolean(deposit.unitId && tenancy.unitId !== deposit.unitId) ||
      Boolean(deposit.personId && tenancy.primaryPersonId !== deposit.personId)
    );
    if (propertyInvalid || personInvalid || unitInvalid || tenancyMismatch) {
      violations.push({ code: "deposit_reference_invalid", entityId: deposit.id, message: `Deposit ${deposit.id} has inconsistent property, optional unit, tenancy, or person references` });
    }
    if (deposit.receivedOnKnowledge === "source" && !deposit.receivedOn || deposit.receivedOnKnowledge === "unknown" && deposit.receivedOn) violations.push({ code: "deposit_date_knowledge_invalid", entityId: deposit.id, message: `Deposit ${deposit.id} has inconsistent received-date knowledge` });
  }
  for (const contract of snapshot.subsidyContracts) {
    const tenancy = tenancies.get(contract.tenancyId);
    if (!tenancy || tenancy.propertyId !== contract.propertyId || tenancy.unitId !== contract.unitId) violations.push({ code: "subsidy_reference_invalid", entityId: contract.id, message: `Housing-assistance contract ${contract.id} has inconsistent tenancy, property, or unit references` });
  }
  const subsidyContractMap = new Map(snapshot.subsidyContracts.map((contract) => [contract.id, contract]));
  const subsidyTenantMap = new Map(snapshot.subsidyTenants.map((tenant) => [tenant.id, tenant]));
  const unknownLink = (knowledge: string | undefined): boolean => knowledge === "unknown" || knowledge === "ambiguous";
  for (const tenant of snapshot.subsidyTenants) {
    if (tenant.subsidyContractId && !subsidyContractMap.has(tenant.subsidyContractId) && !(v3 && unknownLink(tenant.subsidyContractLinkKnowledge))) violations.push({ code: "subsidy_tenant_contract_missing", entityId: tenant.id, message: `SubsidyTenant ${tenant.id} references a missing contract` });
    if (tenant.tenancyId && !tenancies.has(tenant.tenancyId) && !(v3 && unknownLink(tenant.tenancyLinkKnowledge))) violations.push({ code: "subsidy_tenant_tenancy_missing", entityId: tenant.id, message: `SubsidyTenant ${tenant.id} references a missing tenancy` });
    if (tenant.propertyId && !propertyIds.has(tenant.propertyId) && !(v3 && unknownLink(tenant.propertyLinkKnowledge))) violations.push({ code: "subsidy_tenant_property_missing", entityId: tenant.id, message: `SubsidyTenant ${tenant.id} references a missing property` });
    const unit = tenant.unitId ? units.get(tenant.unitId) : undefined;
    if (tenant.unitId && (!unit || tenant.propertyId && unit.propertyId !== tenant.propertyId) && !(v3 && unknownLink(tenant.unitLinkKnowledge))) violations.push({ code: "subsidy_tenant_unit_missing", entityId: tenant.id, message: `SubsidyTenant ${tenant.id} references an invalid unit` });
    if (tenant.personId && !personIds.has(tenant.personId) && !(v3 && unknownLink(tenant.personLinkKnowledge))) violations.push({ code: "subsidy_tenant_person_missing", entityId: tenant.id, message: `SubsidyTenant ${tenant.id} references a missing person` });
    if (tenant.effectiveFromKnowledge === "source" && !tenant.effectiveFrom || tenant.effectiveToKnowledge === "source" && !tenant.effectiveTo || tenant.effectiveFrom && tenant.effectiveTo && tenant.effectiveTo < tenant.effectiveFrom) violations.push({ code: "subsidy_tenant_date_invalid", entityId: tenant.id, message: `SubsidyTenant ${tenant.id} has inconsistent effective dates` });
  }
  for (const payment of snapshot.subsidyPayments) {
    if (payment.subsidyContractId && !subsidyContractMap.has(payment.subsidyContractId) && !(v3 && unknownLink(payment.subsidyContractLinkKnowledge))) violations.push({ code: "subsidy_payment_contract_missing", entityId: payment.id, message: `SubsidyPayment ${payment.id} references a missing contract` });
    if (payment.subsidyTenantId && !subsidyTenantMap.has(payment.subsidyTenantId) && !(v3 && unknownLink(payment.subsidyTenantLinkKnowledge))) violations.push({ code: "subsidy_payment_tenant_missing", entityId: payment.id, message: `SubsidyPayment ${payment.id} references a missing SubsidyTenant row` });
    if (payment.paymentTransactionId && (!transactionMap.has(payment.paymentTransactionId) || transactionMap.get(payment.paymentTransactionId)?.kind !== "payment") && !(v3 && unknownLink(payment.paymentLinkKnowledge))) violations.push({ code: "subsidy_payment_ledger_link_invalid", entityId: payment.id, message: `SubsidyPayment ${payment.id} has a non-payment ledger link` });
    if (payment.tenancyId && !tenancies.has(payment.tenancyId) && !(v3 && unknownLink(payment.tenancyLinkKnowledge))) violations.push({ code: "subsidy_payment_tenancy_missing", entityId: payment.id, message: `SubsidyPayment ${payment.id} references a missing tenancy` });
    if (payment.propertyId && !propertyIds.has(payment.propertyId) && !(v3 && unknownLink(payment.propertyLinkKnowledge))) violations.push({ code: "subsidy_payment_property_missing", entityId: payment.id, message: `SubsidyPayment ${payment.id} references a missing property` });
    const unit = payment.unitId ? units.get(payment.unitId) : undefined;
    if (payment.unitId && (!unit || payment.propertyId && unit.propertyId !== payment.propertyId) && !(v3 && unknownLink(payment.unitLinkKnowledge))) violations.push({ code: "subsidy_payment_unit_missing", entityId: payment.id, message: `SubsidyPayment ${payment.id} references an invalid unit` });
    if (payment.personId && !personIds.has(payment.personId) && !(v3 && unknownLink(payment.personLinkKnowledge))) violations.push({ code: "subsidy_payment_person_missing", entityId: payment.id, message: `SubsidyPayment ${payment.id} references a missing person` });
    if (payment.paymentOnKnowledge === "source" && !payment.paymentOn || payment.paymentOnKnowledge === "unknown" && payment.paymentOn) violations.push({ code: "subsidy_payment_date_knowledge_invalid", entityId: payment.id, message: `SubsidyPayment ${payment.id} has inconsistent payment-date knowledge` });
  }
  for (const document of snapshot.documents) {
    if (document.propertyId && !propertyIds.has(document.propertyId) || document.unitId && !units.has(document.unitId) || document.tenancyId && !tenancies.has(document.tenancyId) || document.personId && !personIds.has(document.personId) || document.applicationId && !applicationIds.has(document.applicationId)) violations.push({ code: "document_reference_invalid", entityId: document.id, message: `Document ${document.id} has an invalid entity reference` });
    if (document.storageKey !== null && document.storageKey !== undefined) {
      try { assertPrivateStorageKey(document.storageKey); } catch (error) { violations.push({ code: "document_storage_key_invalid", entityId: document.id, message: error instanceof Error ? error.message : "Document storage key is invalid" }); }
    } else if (!document.availability) {
      violations.push({ code: "document_storage_key_invalid", entityId: document.id, message: "Document without a storage key must declare metadata/requested/unavailable availability" });
    }
    violations.push(...documentReferenceViolations(snapshot, document));
  }
  for (const [originalId, reversals] of Array.from(postedReversalsByOriginal.entries())) {
    if (reversals.length > 1) violations.push({ code: "transaction_reversed_twice", entityId: originalId, message: `Transaction ${originalId} has ${reversals.length} posted reversals` });
  }
  violations.push(...baseRentScheduleViolations(snapshot.recurringSchedules));
  violations.push(...activeTenancyViolations(snapshot));
  for (const payment of snapshot.ledgerTransactions.filter(row=>row.kind==="payment" && row.allocationMode==="multi_property")) {
    const rows = snapshot.paymentAllocations.filter(row=>row.paymentTransactionId===payment.id && row.kind!=="transfer");
    const properties = new Set(rows.map(row=>transactionMap.get(row.chargeTransactionId??"")?.propertyId).filter(Boolean));
    const valid = payment.source?.system==="rent_manager" && /^[a-f0-9]{64}$/.test(payment.sourceArtifactSha256??"") && !!payment.personId && payment.personLinkKnowledge==="exact"
      && payment.propertyId===null && payment.unitId===null && payment.tenancyId===null && properties.size>1
      && rows.every(row=>row.paymentLinkKnowledge==="exact" && row.chargeLinkKnowledge==="exact" && !!row.allocatedOn && typeof row.amountCents==="number" && transactionMap.get(row.chargeTransactionId??"")?.personId===payment.personId)
      && rows.reduce((sum,row)=>sum+(row.amountCents??0),0)===payment.amountCents;
    if(!valid) violations.push({code:"shared_payment_scope_invalid",entityId:payment.id,message:"Shared payment requires exact source account, complete allocations and a full receipt tie-out"});
  }
  const allocationsByPayment = new Map<string, number>();
  const allocationsByCharge = new Map<string, number>();
  const reversedAllocationTargets = postedReversalTargets(snapshot.ledgerTransactions);
  // Include malformed targets too: allocation validation must retain every
  // candidate from the original scan, not only valid reversal originals.
  const allocationReversals = new Map<string | null | undefined, RentOpsLedgerTransaction[]>();
  for (const transaction of snapshot.ledgerTransactions) {
    if (transaction.kind !== "reversal" || transaction.status !== "posted") continue;
    const rows = allocationReversals.get(transaction.reversalOfId) ?? [];
    rows.push(transaction);
    allocationReversals.set(transaction.reversalOfId, rows);
  }
  const allocationPairs = new Map<string, RentOpsPaymentAllocation[]>();
  for (const allocation of snapshot.paymentAllocations) {
    const allocationParentId = allocation.kind === "credit_allocation" ? allocation.creditTransactionId : allocation.paymentTransactionId;
    if (allocation.kind !== "transfer" && allocation.paymentTransactionId && allocation.chargeTransactionId) {const key = `${allocation.paymentTransactionId}\0${allocation.chargeTransactionId}`; const rows = allocationPairs.get(key) ?? []; rows.push(allocation); allocationPairs.set(key, rows);}
    violations.push(...validateAllocationWithReversals(allocation, allocation.paymentTransactionId ? transactionMap.get(allocation.paymentTransactionId) : undefined, allocation.chargeTransactionId ? transactionMap.get(allocation.chargeTransactionId) : undefined, snapshot.ledgerTransactions, true, snapshot.paymentAllocations, allocationReversals));
    if (allocation.kind !== "transfer" && allocationParentId && typeof allocation.amountCents === "number") allocationsByPayment.set(allocationParentId, (allocationsByPayment.get(allocationParentId) ?? 0) + allocation.amountCents);
    if (allocation.kind !== "transfer" && allocation.chargeTransactionId && !reversedAllocationTargets.has(allocation.chargeTransactionId) && !!allocationParentId && !reversedAllocationTargets.has(allocationParentId) && typeof allocation.amountCents === "number") allocationsByCharge.set(allocation.chargeTransactionId, (allocationsByCharge.get(allocation.chargeTransactionId) ?? 0) + allocation.amountCents);
  }
  for (const rows of Array.from(allocationPairs.values())) {
    // A source reverse row has no invented target-allocation link. Its exact
    // payment/charge pair must have sufficient dated allocation history.
    let net = 0;
    for (const row of rows.sort((a,b) => (a.allocatedOn ?? "").localeCompare(b.allocatedOn ?? "") || (b.amountCents ?? 0) - (a.amountCents ?? 0))) {
      net += row.amountCents ?? 0;
      if (net < 0 && recordedFutureAllocationAmount(row,rows,snapshot.ledgerTransactions) < -net) violations.push({code:"allocation_reversal_exceeds_history",entityId:row.id,message:"Reverse allocation exceeds its exact payment and charge allocation history"});
    }
  }
  for (const [paymentId, amount] of Array.from(allocationsByPayment.entries())) {
    const payment = transactionMap.get(paymentId);
    if (payment && typeof payment.amountCents === "number" && amount > payment.amountCents) violations.push({ code: "allocations_exceed_payment", entityId: paymentId, message: `Allocations ${amount} exceed payment ${payment.amountCents}` });
  }
  for (const [chargeId, amount] of Array.from(allocationsByCharge.entries())) {
    const charge = transactionMap.get(chargeId);
    if (charge && typeof charge.amountCents === "number" && amount > charge.amountCents) violations.push({ code: "allocations_exceed_charge", entityId: chargeId, message: `Allocations ${amount} exceed charge ${charge.amountCents}` });
  }
  return violations;
}

export function assertValidSnapshot(snapshot: RentOpsSnapshot): void {
  const violations = validateSnapshot(snapshot);
  if (violations.length > 0) throw new RentOpsInvariantError("Rent Operations snapshot failed invariant validation", violations);
}

export function buildReversal(
  original: RentOpsLedgerTransaction,
  reversal: Omit<RentOpsLedgerTransaction, "kind" | "reversalOfId" | "amountCents" | "category" | "propertyId" | "unitId" | "tenancyId" | "personId"> & Partial<Pick<RentOpsLedgerTransaction, "propertyId" | "unitId" | "tenancyId" | "personId">>,
): RentOpsLedgerTransaction {
  if (original.status !== "posted") throw new RentOpsInvariantError("Only a posted ledger entry can be reversed");
  if (original.kind === "reversal") throw new RentOpsInvariantError("A reversal cannot reverse another reversal");
  if (!original.postedOn || !reversal.postedOn) throw new RentOpsInvariantError("A reversal requires a known posted date");
  if (reversal.postedOn < original.postedOn) throw new RentOpsInvariantError("A reversal cannot predate its original transaction");
  const { source: _originalSource, ...originalWithoutSource } = original;
  const { source: _reversalSource, ...reversalWithoutSource } = reversal;
  return {
    ...originalWithoutSource,
    ...reversalWithoutSource,
    id: reversal.id,
    kind: "reversal",
    reversalOfId: original.id,
    category: original.category,
    propertyId: original.propertyId,
    unitId: original.unitId,
    tenancyId: original.tenancyId,
    personId: original.personId,
    amountCents: original.amountCents,
    status: "posted",
    adjustmentDirection: undefined,
  };
}
