import { hasVacancyConfirmationOn, hasOperationalEndOn, hasOccupancyConfirmationOn, isKnownPastAccountOn, isOccupiedTenancyOn } from "./tenancy-occupancy";
import type {
  Cents,
  IsoDate,
  IsoMonth,
  OccupancyState,
  RentOpsLeaseTerm,
  RentOpsRecurringChargeSchedule,
  RentOpsSnapshot,
  RentOpsTenancy,
  RentOpsUnit,
  ScheduledIncomeRow,
} from "../../../shared/rent-ops-contracts";
import { monthEnd, monthStart, rangesOverlap } from "./dates";

const TENANCY_STATUS_SET = new Set(["current", "notice", "past", "future", "cancelled"]);
const LEASE_STATUS_SET = new Set(["executed", "month_to_month"]);

function factIsKnown(knowledge: string | null | undefined, strictKnowledge: boolean): boolean {
  return !strictKnowledge || knowledge === "source" || knowledge === "manual";
}

export interface FinancialMonthInterval {
  month: IsoMonth;
  start: IsoDate;
  end: IsoDate;
}

export function financialMonthInterval(month: IsoMonth): FinancialMonthInterval {
  return { month, start: monthStart(month), end: monthEnd(month) };
}

export interface FinancialOccupancyProjection {
  unitId: string;
  propertyId?: string;
  month: IsoMonth;
  occupancy: OccupancyState | "past";
  tenancyId?: string;
  personId?: string;
  partialMonth: boolean;
  exceptionCodes: string[];
}

function linkIsUnknown(value: string | undefined, knowledge: string | undefined, strictKnowledge = false): boolean {
  return !value || knowledge === "unknown" || knowledge === "ambiguous" || (strictKnowledge && knowledge !== "exact" && knowledge !== "manual");
}

function leaseOverlapsMonth(term: RentOpsLeaseTerm, interval: FinancialMonthInterval): boolean {
  if (!term.contractStartOn) return false;
  return rangesOverlap(term.contractStartOn, term.contractEndOn, interval.start, interval.end);
}

function exactLeaseForMonth(snapshot: RentOpsSnapshot, tenancyId: string, interval: FinancialMonthInterval): { term?: RentOpsLeaseTerm; unknown: boolean } {
  const terms = snapshot.leaseTerms.filter((term) => term.tenancyId === tenancyId);
  if (terms.length === 0) return { unknown: true };
  const strictKnowledge = snapshot.modelVersion === 3;
  const eligible = terms.filter((term) => {
    if (!LEASE_STATUS_SET.has(term.status) || !factIsKnown(term.statusKnowledge, strictKnowledge) || !factIsKnown(term.contractStartKnowledge, strictKnowledge) || (strictKnowledge && term.tenancyLinkKnowledge !== "exact" && term.tenancyLinkKnowledge !== "manual")) return false;
    if (!term.contractStartOn) return false;
    const explicitMonthToMonth = (term.status === "month_to_month" && factIsKnown(term.statusKnowledge, strictKnowledge)) || Boolean(term.monthToMonth && factIsKnown(term.monthToMonthKnowledge, strictKnowledge));
    if (term.contractEndOn && !factIsKnown(term.contractEndKnowledge, strictKnowledge) && !explicitMonthToMonth) return false;
    if (!term.contractEndOn && !explicitMonthToMonth) return false;
    const overlapTerm = explicitMonthToMonth && !term.contractEndOn ? { ...term, contractEndOn: undefined } : term;
    return leaseOverlapsMonth(overlapTerm, interval);
  });
  // Two independently identified lease rows are ambiguous even when their
  // visible dates happen to match.  Collapsing duplicates here would diverge
  // from the independent SQL audit and could hide a renewal/import defect.
  if (eligible.length > 1) return { unknown: true };
  const term = [...eligible].sort((left, right) => right.contractStartOn.localeCompare(left.contractStartOn) || right.id.localeCompare(left.id))[0];
  const unknown = !term && terms.some((candidate) => {
    if (!LEASE_STATUS_SET.has(candidate.status) || !candidate.contractStartOn) return true;
    if (!factIsKnown(candidate.statusKnowledge, strictKnowledge) || !factIsKnown(candidate.contractStartKnowledge, strictKnowledge)) return true;
    if (strictKnowledge && candidate.tenancyLinkKnowledge !== "exact" && candidate.tenancyLinkKnowledge !== "manual") return true;
    const explicitMonthToMonth = (candidate.status === "month_to_month" && factIsKnown(candidate.statusKnowledge, strictKnowledge)) || Boolean(candidate.monthToMonth && factIsKnown(candidate.monthToMonthKnowledge, strictKnowledge));
    return candidate.contractEndOn ? !factIsKnown(candidate.contractEndKnowledge, strictKnowledge) && !explicitMonthToMonth : !explicitMonthToMonth;
  });
  return { term, unknown };
}

function tenancyOccupiesMonth(
  snapshot: RentOpsSnapshot,
  tenancy: RentOpsTenancy,
  interval: FinancialMonthInterval,
  asOf: IsoDate,
): { state: "current" | "future_preleased" | "past" | "excluded" | "unknown"; partialMonth: boolean; exceptionCodes: string[] } {
  const exceptionCodes: string[] = [];
  if (hasOperationalEndOn(tenancy, asOf)) return { state: "excluded", partialMonth: false, exceptionCodes: [] };
  const strictKnowledge = snapshot.modelVersion === 3;
  if (isKnownPastAccountOn(snapshot, tenancy.primaryPersonId, asOf, tenancy)) {
    return ["current", "notice", "future"].includes(tenancy.status)
      ? { state: "unknown", partialMonth: false, exceptionCodes: ["tenancy_account_status_conflict"] }
      : { state: "excluded", partialMonth: false, exceptionCodes: [] };
  }
  if (linkIsUnknown(tenancy.propertyId, tenancy.propertyLinkKnowledge, strictKnowledge)) exceptionCodes.push("property_link_unknown");
  if (linkIsUnknown(tenancy.unitId, tenancy.unitLinkKnowledge, strictKnowledge)) exceptionCodes.push("unit_link_unknown");
  if (linkIsUnknown(tenancy.primaryPersonId, tenancy.primaryPersonLinkKnowledge, strictKnowledge)) exceptionCodes.push("person_link_unknown");
  if (exceptionCodes.length > 0) return { state: "unknown", partialMonth: false, exceptionCodes };
  if (!TENANCY_STATUS_SET.has(tenancy.status) || !factIsKnown(tenancy.statusKnowledge, strictKnowledge)) return { state: "unknown", partialMonth: false, exceptionCodes: ["tenancy_status_unknown"] };
  if (tenancy.status === "cancelled") return { state: "excluded", partialMonth: false, exceptionCodes: [] };

  const isFuture = tenancy.status === "future";
  // Observation is a conservative lower bound for known occupancy, never a
  // claimed actual move-in or authority to generate historical charges.
  const observation = !isFuture && hasOccupancyConfirmationOn(tenancy, asOf) ? tenancy.occupancyConfirmedOn : undefined;
  const moveIn = isFuture ? tenancy.plannedMoveInOn : tenancy.actualMoveInOn ?? observation;
  const moveInKnowledge = isFuture ? tenancy.plannedMoveInKnowledge : observation ? "manual" : tenancy.actualMoveInKnowledge;
  if (!moveIn || !factIsKnown(moveInKnowledge, strictKnowledge)) return { state: "unknown", partialMonth: false, exceptionCodes: [isFuture ? "planned_move_in_unknown" : "actual_move_in_unknown"] };
  if (moveIn > interval.end) return { state: "excluded", partialMonth: false, exceptionCodes: [] };

  if (isFuture) {
    const lease = exactLeaseForMonth(snapshot, tenancy.id, interval);
    if (lease.unknown || !lease.term) return { state: "unknown", partialMonth: false, exceptionCodes: ["future_lease_unknown"] };
    if (tenancy.actualMoveInOn && tenancy.actualMoveInOn <= interval.end) {
      // A future source status contradicts an exact actual move-in. Keep the
      // unit isolated as unknown rather than silently changing the source fact.
      return { state: "unknown", partialMonth: false, exceptionCodes: ["tenancy_status_date_conflict"] };
    }
    return { state: "future_preleased", partialMonth: moveIn > interval.start, exceptionCodes: [] };
  }

  const actualMoveOut = tenancy.actualMoveOutOn;
  if (tenancy.status === "past" && (!actualMoveOut || !factIsKnown(tenancy.actualMoveOutKnowledge, strictKnowledge))) return { state: "unknown", partialMonth: false, exceptionCodes: ["actual_move_out_unknown"] };
  if (actualMoveOut && !factIsKnown(tenancy.actualMoveOutKnowledge, strictKnowledge)) return { state: "unknown", partialMonth: false, exceptionCodes: ["actual_move_out_unknown"] };
  // An exact move-out before the report month proves this tenancy is outside
  // the occupancy interval.  Lease ambiguity cannot widen an already-ended
  // occupancy and must not turn an otherwise vacant unit into unknown.
  if (actualMoveOut && actualMoveOut < interval.start) return { state: "excluded", partialMonth: false, exceptionCodes: [] };

  const lease = exactLeaseForMonth(snapshot, tenancy.id, interval);
  // A fixed-term lease ending is not an actual move-out. Confirmed continuing
  // occupancy and an effective charge still support scheduled income; retain
  // the lease coverage issue separately instead of removing the resident.
  if (!lease.unknown && !actualMoveOut && isOccupiedTenancyOn(tenancy, interval.end)) {
    return { state: "current", partialMonth: moveIn > interval.start, exceptionCodes: lease.unknown || !lease.term ? ["lease_unknown"] : [] };
  }
  if (lease.unknown || !lease.term) return { state: "unknown", partialMonth: false, exceptionCodes: ["lease_unknown"] };
  return {
    state: tenancy.status === "past" ? "past" : "current",
    partialMonth: moveIn > interval.start || Boolean(actualMoveOut && actualMoveOut < interval.end),
    exceptionCodes,
  };
}

