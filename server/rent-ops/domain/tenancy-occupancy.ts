import type { RentOpsSnapshot, RentOpsTenancy, RentOpsUnit, IsoDate } from "../../../shared/rent-ops-contracts";

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

export function hasOccupancyConfirmationOn(tenancy: RentOpsTenancy, asOf: IsoDate): boolean {
  const date = tenancy.occupancyConfirmedOn;
  return tenancy.occupancyConfirmationKnowledge === "manual" && !!date
    && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date && date <= asOf
    && !tenancy.actualMoveInOn;
}

export function hasOperationalEndOn(tenancy: RentOpsTenancy, asOf: IsoDate): boolean {
  const date = tenancy.operationalEndConfirmedOn;
  return tenancy.operationalEndConfirmationKnowledge === "manual" && !!date
    && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date && date <= asOf;
}

export function isOccupiedTenancyOn(tenancy: RentOpsTenancy, asOf: IsoDate): boolean {
  const confirmed = confirmedTenancyFact;
  if (!hasConfirmedTenancyLinks(tenancy)) return false;
  if (hasOperationalEndOn(tenancy, asOf)) return false;
  if (!confirmed(tenancy.statusKnowledge)) return false;
  const datedMoveIn = confirmed(tenancy.actualMoveInKnowledge) && !!tenancy.actualMoveInOn && tenancy.actualMoveInOn <= asOf;
  const observedOccupancy = hasOccupancyConfirmationOn(tenancy, asOf);
  if (!datedMoveIn && !observedOccupancy) return false;
  if (tenancy.actualMoveOutOn && (!confirmed(tenancy.actualMoveOutKnowledge) || tenancy.actualMoveOutOn <= asOf)) return false;
  if (tenancy.status === "current" || tenancy.status === "notice") return true;
  return tenancy.status === "past" && !!tenancy.actualMoveOutOn && confirmed(tenancy.actualMoveOutKnowledge);
}

export function isKnownPastAccountOn(snapshot: RentOpsSnapshot, personId: string, asOf: IsoDate, tenancy?: RentOpsTenancy): boolean {
  // An explicit canonical operator status overrides this account observation
  // only for the exact tenancy; date and occupancy guards still apply.
  if (tenancy?.primaryPersonId === personId && ["manual", "confirmed"].includes(tenancy.statusKnowledge ?? "")) return false;
  const facts = snapshot.people.find(person => person.id === personId)?.sourceAccountFacts;
  return !!facts && facts.statusKnowledge === "source" && (facts.status === "past" || facts.status === "cancelled") && !!facts.observedOn && facts.observedOn <= asOf;
}


export function hasVacancyConfirmationOn(unit: RentOpsUnit, asOf: IsoDate): boolean {
  const date = unit.vacancyConfirmedOn;
  return unit.vacancyConfirmationKnowledge === "manual" && !!date
    && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date && date <= asOf;
}
