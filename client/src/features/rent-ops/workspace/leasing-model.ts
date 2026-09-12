import { APPLICATION_STATUS_TRANSITIONS } from "../../../../../shared/application-status-transitions";
import { applicationDocumentDownloadable } from "../application-case-detail-model";
import type {
  AdminActivityView,
  AdminApplicationView,
  AdminDocumentView,
  AdminSnapshot,
  ViewFilters,
} from "../types";

/**
 * Filters owned by the compact leasing and document registers. The global
 * ViewFilters are accepted directly, while the optional date bounds let the
 * register narrow a loaded collection without changing the root snapshot.
 */
export interface LeasingRegisterFilters extends Partial<Pick<ViewFilters, "propertyScope" | "propertyId" | "status" | "search">> {
  unitId?: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
  type?: string;
}

const REVIEW_KNOWLEDGE = new Set(["unknown", "ambiguous", "inferred"]);

function normalized(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** Keep missing values and facts requiring review visibly different. */
export function leasingFact(value: unknown, knowledge?: string): string {
  if (knowledge && REVIEW_KNOWLEDGE.has(normalized(knowledge))) return "Needs review";
  if (!hasValue(value)) return "Unknown";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && !Number.isFinite(value)) return "Unknown";
  return String(value);
}

export function leasingLabel(value: unknown, knowledge?: string): string {
  const fact = leasingFact(value, knowledge);
  if (fact === "Unknown" || fact === "Needs review") return fact;
  return fact
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function applicationDisplayName(application: Pick<AdminApplicationView, "firstName" | "lastName">): string {
  const name = [application.firstName, application.lastName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return name || "Applicant needs review";
}

export function propertyDisplayName(snapshot: AdminSnapshot, propertyId?: string): string {
  if (!propertyId) return "Unknown property";
  const name = snapshot.snapshot.properties.find((property) => property.id === propertyId)?.name?.trim();
  return name || "Needs review";
}

export function unitDisplayName(snapshot: AdminSnapshot, unitId?: string): string {
  if (!unitId) return "Unknown unit";
  const unit = snapshot.snapshot.units.find((candidate) => candidate.id === unitId);
  return unit?.unitNumber?.trim() || "Needs review";
}

export function applicationUnitDisplayName(snapshot: AdminSnapshot, application: Pick<AdminApplicationView, "unitId">): string {
  return unitDisplayName(snapshot, application.unitId);
}

export function applicationLinkedRecordLabel(snapshot: AdminSnapshot, application: AdminApplicationView): string {
  const property = application.propertyId ? propertyDisplayName(snapshot, application.propertyId) : "Unknown property";
  const unit = application.unitId ? unitDisplayName(snapshot, application.unitId) : "Unknown unit";
  return `${applicationDisplayName(application)} · ${property} · ${unit}`;
}

export function applicationRecordKey(application: AdminApplicationView, index = 0): string {
  return application.id ?? `application:row:${index}`;
}

export function applicationStatusLabel(status?: string, knowledge?: string): string {
  return leasingLabel(status, knowledge);
}

/** Return only status transitions approved by the shared application contract. */
export function applicationStatusOptions(status?: string): string[] {
  const current = normalized(status);
  if (!current) return [];
  const transitions = APPLICATION_STATUS_TRANSITIONS[current as keyof typeof APPLICATION_STATUS_TRANSITIONS];
  return Array.from(new Set([current, ...(transitions ?? [])]));
}

export const nextApplicationStatuses = applicationStatusOptions;

export function isManualDecisionStatus(status?: string): boolean {
  const value = normalized(status);
  return value === "approved" || value === "declined";
}

export function applicationDateValue(application: Pick<AdminApplicationView, "submittedOn" | "createdAt" | "updatedAt">): string | undefined {
  return application.submittedOn ?? application.createdAt ?? application.updatedAt;
}

function dateInRange(value: string | undefined, filters: LeasingRegisterFilters): boolean {
  if (!filters.date && !filters.fromDate && !filters.toDate) return true;
  if (!value) return false;
  const date = value.slice(0, 10);
  if (filters.date && date !== filters.date.slice(0, 10)) return false;
  if (filters.fromDate && date < filters.fromDate.slice(0, 10)) return false;
  if (filters.toDate && date > filters.toDate.slice(0, 10)) return false;
  return true;
}

function propertyMatches(snapshot: AdminSnapshot, propertyId: string | undefined, filters: LeasingRegisterFilters): boolean {
  if (filters.propertyId !== "all" && filters.propertyId && propertyId !== filters.propertyId) return false;
  if ((filters.propertyScope ?? "active") !== "active" || !propertyId) return true;
  // Unknown links remain visible so an operator can resolve them. A known
  // archived property is excluded from the active portfolio view.
  const property = snapshot.snapshot.properties.find((candidate) => candidate.id === propertyId);
  return !property || property.state === "active";
}

function statusMatches(status: string | undefined, filters: LeasingRegisterFilters): boolean {
  const requested = normalized(filters.status);
  if (!requested || requested === "all") return true;
  return normalized(status || "unknown") === requested;
}

function textMatches(values: unknown[], search?: string): boolean {
  const query = normalized(search).replace(/_/g, " ");
  if (!query) return true;
  return values
    .filter(hasValue)
    .some((value) => String(value).toLowerCase().replace(/[_-]+/g, " ").includes(query));
}

export function filterApplications(
  applications: readonly AdminApplicationView[],
  snapshot: AdminSnapshot,
  filters: LeasingRegisterFilters,
): AdminApplicationView[] {
  return applications.filter((application) => {
    if (!propertyMatches(snapshot, application.propertyId, filters)) return false;
    if (filters.unitId && filters.unitId !== "all" && application.unitId !== filters.unitId) return false;
    if (!statusMatches(application.status, filters)) return false;
    if (!dateInRange(applicationDateValue(application), filters)) return false;
    const property = propertyDisplayName(snapshot, application.propertyId);
    const unit = unitDisplayName(snapshot, application.unitId);
    return textMatches([
      applicationDisplayName(application),
      application.email,
      application.phone,
      property,
      unit,
      application.sourceType,
      application.status,
    ], filters.search);
  });
}

export function sortApplicationsByDate(applications: readonly AdminApplicationView[]): AdminApplicationView[] {
  return [...applications].sort((left, right) => {
    const rightDate = applicationDateValue(right) ?? "";
    const leftDate = applicationDateValue(left) ?? "";
    return rightDate.localeCompare(leftDate) || applicationDisplayName(left).localeCompare(applicationDisplayName(right));
  });
}

export function documentDateValue(document: Pick<AdminDocumentView, "uploadedAt" | "verifiedAt">): string | undefined {
  return document.uploadedAt ?? document.verifiedAt;
}

export function documentAvailabilityLabel(document: Pick<AdminDocumentView, "id" | "state" | "availability" | "downloadAvailable">): string {
  if (document.availability === "metadata") return "Metadata only · file unavailable";
  if (document.availability === "unavailable") return "File unavailable";
  if (applicationDocumentDownloadable(document)) return "Verified secure file";
  if (document.availability === "verified") return "Verified metadata · file unavailable";
  if (document.downloadAvailable) return "File availability needs review";
  return "Secure file unavailable";
}

export function documentRecordKey(document: AdminDocumentView, index = 0): string {
  return document.id ?? `document:row:${index}`;
}

export function activityRecordKey(activity: AdminActivityView, index = 0): string {
  return activity.id ?? `activity:row:${index}`;
}

export function activityDateValue(activity: Pick<AdminActivityView, "occurredAt">): string | undefined {
  return activity.occurredAt;
}

export function linkedRecordLabel(snapshot: AdminSnapshot, record: Pick<AdminDocumentView | AdminActivityView, "propertyId" | "unitId" | "personId" | "tenancyId" | "applicationId">): string {
  const application = record.applicationId
    ? snapshot.applicants.find((candidate) => candidate.id === record.applicationId)
    : undefined;
  const person = record.personId
    ? snapshot.snapshot.people.find((candidate) => candidate.id === record.personId)
    : undefined;
  const property = record.propertyId
    ? snapshot.snapshot.properties.find((candidate) => candidate.id === record.propertyId)
    : undefined;
  const unit = record.unitId
    ? snapshot.snapshot.units.find((candidate) => candidate.id === record.unitId)
    : undefined;
  const tenancy = record.tenancyId
    ? snapshot.snapshot.tenancies.find((candidate) => candidate.id === record.tenancyId)
    : undefined;
  const name = application ? applicationDisplayName(application)
    : person ? [person.firstName, person.lastName].filter((value): value is string => Boolean(value?.trim())).join(" ") || "Person needs review"
      : record.applicationId ? "Application needs review"
        : record.personId ? "Person needs review"
          : undefined;
  const propertyName = property?.name ?? (record.propertyId ? "Property needs review" : undefined);
  const unitName = unit?.unitNumber ?? (record.unitId ? "Unit needs review" : undefined);
  const tenancyName = tenancy && !unitName ? `Tenancy ${tenancy.status ?? "needs review"}` : undefined;
  const parts = [name, propertyName, unitName, tenancyName].filter((value): value is string => Boolean(value));
  if (parts.length) return parts.join(" · ");
  return "Unlinked record";
}

type RecordLinks = Pick<AdminDocumentView | AdminActivityView, "propertyId" | "unitId" | "tenancyId" | "applicationId">;

function recordUnitId(record: RecordLinks, snapshot: AdminSnapshot): string | undefined {
  return record.unitId
    ?? snapshot.snapshot.tenancies.find((item) => item.id === record.tenancyId)?.unitId
    ?? snapshot.applicants.find((item) => item.id === record.applicationId)?.unitId;
}

function recordPropertyId(record: RecordLinks, snapshot: AdminSnapshot): string | undefined {
  return record.propertyId
    ?? snapshot.snapshot.units.find((item) => item.id === recordUnitId(record, snapshot))?.propertyId
    ?? snapshot.snapshot.tenancies.find((item) => item.id === record.tenancyId)?.propertyId
    ?? snapshot.applicants.find((item) => item.id === record.applicationId)?.propertyId;
}

function recordType(record: Pick<AdminDocumentView | AdminActivityView, "type">): string | undefined {
  return record.type;
}

export function filterDocuments(
  documents: readonly AdminDocumentView[],
  snapshot: AdminSnapshot,
  filters: LeasingRegisterFilters,
): AdminDocumentView[] {
  return documents.filter((document) => {
    if (!propertyMatches(snapshot, recordPropertyId(document, snapshot), filters)) return false;
    if (filters.unitId && filters.unitId !== "all" && recordUnitId(document, snapshot) !== filters.unitId) return false;
    if (!statusMatches(document.state, filters)) return false;
    if (filters.type && filters.type !== "all" && (normalized(recordType(document)) || "unknown") !== normalized(filters.type)) return false;
    if (!dateInRange(documentDateValue(document), filters)) return false;
    return textMatches([
      document.fileName,
      document.type,
      document.state,
      document.availability,
      linkedRecordLabel(snapshot, document),
    ], filters.search);
  });
}

export function filterActivities(
  activities: readonly AdminActivityView[],
  snapshot: AdminSnapshot,
  filters: LeasingRegisterFilters,
): AdminActivityView[] {
  return activities.filter((activity) => {
    if (!propertyMatches(snapshot, recordPropertyId(activity, snapshot), filters)) return false;
    if (filters.unitId && filters.unitId !== "all" && recordUnitId(activity, snapshot) !== filters.unitId) return false;
    if (filters.type && filters.type !== "all" && (normalized(recordType(activity)) || "unknown") !== normalized(filters.type)) return false;
    if (!dateInRange(activityDateValue(activity), filters)) return false;
    return textMatches([
      activity.type,
      activity.summary,
      activity.actor,
      activity.detail,
      linkedRecordLabel(snapshot, activity),
    ], filters.search);
  });
}

export function sortDocumentsByDate(documents: readonly AdminDocumentView[]): AdminDocumentView[] {
  return [...documents].sort((left, right) => (documentDateValue(right) ?? "").localeCompare(documentDateValue(left) ?? ""));
}

export function sortActivitiesByDate(activities: readonly AdminActivityView[]): AdminActivityView[] {
  return [...activities].sort((left, right) => (activityDateValue(right) ?? "").localeCompare(activityDateValue(left) ?? ""));
}

/** The secure route gate is shared with application case detail. */
export const canDownloadDocument = applicationDocumentDownloadable;

/** Follow only a recorded conversion, never matching applicants by name or contact. */
export function applicationTenantPersonId(snapshot:AdminSnapshot,application:AdminApplicationView):string|undefined {
  const tenancy=application.convertedTenancyId?snapshot.snapshot.tenancies.find(row=>row.id===application.convertedTenancyId):undefined;
  if(!tenancy?.primaryPersonId||REVIEW_KNOWLEDGE.has(tenancy.primaryPersonLinkKnowledge??''))return undefined;
  return snapshot.snapshot.people.some(person=>person.id===tenancy.primaryPersonId)?tenancy.primaryPersonId:undefined;
}
export function linkedRecordPerson(snapshot:AdminSnapshot,record:AdminDocumentView|AdminActivityView):{id:string;name:string}|undefined {
  const application=record.applicationId?snapshot.applicants.find(row=>row.id===record.applicationId):undefined;
  if(application){const id=applicationTenantPersonId(snapshot,application);return id?{id,name:applicationDisplayName(application)}:undefined;}
  if('personLinkKnowledge' in record&&REVIEW_KNOWLEDGE.has(record.personLinkKnowledge??''))return undefined;
  const person=record.personId?snapshot.snapshot.people.find(row=>row.id===record.personId):undefined;
  if(!person?.id)return undefined;
  const name=[person.firstName,person.lastName].filter(value=>Boolean(value?.trim())).join(' ');
  return name?{id:person.id,name}:undefined;
}