/** Projects one unit independently.  A contradictory/unknown tenancy only
 * makes that unit unknown; it never becomes a portfolio vacancy or throws a
 * global report error. */
export function projectFinancialOccupancy(
  snapshot: RentOpsSnapshot,
  unit: RentOpsUnit,
  month: IsoMonth,
  asOf?: IsoDate,
): FinancialOccupancyProjection {
  const interval = financialMonthInterval(month);
  const strictKnowledge = snapshot.modelVersion === 3;
  const candidates = snapshot.tenancies.filter((tenancy) => {
    if (tenancy.propertyId !== unit.propertyId) return false;
    // Matching property/unit identifiers are enough to locate the affected
    // unit even when the relationship evidence is unknown. The tenancy is
    // then classified as unknown below; filtering it here would falsely
    // advertise the unit as vacant.
    if (tenancy.unitId === unit.id) return true;
    // A tenancy linked to the property but lacking an exact unit link makes
    // the whole property's occupancy uncertain; it must not turn every unit
    // into a false vacancy.
    return isKnownLink(tenancy.propertyLinkKnowledge)
      && linkIsUnknown(tenancy.unitId, tenancy.unitLinkKnowledge, strictKnowledge);
  });
  const observed = candidates
    .map((tenancy) => ({ tenancy, projection: tenancyOccupiesMonth(snapshot, tenancy, interval, asOf ?? interval.end) }))
    .filter(({ projection }) => projection.state !== "excluded" && !(projection.state === "unknown" && hasVacancyConfirmationOn(unit, asOf ?? interval.end)));
  const unknown = observed.filter(({ projection }) => projection.state === "unknown");
  if (unknown.length > 0) {
    return { unitId: unit.id, propertyId: unit.propertyId, month, occupancy: "unknown", partialMonth: false, exceptionCodes: Array.from(new Set(unknown.flatMap(({ projection }) => projection.exceptionCodes))).sort() };
  }
  if (observed.length > 1) {
    return { unitId: unit.id, propertyId: unit.propertyId, month, occupancy: "unknown", partialMonth: false, exceptionCodes: ["simultaneous_tenancy_conflict"] };
  }
  const selected = observed[0];
  if (!selected) return { unitId: unit.id, propertyId: unit.propertyId, month, occupancy: "vacant", partialMonth: false, exceptionCodes: [] };
  return {
    unitId: unit.id,
    propertyId: unit.propertyId,
    month,
    occupancy: selected.projection.state === "excluded" ? "vacant" : selected.projection.state,
    tenancyId: selected.tenancy.id,
    personId: selected.tenancy.primaryPersonId,
    partialMonth: selected.projection.partialMonth,
    exceptionCodes: selected.projection.exceptionCodes,
  };
}

export interface EffectiveScheduleVersionResult {
  schedules: RentOpsRecurringChargeSchedule[];
  invalidSchedules: RentOpsRecurringChargeSchedule[];
  /** The version selected by lineage for the requested month.  This is the
   * immutable-lineage selection only; assignment, occupancy, and
   * property/unit precedence are applied by projectFinancialSchedules. */
  selectedSchedules: RentOpsRecurringChargeSchedule[];
  supersededSchedules: RentOpsRecurringChargeSchedule[];
  endedSchedules: RentOpsRecurringChargeSchedule[];
  inactiveSchedules: RentOpsRecurringChargeSchedule[];
  futureSchedules: RentOpsRecurringChargeSchedule[];
  classifications: Array<{
    schedule: RentOpsRecurringChargeSchedule;
    bucket: "selected" | "superseded" | "ended" | "inactive" | "future" | "invalid";
    reason?: string;
  }>;
  exceptionCodes: string[];
}

function scheduleRoot(schedule: RentOpsRecurringChargeSchedule, strictLineage = false): string {
  // The fallback is intentionally retained only for pre-v8/non-strict
  // snapshots.  A model-v3 row without an explicit root is invalid and is
  // never allowed to become a synthetic one-row lineage.
  return schedule.lineageRootId ?? (strictLineage ? "" : schedule.id);
}

type ScheduleVersionBucket = "selected" | "superseded" | "ended" | "inactive" | "future" | "invalid";

function isValidArtifactSha(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isKnownDateKnowledge(value: string | null | undefined): boolean {
  return value === "source" || value === "manual";
}

function isKnownLink(value: string | null | undefined): boolean {
  return value === "exact" || value === "manual";
}

function scheduleScopeIsKnown(schedule: RentOpsRecurringChargeSchedule): schedule is RentOpsRecurringChargeSchedule & { scopeType: "tenant" | "unit" | "property"; scopeId: string } {
  return schedule.scopeType !== null
    && schedule.scopeType !== undefined
    && schedule.scopeId !== null
    && schedule.scopeId !== undefined
    && factIsKnown(schedule.scopeTypeKnowledge, true)
    && isKnownLink(schedule.scopeLinkKnowledge);
}

function compareNullableDateDescending(left: string | null | undefined, right: string | null | undefined): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  return right.localeCompare(left);
}

/** v8 names the root action `root`.  The old `source` spelling is accepted
 * only by non-strict/legacy snapshots while the shared contract is rolling
 * forward; model-v3 never silently upgrades it. */
