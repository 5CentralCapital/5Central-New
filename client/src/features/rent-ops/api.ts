import type {
  ApiFilters,
  AdminSnapshot,
  AdminSnapshotView,
  AdminApplicationView,
  AdminApplicationDetailView,
  AdminApplicationHistoryCaseView,
  AdminApplicationHistoryPartyView,
  AdminApplicationHistoryApplicationView,
  AdminApplicationHistoryInterestView,
  AdminApplicationHistoryParticipantView,
  AdminApplicationHistoryRequirementView,
  AdminApplicationHistoryAnswerView,
  AdminApplicationHistoryDocumentView,
  AdminApplicationHistoryActivityView,
  AdminApplicationHistoryBlockerView,
  AdminApplicationHistoryUnknownRestrictedView,
  AdminApplicationHistoryDetailView,
  AdminDocumentView,
  AdminActivityView,
  AdminAddressView,
  AdminChargeDefinitionView,
  AdminHouseholdMembershipView,
  AdminLeaseTermView,
  AdminLedgerTransactionView,
  AdminPaymentAllocationView,
  AdminPersonView,
  AdminPropertyView,
  AdminRecurringScheduleView,
  AdminSecurityDepositView,
  AdminSubsidyContractView,
  AdminTenancyView,
  AdminUnitView,
  AdminApplicationHouseholdMemberView,
  AdminApplicationRequirementView,
  ApplicantPipelineRow,
  CollectedIncomeRow,
  DepositLiabilityRow,
  DelinquencyRow,
  DashboardSummary,
  HapRow,
  LeaseExpirationRow,
  LedgerRow,
  OccupancyRow,
  RentRollRow,
  ScheduledIncomeRow,
  ScheduledVsCollectedRow,
  ReportDefinition,
  ReportKey,
  ReportRow,
  RentOpsLoadResult,
  RentOpsSource,
  RentOpsMutation,
  RentOpsMutationResult,
  TenantView,
} from "./types";
import { createDemoAdminSnapshot, DEMO_AS_OF_DATE } from "./demo";
import { REPORT_KEYS, REPORT_LABELS } from "./types";
import type { ReportColumn } from "./types";
import { rentOpsAuthClient } from "./auth";

/**
 * The browser is an adapter, not a second reporting engine. All financial and
 * occupancy calculations happen in the Rent Operations domain service. The
 * client only fetches those rows, normalizes response envelopes, and applies
 * display-only filters/sorts.
 */

// `vite build` always sets DEV=false, including the explicit local screenshot
// build. Require a second local-only build flag so the compiled synthetic path
// works for browser smoke tests but stays absent from normal production builds.
const DEMO_ALLOWED = Boolean(
  import.meta.env?.VITE_RENT_OPS_DEMO === "true"
  && import.meta.env?.VITE_RENT_OPS_LOCAL_SYNTHETIC_BUILD === "true",
);

type JsonRecord = Record<string, unknown>;

const INVALID_RESPONSE_MESSAGE = "Rent Operations API returned an invalid response.";
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const FACT_KNOWLEDGE = ["source", "unknown", "ambiguous", "inferred", "manual"];
const LINK_KNOWLEDGE = ["exact", "unknown", "ambiguous", "manual"];
const AMOUNT_KNOWLEDGE = ["known", "unknown"];
const RECURRING_DATE_KNOWLEDGE = ["source", "unknown_open_start", "manual"];
const DEPOSIT_DATE_KNOWLEDGE = ["source", "unknown", "manual"];
const DEPOSIT_UNIT_LINK_KNOWLEDGE = ["exact", "unknown", "manual"];
const PROPERTY_TYPES = ["multifamily", "single_family", "other"];
const PROPERTY_STATES = ["active", "archived"];
const READINESS_STATES = ["ready", "not_ready", "off_market"];
const LISTING_STATES = ["listed", "unlisted", "off_market"];
const TENANCY_STATUSES = ["future", "current", "notice", "past", "cancelled"];
const LEASE_STATUSES = ["draft", "executed", "expired", "month_to_month", "cancelled"];
const CHARGE_CATEGORIES = ["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"];
const LEDGER_KINDS = ["charge", "payment", "credit", "reversal", "adjustment"];
const LEDGER_STATUSES = ["posted", "voided", "pending"];
const PAYMENT_METHODS = ["ach", "card", "cash", "check", "money_order", "zelle", "other"];
const PAYERS = ["tenant", "agency", "owner", "unknown"];
const ADJUSTMENT_DIRECTIONS = ["debit", "credit"];
const ALLOCATION_MODES = ["allocation_single", "multi_property", "unknown"];
const RECURRING_SCOPES = ["tenant", "unit", "property"];
const SOURCE_CONFIDENCE = ["confirmed", "inferred", "exception"];
const DEPOSIT_TYPES = ["security", "refundable_pet", "other_refundable"];
const DEPOSIT_STATUSES = ["held", "partially_disposed", "disposed", "returned"];
const SUBSIDY_STATUSES = ["active", "ended", "pending", "exception"];
const APPLICATION_SOURCES = ["public_portal", "manual", "rm_import", "referral", "other"];
const APPLICATION_STATUSES = ["draft", "submitted", "missing_information", "under_review", "approved", "declined", "withdrawn", "converted", "complete", "in_progress", "awaiting_payment"];
const REQUIREMENT_STATUSES = ["requested", "received", "waived", "rejected"];
const DOCUMENT_TYPES = ["lease", "addendum", "identity", "insurance", "notice", "application_attachment", "housing_assistance", "deposit_record", "other"];
const DOCUMENT_STATES = ["requested", "received", "signed", "executed", "filed", "current", "verified", "rejected", "expired", "archived"];
const DOCUMENT_AVAILABILITIES = ["metadata", "requested", "unavailable", "verified"];
const ACTIVITY_TYPES = ["note", "call", "email", "text", "promise_to_pay", "hold", "notice", "system"];
const HISTORY_ANSWER_TYPES = ["unknown", "text", "integer", "decimal", "boolean", "date", "choice", "multi_choice", "money"];
const HISTORY_VALUE_KNOWLEDGE = ["known", "unknown", "ambiguous", "restricted"];
const HISTORY_BLOCKER_CODES = ["application_answers_missing"];
const HISTORY_BLOCKER_REASONS = ["source_collection_missing", "source_collection_empty", "source_rows_unusable"];
const HISTORY_DOCUMENT_AVAILABILITIES = ["metadata", "unavailable"];
const SAFE_ERROR_CODES = ["invalid_input", "invalid_target_id", "not_found", "not_authorized", "rate_limited", "conflict", "versioned_schedule_required", "activity_append_only", "hap_create_requires_provenance", "unknown_report", "unsafe_output", "temporarily_unavailable", "verified_upload_required", "request_failed"];
const FORBIDDEN_RESPONSE_KEYS = new Set([
  "ssn", "socialsecuritynumber", "social_security_number", "dob", "dateofbirth", "date_of_birth",
  "credential", "credentials", "password", "passcode", "secret", "source", "sourceid", "sourcesystem",
  "sourceupdatedat", "sourcerecord", "sourcerecords", "sourcecollection", "import", "imports", "importrecord",
  "importrecords", "importrun", "importruns", "importrunid", "manifest", "manifesthash", "checkpoint", "resume",
  "resumetoken", "resumetokenhash", "resumetokenexpiresat", "token", "hash", "digest", "raw", "rawmetadata",
  "rawpayload", "rawjson", "restricted", "restrictedpayload", "restrictedrows", "payload", "storage", "storagekey",
  "checksum", "checksumsha256", "metadatachecksumsha256", "backend", "bucket", "key", "generation", "version",
  "immutablegeneration", "logicalkey", "verification", "signedurl", "downloadurl", "provenance", "provenancesha256",
  "sourcedefinitionid", "sourcedefinitionkey", "chargedefinitionkey",
]);

export class RentOpsApiError extends Error {
  constructor(readonly code: string | undefined, readonly status: number) {
    super(code === "conflict"
      ? "This record changed since it was opened. The workspace was refreshed; reopen the edit before saving."
      : code === "versioned_schedule_required"
        ? "Recurring schedules require a new version rather than an in-place edit."
      : code === "activity_append_only"
          ? "Activity records are append-only; add a new dated event instead."
            : code === "hap_create_requires_provenance"
              ? "New HAP contracts require explicit source provenance and are not available here."
            : `Rent Operations API returned ${status}.`);
    this.name = "RentOpsApiError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : invalidResponse();
}

function unwrapData(value: unknown): JsonRecord {
  const root = asRecord(value);
  if (Object.keys(root).length === 1 && "data" in root) return asRecord(root.data);
  return root;
}

/** Read a display column without adding an unsafe index signature to DTOs. */
export function reportCell(row: ReportRow, key: string): unknown {
  return isRecord(row) ? Reflect.get(row, key) : undefined;
}

function invalidResponse(): never {
  throw new Error(INVALID_RESPONSE_MESSAGE);
}

function assertNoForbiddenResponseFields(value: unknown, seen = new Set<object>()): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenResponseFields(item, seen);
    return;
  }
  if (!isRecord(value)) return;
  if (seen.has(value)) invalidResponse();
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RESPONSE_KEYS.has(key.toLowerCase())) invalidResponse();
    assertNoForbiddenResponseFields(child, seen);
  }
  seen.delete(value);
}

function exactRecord(value: unknown, label: string, allowedKeys: readonly string[]): JsonRecord {
  if (!isRecord(value)) invalidResponse();
  assertNoForbiddenResponseFields(value);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalidResponse();
  return value;
}

function optionalValue(input: JsonRecord, key: string): unknown {
  const value = input[key];
  return value === undefined ? undefined : value;
}

function optionalText(input: JsonRecord, key: string): string | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : invalidResponse();
}

/**
 * v8 keeps SQL-null distinct from an omitted legacy field.  The positive
 * browser DTOs therefore decode null explicitly instead of silently turning
 * it into an absent value or a fabricated default.
 */
function nullableText(input: JsonRecord, key: string): string | null | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : invalidResponse();
}

function requiredText(input: JsonRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) invalidResponse();
  return value;
}

function validTargetId(value: string): boolean {
  return TARGET_ID_PATTERN.test(value);
}

function optionalId(input: JsonRecord, key: string): string | undefined {
  const value = optionalText(input, key);
  if (value !== undefined && !validTargetId(value)) invalidResponse();
  return value;
}

function nullableId(input: JsonRecord, key: string): string | null | undefined {
  const value = nullableText(input, key);
  if (value !== null && value !== undefined && !validTargetId(value)) invalidResponse();
  return value;
}

function requiredId(input: JsonRecord, key: string): string {
  const value = requiredText(input, key);
  if (!validTargetId(value)) invalidResponse();
  return value;
}

function optionalFinite(input: JsonRecord, key: string): number | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : invalidResponse();
}

function nullableFinite(input: JsonRecord, key: string): number | null | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : invalidResponse();
}

function optionalInteger(input: JsonRecord, key: string): number | undefined {
  const value = optionalFinite(input, key);
  if (value !== undefined && !Number.isSafeInteger(value)) invalidResponse();
  return value;
}

function nullableInteger(input: JsonRecord, key: string): number | null | undefined {
  const value = nullableFinite(input, key);
  if (value !== null && value !== undefined && !Number.isSafeInteger(value)) invalidResponse();
  return value;
}

function optionalRevision(input: JsonRecord): number | undefined {
  const value = optionalInteger(input, "recordRevision");
  if (value !== undefined && value < 1) invalidResponse();
  return value;
}

function optionalMoney(input: JsonRecord, key: string): number | undefined {
  return optionalInteger(input, key);
}

function nullableMoney(input: JsonRecord, key: string): number | null | undefined {
  return nullableInteger(input, key);
}

function requiredMoney(input: JsonRecord, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidResponse();
  return value;
}

function requiredFinite(input: JsonRecord, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) invalidResponse();
  return value;
}

function requiredInteger(input: JsonRecord, key: string): number {
  const value = requiredFinite(input, key);
  if (!Number.isSafeInteger(value)) invalidResponse();
  return value;
}

function optionalBoolean(input: JsonRecord, key: string): boolean | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : invalidResponse();
}

function nullableBoolean(input: JsonRecord, key: string): boolean | null | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "boolean" ? value : invalidResponse();
}

function requiredBoolean(input: JsonRecord, key: string): boolean {
  const value = input[key];
  if (typeof value !== "boolean") invalidResponse();
  return value;
}

function optionalAllowed(input: JsonRecord, key: string, values: readonly string[]): string | undefined {
  const value = optionalText(input, key);
  if (value !== undefined && !values.includes(value)) invalidResponse();
  return value;
}

function nullableAllowed(input: JsonRecord, key: string, values: readonly string[]): string | null | undefined {
  const value = nullableText(input, key);
  if (value !== null && value !== undefined && !values.includes(value)) invalidResponse();
  return value;
}

function requiredAllowed(input: JsonRecord, key: string, values: readonly string[]): string {
  const value = requiredText(input, key);
  if (!values.includes(value)) invalidResponse();
  return value;
}

function optionalEnum<T extends string>(input: JsonRecord, key: string, values: readonly T[]): T | undefined {
  const value = optionalText(input, key);
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) invalidResponse();
  return value as T;
}

function validIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}

function optionalDate(input: JsonRecord, key: string): string | undefined {
  const value = optionalText(input, key);
  if (value !== undefined && !validIsoDate(value)) invalidResponse();
  return value;
}

