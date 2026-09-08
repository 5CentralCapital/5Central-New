import type {
  ApplicantPublicView,
  RentOpsSnapshot,
} from "../../../shared/rent-ops-contracts";
import { isoDateSchema } from "../../../shared/rent-ops-contracts";
import {
  booleanValue,
  finiteNumberValue,
  isRecord,
  JsonObject,
  presentationObject,
  recordArrayValue,
  stringValue,
} from "./allowlist";
import {
  serializeApplicationPreferences,
  documentDownloadAvailable,
  serializeEmergencyContact,
  serializeEmployment,
  serializeHouseholdSummary,
  serializePet,
  serializeRentalHistory,
  serializeVehicle,
  serializeVoucher,
} from "./entities";

function inputOf(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function text(input: JsonObject, field: string): string | undefined {
  return stringValue(input[field]);
}

function number(input: JsonObject, field: string): number | undefined {
  return finiteNumberValue(input[field]);
}

function bool(input: JsonObject, field: string): boolean | undefined {
  return booleanValue(input[field]);
}

function trustedNative(input: JsonObject): boolean {
  // The route serializer carries this marker on its short-lived internal
  // rehydration object. Domain records use the absence of an import source.
  return input.trustedNative === true || (input.trustedNative !== false && input.source === undefined);
}

function knownFact(input: JsonObject, knowledgeField: string, isNative = trustedNative(input)): boolean {
  const knowledge = input[knowledgeField];
  // Native rows may rely on their bounded app's local facts. Imported rows
  // must carry explicit source, confirmed, or manual knowledge; unknown, ambiguous, and
  // inferred values never become applicant-facing inventory.
  if (knowledge === undefined) return isNative;
  return knowledge === "source" || knowledge === "confirmed" || knowledge === "manual";
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function knownDateValue(input: JsonObject, field: string, knowledgeField: string, isNative: boolean): string | undefined {
  const value = input[field];
  return typeof value === "string"
    && isoDateSchema.safeParse(value).success
    && knownFact(input, knowledgeField, isNative)
    ? value
    : undefined;
}

type LinkState = "exact" | "other" | "unknown";
type VacancyState = "vacant" | "occupied" | "unknown";

function linkState(input: JsonObject, idField: string, knowledgeField: string, targetId: string, isNative: boolean): LinkState {
  if (!nonEmptyText(input[idField])) return "unknown";
  const exact = input[knowledgeField] === "exact" || input[knowledgeField] === "manual" || (input[knowledgeField] === undefined && isNative);
  if (!exact) return "unknown";
  return input[idField] === targetId ? "exact" : "other";
}

function publicPropertyFacts(value: unknown): boolean {
  const input = inputOf(value);
  const isNative = trustedNative(input);
  if (!nonEmptyText(input.id) || !nonEmptyText(input.name) || !nonEmptyText(input.slug)) return false;
  if (input.state !== "active") return false;
  if (!knownFact(input, "nameKnowledge", isNative) || !knownFact(input, "addressKnowledge", isNative) || !knownFact(input, "stateKnowledge", isNative)) return false;
  const address = input.address;
  if (!isRecord(address)) return false;
  return ["line1", "city", "state", "postalCode"].every((field) => nonEmptyText(address[field]));
}

function publicUnitFacts(value: unknown, propertyId: string): boolean {
  const input = inputOf(value);
  const isNative = trustedNative(input);
  if (!nonEmptyText(input.id) || input.propertyId !== propertyId || !nonEmptyText(input.unitNumber)) return false;
  if (input.readiness !== "ready" || input.listing !== "listed") return false;
  if (!knownFact(input, "unitNumberKnowledge", isNative) || !knownFact(input, "readinessKnowledge", isNative) || !knownFact(input, "listingKnowledge", isNative)) return false;
  // The unit-to-property relationship is part of the public inventory
  // boundary. Native rows may use their typed local relationship; imported
  // rows must prove an exact source or explicitly reviewed manual relationship.
  return input.propertyLinkKnowledge === "exact" || input.propertyLinkKnowledge === "manual" || (input.propertyLinkKnowledge === undefined && isNative);
}

function tenancyRelation(value: unknown, propertyId: string, unitId: string): "linked" | "none" | "unknown" {
  const input = inputOf(value);
  const isNative = trustedNative(input);
  const property = linkState(input, "propertyId", "propertyLinkKnowledge", propertyId, isNative);
  const unit = linkState(input, "unitId", "unitLinkKnowledge", unitId, isNative);
  if (property === "exact" && unit === "exact") return "linked";
  if (property === "exact" && unit === "other") return "none";
  if (property === "other" && (unit === "other" || unit === "unknown")) return "none";
  if (property === "unknown" && unit === "other") return "none";
  // One exact link paired with an unknown link, or conflicting exact links,
  // cannot prove that the tenancy is unrelated to this public unit.
  return "unknown";
}

function publicVacancyState(tenancies: readonly unknown[], propertyId: string, unitId: string, asOf: string): VacancyState {
  if (!isoDateSchema.safeParse(asOf).success) return "unknown";
  for (const tenancy of tenancies) {
    const relation = tenancyRelation(tenancy, propertyId, unitId);
    if (relation === "none") continue;
    if (relation === "unknown") return "unknown";

    const input = inputOf(tenancy);
    const isNative = trustedNative(input);
    if (!knownFact(input, "statusKnowledge", isNative)) return "unknown";
    const status = input.status;
    if (typeof status !== "string") return "unknown";

    if (status === "current" || status === "notice") {
      const actualMoveInOn = knownDateValue(input, "actualMoveInOn", "actualMoveInKnowledge", isNative);
      if (!actualMoveInOn || actualMoveInOn > asOf) return "unknown";
      if (input.actualMoveOutOn !== undefined) {
        const actualMoveOutOn = knownDateValue(input, "actualMoveOutOn", "actualMoveOutKnowledge", isNative);
        if (!actualMoveOutOn) return "unknown";
        // A current/notice row with a completed move-out conflicts with its
        // status. Do not turn contradictory data into a public vacancy.
        if (actualMoveOutOn <= asOf) return "unknown";
      }
      return "occupied";
    }

    if (status === "future") {
      // Legacy native snapshots used actualMoveInOn for prospective move-in;
      // imported rows must expose the explicit planned date instead.
      const plannedDate = input.plannedMoveInOn !== undefined
        ? knownDateValue(input, "plannedMoveInOn", "plannedMoveInKnowledge", isNative)
        : isNative ? knownDateValue(input, "actualMoveInOn", "actualMoveInKnowledge", isNative) : undefined;
      if (!plannedDate || plannedDate <= asOf) return "unknown";
      return "occupied";
    }

    if (status === "past") {
      const actualMoveOutOn = knownDateValue(input, "actualMoveOutOn", "actualMoveOutKnowledge", isNative);
      if (!actualMoveOutOn || actualMoveOutOn > asOf) return "unknown";
      if (input.actualMoveInOn !== undefined && !knownDateValue(input, "actualMoveInOn", "actualMoveInKnowledge", isNative)) return "unknown";
      continue;
    }

    if (status === "cancelled") {
      if (input.actualMoveInOn !== undefined && !knownDateValue(input, "actualMoveInOn", "actualMoveInKnowledge", isNative)) return "unknown";
      if (input.actualMoveOutOn !== undefined && !knownDateValue(input, "actualMoveOutOn", "actualMoveOutKnowledge", isNative)) return "unknown";
      continue;
    }

    return "unknown";
  }
  return "vacant";
}

function isRentOpsSnapshot(value: unknown): value is RentOpsSnapshot {
  return isRecord(value)
    && Array.isArray(value.properties)
    && Array.isArray(value.units)
    && Array.isArray(value.tenancies);
}

/**
 * Single server-side truth predicate for applicant inventory. Both public
 * listing serialization and token-scoped application saves call this exact
 * predicate, so a direct caller cannot select a row hidden from listings.
 */
export function isPublicApplicationInventory(
  property: unknown,
  unit: unknown,
  tenancies?: readonly unknown[],
  asOf?: string,
): boolean;
export function isPublicApplicationInventory(
  snapshot: RentOpsSnapshot,
  propertyId: unknown,
  unitId?: unknown,
  asOf?: string,
): boolean;
export function isPublicApplicationInventory(
  propertyOrSnapshot: unknown,
  unitOrPropertyId: unknown,
  tenanciesOrUnitId: readonly unknown[] | unknown = [],
  asOf = "9999-12-31",
): boolean {
  let property: unknown = propertyOrSnapshot;
  let unit: unknown = unitOrPropertyId;
  let tenancies: readonly unknown[] = Array.isArray(tenanciesOrUnitId) ? tenanciesOrUnitId : [];
  let effectiveAsOf = asOf;

  // Service callers may use the durable snapshot form. Presentation callers
  // use the direct property/unit/tenancy form and never need a fabricated
  // snapshot just to re-run the same facts.
  if (isRentOpsSnapshot(propertyOrSnapshot)) {
    const snapshot = propertyOrSnapshot;
    const propertyId = unitOrPropertyId;
    const unitId = Array.isArray(tenanciesOrUnitId) ? undefined : tenanciesOrUnitId;
    effectiveAsOf = typeof asOf === "string" ? asOf : "9999-12-31";
    property = snapshot.properties.find((candidate) => isRecord(candidate) && candidate.id === propertyId);
    unit = unitId === undefined ? undefined : snapshot.units.find((candidate) => isRecord(candidate) && candidate.id === unitId);
    tenancies = snapshot.tenancies;
  }

  const propertyInput = inputOf(property);
  if (!publicPropertyFacts(propertyInput)) return false;
  if (unit === undefined) return true;
  const propertyId = propertyInput.id;
  if (!nonEmptyText(propertyId) || !publicUnitFacts(unit, propertyId)) return false;
  const unitInput = inputOf(unit);
  const unitId = unitInput.id;
  if (!nonEmptyText(unitId)) return false;
  return publicVacancyState(tenancies, propertyId, unitId, effectiveAsOf) === "vacant";
}

export interface PublicListingUnitView {
  id?: string;
  unitNumber?: string;
  unitType?: string;
  bedrooms?: number;
  bathrooms?: number;
  marketRentCents?: number;
}

export interface PublicListingView {
  id?: string;
  name?: string;
  slug?: string;
  units: PublicListingUnitView[];
}

export function serializePublicListingUnit(value: unknown): PublicListingUnitView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    unitNumber: text(input, "unitNumber"),
    unitType: text(input, "unitType"),
    bedrooms: number(input, "bedrooms"),
    bathrooms: number(input, "bathrooms"),
    marketRentCents: number(input, "marketRentCents"),
  });
}

