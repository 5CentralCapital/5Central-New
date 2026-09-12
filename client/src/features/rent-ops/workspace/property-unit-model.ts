import type {
  AdminAddressView,
  AdminLeaseTermView,
  AdminPropertyView,
  AdminRecurringScheduleView,
  AdminSnapshot,
  AdminTenancyView,
  AdminUnitView,
  ViewFilters,
} from "../types";
import type { FormValues } from "../form-payload";
import { scheduleDisplayInterval } from "./schedule-display";

export type PropertyUnitRecordKind = "property" | "unit";

export type PropertyUnitTab = "general" | "units" | "occupancy" | "recurring" | "marketing";

export type RecurringRelationship = "direct" | "inherited" | "tenant-linked" | "linked" | "unresolved";

export interface PropertyUnitListItem {
  key: string;
  kind: PropertyUnitRecordKind;
  id?: string;
  propertyId?: string;
  title: string;
  subtitle: string;
  searchText: string;
}

export interface PropertyUnitSelection {
  kind: PropertyUnitRecordKind;
  property?: AdminPropertyView;
  unit?: AdminUnitView;
}

export interface OccupancyHistoryRecord {
  key: string;
  unit: AdminUnitView;
  tenancy?: AdminTenancyView;
  lease?: AdminLeaseTermView;
  occupantName?: string;
  occupancyStatus: string;
}

export interface UnitRecurringRecord {
  key: string;
  schedule: AdminRecurringScheduleView;
  relationship: RecurringRelationship;
  relationshipLabel: string;
}