function nullableDate(input: JsonRecord, key: string): string | null | undefined {
  const value = nullableText(input, key);
  if (value !== null && value !== undefined && !validIsoDate(value)) invalidResponse();
  return value;
}

function optionalMonth(input: JsonRecord, key: string): string | undefined {
  const value = optionalText(input, key);
  if (value !== undefined && !ISO_MONTH_PATTERN.test(value)) invalidResponse();
  return value;
}

function nullableMonth(input: JsonRecord, key: string): string | null | undefined {
  const value = nullableText(input, key);
  if (value !== null && value !== undefined && !ISO_MONTH_PATTERN.test(value)) invalidResponse();
  return value;
}

function optionalTimestamp(input: JsonRecord, key: string): string | undefined {
  const value = optionalText(input, key);
  if (value !== undefined && (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value)))) invalidResponse();
  return value;
}

function requiredTimestamp(input: JsonRecord, key: string): string {
  const value = requiredText(input, key);
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) invalidResponse();
  return value;
}

function requiredDate(input: JsonRecord, key: string): string {
  const value = requiredText(input, key);
  if (!validIsoDate(value)) invalidResponse();
  return value;
}

function optionalStrings(input: JsonRecord, key: string): string[] | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalidResponse();
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") invalidResponse();
    strings.push(item);
  }
  return strings;
}

function requiredArray(input: JsonRecord, key: string): unknown[] {
  const value = input[key];
  if (!Array.isArray(value)) invalidResponse();
  return value;
}

function optionalObject<T>(input: JsonRecord, key: string, decode: (value: unknown) => T): T | undefined {
  const value = optionalValue(input, key);
  return value === undefined ? undefined : decode(value);
}

function optionalArray<T>(input: JsonRecord, key: string, decode: (value: unknown) => T): T[] | undefined {
  const value = optionalValue(input, key);
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalidResponse();
  return value.map(decode);
}

function safeErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "code")) return undefined;
  const code = value.code;
  return typeof code === "string" && SAFE_ERROR_CODES.includes(code) ? code : undefined;
}

type ValueDecoder<T> = (value: unknown) => T;

function requiredArrayOf<T>(input: JsonRecord, key: string, decode: ValueDecoder<T>): T[] {
  const value = input[key];
  if (!Array.isArray(value)) invalidResponse();
  return value.map(decode);
}

function decodeAddress(value: unknown): AdminAddressView {
  const input = exactRecord(value, "address", ["line1", "line2", "city", "state", "postalCode"]);
  return {
    line1: optionalText(input, "line1"),
    line2: optionalText(input, "line2"),
    city: optionalText(input, "city"),
    state: optionalText(input, "state"),
    postalCode: optionalText(input, "postalCode"),
  };
}

