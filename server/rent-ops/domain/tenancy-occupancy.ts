import type { RentOpsSnapshot, RentOpsTenancy, IsoDate } from "../../../shared/rent-ops-contracts";

/** Actual occupancy is independent of the contractual lease expiration. A past
 * source status supports historical occupancy only inside a confirmed interval. */
export function confirmedTenancyFact(knowledge: string | null | undefined): boolean {
  return knowledge === undefined || knowledge === "source" || knowledge === "manual";
}

export function hasConfirmedTenancyLinks(tenancy: RentOpsTenancy): boolean {
  const confirmed = (value: string | null | undefined) => value === undefined || value === "exact" || value === "manual";
  return !!tenancy.propertyId && !!tenancy.unitId && !!tenancy.primaryPersonId
    && confirmed(tenancy.propertyLinkKnowledge) && confirmed(tenancy.unitLinkKnowledge) && confirmed(tenancy.primaryPersonLinkKnowledge);
}

export function isOccupiedTenancyOn(tenancy: RentOpsTenancy, asOf: IsoDate): boolean {
  const confirmed = confirmedTenancyFact;
  if (!hasConfirmedTenancyLinks(tenancy)) return false;
  if (!confirmed(tenancy.statusKnowledge) || !confirmed(tenancy.actualMoveInKnowledge)) return false;
  if (!tenancy.actualMoveInOn || tenancy.actualMoveInOn > asOf) return false;
  if (tenancy.actualMoveOutOn && (!confirmed(tenancy.actualMoveOutKnowledge) || tenancy.actualMoveOutOn <= asOf)) return false;
  if (tenancy.status === "current" || tenancy.status === "notice") return true;
  return tenancy.status === "past" && !!tenancy.actualMoveOutOn && confirmed(tenancy.actualMoveOutKnowledge);
}

export function isKnownPastAccountOn(snapshot: RentOpsSnapshot, personId: string, asOf: IsoDate): boolean {
  const facts = snapshot.people.find(person => person.id === personId)?.sourceAccountFacts;
  return !!facts && facts.statusKnowledge === "source" && (facts.status === "past" || facts.status === "cancelled") && !!facts.observedOn && facts.observedOn <= asOf;
}