const UNKNOWN_LINK_VALUES = new Set(["unknown", "ambiguous", "inferred"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function lower(value: unknown): string {
  return text(value).toLocaleLowerCase();
}

/**
 * A positive id without an explicit uncertainty marker is usable in the
 * browser view. Explicit unknown/ambiguous link markers remain excluded so a
 * missing relationship cannot become a vacancy, charge, or occupancy claim.
 */
export function knownLink(id: unknown, knowledge?: unknown): boolean {
  const value = text(id);
  return Boolean(value) && !UNKNOWN_LINK_VALUES.has(lower(knowledge));
}

export function centsAsDollars(cents: number | null | undefined): string {
  return typeof cents === "number" && Number.isFinite(cents) ? String(cents / 100) : "";
}

function normalizedAddressPart(value: unknown): string {
  return text(value)
    .toLocaleLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAddressPart(existing: string, candidate: unknown): boolean {
  const haystack = normalizedAddressPart(existing);
  const needle = normalizedAddressPart(candidate);
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  return (` ${haystack} `).includes(` ${needle} `);
}

/**
 * Return address lines without repeating locality fields that already appear
 * in a legacy line1/line2 value. This handles imported values such as
 * "123 Main St, Tampa, FL 33601" plus separate city/state fields.
 */
export function addressLines(address?: AdminAddressView): string[] {
  if (!address) return ["Needs review"];

  const line1 = text(address.line1);
  const line2 = text(address.line2);
  const existing = [line1, line2].filter(Boolean).join(" ");
  const city = text(address.city);
  const state = text(address.state);
  const postalCode = text(address.postalCode);
  const localityParts = {
    city: city && !containsAddressPart(existing, city) ? city : "",
    state: state && !containsAddressPart(existing, state) ? state : "",
    postalCode: postalCode && !containsAddressPart(existing, postalCode) ? postalCode : "",
  };

  const lines: string[] = [];
  if (line1) lines.push(line1);
  if (line2 && normalizedAddressPart(line2) !== normalizedAddressPart(line1)) lines.push(line2);
  if (localityParts.city || localityParts.state || localityParts.postalCode) {
    const locality = [localityParts.city, [localityParts.state, localityParts.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    if (locality) lines.push(locality);
  }
  return lines.length ? lines : ["Needs review"];
}

export function formatAddress(address?: AdminAddressView): string {
  return addressLines(address).join(", ");
}

function propertyMatches(property: AdminPropertyView, query: string): boolean {
  if (!query) return true;
  const address = property.address;
  const values = [
    property.name,
    property.slug,
    property.propertyType,
    property.state,
    property.operatingContact,
    address?.line1,
    address?.line2,
    address?.city,
    address?.state,
    address?.postalCode,
  ];
  return values.some((value) => lower(value).includes(query));
}

function unitMatches(unit: AdminUnitView, query: string): boolean {
  if (!query) return true;
  return [
    unit.unitNumber,
    unit.unitType,
    unit.bedrooms,
    unit.bathrooms,
    unit.squareFeet,
    unit.readiness,
    unit.listing,
    unit.amenities?.join(" "),
    unit.accessNotes,
  ].some((value) => lower(value).includes(query));
}

const recordCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareRecordLabels(left: unknown, right: unknown, leftId?: string, rightId?: string): number {
  const a = text(left);
  const b = text(right);
  // Unnamed records follow named records; identity breaks equal-label ties so
  // database update order never becomes visible directory ordering.
  return Number(!a) - Number(!b) || recordCollator.compare(a, b) || recordCollator.compare(leftId ?? "", rightId ?? "");
}

function compareProperties(left: AdminPropertyView, right: AdminPropertyView): number {
  return compareRecordLabels(left.name, right.name, left.id, right.id);
}

function compareUnits(left: AdminUnitView, right: AdminUnitView): number {
  return compareRecordLabels(left.unitNumber, right.unitNumber, left.id, right.id);
}

function propertyInFilters(property: AdminPropertyView, filters: Pick<ViewFilters, "propertyId" | "propertyScope">): boolean {
  const propertyId = filters.propertyId || "all";
  const propertyScope = filters.propertyScope || "active";
  if (propertyId !== "all" && property.id !== propertyId) return false;
  if (propertyId === "all" && propertyScope === "active" && property.state !== "active") return false;
  return true;
}

/**
 * Build the compact left-hand property/unit list. A property remains visible
 * when one of its units matches the query, and a property match expands to
 * its units so the operator can open the related record immediately.
 */
export function propertyUnitListItems(
  snapshot: AdminSnapshot,
  filters: Pick<ViewFilters, "propertyId" | "propertyScope">,
  search = "",
): PropertyUnitListItem[] {
  const query = lower(search);
  const unitsByProperty = new Map<string, AdminUnitView[]>();
  for (const unit of snapshot.snapshot.units) {
    const propertyId = text(unit.propertyId);
    if (!propertyId) continue;
    const rows = unitsByProperty.get(propertyId) ?? [];
    rows.push(unit);
    unitsByProperty.set(propertyId, rows);
  }

  const rows: PropertyUnitListItem[] = [];
  [...snapshot.snapshot.properties].sort(compareProperties).forEach((property, propertyIndex) => {
    if (!propertyInFilters(property, filters)) return;
    const propertyUnits = property.id ? [...(unitsByProperty.get(property.id) ?? [])].sort(compareUnits) : [];
    const propertyIsMatch = propertyMatches(property, query);
    const matchingUnits = propertyUnits.filter((unit) => unitMatches(unit, query));
    if (query && !propertyIsMatch && matchingUnits.length === 0) return;

    const propertyId = text(property.id) || undefined;
    rows.push({
      key: `property:${propertyId ?? propertyIndex}`,
      kind: "property",
      id: propertyId,
      title: text(property.name) || "Needs review",
      subtitle: `${propertyUnits.length} ${propertyUnits.length === 1 ? "unit" : "units"} · ${formatAddress(property.address)}`,
      searchText: [property.name, property.slug, formatAddress(property.address)].filter(Boolean).join(" "),
    });

    const unitsToShow = query && !propertyIsMatch ? matchingUnits : propertyUnits;
    unitsToShow.forEach((unit, unitIndex) => {
      const unitId = text(unit.id) || undefined;
      rows.push({
        key: `unit:${unitId ?? `${propertyId ?? propertyIndex}:${unitIndex}`}`,
        kind: "unit",
        id: unitId,
        propertyId,
        title: text(unit.unitNumber) || "Needs review",
        subtitle: [text(unit.unitType), text(unit.readiness) || "Readiness needs review"].filter(Boolean).join(" · "),
        searchText: [unit.unitNumber, unit.unitType, unit.readiness, unit.listing, unit.amenities?.join(" "), unit.accessNotes].filter(Boolean).join(" "),
      });
    });
  });
  return rows;
}

function selectedPropertyForUnit(snapshot: AdminSnapshot, unit?: AdminUnitView): AdminPropertyView | undefined {
  // Keep a unit record open when the source supplied a candidate property id
  // but marked the relationship uncertain. The detail view shows that link as
  // Needs review; dropping the record would hide useful positive unit facts.
  if (!unit?.propertyId) return undefined;
  return snapshot.snapshot.properties.find((property) => property.id === unit.propertyId);
}

/** Resolve the current record while retaining an explicit URL selection when a search query changes. */
export function resolvePropertyUnitSelection(
  snapshot: AdminSnapshot,
  filters: Pick<ViewFilters, "propertyId" | "propertyScope">,
  selectedPropertyId?: string,
  selectedUnitId?: string,
  search = "",
): PropertyUnitSelection | undefined {
  const properties = snapshot.snapshot.properties.filter((property) => propertyInFilters(property, filters)).sort(compareProperties);
  const list = propertyUnitListItems(snapshot, filters, search);
  const visiblePropertyIds = new Set(list.filter((row) => row.kind === "property" && row.id).map((row) => row.id));

  if (selectedUnitId) {
    const unit = snapshot.snapshot.units.find((candidate) => candidate.id === selectedUnitId);
    const property = selectedPropertyForUnit(snapshot, unit);
    if (unit && property && propertyInFilters(property, filters)) return { kind: "unit", property, unit };
  }

  if (selectedPropertyId) {
    const property = properties.find((candidate) => candidate.id === selectedPropertyId);
    if (property) return { kind: "property", property };
  }

  const firstMatchedProperty = properties.find((property) => !search || visiblePropertyIds.has(property.id));
  if (firstMatchedProperty) return { kind: "property", property: firstMatchedProperty };

  // Orphaned unit rows remain reviewable when no property record is available.
  const firstUnitRow = list.find((row) => row.kind === "unit" && row.id);
  if (firstUnitRow) {
    const unit = snapshot.snapshot.units.find((candidate) => candidate.id === firstUnitRow.id);
    const property = selectedPropertyForUnit(snapshot, unit);
    if (unit) return { kind: "unit", property, unit };
  }
  return undefined;
}

/** Values expected by the existing property form and mutationPayload helper. */
export function propertyEditValues(property: AdminPropertyView): FormValues {
  return {
    id: property.id,
    revision: property.recordRevision ?? 1,
    name: property.name,
    slug: property.slug,
    address1: property.address?.line1 ?? "",
    city: property.address?.city ?? "",
    stateCode: property.address?.state ?? "",
    postalCode: property.address?.postalCode ?? "",
    propertyType: property.propertyType,
    propertyState: property.state,
    operatingContact: property.operatingContact ?? "",
  };
}

/** Values expected by the existing unit form and mutationPayload helper. */
export function unitEditValues(unit: AdminUnitView): FormValues {
  return {
    id: unit.id,
    revision: unit.recordRevision ?? 1,
    propertyId: unit.propertyId,
    unitNumber: unit.unitNumber,
    unitType: unit.unitType ?? "",
    squareFeet: unit.squareFeet == null ? "" : String(unit.squareFeet),
    defaultDepositDollars: centsAsDollars(unit.defaultDepositCents),
    amenitiesText: unit.amenities?.join("\n") ?? "",
    accessNotes: unit.accessNotes ?? "",
    bedrooms: unit.bedrooms == null ? "" : String(unit.bedrooms),
    bathrooms: unit.bathrooms == null ? "" : String(unit.bathrooms),
    marketRentDollars: centsAsDollars(unit.marketRentCents),
    readiness: unit.readiness,
    listing: unit.listing,
  };
}

export function addUnitValues(property: AdminPropertyView): FormValues {
  return { propertyId: property.id };
}

// Descriptive aliases make the payload identity explicit at call sites and
// keep tests independent of the component's JSX details.
export const buildPropertyEditValues = propertyEditValues;
export const buildUnitEditValues = unitEditValues;

export function propertyUnits(snapshot: AdminSnapshot, propertyId?: string): AdminUnitView[] {
  if (!propertyId) return [];
  return snapshot.snapshot.units.filter((unit) => unit.propertyId === propertyId && knownLink(unit.propertyId, unit.propertyLinkKnowledge)).sort(compareUnits);
}

export function propertyForUnit(snapshot: AdminSnapshot, unit?: AdminUnitView): AdminPropertyView | undefined {
  return selectedPropertyForUnit(snapshot, unit);
}

export function knownTenanciesForUnit(snapshot: AdminSnapshot, unitId?: string): AdminTenancyView[] {
  if (!unitId) return [];
  return snapshot.snapshot.tenancies.filter((tenancy) => tenancy.unitId === unitId && knownLink(tenancy.unitId, tenancy.unitLinkKnowledge));
}

export function knownLeaseTermsForTenancy(snapshot: AdminSnapshot, tenancyId?: string): AdminLeaseTermView[] {
  if (!tenancyId) return [];
  return snapshot.snapshot.leaseTerms.filter((term) => term.tenancyId === tenancyId && knownLink(term.tenancyId, term.tenancyLinkKnowledge));
}

function occupantName(snapshot: AdminSnapshot, tenancy?: AdminTenancyView): string | undefined {
  if (!tenancy?.primaryPersonId || !knownLink(tenancy.primaryPersonId, tenancy.primaryPersonLinkKnowledge)) return undefined;
  const person = snapshot.snapshot.people.find((candidate) => candidate.id === tenancy.primaryPersonId);
  if (!person) return undefined;
  return [person.firstName, person.lastName].map(text).filter(Boolean).join(" ") || undefined;
}

function occupancyStatus(tenancy?: AdminTenancyView): string {
  if (!tenancy || UNKNOWN_LINK_VALUES.has(lower(tenancy.statusKnowledge))) return "unknown";
  if (tenancy.status === "future") return "future_preleased";
  if (tenancy.status === "current" || tenancy.status === "notice") return "current";
  return text(tenancy.status) || "unknown";
}

/**
 * Build history rows only from known unit-linked tenancies and their known
 * lease terms. Units without a linked tenancy get one explicit unknown row;
 * they are never called vacant because an empty link is not proof of vacancy.
 */
export function occupancyHistoryForUnit(snapshot: AdminSnapshot, unit: AdminUnitView): OccupancyHistoryRecord[] {
  const tenancies = knownTenanciesForUnit(snapshot, unit.id);
  if (!tenancies.length) {
    return [{ key: `unit:${unit.id ?? "unknown"}:occupancy:unknown`, unit, occupancyStatus: "unknown" }];
  }

  return tenancies.flatMap((tenancy, tenancyIndex) => {
    const leases = knownLeaseTermsForTenancy(snapshot, tenancy.id);
    if (!leases.length) {
      return [{
        key: `tenancy:${tenancy.id ?? tenancyIndex}`,
        unit,
        tenancy,
        occupantName: occupantName(snapshot, tenancy),
        occupancyStatus: occupancyStatus(tenancy),
      }];
    }
    return leases.map((lease, leaseIndex) => ({
      key: `lease:${lease.id ?? `${tenancy.id ?? tenancyIndex}:${leaseIndex}`}`,
      unit,
      tenancy,
      lease,
      occupantName: occupantName(snapshot, tenancy),
      occupancyStatus: occupancyStatus(tenancy),
    }));
  });
}

export function occupancyHistoryForProperty(snapshot: AdminSnapshot, propertyId?: string): OccupancyHistoryRecord[] {
  const units = propertyUnits(snapshot, propertyId);
  return units.flatMap((unit) => occupancyHistoryForUnit(snapshot, unit));
}

export function occupancySummaryForUnits(snapshot: AdminSnapshot, units: AdminUnitView[]): { current: number; future: number; unknown: number; linkedHistory: number } {
  const rows = units.flatMap((unit) => occupancyHistoryForUnit(snapshot, unit));
  const byUnit = new Map<string, OccupancyHistoryRecord>();
  for (const row of rows) {
    const unitId = row.unit.id;
    if (!unitId) continue;
    const current = byUnit.get(unitId);
    if (!current) {
      byUnit.set(unitId, row);
      continue;
    }
    const rank = (status: string): number => status === "current" ? 3 : status === "future_preleased" ? 2 : status === "unknown" ? 0 : 1;
    if (rank(row.occupancyStatus) > rank(current.occupancyStatus)) byUnit.set(unitId, row);
  }
  let current = 0;
  let future = 0;
  let unknown = 0;
  for (const unit of units) {
    const row = unit.id ? byUnit.get(unit.id) : undefined;
    if (!row || row.occupancyStatus === "unknown") unknown += 1;
    else if (row.occupancyStatus === "current") current += 1;
    else if (row.occupancyStatus === "future_preleased") future += 1;
  }
  return { current, future, unknown, linkedHistory: rows.filter((row) => row.tenancy).length };
}

function scheduleMatchesProperty(schedule: AdminRecurringScheduleView, propertyId: string): boolean {
  return schedule.propertyId === propertyId || (schedule.scopeType === "property" && schedule.scopeId === propertyId);
}

function relationshipForSchedule(schedule: AdminRecurringScheduleView, unit: AdminUnitView, propertyId: string): RecurringRelationship {
  if (schedule.scopeType === "property" && schedule.scopeId === propertyId) return "inherited";
  if (schedule.scopeType === "unit" && schedule.scopeId === unit.id) return "direct";
  if (schedule.scopeType === "tenant" && (schedule.unitId === unit.id || schedule.tenancyId)) return "tenant-linked";
  if (schedule.unitId === unit.id) return schedule.scopeType === "property" ? "inherited" : "linked";
  if (schedule.propertyId === propertyId && schedule.scopeType === "property") return "inherited";
  return "unresolved";
}

function relationshipLabel(relationship: RecurringRelationship): string {
  switch (relationship) {
    case "direct": return "Direct · unit";
    case "inherited": return "Inherited · property";
    case "tenant-linked": return "Tenant-linked";
    case "linked": return "Linked record";
    default: return "Needs review";
  }
}

/**
 * Include all schedules explicitly attributable to a unit. Property-scoped
 * schedules are marked inherited; unit-scoped schedules are direct; tenant
 * schedules stay tenant-linked so a property-wide charge is never mistaken
 * for a unit's base rent.
 */
export function recurringSchedulesForUnit(snapshot: AdminSnapshot, unit: AdminUnitView): UnitRecurringRecord[] {
  const propertyId = text(unit.propertyId);
  if (!propertyId || !unit.id) return [];
  const tenancyIds = new Set(knownTenanciesForUnit(snapshot, unit.id).map((tenancy) => tenancy.id));
  const propertyLinkKnown = knownLink(unit.propertyId, unit.propertyLinkKnowledge);
  const rows: UnitRecurringRecord[] = [];
  snapshot.snapshot.recurringSchedules.forEach((schedule, index) => {
    const linkedTenancy = Boolean(schedule.tenancyId && tenancyIds.has(schedule.tenancyId));
    const relationship = linkedTenancy && schedule.scopeType === "tenant" ? "tenant-linked" : relationshipForSchedule(schedule, unit, propertyId);
    const matches = schedule.unitId === unit.id
      || (schedule.scopeType === "unit" && schedule.scopeId === unit.id)
      || linkedTenancy
      || (propertyLinkKnown && schedule.scopeType === "property" && schedule.scopeId === propertyId)
      || (propertyLinkKnown && schedule.scopeType === "property" && schedule.propertyId === propertyId);
    if (!matches || relationship === "unresolved") return;
    rows.push({
      key: `schedule:${schedule.id ?? `${unit.id}:${index}`}`,
      schedule,
      relationship,
      relationshipLabel: relationshipLabel(relationship),
    });
  });
  return rows;
}

export function recurringSchedulesForProperty(snapshot: AdminSnapshot, propertyId?: string): UnitRecurringRecord[] {
  if (!propertyId) return [];
  const units = propertyUnits(snapshot, propertyId);
  const unitIds = new Set(units.map((unit) => unit.id).filter(Boolean));
  const tenancyIds = new Set(snapshot.snapshot.tenancies.filter((tenancy) => tenancy.propertyId === propertyId && knownLink(tenancy.propertyId, tenancy.propertyLinkKnowledge)).map((tenancy) => tenancy.id).filter(Boolean));
  return snapshot.snapshot.recurringSchedules.flatMap((schedule, index) => {
    if (scheduleMatchesProperty(schedule, propertyId)) {
      const unit = units.find((candidate) => candidate.id === schedule.unitId) ?? units[0];
      const relationship: RecurringRelationship = schedule.scopeType === "property" && (schedule.scopeId === propertyId || schedule.propertyId === propertyId) ? "direct" : unit ? relationshipForSchedule(schedule, unit, propertyId) : "linked";
      return [{ key: `schedule:${schedule.id ?? `${propertyId}:${index}`}`, schedule, relationship, relationshipLabel: relationship === "direct" && schedule.scopeType === "property" ? "Direct · property" : relationshipLabel(relationship) }];
    }
    const scopedUnitId = schedule.scopeType === "unit" ? schedule.scopeId : schedule.unitId;
    if (scopedUnitId && unitIds.has(scopedUnitId)) {
      const unit = units.find((candidate) => candidate.id === scopedUnitId);
      if (!unit) return [];
      const relationship = relationshipForSchedule(schedule, unit, propertyId);
      return relationship === "unresolved" ? [] : [{ key: `schedule:${schedule.id ?? `${propertyId}:${index}`}`, schedule, relationship, relationshipLabel: relationshipLabel(relationship) }];
    }
    if (schedule.tenancyId && tenancyIds.has(schedule.tenancyId)) {
      return [{ key: `schedule:${schedule.id ?? `${propertyId}:${index}`}`, schedule, relationship: "tenant-linked", relationshipLabel: "Tenant-linked" }];
    }
    return [];
  });
}

export function availablePropertyTabs(snapshot: AdminSnapshot, property: AdminPropertyView): PropertyUnitTab[] {
  const units = propertyUnits(snapshot, property.id);
  const schedules = recurringSchedulesForProperty(snapshot, property.id);
  return [
    "general",
    "units",
    ...(units.length || occupancyHistoryForProperty(snapshot, property.id).length ? ["occupancy" as const] : []),
    "recurring",
    ...(units.length ? ["marketing" as const] : []),
  ];
}

export function availableUnitTabs(snapshot: AdminSnapshot, unit: AdminUnitView): PropertyUnitTab[] {
  const recurring = recurringSchedulesForUnit(snapshot, unit);
  const hasMarketing = unit.readiness !== undefined || unit.listing !== undefined || unit.accessNotes !== undefined;
  return [
    "general",
    ...(occupancyHistoryForUnit(snapshot, unit).length ? ["occupancy" as const] : []),
    "recurring",
    ...(hasMarketing ? ["marketing" as const] : []),
  ];
}

/** Preserve source records while displaying the server-validated replacement interval. */
export function propertyUnitRecurringDisplay(record: UnitRecurringRecord, asOfDate: string) {
  const interval = scheduleDisplayInterval(record.schedule, asOfDate);
  return {
    ...interval,
    effectiveFrom: interval.uncertaintyCodes.includes("schedule_dates_unconfirmed") ? undefined : interval.effectiveFrom,
    effectiveTo: interval.uncertaintyCodes.includes("schedule_dates_unconfirmed") ? undefined : interval.effectiveTo,
  };
}

export function recurringRecordCreateValues(snapshot: AdminSnapshot, propertyId?: string, unit?: AdminUnitView): FormValues | undefined {
  if (!propertyId || !snapshot.snapshot.properties.some(property => property.id === propertyId)) return undefined;
  if (unit && (!unit.id || unit.propertyId !== propertyId || !knownLink(unit.propertyId, unit.propertyLinkKnowledge))) return undefined;
  return { propertyId, scopeType: unit ? "unit" : "property", scopeId: unit?.id ?? propertyId, ...(unit ? { unitId: unit.id } : {}) };
}

export function recurringRecordSuccessorValues(snapshot: AdminSnapshot, schedule: AdminRecurringScheduleView): FormValues | undefined {
  if (!schedule.id || schedule.lineageState !== "valid" || schedule.canScheduleSuccessor !== true || !Number.isInteger(schedule.recordRevision) || schedule.recordRevision! < 1) return undefined;
  if (!schedule.propertyId || !snapshot.snapshot.properties.some(property => property.id === schedule.propertyId)) return undefined;
  if (schedule.scopeType === "property") {
    if (schedule.scopeId !== schedule.propertyId) return undefined;
  } else if (schedule.scopeType === "unit") {
    if (!snapshot.snapshot.units.some(unit => unit.id === schedule.scopeId && unit.propertyId === schedule.propertyId && knownLink(unit.propertyId, unit.propertyLinkKnowledge))) return undefined;
  } else if (schedule.scopeType === "tenant") {
    if (!schedule.scopeId || !snapshot.snapshot.people.some(person => person.id === schedule.scopeId)) return undefined;
    if (!snapshot.snapshot.tenancies.some(tenancy => tenancy.propertyId === schedule.propertyId && tenancy.primaryPersonId === schedule.scopeId && knownLink(tenancy.propertyId, tenancy.propertyLinkKnowledge) && knownLink(tenancy.primaryPersonId, tenancy.primaryPersonLinkKnowledge))) return undefined;
  } else return undefined;
  return { predecessorId: schedule.id, expectedRevision: schedule.recordRevision, effectiveFrom: "", amountDollars: "" };
}
