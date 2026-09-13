import type { RentOpsActivityEvent, RentOpsFilters, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import {
  dashboardArchivedSnapshotSchema,
  dashboardPropertyPointSchema,
  HISTORICAL_LEASING_SNAPSHOT_SCHEMA,
  HISTORICAL_LEASING_SOURCE_SYSTEMS,
  historicalLeasingSnapshotSchema,
  type DashboardArchivedSnapshot,
  type HistoricalLeasingSnapshotObservation,
  type HistoricalLeasingSourceSystem,
} from "../../../shared/rent-ops-dashboard";

/** The source system values that may be shown by a historical chart. */
const sourceAliases: Record<string, HistoricalLeasingSourceSystem> = {
  appfolio: "appfolio",
  evernest: "evernest",
  rm: "rent_manager",
  rentmanager: "rent_manager",
  rent_manager: "rent_manager",
  "rent-manager": "rent_manager",
};

type JsonRecord = Record<string, unknown>;

export interface HistoricalLeasingSnapshotIssue {
  eventId?: string;
  asOfDate?: string;
  propertyId?: string;
  code:
    | "event_invalid"
    | "observation_invalid"
    | "event_scope_mismatch"
    | "property_out_of_scope"
    | "future_observation"
    | "observation_conflict"
    | "source_conflict";
}

export interface HistoricalLeasingSnapshotDerivation {
  snapshots: DashboardArchivedSnapshot[];
  issues: HistoricalLeasingSnapshotIssue[];
}

interface ValidatedObservation {
  eventId: string;
  observation: HistoricalLeasingSnapshotObservation;
  sourceSystem: HistoricalLeasingSourceSystem;
}

interface HistoricalObservationEvent extends Omit<RentOpsActivityEvent, "detail"> {
  detail?: unknown;
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function canonicalSourceSystem(value: string): HistoricalLeasingSourceSystem | undefined {
  return sourceAliases[value.trim().toLocaleLowerCase("en-US")];
}

function validTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function eventCandidate(eventValue: unknown): { relevant: boolean; value?: ValidatedObservation; issue?: HistoricalLeasingSnapshotIssue } {
  const event = record(eventValue) as HistoricalObservationEvent | undefined;
  // Activity events are a large mixed stream.  Only a direct JSON detail body
  // carrying this exact schema is a historical leasing candidate; ordinary
  // notes, application events, and other system events stay invisible here.
  const detail = safeJson(event?.detail);
  const detailRecord = record(detail);
  if (detailRecord?.schema !== HISTORICAL_LEASING_SNAPSHOT_SCHEMA) return { relevant: false };

  const eventId = typeof event?.id === "string" ? event.id : undefined;
  if (!event || !eventId?.trim() || event.type !== "system" || !validTimestamp(event.occurredAt)) {
    return { relevant: true, issue: { eventId, code: "event_invalid" } };
  }

  // A historical leasing observation has property scope only.  Any narrower
  // identity on the carrier is a malformed or mis-scoped event, even if the
  // JSON body itself looks valid.
  if ([event.unitId, event.personId, event.tenancyId, event.applicationId].some((value) => value !== undefined && value !== null)) {
    return { relevant: true, issue: { eventId, code: "event_scope_mismatch" } };
  }

  // The persisted body is the observation itself.  Parsing it directly keeps
  // the strict schema effective, including rejection of unknown fields.
  const observation = historicalLeasingSnapshotSchema.safeParse(detailRecord);
  if (!observation.success) return { relevant: true, issue: { eventId, code: "observation_invalid" } };
  const sourceSystem = canonicalSourceSystem(observation.data.sourceSystem);
  if (!sourceSystem || !HISTORICAL_LEASING_SOURCE_SYSTEMS.includes(sourceSystem)) {
    return { relevant: true, issue: { eventId, code: "observation_invalid", propertyId: observation.data.propertyId, asOfDate: observation.data.asOfDate } };
  }

  const carrierPropertyId = event.propertyId;
  const carrierSourceSystem = record(event.source)?.system;
  if (typeof carrierPropertyId !== "string" || carrierPropertyId !== observation.data.propertyId
    || (carrierSourceSystem !== undefined && (typeof carrierSourceSystem !== "string" || canonicalSourceSystem(carrierSourceSystem) !== sourceSystem))) {
    return { relevant: true, issue: { eventId, code: "event_scope_mismatch", propertyId: observation.data.propertyId, asOfDate: observation.data.asOfDate } };
  }

  return { relevant: true, value: { eventId, observation: observation.data, sourceSystem } };
}

function scopedPropertyIds(snapshot: RentOpsSnapshot, filters: RentOpsFilters): Set<string> {
  const selected = snapshot.properties.filter((property) =>
    (!filters.propertyId || property.id === filters.propertyId)
    && (!filters.propertyIds?.length || filters.propertyIds.includes(property.id)));
  if (filters.propertyId || filters.propertyIds?.length || filters.propertyScope !== "active") return new Set(selected.map((property) => property.id));
  return new Set(selected.filter((property) => property.state === "active").map((property) => property.id));
}

type EvidenceField = "occupancy" | "vacancy" | "rent";
type EvidenceValue = string | { occupancy?: string; vacancy?: string; rent?: string };

function evidenceFieldValue(value: EvidenceValue, field: EvidenceField): string | undefined {
  return typeof value === "string" ? value : value[field];
}

function scalarCompletenessForField(value: string, field: EvidenceField): string {
  if (value === "complete_charge_snapshot") return field === "rent" ? value : "unknown";
  if (value === "complete_vacancy_snapshot") return field === "vacancy" ? value : "unknown";
  return value;
}

function evidenceComplete(observation: HistoricalLeasingSnapshotObservation, field: EvidenceField): boolean {
  const knowledge = evidenceFieldValue(observation.evidence.knowledge, field);
  const rawCompleteness = evidenceFieldValue(observation.evidence.completeness, field);
  const completeness = rawCompleteness ? scalarCompletenessForField(rawCompleteness, field) : "unknown";
  return (knowledge === "source" || knowledge === "known" || knowledge === "manual")
    && (completeness === "complete"
      || completeness === "complete_property_snapshot"
      || completeness === "complete_55_unit_snapshot"
      || (field === "rent" && completeness === "complete_charge_snapshot")
      || (field === "vacancy" && completeness === "complete_vacancy_snapshot"));
}

function evidenceKnown(observation: HistoricalLeasingSnapshotObservation, field: EvidenceField): boolean {
  const knowledge = evidenceFieldValue(observation.evidence.knowledge, field);
  return knowledge === "source" || knowledge === "known" || knowledge === "manual";
}

function dashboardPoint(observation: HistoricalLeasingSnapshotObservation, propertyName: string) {
  // A property snapshot with no units cannot produce a meaningful rate or
  // chart point.  Keep this guard even though the public schema also rejects
  // zero, because callers may pass observations from an older schema version.
  if (observation.unitCount <= 0) return undefined;
  const occupied = observation.occupied ?? 0;
  const vacant = observation.vacant ?? 0;
  const preleased = observation.preleased ?? 0;
  const suppliedUnknown = observation.unknown;
  const inferredUnknown = observation.unitCount - occupied - vacant;
  const unknown = suppliedUnknown ?? inferredUnknown;
  if (![occupied, vacant, preleased, unknown].every((value) => Number.isSafeInteger(value) && value >= 0)
    || occupied + vacant + unknown !== observation.unitCount
    || preleased > vacant) return undefined;

  const occupancyComplete = evidenceComplete(observation, "occupancy")
    && observation.occupied !== null
    && observation.vacant !== null
    && observation.preleased !== null
    && unknown === 0;
  const vacancyComplete = evidenceComplete(observation, "vacancy") && observation.vacant !== null;
  const rentKnown = evidenceComplete(observation, "rent") && observation.monthlyBaseRentCents !== null;
  return dashboardPropertyPointSchema.parse({
    propertyId: observation.propertyId,
    propertyName,
    unitCount: observation.unitCount,
    occupiedUnits: occupied,
    vacantUnits: vacant,
    preleasedUnits: preleased,
    unknownUnits: unknown,
    occupiedUnitsKnown: observation.occupied !== null && evidenceKnown(observation, "occupancy"),
    vacantUnitsKnown: observation.vacant !== null && evidenceKnown(observation, "vacancy"),
    preleasedUnitsKnown: observation.preleased !== null && evidenceKnown(observation, "occupancy"),
    occupancyRate: occupancyComplete ? 100 * occupied / observation.unitCount : null,
    vacancyRate: vacancyComplete ? 100 * vacant / observation.unitCount : null,
    baseRentCents: rentKnown ? observation.monthlyBaseRentCents : null,
    // A partial or lower-bound amount is intentionally not carried into any
    // aggregate.  It remains an incomplete rent observation in the point.
    confirmedBaseRentCents: rentKnown ? observation.monthlyBaseRentCents : 0,
    unconfirmedRentUnits: rentKnown ? 0 : observation.unitCount,
  });
}

function sameObservation(left: HistoricalLeasingSnapshotObservation, right: HistoricalLeasingSnapshotObservation): boolean {
  const evidenceFields: EvidenceField[] = ["occupancy", "vacancy", "rent"];
  const sameEvidence = (key: "knowledge" | "completeness") => evidenceFields.every((field) =>
    evidenceFieldValue(left.evidence[key], field) === evidenceFieldValue(right.evidence[key], field));
  return left.propertyId === right.propertyId
    && left.asOfDate === right.asOfDate
    && left.sourceSystem.trim().toLocaleLowerCase("en-US") === right.sourceSystem.trim().toLocaleLowerCase("en-US")
    && left.unitCount === right.unitCount
    && left.occupied === right.occupied
    && left.vacant === right.vacant
    && left.preleased === right.preleased
    && left.unknown === right.unknown
    && left.monthlyBaseRentCents === right.monthlyBaseRentCents
    && sameEvidence("knowledge")
    && sameEvidence("completeness");
}

function sourceLabel(sourceSystem: HistoricalLeasingSourceSystem): string {
  return sourceSystem === "rent_manager" ? "RM" : "Evernest";
}

/**
 * Validate and project append-only history events into safe chart snapshots.
 * Invalid, future, foreign, duplicate-conflicting, and cross-source points
 * are omitted.  `issues` is intentionally an internal diagnostic channel and
 * is never included in the dashboard response.
 */
export function deriveArchivedDashboardSnapshots(
  snapshot: RentOpsSnapshot,
  filters: RentOpsFilters = {},
  asOfDate: string,
): HistoricalLeasingSnapshotDerivation {
  const propertyIds = scopedPropertyIds(snapshot, filters);
  const properties = new Map(snapshot.properties.map((property) => [property.id, property]));
  const issues: HistoricalLeasingSnapshotIssue[] = [];
  const candidates: ValidatedObservation[] = [];

  for (const event of snapshot.activityEvents ?? []) {
    const parsed = eventCandidate(event);
    if (!parsed.value) {
      if (parsed.relevant) issues.push(parsed.issue!);
      continue;
    }
    const { observation } = parsed.value;
    if (observation.asOfDate > asOfDate) {
      issues.push({ eventId: parsed.value.eventId, propertyId: observation.propertyId, asOfDate: observation.asOfDate, code: "future_observation" });
      continue;
    }
    if (!propertyIds.has(observation.propertyId) || !properties.has(observation.propertyId)) {
      issues.push({ eventId: parsed.value.eventId, propertyId: observation.propertyId, asOfDate: observation.asOfDate, code: "property_out_of_scope" });
      continue;
    }
    candidates.push(parsed.value);
  }

  const byDate = new Map<string, Map<string, ValidatedObservation>>();
  const conflictedDates = new Set<string>();
  for (const candidate of candidates) {
    const date = candidate.observation.asOfDate;
    const byProperty = byDate.get(date) ?? new Map<string, ValidatedObservation>();
    const prior = byProperty.get(candidate.observation.propertyId);
    if (prior) {
      if (!sameObservation(prior.observation, candidate.observation)) {
        conflictedDates.add(date);
        issues.push({ eventId: candidate.eventId, propertyId: candidate.observation.propertyId, asOfDate: date, code: "observation_conflict" });
      }
      // Exact duplicate events are one immutable observation, never additive.
      byProperty.set(candidate.observation.propertyId, prior);
    } else byProperty.set(candidate.observation.propertyId, candidate);
    byDate.set(date, byProperty);
  }

  const result = Array.from(byDate.entries()).sort(([left], [right]) => left.localeCompare(right)).flatMap(([asOf, byProperty]) => {
    if (conflictedDates.has(asOf)) return [];
    const sourceSystems = new Set(Array.from(byProperty.values()).map((candidate) => candidate.sourceSystem));
    if (sourceSystems.size !== 1) {
      issues.push({ asOfDate: asOf, code: "source_conflict" });
      return [];
    }
    const sourceSystem = Array.from(sourceSystems)[0];
    const points = Array.from(byProperty.values()).flatMap((candidate) => {
      const point = dashboardPoint(candidate.observation, properties.get(candidate.observation.propertyId)!.name);
      if (!point) {
        issues.push({ eventId: candidate.eventId, propertyId: candidate.observation.propertyId, asOfDate: asOf, code: "observation_invalid" });
        return [];
      }
      return [point];
    });
    if (!points.length) return [];
    return [dashboardArchivedSnapshotSchema.parse({ asOfDate: asOf, sourceSystem, properties: points })];
  });

  return { snapshots: result, issues };
}

/** Convenience array API for chart/domain callers that do not need diagnostics. */
export function archivedDashboardSnapshots(snapshot: RentOpsSnapshot, filters: RentOpsFilters = {}, asOfDate: string): DashboardArchivedSnapshot[] {
  return deriveArchivedDashboardSnapshots(snapshot, filters, asOfDate).snapshots;
}

/** Safe UI label for the allowlisted public source system. */
export function archivedSnapshotSourceLabel(sourceSystem: HistoricalLeasingSourceSystem): "RM" | "Evernest" {
  return sourceLabel(sourceSystem) as "RM" | "Evernest";
}