function lineageAction(schedule: RentOpsRecurringChargeSchedule, strictLineage: boolean): "root" | "replace" | "end" | undefined {
  const action = schedule.versionAction as string | undefined;
  if (action === "root") return "root";
  if (!strictLineage && action === "source") return "root";
  if (action === "replace" || action === "end") return action;
  return undefined;
}

/** Selects one immutable version per lineage for a month.  Source rows with
 * an unknown open start are not backdated; callers opt into observation-month
 * inclusion explicitly. */
export function resolveEffectiveScheduleVersions(
  schedules: readonly RentOpsRecurringChargeSchedule[],
  month: IsoMonth,
  options: { observationMonth?: IsoMonth; strictLineage?: boolean; effectiveAsOf?: IsoDate } = {},
): EffectiveScheduleVersionResult {
  const interval = financialMonthInterval(month);
  const selectionEnd = options.effectiveAsOf && options.effectiveAsOf < interval.end ? options.effectiveAsOf : interval.end;
  const exceptionCodes = new Set<string>();
  const strictLineage = options.strictLineage === true;
  const byRoot = new Map<string, RentOpsRecurringChargeSchedule[]>();
  const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  const invalidRoots = new Set<string>();
  const invalidIds = new Set<string>();
  const invalidReasons = new Map<string, Set<string>>();

  const addInvalid = (schedule: RentOpsRecurringChargeSchedule | undefined, code: string, rootOverride?: string): void => {
    if (schedule) invalidIds.add(schedule.id);
    const root = rootOverride ?? (schedule ? scheduleRoot(schedule, strictLineage) : "");
    if (root) invalidRoots.add(root);
    const key = schedule?.id ?? root;
    if (key) {
      const reasons = invalidReasons.get(key) ?? new Set<string>();
      reasons.add(code);
      invalidReasons.set(key, reasons);
    }
    exceptionCodes.add(code);
  };

  // A duplicate source id cannot be safely selected.  Keep every row visible
  // to the caller, but isolate the id as an invalid lineage.
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const schedule of schedules) {
    if (seenIds.has(schedule.id)) duplicateIds.add(schedule.id);
    seenIds.add(schedule.id);
  }
  for (const schedule of schedules) {
    const root = scheduleRoot(schedule, strictLineage);
    const rows = byRoot.get(root) ?? [];
    rows.push(schedule);
    byRoot.set(root, rows);
    if (duplicateIds.has(schedule.id)) addInvalid(schedule, "schedule_lineage_duplicate_id", root || `invalid:${schedule.id}`);
  }

  // Strict model-v3 rules require all three lineage identity fields.  This is
  // deliberately checked before any fallback logic so a malformed imported
  // row cannot be treated as an ordinary one-row source schedule.
  for (const schedule of schedules) {
    const root = scheduleRoot(schedule, strictLineage);
    const action = lineageAction(schedule, strictLineage);
    const origin = schedule.lineageRootOrigin;
    const hasSourceSystem = Boolean(schedule.source?.system);
    const hasSourceId = Boolean(schedule.source?.sourceId);
    const hasCompleteSourcePair = hasSourceSystem && hasSourceId;
    const hasAnySource = hasSourceSystem || hasSourceId;
    if (strictLineage && (!schedule.lineageRootId || !action || !origin)) {
      addInvalid(schedule, "schedule_lineage_root_or_action_missing", root || `invalid:${schedule.id}`);
      continue;
    }
    if (strictLineage && hasSourceSystem !== hasSourceId) {
      addInvalid(schedule, "schedule_lineage_version_provenance_invalid", root || `invalid:${schedule.id}`);
    }
    const effectiveAction = action ?? (!strictLineage && !schedule.versionAction ? "root" : undefined);
    if (effectiveAction !== "root" && effectiveAction !== "replace" && effectiveAction !== "end") {
      addInvalid(schedule, "schedule_lineage_action_unknown", root || `invalid:${schedule.id}`);
      continue;
    }
    if (strictLineage && (origin !== "artifact" && origin !== "manual")) {
      addInvalid(schedule, "schedule_lineage_origin_unknown", root || `invalid:${schedule.id}`);
      continue;
    }
    if (effectiveAction === "root") {
      if ((strictLineage && (!schedule.lineageRootId || schedule.lineageRootId !== schedule.id)) || schedule.supersedesId || (schedule.lineageRootId && schedule.lineageRootId !== schedule.id)) {
        addInvalid(schedule, "schedule_lineage_root_mismatch", root || `invalid:${schedule.id}`);
      }
      if (strictLineage) {
        if (origin === "artifact") {
          if (schedule.versionOrigin !== "artifact" || !hasCompleteSourcePair) addInvalid(schedule, "schedule_lineage_version_provenance_invalid", root || `invalid:${schedule.id}`);
          if (!isValidArtifactSha(schedule.sourceArtifactSha256) || !schedule.artifactObservationOn) addInvalid(schedule, "schedule_lineage_artifact_binding_missing", root || `invalid:${schedule.id}`);
          if (schedule.effectiveFrom === null || schedule.effectiveFrom === undefined) {
            if (schedule.effectiveFromKnowledge !== "unknown_open_start") addInvalid(schedule, "schedule_lineage_open_start_invalid", root || `invalid:${schedule.id}`);
          } else if (schedule.effectiveFromKnowledge !== "source") {
            addInvalid(schedule, "schedule_lineage_effective_from_knowledge_invalid", root || `invalid:${schedule.id}`);
          }
        } else if (origin === "manual") {
          if (schedule.versionOrigin !== "manual" || hasAnySource) addInvalid(schedule, "schedule_lineage_version_provenance_invalid", root || `invalid:${schedule.id}`);
          if (schedule.sourceArtifactSha256 != null || schedule.artifactObservationOn != null) addInvalid(schedule, "schedule_lineage_manual_artifact_mismatch", root || `invalid:${schedule.id}`);
          if (schedule.effectiveFrom === null || schedule.effectiveFrom === undefined) {
            addInvalid(schedule, "schedule_lineage_manual_date_required", root || `invalid:${schedule.id}`);
          } else if (schedule.effectiveFromKnowledge !== "manual") {
            addInvalid(schedule, "schedule_lineage_manual_date_required", root || `invalid:${schedule.id}`);
          }
        }
      }
    } else {
      if (strictLineage && (!schedule.supersedesId || !schedule.effectiveFrom || !isKnownDateKnowledge(schedule.effectiveFromKnowledge))) {
        addInvalid(schedule, "schedule_lineage_successor_required", root || `invalid:${schedule.id}`);
      }
      if (strictLineage && (schedule.versionOrigin !== "manual" || hasAnySource || schedule.effectiveFromKnowledge !== "manual")) {
        addInvalid(schedule, "schedule_lineage_version_provenance_invalid", root || `invalid:${schedule.id}`);
      }
      if (strictLineage && effectiveAction === "replace" && (typeof schedule.amountCents !== "number" || schedule.amountCents <= 0 || schedule.amountKnowledge !== "known")) {
        addInvalid(schedule, "schedule_lineage_replace_amount_invalid", root || `invalid:${schedule.id}`);
      }
      if (strictLineage && effectiveAction === "end" && (schedule.amountCents !== null || schedule.amountKnowledge !== "unknown")) {
        addInvalid(schedule, "schedule_lineage_end_amount_nonnull", root || `invalid:${schedule.id}`);
      }
      if (schedule.supersedesId === schedule.id) addInvalid(schedule, "schedule_lineage_cycle", root || `invalid:${schedule.id}`);
    }
  }

  const inheritedFields = [
    "scopeType", "scopeId", "scopeTypeKnowledge", "scopeLinkKnowledge",
    "chargeDefinitionId", "chargeDefinitionKey", "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge",
    "tenancyId", "personId", "propertyId", "unitId", "category", "categoryKnowledge",
    "description", "descriptionKnowledge", "sourceConfidence", "lineageRootId", "lineageRootOrigin",
    "sourceArtifactSha256", "artifactObservationOn",
  ] as const;
  const sameInheritedFacts = (left: RentOpsRecurringChargeSchedule, right: RentOpsRecurringChargeSchedule): boolean => inheritedFields.every((field) => left[field] === right[field]);

  // Validate every successor against both its predecessor and the explicit
  // root.  Artifact identity/observation are a continuity boundary, not
  // descriptive metadata; a changed boundary invalidates the whole lineage.
  for (const schedule of schedules) {
    const action = lineageAction(schedule, strictLineage);
    if (action !== "replace" && action !== "end") continue;
    const root = scheduleRoot(schedule, strictLineage);
    const predecessor = schedule.supersedesId ? byId.get(schedule.supersedesId) : undefined;
    const rootSchedule = root ? byId.get(root) : undefined;
    if (!predecessor) {
      addInvalid(schedule, "schedule_lineage_predecessor_missing", root || `invalid:${schedule.id}`);
      continue;
    }
    if (!rootSchedule || lineageAction(rootSchedule, strictLineage) !== "root" || scheduleRoot(rootSchedule, strictLineage) !== root) {
      addInvalid(schedule, "schedule_lineage_root_missing", root || `invalid:${schedule.id}`);
    }
    if (scheduleRoot(predecessor, strictLineage) !== root) {
      addInvalid(schedule, "schedule_lineage_root_mismatch", root || `invalid:${schedule.id}`);
      addInvalid(predecessor, "schedule_lineage_root_mismatch");
    }
    // `end` is a terminal tombstone.  Allowing either a replacement or a
    // second end after it would silently resurrect a closed obligation.
    if (lineageAction(predecessor, strictLineage) === "end") {
      addInvalid(schedule, "schedule_lineage_end_terminal", root || `invalid:${schedule.id}`);
      addInvalid(predecessor, "schedule_lineage_end_terminal");
    }
    if (strictLineage && rootSchedule && schedule.lineageRootOrigin !== rootSchedule.lineageRootOrigin) {
      addInvalid(schedule, "schedule_lineage_origin_mismatch", root || `invalid:${schedule.id}`);
    }
    const expectedOrigin = rootSchedule?.lineageRootOrigin;
    if (strictLineage && expectedOrigin === "artifact") {
      if (!isValidArtifactSha(rootSchedule?.sourceArtifactSha256) || !rootSchedule?.artifactObservationOn) addInvalid(schedule, "schedule_lineage_artifact_binding_missing", root || `invalid:${schedule.id}`);
      if (schedule.sourceArtifactSha256 !== rootSchedule?.sourceArtifactSha256 || schedule.artifactObservationOn !== rootSchedule?.artifactObservationOn || schedule.sourceArtifactSha256 !== predecessor.sourceArtifactSha256 || schedule.artifactObservationOn !== predecessor.artifactObservationOn) {
        addInvalid(schedule, "schedule_lineage_artifact_boundary_mismatch", root || `invalid:${schedule.id}`);
      }
    } else if (strictLineage && expectedOrigin === "manual") {
      if (schedule.sourceArtifactSha256 != null || schedule.artifactObservationOn != null || predecessor.sourceArtifactSha256 != null || predecessor.artifactObservationOn != null) addInvalid(schedule, "schedule_lineage_manual_artifact_mismatch", root || `invalid:${schedule.id}`);
      if (schedule.effectiveFromKnowledge !== "manual") addInvalid(schedule, "schedule_lineage_manual_date_required", root || `invalid:${schedule.id}`);
    }
    const predecessorBoundaryValid = predecessor.effectiveFrom
      ? Boolean(schedule.effectiveFrom && (schedule.effectiveFrom > predecessor.effectiveFrom || (action === "end" && schedule.effectiveFrom === predecessor.effectiveFrom && (expectedOrigin !== "artifact" || !!rootSchedule?.artifactObservationOn && schedule.effectiveFrom >= rootSchedule.artifactObservationOn))) && (!predecessor.effectiveTo || schedule.effectiveFrom <= predecessor.effectiveTo) && isKnownDateKnowledge(schedule.effectiveFromKnowledge))
      : predecessor.effectiveFromKnowledge === "unknown_open_start"
        && Boolean(rootSchedule?.artifactObservationOn && schedule.effectiveFrom && schedule.effectiveFrom >= rootSchedule.artifactObservationOn)
        && isKnownDateKnowledge(schedule.effectiveFromKnowledge)
        && expectedOrigin === "artifact";
    if (!predecessorBoundaryValid) addInvalid(schedule, "schedule_lineage_boundary_invalid", root || `invalid:${schedule.id}`);
    const actionFactsValid = action === "replace"
      ? schedule.active === predecessor.active
        && schedule.activeKnowledge === predecessor.activeKnowledge
        && schedule.effectiveTo === predecessor.effectiveTo
      : schedule.active === false
        && schedule.activeKnowledge === "manual"
        && schedule.effectiveTo === schedule.effectiveFrom;
    if (!sameInheritedFacts(schedule, predecessor) || !actionFactsValid) {
      addInvalid(schedule, "schedule_lineage_inherited_fact_mutation", root || `invalid:${schedule.id}`);
      addInvalid(predecessor, "schedule_lineage_inherited_fact_mutation");
    }
  }

  // Branching and cycles are invalid at the lineage level.  The source
  // predecessor may have only one successor in the immutable model.
  const successorsByPredecessor = new Map<string, RentOpsRecurringChargeSchedule[]>();
  for (const schedule of schedules) {
    if (!schedule.supersedesId) continue;
    const successors = successorsByPredecessor.get(schedule.supersedesId) ?? [];
    successors.push(schedule);
    successorsByPredecessor.set(schedule.supersedesId, successors);
  }
  for (const [predecessorId, successors] of Array.from(successorsByPredecessor.entries())) {
    if (successors.length <= 1) continue;
    exceptionCodes.add("schedule_lineage_branch");
    const predecessor = byId.get(predecessorId);
    addInvalid(predecessor, "schedule_lineage_branch");
    for (const successor of successors) addInvalid(successor, "schedule_lineage_branch");
  }
  for (const schedule of schedules) {
    const seen = new Set<string>();
    let cursor: RentOpsRecurringChargeSchedule | undefined = schedule;
    while (cursor?.supersedesId) {
      if (seen.has(cursor.id)) {
        for (const id of Array.from(seen)) addInvalid(byId.get(id), "schedule_lineage_cycle");
        addInvalid(schedule, "schedule_lineage_cycle");
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.supersedesId);
      if (!cursor) {
        addInvalid(schedule, "schedule_lineage_predecessor_missing");
        break;
      }
    }
  }
  for (const schedule of schedules) {
    const root = scheduleRoot(schedule, strictLineage);
    if (invalidIds.has(schedule.id) && root) invalidRoots.add(root);
  }
  for (const id of Array.from(invalidIds)) {
    const schedule = byId.get(id);
    if (schedule) invalidRoots.add(scheduleRoot(schedule, strictLineage));
  }
  const selected: RentOpsRecurringChargeSchedule[] = [];
  const superseded: RentOpsRecurringChargeSchedule[] = [];
  const ended: RentOpsRecurringChargeSchedule[] = [];
  const inactive: RentOpsRecurringChargeSchedule[] = [];
  const future: RentOpsRecurringChargeSchedule[] = [];
  const classifications = new Map<string, { schedule: RentOpsRecurringChargeSchedule; bucket: ScheduleVersionBucket; reason?: string }>();
  const putClassification = (schedule: RentOpsRecurringChargeSchedule, bucket: ScheduleVersionBucket, reason?: string): void => {
    classifications.set(schedule.id, { schedule, bucket, reason });
  };

  for (const rows of Array.from(byRoot.values())) {
    const root = scheduleRoot(rows[0], strictLineage);
    if (!root || invalidRoots.has(root) || rows.some((row) => invalidRoots.has(scheduleRoot(row, strictLineage)))) {
      for (const schedule of rows) putClassification(schedule, "invalid", "schedule_lineage_invalid");
      continue;
    }
    const startDates = rows
      .filter((schedule): schedule is RentOpsRecurringChargeSchedule & { effectiveFrom: IsoDate } => schedule.effectiveFrom !== null && schedule.effectiveFrom !== undefined)
      .map((schedule) => schedule.effectiveFrom);
    const duplicateStart = startDates.some(date => {
      const sameDate = rows.filter(schedule => schedule.effectiveFrom === date);
      if (sameDate.length < 2) return false;
      // A terminal END at its direct predecessor start creates an empty
      // active interval. No replacement or unrelated same-date pair is legal.
      return sameDate.length !== 2 || !sameDate.some(end => lineageAction(end, strictLineage) === "end"
        && sameDate.some(predecessor => predecessor.id === end.supersedesId && predecessor.id !== end.id));
    });
    if (duplicateStart) {
      exceptionCodes.add("schedule_lineage_same_date_conflict");
      invalidRoots.add(root);
      for (const schedule of rows) putClassification(schedule, "invalid", "schedule_lineage_same_date_conflict");
      continue;
    }
    const applicable = rows.filter((schedule) => {
      if (schedule.effectiveFrom === null || schedule.effectiveFrom === undefined) {
        const observationBoundary = strictLineage && schedule.lineageRootOrigin === "artifact" && schedule.artifactObservationOn
          ? schedule.artifactObservationOn.slice(0, 7) as IsoMonth
          : options.observationMonth;
        if (schedule.effectiveFromKnowledge === "unknown_open_start" && observationBoundary && month >= observationBoundary
          && (!options.effectiveAsOf || !schedule.artifactObservationOn || schedule.artifactObservationOn <= selectionEnd)) return true;
        return false;
      }
      // Choose the latest lineage version whose start has taken effect before
      // applying that winner's end/action state. Filtering each version by
      // effectiveTo here would discard an end tombstone in later months and
      // incorrectly resurrect its predecessor.
      return schedule.effectiveFrom <= selectionEnd;
    }).sort((left, right) => compareNullableDateDescending(left.effectiveFrom, right.effectiveFrom) || (right.recordRevision ?? 0) - (left.recordRevision ?? 0) || right.id.localeCompare(left.id));
    const winner = applicable[0];
    if (!winner) {
      for (const schedule of rows) {
        if (schedule.effectiveFrom && schedule.effectiveFrom > selectionEnd) putClassification(schedule, "future", "schedule_effective_in_future");
        else if (!schedule.effectiveFrom && schedule.effectiveFromKnowledge === "unknown_open_start") putClassification(schedule, "future", "schedule_open_start_not_observed");
        else if (schedule.active === false) putClassification(schedule, "inactive", "schedule_inactive");
        else putClassification(schedule, "ended", "schedule_ended");
      }
      continue;
    }
    for (const schedule of rows) {
      if (schedule.id === winner.id) continue;
      if (schedule.effectiveFrom && schedule.effectiveFrom > selectionEnd) putClassification(schedule, "future", "schedule_effective_in_future");
      else if (schedule.effectiveFrom && winner.effectiveFrom && schedule.effectiveFrom < winner.effectiveFrom) putClassification(schedule, "superseded", "schedule_superseded");
      else if (!schedule.effectiveFrom && winner.effectiveFrom) putClassification(schedule, "superseded", "schedule_superseded");
      else putClassification(schedule, "superseded", "schedule_superseded");
    }
    if (lineageAction(winner, strictLineage) === "end" || (winner.effectiveTo !== null && winner.effectiveTo !== undefined && winner.effectiveTo < (options.effectiveAsOf ? selectionEnd : interval.start))) {
      putClassification(winner, "ended", "schedule_ended");
      ended.push(winner);
    } else if (winner.active === false) {
      putClassification(winner, "inactive", "schedule_inactive");
      inactive.push(winner);
    } else {
      putClassification(winner, "selected");
      selected.push(winner);
    }
  }
  for (const schedule of schedules) {
    if (!classifications.has(schedule.id)) {
      putClassification(schedule, invalidIds.has(schedule.id) ? "invalid" : "superseded", invalidIds.has(schedule.id) ? "schedule_lineage_invalid" : "schedule_superseded");
    }
  }
  for (const value of Array.from(classifications.values())) {
    if (value.bucket === "superseded") superseded.push(value.schedule);
    if (value.bucket === "future") future.push(value.schedule);
  }
  const invalidSchedules = schedules.filter((schedule) => classifications.get(schedule.id)?.bucket === "invalid");
  const classificationList = schedules.map((schedule) => classifications.get(schedule.id)!).filter(Boolean);
  return {
    schedules: selected,
    selectedSchedules: selected,
    supersededSchedules: superseded,
    endedSchedules: ended,
    inactiveSchedules: inactive,
    futureSchedules: future,
    invalidSchedules,
    classifications: classificationList,
    exceptionCodes: Array.from(exceptionCodes).sort(),
  };
}