export function serializePublicListing(value: unknown): PublicListingView {
  const input = inputOf(value);
  const tenancies = recordArrayValue(input.tenancies) ?? [];
  return presentationObject({
    id: text(input, "id"),
    name: text(input, "name"),
    slug: text(input, "slug"),
    units: (recordArrayValue(input.units) ?? [])
      .filter((unit) => isPublicApplicationInventory(input, unitForListingEligibility(input, unit), tenancies))
      .map(serializePublicListingUnit),
  });
}

function unitForListingEligibility(property: JsonObject, unit: JsonObject): JsonObject {
  // Nested listing rows carry the parent property relationship even though
  // that internal link is intentionally omitted from the public DTO. Preserve
  // an explicitly supplied relationship so a conflicting link still fails.
  return unit.propertyId === undefined ? { ...unit, propertyId: property.id } : unit;
}

export function serializePublicListings(value: unknown): PublicListingView[] {
  return (recordArrayValue(value) ?? [])
    .filter((input) => isPublicApplicationInventory(input, undefined, recordArrayValue(input.tenancies) ?? []))
    .map(serializePublicListing);
}

export const serializePublicApplicationOptions = serializePublicListings;
export const serializeListingViews = serializePublicListings;

export interface PublicApplicationHouseholdMemberView {
  id?: string;
  firstName?: string;
  lastName?: string;
  relationship?: string;
  email?: string;
  phone?: string;
  isMinor?: boolean;
}

