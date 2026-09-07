import { createHash } from "node:crypto";
import type {
  ApplicationHistoryAnswerValueType,
  ApplicationHistoryOrigin,
  ApplicationHistoryValueKnowledge,
  ApplicationStatus,
  ApplicationRequirementStatus,
  AmountKnowledge,
  DocumentAvailability,
  DocumentState,
  DocumentType,
  FactKnowledge,
  LinkKnowledge,
  RentManagerRawRecord,
  RentOpsApplicationAnswerOccurrence,
  RentOpsApplicationCase,
  RentOpsApplicationHistoryActivity,
  RentOpsApplicationHistoryBlocker,
  RentOpsApplicationHistoryDocument,
  RentOpsApplicationHistorySnapshot,
  RentOpsApplicationInterest,
  RentOpsApplicationParticipant,
  RentOpsApplicationRequirementOccurrence,
  RentOpsApplicationTemplateDefinition,
  RentOpsApplicationTemplateFieldDefinition,
  RentOpsApplicationTemplateSectionDefinition,
  RentOpsHistoricalApplication,
  RentOpsSourceRecord,
  RentOpsProspect,
  SourceRef,
  IsoDate,
} from "../../../shared/rent-ops-contracts";
import {
  APPLICATION_HISTORY_ANSWER_VALUE_TYPES,
  APPLICATION_REQUIREMENT_STATUSES,
  APPLICATION_STATUSES,
  ACTIVITY_TYPES,
  DOCUMENT_AVAILABILITIES,
  DOCUMENT_STATES,
  DOCUMENT_TYPES,
} from "../../../shared/rent-ops-contracts";
import type { ExportPayload } from "../export/types";
import { assertValidApplicationHistory } from "../domain/application-history";

type Raw = RentManagerRawRecord & Record<string, unknown>;

export interface ApplicationHistoryStatusMapping {
  artifactSha256: string;
  sourceCollection: string;
  sourceField: string;
  sourceValue: string;
  targetStatus: ApplicationStatus;
}

export interface ApplicationHistoryRequirementStatusMapping {
  artifactSha256: string;
  sourceCollection: string;
  sourceField: string;
  sourceValue: string;
  targetStatus: ApplicationRequirementStatus;
}

export interface ApplicationHistoryDocumentMapping {
  artifactSha256: string;
  sourceCollection: string;
  sourceField: string;
  sourceValue: string;
  targetType?: DocumentType;
  targetState?: DocumentState;
}

/** A target link is exact only when both the production target factory and an
 * exact source-to-target registry agree. A bare RM key is never enough: IDs
 * are reused across people, properties, units, and contact scopes. */
export interface ApplicationHistoryTargetBinding {
  targetId: string;
  /** Exact source ID originally supplied to the target-ID factory. */
  factorySourceId: string;
}

type ApplicationHistoryTargetRegistryValue = string | ApplicationHistoryTargetBinding;

export type ApplicationHistoryTargetRegistry = Partial<Record<
  "person" | "contact" | "property" | "unit" | "application",
  ReadonlyMap<string, ApplicationHistoryTargetRegistryValue> | Readonly<Record<string, ApplicationHistoryTargetRegistryValue>>
>>;

export interface ApplicationHistoryAnswerEvidence {
  artifactSha256: string;
  rowSetSha256: string;
  attestationSha256: string;
  allowlistedFieldSourceIds: readonly string[];
  /** If present, only these exact answer occurrence IDs are attested. */
  rowSourceIds?: readonly string[];
}

export interface ApplicationHistoryActivitySummaryEvidence {
  artifactSha256: string;
  sourceCollection: string;
  sourceField: string;
}

export interface ApplicationHistoryProjectionInput extends ExportPayload {
  /** Optional explicitly collected source occurrence collections. */
  applicationParticipants?: RentManagerRawRecord[];
  applicationRequirements?: RentManagerRawRecord[];
  applicationDocuments?: RentManagerRawRecord[];
  /** A verified answer occurrence set must opt in as complete. */
  applicationAnswersCoverage?: "missing" | "partial" | "complete";
}

export interface ApplicationHistoryProjectionOptions {
  artifactSha256?: string;
  statusCrosswalk?: readonly ApplicationHistoryStatusMapping[] | Readonly<Record<string, ApplicationStatus>>;
  statusCrosswalkArtifactSha256?: string;
  requirementStatusCrosswalk?: readonly ApplicationHistoryRequirementStatusMapping[];
  documentCrosswalk?: readonly ApplicationHistoryDocumentMapping[];
  targetIdFactory?: (entityType: string, sourceId: string) => string | undefined;
  targetSourceRegistry?: ApplicationHistoryTargetRegistry;
  answerEvidence?: ApplicationHistoryAnswerEvidence;
  activitySummaryEvidence?: readonly ApplicationHistoryActivitySummaryEvidence[];
  now?: () => Date;
}

export interface ApplicationHistoryImportProjectionOptions {
  artifactSha256: string;
  targetIdFactory?: ApplicationHistoryProjectionOptions["targetIdFactory"];
  supplementApproved: boolean;
  supplementEvidence?: {
    rowSetSha256?: string;
    attestationSha256?: string;
  };
  statusCrosswalk?: ApplicationHistoryProjectionOptions["statusCrosswalk"];
  statusCrosswalkArtifactSha256?: string;
  requirementStatusCrosswalk?: ApplicationHistoryProjectionOptions["requirementStatusCrosswalk"];
  documentCrosswalk?: ApplicationHistoryProjectionOptions["documentCrosswalk"];
  activitySummaryEvidence?: ApplicationHistoryProjectionOptions["activitySummaryEvidence"];
}

export interface ApplicationHistoryImportProjectionResult {
  snapshot: RentOpsApplicationHistorySnapshot;
  /** Stable aggregate-only codes safe for an artifact report or log. */
  blockingCodes: string[];
}

const SYSTEM = "rent_manager";

function value(row: Raw, ...keys: string[]): unknown {
  for (const key of keys) {
    const candidate = row[key];
    if (candidate !== undefined && candidate !== null && candidate !== "") return candidate;
  }
  return undefined;
}

function text(row: Raw, ...keys: string[]): string | undefined {
  const candidate = value(row, ...keys);
  if (candidate === undefined) return undefined;
  const result = String(candidate).trim();
  return result || undefined;
}

function sourceId(row: Raw, ...keys: string[]): string | undefined {
  return text(row, ...keys, "sourceId", "id", "ID", "Id");
}

function dateValue(row: Raw, ...keys: string[]): IsoDate | undefined {
  const candidate = text(row, ...keys);
  if (!candidate) return undefined;
  const date = candidate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date as IsoDate : undefined;
}