export interface FinancialScheduleProjection {
  rows: ScheduledIncomeRow[];
  /** Every recurring-schedule version that passed the caller's property/unit
   * filter.  This includes old versions and non-billable outcomes. */
  sourceRowCount: number;
  inputRowCount: number;
  accountedRowCount: number;
  selectedRowCount: number;
  emittedRowCount: number;
  emittedKnownRowCount: number;
  emittedUncertainRowCount: number;
  /** Cents in the exclusive emitted-uncertain bucket.  This deliberately
   * excludes the separately reported unassigned and invalid buckets. */
  emittedUncertainCents: Cents;
  knownRowCount: number;
  uncertainRowCount: number;
  knownCents: Cents;
  uncertainCents: Cents;
  unassignedCents: Cents;
  unknownAmountCount: number;
  invalidLineageCount: number;
  invalidLineageCents: Cents;
  supersededCount: number;
  supersededCents: Cents;
  endedCount: number;
  endedCents: Cents;
  inactiveCount: number;
  inactiveCents: Cents;
  futureCount: number;
  futureCents: Cents;
  propertyOnceCount: number;
  suppressedByPrecedenceCount: number;
  suppressedByPrecedenceCents: Cents;
  notApplicableCount: number;
  notApplicableCents: Cents;
  unassignedRowCount: number;
  exceptionCodes: string[];
}