function serializePublicHouseholdMember(value: unknown): PublicApplicationHouseholdMemberView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    firstName: text(input, "firstName"),
    lastName: text(input, "lastName"),
    relationship: text(input, "relationship"),
    email: text(input, "email"),
    phone: text(input, "phone"),
    isMinor: bool(input, "isMinor"),
  });
}

export interface PublicApplicationRequirementView {
  id?: string;
  label?: string;
  status?: string;
  documentId?: string;
  requestedOn?: string;
  resolvedOn?: string;
}

function serializePublicRequirement(value: unknown): PublicApplicationRequirementView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    label: text(input, "label"),
    status: text(input, "status"),
    documentId: text(input, "documentId"),
    requestedOn: text(input, "requestedOn"),
    resolvedOn: text(input, "resolvedOn"),
  });
}

export interface PublicDocumentView {
  id?: string;
  type?: string;
  state?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  downloadAvailable: boolean;
}

export function serializePublicDocument(value: unknown): PublicDocumentView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    type: text(input, "type"),
    state: text(input, "state"),
    fileName: text(input, "fileName"),
    mimeType: text(input, "mimeType"),
    sizeBytes: number(input, "sizeBytes"),
    uploadedAt: text(input, "uploadedAt"),
    downloadAvailable: documentDownloadAvailable(value),
  });
}

