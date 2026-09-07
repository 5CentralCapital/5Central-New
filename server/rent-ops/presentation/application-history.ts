import type {
  ApplicationHistoryAnswerValueType,
  ApplicationHistoryBlockerCode,
  ApplicationHistoryValueKnowledge,
  ApplicationRequirementStatus,
  ApplicationStatus,
  RentOpsApplicationCase,
  RentOpsApplicationHistoryActivity,
  RentOpsApplicationHistoryBlocker,
  RentOpsApplicationHistoryDocument,
  RentOpsApplicationInterest,
  RentOpsApplicationParticipant,
  RentOpsApplicationRequirementOccurrence,
  RentOpsHistoricalApplication,
  RentOpsProspect,
} from "../../../shared/rent-ops-contracts";
import {
  ACTIVITY_TYPES,
  APPLICATION_HISTORY_ANSWER_VALUE_TYPES,
  APPLICATION_HISTORY_BLOCKER_CODES,
  APPLICATION_HISTORY_VALUE_KNOWLEDGE,
  APPLICATION_REQUIREMENT_STATUSES,
  APPLICATION_STATUSES,
  DOCUMENT_AVAILABILITIES,
  DOCUMENT_STATES,
  DOCUMENT_TYPES,
  FACT_KNOWLEDGE,
  LINK_KNOWLEDGE,
} from "../../../shared/rent-ops-contracts";
import { presentationObject } from "./allowlist";

/**
 * Historical application rows contain source identities, link targets, and
 * restricted fields that are useful to the import boundary but not to the
 * browser. This DTO is intentionally a separate positive contract rather
 * than a filtered copy of the internal case aggregate.
 */
export interface AdminApplicationHistoryPartyView {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  status?: ApplicationStatus;
  statusKnowledge?: string;
  submittedOn?: string;
  submittedOnKnowledge?: string;
  createdOn?: string;
  createdOnKnowledge?: string;
  updatedOn?: string;
  updatedOnKnowledge?: string;
}

export interface AdminApplicationHistoryApplicationView extends AdminApplicationHistoryPartyView {
  /** Target application ID is the only historical case identity needed by the UI. */
  id: string;
}

export interface AdminApplicationHistoryInterestView {
  propertyId?: string;
  unitId?: string;
  sourceOrder?: number;
  sourceRank?: number;
  preference?: string;
  preferenceKnowledge?: string;
  interestedOn?: string;
  interestedOnKnowledge?: string;
  rentCents?: number;
  rentKnowledge?: string;
  bedrooms?: number;
  bedroomsKnowledge?: string;
  status?: string;
  statusKnowledge?: string;
}

export interface AdminApplicationHistoryParticipantView {
  sourceOrder?: number;
  role?: string;
  roleKnowledge?: string;
  relationship?: string;
  relationshipKnowledge?: string;
  isMinor?: boolean;
  minorKnowledge?: string;
  isFinanciallyResponsible?: boolean;
  financialResponsibilityKnowledge?: string;
}

export interface AdminApplicationHistoryRequirementView {
  label?: string;
  status?: ApplicationRequirementStatus;
  statusKnowledge?: string;
  requestedOn?: string;
  requestedOnKnowledge?: string;
  resolvedOn?: string;
  resolvedOnKnowledge?: string;
  hasDocument?: boolean;
}

export interface AdminApplicationHistoryAnswerView {
  valueType: ApplicationHistoryAnswerValueType;
  valueKnowledge: ApplicationHistoryValueKnowledge;
  fieldLinkKnowledge?: string;
}

export interface AdminApplicationHistoryDocumentView {
  type?: string;
  typeKnowledge?: string;
  state?: string;
  stateKnowledge?: string;
  fileName?: string;
  mimeType?: string;
  metadataSizeBytes?: number;
  availability: "metadata" | "unavailable";
}

export interface AdminApplicationHistoryActivityView {
  type?: string;
  occurredAt?: string;
  occurredAtKnowledge?: string;
  summary?: string;
  summaryKnowledge?: string;
}

export interface AdminApplicationHistoryBlockerView {
  code: ApplicationHistoryBlockerCode;
  occurrenceCount: number;
  reason: RentOpsApplicationHistoryBlocker["reason"];
}

export interface AdminApplicationHistoryUnknownRestrictedView {
  restrictedAnswerCount: number;
  unmappedAnswerCount: number;
  missingAnswerApplications: number;
  metadataOnlyDocumentCount: number;
  unavailableDocumentCount: number;
  unlinkedActivityCount: number;
  unlinkedInterestCount: number;
}