function definitionKey(schedule: RentOpsRecurringChargeSchedule): string {
  // A source ChargeTypeKey is not a target identity and must never be used
  // for grouping or emitted in a positive report. Unknown definitions stay
  // distinct by immutable schedule identity.
  if (schedule.chargeDefinitionId && (schedule.chargeDefinitionLinkKnowledge === "exact" || schedule.chargeDefinitionLinkKnowledge === "manual")) return schedule.chargeDefinitionId;
  return `unknown:${schedule.id}`;
}

function scopeRank(schedule: RentOpsRecurringChargeSchedule): number {
  if (!scheduleScopeIsKnown(schedule)) return 0;
  return schedule.scopeType === "tenant" ? (schedule.tenancyId ? 4 : 3) : schedule.scopeType === "unit" ? 2 : schedule.scopeType === "property" ? 1 : 0;
}

/**
 * Month-effective schedule projection. It deliberately emits nullable rows
 * for unknown amount/category/link facts so conservation controls can account
 * for every source row without manufacturing zeroes.
 */
export function projectFinancialSchedules(
  snapshot: RentOpsSnapshot,
  month: IsoMonth,
  options: { observationMonth?: IsoMonth; propertyId?: string; unitId?: string; asOfDate?: IsoDate; selection?: "as_of" | "month_forecast" } = {},
): FinancialScheduleProjection {
  const interval = financialMonthInterval(month);
  const strictKnowledge = snapshot.modelVersion === 3;
  const units = snapshot.units.filter((unit) => (!options.propertyId || unit.propertyId === options.propertyId) && (!options.unitId || unit.id === options.unitId));
  const allOccupancy = new Map(snapshot.units.map((unit) => [unit.id, projectFinancialOccupancy(snapshot, unit, month, options.asOfDate)]));
  const occupancy = new Map(units.map((unit) => [unit.id, allOccupancy.get(unit.id)!]));
  const amountPresent = (schedule: RentOpsRecurringChargeSchedule): schedule is RentOpsRecurringChargeSchedule & { amountCents: Cents } => typeof schedule.amountCents === "number" && Number.isSafeInteger(schedule.amountCents);

  interface CanonicalScopeResolution {
    propertyId?: string;
    unit?: RentOpsUnit;
    tenancy?: RentOpsTenancy;
    personId?: string;
    code?: string;
  }

  /** scopeType + scopeId is the authoritative owner identity.  Convenience
   * copies such as unitId/personId may corroborate it, but can never replace
   * or contradict it. */
  const canonicalScope = (schedule: RentOpsRecurringChargeSchedule): CanonicalScopeResolution => {
    if (!scheduleScopeIsKnown(schedule)) return { code: "schedule_scope_id_unknown" };
    if (schedule.propertyId === null) return { code: "schedule_property_link_unknown" };
    if (schedule.scopeType === "property") {
      const property = snapshot.properties.find((candidate) => candidate.id === schedule.scopeId);
      if (!property || schedule.propertyId !== property.id || schedule.unitId != null || schedule.tenancyId != null || schedule.personId != null) return { code: "schedule_property_scope_conflict" };
      return { propertyId: property.id };
    }
    if (schedule.scopeType === "unit") {
      const unit = snapshot.units.find((candidate) => candidate.id === schedule.scopeId);
      if (!unit || unit.propertyId !== schedule.propertyId || (schedule.unitId != null && schedule.unitId !== unit.id) || schedule.tenancyId != null || schedule.personId != null) return { code: "schedule_unit_scope_conflict" };
      return { propertyId: unit.propertyId, unit };
    }
    if (schedule.scopeType !== "tenant") return { code: "schedule_scope_id_unknown" };
    const person = snapshot.people.find((candidate) => candidate.id === schedule.scopeId);
    if (!person || (schedule.personId != null && schedule.personId !== person.id)) return { code: "schedule_tenant_scope_conflict" };
    if (schedule.tenancyId) {
      const tenancy = snapshot.tenancies.find((candidate) => candidate.id === schedule.tenancyId);
      if (!tenancy || tenancy.primaryPersonId !== person.id || tenancy.propertyId !== schedule.propertyId || !tenancy.unitId) return { code: "schedule_tenancy_link_unknown" };
      if (strictKnowledge && (!isKnownLink(tenancy.propertyLinkKnowledge) || !isKnownLink(tenancy.unitLinkKnowledge) || !isKnownLink(tenancy.primaryPersonLinkKnowledge))) return { code: "schedule_tenancy_link_unknown" };
      const unit = snapshot.units.find((candidate) => candidate.id === tenancy.unitId && candidate.propertyId === tenancy.propertyId);
      if (!unit || (schedule.unitId != null && schedule.unitId !== unit.id)) return { code: "schedule_tenancy_scope_conflict" };
      return { propertyId: tenancy.propertyId, unit, tenancy, personId: person.id };
    }
    const candidates = snapshot.units.filter((unit) => {
      if (unit.propertyId !== schedule.propertyId || (schedule.unitId != null && schedule.unitId !== unit.id)) return false;
      const projected = allOccupancy.get(unit.id);
      return projected?.personId === person.id && projected.occupancy !== "vacant" && projected.occupancy !== "unknown";
    });
    if (candidates.length !== 1) return { code: "schedule_person_assignment_ambiguous" };
    return { propertyId: schedule.propertyId, unit: candidates[0], personId: person.id };
  };

  const scopeEvidenceKnown = (schedule: RentOpsRecurringChargeSchedule): boolean => scheduleScopeIsKnown(schedule);

  /** Unit-scoped reports are deliberately narrower than property reports:
   * property obligations and unresolved tenant/person assignments must not be
   * repeated once per unit. */
  const scheduleInFilter = (schedule: RentOpsRecurringChargeSchedule): boolean => {
    if (options.propertyId && schedule.propertyId !== options.propertyId) return false;
    if (!options.unitId) return true;
    if (schedule.scopeType === "property" || !scopeEvidenceKnown(schedule)) return false;
    const resolved = canonicalScope(schedule);
    return Boolean(!resolved.code && resolved.unit?.id === options.unitId && (schedule.scopeType === "unit" || schedule.scopeType === "tenant"));
  };

  const filteredInput = snapshot.recurringSchedules.filter(scheduleInFilter);
  // An as-of dashboard must not see a later correction or termination in the
  // same month. Explicit month forecasts retain whole-month version selection.
  const versioned = resolveEffectiveScheduleVersions(filteredInput, month, { ...options, strictLineage: strictKnowledge,
    effectiveAsOf: options.selection === "month_forecast" ? undefined : options.asOfDate });
  const classificationById = new Map(versioned.classifications.map((item) => [item.schedule.id, item]));
  type ProjectionBucket = "selected" | "emitted_known" | "emitted_uncertain" | "unassigned" | "invalid" | "superseded" | "ended" | "inactive" | "future" | "not_applicable" | "suppressed";
  const bucketById = new Map<string, ProjectionBucket>();
  for (const item of versioned.classifications) bucketById.set(item.schedule.id, item.bucket);
  const rows: ScheduledIncomeRow[] = [];
  const exceptions = new Set(versioned.exceptionCodes);
  const candidatesByDefinitionUnit = new Map<string, RentOpsRecurringChargeSchedule[]>();
  const propertySchedules = new Map<string, RentOpsRecurringChargeSchedule[]>();
  const unassignedSchedules: Array<{ schedule: RentOpsRecurringChargeSchedule; code: string }> = [];
  const notApplicableSchedules: Array<{ schedule: RentOpsRecurringChargeSchedule; code: string }> = [];
  let propertyOnceCount = 0;

  // Count unknown amounts once over the filtered input.  This is a diagnostic
  // about source completeness, never an additional conservation bucket.
  const unknownAmountCount = filteredInput.filter((schedule) => !amountPresent(schedule)).length;
  const amountFactKnown = (schedule: RentOpsRecurringChargeSchedule): boolean => amountPresent(schedule) && (!strictKnowledge || schedule.amountKnowledge === "known");

  const makeRow = (schedule: RentOpsRecurringChargeSchedule, input: { unit?: RentOpsUnit; occupancy?: FinancialOccupancyProjection; extraCodes?: string[]; unassigned?: boolean }): ScheduledIncomeRow => {
    const property = schedule.propertyId === null ? undefined : snapshot.properties.find((candidate) => candidate.id === schedule.propertyId);
    const person = input.occupancy?.personId ? snapshot.people.find((candidate) => candidate.id === input.occupancy?.personId) : undefined;
    const knownMoney = amountPresent(schedule);
    const amountKnownByEvidence = amountFactKnown(schedule);
    const occupancyUnknown = input.occupancy?.occupancy === "unknown";
    const categoryKnownByEvidence = schedule.category !== null && schedule.category !== undefined && factIsKnown(schedule.categoryKnowledge, strictKnowledge);
    const activeKnownByEvidence = schedule.active === true && factIsKnown(schedule.activeKnowledge, strictKnowledge);
    const definitionKnownByEvidence = !strictKnowledge || Boolean(schedule.chargeDefinitionId && isKnownLink(schedule.chargeDefinitionLinkKnowledge));
    const scopeKnownByEvidence = scopeEvidenceKnown(schedule) && !canonicalScope(schedule).code;
    const temporalKnownByEvidence = !strictKnowledge || isKnownDateKnowledge(schedule.effectiveFromKnowledge);
    const cadenceKnown = schedule.billingFrequency === "monthly";
    const uncertain = !cadenceKnown || !knownMoney || !amountKnownByEvidence || !categoryKnownByEvidence || !activeKnownByEvidence || !definitionKnownByEvidence || !scopeKnownByEvidence || !temporalKnownByEvidence || occupancyUnknown || Boolean(input.unassigned);
    const codes = [
      ...(input.occupancy?.exceptionCodes ?? []),
      ...(input.extraCodes ?? []),
      ...(knownMoney ? [] : ["amount_unknown"]),
      ...(cadenceKnown ? [] : ["schedule_cadence_unknown"]),
      ...(schedule.category === null || schedule.category === undefined ? ["charge_category_unknown"] : []),
      ...(schedule.active === true ? [] : ["active_unknown"]),
      ...(!scopeKnownByEvidence ? ["schedule_scope_unknown"] : []),
      ...(input.unassigned ? ["schedule_unassigned"] : []),
    ];
    return {
      propertyId: schedule.propertyId,
      propertyName: property?.name ?? null,
      ...(input.unit ? { unitId: input.unit.id, unitNumber: input.unit.unitNumber } : {}),
      ...(input.occupancy?.tenancyId ? { tenancyId: input.occupancy.tenancyId } : {}),
      ...(input.occupancy?.personId ? { personId: input.occupancy.personId, tenantName: person ? `${person.firstName} ${person.lastName}`.trim() : undefined } : {}),
      month,
      category: schedule.category === undefined ? null : schedule.category,
      // Description is presentation metadata, not charge identity.  Keep a
      // missing description null so a report cannot silently turn an unknown
      // source fact into a fabricated label.
      description: schedule.description === undefined ? null : schedule.description,
      amountCents: knownMoney ? schedule.amountCents : null,
      scheduleId: schedule.id,
      scopeType: schedule.scopeType,
      chargeDefinitionId: schedule.chargeDefinitionId,
      // Never copy chargeDefinitionKey: it may be a raw RM key.
      effectiveFromKnowledge: schedule.effectiveFromKnowledge,
      temporalUncertainty: Boolean(!cadenceKnown || schedule.effectiveFromKnowledge === "unknown_open_start" || occupancyUnknown || schedule.active !== true),
      // Preserve an explicit null knowledge fact. Legacy rows that omitted
      // the marker are normalized only at this report boundary.
      amountKnowledge: schedule.amountKnowledge === undefined ? (amountKnownByEvidence ? "known" : "unknown") : schedule.amountKnowledge,
      categoryKnowledge: schedule.categoryKnowledge,
      chargeDefinitionLinkKnowledge: schedule.chargeDefinitionLinkKnowledge,
      known: !uncertain,
      uncertain,
      unclassified: schedule.category === null || schedule.category === undefined,
      exceptionCodes: Array.from(new Set(codes)).sort(),
    };
  };

  const mark = (schedule: RentOpsRecurringChargeSchedule, bucket: ProjectionBucket): void => {
    bucketById.set(schedule.id, bucket);
  };

  const pushUnassigned = (schedule: RentOpsRecurringChargeSchedule, code: string): void => {
    unassignedSchedules.push({ schedule, code });
  };

  // Invalid lineage is retained as a single uncertain diagnostic row per
  // source version, never re-projected into units.
  for (const schedule of versioned.invalidSchedules) {
    exceptions.add("schedule_lineage_invalid");
    const row = makeRow(schedule, { extraCodes: ["schedule_lineage_invalid"], unassigned: true });
    rows.push(row);
    mark(schedule, "invalid");
  }

  for (const schedule of versioned.selectedSchedules.filter(scheduleInFilter)) {
    if (schedule.category === null || schedule.category === undefined) exceptions.add("charge_category_unknown");
    const scopeKnown = scopeEvidenceKnown(schedule);
    if (!scopeKnown) {
      pushUnassigned(schedule, "schedule_scope_unknown");
      continue;
    }
    const resolvedScope = canonicalScope(schedule);
    if (resolvedScope.code) {
      pushUnassigned(schedule, resolvedScope.code);
      continue;
    }
    if (schedule.scopeType === "property") {
      const key = `${schedule.propertyId}\u0000${definitionKey(schedule)}`;
      const property = propertySchedules.get(key) ?? [];
      property.push(schedule);
      propertySchedules.set(key, property);
      continue;
    }
    if (schedule.scopeType !== "tenant" && schedule.scopeType !== "unit") {
      pushUnassigned(schedule, "schedule_scope_unknown");
      continue;
    }
    const targetUnits = resolvedScope.unit && units.some((unit) => unit.id === resolvedScope.unit?.id) ? [resolvedScope.unit] : [];
    if (targetUnits.length === 0) {
      pushUnassigned(schedule, "schedule_unit_link_unknown");
      continue;
    }
    let matched = false;
    for (const unit of targetUnits) {
      const occ = occupancy.get(unit.id);
      if (!occ) {
        pushUnassigned(schedule, "schedule_unit_link_unknown");
        continue;
      }
      if (occ.occupancy === "vacant") {
        notApplicableSchedules.push({ schedule, code: "schedule_not_applicable_vacant" });
        matched = true;
        continue;
      }
      if (schedule.scopeType === "tenant" && schedule.tenancyId && occ.tenancyId !== schedule.tenancyId) {
        notApplicableSchedules.push({ schedule, code: "schedule_not_applicable_other_tenancy" });
        matched = true;
        continue;
      }
      const key = `${unit.id}\u0000${definitionKey(schedule)}`;
      const candidates = candidatesByDefinitionUnit.get(key) ?? [];
      candidates.push(schedule);
      candidatesByDefinitionUnit.set(key, candidates);
      matched = true;
    }
    if (!matched) pushUnassigned(schedule, "schedule_occupancy_unknown");
  }

  const recordEmitted = (schedule: RentOpsRecurringChargeSchedule, row: ScheduledIncomeRow, unassigned = false, invalid = false): void => {
    if (invalid) mark(schedule, "invalid");
    else if (unassigned) mark(schedule, "unassigned");
    else mark(schedule, row.known === true ? "emitted_known" : "emitted_uncertain");
  };

  for (const [key, candidates] of Array.from(candidatesByDefinitionUnit.entries())) {
    const unitId = key.split("\u0000", 1)[0];
    const unit = units.find((candidate) => candidate.id === unitId);
    if (!unit) {
      for (const candidate of candidates) pushUnassigned(candidate, "schedule_unit_link_unknown");
      continue;
    }
    const occ = occupancy.get(unit.id);
    if (!occ) {
      for (const candidate of candidates) pushUnassigned(candidate, "schedule_occupancy_unknown");
      continue;
    }
    const highestRank = Math.max(...candidates.map(scopeRank));
    const winners = candidates.filter((candidate) => scopeRank(candidate) === highestRank);
    const chosen = winners.length === 1 ? winners[0] : undefined;
    if (!chosen) {
      exceptions.add("schedule_precedence_conflict");
      for (const candidate of candidates) pushUnassigned(candidate, "schedule_precedence_conflict");
      continue;
    }
    const row = makeRow(chosen, { unit, occupancy: occ, extraCodes: occ.occupancy === "unknown" ? ["schedule_occupancy_unknown"] : [] });
    rows.push(row);
    recordEmitted(chosen, row);
    for (const candidate of candidates) {
      if (candidate.id === chosen.id) continue;
      mark(candidate, "suppressed");
      exceptions.add("schedule_precedence_suppressed");
    }
  }

  for (const [key, schedulesForProperty] of Array.from(propertySchedules.entries())) {
    if (schedulesForProperty.length > 1) {
      exceptions.add("property_schedule_duplicate_conflict");
      for (const schedule of schedulesForProperty) pushUnassigned(schedule, "property_schedule_duplicate_conflict");
      continue;
    }
    const schedule = schedulesForProperty[0];
    const row = makeRow(schedule, {});
    rows.push(row);
    propertyOnceCount += 1;
    propertySchedules.delete(key);
    recordEmitted(schedule, row);
  }

  for (const { schedule, code } of unassignedSchedules) {
    // A schedule can only arrive here once; the guard keeps a future mapper
    // change from duplicating a diagnostic row and breaking conservation.
    if (bucketById.get(schedule.id) === "unassigned" || bucketById.get(schedule.id) === "invalid") continue;
    exceptions.add(code);
    const row = makeRow(schedule, { extraCodes: [code], unassigned: true });
    rows.push(row);
    recordEmitted(schedule, row, true);
  }
  for (const { schedule, code } of notApplicableSchedules) {
    if (bucketById.get(schedule.id) !== "selected") continue;
    exceptions.add(code);
    mark(schedule, "not_applicable");
  }
  // Any selected version not classified by assignment is conservative: keep
  // it once at the property level as unresolved, never silently drop it.
  for (const schedule of versioned.selectedSchedules.filter(scheduleInFilter)) {
    if (bucketById.get(schedule.id) !== "selected") continue;
    const code = "schedule_unclassified";
    exceptions.add(code);
    const row = makeRow(schedule, { extraCodes: [code], unassigned: true });
    rows.push(row);
    recordEmitted(schedule, row, true);
  }

  const countBucket = (bucket: ProjectionBucket): number => filteredInput.reduce((total, schedule) => total + (bucketById.get(schedule.id) === bucket ? 1 : 0), 0);
  const centsBucket = (bucket: ProjectionBucket): Cents => filteredInput.reduce((total, schedule) => {
    if (bucketById.get(schedule.id) !== bucket || !amountPresent(schedule)) return total;
    return total + schedule.amountCents;
  }, 0);
  const emittedKnownRowCount = countBucket("emitted_known");
  const emittedUncertainRowCount = countBucket("emitted_uncertain");
  const unassignedRowCount = countBucket("unassigned");
  const invalidLineageCount = countBucket("invalid");
  const supersededCount = countBucket("superseded");
  const endedCount = countBucket("ended");
  const inactiveCount = countBucket("inactive");
  const futureCount = countBucket("future");
  const notApplicableCount = countBucket("not_applicable");
  const suppressedByPrecedenceCount = countBucket("suppressed");
  const knownCents = centsBucket("emitted_known");
  const emittedUncertainCents = centsBucket("emitted_uncertain");
  const uncertainCents = emittedUncertainCents + centsBucket("unassigned") + centsBucket("invalid");
  const accountedRowCount = emittedKnownRowCount + emittedUncertainRowCount + unassignedRowCount + invalidLineageCount + supersededCount + endedCount + inactiveCount + futureCount + notApplicableCount + suppressedByPrecedenceCount;
  const selectedRowCount = countBucket("selected") + emittedKnownRowCount + emittedUncertainRowCount + unassignedRowCount + notApplicableCount + suppressedByPrecedenceCount;
  return {
    rows,
    sourceRowCount: filteredInput.length,
    inputRowCount: filteredInput.length,
    accountedRowCount,
    selectedRowCount,
    emittedRowCount: rows.length,
    emittedKnownRowCount,
    emittedUncertainRowCount,
    emittedUncertainCents,
    knownRowCount: emittedKnownRowCount,
    uncertainRowCount: emittedUncertainRowCount + unassignedRowCount + invalidLineageCount,
    knownCents,
    uncertainCents,
    unassignedCents: centsBucket("unassigned"),
    unknownAmountCount,
    invalidLineageCount,
    invalidLineageCents: centsBucket("invalid"),
    supersededCount,
    supersededCents: centsBucket("superseded"),
    endedCount,
    endedCents: centsBucket("ended"),
    inactiveCount,
    inactiveCents: centsBucket("inactive"),
    futureCount,
    futureCents: centsBucket("future"),
    propertyOnceCount,
    suppressedByPrecedenceCount,
    suppressedByPrecedenceCents: centsBucket("suppressed"),
    notApplicableCount,
    notApplicableCents: centsBucket("not_applicable"),
    unassignedRowCount,
    exceptionCodes: Array.from(exceptions).sort(),
  };
}

