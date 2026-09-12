import type { RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { reconciliationHash } from "./operator";
import { select, snapshotHash } from "./maintenance";

/** Preparation only: an occupancy observation is not an actual move-in date. */
export interface OccupancyEstablishmentRequest {
  expectedSnapshotSha256: string;
  personSourceId: string;
  unitSourceId: string;
  propertySourceId: string;
  occupiedAsOf: string;
  leaseStartOn: string;
  leaseEndOn: string;
  monthlyBaseCents: number;
  monthlyFeeCents: number;
  evidence: Array<{ path: string; sha256: string; reference: string }>;
}
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function prepareOccupancyEstablishment(snapshot: RentOpsSnapshot, request: OccupancyEstablishmentRequest) {
  if (snapshotHash(snapshot) !== request.expectedSnapshotSha256) throw new Error("Snapshot changed");
  if (![request.occupiedAsOf, request.leaseStartOn, request.leaseEndOn].every(date)
    || request.leaseEndOn < request.leaseStartOn || request.occupiedAsOf < request.leaseStartOn || request.occupiedAsOf > request.leaseEndOn) throw new Error("Invalid observation or lease interval");
  if (![request.monthlyBaseCents, request.monthlyFeeCents].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid monthly amounts");
  if (!request.evidence.length || request.evidence.some(value => !value.path.startsWith("/") || !/^[a-f0-9]{64}$/.test(value.sha256) || !value.reference.trim())) throw new Error("Evidence references required");
  const person = select(snapshot, { collection: "people", sourceId: request.personSourceId });
  const unit = select(snapshot, { collection: "units", sourceId: request.unitSourceId });
  const property = select(snapshot, { collection: "properties", sourceId: request.propertySourceId });
  if (unit.propertyId !== property.id) throw new Error("Unit/property identity mismatch");
  const relatedTenancies = snapshot.tenancies.filter(row => row.unitId === unit.id || row.primaryPersonId === person.id);
  if (relatedTenancies.some(row => ["current", "notice", "future"].includes(row.status))) throw new Error("Existing occupancy or future assignment requires separate reconciliation");
  const guard = (row: any) => ({ id: row.id, expectedRevision: row.recordRevision ?? 1, beforeSha256: reconciliationHash(row) });
  return {
    version: 1 as const,
    state: "proposal_only_not_executable" as const,
    snapshotSha256: request.expectedSnapshotSha256,
    guards: { person: guard(person), unit: guard(unit), property: guard(property), relatedTenancies: relatedTenancies.map(guard) },
    occupancyEvidence: { occupiedAsOf: request.occupiedAsOf, actualMoveInOn: null, actualMoveInKnowledge: "unknown" as const },
    proposedIdentity: { propertyId: property.id, unitId: unit.id, primaryPersonId: person.id },
    proposedLease: { status: "executed" as const, contractStartOn: request.leaseStartOn, contractEndOn: request.leaseEndOn, monthToMonth: false },
    proposedMonthlyObligations: [{ category: "base_rent" as const, amountCents: request.monthlyBaseCents }, { category: "recurring_fee" as const, amountCents: request.monthlyFeeCents }],
    evidence: structuredClone(request.evidence),
    blockers: ["Current tenancy creation and occupancy projection require an actual move-in date; a distinct confirmed-occupancy observation must be supported before execution.", "Schedule activation date requires explicit review; lease commencement and observation dates must not be substituted for actual move-in."],
  };
}