export interface AdminApplicationHistoryCaseView {
  application?: AdminApplicationHistoryApplicationView;
  prospect?: AdminApplicationHistoryPartyView;
  interests: AdminApplicationHistoryInterestView[];
  participants: AdminApplicationHistoryParticipantView[];
  requirements: AdminApplicationHistoryRequirementView[];
  answers: AdminApplicationHistoryAnswerView[];
  documents: AdminApplicationHistoryDocumentView[];
  activities: AdminApplicationHistoryActivityView[];
  blockers: AdminApplicationHistoryBlockerView[];
  unknownRestricted: AdminApplicationHistoryUnknownRestrictedView;
}

const MAX_DISPLAY_TEXT = 500;
const MAX_FILE_NAME = 240;

function text(value: unknown, max = MAX_DISPLAY_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  const candidate = number(value);
  return candidate !== undefined && Number.isSafeInteger(candidate) ? candidate : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function allowed<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? value as T : undefined;
}

function knowledge(value: unknown): string | undefined {
  return allowed(value, FACT_KNOWLEDGE);
}

function linkKnowledge(value: unknown): string | undefined {
  return allowed(value, LINK_KNOWLEDGE);
}

function date(value: unknown): string | undefined {
  return text(value, 40);
}

function timestamp(value: unknown): string | undefined {
  return text(value, 40);
}

function party(value: RentOpsProspect | RentOpsHistoricalApplication): AdminApplicationHistoryPartyView {
  return presentationObject({
    firstName: text(value.firstName),
    lastName: text(value.lastName),
    email: text(value.email, 240),
    phone: text(value.phone, 80),
    status: allowed(value.status, APPLICATION_STATUSES),
    statusKnowledge: knowledge(value.statusKnowledge),
    // Prospect rows use created/updated dates; historical applications also
    // carry submittedOn. The positive shape deliberately omits link IDs.
    submittedOn: date("submittedOn" in value ? value.submittedOn : undefined),
    submittedOnKnowledge: knowledge("submittedOnKnowledge" in value ? value.submittedOnKnowledge : undefined),
    createdOn: date(value.createdOn),
    createdOnKnowledge: knowledge(value.createdOnKnowledge),
    updatedOn: date(value.updatedOn),
    updatedOnKnowledge: knowledge(value.updatedOnKnowledge),
  });
}

function application(value: RentOpsHistoricalApplication): AdminApplicationHistoryApplicationView {
  return presentationObject({ id: text(value.id) ?? "unknown", ...party(value) });
}

function interest(value: RentOpsApplicationInterest): AdminApplicationHistoryInterestView {
  return presentationObject({
    // These are already-resolved operational targets, not raw provider IDs.
    propertyId: text(value.propertyId),
    unitId: text(value.unitId),
    sourceOrder: safeInteger(value.sourceOrder),
    sourceRank: safeInteger(value.sourceRank),
    preference: text(value.preference),
    preferenceKnowledge: knowledge(value.preferenceKnowledge),
    interestedOn: date(value.interestedOn),
    interestedOnKnowledge: knowledge(value.interestedOnKnowledge),
    rentCents: safeInteger(value.rentCents),
    rentKnowledge: allowed(value.rentKnowledge, ["known", "unknown"] as const),
    bedrooms: safeInteger(value.bedrooms),
    bedroomsKnowledge: knowledge(value.bedroomsKnowledge),
    // Interest statuses are not crosswalked in v9. Retain the value only as
    // a bounded display label when the projection explicitly marked it known.
    status: value.statusKnowledge === "source" ? text(value.status) : undefined,
    statusKnowledge: knowledge(value.statusKnowledge),
  });
}

function participant(value: RentOpsApplicationParticipant): AdminApplicationHistoryParticipantView {
  return presentationObject({
    sourceOrder: safeInteger(value.sourceOrder),
    role: text(value.role),
    roleKnowledge: knowledge(value.roleKnowledge),
    relationship: text(value.relationship),
    relationshipKnowledge: knowledge(value.relationshipKnowledge),
    isMinor: booleanValue(value.isMinor),
    minorKnowledge: knowledge(value.minorKnowledge),
    isFinanciallyResponsible: booleanValue(value.isFinanciallyResponsible),
    financialResponsibilityKnowledge: knowledge(value.financialResponsibilityKnowledge),
  });
}

function requirement(value: RentOpsApplicationRequirementOccurrence): AdminApplicationHistoryRequirementView {
  return presentationObject({
    label: text(value.label),
    status: allowed(value.status, APPLICATION_REQUIREMENT_STATUSES),
    statusKnowledge: knowledge(value.statusKnowledge),
    requestedOn: date(value.requestedOn),
    requestedOnKnowledge: knowledge(value.requestedOnKnowledge),
    resolvedOn: date(value.resolvedOn),
    resolvedOnKnowledge: knowledge(value.resolvedOnKnowledge),
    hasDocument: Boolean(value.documentId && value.documentLinkKnowledge === "exact"),
  });
}