/** Stable controls shared by report adapters.  Amount totals deliberately
 * exclude null/unknown amounts; the source row count and unknown-amount
 * amount are reported separately so an incomplete report cannot look like a
 * clean zero. */
export interface FinancialProjectionControls {
  sourceRowCount: number;
  knownCount: number;
  uncertainCount: number;
  unclassifiedCount: number;
  unknownAmountCount: number;
  unassignedCount: number;
  knownCents: Cents;
  uncertainCents: Cents;
  unclassifiedCents: Cents;
  unknownAmountCents: Cents;
  unassignedCents: Cents;
  complete: boolean;
}

export function financialProjectionControls(projection: FinancialScheduleProjection): FinancialProjectionControls {
  const unknownAmountCents = projection.rows.reduce((total, row) => total + (row.amountCents === null ? 0 : 0), 0);
  const unclassifiedRows = projection.rows.filter((row) => row.unclassified === true);
  const uncertainRows = projection.rows.filter((row) => row.uncertain === true || row.known !== true);
  const unassignedRows = projection.rows.filter((row) => row.exceptionCodes?.includes("schedule_unassigned") || row.exceptionCodes?.includes("schedule_scope_unknown"));
  return {
    sourceRowCount: projection.sourceRowCount,
    knownCount: projection.knownRowCount,
    uncertainCount: projection.uncertainRowCount,
    unclassifiedCount: unclassifiedRows.length,
    unknownAmountCount: projection.unknownAmountCount,
    unassignedCount: projection.unassignedRowCount,
    knownCents: projection.knownCents,
    uncertainCents: projection.uncertainCents,
    unclassifiedCents: unclassifiedRows.reduce((total, row) => total + (typeof row.amountCents === "number" ? row.amountCents : 0), 0),
    // The projection's uncertain cents intentionally include rows with
    // unknown amounts only when a source amount was present.  A null amount
    // contributes zero cents by definition; the count above preserves the
    // missing fact.
    unknownAmountCents,
    unassignedCents: projection.unassignedCents,
    complete: projection.unknownAmountCount === 0 && projection.unassignedRowCount === 0 && projection.invalidLineageCount === 0 && unclassifiedRows.length === 0 && projection.emittedUncertainRowCount === 0,
  };
}
