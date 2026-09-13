import type { DelinquencyRow, RentOpsFilters, RentOpsPerson, RentOpsSnapshot, RentOpsTenancy } from "../../../shared/rent-ops-contracts";
import { nowIsoDate } from "./dates";
import { confirmedTenancyFact, isOccupiedTenancyOn, hasOperationalEndOn, isKnownPastAccountOn, hasConfirmedTenancyLinks } from "./tenancy-occupancy";
type Status = NonNullable<DelinquencyRow["tenancyStatus"]>;

export function accountTenantStatusOn(snapshot: RentOpsSnapshot, person: RentOpsPerson, tenancies: RentOpsTenancy[], occupied: RentOpsTenancy[], asOf: string): Status {
  // Match Rent Roll's exact, dated occupancy predicate. A still-occupied
  // tenancy is not ended by a different historical tenancy in this property.
  if (occupied.length) return "current";
  if (tenancies.some(t => hasConfirmedTenancyLinks(t) && !isKnownPastAccountOn(snapshot, person.id, asOf, t)
    && confirmedTenancyFact(t.statusKnowledge) && confirmedTenancyFact(t.plannedMoveInKnowledge)
    && t.status === "future" && !!t.plannedMoveInOn && t.plannedMoveInOn > asOf)) return "future";
  if (tenancies.some(t => hasConfirmedTenancyLinks(t) && (
    (["manual", "confirmed"].includes(t.statusKnowledge ?? "") && (t.status === "past" || t.status === "cancelled"))
    || hasOperationalEndOn(t, asOf)
    || (confirmedTenancyFact(t.actualMoveOutKnowledge) && !!t.actualMoveOutOn && t.actualMoveOutOn <= asOf)))) return "former";
  const facts = person.sourceAccountFacts;
  if (facts?.statusKnowledge === "source" && facts.observedOn <= asOf) {
    if (facts.status === "past" || facts.status === "cancelled") return "former";
    if (facts.status === "future") return "future";
  }
  // A historical account-level Current flag proves neither a current property
  // nor an occupied unit, and cannot override a manual departure correction.
  return "unknown";
}

/** Reports select resident accounts within each property, just like Account
 * Balances. A transfer within that property retains the resident's prior lease
 * history; occupancy in another property cannot relabel their old account. */
export function createTenantStatusMatcher(snapshot: RentOpsSnapshot, filters: RentOpsFilters) {
  if (!filters.tenantStatus || filters.tenantStatus === "all") return (_row: TenantStatusScope) => true;
  const asOf = filters.asOfDate ?? nowIsoDate();
  const people = new Map(snapshot.people.map(person => [person.id, person]));
  const tenancies = new Map(snapshot.tenancies.map(tenancy => [tenancy.id, tenancy]));
  const exact = (knowledge: string | null | undefined) => knowledge === "exact" || knowledge === "manual" || (snapshot.modelVersion !== 3 && knowledge === undefined);
  const key = (personId: string, propertyId: string) => JSON.stringify([personId, propertyId]);
  const groups = new Map<string, RentOpsTenancy[]>();
  for (const tenancy of snapshot.tenancies) {
    if (!tenancy.primaryPersonId || !tenancy.propertyId || !exact(tenancy.primaryPersonLinkKnowledge) || !exact(tenancy.propertyLinkKnowledge)) continue;
    const id = key(tenancy.primaryPersonId, tenancy.propertyId);
    const entries = groups.get(id) ?? [];
    entries.push(tenancy); groups.set(id, entries);
  }
  const statuses = new Map<string, Status>();
  for (const [id, entries] of Array.from(groups.entries())) {
    const person = people.get(entries[0].primaryPersonId);
    if (!person) continue;
    const personSnapshot = { ...snapshot, people: [person] };
    const occupied = entries.filter(tenancy => isOccupiedTenancyOn(tenancy, asOf) && !isKnownPastAccountOn(personSnapshot, person.id, asOf, tenancy));
    statuses.set(id, accountTenantStatusOn(personSnapshot, person, entries, occupied, asOf));
  }
  return (row: TenantStatusScope): boolean => {
    // Projected report rows omit link metadata because their scope has already
    // been resolved. Explicit unknown/ambiguous links never prove an account.
    const admitted = (knowledge: string | null | undefined) => knowledge === undefined || knowledge === "exact" || knowledge === "manual";
    const linked = row.tenancyId && admitted(row.tenancyLinkKnowledge) ? tenancies.get(row.tenancyId) : undefined;
    const linkedPerson = linked && exact(linked.primaryPersonLinkKnowledge) ? linked.primaryPersonId : undefined;
    const linkedProperty = linked && exact(linked.propertyLinkKnowledge) ? linked.propertyId : undefined;
    const directPerson = admitted(row.personLinkKnowledge) ? row.personId : undefined;
    const directProperty = admitted(row.propertyLinkKnowledge) ? row.propertyId : undefined;
    const conflict = (directPerson && linkedPerson && directPerson !== linkedPerson) || (directProperty && linkedProperty && directProperty !== linkedProperty);
    const personId = conflict ? undefined : directPerson || linkedPerson;
    const propertyId = conflict ? undefined : directProperty || linkedProperty;
    let status: Status = "unknown";
    if (personId && propertyId) {
      const person = people.get(personId);
      status = statuses.get(key(personId, propertyId)) ?? (person ? accountTenantStatusOn(snapshot, person, [], [], asOf) : "unknown");
    }
    return status === filters.tenantStatus;
  };
}
interface TenantStatusScope {
  tenancyId?: string | null; personId?: string | null; propertyId?: string | null;
  tenancyLinkKnowledge?: string | null; personLinkKnowledge?: string | null; propertyLinkKnowledge?: string | null;
}