function answer(value: RentOpsApplicationCase["answers"][number]): AdminApplicationHistoryAnswerView {
  return presentationObject({
    valueType: allowed(value.valueType, APPLICATION_HISTORY_ANSWER_VALUE_TYPES) ?? "text",
    valueKnowledge: allowed(value.valueKnowledge, APPLICATION_HISTORY_VALUE_KNOWLEDGE) ?? "unknown",
    fieldLinkKnowledge: linkKnowledge(value.fieldLinkKnowledge),
  });
}

function document(value: RentOpsApplicationHistoryDocument): AdminApplicationHistoryDocumentView {
  const availability = value.availability === "unavailable" ? "unavailable" : "metadata";
  return presentationObject({
    type: allowed(value.type, DOCUMENT_TYPES),
    typeKnowledge: knowledge(value.typeKnowledge),
    state: allowed(value.state, DOCUMENT_STATES),
    stateKnowledge: knowledge(value.stateKnowledge),
    fileName: text(value.fileName, MAX_FILE_NAME),
    mimeType: text(value.mimeType, 120),
    metadataSizeBytes: safeInteger(value.metadataSizeBytes),
    // Historical documents are never treated as verified/downloadable here.
    availability,
  });
}

function activity(value: RentOpsApplicationHistoryActivity): AdminApplicationHistoryActivityView {
  return presentationObject({
    type: allowed(value.type, ACTIVITY_TYPES),
    occurredAt: timestamp(value.occurredAt),
    occurredAtKnowledge: knowledge(value.occurredAtKnowledge),
    // Summary is admitted only when the projection received its dedicated
    // safe-field attestation. Actor/detail/body are intentionally absent.
    summary: value.summaryKnowledge === "source" ? text(value.summary) : undefined,
    summaryKnowledge: knowledge(value.summaryKnowledge),
  });
}

function blocker(value: RentOpsApplicationHistoryBlocker): AdminApplicationHistoryBlockerView {
  return presentationObject({
    code: allowed(value.code, APPLICATION_HISTORY_BLOCKER_CODES) ?? "application_answers_missing",
    occurrenceCount: Math.max(0, safeInteger(value.occurrenceCount) ?? 0),
    reason: allowed(value.reason, ["source_collection_missing", "source_collection_empty", "source_rows_unusable"] as const) ?? "source_rows_unusable",
  });
}

export function serializeAdminApplicationHistoryCase(value: RentOpsApplicationCase): AdminApplicationHistoryCaseView {
  // Keep the aggregate strongly typed at this boundary. Every nested object
  // below is still rebuilt field-by-field, so source/provider fields cannot
  // cross the boundary through object spreading or dynamic key iteration.
  const input: RentOpsApplicationCase = value;
  const applicationValue = input.application;
  const prospectValue = input.prospect;
  const unknownRestricted = input.unknownRestricted;
  return presentationObject({
    application: applicationValue ? application(applicationValue as RentOpsHistoricalApplication) : undefined,
    prospect: prospectValue ? party(prospectValue as RentOpsProspect) : undefined,
    interests: input.interests.map((item) => interest(item as RentOpsApplicationInterest)),
    participants: input.participants.map((item) => participant(item as RentOpsApplicationParticipant)),
    requirements: input.requirements.map((item) => requirement(item as RentOpsApplicationRequirementOccurrence)),
    answers: input.answers.map((item) => answer(item as RentOpsApplicationCase["answers"][number])),
    documents: input.documents.map((item) => document(item as RentOpsApplicationHistoryDocument)),
    activities: input.activities.map((item) => activity(item as RentOpsApplicationHistoryActivity)),
    blockers: input.blockers.map((item) => blocker(item as RentOpsApplicationHistoryBlocker)),
    unknownRestricted: presentationObject({
      restrictedAnswerCount: Math.max(0, safeInteger(unknownRestricted.restrictedAnswerCount) ?? 0),
      unmappedAnswerCount: Math.max(0, safeInteger(unknownRestricted.unmappedAnswerCount) ?? 0),
      missingAnswerApplications: Math.max(0, safeInteger(unknownRestricted.missingAnswerApplications) ?? 0),
      metadataOnlyDocumentCount: Math.max(0, safeInteger(unknownRestricted.metadataOnlyDocumentCount) ?? 0),
      unavailableDocumentCount: Math.max(0, safeInteger(unknownRestricted.unavailableDocumentCount) ?? 0),
      unlinkedActivityCount: Math.max(0, safeInteger(unknownRestricted.unlinkedActivityCount) ?? 0),
      unlinkedInterestCount: Math.max(0, safeInteger(unknownRestricted.unlinkedInterestCount) ?? 0),
    }),
  });
}

/** Short aliases make the positive boundary easy to use in route adapters. */
export const serializeApplicationHistoryCase = serializeAdminApplicationHistoryCase;