function decodeProperty(value: unknown): AdminPropertyView {
  const input = exactRecord(value, "property", ["id", "name", "slug", "address", "propertyType", "state", "operatingContact", "nameKnowledge", "addressKnowledge", "propertyTypeKnowledge", "stateKnowledge", "operatingContactKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    name: optionalText(input, "name"),
    slug: optionalText(input, "slug"),
    address: optionalObject(input, "address", decodeAddress),
    propertyType: optionalAllowed(input, "propertyType", PROPERTY_TYPES),
    state: optionalAllowed(input, "state", PROPERTY_STATES),
    operatingContact: optionalText(input, "operatingContact"),
    nameKnowledge: optionalAllowed(input, "nameKnowledge", FACT_KNOWLEDGE),
    addressKnowledge: optionalAllowed(input, "addressKnowledge", FACT_KNOWLEDGE),
    propertyTypeKnowledge: optionalAllowed(input, "propertyTypeKnowledge", FACT_KNOWLEDGE),
    stateKnowledge: optionalAllowed(input, "stateKnowledge", FACT_KNOWLEDGE),
    operatingContactKnowledge: optionalAllowed(input, "operatingContactKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeUnit(value: unknown): AdminUnitView {
  const input = exactRecord(value, "unit", ["id", "propertyId", "unitNumber", "unitType", "bedrooms", "bathrooms", "squareFeet", "marketRentCents", "defaultDepositCents", "readiness", "listing", "amenities", "accessNotes", "propertyLinkKnowledge", "unitNumberKnowledge", "unitTypeKnowledge", "readinessKnowledge", "listingKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    propertyId: optionalId(input, "propertyId"),
    unitNumber: optionalText(input, "unitNumber"),
    unitType: optionalText(input, "unitType"),
    bedrooms: optionalFinite(input, "bedrooms"),
    bathrooms: optionalFinite(input, "bathrooms"),
    squareFeet: optionalFinite(input, "squareFeet"),
    marketRentCents: optionalMoney(input, "marketRentCents"),
    defaultDepositCents: optionalMoney(input, "defaultDepositCents"),
    readiness: optionalAllowed(input, "readiness", READINESS_STATES),
    listing: optionalAllowed(input, "listing", LISTING_STATES),
    amenities: optionalStrings(input, "amenities"),
    accessNotes: optionalText(input, "accessNotes"),
    propertyLinkKnowledge: optionalAllowed(input, "propertyLinkKnowledge", LINK_KNOWLEDGE),
    unitNumberKnowledge: optionalAllowed(input, "unitNumberKnowledge", FACT_KNOWLEDGE),
    unitTypeKnowledge: optionalAllowed(input, "unitTypeKnowledge", FACT_KNOWLEDGE),
    readinessKnowledge: optionalAllowed(input, "readinessKnowledge", FACT_KNOWLEDGE),
    listingKnowledge: optionalAllowed(input, "listingKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodePhoneMethod(value: unknown): { id?: string; value?: string; type?: string; isPrimary?: boolean; isTextReady?: boolean } {
  const input = exactRecord(value, "phone method", ["id", "value", "type", "isPrimary", "isTextReady"]);
  return {
    id: optionalId(input, "id"),
    value: optionalText(input, "value"),
    type: optionalText(input, "type"),
    isPrimary: optionalBoolean(input, "isPrimary"),
    isTextReady: optionalBoolean(input, "isTextReady"),
  };
}

function decodePerson(value: unknown): AdminPersonView {
  const input = exactRecord(value, "person", ["id", "firstName", "lastName", "email", "phone", "phoneMethods", "renterInsuranceExpiresOn", "archived", "archivedKnowledge", "firstNameKnowledge", "lastNameKnowledge", "emailKnowledge", "phoneKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    firstName: optionalText(input, "firstName"),
    lastName: optionalText(input, "lastName"),
    email: optionalText(input, "email"),
    phone: optionalText(input, "phone"),
    phoneMethods: optionalArray(input, "phoneMethods", decodePhoneMethod),
    renterInsuranceExpiresOn: optionalDate(input, "renterInsuranceExpiresOn"),
    archived: optionalBoolean(input, "archived"),
    archivedKnowledge: optionalAllowed(input, "archivedKnowledge", FACT_KNOWLEDGE),
    firstNameKnowledge: optionalAllowed(input, "firstNameKnowledge", FACT_KNOWLEDGE),
    lastNameKnowledge: optionalAllowed(input, "lastNameKnowledge", FACT_KNOWLEDGE),
    emailKnowledge: optionalAllowed(input, "emailKnowledge", FACT_KNOWLEDGE),
    phoneKnowledge: optionalAllowed(input, "phoneKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeHouseholdMembership(value: unknown): AdminHouseholdMembershipView {
  const input = exactRecord(value, "household membership", ["id", "tenancyId", "applicationId", "personId", "accountPersonId", "role", "relationship", "isFinanciallyResponsible", "roleKnowledge", "relationshipKnowledge", "responsibilityKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    tenancyId: optionalId(input, "tenancyId"),
    applicationId: optionalId(input, "applicationId"),
    personId: optionalId(input, "personId"),
    accountPersonId: optionalId(input, "accountPersonId"),
    role: optionalText(input, "role"),
    relationship: optionalText(input, "relationship"),
    isFinanciallyResponsible: optionalBoolean(input, "isFinanciallyResponsible"),
    roleKnowledge: optionalAllowed(input, "roleKnowledge", FACT_KNOWLEDGE),
    relationshipKnowledge: optionalAllowed(input, "relationshipKnowledge", FACT_KNOWLEDGE),
    responsibilityKnowledge: optionalAllowed(input, "responsibilityKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeTenancy(value: unknown): AdminTenancyView {
  const input = exactRecord(value, "tenancy", ["id", "propertyId", "unitId", "primaryPersonId", "status", "plannedMoveInOn", "actualMoveInOn", "noticeOn", "expectedMoveOutOn", "actualMoveOutOn", "createdAt", "endedAt", "applicationId", "propertyLinkKnowledge", "unitLinkKnowledge", "primaryPersonLinkKnowledge", "statusKnowledge", "plannedMoveInKnowledge", "actualMoveInKnowledge", "noticeKnowledge", "expectedMoveOutKnowledge", "actualMoveOutKnowledge", "createdAtKnowledge", "endedAtKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    primaryPersonId: optionalId(input, "primaryPersonId"),
    status: optionalAllowed(input, "status", TENANCY_STATUSES),
    plannedMoveInOn: optionalDate(input, "plannedMoveInOn"),
    actualMoveInOn: optionalDate(input, "actualMoveInOn"),
    noticeOn: optionalDate(input, "noticeOn"),
    expectedMoveOutOn: optionalDate(input, "expectedMoveOutOn"),
    actualMoveOutOn: optionalDate(input, "actualMoveOutOn"),
    createdAt: optionalTimestamp(input, "createdAt"),
    endedAt: optionalTimestamp(input, "endedAt"),
    applicationId: optionalId(input, "applicationId"),
    propertyLinkKnowledge: optionalAllowed(input, "propertyLinkKnowledge", LINK_KNOWLEDGE),
    unitLinkKnowledge: optionalAllowed(input, "unitLinkKnowledge", LINK_KNOWLEDGE),
    primaryPersonLinkKnowledge: optionalAllowed(input, "primaryPersonLinkKnowledge", LINK_KNOWLEDGE),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
    plannedMoveInKnowledge: optionalAllowed(input, "plannedMoveInKnowledge", FACT_KNOWLEDGE),
    actualMoveInKnowledge: optionalAllowed(input, "actualMoveInKnowledge", FACT_KNOWLEDGE),
    noticeKnowledge: optionalAllowed(input, "noticeKnowledge", FACT_KNOWLEDGE),
    expectedMoveOutKnowledge: optionalAllowed(input, "expectedMoveOutKnowledge", FACT_KNOWLEDGE),
    actualMoveOutKnowledge: optionalAllowed(input, "actualMoveOutKnowledge", FACT_KNOWLEDGE),
    createdAtKnowledge: optionalAllowed(input, "createdAtKnowledge", FACT_KNOWLEDGE),
    endedAtKnowledge: optionalAllowed(input, "endedAtKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeLeaseTerm(value: unknown): AdminLeaseTermView {
  const input = exactRecord(value, "lease term", ["id", "tenancyId", "status", "contractStartOn", "contractEndOn", "monthToMonth", "signedOn", "executedDocumentId", "renewalOfId", "createdAt", "tenancyLinkKnowledge", "statusKnowledge", "contractStartKnowledge", "contractEndKnowledge", "signedOnKnowledge", "monthToMonthKnowledge", "createdAtKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    tenancyId: optionalId(input, "tenancyId"),
    status: optionalAllowed(input, "status", LEASE_STATUSES),
    contractStartOn: optionalDate(input, "contractStartOn"),
    contractEndOn: optionalDate(input, "contractEndOn"),
    monthToMonth: optionalBoolean(input, "monthToMonth"),
    signedOn: optionalDate(input, "signedOn"),
    executedDocumentId: optionalId(input, "executedDocumentId"),
    renewalOfId: optionalId(input, "renewalOfId"),
    createdAt: optionalTimestamp(input, "createdAt"),
    tenancyLinkKnowledge: optionalAllowed(input, "tenancyLinkKnowledge", LINK_KNOWLEDGE),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
    contractStartKnowledge: optionalAllowed(input, "contractStartKnowledge", FACT_KNOWLEDGE),
    contractEndKnowledge: optionalAllowed(input, "contractEndKnowledge", FACT_KNOWLEDGE),
    signedOnKnowledge: optionalAllowed(input, "signedOnKnowledge", FACT_KNOWLEDGE),
    monthToMonthKnowledge: optionalAllowed(input, "monthToMonthKnowledge", FACT_KNOWLEDGE),
    createdAtKnowledge: optionalAllowed(input, "createdAtKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeRecurringSchedule(value: unknown): AdminRecurringScheduleView {
  const input = exactRecord(value, "recurring schedule", ["id", "chargeDefinitionId", "billingFrequency", "scopeType", "scopeId", "tenancyId", "personId", "propertyId", "unitId", "category", "description", "descriptionKnowledge", "amountCents", "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "active", "activeKnowledge", "sourceConfidence", "chargeDefinitionKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    chargeDefinitionId: nullableId(input, "chargeDefinitionId"),
    billingFrequency: input.billingFrequency === null ? null : optionalEnum(input, "billingFrequency", ["monthly"] as const),
    scopeType: nullableAllowed(input, "scopeType", RECURRING_SCOPES),
    scopeId: nullableId(input, "scopeId"),
    tenancyId: nullableId(input, "tenancyId"),
    personId: nullableId(input, "personId"),
    propertyId: nullableId(input, "propertyId"),
    unitId: nullableId(input, "unitId"),
    category: nullableAllowed(input, "category", CHARGE_CATEGORIES),
    description: nullableText(input, "description"),
    descriptionKnowledge: nullableAllowed(input, "descriptionKnowledge", FACT_KNOWLEDGE),
    amountCents: nullableMoney(input, "amountCents"),
    effectiveFrom: nullableDate(input, "effectiveFrom"),
    effectiveFromKnowledge: nullableAllowed(input, "effectiveFromKnowledge", RECURRING_DATE_KNOWLEDGE),
    effectiveTo: nullableDate(input, "effectiveTo"),
    active: nullableBoolean(input, "active"),
    activeKnowledge: nullableAllowed(input, "activeKnowledge", FACT_KNOWLEDGE),
    sourceConfidence: nullableAllowed(input, "sourceConfidence", SOURCE_CONFIDENCE),
    chargeDefinitionKnowledge: nullableAllowed(input, "chargeDefinitionKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeChargeDefinition(value: unknown): AdminChargeDefinitionView {
  const input = exactRecord(value, "charge definition", ["id", "displayName", "displayNameKnowledge", "category", "categoryKnowledge", "active", "activeKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    displayName: nullableText(input, "displayName"),
    displayNameKnowledge: nullableAllowed(input, "displayNameKnowledge", FACT_KNOWLEDGE),
    category: nullableAllowed(input, "category", CHARGE_CATEGORIES),
    categoryKnowledge: nullableAllowed(input, "categoryKnowledge", FACT_KNOWLEDGE),
    active: nullableBoolean(input, "active"),
    activeKnowledge: nullableAllowed(input, "activeKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeLedgerTransaction(value: unknown): AdminLedgerTransactionView {
  const input = exactRecord(value, "ledger transaction", ["id", "propertyId", "unitId", "tenancyId", "personId", "kind", "category", "status", "amountCents", "postedOn", "dueOn", "paymentMethod", "description", "reversalOfId", "payer", "adjustmentDirection", "propertyLinkKnowledge", "unitLinkKnowledge", "tenancyLinkKnowledge", "personLinkKnowledge", "amountKnowledge", "postedOnKnowledge", "dueOnKnowledge", "descriptionKnowledge", "statusKnowledge", "allocationMode"]);
  return {
    id: optionalId(input, "id"),
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    tenancyId: optionalId(input, "tenancyId"),
    personId: optionalId(input, "personId"),
    kind: optionalAllowed(input, "kind", LEDGER_KINDS),
    category: optionalAllowed(input, "category", CHARGE_CATEGORIES),
    status: optionalAllowed(input, "status", LEDGER_STATUSES),
    amountCents: optionalMoney(input, "amountCents"),
    postedOn: optionalDate(input, "postedOn"),
    dueOn: optionalDate(input, "dueOn"),
    paymentMethod: optionalAllowed(input, "paymentMethod", PAYMENT_METHODS),
    description: optionalText(input, "description"),
    reversalOfId: optionalId(input, "reversalOfId"),
    payer: optionalAllowed(input, "payer", PAYERS),
    adjustmentDirection: optionalAllowed(input, "adjustmentDirection", ADJUSTMENT_DIRECTIONS),
    propertyLinkKnowledge: optionalAllowed(input, "propertyLinkKnowledge", LINK_KNOWLEDGE),
    unitLinkKnowledge: optionalAllowed(input, "unitLinkKnowledge", LINK_KNOWLEDGE),
    tenancyLinkKnowledge: optionalAllowed(input, "tenancyLinkKnowledge", LINK_KNOWLEDGE),
    personLinkKnowledge: optionalAllowed(input, "personLinkKnowledge", LINK_KNOWLEDGE),
    amountKnowledge: optionalAllowed(input, "amountKnowledge", AMOUNT_KNOWLEDGE),
    postedOnKnowledge: optionalAllowed(input, "postedOnKnowledge", FACT_KNOWLEDGE),
    dueOnKnowledge: optionalAllowed(input, "dueOnKnowledge", FACT_KNOWLEDGE),
    descriptionKnowledge: optionalAllowed(input, "descriptionKnowledge", FACT_KNOWLEDGE),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
    allocationMode: optionalAllowed(input, "allocationMode", ALLOCATION_MODES),
  };
}

function decodePaymentAllocation(value: unknown): AdminPaymentAllocationView {
  const input = exactRecord(value, "payment allocation", ["id", "kind", "paymentTransactionId", "chargeTransactionId", "amountCents", "allocatedOn", "paymentLinkKnowledge", "chargeLinkKnowledge", "amountKnowledge", "allocatedOnKnowledge"]);
  return {
    id: optionalId(input, "id"),
    kind: optionalEnum(input, "kind", ["allocation", "reversal", "transfer", "credit_allocation"] as const),
    paymentTransactionId: optionalId(input, "paymentTransactionId"),
    chargeTransactionId: optionalId(input, "chargeTransactionId"),
    amountCents: optionalMoney(input, "amountCents"),
    allocatedOn: optionalDate(input, "allocatedOn"),
    paymentLinkKnowledge: optionalAllowed(input, "paymentLinkKnowledge", LINK_KNOWLEDGE),
    chargeLinkKnowledge: optionalAllowed(input, "chargeLinkKnowledge", LINK_KNOWLEDGE),
    amountKnowledge: optionalAllowed(input, "amountKnowledge", AMOUNT_KNOWLEDGE),
    allocatedOnKnowledge: optionalAllowed(input, "allocatedOnKnowledge", DEPOSIT_DATE_KNOWLEDGE),
  };
}

function decodeSecurityDeposit(value: unknown): AdminSecurityDepositView {
  const input = exactRecord(value, "security deposit", ["id", "propertyId", "propertyLinkKnowledge", "unitId", "unitLinkKnowledge", "tenancyId", "personId", "personLinkKnowledge", "type", "typeKnowledge", "amountHeldCents", "sourceBalanceCents", "receivedOn", "receivedOnKnowledge", "dispositionStatus", "dispositionStatusKnowledge", "disposedOn", "dispositionNotes", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    propertyId: optionalId(input, "propertyId"),
    propertyLinkKnowledge: optionalAllowed(input, "propertyLinkKnowledge", LINK_KNOWLEDGE),
    unitId: optionalId(input, "unitId"),
    unitLinkKnowledge: optionalAllowed(input, "unitLinkKnowledge", DEPOSIT_UNIT_LINK_KNOWLEDGE),
    tenancyId: optionalId(input, "tenancyId"),
    personId: optionalId(input, "personId"),
    personLinkKnowledge: optionalAllowed(input, "personLinkKnowledge", LINK_KNOWLEDGE),
    type: optionalAllowed(input, "type", DEPOSIT_TYPES),
    typeKnowledge: optionalAllowed(input, "typeKnowledge", FACT_KNOWLEDGE),
    amountHeldCents: nullableMoney(input, "amountHeldCents"),
    sourceBalanceCents: nullableMoney(input, "sourceBalanceCents"),
    receivedOn: optionalDate(input, "receivedOn"),
    receivedOnKnowledge: optionalAllowed(input, "receivedOnKnowledge", DEPOSIT_DATE_KNOWLEDGE),
    dispositionStatus: optionalAllowed(input, "dispositionStatus", DEPOSIT_STATUSES),
    dispositionStatusKnowledge: optionalAllowed(input, "dispositionStatusKnowledge", FACT_KNOWLEDGE),
    disposedOn: optionalDate(input, "disposedOn"),
    dispositionNotes: optionalText(input, "dispositionNotes"),
    recordRevision: optionalRevision(input),
  };
}

function decodeSubsidyContract(value: unknown): AdminSubsidyContractView {
  const input = exactRecord(value, "subsidy contract", ["id", "propertyId", "unitId", "tenancyId", "agencyName", "contractNumber", "effectiveFrom", "effectiveTo", "agencyObligationCents", "tenantObligationCents", "status", "statusKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    tenancyId: optionalId(input, "tenancyId"),
    agencyName: optionalText(input, "agencyName"),
    contractNumber: optionalText(input, "contractNumber"),
    effectiveFrom: optionalDate(input, "effectiveFrom"),
    effectiveTo: optionalDate(input, "effectiveTo"),
    agencyObligationCents: optionalMoney(input, "agencyObligationCents"),
    tenantObligationCents: optionalMoney(input, "tenantObligationCents"),
    status: optionalAllowed(input, "status", SUBSIDY_STATUSES),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeRentalHistory(value: unknown): Record<string, unknown> {
  const input = exactRecord(value, "rental history", ["currentAddress", "priorAddress", "landlordName", "landlordContact", "reasonForMoving"]);
  return {
    currentAddress: optionalText(input, "currentAddress"),
    priorAddress: optionalText(input, "priorAddress"),
    landlordName: optionalText(input, "landlordName"),
    landlordContact: optionalText(input, "landlordContact"),
    reasonForMoving: optionalText(input, "reasonForMoving"),
  };
}

function decodeEmployment(value: unknown): Record<string, unknown> {
  const input = exactRecord(value, "employment", ["employerName", "jobTitle", "monthlyIncomeCents", "employmentStartOn"]);
  return {
    employerName: optionalText(input, "employerName"),
    jobTitle: optionalText(input, "jobTitle"),
    monthlyIncomeCents: optionalMoney(input, "monthlyIncomeCents"),
    employmentStartOn: optionalDate(input, "employmentStartOn"),
  };
}

function decodeHouseholdSummary(value: unknown): Record<string, unknown> {
  const input = exactRecord(value, "household summary", ["adults", "children", "totalOccupants"]);
  return {
    adults: optionalFinite(input, "adults"),
    children: optionalFinite(input, "children"),
    totalOccupants: optionalFinite(input, "totalOccupants"),
  };
}

function decodeApplicationPreferences(value: unknown): { desiredMoveInOn?: string; desiredLeaseMonths?: number; maxRentCents?: number; bedrooms?: number } {
  const input = exactRecord(value, "application preferences", ["desiredMoveInOn", "desiredLeaseMonths", "maxRentCents", "bedrooms"]);
  return {
    desiredMoveInOn: optionalDate(input, "desiredMoveInOn"),
    desiredLeaseMonths: optionalInteger(input, "desiredLeaseMonths"),
    maxRentCents: optionalMoney(input, "maxRentCents"),
    bedrooms: optionalFinite(input, "bedrooms"),
  };
}

function decodeVoucher(value: unknown): { hasVoucher?: boolean; agencyName?: string; caseNumber?: string; tenantPortionCents?: number } {
  const input = exactRecord(value, "voucher", ["hasVoucher", "agencyName", "caseNumber", "tenantPortionCents"]);
  return {
    hasVoucher: optionalBoolean(input, "hasVoucher"),
    agencyName: optionalText(input, "agencyName"),
    caseNumber: optionalText(input, "caseNumber"),
    tenantPortionCents: optionalMoney(input, "tenantPortionCents"),
  };
}

function decodePet(value: unknown): Record<string, unknown> {
  const input = exactRecord(value, "pet", ["type", "name", "weightLb"]);
  return { type: optionalText(input, "type"), name: optionalText(input, "name"), weightLb: optionalFinite(input, "weightLb") };
}

function decodeVehicle(value: unknown): Record<string, unknown> {
  const input = exactRecord(value, "vehicle", ["makeModel", "plateState", "plateLastFour"]);
  return { makeModel: optionalText(input, "makeModel"), plateState: optionalText(input, "plateState"), plateLastFour: optionalText(input, "plateLastFour") };
}

function decodeEmergencyContact(value: unknown): Record<string, unknown> {
  const input = exactRecord(value, "emergency contact", ["name", "phone", "relationship"]);
  return { name: optionalText(input, "name"), phone: optionalText(input, "phone"), relationship: optionalText(input, "relationship") };
}

const APPLICATION_RESPONSE_KEYS = ["id", "sourceType", "status", "email", "firstName", "lastName", "phone", "propertyId", "unitId", "submittedOn", "certificationAcceptedOn", "convertedTenancyId", "createdAt", "updatedAt", "rentalHistory", "employment", "householdSummary", "preferences", "voucher", "pets", "vehicles", "emergencyContact", "sourceTypeKnowledge", "statusKnowledge", "emailKnowledge", "firstNameKnowledge", "lastNameKnowledge", "phoneKnowledge", "propertyLinkKnowledge", "unitLinkKnowledge", "submittedOnKnowledge", "certificationAcceptedOnKnowledge", "createdAtKnowledge", "updatedAtKnowledge", "recordRevision"] as const;

function decodeApplicationFields(input: JsonRecord): AdminApplicationView {
  return {
    id: optionalId(input, "id"),
    sourceType: optionalAllowed(input, "sourceType", APPLICATION_SOURCES),
    status: optionalAllowed(input, "status", APPLICATION_STATUSES),
    email: optionalText(input, "email"),
    firstName: optionalText(input, "firstName"),
    lastName: optionalText(input, "lastName"),
    phone: optionalText(input, "phone"),
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    submittedOn: optionalDate(input, "submittedOn"),
    certificationAcceptedOn: optionalDate(input, "certificationAcceptedOn"),
    convertedTenancyId: optionalId(input, "convertedTenancyId"),
    createdAt: optionalTimestamp(input, "createdAt"),
    updatedAt: optionalTimestamp(input, "updatedAt"),
    rentalHistory: optionalObject(input, "rentalHistory", decodeRentalHistory),
    employment: optionalObject(input, "employment", decodeEmployment),
    householdSummary: optionalObject(input, "householdSummary", decodeHouseholdSummary),
    preferences: optionalObject(input, "preferences", decodeApplicationPreferences),
    voucher: optionalObject(input, "voucher", decodeVoucher),
    pets: optionalArray(input, "pets", decodePet),
    vehicles: optionalArray(input, "vehicles", decodeVehicle),
    emergencyContact: optionalObject(input, "emergencyContact", decodeEmergencyContact),
    sourceTypeKnowledge: optionalAllowed(input, "sourceTypeKnowledge", FACT_KNOWLEDGE),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
    emailKnowledge: optionalAllowed(input, "emailKnowledge", FACT_KNOWLEDGE),
    firstNameKnowledge: optionalAllowed(input, "firstNameKnowledge", FACT_KNOWLEDGE),
    lastNameKnowledge: optionalAllowed(input, "lastNameKnowledge", FACT_KNOWLEDGE),
    phoneKnowledge: optionalAllowed(input, "phoneKnowledge", FACT_KNOWLEDGE),
    propertyLinkKnowledge: optionalAllowed(input, "propertyLinkKnowledge", LINK_KNOWLEDGE),
    unitLinkKnowledge: optionalAllowed(input, "unitLinkKnowledge", LINK_KNOWLEDGE),
    submittedOnKnowledge: optionalAllowed(input, "submittedOnKnowledge", FACT_KNOWLEDGE),
    certificationAcceptedOnKnowledge: optionalAllowed(input, "certificationAcceptedOnKnowledge", FACT_KNOWLEDGE),
    createdAtKnowledge: optionalAllowed(input, "createdAtKnowledge", FACT_KNOWLEDGE),
    updatedAtKnowledge: optionalAllowed(input, "updatedAtKnowledge", FACT_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeApplication(value: unknown): AdminApplicationView {
  return decodeApplicationFields(exactRecord(value, "application", APPLICATION_RESPONSE_KEYS));
}

function decodeApplicationHistoryPartyFields(input: JsonRecord): AdminApplicationHistoryPartyView {
  return {
    firstName: optionalText(input, "firstName"),
    lastName: optionalText(input, "lastName"),
    email: optionalText(input, "email"),
    phone: optionalText(input, "phone"),
    status: optionalAllowed(input, "status", APPLICATION_STATUSES),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
    submittedOn: optionalDate(input, "submittedOn"),
    submittedOnKnowledge: optionalAllowed(input, "submittedOnKnowledge", FACT_KNOWLEDGE),
    createdOn: optionalDate(input, "createdOn"),
    createdOnKnowledge: optionalAllowed(input, "createdOnKnowledge", FACT_KNOWLEDGE),
    updatedOn: optionalDate(input, "updatedOn"),
    updatedOnKnowledge: optionalAllowed(input, "updatedOnKnowledge", FACT_KNOWLEDGE),
  };
}

function decodeApplicationHistoryParty(value: unknown): AdminApplicationHistoryPartyView {
  const input = exactRecord(value, "historical application party", ["firstName", "lastName", "email", "phone", "status", "statusKnowledge", "submittedOn", "submittedOnKnowledge", "createdOn", "createdOnKnowledge", "updatedOn", "updatedOnKnowledge"]);
  return decodeApplicationHistoryPartyFields(input);
}

function decodeApplicationHistoryApplication(value: unknown): AdminApplicationHistoryApplicationView {
  const input = exactRecord(value, "historical application", ["id", "firstName", "lastName", "email", "phone", "status", "statusKnowledge", "submittedOn", "submittedOnKnowledge", "createdOn", "createdOnKnowledge", "updatedOn", "updatedOnKnowledge"]);
  return {
    id: requiredId(input, "id"),
    ...decodeApplicationHistoryPartyFields(input),
  };
}

function decodeApplicationHistoryInterest(value: unknown): AdminApplicationHistoryInterestView {
  const input = exactRecord(value, "historical application interest", ["propertyId", "unitId", "sourceOrder", "sourceRank", "preference", "preferenceKnowledge", "interestedOn", "interestedOnKnowledge", "rentCents", "rentKnowledge", "bedrooms", "bedroomsKnowledge", "status", "statusKnowledge"]);
  return {
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    sourceOrder: optionalInteger(input, "sourceOrder"),
    sourceRank: optionalInteger(input, "sourceRank"),
    preference: optionalText(input, "preference"),
    preferenceKnowledge: optionalAllowed(input, "preferenceKnowledge", FACT_KNOWLEDGE),
    interestedOn: optionalDate(input, "interestedOn"),
    interestedOnKnowledge: optionalAllowed(input, "interestedOnKnowledge", FACT_KNOWLEDGE),
    rentCents: optionalMoney(input, "rentCents"),
    rentKnowledge: optionalAllowed(input, "rentKnowledge", AMOUNT_KNOWLEDGE),
    bedrooms: optionalInteger(input, "bedrooms"),
    bedroomsKnowledge: optionalAllowed(input, "bedroomsKnowledge", FACT_KNOWLEDGE),
    status: optionalText(input, "status"),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
  };
}

function decodeApplicationHistoryParticipant(value: unknown): AdminApplicationHistoryParticipantView {
  const input = exactRecord(value, "historical application participant", ["sourceOrder", "role", "roleKnowledge", "relationship", "relationshipKnowledge", "isMinor", "minorKnowledge", "isFinanciallyResponsible", "financialResponsibilityKnowledge"]);
  return {
    sourceOrder: optionalInteger(input, "sourceOrder"),
    role: optionalText(input, "role"),
    roleKnowledge: optionalAllowed(input, "roleKnowledge", FACT_KNOWLEDGE),
    relationship: optionalText(input, "relationship"),
    relationshipKnowledge: optionalAllowed(input, "relationshipKnowledge", FACT_KNOWLEDGE),
    isMinor: optionalBoolean(input, "isMinor"),
    minorKnowledge: optionalAllowed(input, "minorKnowledge", FACT_KNOWLEDGE),
    isFinanciallyResponsible: optionalBoolean(input, "isFinanciallyResponsible"),
    financialResponsibilityKnowledge: optionalAllowed(input, "financialResponsibilityKnowledge", FACT_KNOWLEDGE),
  };
}

function decodeApplicationHistoryRequirement(value: unknown): AdminApplicationHistoryRequirementView {
  const input = exactRecord(value, "historical application requirement", ["label", "status", "statusKnowledge", "requestedOn", "requestedOnKnowledge", "resolvedOn", "resolvedOnKnowledge", "hasDocument"]);
  return {
    label: optionalText(input, "label"),
    status: optionalAllowed(input, "status", REQUIREMENT_STATUSES),
    statusKnowledge: optionalAllowed(input, "statusKnowledge", FACT_KNOWLEDGE),
    requestedOn: optionalDate(input, "requestedOn"),
    requestedOnKnowledge: optionalAllowed(input, "requestedOnKnowledge", FACT_KNOWLEDGE),
    resolvedOn: optionalDate(input, "resolvedOn"),
    resolvedOnKnowledge: optionalAllowed(input, "resolvedOnKnowledge", FACT_KNOWLEDGE),
    hasDocument: optionalBoolean(input, "hasDocument"),
  };
}

function decodeApplicationHistoryAnswer(value: unknown): AdminApplicationHistoryAnswerView {
  const input = exactRecord(value, "historical application answer", ["valueType", "valueKnowledge", "fieldLinkKnowledge"]);
  return {
    valueType: requiredAllowed(input, "valueType", HISTORY_ANSWER_TYPES),
    valueKnowledge: requiredAllowed(input, "valueKnowledge", HISTORY_VALUE_KNOWLEDGE),
    fieldLinkKnowledge: optionalAllowed(input, "fieldLinkKnowledge", LINK_KNOWLEDGE),
  };
}

function decodeApplicationHistoryDocument(value: unknown): AdminApplicationHistoryDocumentView {
  const input = exactRecord(value, "historical application document", ["type", "typeKnowledge", "state", "stateKnowledge", "fileName", "mimeType", "metadataSizeBytes", "availability"]);
  return {
    type: optionalAllowed(input, "type", DOCUMENT_TYPES),
    typeKnowledge: optionalAllowed(input, "typeKnowledge", FACT_KNOWLEDGE),
    state: optionalAllowed(input, "state", DOCUMENT_STATES),
    stateKnowledge: optionalAllowed(input, "stateKnowledge", FACT_KNOWLEDGE),
    fileName: optionalText(input, "fileName"),
    mimeType: optionalText(input, "mimeType"),
    metadataSizeBytes: optionalInteger(input, "metadataSizeBytes"),
    availability: requiredAllowed(input, "availability", HISTORY_DOCUMENT_AVAILABILITIES) as "metadata" | "unavailable",
  };
}

function decodeApplicationHistoryActivity(value: unknown): AdminApplicationHistoryActivityView {
  const input = exactRecord(value, "historical application activity", ["type", "occurredAt", "occurredAtKnowledge", "summary", "summaryKnowledge"]);
  return {
    type: optionalAllowed(input, "type", ACTIVITY_TYPES),
    occurredAt: optionalTimestamp(input, "occurredAt"),
    occurredAtKnowledge: optionalAllowed(input, "occurredAtKnowledge", FACT_KNOWLEDGE),
    summary: optionalText(input, "summary"),
    summaryKnowledge: optionalAllowed(input, "summaryKnowledge", FACT_KNOWLEDGE),
  };
}

function decodeApplicationHistoryBlocker(value: unknown): AdminApplicationHistoryBlockerView {
  const input = exactRecord(value, "historical application blocker", ["code", "occurrenceCount", "reason"]);
  return {
    code: requiredAllowed(input, "code", HISTORY_BLOCKER_CODES),
    occurrenceCount: requiredInteger(input, "occurrenceCount"),
    reason: requiredAllowed(input, "reason", HISTORY_BLOCKER_REASONS),
  };
}

function decodeApplicationHistoryUnknownRestricted(value: unknown): AdminApplicationHistoryUnknownRestrictedView {
  const input = exactRecord(value, "historical application unknown/restricted summary", ["restrictedAnswerCount", "unmappedAnswerCount", "missingAnswerApplications", "metadataOnlyDocumentCount", "unavailableDocumentCount", "unlinkedActivityCount", "unlinkedInterestCount"]);
  return {
    restrictedAnswerCount: requiredInteger(input, "restrictedAnswerCount"),
    unmappedAnswerCount: requiredInteger(input, "unmappedAnswerCount"),
    missingAnswerApplications: requiredInteger(input, "missingAnswerApplications"),
    metadataOnlyDocumentCount: requiredInteger(input, "metadataOnlyDocumentCount"),
    unavailableDocumentCount: requiredInteger(input, "unavailableDocumentCount"),
    unlinkedActivityCount: requiredInteger(input, "unlinkedActivityCount"),
    unlinkedInterestCount: requiredInteger(input, "unlinkedInterestCount"),
  };
}

/** Strict decoder for the v9 positive historical case section. */
export function decodeRentOpsApplicationHistoryCase(value: unknown): AdminApplicationHistoryCaseView {
  const input = exactRecord(value, "historical application case", ["application", "prospect", "interests", "participants", "requirements", "answers", "documents", "activities", "blockers", "unknownRestricted"]);
  return {
    application: optionalObject(input, "application", decodeApplicationHistoryApplication),
    prospect: optionalObject(input, "prospect", decodeApplicationHistoryParty),
    interests: requiredArrayOf(input, "interests", decodeApplicationHistoryInterest),
    participants: requiredArrayOf(input, "participants", decodeApplicationHistoryParticipant),
    requirements: requiredArrayOf(input, "requirements", decodeApplicationHistoryRequirement),
    answers: requiredArrayOf(input, "answers", decodeApplicationHistoryAnswer),
    documents: requiredArrayOf(input, "documents", decodeApplicationHistoryDocument),
    activities: requiredArrayOf(input, "activities", decodeApplicationHistoryActivity),
    blockers: requiredArrayOf(input, "blockers", decodeApplicationHistoryBlocker),
    unknownRestricted: decodeApplicationHistoryUnknownRestricted(input.unknownRestricted),
  };
}

export const decodeRentOpsApplicationHistory = decodeRentOpsApplicationHistoryCase;

/** Decode the current positive `/api/rent-ops/applications/:id` response. */
export function decodeRentOpsApplicationDetail(value: unknown): AdminApplicationDetailView {
  const input = exactRecord(value, "application detail", [...APPLICATION_RESPONSE_KEYS, "householdMembers", "requirements", "documents", "history"]);
  return {
    ...decodeApplicationFields(input),
    householdMembers: requiredArrayOf(input, "householdMembers", decodeApplicationHouseholdMember),
    requirements: requiredArrayOf(input, "requirements", decodeApplicationRequirement),
    documents: requiredArrayOf(input, "documents", decodeDocument),
    history: optionalObject(input, "history", decodeRentOpsApplicationHistoryCase),
  };
}

export function decodeRentOpsApplicationHistoryDetail(value: unknown): AdminApplicationHistoryDetailView {
  const input = exactRecord(value, "historical application detail", ["history"]);
  return { history: decodeRentOpsApplicationHistoryCase(input.history) };
}

function decodeApplicationHouseholdMember(value: unknown): AdminApplicationHouseholdMemberView {
  const input = exactRecord(value, "application household member", ["id", "applicationId", "firstName", "lastName", "relationship", "email", "phone", "isMinor"]);
  return {
    id: optionalId(input, "id"),
    applicationId: optionalId(input, "applicationId"),
    firstName: optionalText(input, "firstName"),
    lastName: optionalText(input, "lastName"),
    relationship: optionalText(input, "relationship"),
    email: optionalText(input, "email"),
    phone: optionalText(input, "phone"),
    isMinor: optionalBoolean(input, "isMinor"),
  };
}

function decodeApplicationRequirement(value: unknown): AdminApplicationRequirementView {
  const input = exactRecord(value, "application requirement", ["id", "applicationId", "label", "status", "documentId", "requestedOn", "resolvedOn"]);
  return {
    id: optionalId(input, "id"),
    applicationId: optionalId(input, "applicationId"),
    label: optionalText(input, "label"),
    status: optionalAllowed(input, "status", REQUIREMENT_STATUSES),
    documentId: optionalId(input, "documentId"),
    requestedOn: optionalDate(input, "requestedOn"),
    resolvedOn: optionalDate(input, "resolvedOn"),
  };
}

function decodeDocument(value: unknown): AdminDocumentView {
  const input = exactRecord(value, "document", ["id", "propertyId", "unitId", "personId", "tenancyId", "applicationId", "type", "state", "fileName", "mimeType", "sizeBytes", "uploadedAt", "verifiedAt", "availability", "downloadAvailable", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    personId: optionalId(input, "personId"),
    tenancyId: optionalId(input, "tenancyId"),
    applicationId: optionalId(input, "applicationId"),
    type: optionalAllowed(input, "type", DOCUMENT_TYPES),
    state: optionalAllowed(input, "state", DOCUMENT_STATES),
    fileName: optionalText(input, "fileName"),
    mimeType: optionalText(input, "mimeType"),
    sizeBytes: optionalInteger(input, "sizeBytes"),
    uploadedAt: optionalTimestamp(input, "uploadedAt"),
    verifiedAt: optionalTimestamp(input, "verifiedAt"),
    availability: optionalAllowed(input, "availability", DOCUMENT_AVAILABILITIES),
    downloadAvailable: requiredBoolean(input, "downloadAvailable"),
    recordRevision: optionalRevision(input),
  };
}

function decodeActivity(value: unknown): AdminActivityView {
  const input = exactRecord(value, "activity", ["id", "propertyId", "unitId", "personId", "tenancyId", "applicationId", "type", "occurredAt", "actor", "summary", "detail", "occurredAtKnowledge", "actorKnowledge", "summaryKnowledge", "typeKnowledge", "propertyLinkKnowledge", "unitLinkKnowledge", "personLinkKnowledge", "tenancyLinkKnowledge", "applicationLinkKnowledge", "recordRevision"]);
  return {
    id: optionalId(input, "id"),
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    personId: optionalId(input, "personId"),
    tenancyId: optionalId(input, "tenancyId"),
    applicationId: optionalId(input, "applicationId"),
    type: optionalAllowed(input, "type", ACTIVITY_TYPES),
    occurredAt: optionalTimestamp(input, "occurredAt"),
    actor: optionalText(input, "actor"),
    summary: optionalText(input, "summary"),
    detail: optionalText(input, "detail"),
    occurredAtKnowledge: optionalAllowed(input, "occurredAtKnowledge", FACT_KNOWLEDGE),
    actorKnowledge: optionalAllowed(input, "actorKnowledge", FACT_KNOWLEDGE),
    summaryKnowledge: optionalAllowed(input, "summaryKnowledge", FACT_KNOWLEDGE),
    typeKnowledge: optionalAllowed(input, "typeKnowledge", FACT_KNOWLEDGE),
    propertyLinkKnowledge: optionalAllowed(input, "propertyLinkKnowledge", LINK_KNOWLEDGE),
    unitLinkKnowledge: optionalAllowed(input, "unitLinkKnowledge", LINK_KNOWLEDGE),
    personLinkKnowledge: optionalAllowed(input, "personLinkKnowledge", LINK_KNOWLEDGE),
    tenancyLinkKnowledge: optionalAllowed(input, "tenancyLinkKnowledge", LINK_KNOWLEDGE),
    applicationLinkKnowledge: optionalAllowed(input, "applicationLinkKnowledge", LINK_KNOWLEDGE),
    recordRevision: optionalRevision(input),
  };
}

function decodeLedgerRow(value: unknown): LedgerRow {
  const input = exactRecord(value, "ledger row", ["balanceComplete", "balanceUncertaintyCodes", "transaction", "allocatedCents", "openCents", "runningBalanceCents", "rowType", "openingBalanceCents"]);
  return { balanceComplete: optionalBoolean(input, "balanceComplete"), balanceUncertaintyCodes: optionalStrings(input, "balanceUncertaintyCodes"),
    rowType: optionalEnum(input, "rowType", ["transaction", "opening_balance"] as const),
    openingBalanceCents: nullableMoney(input, "openingBalanceCents"),
    transaction: decodeLedgerTransaction(input.transaction),
    allocatedCents: nullableMoney(input, "allocatedCents"),
    openCents: nullableMoney(input, "openCents"),
    runningBalanceCents: nullableMoney(input, "runningBalanceCents"),
  };
}

function decodeAdminTenant(value: unknown): TenantView {
  const input = exactRecord(value, "tenant profile", ["person", "household", "tenancy", "tenancies", "leaseTerms", "schedules", "ledger", "deposits", "subsidyContracts", "documents", "activity", "property", "unit", "primaryLease"]);
  return {
    person: decodePerson(input.person),
    household: requiredArrayOf(input, "household", decodeHouseholdMembership),
    tenancy: optionalObject(input, "tenancy", decodeTenancy),
    tenancies: requiredArrayOf(input, "tenancies", decodeTenancy),
    leaseTerms: requiredArrayOf(input, "leaseTerms", decodeLeaseTerm),
    schedules: requiredArrayOf(input, "schedules", decodeRecurringSchedule),
    ledger: requiredArrayOf(input, "ledger", decodeLedgerRow),
    deposits: requiredArrayOf(input, "deposits", decodeSecurityDeposit),
    subsidyContracts: requiredArrayOf(input, "subsidyContracts", decodeSubsidyContract),
    documents: requiredArrayOf(input, "documents", decodeDocument),
    activity: requiredArrayOf(input, "activity", decodeActivity),
    property: optionalObject(input, "property", decodeProperty),
    unit: optionalObject(input, "unit", decodeUnit),
    primaryLease: optionalObject(input, "primaryLease", decodeLeaseTerm),
  };
}

function decodeSnapshotView(value: unknown): AdminSnapshotView {
  const input = exactRecord(value, "snapshot", ["properties", "units", "people", "householdMemberships", "tenancies", "leaseTerms", "recurringSchedules", "ledgerTransactions", "paymentAllocations", "securityDeposits", "subsidyContracts", "applications", "applicationHouseholdMembers", "applicationRequirements", "documents", "activityEvents"]);
  return {
    properties: requiredArrayOf(input, "properties", decodeProperty),
    units: requiredArrayOf(input, "units", decodeUnit),
    people: requiredArrayOf(input, "people", decodePerson),
    householdMemberships: requiredArrayOf(input, "householdMemberships", decodeHouseholdMembership),
    tenancies: requiredArrayOf(input, "tenancies", decodeTenancy),
    leaseTerms: requiredArrayOf(input, "leaseTerms", decodeLeaseTerm),
    recurringSchedules: requiredArrayOf(input, "recurringSchedules", decodeRecurringSchedule),
    ledgerTransactions: requiredArrayOf(input, "ledgerTransactions", decodeLedgerTransaction),
    paymentAllocations: requiredArrayOf(input, "paymentAllocations", decodePaymentAllocation),
    securityDeposits: requiredArrayOf(input, "securityDeposits", decodeSecurityDeposit),
    subsidyContracts: requiredArrayOf(input, "subsidyContracts", decodeSubsidyContract),
    applications: requiredArrayOf(input, "applications", decodeApplication),
    applicationHouseholdMembers: requiredArrayOf(input, "applicationHouseholdMembers", decodeApplicationHouseholdMember),
    applicationRequirements: requiredArrayOf(input, "applicationRequirements", decodeApplicationRequirement),
    documents: requiredArrayOf(input, "documents", decodeDocument),
    activityEvents: requiredArrayOf(input, "activityEvents", decodeActivity),
  };
}

function decodeApiFilters(value: unknown): ApiFilters {
  const input = exactRecord(value, "report filters", ["propertyScope", "propertyId", "unitId", "tenancyId", "personId", "asOfDate", "month", "fromDate", "toDate", "occupancy", "readiness", "listing", "balanceStatus", "status", "search"]);
  return {
    propertyScope: optionalEnum(input, "propertyScope", ["active", "all"] as const),
    propertyId: optionalId(input, "propertyId"),
    unitId: optionalId(input, "unitId"),
    tenancyId: optionalId(input, "tenancyId"),
    personId: optionalId(input, "personId"),
    asOfDate: optionalDate(input, "asOfDate"),
    month: optionalMonth(input, "month"),
    fromDate: optionalDate(input, "fromDate"),
    toDate: optionalDate(input, "toDate"),
    occupancy: optionalStrings(input, "occupancy"),
    readiness: optionalStrings(input, "readiness"),
    listing: optionalStrings(input, "listing"),
    balanceStatus: optionalEnum(input, "balanceStatus", ["all", "due", "credit", "zero"] as const),
    status: optionalStrings(input, "status"),
    search: optionalText(input, "search"),
  };
}

const DASHBOARD_DRILLDOWN_KEYS = ["occupiedUnits", "futurePreleasedUnits", "genuineVacantUnits", "rentOnlyDelinquencyCents", "securityDepositLiabilityCents"] as const;

function decodeDashboardSummary(value: unknown): DashboardSummary {
  const input = exactRecord(value, "dashboard summary", ["balanceUnresolvedCount", "balanceComplete", "balanceUncertaintyCodes", "asOfDate", "propertyCount", "unitCount", "occupiedUnits", "futurePreleasedUnits", "genuineVacantUnits", "readyVacantUnits", "notReadyUnits", "offMarketUnits", "physicalOccupancyPercent", "scheduledRentConfirmedCents", "scheduledRentUnresolvedCount", "scheduledRentComplete", "scheduledRentCadenceComplete", "scheduledRentCents", "collectedRentCents", "rentOnlyDelinquencyCents", "totalDelinquencyCents", "unappliedCashCents", "expiringIn30Days", "expiringIn60Days", "expiringIn90Days", "monthToMonthCount", "applicationsSubmitted", "applicationsMissingInformation", "securityDepositLiabilityCents", "drilldowns"]);
  const drilldownInput = exactRecord(input.drilldowns, "dashboard drilldowns", DASHBOARD_DRILLDOWN_KEYS);
  const drilldowns: DashboardSummary["drilldowns"] = {};
  for (const key of DASHBOARD_DRILLDOWN_KEYS) {
    const candidate = drilldownInput[key];
    if (candidate === undefined) continue;
    const item = exactRecord(candidate, "dashboard drilldown", ["report", "filters"]);
    const reportName = requiredText(item, "report");
    const report = REPORT_KEYS.find((candidate) => REPORT_ALIASES[candidate].includes(reportName));
    if (!report) invalidResponse();
    drilldowns[key] = { report, filters: decodeApiFilters(item.filters) };
  }
  return { balanceUnresolvedCount: optionalInteger(input, "balanceUnresolvedCount"), balanceComplete: optionalBoolean(input, "balanceComplete"), balanceUncertaintyCodes: optionalStrings(input, "balanceUncertaintyCodes"),
    asOfDate: requiredDate(input, "asOfDate"),
    propertyCount: requiredInteger(input, "propertyCount"),
    unitCount: requiredInteger(input, "unitCount"),
    occupiedUnits: requiredInteger(input, "occupiedUnits"),
    futurePreleasedUnits: requiredInteger(input, "futurePreleasedUnits"),
    genuineVacantUnits: requiredInteger(input, "genuineVacantUnits"),
    readyVacantUnits: requiredInteger(input, "readyVacantUnits"),
    notReadyUnits: requiredInteger(input, "notReadyUnits"),
    offMarketUnits: requiredInteger(input, "offMarketUnits"),
    physicalOccupancyPercent: requiredFinite(input, "physicalOccupancyPercent"),
    scheduledRentConfirmedCents: optionalMoney(input, "scheduledRentConfirmedCents") ?? undefined,
    scheduledRentUnresolvedCount: optionalInteger(input, "scheduledRentUnresolvedCount") ?? undefined,
    scheduledRentCadenceComplete: optionalBoolean(input, "scheduledRentCadenceComplete") ?? undefined,
    scheduledRentComplete: optionalBoolean(input, "scheduledRentComplete") ?? undefined,
    scheduledRentCents: requiredMoney(input, "scheduledRentCents"),
    collectedRentCents: requiredMoney(input, "collectedRentCents"),
    rentOnlyDelinquencyCents: input.rentOnlyDelinquencyCents === null ? null : requiredMoney(input, "rentOnlyDelinquencyCents"),
    totalDelinquencyCents: input.totalDelinquencyCents === null ? null : requiredMoney(input, "totalDelinquencyCents"),
    unappliedCashCents: input.unappliedCashCents === null ? null : requiredMoney(input, "unappliedCashCents"),
    expiringIn30Days: requiredInteger(input, "expiringIn30Days"),
    expiringIn60Days: requiredInteger(input, "expiringIn60Days"),
    expiringIn90Days: requiredInteger(input, "expiringIn90Days"),
    monthToMonthCount: requiredInteger(input, "monthToMonthCount"),
    applicationsSubmitted: requiredInteger(input, "applicationsSubmitted"),
    applicationsMissingInformation: requiredInteger(input, "applicationsMissingInformation"),
    securityDepositLiabilityCents: input.securityDepositLiabilityCents === null ? null : requiredMoney(input, "securityDepositLiabilityCents"),
    drilldowns,
  };
}

function decodeRentRollRow(value: unknown): RentRollRow {
  const input = exactRecord(value, "rent-roll row", ["balanceComplete", "balanceUncertaintyCodes", "propertyId", "propertyName", "unitId", "unitNumber", "bedrooms", "bathrooms", "marketRentCents", "readiness", "listing", "occupancy", "currentPersonId", "currentTenantName", "futurePersonId", "futureTenantName", "tenancyId", "actualMoveInOn", "noticeOn", "expectedMoveOutOn", "actualMoveOutOn", "contractStartOn", "contractEndOn", "monthToMonth", "baseRentCents", "recurringFeesCents", "subsidyCents", "tenantPortionCents", "totalScheduledCents", "balanceDueCents", "oldestUnpaidRentOn", "exceptionCodes"]);
  return { balanceComplete: optionalBoolean(input, "balanceComplete"), balanceUncertaintyCodes: optionalStrings(input, "balanceUncertaintyCodes"),
    propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitNumber: optionalText(input, "unitNumber"),
    bedrooms: optionalFinite(input, "bedrooms"), bathrooms: optionalFinite(input, "bathrooms"), marketRentCents: optionalMoney(input, "marketRentCents"),
    readiness: optionalAllowed(input, "readiness", READINESS_STATES), listing: optionalAllowed(input, "listing", LISTING_STATES), occupancy: optionalText(input, "occupancy"),
    currentPersonId: optionalId(input, "currentPersonId"), currentTenantName: optionalText(input, "currentTenantName"), futurePersonId: optionalId(input, "futurePersonId"), futureTenantName: optionalText(input, "futureTenantName"), tenancyId: optionalId(input, "tenancyId"),
    actualMoveInOn: optionalDate(input, "actualMoveInOn"), noticeOn: optionalDate(input, "noticeOn"), expectedMoveOutOn: optionalDate(input, "expectedMoveOutOn"), actualMoveOutOn: optionalDate(input, "actualMoveOutOn"), contractStartOn: optionalDate(input, "contractStartOn"), contractEndOn: optionalDate(input, "contractEndOn"), monthToMonth: optionalBoolean(input, "monthToMonth"),
    baseRentCents: optionalMoney(input, "baseRentCents"), recurringFeesCents: optionalMoney(input, "recurringFeesCents"), subsidyCents: optionalMoney(input, "subsidyCents"), tenantPortionCents: optionalMoney(input, "tenantPortionCents"), totalScheduledCents: optionalMoney(input, "totalScheduledCents"), balanceDueCents: nullableMoney(input, "balanceDueCents"), oldestUnpaidRentOn: optionalDate(input, "oldestUnpaidRentOn"), exceptionCodes: optionalStrings(input, "exceptionCodes"),
  };
}

function decodeOccupancyRow(value: unknown): OccupancyRow {
  const input = exactRecord(value, "occupancy row", ["propertyId", "propertyName", "unitId", "unitNumber", "occupancy", "readiness", "listing", "daysVacant", "tenancyId"]);
  return { propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitNumber: optionalText(input, "unitNumber"), occupancy: optionalText(input, "occupancy"), readiness: optionalAllowed(input, "readiness", READINESS_STATES), listing: optionalAllowed(input, "listing", LISTING_STATES), daysVacant: optionalInteger(input, "daysVacant"), tenancyId: optionalId(input, "tenancyId") };
}

function decodeScheduledIncomeRow(value: unknown): ScheduledIncomeRow {
  const input = exactRecord(value, "scheduled-income row", ["propertyId", "propertyName", "unitId", "unitNumber", "tenancyId", "personId", "tenantName", "month", "category", "description", "amountCents", "scheduleId", "scopeType", "effectiveFromKnowledge", "temporalUncertainty", "amountKnowledge", "categoryKnowledge", "chargeDefinitionLinkKnowledge", "known", "uncertain", "unclassified", "exceptionCodes"]);
  return {
    propertyId: nullableId(input, "propertyId"),
    propertyName: nullableText(input, "propertyName"),
    unitId: nullableId(input, "unitId"),
    unitNumber: nullableText(input, "unitNumber"),
    tenancyId: nullableId(input, "tenancyId"),
    personId: nullableId(input, "personId"),
    tenantName: nullableText(input, "tenantName"),
    month: nullableMonth(input, "month"),
    category: nullableAllowed(input, "category", CHARGE_CATEGORIES),
    description: nullableText(input, "description"),
    amountCents: nullableMoney(input, "amountCents"),
    scheduleId: optionalId(input, "scheduleId"),
    scopeType: nullableAllowed(input, "scopeType", RECURRING_SCOPES),
    effectiveFromKnowledge: nullableAllowed(input, "effectiveFromKnowledge", RECURRING_DATE_KNOWLEDGE),
    temporalUncertainty: nullableBoolean(input, "temporalUncertainty"),
    amountKnowledge: nullableAllowed(input, "amountKnowledge", AMOUNT_KNOWLEDGE),
    categoryKnowledge: nullableAllowed(input, "categoryKnowledge", FACT_KNOWLEDGE),
    chargeDefinitionLinkKnowledge: nullableAllowed(input, "chargeDefinitionLinkKnowledge", LINK_KNOWLEDGE),
    known: nullableBoolean(input, "known"),
    uncertain: nullableBoolean(input, "uncertain"),
    unclassified: nullableBoolean(input, "unclassified"),
    exceptionCodes: optionalStrings(input, "exceptionCodes"),
  };
}

function decodeCollectedIncomeRow(value: unknown): CollectedIncomeRow {
  const input = exactRecord(value, "collected-income row", ["propertyId", "propertyName", "unitId", "unitNumber", "tenancyId", "personId", "tenantName", "paymentTransactionId", "chargeTransactionId", "paymentOn", "category", "amountCents", "description"]);
  return { propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitNumber: optionalText(input, "unitNumber"), tenancyId: optionalId(input, "tenancyId"), personId: optionalId(input, "personId"), tenantName: optionalText(input, "tenantName"), paymentTransactionId: optionalId(input, "paymentTransactionId"), chargeTransactionId: optionalId(input, "chargeTransactionId"), paymentOn: optionalDate(input, "paymentOn"), category: optionalAllowed(input, "category", CHARGE_CATEGORIES), amountCents: optionalMoney(input, "amountCents"), description: optionalText(input, "description") };
}

function decodeScheduledVsCollectedRow(value: unknown): ScheduledVsCollectedRow {
  const input = exactRecord(value, "scheduled-vs-collected row", ["propertyId", "propertyName", "month", "scheduledCents", "collectedCents", "varianceCents", "scheduledKnownCents", "scheduledUncertainCents", "scheduledUnknownAmountCount", "collectedKnownCents", "collectedUncertainCents", "collectedUnknownAmountCount", "complete", "uncertaintyCodes"]);
  return {
    propertyId: nullableId(input, "propertyId"),
    propertyName: nullableText(input, "propertyName"),
    month: nullableMonth(input, "month"),
    scheduledCents: nullableMoney(input, "scheduledCents"),
    collectedCents: nullableMoney(input, "collectedCents"),
    varianceCents: nullableMoney(input, "varianceCents"),
    scheduledKnownCents: nullableMoney(input, "scheduledKnownCents"),
    scheduledUncertainCents: nullableMoney(input, "scheduledUncertainCents"),
    scheduledUnknownAmountCount: nullableInteger(input, "scheduledUnknownAmountCount"),
    collectedKnownCents: nullableMoney(input, "collectedKnownCents"),
    collectedUncertainCents: nullableMoney(input, "collectedUncertainCents"),
    collectedUnknownAmountCount: nullableInteger(input, "collectedUnknownAmountCount"),
    complete: nullableBoolean(input, "complete"),
    uncertaintyCodes: optionalStrings(input, "uncertaintyCodes"),
  };
}

function decodeDelinquencyRow(value: unknown): DelinquencyRow {
  const input = exactRecord(value, "delinquency row", ["balanceComplete", "balanceUncertaintyCodes", "propertyId", "propertyName", "unitId", "unitNumber", "tenancyId", "personId", "tenantName", "rentOnlyBalanceCents", "nonRentBalanceCents", "grossBalanceCents", "totalBalanceCents", "netAccountBalanceCents", "unappliedCashCents", "prepaidCents", "oldestUnpaidRentOn", "lastPaymentOn", "hasPromiseOrHold", "noticeStatus"]);
  return { balanceComplete: optionalBoolean(input, "balanceComplete"), balanceUncertaintyCodes: optionalStrings(input, "balanceUncertaintyCodes"), propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitNumber: optionalText(input, "unitNumber"), tenancyId: optionalId(input, "tenancyId"), personId: optionalId(input, "personId"), tenantName: optionalText(input, "tenantName"), rentOnlyBalanceCents: nullableMoney(input, "rentOnlyBalanceCents"), nonRentBalanceCents: nullableMoney(input, "nonRentBalanceCents"), grossBalanceCents: nullableMoney(input, "grossBalanceCents"), totalBalanceCents: nullableMoney(input, "totalBalanceCents"), netAccountBalanceCents: nullableMoney(input, "netAccountBalanceCents"), unappliedCashCents: nullableMoney(input, "unappliedCashCents"), prepaidCents: nullableMoney(input, "prepaidCents"), oldestUnpaidRentOn: optionalDate(input, "oldestUnpaidRentOn"), lastPaymentOn: optionalDate(input, "lastPaymentOn"), hasPromiseOrHold: optionalBoolean(input, "hasPromiseOrHold"), noticeStatus: optionalText(input, "noticeStatus") };
}

function decodeLeaseExpirationRow(value: unknown): LeaseExpirationRow {
  const input = exactRecord(value, "lease-expiration row", ["propertyId", "propertyName", "unitId", "unitNumber", "tenancyId", "personId", "tenantName", "contractEndOn", "monthToMonth", "currentBaseRentCents", "noticeDeadlineOn", "actionStatus"]);
  return { propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitNumber: optionalText(input, "unitNumber"), tenancyId: optionalId(input, "tenancyId"), personId: optionalId(input, "personId"), tenantName: optionalText(input, "tenantName"), contractEndOn: optionalDate(input, "contractEndOn"), monthToMonth: optionalBoolean(input, "monthToMonth"), currentBaseRentCents: optionalMoney(input, "currentBaseRentCents"), noticeDeadlineOn: optionalDate(input, "noticeDeadlineOn"), actionStatus: optionalText(input, "actionStatus") };
}

function decodeDepositLiabilityRow(value: unknown): DepositLiabilityRow {
  const input = exactRecord(value, "security-deposit row", ["propertyId", "propertyName", "unitId", "unitNumber", "tenancyId", "personId", "tenantName", "securityHeldCents", "refundablePetHeldCents", "otherRefundableHeldCents", "totalHeldCents", "sourceBalanceCents", "unknownHeldCount", "dispositionStatus", "unknownReceiptCount", "hasUnknownReceiptDate", "temporalUncertainty"]);
  return { propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitNumber: optionalText(input, "unitNumber"), tenancyId: optionalId(input, "tenancyId"), personId: optionalId(input, "personId"), tenantName: optionalText(input, "tenantName"), securityHeldCents: nullableMoney(input, "securityHeldCents"), refundablePetHeldCents: nullableMoney(input, "refundablePetHeldCents"), otherRefundableHeldCents: nullableMoney(input, "otherRefundableHeldCents"), totalHeldCents: nullableMoney(input, "totalHeldCents"), sourceBalanceCents: nullableMoney(input, "sourceBalanceCents"), unknownHeldCount: optionalInteger(input, "unknownHeldCount"), dispositionStatus: optionalAllowed(input, "dispositionStatus", DEPOSIT_STATUSES), unknownReceiptCount: optionalInteger(input, "unknownReceiptCount"), hasUnknownReceiptDate: optionalBoolean(input, "hasUnknownReceiptDate"), temporalUncertainty: optionalBoolean(input, "temporalUncertainty") };
}

function decodeApplicantPipelineRow(value: unknown): ApplicantPipelineRow {
  const input = exactRecord(value, "applicant-pipeline row", ["id", "displayName", "propertyId", "propertyName", "unitId", "unitInterest", "submittedOn", "status", "missingItems", "daysInStage"]);
  return { id: optionalId(input, "id"), displayName: optionalText(input, "displayName"), propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitInterest: optionalText(input, "unitInterest"), submittedOn: optionalDate(input, "submittedOn"), status: optionalAllowed(input, "status", APPLICATION_STATUSES), missingItems: optionalStrings(input, "missingItems"), daysInStage: optionalInteger(input, "daysInStage") };
}

function decodeHapRow(value: unknown): HapRow {
  const input = exactRecord(value, "hap row", ["propertyId", "propertyName", "unitId", "unitNumber", "tenancyId", "tenantName", "agencyName", "month", "agencyObligationCents", "tenantObligationCents", "expectedTotalCents", "receivedAgencyCents", "varianceCents", "exception"]);
  return { propertyId: optionalId(input, "propertyId"), propertyName: optionalText(input, "propertyName"), unitId: optionalId(input, "unitId"), unitNumber: optionalText(input, "unitNumber"), tenancyId: optionalId(input, "tenancyId"), tenantName: optionalText(input, "tenantName"), agencyName: optionalText(input, "agencyName"), month: optionalMonth(input, "month"), agencyObligationCents: optionalMoney(input, "agencyObligationCents"), tenantObligationCents: optionalMoney(input, "tenantObligationCents"), expectedTotalCents: optionalMoney(input, "expectedTotalCents"), receivedAgencyCents: optionalMoney(input, "receivedAgencyCents"), varianceCents: optionalMoney(input, "varianceCents"), exception: optionalBoolean(input, "exception") };
}

function decodeReportRows(key: ReportKey, value: unknown): ReportRow[] {
  if (!Array.isArray(value)) invalidResponse();
  switch (key) {
    case "rent-roll": return value.map(decodeRentRollRow);
    case "occupancy": return value.map(decodeOccupancyRow);
    case "scheduled-income": return value.map(decodeScheduledIncomeRow);
    case "collected-income": return value.map(decodeCollectedIncomeRow);
    case "scheduled-vs-collected": return value.map(decodeScheduledVsCollectedRow);
    case "delinquency": return value.map(decodeDelinquencyRow);
    case "tenant-ledger": return value.map(decodeLedgerRow);
    case "lease-expiration": return value.map(decodeLeaseExpirationRow);
    case "security-deposit": return value.map(decodeDepositLiabilityRow);
    case "applicant-pipeline": return value.map(decodeApplicantPipelineRow);
    case "hap": return value.map(decodeHapRow);
  }
}

/**
 * The local workspace has a compact view-filter shape, while API report
 * filters also support unit, tenancy, person, month, occupancy, readiness,
 * listing, balance, and multi-value status filters. Keep serialization in one
 * place so every report endpoint receives the same supported contract.
 */
export type RentOpsQueryFilters = Omit<ApiFilters, "status"> & { status?: string | string[] };

function addQueryParam(params: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item).trim()).filter((item) => item && item !== "all");
    if (list.length) params.set(key, list.join(","));
    return;
  }
  if (value == null) return;
  const normalized = String(value).trim();
  if (!normalized || normalized === "all") return;
  params.set(key, normalized);
}

export function buildRentOpsQuery(filters: RentOpsQueryFilters = {}): string {
  const params = new URLSearchParams();
  addQueryParam(params, "propertyScope", filters.propertyScope);
  addQueryParam(params, "propertyId", filters.propertyId);
  addQueryParam(params, "unitId", filters.unitId);
  addQueryParam(params, "tenancyId", filters.tenancyId);
  addQueryParam(params, "personId", filters.personId);
  addQueryParam(params, "asOfDate", filters.asOfDate);
  addQueryParam(params, "month", filters.month);
  addQueryParam(params, "fromDate", filters.fromDate);
  addQueryParam(params, "toDate", filters.toDate);
  addQueryParam(params, "occupancy", filters.occupancy);
  addQueryParam(params, "readiness", filters.readiness);
  addQueryParam(params, "listing", filters.listing);
  addQueryParam(params, "balanceStatus", filters.balanceStatus);
  addQueryParam(params, "status", filters.status);
  addQueryParam(params, "search", filters.search);
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await rentOpsAuthClient.request(path, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => undefined);
    const code = safeErrorCode(errorPayload);
    const reportRequest = /\/api\/rent-ops\/(?:preview-context|dashboard|snapshot|reports(?:\/|$))/.test(path);
    const message = code === "not_authorized" ? "Rent Operations authorization is required."
      : code === "not_found" ? "The requested Rent Operations record was not found."
        : code === "conflict" || code === "versioned_schedule_required" ? undefined
          : code === "verified_upload_required" ? "Secure document upload is not available yet."
            : code === "temporarily_unavailable" ? "Rent Operations is temporarily unavailable."
              : code === "invalid_input" ? reportRequest ? "The selected report date or filters cannot be used. Choose a valid date and try again." : "Rent Operations request contains invalid input."
              : `Rent Operations API returned ${response.status}.`;
    if (code === "conflict" || code === "versioned_schedule_required" || code === "activity_append_only" || code === "hap_create_requires_provenance") throw new RentOpsApiError(code, response.status);
    throw new Error(message);
  }
  return response.json().catch(() => ({}));
}

/** Download only through the authenticated same-origin document-ID route. */
export async function downloadRentOpsDocument(documentId: string): Promise<Blob> {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(documentId)) throw new Error("The document record is unavailable.");
  if (DEMO_ALLOWED) throw new Error("Secure document download is not available in synthetic data.");
  const response = await rentOpsAuthClient.request(`/api/rent-ops/documents/${encodeURIComponent(documentId)}/download`, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => undefined);
    const code = safeErrorCode(errorPayload);
    throw new Error(code === "not_authorized" ? "Rent Operations authorization is required."
      : code === "not_found" ? "The document record was not found."
        : "Secure document download is unavailable.");
  }
  return response.blob();
}

function toLabel(key: string): string {
  const depositLabels: Record<string, string> = { balanceComplete: "Balance status", balanceUncertaintyCodes: "Balance review", sourceBalanceCents: "Source balance", securityHeldCents: "Security held", refundablePetHeldCents: "Pet deposit held", otherRefundableHeldCents: "Other deposit held", totalHeldCents: "Total held", unknownHeldCount: "Unknown held amounts" };
  if (depositLabels[key]) return depositLabels[key];
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function decodeReportColumn(value: unknown): ReportColumn {
  if (typeof value === "string") {
    if (value.length === 0) invalidResponse();
    return { key: value, label: toLabel(value) };
  }
  const input = exactRecord(value, "report column", ["key", "label", "format", "align"]);
  const key = requiredText(input, "key");
  const format = optionalEnum(input, "format", ["currency", "date", "percent", "integer", "status"] as const);
  const align = optionalEnum(input, "align", ["left", "right"] as const);
  return { key, label: optionalText(input, "label") ?? toLabel(key), format, align };
}

function normalizeColumns(value: unknown, rows: ReportRow[]): ReportColumn[] {
  if (value !== undefined) return requiredArrayOf({ columns: value }, "columns", decodeReportColumn);
  const keys = rows.length && isRecord(rows[0]) ? Object.keys(rows[0]).filter((key) => key !== "id") : [];
  const reviewKeys = new Set(["balanceComplete", "balanceUncertaintyCodes"]);
  return [...keys.filter(key => !reviewKeys.has(key)), ...keys.filter(key => reviewKeys.has(key))].map((key) => ({ key, label: toLabel(key) }));
}

function normalizeReport(key: ReportKey, value: unknown): ReportDefinition {
  let rowsValue = value;
  let label: string | undefined;
  let description: string | undefined;
  let sourceNote: string | undefined;
  let columns: unknown;
  if (isRecord(value)) {
    const record = exactRecord(value, "report", ["rows", "label", "description", "sourceNote", "columns"]);
    rowsValue = record.rows;
    label = optionalText(record, "label");
    description = optionalText(record, "description");
    sourceNote = optionalText(record, "sourceNote");
    columns = record.columns;
  }
  const rows = decodeReportRows(key, rowsValue);
  return {
    key,
    label: label ?? REPORT_LABELS[key],
    description: description ?? "Server-derived Rent Operations report.",
    sourceNote: sourceNote ?? "Rows are derived by the Rent Operations domain service.",
    columns: normalizeColumns(columns, rows),
    rows,
  };
}

const REPORT_ALIASES: Record<ReportKey, readonly string[]> = {
  "rent-roll": ["rent-roll", "rentRoll"],
  occupancy: ["occupancy"],
  "scheduled-income": ["scheduled-income", "scheduledIncome"],
  "collected-income": ["collected-income", "collectedIncome"],
  "scheduled-vs-collected": ["scheduled-vs-collected", "scheduledVsCollected"],
  delinquency: ["delinquency"],
  "tenant-ledger": ["tenant-ledger", "tenantLedger", "ledger"],
  "lease-expiration": ["lease-expiration", "lease-expirations", "leaseExpiration"],
  "security-deposit": ["security-deposit", "deposits", "depositLiability"],
  "applicant-pipeline": ["applicant-pipeline", "applicantPipeline"],
  hap: ["hap"],
};
const REPORT_RESPONSE_KEYS = Object.values(REPORT_ALIASES).flat();

function reportValue(reports: JsonRecord, key: ReportKey): unknown {
  return REPORT_ALIASES[key].map((alias) => reports[alias]).find((candidate) => candidate !== undefined);
}

function decodeReports(value: unknown): Record<ReportKey, ReportDefinition> {
  const input = exactRecord(value, "reports", REPORT_RESPONSE_KEYS);
  const result = {} as Record<ReportKey, ReportDefinition>;
  for (const key of REPORT_KEYS) {
    const candidate = reportValue(input, key);
    if (candidate === undefined) invalidResponse();
    result[key] = normalizeReport(key, candidate);
  }
  return result;
}

function bundleToSnapshot(payload: unknown, _asOfDate: string): AdminSnapshot {
  assertNoForbiddenResponseFields(payload);
  const root = unwrapData(payload);
  const compact = "transportVersion" in root;
  const bundle = exactRecord(root, "snapshot root", compact
    ? ["transportVersion", "generatedAt", "summary", "snapshot", "reports", "tenants", "applicants"]
    : ["generatedAt", "summary", "snapshot", "rentRoll", "occupancy", "scheduledIncome", "collectedIncome", "scheduledVsCollected", "delinquency", "ledger", "leaseExpiration", "depositLiability", "hap", "tenants", "applicants", "documents", "activities", "reports"]);
  if (compact && bundle.transportVersion !== 1) invalidResponse();
  const reports = decodeReports(bundle.reports);
  const summary = decodeDashboardSummary(bundle.summary);
  const snapshot = decodeSnapshotView(bundle.snapshot);
  const rentRoll = (compact ? reports["rent-roll"].rows : decodeReportRows("rent-roll", bundle.rentRoll)) as RentRollRow[];
  const occupancy = (compact ? reports["occupancy"].rows : decodeReportRows("occupancy", bundle.occupancy)) as OccupancyRow[];
  const scheduledIncome = (compact ? reports["scheduled-income"].rows : decodeReportRows("scheduled-income", bundle.scheduledIncome)) as ScheduledIncomeRow[];
  const collectedIncome = (compact ? reports["collected-income"].rows : decodeReportRows("collected-income", bundle.collectedIncome)) as CollectedIncomeRow[];
  const scheduledVsCollected = (compact ? reports["scheduled-vs-collected"].rows : decodeReportRows("scheduled-vs-collected", bundle.scheduledVsCollected)) as ScheduledVsCollectedRow[];
  const delinquency = (compact ? reports["delinquency"].rows : decodeReportRows("delinquency", bundle.delinquency)) as DelinquencyRow[];
  const ledger = (compact ? reports["tenant-ledger"].rows : decodeReportRows("tenant-ledger", bundle.ledger)) as LedgerRow[];
  const leaseExpiration = (compact ? reports["lease-expiration"].rows : decodeReportRows("lease-expiration", bundle.leaseExpiration)) as LeaseExpirationRow[];
  const depositLiability = (compact ? reports["security-deposit"].rows : decodeReportRows("security-deposit", bundle.depositLiability)) as DepositLiabilityRow[];
  const hap = (compact ? reports["hap"].rows : decodeReportRows("hap", bundle.hap)) as HapRow[];
  return {
    generatedAt: requiredTimestamp(bundle, "generatedAt"), summary, snapshot,
    rentRoll, occupancy, scheduledIncome, collectedIncome, scheduledVsCollected, delinquency, ledger, leaseExpiration, depositLiability, hap,
    tenants: requiredArrayOf(bundle, "tenants", decodeAdminTenant),
    applicants: requiredArrayOf(bundle, "applicants", decodeApplication),
    documents: compact ? snapshot.documents : requiredArrayOf(bundle, "documents", decodeDocument),
    activities: compact ? snapshot.activityEvents : requiredArrayOf(bundle, "activities", decodeActivity),
    reports,
    // Charge definitions arrive through the dedicated positive catalog route;
    // the broad snapshot never receives persistence-definition identifiers.
    chargeDefinitions: [],
  };
}

export async function loadRentOpsAdminSnapshot(filters: RentOpsQueryFilters = {}): Promise<RentOpsLoadResult> {
  const asOfDate = filters.asOfDate ?? (DEMO_ALLOWED ? DEMO_AS_OF_DATE : currentLocalIsoDate());
  if (DEMO_ALLOWED) return { snapshot: createDemoAdminSnapshot(), source: "synthetic", warning: "Synthetic records are enabled for local development only." };
  // Production deliberately fails closed. A missing API, malformed response,
  // or unavailable admin session is surfaced instead of showing fixtures.
  const payload = await requestJson(`/api/rent-ops/snapshot${buildRentOpsQuery({ ...filters, asOfDate })}`);
  return { snapshot: bundleToSnapshot(payload, asOfDate), source: "live" };
}

/**
 * Resolve the server's current business date before the first report request.
 * Local QA injects a simulated clock; production resolves the same value from
 * the server's real business clock so the browser never invents a report date.
 */
export async function loadRentOpsPreviewContext(): Promise<{ asOfDate: string; source: RentOpsSource }> {
  if (DEMO_ALLOWED) return { asOfDate: DEMO_AS_OF_DATE, source: "synthetic" };
  const payload = await requestJson("/api/rent-ops/preview-context");
  assertNoForbiddenResponseFields(payload);
  const root = exactRecord(unwrapData(payload), "preview context", ["asOfDate", "dataMode"]);
  return { asOfDate: requiredDate(root, "asOfDate"), source: requiredAllowed(root, "dataMode", ["live", "synthetic"]) as RentOpsSource };
}

/**
 * Load only the safe operational charge-definition catalog. The response is
 * deliberately separate from recurring schedules/reports so a definition's
 * opaque target id can be selected for a new admin action without exposing
 * source keys, artifact hashes, or crosswalk metadata anywhere else.
 */
export async function loadRentOpsChargeDefinitions(): Promise<AdminChargeDefinitionView[]> {
  if (DEMO_ALLOWED) return createDemoAdminSnapshot().chargeDefinitions;
  const payload = await requestJson("/api/rent-ops/charge-definitions");
  assertNoForbiddenResponseFields(payload);
  if (!Array.isArray(payload)) invalidResponse();
  return payload.map(decodeChargeDefinition);
}

export async function loadRentOpsReport(report: ReportKey, filters: ApiFilters = {}): Promise<ReportRow[]> {
  if (DEMO_ALLOWED) return createDemoAdminSnapshot().reports[report].rows;
  const serverName = report === "lease-expiration" ? "lease-expirations" : report === "security-deposit" ? "security-deposit" : report;
  const payload = await requestJson(`/api/rent-ops/reports/${encodeURIComponent(serverName)}${buildRentOpsQuery(filters)}`);
  assertNoForbiddenResponseFields(payload);
  const root = exactRecord(unwrapData(payload), "report response", ["report", "filters", "rows"]);
  const responseName = requiredText(root, "report");
  if (!REPORT_RESPONSE_KEYS.includes(responseName)) invalidResponse();
  decodeApiFilters(root.filters);
  return decodeReportRows(report, root.rows);
}

export async function loadRentOpsTenantProfile(personId: string, filters: ApiFilters = {}): Promise<TenantView> {
  if (DEMO_ALLOWED) {
    const tenant = createDemoAdminSnapshot().tenants.find((candidate) => candidate.person.id === personId);
    if (!tenant) throw new Error("Tenant record was not found.");
    return tenant;
  }
  const payload = await requestJson(`/api/rent-ops/tenants/${encodeURIComponent(personId)}${buildRentOpsQuery(filters)}`);
  assertNoForbiddenResponseFields(payload);
  const root = unwrapData(payload);
  if (isRecord(root) && ("profile" in root || "tenant" in root)) {
    const envelope = exactRecord(root, "tenant response", ["profile", "tenant"]);
    const candidate = envelope.profile ?? envelope.tenant;
    return decodeAdminTenant(candidate);
  }
  return decodeAdminTenant(root);
}

/** Load one application only when an operator opens its case detail. */
export async function loadRentOpsApplication(applicationId: string): Promise<AdminApplicationDetailView> {
  if (!validTargetId(applicationId)) throw new Error("The application record is unavailable.");
  if (DEMO_ALLOWED) {
    const snapshot = createDemoAdminSnapshot();
    const application = snapshot.applicants.find((candidate) => candidate.id === applicationId);
    if (!application) throw new Error("The application record was not found.");
    return {
      ...application,
      householdMembers: snapshot.snapshot.applicationHouseholdMembers.filter((member) => member.applicationId === applicationId),
      requirements: snapshot.snapshot.applicationRequirements.filter((requirement) => requirement.applicationId === applicationId),
      documents: snapshot.documents.filter((document) => document.applicationId === applicationId),
    };
  }
  const payload = await requestJson(`/api/rent-ops/applications/${encodeURIComponent(applicationId)}`);
  assertNoForbiddenResponseFields(payload);
  const root = unwrapData(payload);
  // Imported-only targets can be opened from a history index even when no
  // native portal row exists. Keep the component contract stable by returning
  // empty native collections alongside the positive history section.
  if ("history" in root && !("householdMembers" in root)) {
    const history = decodeRentOpsApplicationHistoryDetail(root).history;
    if (history.application?.id !== applicationId) throw new Error(INVALID_RESPONSE_MESSAGE);
    const historicalApplication = history.application;
    return {
      id: applicationId,
      firstName: historicalApplication?.firstName,
      lastName: historicalApplication?.lastName,
      email: historicalApplication?.email,
      phone: historicalApplication?.phone,
      status: historicalApplication?.status,
      submittedOn: historicalApplication?.submittedOn,
      householdMembers: [],
      requirements: [],
      documents: [],
      history,
    };
  }
  const detail = decodeRentOpsApplicationDetail(root);
  if (detail.id !== applicationId) throw new Error(INVALID_RESPONSE_MESSAGE);
  return detail;
}

/** Load only the historical case when an imported-only target has no native row. */
export async function loadRentOpsApplicationHistory(applicationId: string): Promise<AdminApplicationHistoryCaseView> {
  if (!validTargetId(applicationId)) throw new Error("The application record is unavailable.");
  if (DEMO_ALLOWED) throw new Error("Historical application data is not available in synthetic data.");
  const payload = await requestJson(`/api/rent-ops/applications/${encodeURIComponent(applicationId)}/history`);
  assertNoForbiddenResponseFields(payload);
  const history = decodeRentOpsApplicationHistoryCase(unwrapData(payload));
  if (history.application?.id !== applicationId) throw new Error(INVALID_RESPONSE_MESSAGE);
  return history;
}

const PATCH_ACTION_PATHS: Partial<Record<RentOpsMutation["action"], string>> = {
  "save-property": "/api/rent-ops/properties",
  "save-unit": "/api/rent-ops/units",
  "save-person": "/api/rent-ops/people",
  "save-household-membership": "/api/rent-ops/household-memberships",
  "save-tenancy": "/api/rent-ops/tenancies",
  "save-lease-term": "/api/rent-ops/lease-terms",
  "save-recurring-schedule": "/api/rent-ops/recurring-schedules",
  "save-security-deposit": "/api/rent-ops/deposits",
  "save-subsidy-contract": "/api/rent-ops/subsidies",
  "save-activity": "/api/rent-ops/activity",
};

export function assertWritableRentOpsTransport(previewOnly: boolean): void {
  if (previewOnly) throw new Error("Read-only preview. No records were saved.");
}

export async function postRentOpsMutation(mutation: RentOpsMutation): Promise<RentOpsMutationResult> {
  assertWritableRentOpsTransport(DEMO_ALLOWED);
  const source = { ...mutation.payload };
  const id = typeof source.id === "string" ? source.id : undefined;
  const mutationRevision = typeof source.revision === "number" && Number.isSafeInteger(source.revision) && source.revision > 0 ? source.revision : undefined;
  if (mutation.action === "save-subsidy-contract" && (!id || mutationRevision === undefined)) {
    throw new RentOpsApiError("hap_create_requires_provenance", 409);
  }
  let path: string;
  let method: "POST" | "PATCH" = "POST";
  let body: JsonRecord = source;
  switch (mutation.action) {
    case "save-property": path = "/api/rent-ops/properties"; break;
    case "save-unit": path = "/api/rent-ops/units"; break;
    case "save-person": path = "/api/rent-ops/people"; break;
    case "save-household-membership": path = "/api/rent-ops/household-memberships"; break;
    case "save-tenancy": path = "/api/rent-ops/tenancies"; break;
    case "save-lease-term": path = "/api/rent-ops/lease-terms"; break;
    case "save-recurring-schedule": path = "/api/rent-ops/recurring-schedules"; break;
    case "replace-recurring-schedule":
    case "end-recurring-schedule": {
      const predecessorId = typeof source.predecessorId === "string" ? source.predecessorId.trim() : "";
      if (!predecessorId || !validTargetId(predecessorId)) throw new Error("A predecessor recurring schedule is required.");
      const bodySource = { ...source };
      delete bodySource.predecessorId;
      delete bodySource.revision;
      delete bodySource.chargeDefinitionId;
      delete bodySource.category;
      delete bodySource.description;
      path = `/api/rent-ops/recurring-schedules/${encodeURIComponent(predecessorId)}/successor`;
      body = bodySource;
      break;
    }
    case "post-ledger-transaction": path = "/api/rent-ops/ledger/transactions"; break;
    case "save-payment-allocation": path = "/api/rent-ops/ledger/allocations"; break;
    case "save-security-deposit": path = "/api/rent-ops/deposits"; break;
    case "save-subsidy-contract": path = "/api/rent-ops/subsidies"; break;
    case "save-activity": path = "/api/rent-ops/activity"; break;
    case "reverse-ledger-transaction": {
      const originalId = typeof source.originalId === "string" ? source.originalId : "";
      if (!originalId) throw new Error("A ledger transaction is required before posting a reversal.");
      path = `/api/rent-ops/ledger/${encodeURIComponent(originalId)}/reverse`;
      body = { ...source };
      delete body.originalId;
      break;
    }
    case "assign-application-unit": {
      const applicationId = typeof source.applicationId === "string" ? source.applicationId : undefined;
      if (!applicationId) throw new Error("An application is required before assigning a unit.");
      path = `/api/rent-ops/applications/${encodeURIComponent(applicationId)}`;
      method = "PATCH";
      body = { revision: source.revision, propertyId: source.propertyId, unitId: source.unitId };
      break;
    }
    case "update-application-status": {
      const applicationId = typeof source.applicationId === "string" ? source.applicationId : id;
      if (!applicationId) throw new Error("An application is required before changing status.");
      path = `/api/rent-ops/applications/${encodeURIComponent(applicationId)}/status`;
      method = "PATCH";
      body = { revision: source.revision, status: source.status, note: source.note };
      break;
    }
    case "save-application-requirement": {
      const applicationId = typeof source.applicationId === "string" ? source.applicationId : undefined;
      if (!applicationId) throw new Error("An application is required before adding a missing item.");
      path = `/api/rent-ops/applications/${encodeURIComponent(applicationId)}/requirements`;
      body = { key: source.key, label: source.label, status: source.status, documentId: source.documentId, requestedOn: source.requestedOn, resolvedOn: source.resolvedOn };
      break;
    }
    case "convert-application": {
      const applicationId = typeof source.applicationId === "string" ? source.applicationId : id;
      if (!applicationId) throw new Error("An application is required before conversion.");
      path = `/api/rent-ops/applications/${encodeURIComponent(applicationId)}/convert`;
      // Conversion is a positive facts request. Keep the browser's form
      // payload allowlisted so no stale source/provenance fields can ride
      // along with the selected charge definition.
      body = {
        propertyId: source.propertyId,
        unitId: source.unitId,
        plannedMoveInOn: source.plannedMoveInOn,
        leaseStatus: source.leaseStatus,
        contractStartOn: source.contractStartOn,
        ...(source.contractEndOn ? { contractEndOn: source.contractEndOn } : {}),
        monthToMonth: source.monthToMonth,
        baseRentCents: source.baseRentCents,
        chargeDefinitionId: source.chargeDefinitionId,
        category: source.category,
        scheduleDescription: source.scheduleDescription,
        billingFrequency: source.billingFrequency,
        primaryFinanciallyResponsible: source.primaryFinanciallyResponsible,
        members: source.members,
      };
      break;
    }
    default: throw new Error(`Unsupported Rent Operations action: ${mutation.action}`);
  }
  const patchBase = PATCH_ACTION_PATHS[mutation.action];
  const revision = source.revision;
  if (patchBase && id && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1) {
    path = `${patchBase}/${encodeURIComponent(id)}`;
    method = "PATCH";
    body = { ...source };
    delete body.id;
  }
  const payload = asRecord(await requestJson(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { ok: payload.ok !== false, id: typeof payload.id === "string" ? payload.id : undefined, message: typeof payload.message === "string" ? payload.message : undefined };
}

/** Display-only filtering. It never recomputes balances, rent, or occupancy. */
export function filterReportRows(report: ReportDefinition, filters: { propertyId: string; status: string; search: string }, snapshot: AdminSnapshot): ReportDefinition {
  const property = filters.propertyId === "all" ? undefined : snapshot.snapshot.properties.find((candidate) => candidate.id === filters.propertyId);
  const propertyName = property?.name;
  const normalizedSearch = filters.search.trim().toLowerCase();
  const normalizedStatus = filters.status.trim().toLowerCase().replaceAll("_", " ");
  const rows = report.rows.filter((row) => {
    const values = report.columns.flatMap((column) => {
      const value = reportCell(row, column.key);
      return value === undefined ? [] : [String(value)];
    });
    const rowPropertyId = "propertyId" in row ? row.propertyId : "transaction" in row ? row.transaction.propertyId : undefined;
    const rowPropertyName = "propertyName" in row ? row.propertyName : undefined;
    // API snapshots are already scoped. Prefer stable identity; a ledger row
    // need not render the property name among its columns to remain visible.
    const propertyMatches = filters.propertyId === "all" || (rowPropertyId ? rowPropertyId === filters.propertyId : rowPropertyName ? rowPropertyName === propertyName : true);
    const statusMatches = filters.status === "all" || values.some((value) => value.toLowerCase().replaceAll("_", " ") === normalizedStatus);
    const searchMatches = !normalizedSearch || values.some((value) => value.toLowerCase().includes(normalizedSearch));
    return propertyMatches && statusMatches && searchMatches;
  });
  return { ...report, rows };
}

export function sortReportRows(report: ReportDefinition, key: string, direction: "asc" | "desc" = "asc"): ReportDefinition {
  const factor = direction === "asc" ? 1 : -1;
  const rows = [...report.rows].sort((left, right) => String(reportCell(left, key) ?? "").localeCompare(String(reportCell(right, key) ?? ""), undefined, { numeric: true }) * factor);
  return { ...report, rows };
}

export function reportToCsv(report: ReportDefinition): string {
  return [report.columns.map((column) => escapeCsvCell(column.label)).join(","), ...report.rows.map((row) => report.columns.map((column) => escapeCsvCell(reportCell(row, column.key))).join(","))].join("\n");
}

export function escapeCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Spreadsheet applications can execute formulas embedded in CSV cells.
  // Prefix after optional leading whitespace while preserving display text.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function currentLocalIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export { DEMO_ALLOWED };
