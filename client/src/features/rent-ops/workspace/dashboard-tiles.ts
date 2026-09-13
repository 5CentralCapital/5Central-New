import type { AdminSnapshot, AdminApplicationView, ViewFilters } from "../types";
import { workspacePropertyMatches } from "./workspace-state";

const known = (knowledge?: string | null) => knowledge === undefined || knowledge === "source" || knowledge === "manual";
const exact = (knowledge?: string | null) => knowledge === undefined || knowledge === "exact" || knowledge === "manual";
const dateOnly = (value?: string) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : undefined;

/** Only received native web applications belong in the online-submissions tile. */
export function recentOnlineApplications(applications: AdminApplicationView[], snapshot: AdminSnapshot, filters: ViewFilters) {
  const from = new Date(`${filters.asOfDate}T12:00:00Z`); from.setUTCDate(from.getUTCDate() - 29);
  const start = from.toISOString().slice(0, 10);
  const properties = new Map(snapshot.snapshot.properties.map(property => [property.id, property]));
  const query = filters.search.trim().toLowerCase();
  return applications.filter(application => {
    const submitted = known(application.submittedOnKnowledge) ? dateOnly(application.submittedOn) : undefined;
    if (!application.id || application.sourceType !== "public_portal" || !known(application.sourceTypeKnowledge) || application.status === "draft" || !submitted || submitted < start || submitted > filters.asOfDate) return false;
    const property = properties.get(application.propertyId);
    if (!workspacePropertyMatches(filters, application.propertyId) || property && filters.propertyScope === "active" && property.state !== "active") return false;
    if (filters.status !== "all" && application.status !== filters.status) return false;
    return !query || `${application.firstName ?? ""} ${application.lastName ?? ""} ${application.email ?? ""} ${property?.name ?? ""}`.toLowerCase().includes(query);
  }).sort((a, b) => b.submittedOn!.localeCompare(a.submittedOn!) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id!.localeCompare(b.id!))
    .map(application => ({ ...application, displayName: [application.firstName, application.lastName].filter(Boolean).join(" ") || application.email || "Applicant", propertyName: properties.get(application.propertyId)?.name }));
}

/** Actual and planned events remain separate; only the selected calendar month is shown. */
export function dashboardMovements(snapshot: AdminSnapshot, filters: ViewFilters) {
  const start = `${filters.asOfDate.slice(0, 7)}-01`;
  const endDate = new Date(`${start}T12:00:00Z`); endDate.setUTCMonth(endDate.getUTCMonth() + 1); endDate.setUTCDate(0);
  const end = endDate.toISOString().slice(0, 10);
  const inPeriod = (date?: string) => !!date && date >= start && date <= end;
  return snapshot.snapshot.tenancies.flatMap(tenancy => {
    if (![tenancy.propertyLinkKnowledge, tenancy.unitLinkKnowledge, tenancy.primaryPersonLinkKnowledge].every(exact)) return [];
    const property = snapshot.snapshot.properties.find(property => property.id === tenancy.propertyId);
    if (!property || filters.propertyScope === "active" && property.state !== "active" || !workspacePropertyMatches(filters, property.id)) return [];
    const unit = snapshot.snapshot.units.find(unit => unit.id === tenancy.unitId);
    const person = snapshot.snapshot.people.find(person => person.id === tenancy.primaryPersonId);
    if (filters.search.trim() && !`${property.name} ${unit?.unitNumber ?? ""} ${person?.firstName ?? ""} ${person?.lastName ?? ""}`.toLowerCase().includes(filters.search.trim().toLowerCase())) return [];
    // Cancellation is an explicit correction, not evidence that imported intent happened.
    // A former record needs a consistent actual interval before it can establish a move-in.
    const actualStatus = known(tenancy.statusKnowledge) && ["current", "notice", "past", "former"].includes(tenancy.status ?? "");
    const rawActualIn = actualStatus && known(tenancy.actualMoveInKnowledge) ? dateOnly(tenancy.actualMoveInOn) : undefined;
    const rawActualOut = actualStatus && known(tenancy.actualMoveOutKnowledge) ? dateOnly(tenancy.actualMoveOutOn) : undefined;
    const chronological = !rawActualIn || !rawActualOut || rawActualIn <= rawActualOut;
    const former = ["past", "former"].includes(tenancy.status ?? "");
    const actualIn = chronological && (!former || rawActualOut) ? rawActualIn : undefined;
    const actualOut = chronological ? rawActualOut : undefined;
    const plannedIn = tenancy.status === "future" && known(tenancy.statusKnowledge) && known(tenancy.plannedMoveInKnowledge) ? dateOnly(tenancy.plannedMoveInOn) : undefined;
    const expectedOut = !actualOut && ["current", "notice"].includes(tenancy.status ?? "") && known(tenancy.statusKnowledge) && known(tenancy.expectedMoveOutKnowledge) ? dateOnly(tenancy.expectedMoveOutOn) : undefined;
    const events = [
      { date: actualIn, movement: "Move in", state: "Completed", actual: true },
      { date: actualOut, movement: "Move out", state: "Completed", actual: true },
      { date: plannedIn, movement: "Move in", state: "Planned", actual: false },
      { date: expectedOut, movement: "Move out", state: "Expected", actual: false },
    ].filter(event => inPeriod(event.date) && (!event.actual || event.date! <= filters.asOfDate));
    return events.map(event => ({ id: `${tenancy.id}:${event.movement}:${event.state}`, tenancyId: tenancy.id, personId: tenancy.primaryPersonId, tenantName: [person?.firstName, person?.lastName].filter(Boolean).join(" "), propertyId: property.id, propertyName: property.name, unitId: unit?.id, unitNumber: unit?.unitNumber, ...event }));
  }).sort((a, b) => a.date!.localeCompare(b.date!) || a.id.localeCompare(b.id));
}