export interface PublicApplicationView {
  id?: string;
  status?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  propertyId?: string;
  unitId?: string;
  submittedOn?: string;
  certificationAcceptedOn?: string;
  rentalHistory?: JsonObject;
  employment?: JsonObject;
  householdSummary?: JsonObject;
  preferences?: JsonObject;
  voucher?: JsonObject;
  pets?: JsonObject[];
  vehicles?: JsonObject[];
  emergencyContact?: JsonObject;
  householdMembers: PublicApplicationHouseholdMemberView[];
  requirements: PublicApplicationRequirementView[];
  documents: PublicDocumentView[];
}

/**
 * Public application state is scoped by the bearer token at the route. The
 * view contains only fields the applicant can edit or review; persistence
 * resume hashes, delivery tokens, source metadata, and internal linkage are
 * never copied.
 */
export function serializePublicApplication(value: ApplicantPublicView | unknown): PublicApplicationView {
  const input = inputOf(value);
  return presentationObject({
    id: text(input, "id"),
    status: text(input, "status"),
    email: text(input, "email"),
    firstName: text(input, "firstName"),
    lastName: text(input, "lastName"),
    phone: text(input, "phone"),
    propertyId: text(input, "propertyId"),
    unitId: text(input, "unitId"),
    submittedOn: text(input, "submittedOn"),
    certificationAcceptedOn: text(input, "certificationAcceptedOn"),
    rentalHistory: isRecord(input.rentalHistory) ? serializeRentalHistory(input.rentalHistory) : undefined,
    employment: isRecord(input.employment) ? serializeEmployment(input.employment) : undefined,
    householdSummary: isRecord(input.householdSummary) ? serializeHouseholdSummary(input.householdSummary) : undefined,
    preferences: isRecord(input.preferences) ? serializeApplicationPreferences(input.preferences) : undefined,
    voucher: isRecord(input.voucher) ? serializeVoucher(input.voucher) : undefined,
    pets: recordArrayValue(input.pets)?.map(serializePet),
    vehicles: recordArrayValue(input.vehicles)?.map(serializeVehicle),
    emergencyContact: isRecord(input.emergencyContact) ? serializeEmergencyContact(input.emergencyContact) : undefined,
    householdMembers: (recordArrayValue(input.householdMembers) ?? []).map(serializePublicHouseholdMember),
    requirements: (recordArrayValue(input.requirements) ?? []).map(serializePublicRequirement),
    documents: (recordArrayValue(input.documents) ?? []).map(serializePublicDocument),
  }) as unknown as PublicApplicationView;
}

export const serializeApplicantPublicView = serializePublicApplication;
export const serializePublicApplicationView = serializePublicApplication;

export interface PublicApplicationResultView {
  application?: PublicApplicationView;
  accepted?: boolean;
  expiresAt?: string;
}

/** Start/resume results are safe even if a service accidentally includes a token. */
export function serializePublicApplicationResult(value: unknown): PublicApplicationResultView {
  const input = inputOf(value);
  return presentationObject({
    application: isRecord(input.application) ? serializePublicApplication(input.application) : undefined,
    accepted: bool(input, "accepted"),
    expiresAt: text(input, "expiresAt"),
  });
}

export const serializePublicResult = serializePublicApplicationResult;