function timestampValue(row: Raw, ...keys: string[]): string | undefined {
  const candidate = text(row, ...keys);
  if (!candidate) return undefined;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function numberValue(row: Raw, ...keys: string[]): number | undefined {
  const candidate = value(row, ...keys);
  if (candidate === undefined) return undefined;
  const number = typeof candidate === "number" ? candidate : Number(String(candidate).trim());
  return Number.isFinite(number) && Number.isSafeInteger(number) ? number : undefined;
}

function decimalCents(row: Raw, ...keys: string[]): number | undefined {
  let candidate: unknown;
  let matchedKey: string | undefined;
  for (const key of keys) {
    const current = row[key];
    if (current !== undefined && current !== null && current !== "") {
      candidate = current;
      matchedKey = key;
      break;
    }
  }
  if (candidate === undefined) return undefined;
  const normalized = String(candidate).trim().replace(/^\$/, "").replace(/,/g, "");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  // The matched source field, rather than the JavaScript representation,
  // determines units. RM may return either 1250 or "1250" for dollars, and
  // either 125000 or "125000" for an explicitly cents-named field.
  const centsInput = matchedKey?.toLowerCase().includes("cents") === true;
  const cents = centsInput ? amount : amount * 100;
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function booleanValue(row: Raw, ...keys: string[]): boolean | undefined {
  const candidate = value(row, ...keys);
  if (typeof candidate === "boolean") return candidate;
  if (candidate === 1 || candidate === 0) return candidate === 1;
  if (typeof candidate === "string") {
    if (candidate === "true" || candidate === "yes" || candidate === "1") return true;
    if (candidate === "false" || candidate === "no" || candidate === "0") return false;
  }
  return undefined;
}

function allowlisted<T extends readonly string[]>(candidate: string | undefined, values: T): T[number] | undefined {
  return candidate && (values as readonly string[]).includes(candidate) ? candidate as T[number] : undefined;
}

function rawVariants(row: Raw, keys: string[]): string[] {
  const candidates = keys.map((key) => text(row, key)).filter((candidate): candidate is string => Boolean(candidate));
  const result = new Set<string>();
  for (const candidate of candidates) {
    result.add(candidate);
    const separator = candidate.indexOf(":");
    if (separator > -1) result.add(candidate.slice(separator + 1));
  }
  return Array.from(result);
}

function sourceIdentity(sourceCollection: string, source: string): string {
  return `${sourceCollection.length}:${sourceCollection}${source}`;
}

function sourceRef(row: Raw, sourceCollection: string, entityType: string, source: string): SourceRef {
  const updatedAt = timestampValue(row, "updatedAt", "UpdatedAt", "updated_at", "ModifiedDate", "UpdatedDate", "UpdateDate");
  return {
    system: SYSTEM,
    entityType: text(row, "sourceEntityType", "entityType") ?? entityType,
    // RM reuses numeric identifiers across independent resources (for
    // example histories, notes and communications).  The collection-qualified
    // identity preserves the exact domain and prevents false uniqueness.
    sourceId: sourceIdentity(sourceCollection, source),
    ...(updatedAt ? { sourceUpdatedAt: updatedAt } : {}),
  };
}

function fact(candidate: unknown): FactKnowledge {
  return candidate === undefined || candidate === null || candidate === "" ? "unknown" : "source";
}

function link(id: string | undefined): LinkKnowledge | undefined {
  return id ? "exact" : undefined;
}

function amountKnowledge(amount: number | undefined): AmountKnowledge {
  return amount === undefined ? "unknown" : "known";
}

function rawApplicationId(row: Raw): string | undefined {
  return text(row, "applicationId", "ApplicationID", "ApplicationId", "ProspectApplicationID", "ProspectApplicationId", "ApplicationSourceID", "ApplicationSourceId", "ParentApplicationID");
}

function rawProspectId(row: Raw): string | undefined {
  return text(row, "prospectId", "ProspectID", "ProspectId", "ParentProspectID", "ParentProspectId");
}

function rawPersonId(row: Raw): string | undefined {
  return text(row, "personId", "PersonID", "PersonId", "TenantID", "TenantId");
}

function rawContactId(row: Raw): string | undefined {
  return text(row, "contactId", "ContactID", "ContactId");
}

function explicitParentType(row: Raw): "application" | "prospect" | undefined {
  const candidate = text(row, "parentType", "ParentType", "EntityTypeName", "ParentEntityType")?.trim().toLowerCase();
  if (["application", "prospectapplication", "prospect_application"].includes(candidate ?? "")) return "application";
  if (candidate === "prospect") return "prospect";
  return undefined;
}

function hasApplicationHistoryParentReference(row: Raw): boolean {
  return Boolean(rawApplicationId(row) || rawProspectId(row) || (explicitParentType(row) && text(row, "parentId", "ParentID", "ParentId", "EntityKeyID")));
}

function exactParent(
  row: Raw,
  applicationTargets: ReadonlyMap<string, string>,
  prospectTargets: ReadonlyMap<string, string>,
  keys: { application?: string[]; prospect?: string[] } = {},
): { applicationId?: string; prospectId?: string; applicationLinkKnowledge?: LinkKnowledge; prospectLinkKnowledge?: LinkKnowledge } {
  const applicationSource = text(row, ...(keys.application ?? ["applicationId", "ApplicationID", "ApplicationId", "ProspectApplicationID", "ProspectApplicationId"]));
  const prospectSource = text(row, ...(keys.prospect ?? ["prospectId", "ProspectID", "ProspectId"]));
  const applicationId = applicationSource ? applicationTargets.get(applicationSource) ?? applicationTargets.get(applicationSource.replace(/^[a-z_]+:/i, "")) : undefined;
  const prospectId = prospectSource ? prospectTargets.get(prospectSource) ?? prospectTargets.get(prospectSource.replace(/^[a-z_]+:/i, "")) : undefined;
  return {
    ...(applicationId ? { applicationId, applicationLinkKnowledge: "exact" as const } : {}),
    ...(prospectId ? { prospectId, prospectLinkKnowledge: "exact" as const } : {}),
  };
}

function targetFor(options: ApplicationHistoryProjectionOptions, entityType: string, source: string): string {
  const injected = options.targetIdFactory?.(entityType, source);
  if (injected) return injected;
  if (process.env.NODE_ENV === "production") throw new Error("application_history_target_id_factory_required");
  // Development-only target IDs are intentionally opaque to the raw RM key.
  // Approved artifacts always inject the persisted keyed target factory.
  const digest = createHash("sha256").update(`${entityType}\u0000${source}`).digest("hex").slice(0, 40);
  return `development:${entityType}:${digest}`;
}

function registryValue(
  registry: ReadonlyMap<string, ApplicationHistoryTargetRegistryValue> | Readonly<Record<string, ApplicationHistoryTargetRegistryValue>> | undefined,
  source: string,
): ApplicationHistoryTargetBinding | undefined {
  if (!registry) return undefined;
  let candidate: ApplicationHistoryTargetRegistryValue | undefined;
  if (typeof (registry as ReadonlyMap<string, string>).get === "function") {
    candidate = (registry as ReadonlyMap<string, ApplicationHistoryTargetRegistryValue>).get(source);
  } else {
    candidate = (registry as Readonly<Record<string, ApplicationHistoryTargetRegistryValue>>)[source];
  }
  if (typeof candidate === "string") return candidate.trim() ? { targetId: candidate, factorySourceId: source } : undefined;
  return candidate?.targetId.trim() && candidate.factorySourceId.trim() ? candidate : undefined;
}

function linkedTarget(options: ApplicationHistoryProjectionOptions, entityType: "person" | "contact" | "property" | "unit", source: string): string | undefined {
  const registered = registryValue(options.targetSourceRegistry?.[entityType], source);
  if (!registered || !options.targetIdFactory) return undefined;
  const produced = options.targetIdFactory(entityType, registered.factorySourceId);
  return produced && produced === registered.targetId ? produced : undefined;
}

function sourceTargetMap(rows: readonly Raw[], entityType: string, options: ApplicationHistoryProjectionOptions, keys: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  rows.forEach((row) => {
    const id = sourceId(row, ...keys);
    if (!id) return;
    const variants = rawVariants(row, keys);
    const registered = entityType === "application"
      ? variants.map((variant) => registryValue(options.targetSourceRegistry?.application, variant)).filter((value): value is ApplicationHistoryTargetBinding => Boolean(value))
      : [];
    const verifiedRegistered = registered.filter((binding) => options.targetIdFactory?.("application", binding.factorySourceId) === binding.targetId);
    const registeredTargets = new Set(verifiedRegistered.map((binding) => binding.targetId));
    const target = registeredTargets.size === 1
      ? Array.from(registeredTargets)[0]
      : targetFor(options, entityType, sourceIdentity(rowCollection(row), id));
    for (const variant of variants) {
      if (ambiguous.has(variant)) continue;
      const existing = map.get(variant);
      if (existing && existing !== target) {
        map.delete(variant);
        ambiguous.add(variant);
      } else if (!existing) {
        map.set(variant, target);
      }
    }
  });
  return map;
}

function statusFromCrosswalk(
  row: Raw,
  sourceCollection: string,
  options: ApplicationHistoryProjectionOptions,
): ApplicationStatus | undefined {
  const raw = text(row, "status", "Status", "applicationStatus", "ApplicationStatus");
  if (!raw || !options.artifactSha256 || !options.statusCrosswalk) return undefined;
  if (Array.isArray(options.statusCrosswalk)) {
    const matches = options.statusCrosswalk.filter((entry) => entry.artifactSha256 === options.artifactSha256
      && entry.sourceCollection === sourceCollection
      && (entry.sourceField === "status" || entry.sourceField === "Status" || entry.sourceField === "ApplicationStatus")
      && entry.sourceValue === raw);
    return matches.length === 1 && (APPLICATION_STATUSES as readonly string[]).includes(matches[0].targetStatus)
      ? matches[0].targetStatus
      : undefined;
  }
  if (options.statusCrosswalkArtifactSha256 !== options.artifactSha256) return undefined;
  const keys = [`${sourceCollection}\u0000status\u0000${raw}`, `${sourceCollection}\u0000Status\u0000${raw}`];
  const map = options.statusCrosswalk as Readonly<Record<string, ApplicationStatus>>;
  const matches = keys.map((key) => map[key]).filter((candidate): candidate is ApplicationStatus => Boolean(candidate));
  return matches.length === 1 && (APPLICATION_STATUSES as readonly string[]).includes(matches[0]) ? matches[0] : undefined;
}

function exactCrosswalkValue(
  row: Raw,
  sourceCollection: string,
  fields: readonly string[],
  artifactSha256: string | undefined,
  mappings: readonly { artifactSha256: string; sourceCollection: string; sourceField: string; sourceValue: string; targetValue?: string }[] | undefined,
): string | undefined {
  if (!artifactSha256 || !mappings) return undefined;
  const matches: string[] = [];
  for (const field of fields) {
    const raw = text(row, field);
    if (raw === undefined) continue;
    const fieldMatches = mappings.filter((entry) => entry.artifactSha256 === artifactSha256
      && entry.sourceCollection === sourceCollection
      && entry.sourceField === field
      && entry.sourceValue === raw);
    for (const match of fieldMatches) if (match.targetValue !== undefined) matches.push(match.targetValue);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function requirementStatusFromCrosswalk(row: Raw, sourceCollection: string, options: ApplicationHistoryProjectionOptions): ApplicationRequirementStatus | undefined {
  const target = exactCrosswalkValue(row, sourceCollection, ["status", "Status", "RequirementStatus"], options.artifactSha256, options.requirementStatusCrosswalk?.map((entry) => ({ ...entry, targetValue: entry.targetStatus })));
  return target && (APPLICATION_REQUIREMENT_STATUSES as readonly string[]).includes(target) ? target as ApplicationRequirementStatus : undefined;
}

function documentMappedValue(row: Raw, sourceCollection: string, fields: readonly string[], options: ApplicationHistoryProjectionOptions): string | undefined {
  return exactCrosswalkValue(row, sourceCollection, fields, options.artifactSha256, options.documentCrosswalk?.map((entry) => ({
    artifactSha256: entry.artifactSha256,
    sourceCollection: entry.sourceCollection,
    sourceField: entry.sourceField,
    sourceValue: entry.sourceValue,
    targetValue: fields.some((field) => field.toLowerCase().includes("type")) ? entry.targetType : entry.targetState,
  })));
}

function answerValueType(candidate: unknown): ApplicationHistoryAnswerValueType | undefined {
  const textValue = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
  const aliases: Record<string, ApplicationHistoryAnswerValueType> = {
    string: "text",
    text: "text",
    integer: "integer",
    number: "decimal",
    decimal: "decimal",
    boolean: "boolean",
    bool: "boolean",
    date: "date",
    choice: "choice",
    select: "choice",
    multi_choice: "multi_choice",
    multiselect: "multi_choice",
    money: "money",
    currency: "money",
  };
  return aliases[textValue] ?? allowlisted(textValue, APPLICATION_HISTORY_ANSWER_VALUE_TYPES);
}

function rowCollection(row: Raw): string {
  return text(row, "sourceCollection", "SourceCollection", "collection") ?? "rent_manager";
}

function templateKind(row: Raw): "template" | "section" | "field" {
  const collection = rowCollection(row).toLowerCase();
  if (collection.includes("field")) return "field";
  if (collection.includes("section")) return "section";
  if (text(row, "fieldId", "FieldID", "ApplicationFieldID", "ApplicationTemplateFieldID")) return "field";
  if (text(row, "sectionId", "SectionID", "MajorSectionID", "MinorSectionID")) return "section";
  return "template";
}

function documentType(row: Raw, sourceCollection: string, options: ApplicationHistoryProjectionOptions): DocumentType | undefined {
  const mapped = documentMappedValue(row, sourceCollection, ["type", "Type", "DocumentType", "DocumentTypeName"], options)?.toLowerCase();
  return allowlisted(mapped, DOCUMENT_TYPES);
}

function documentState(row: Raw, sourceCollection: string, options: ApplicationHistoryProjectionOptions): DocumentState | undefined {
  const mapped = documentMappedValue(row, sourceCollection, ["state", "State", "Status", "DocumentStatus"], options)?.toLowerCase();
  return allowlisted(mapped, DOCUMENT_STATES);
}

function activityType(row: Raw): RentOpsApplicationHistoryActivity["type"] {
  return allowlisted(text(row, "type", "Type", "ActivityType", "EventType")?.toLowerCase(), ACTIVITY_TYPES);
}

function safeActivitySummary(row: Raw, sourceCollection: string, options: ApplicationHistoryProjectionOptions): string | undefined {
  if (!options.artifactSha256 || !options.activitySummaryEvidence) return undefined;
  const safeFields = new Set(["summary", "Summary", "Subject", "Title"]);
  const matches = options.activitySummaryEvidence.filter((entry) => entry.artifactSha256 === options.artifactSha256
    && entry.sourceCollection === sourceCollection
    && safeFields.has(entry.sourceField));
  if (matches.length !== 1) return undefined;
  return text(row, matches[0].sourceField);
}

function occurrenceParent(row: Raw, appTargets: ReadonlyMap<string, string>, prospectTargets: ReadonlyMap<string, string>): ReturnType<typeof exactParent> {
  const direct = exactParent(row, appTargets, prospectTargets);
  if (direct.applicationId || direct.prospectId) return direct;
  const parentType = explicitParentType(row);
  const parentSource = text(row, "parentId", "ParentID", "ParentId", "EntityKeyID");
  if (!parentType || !parentSource) return direct;
  if (parentType === "application") {
    const applicationId = appTargets.get(parentSource) ?? appTargets.get(parentSource.replace(/^[a-z_]+:/i, ""));
    return applicationId ? { applicationId, applicationLinkKnowledge: "exact" } : direct;
  }
  const prospectId = prospectTargets.get(parentSource) ?? prospectTargets.get(parentSource.replace(/^[a-z_]+:/i, ""));
  return prospectId ? { prospectId, prospectLinkKnowledge: "exact" } : direct;
}

function buildProspects(rows: readonly Raw[], options: ApplicationHistoryProjectionOptions): { rows: RentOpsProspect[]; targets: Map<string, string> } {
  const targets = sourceTargetMap(rows, "prospect", options, ["ProspectID", "prospectId", "sourceId", "id", "ID", "Id"]);
  const result = rows.flatMap((row) => {
    const source = sourceId(row, "ProspectID", "prospectId", "sourceId", "id", "ID", "Id");
    if (!source) return [];
    const id = targets.get(source) ?? targetFor(options, "prospect", sourceIdentity(rowCollection(row), source));
    const personSource = rawPersonId(row);
    const contactSource = rawContactId(row);
    const personId = personSource ? linkedTarget(options, "person", personSource) : undefined;
    const contactId = contactSource ? linkedTarget(options, "contact", contactSource) : undefined;
    return [{
      id,
      source: sourceRef(row, rowCollection(row), "prospect", source),
      ...(personId ? { personId, personLinkKnowledge: "exact" as const } : { personLinkKnowledge: personSource ? "unknown" as const : null }),
      ...(contactId ? { contactId, contactLinkKnowledge: "exact" as const } : { contactLinkKnowledge: contactSource ? "unknown" as const : null }),
      firstName: text(row, "firstName", "FirstName", "first_name") ?? null,
      lastName: text(row, "lastName", "LastName", "last_name") ?? null,
      email: text(row, "email", "Email", "EmailAddress") ?? null,
      phone: text(row, "phone", "Phone", "PhoneNumber", "Mobile") ?? null,
      status: text(row, "status", "Status", "ProspectStatus") ?? null,
      statusKnowledge: fact(value(row, "status", "Status", "ProspectStatus")),
      createdOn: dateValue(row, "createdOn", "CreatedOn", "CreatedDate", "CreateDate") ?? null,
      createdOnKnowledge: fact(value(row, "createdOn", "CreatedOn", "CreatedDate", "CreateDate")),
      updatedOn: dateValue(row, "updatedOn", "UpdatedOn", "UpdatedDate", "ModifiedDate") ?? null,
      updatedOnKnowledge: fact(value(row, "updatedOn", "UpdatedOn", "UpdatedDate", "ModifiedDate")),
      recordRevision: 1,
    } satisfies RentOpsProspect];
  });
  for (const row of rows) {
    const source = sourceId(row, "ProspectID", "prospectId", "sourceId", "id", "ID", "Id");
    if (source && !targets.has(source)) targets.set(source, targetFor(options, "prospect", sourceIdentity(rowCollection(row), source)));
  }
  return { rows: result, targets };
}

function buildApplications(rows: readonly Raw[], prospects: ReadonlyMap<string, string>, options: ApplicationHistoryProjectionOptions): { rows: RentOpsHistoricalApplication[]; targets: Map<string, string> } {
  const targets = sourceTargetMap(rows, "application", options, ["ProspectApplicationID", "ApplicationID", "applicationId", "sourceId", "id", "ID", "Id"]);
  const result = rows.flatMap((row) => {
    const source = sourceId(row, "ProspectApplicationID", "ApplicationID", "applicationId", "sourceId", "id", "ID", "Id");
    if (!source) return [];
    const id = targets.get(source) ?? targetFor(options, "application", sourceIdentity(rowCollection(row), source));
    const parent = exactParent(row, targets, prospects);
    const prospectSource = rawProspectId(row);
    const personSource = rawPersonId(row);
    const personId = personSource ? linkedTarget(options, "person", personSource) : undefined;
    const mappedStatus = statusFromCrosswalk(row, rowCollection(row), options);
    const rawStatus = value(row, "status", "Status", "applicationStatus", "ApplicationStatus");
    return [{
      id,
      source: sourceRef(row, rowCollection(row), "application", source),
      ...(parent.prospectId ? { prospectId: parent.prospectId, prospectLinkKnowledge: "exact" as const } : prospectSource ? { prospectLinkKnowledge: "unknown" as const } : { prospectLinkKnowledge: null }),
      ...(personId ? { personId, personLinkKnowledge: "exact" as const } : { personLinkKnowledge: personSource ? "unknown" as const : null }),
      firstName: text(row, "firstName", "FirstName", "first_name") ?? null,
      lastName: text(row, "lastName", "LastName", "last_name") ?? null,
      email: text(row, "email", "Email", "EmailAddress") ?? null,
      phone: text(row, "phone", "Phone", "PhoneNumber", "Mobile") ?? null,
      status: mappedStatus ?? null,
      statusKnowledge: mappedStatus ? "source" as const : rawStatus === undefined ? "unknown" as const : "unknown" as const,
      submittedOn: dateValue(row, "submittedOn", "SubmittedOn", "SubmittedDate", "ApplicationDate", "ApplicationSubmissionDate") ?? null,
      submittedOnKnowledge: fact(value(row, "submittedOn", "SubmittedOn", "SubmittedDate", "ApplicationDate", "ApplicationSubmissionDate")),
      createdOn: dateValue(row, "createdOn", "CreatedOn", "CreatedDate", "CreateDate") ?? null,
      createdOnKnowledge: fact(value(row, "createdOn", "CreatedOn", "CreatedDate", "CreateDate")),
      updatedOn: dateValue(row, "updatedOn", "UpdatedOn", "UpdatedDate", "ModifiedDate") ?? null,
      updatedOnKnowledge: fact(value(row, "updatedOn", "UpdatedOn", "UpdatedDate", "ModifiedDate")),
      recordRevision: 1,
    } satisfies RentOpsHistoricalApplication];
  });
  return { rows: result, targets };
}

function buildInterests(rows: readonly Raw[], appTargets: ReadonlyMap<string, string>, prospectTargets: ReadonlyMap<string, string>, options: ApplicationHistoryProjectionOptions, unknownRestricted: { unlinkedInterestCount: number }): RentOpsApplicationInterest[] {
  return rows.flatMap((row) => {
    const source = sourceId(row, "InterestedRentalID", "InterestedRentID", "sourceId", "ID", "Id");
    if (!source) return [];
    const parent = occurrenceParent(row, appTargets, prospectTargets);
    const propertySource = text(row, "propertyId", "PropertyID", "PropertyId");
    const unitSource = text(row, "unitId", "UnitID", "UnitId");
    if (!parent.applicationId && !parent.prospectId) {
      unknownRestricted.unlinkedInterestCount += 1;
      return [];
    }
    const rent = decimalCents(row, "rentCents", "RentCents", "rent", "Rent", "MarketRent");
    const sourceOrder = numberValue(row, "sourceOrder", "SourceOrder", "order", "Order", "DisplayOrder", "SortOrder", "Sequence");
    const sourceRank = numberValue(row, "sourceRank", "SourceRank", "rank", "Rank", "PreferenceRank");
    const propertyId = propertySource ? linkedTarget(options, "property", propertySource) : undefined;
    const unitId = unitSource ? linkedTarget(options, "unit", unitSource) : undefined;
    return [{
      id: targetFor(options, "application_interest", sourceIdentity(rowCollection(row), source)),
      source: sourceRef(row, rowCollection(row), "interested_rental", source),
      ...(parent.prospectId ? { prospectId: parent.prospectId, prospectLinkKnowledge: "exact" as const } : {}),
      ...(parent.applicationId ? { applicationId: parent.applicationId, applicationLinkKnowledge: "exact" as const } : {}),
      ...(propertyId ? { propertyId, propertyLinkKnowledge: "exact" as const } : { propertyLinkKnowledge: propertySource ? "unknown" as const : null }),
      ...(unitId ? { unitId, unitLinkKnowledge: "exact" as const } : { unitLinkKnowledge: unitSource ? "unknown" as const : null }),
      sourceOrder: sourceOrder ?? null,
      sourceRank: sourceRank ?? null,
      preference: text(row, "preference", "Preference", "InterestType", "InterestedType") ?? null,
      preferenceKnowledge: fact(value(row, "preference", "Preference", "InterestType", "InterestedType")),
      interestedOn: dateValue(row, "interestedOn", "InterestedOn", "InterestedDate", "CreatedDate") ?? null,
      interestedOnKnowledge: fact(value(row, "interestedOn", "InterestedOn", "InterestedDate", "CreatedDate")),
      rentCents: rent ?? null,
      rentKnowledge: amountKnowledge(rent),
      bedrooms: numberValue(row, "bedrooms", "Bedrooms") ?? null,
      bedroomsKnowledge: fact(value(row, "bedrooms", "Bedrooms")),
      status: text(row, "status", "Status", "InterestStatus") ?? null,
      statusKnowledge: fact(value(row, "status", "Status", "InterestStatus")),
      recordRevision: 1,
    } satisfies RentOpsApplicationInterest];
  });
}

function buildParticipants(rows: readonly Raw[], appTargets: ReadonlyMap<string, string>, prospectTargets: ReadonlyMap<string, string>, options: ApplicationHistoryProjectionOptions): RentOpsApplicationParticipant[] {
  return rows.flatMap((row) => {
    const source = sourceId(row, "ParticipantID", "ApplicationParticipantID", "SubApplicantID", "sourceId", "ID", "Id");
    if (!source) return [];
    const parent = occurrenceParent(row, appTargets, prospectTargets);
    if (!parent.applicationId && !parent.prospectId) return [];
    const personSource = rawPersonId(row);
    const personId = personSource ? linkedTarget(options, "person", personSource) : undefined;
    const minor = booleanValue(row, "isMinor", "IsMinor", "Minor");
    const responsible = booleanValue(row, "isFinanciallyResponsible", "IsFinanciallyResponsible", "FinanciallyResponsible", "Responsible");
    return [{
      id: targetFor(options, "application_participant", sourceIdentity(rowCollection(row), source)),
      source: sourceRef(row, rowCollection(row), "application_participant", source),
      ...(parent.prospectId ? { prospectId: parent.prospectId, prospectLinkKnowledge: "exact" as const } : {}),
      ...(parent.applicationId ? { applicationId: parent.applicationId, applicationLinkKnowledge: "exact" as const } : {}),
      ...(personId ? { personId, personLinkKnowledge: "exact" as const } : { personLinkKnowledge: personSource ? "unknown" as const : null }),
      sourceOrder: numberValue(row, "sourceOrder", "SourceOrder", "order", "Order", "Sequence") ?? null,
      role: text(row, "role", "Role", "ParticipantRole") ?? null,
      roleKnowledge: fact(value(row, "role", "Role", "ParticipantRole")),
      relationship: text(row, "relationship", "Relationship", "Relation") ?? null,
      relationshipKnowledge: fact(value(row, "relationship", "Relationship", "Relation")),
      isMinor: minor ?? null,
      minorKnowledge: fact(value(row, "isMinor", "IsMinor", "Minor")),
      isFinanciallyResponsible: responsible ?? null,
      financialResponsibilityKnowledge: fact(value(row, "isFinanciallyResponsible", "IsFinanciallyResponsible", "FinanciallyResponsible", "Responsible")),
      origin: "source" as ApplicationHistoryOrigin,
      recordRevision: 1,
    } satisfies RentOpsApplicationParticipant];
  });
}

function buildRequirements(
  rows: readonly Raw[],
  appTargets: ReadonlyMap<string, string>,
  prospectTargets: ReadonlyMap<string, string>,
  documentTargets: ReadonlyMap<string, string>,
  options: ApplicationHistoryProjectionOptions,
): RentOpsApplicationRequirementOccurrence[] {
  return rows.flatMap((row) => {
    const source = sourceId(row, "RequirementID", "ApplicationRequirementID", "sourceId", "ID", "Id");
    if (!source) return [];
    const parent = occurrenceParent(row, appTargets, prospectTargets);
    if (!parent.applicationId && !parent.prospectId) return [];
    const status = requirementStatusFromCrosswalk(row, rowCollection(row), options);
    const documentSource = text(row, "documentId", "DocumentID", "DocumentId");
    const documentId = documentSource ? resolveOccurrenceTarget(documentTargets, rowCollection(row), documentSource) : undefined;
    return [{
      id: targetFor(options, "application_requirement", sourceIdentity(rowCollection(row), source)),
      source: sourceRef(row, rowCollection(row), "application_requirement", source),
      ...(parent.prospectId ? { prospectId: parent.prospectId, prospectLinkKnowledge: "exact" as const } : {}),
      ...(parent.applicationId ? { applicationId: parent.applicationId, applicationLinkKnowledge: "exact" as const } : {}),
      key: text(row, "key", "Key", "RequirementKey") ?? null,
      label: text(row, "label", "Label", "Name", "Description") ?? null,
      status: status ?? null,
      statusKnowledge: status ? "source" as const : "unknown" as const,
      requestedOn: dateValue(row, "requestedOn", "RequestedOn", "RequestedDate") ?? null,
      requestedOnKnowledge: fact(value(row, "requestedOn", "RequestedOn", "RequestedDate")),
      resolvedOn: dateValue(row, "resolvedOn", "ResolvedOn", "ResolvedDate") ?? null,
      resolvedOnKnowledge: fact(value(row, "resolvedOn", "ResolvedOn", "ResolvedDate")),
      ...(documentId ? { documentId, documentLinkKnowledge: "exact" as const } : { documentLinkKnowledge: documentSource ? "unknown" as const : null }),
      origin: "source" as const,
      recordRevision: 1,
    } satisfies RentOpsApplicationRequirementOccurrence];
  });
}

interface TemplateBuildResult {
  templates: RentOpsApplicationTemplateDefinition[];
  sections: RentOpsApplicationTemplateSectionDefinition[];
  fields: RentOpsApplicationTemplateFieldDefinition[];
  fieldTypes: Map<string, { id: string; type?: ApplicationHistoryAnswerValueType; sensitive: boolean }>;
}

function buildTemplates(rows: readonly Raw[], options: ApplicationHistoryProjectionOptions): TemplateBuildResult {
  const templates: RentOpsApplicationTemplateDefinition[] = [];
  const sections: RentOpsApplicationTemplateSectionDefinition[] = [];
  const fields: RentOpsApplicationTemplateFieldDefinition[] = [];
  const fieldTypes = new Map<string, { id: string; type?: ApplicationHistoryAnswerValueType; sensitive: boolean }>();
  const templateRows = rows.filter((row) => templateKind(row) === "template");
  const sectionRows = rows.filter((row) => templateKind(row) === "section");
  const fieldRows = rows.filter((row) => templateKind(row) === "field");
  const templateKeys = ["TemplateID", "ApplicationTemplateID", "templateId", "sourceId", "ID", "Id"];
  const sectionKeys = ["ApplicationTemplateMajorSectionID", "ApplicationTemplateMinorSectionID", "SectionID", "MajorSectionID", "MinorSectionID", "sectionId", "sourceId", "ID", "Id"];
  const fieldKeys = ["ApplicationTemplateFieldID", "ApplicationFieldID", "FieldID", "fieldId", "sourceId", "ID", "Id"];
  const templateTargets = sourceTargetMap(templateRows, "application_template", options, templateKeys);
  const sectionTargets = sourceTargetMap(sectionRows, "application_template_section", options, sectionKeys);
  const fieldTargets = sourceTargetMap(fieldRows, "application_template_field", options, fieldKeys);

  templateRows.forEach((row) => {
    const source = sourceId(row, ...templateKeys);
    if (!source) return;
    const sourceCollection = rowCollection(row);
    templates.push({
      id: templateTargets.get(source) ?? targetFor(options, "application_template", sourceIdentity(sourceCollection, source)),
      source: sourceRef(row, sourceCollection, "application_template", source),
      name: text(row, "name", "Name", "TemplateName", "Label") ?? null,
      nameKnowledge: fact(value(row, "name", "Name", "TemplateName", "Label")),
      active: booleanValue(row, "active", "Active", "IsActive") ?? null,
      activeKnowledge: fact(value(row, "active", "Active", "IsActive")),
      recordRevision: 1,
    });
  });

  sectionRows.forEach((row) => {
    const source = sourceId(row, ...sectionKeys);
    if (!source) return;
    const sourceCollection = rowCollection(row);
    const templateSource = text(row, "templateId", "TemplateID", "ApplicationTemplateID");
    const templateId = templateSource ? templateTargets.get(templateSource) : undefined;
    sections.push({
      id: sectionTargets.get(source) ?? targetFor(options, "application_template_section", sourceIdentity(sourceCollection, source)),
      source: sourceRef(row, sourceCollection, "application_template_section", source),
      ...(templateId ? { templateId, templateLinkKnowledge: "exact" as const } : { templateLinkKnowledge: templateSource ? "unknown" as const : null }),
      name: text(row, "name", "Name", "SectionName", "Label") ?? null,
      nameKnowledge: fact(value(row, "name", "Name", "SectionName", "Label")),
      sourceOrder: numberValue(row, "sourceOrder", "SourceOrder", "Order", "DisplayOrder", "Sequence") ?? null,
      recordRevision: 1,
    });
  });

  fieldRows.forEach((row) => {
    const source = sourceId(row, ...fieldKeys);
    if (!source) return;
    const sourceCollection = rowCollection(row);
    const templateSource = text(row, "templateId", "TemplateID", "ApplicationTemplateID");
    const sectionSource = text(row, "sectionId", "SectionID", "MajorSectionID", "MinorSectionID");
    const templateId = templateSource ? templateTargets.get(templateSource) : undefined;
    const sectionId = sectionSource ? sectionTargets.get(sectionSource) : undefined;
    const type = answerValueType(value(row, "valueType", "ValueType", "DataType", "FieldType", "Type"));
    const sensitive = booleanValue(row, "sensitive", "Sensitive", "IsSensitive", "Restricted") === true;
    const id = fieldTargets.get(source) ?? targetFor(options, "application_template_field", sourceIdentity(sourceCollection, source));
    const field = {
      id,
      source: sourceRef(row, sourceCollection, "application_template_field", source),
      ...(templateId ? { templateId, templateLinkKnowledge: "exact" as const } : { templateLinkKnowledge: templateSource ? "unknown" as const : null }),
      ...(sectionId ? { sectionId, sectionLinkKnowledge: "exact" as const } : { sectionLinkKnowledge: sectionSource ? "unknown" as const : null }),
      key: text(row, "key", "Key", "FieldKey", "FieldName") ?? null,
      label: text(row, "label", "Label", "Name", "Question") ?? null,
      valueType: type ?? null,
      sensitive,
      sourceOrder: numberValue(row, "sourceOrder", "SourceOrder", "Order", "DisplayOrder", "Sequence") ?? null,
      recordRevision: 1,
    } satisfies RentOpsApplicationTemplateFieldDefinition;
    fields.push(field);
    for (const variant of rawVariants(row, fieldKeys)) fieldTypes.set(variant, { id, type, sensitive });
  });
  return { templates, sections, fields, fieldTypes };
}

function buildAnswers(
  rows: readonly Raw[] | undefined,
  appTargets: ReadonlyMap<string, string>,
  prospectTargets: ReadonlyMap<string, string>,
  fieldTypes: ReadonlyMap<string, { id: string; type?: ApplicationHistoryAnswerValueType; sensitive: boolean }>,
  options: ApplicationHistoryProjectionOptions,
  unknownRestricted: { restrictedAnswerCount: number; unmappedAnswerCount: number },
): RentOpsApplicationAnswerOccurrence[] {
  return (rows ?? []).flatMap((row) => {
    const source = sourceId(row, "ApplicationAnswerID", "AnswerID", "ProspectApplicationAnswerID", "ApplicationFieldAnswerID", "sourceId", "id", "ID", "Id");
    if (!source) return [];
    const parent = occurrenceParent(row, appTargets, prospectTargets);
    if (!parent.applicationId && !parent.prospectId) {
      unknownRestricted.unmappedAnswerCount += 1;
      return [];
    }
    const fieldSource = text(row, "fieldId", "FieldID", "ApplicationFieldID", "ApplicationTemplateFieldID", "targetField", "TargetField");
    const mapping = fieldSource ? fieldTypes.get(fieldSource) ?? fieldTypes.get(fieldSource.replace(/^[a-z_]+:/i, "")) : undefined;
    const type = mapping?.type;
    // The source row and its own `sensitive` flag are not an authorization
    // boundary. Until the verified supplement supplies a typed, allowlisted
    // attestation, retain only occurrence metadata and keep the value
    // restricted.
    // Coverage evidence proves the occurrence set is complete; it does not
    // authorize any answer value for browser projection.  Safe-value
    // projection requires a separately authenticated field/value receipt and
    // remains deliberately disabled here.
    unknownRestricted.restrictedAnswerCount += 1;
    if (!mapping?.type || mapping.sensitive) unknownRestricted.unmappedAnswerCount += 1;
    const answerType = type ?? "text";
    return [{
      id: targetFor(options, "application_answer", sourceIdentity(rowCollection(row), source)),
      source: sourceRef(row, rowCollection(row), "application_answer", source),
      ...(parent.prospectId ? { prospectId: parent.prospectId, prospectLinkKnowledge: "exact" as const } : {}),
      ...(parent.applicationId ? { applicationId: parent.applicationId, applicationLinkKnowledge: "exact" as const } : {}),
      ...(mapping ? { fieldId: mapping.id, fieldLinkKnowledge: "exact" as const } : { fieldLinkKnowledge: fieldSource ? "unknown" as const : null }),
      valueType: answerType,
      valueKnowledge: "restricted" as ApplicationHistoryValueKnowledge,
      recordRevision: 1,
    } satisfies RentOpsApplicationAnswerOccurrence];
  });
}

const AMBIGUOUS_TARGET = "\u0000ambiguous";

function registerOccurrenceTarget(map: Map<string, string>, sourceCollection: string, source: string, target: string): void {
  map.set(`${sourceCollection}\u0000${source}`, target);
  const bare = map.get(source);
  if (bare === undefined) map.set(source, target);
  else if (bare !== target) map.set(source, AMBIGUOUS_TARGET);
}

function resolveOccurrenceTarget(map: ReadonlyMap<string, string>, sourceCollection: string, source: string): string | undefined {
  const resolved = map.get(`${sourceCollection}\u0000${source}`) ?? map.get(source);
  return resolved && resolved !== AMBIGUOUS_TARGET ? resolved : undefined;
}

interface DocumentBuildResult {
  rows: RentOpsApplicationHistoryDocument[];
  targets: Map<string, string>;
}

function mergeDocumentRows(rows: readonly Raw[]): Raw {
  const merged: Raw = { ...(rows[0] ?? {}) };
  // A binary descriptor is a second representation of the same immutable
  // source document. It may enrich metadata but never contributes bytes or a
  // verified-availability claim to the browser-safe row.
  for (const row of rows.slice(1)) {
    for (const [key, candidate] of Object.entries(row)) {
      if (candidate === undefined || candidate === null || candidate === "") continue;
      if (["inlineSources", "archivePath", "binaryAvailable", "descriptorOnly"].includes(key)) continue;
      if (merged[key] === undefined || merged[key] === null || merged[key] === "") merged[key] = candidate;
    }
  }
  return merged;
}

function buildDocuments(
  rows: readonly Raw[],
  appTargets: ReadonlyMap<string, string>,
  prospectTargets: ReadonlyMap<string, string>,
  options: ApplicationHistoryProjectionOptions,
  unknownRestricted: { metadataOnlyDocumentCount: number; unavailableDocumentCount: number },
): DocumentBuildResult {
  const grouped = new Map<string, { sourceCollection: string; source: string; rows: Raw[] }>();
  const descriptors: Raw[] = [];
  for (const row of rows) {
    if (booleanValue(row, "descriptorOnly", "DescriptorOnly") === true) {
      descriptors.push(row);
      continue;
    }
    const source = sourceId(row, "DocumentID", "DocumentPacketID", "SignableDocumentID", "sourceId", "id", "ID", "Id");
    if (!source) continue;
    const sourceCollection = rowCollection(row);
    const key = `${sourceCollection}\u0000${source}`;
    const current = grouped.get(key);
    if (current) current.rows.push(row);
    else grouped.set(key, { sourceCollection, source, rows: [row] });
  }
  // Binary descriptors are archive representations, not independent
  // operational documents.  Attach one only when its source identity resolves
  // to exactly one metadata row; an ambiguous reused ID is never guessed.
  for (const row of descriptors) {
    const source = sourceId(row, "DocumentID", "DocumentPacketID", "SignableDocumentID", "sourceId", "id", "ID", "Id");
    if (!source) continue;
    const candidates = Array.from(grouped.values()).filter((group) => group.source === source);
    if (candidates.length === 1) {
      candidates[0].rows.push(row);
    }
    // An unmatched or ambiguous descriptor remains in the restricted binary
    // inventory; it cannot create or guess an application document row.
  }
  const targets = new Map<string, string>();
  const result: RentOpsApplicationHistoryDocument[] = [];
  for (const group of Array.from(grouped.values())) {
    const row = mergeDocumentRows(group.rows);
    const parent = occurrenceParent(row, appTargets, prospectTargets);
    const explicitUnavailable = group.rows.some((candidate: Raw) => booleanValue(candidate, "unavailable", "Unavailable", "binaryUnavailable") === true
      || booleanValue(candidate, "metadataAvailable", "MetadataAvailable") === false);
    const availability: Exclude<DocumentAvailability, "requested" | "verified"> = explicitUnavailable ? "unavailable" : "metadata";
    if (availability === "metadata") unknownRestricted.metadataOnlyDocumentCount += 1;
    else unknownRestricted.unavailableDocumentCount += 1;
    const metadataSize = numberValue(row, "metadataSizeBytes", "SizeBytes", "FileSize", "sizeBytes");
    const metadataChecksum = text(row, "metadataChecksumSha256", "checksumSha256", "ChecksumSha256", "sha256");
    const id = targetFor(options, "application_history_document", sourceIdentity(group.sourceCollection, group.source));
    registerOccurrenceTarget(targets, group.sourceCollection, group.source, id);
    const type = documentType(row, group.sourceCollection, options);
    const state = documentState(row, group.sourceCollection, options);
    result.push({
      id,
      source: sourceRef(row, group.sourceCollection, "document", group.source),
      ...(parent.prospectId ? { prospectId: parent.prospectId, prospectLinkKnowledge: "exact" as const } : {}),
      ...(parent.applicationId ? { applicationId: parent.applicationId, applicationLinkKnowledge: "exact" as const } : {}),
      type: type ?? null,
      typeKnowledge: type ? "source" : "unknown",
      state: state ?? null,
      stateKnowledge: state ? "source" : "unknown",
      fileName: text(row, "fileName", "FileName", "Name") ?? null,
      mimeType: text(row, "mimeType", "MimeType", "ContentType", "contentType") ?? null,
      metadataSizeBytes: metadataSize ?? null,
      metadataChecksumSha256: metadataChecksum ?? null,
      availability,
      recordRevision: 1,
    });
  }
  return { rows: result, targets };
}

function buildActivities(rows: readonly Raw[], appTargets: ReadonlyMap<string, string>, prospectTargets: ReadonlyMap<string, string>, options: ApplicationHistoryProjectionOptions, unknownRestricted: { unlinkedActivityCount: number }): RentOpsApplicationHistoryActivity[] {
  return rows.flatMap((row) => {
    const source = sourceId(row, "ActivityID", "HistoryID", "CommunicationID", "NoteID", "sourceId", "id", "ID", "Id");
    if (!source) return [];
    const parent = occurrenceParent(row, appTargets, prospectTargets);
    if (!parent.applicationId && !parent.prospectId) {
      unknownRestricted.unlinkedActivityCount += 1;
      return [];
    }
    const occurredAt = timestampValue(row, "occurredAt", "OccurredAt", "Date", "CreatedAt", "CreatedDate");
    const summary = safeActivitySummary(row, rowCollection(row), options);
    return [{
      id: targetFor(options, "application_history_activity", sourceIdentity(rowCollection(row), source)),
      source: sourceRef(row, rowCollection(row), "activity", source),
      ...(parent.prospectId ? { prospectId: parent.prospectId, prospectLinkKnowledge: "exact" as const } : {}),
      ...(parent.applicationId ? { applicationId: parent.applicationId, applicationLinkKnowledge: "exact" as const } : {}),
      type: activityType(row) ?? null,
      occurredAt: occurredAt ?? null,
      occurredAtKnowledge: occurredAt ? "source" as const : "unknown" as const,
      // Raw actor values can be source login IDs or email addresses.  Keep
      // them restricted until an authenticated actor-field receipt exists.
      actor: null,
      actorKnowledge: "unknown" as const,
      summary: summary ?? null,
      summaryKnowledge: summary ? "source" as const : "unknown" as const,
      recordRevision: 1,
    } satisfies RentOpsApplicationHistoryActivity];
  });
}

function answerCoverage(input: ApplicationHistoryProjectionInput, options: ApplicationHistoryProjectionOptions): "missing" | "partial" | "complete" {
  const evidence = options.answerEvidence;
  const evidenceValid = Boolean(evidence
    && evidence.artifactSha256 === options.artifactSha256
    && /^[a-f0-9]{64}$/.test(evidence.rowSetSha256)
    && /^[a-f0-9]{64}$/.test(evidence.attestationSha256));
  if (input.applicationAnswersCoverage === "complete" && evidenceValid) return "complete";
  return input.applicationAnswerRecords === undefined ? "missing" : "partial";
}

function missingAnswerBlockers(
  applications: readonly RentOpsHistoricalApplication[],
  prospects: readonly RentOpsProspect[],
  coverage: "missing" | "partial" | "complete",
  hasTemplateFields: boolean,
): RentOpsApplicationHistoryBlocker[] {
  if (coverage === "complete" || !hasTemplateFields) return [];
  const reason = coverage === "missing" ? "source_collection_missing" : "source_rows_unusable";
  if (applications.length > 0) return applications.map((application) => ({ code: "application_answers_missing" as const, applicationId: application.id, occurrenceCount: 1, reason }));
  if (prospects.length > 0) return prospects.map((prospect) => ({ code: "application_answers_missing" as const, prospectId: prospect.id, occurrenceCount: 1, reason }));
  return [];
}

function sourceRegistry(
  records: readonly RentOpsSourceRecord[],
): ApplicationHistoryTargetRegistry {
  const registries: Record<"person" | "property" | "unit" | "application", Map<string, ApplicationHistoryTargetBinding | string>> = {
    person: new Map(),
    property: new Map(),
    unit: new Map(),
    application: new Map(),
  };
  const ambiguous: Record<keyof typeof registries, Set<string>> = {
    person: new Set<string>(),
    property: new Set<string>(),
    unit: new Set<string>(),
    application: new Set<string>(),
  };
  const variants = (source: string): string[] => {
    const values = new Set([source]);
    const first = source.indexOf(":");
    const last = source.lastIndexOf(":");
    if (first >= 0 && first < source.length - 1) values.add(source.slice(first + 1));
    if (last >= 0 && last < source.length - 1) values.add(source.slice(last + 1));
    return Array.from(values);
  };
  for (const record of records) {
    if (record.entityType !== "person" && record.entityType !== "property" && record.entityType !== "unit" && record.entityType !== "application") continue;
    const registry = registries[record.entityType];
    const conflicts = ambiguous[record.entityType];
    const binding = { targetId: record.targetId, factorySourceId: record.sourceId } satisfies ApplicationHistoryTargetBinding;
    for (const key of variants(record.sourceId)) {
      if (conflicts.has(key)) continue;
      const existing = registry.get(key);
      if (existing && (typeof existing === "string" ? existing !== binding.targetId : existing.targetId !== binding.targetId || existing.factorySourceId !== binding.factorySourceId)) {
        registry.delete(key);
        conflicts.add(key);
      } else if (!existing) {
        registry.set(key, binding);
      }
    }
  }
  return registries;
}

/**
 * Build the v9 projection only from an already-normalized import result and
 * the exact approved archive payload.  This is the shared construction path
 * for artifact creation and integrity replay; callers never rebuild target
 * links from names, email addresses, or browser-visible IDs.
 */
export function projectApplicationHistoryForImport(
  input: ApplicationHistoryProjectionInput,
  sourceRecords: readonly RentOpsSourceRecord[],
  options: ApplicationHistoryImportProjectionOptions,
): ApplicationHistoryImportProjectionResult {
  const evidence = options.supplementApproved
    && options.supplementEvidence?.rowSetSha256
    && options.supplementEvidence.attestationSha256
    ? {
      artifactSha256: options.artifactSha256,
      rowSetSha256: options.supplementEvidence.rowSetSha256,
      attestationSha256: options.supplementEvidence.attestationSha256,
      allowlistedFieldSourceIds: [] as string[],
    }
    : undefined;
  const applicationAnswersCoverage = input.applicationAnswerRecords === undefined
    ? "missing" as const
    : evidence
      ? "complete" as const
      : "partial" as const;
  const snapshot = projectRentManagerApplicationHistory({ ...input, applicationAnswersCoverage }, {
    artifactSha256: options.artifactSha256,
    targetIdFactory: options.targetIdFactory,
    targetSourceRegistry: sourceRegistry(sourceRecords),
    answerEvidence: evidence,
    statusCrosswalk: options.statusCrosswalk,
    statusCrosswalkArtifactSha256: options.statusCrosswalkArtifactSha256,
    requirementStatusCrosswalk: options.requirementStatusCrosswalk,
    documentCrosswalk: options.documentCrosswalk,
    activitySummaryEvidence: options.activitySummaryEvidence,
  });
  const blockingCodes = new Set<string>();
  for (const blocker of snapshot.blockers) blockingCodes.add(blocker.code);
  if (snapshot.unknownRestricted.unlinkedInterestCount > 0) blockingCodes.add("application_interest_parent_unresolved");
  if (snapshot.unknownRestricted.unlinkedActivityCount > 0) blockingCodes.add("application_activity_parent_unresolved");
  if (snapshot.unknownRestricted.unmappedAnswerCount > 0) blockingCodes.add("application_answer_relationship_or_field_unresolved");
  if (snapshot.applications.some((application) => application.status === null && application.statusKnowledge === "unknown")) {
    blockingCodes.add("application_status_crosswalk_incomplete");
  }
  return { snapshot, blockingCodes: Array.from(blockingCodes).sort() };
}

export function projectRentManagerApplicationHistory(input: ApplicationHistoryProjectionInput, options: ApplicationHistoryProjectionOptions = {}): RentOpsApplicationHistorySnapshot {
  const rawProspects = (input.prospects ?? []) as Raw[];
  const rawApplications = (input.applications ?? []) as Raw[];
  const { rows: prospects, targets: prospectTargets } = buildProspects(rawProspects, options);
  const { rows: applications, targets: applicationTargets } = buildApplications(rawApplications, prospectTargets, options);
  const restricted = { restrictedAnswerCount: 0, unmappedAnswerCount: 0, missingAnswerApplications: 0, metadataOnlyDocumentCount: 0, unavailableDocumentCount: 0, unlinkedActivityCount: 0, unlinkedInterestCount: 0 };
  const interests = buildInterests((input.interestedRentals ?? []) as Raw[], applicationTargets, prospectTargets, options, restricted);
  const participantRows = [
    ...((input.applicationParticipants ?? []) as Raw[]),
    ...((input as ApplicationHistoryProjectionInput & { participants?: RentManagerRawRecord[] }).participants ?? []) as Raw[],
  ];
  const participants = buildParticipants(participantRows, applicationTargets, prospectTargets, options);
  const templateResult = buildTemplates((input.applicationTemplates ?? []) as Raw[], options);
  const answerStats = { restrictedAnswerCount: 0, unmappedAnswerCount: 0 };
  const answers = buildAnswers((input.applicationAnswerRecords ?? []) as Raw[] | undefined, applicationTargets, prospectTargets, templateResult.fieldTypes, options, answerStats);
  restricted.restrictedAnswerCount = answerStats.restrictedAnswerCount;
  restricted.unmappedAnswerCount = answerStats.unmappedAnswerCount;
  const documentRows = [
    ...((input.documents ?? []) as Raw[]),
    ...((input.applicationDocuments ?? []) as Raw[]),
  ].filter(hasApplicationHistoryParentReference);
  documentRows.push(...((input.documentBinaries ?? []) as unknown as Raw[]));
  const documentResult = buildDocuments(documentRows, applicationTargets, prospectTargets, options, restricted);
  const requirementRows = [
    ...((input.applicationRequirements ?? []) as Raw[]),
    ...((input as ApplicationHistoryProjectionInput & { requirements?: RentManagerRawRecord[] }).requirements ?? []) as Raw[],
  ];
  const requirements = buildRequirements(requirementRows, applicationTargets, prospectTargets, documentResult.targets, options);
  const activityRows = [
    ...((input.activities ?? []) as Raw[]),
    ...((input.notes ?? []) as Raw[]),
    ...((input.histories ?? []) as Raw[]),
    ...((input.communications ?? []) as Raw[]),
  ].filter(hasApplicationHistoryParentReference);
  const activities = buildActivities(activityRows, applicationTargets, prospectTargets, options, restricted);
  const blockers = missingAnswerBlockers(applications, prospects, answerCoverage(input, options), templateResult.fields.length > 0);
  restricted.missingAnswerApplications = blockers.filter((blocker) => blocker.applicationId).length;
  const snapshot: RentOpsApplicationHistorySnapshot = {
    prospects,
    applications,
    interests,
    participants,
    requirements,
    templates: templateResult.templates,
    templateSections: templateResult.sections,
    templateFields: templateResult.fields,
    answers,
    documents: documentResult.rows,
    activities,
    blockers,
    unknownRestricted: restricted,
  };
  assertValidApplicationHistory(snapshot);
  return snapshot;
}

export function applicationHistoryCase(snapshot: RentOpsApplicationHistorySnapshot, id: string): RentOpsApplicationCase | undefined {
  const application = snapshot.applications.find((candidate) => candidate.id === id);
  const prospect = snapshot.prospects.find((candidate) => candidate.id === id);
  if (!application && !prospect) return undefined;
  const applicationId = application?.id;
  const prospectId = prospect?.id ?? application?.prospectId ?? undefined;
  const parent = (row: { applicationId?: string | null; prospectId?: string | null }) => applicationId
    ? row.applicationId === applicationId || (!row.applicationId && Boolean(prospectId) && row.prospectId === prospectId)
    : Boolean(prospectId) && row.prospectId === prospectId;
  const blockerParent = (blocker: RentOpsApplicationHistoryBlocker) => applicationId
    ? blocker.applicationId === applicationId || (!blocker.applicationId && Boolean(prospectId) && blocker.prospectId === prospectId)
    : Boolean(prospectId) && blocker.prospectId === prospectId;
  return {
    ...(application ? { application } : {}),
    ...(prospect ? { prospect } : application?.prospectId ? { prospect: snapshot.prospects.find((candidate) => candidate.id === application.prospectId) } : {}),
    interests: snapshot.interests.filter(parent),
    participants: snapshot.participants.filter(parent),
    requirements: snapshot.requirements.filter(parent),
    answers: snapshot.answers.filter(parent),
    documents: snapshot.documents.filter(parent),
    activities: snapshot.activities.filter(parent),
    blockers: snapshot.blockers.filter(blockerParent),
    unknownRestricted: snapshot.unknownRestricted,
  };
}
