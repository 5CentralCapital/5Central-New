import { createHash, createHmac } from "node:crypto";
import type {
  RentOpsActivityEvent,
  RentOpsDocument,
  ChargeCategory,
  ImportEntityType,
  ImportMappingException,
  RentManagerImportInput,
  RentManagerRawRecord,
  RentOpsApplication,
  RentOpsImportRun,
  RentOpsHouseholdMembership,
  RentOpsLedgerTransaction,
  RentOpsPaymentAllocation,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsSubsidyContract,
  RentOpsSubsidyTenant,
  RentOpsSubsidyPayment,
  HapContractStatus,
  HapPaymentStatus,
  RentManagerHapStatusCrosswalk,
  RentManagerFinancialSemanticCrosswalk,
  RentOpsSourceRecord,
  RentOpsTenancy,
  RentOpsUnit,
  RentOpsLeaseTerm,
  IsoDate,
  ReconciliationReport,
  RentalHistory,
  EmploymentInfo,
  HouseholdSummary,
  ApplicationPreferences,
  VoucherInfo,
  PetInfo,
  VehicleInfo,
  EmergencyContact,
  RentManagerTargetIdentityOptions,
} from "../../../shared/rent-ops-contracts";
import { financialSemanticCrosswalkValue, selectFinancialSemanticCrosswalk, validateFinancialSemanticCrosswalkForArtifact } from "../../../shared/rent-ops-contracts";
import { emptyRentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { nowIsoTimestamp } from "../domain/dates";
import { assertValidSnapshot } from "../domain/invariants";
import { normalizeHapStatusValue } from "../export/normalizer";

const SYSTEM = "rent_manager";

type RawRecord = RentManagerRawRecord & Record<string, unknown>;

export type RentOpsTargetIdFactory = (entityType: ImportEntityType, sourceId: string) => string;

export interface KeyedTargetIdFactory {
  factory: RentOpsTargetIdFactory;
  identity: Readonly<{
    algorithm: "hmac-sha256";
    keyId: string;
    keyVersion: string;
  }>;
}

/**
 * Creates the only production-safe target identity function.  The source
 * identifier is input to HMAC-SHA256 and never appears in the returned ID.
 * Key material is intentionally not retained on the public result object.
 * Rotate by changing keyVersion/keyId and running an explicit reviewed
 * re-key operation; never silently change a key for an existing import.
 */
export function createKeyedTargetIdFactory(
  key: string | Uint8Array,
  identity: RentManagerTargetIdentityOptions & { keyId: string; keyVersion: string },
): KeyedTargetIdFactory {
  const keyBytes = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (keyBytes.length < 16) throw new Error("target_id_key_too_short");
  if (!identity.keyId.trim() || !identity.keyVersion.trim()) throw new Error("target_id_key_identity_required");
  const factory: RentOpsTargetIdFactory = (entityType, sourceId) => {
    const digest = createHmac("sha256", keyBytes)
      .update(`${identity.keyVersion}\u0000${entityType}\u0000${sourceId}`)
      .digest("hex");
    return `rm:${entityType}:${digest}`;
  };
  return { factory, identity: { algorithm: "hmac-sha256", keyId: identity.keyId, keyVersion: identity.keyVersion } };
}

export const createStableHmacTargetIdFactory = createKeyedTargetIdFactory;

/**
 * Development/test compatibility only. Production callers must inject a
 * keyed pseudonymizer or persisted random mapping; an unkeyed digest is not
 * an acceptable production privacy boundary.
 */
const developmentTargetIdFactory: RentOpsTargetIdFactory = createKeyedTargetIdFactory(
  "rent-ops-test-only-target-id-key-v3",
  { keyId: "synthetic-test", keyVersion: "v3-test" },
).factory;

interface MappingContext {
  readonly targetIdFactory: RentOpsTargetIdFactory;
  readonly fidelityVersion: 2 | 3;
  readonly hapStatusCrosswalk: readonly RentManagerHapStatusCrosswalk[];
  readonly financialSemanticCrosswalk?: RentManagerFinancialSemanticCrosswalk;
  readonly financialSemanticCrosswalkValid: boolean;
  readonly artifactSha256?: string;
  readonly artifactObservationOn?: IsoDate;
  readonly applicationStatusCrosswalk: NonNullable<RentManagerImportInput["applicationHistoryStatusCrosswalk"]>;
}

function isV3(context: MappingContext): boolean {
  return context.fidelityVersion === 3;
}

function strictFinancialValue(
  context: MappingContext,
  input: { sourceCollection: string; sourceField: string; semanticKind: Parameters<typeof financialSemanticCrosswalkValue>[1]["semanticKind"]; rawValue: unknown },
): string | undefined {
  if (!isV3(context) || !context.financialSemanticCrosswalkValid || !context.financialSemanticCrosswalk || !context.artifactSha256) return undefined;
  return financialSemanticCrosswalkValue(context.financialSemanticCrosswalk, {
    artifactSha256: context.artifactSha256,
    ...input,
  });
}

function strictFactKnowledge(valueToCheck: unknown): "source" | "unknown" {
  return valueToCheck === undefined || valueToCheck === null ? "unknown" : "source";
}

function strictBooleanFromCrosswalk(valueToCheck: string | undefined): boolean | null {
  return valueToCheck === "true" ? true : valueToCheck === "false" ? false : null;
}

function strictApplicationStatus(context: MappingContext, record: RawRecord): RentOpsApplication["status"] | null {
  if (!isV3(context) || !context.artifactSha256) return null;
  const sourceCollection = stringValue(record, "sourceCollection", "SourceCollection") ?? "applications";
  const fields = ["Status", "ApplicationStatus", "status"] as const;
  const matches: RentOpsApplication["status"][] = [];
  for (const field of fields) {
    const raw = record[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    for (const entry of context.applicationStatusCrosswalk) {
      if (entry.artifactSha256 === context.artifactSha256
        && entry.sourceCollection === sourceCollection
        && entry.sourceField === field
        && entry.sourceValue === String(raw).trim()) {
        matches.push(entry.targetStatus);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function sourceId(record: RawRecord): string {
  const raw = record.sourceId ?? record.id;
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "number" && !Number.isFinite(raw)) return "";
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  return String(raw).trim();
}

function targetId(context: MappingContext, entityType: ImportEntityType, id: string): string {
  return context.targetIdFactory(entityType, id);
}

function value(record: RawRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function stringValue(record: RawRecord, ...keys: string[]): string | undefined {
  const found = value(record, ...keys);
  if (found === undefined) return undefined;
  const result = String(found).trim();
  return result || undefined;
}

function requiredString(record: RawRecord, fallback: string, ...keys: string[]): string {
  return stringValue(record, ...keys) ?? fallback;
}

function isValidCalendarDate(valueToCheck: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueToCheck)) return false;
  const [year, month, day] = valueToCheck.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidTimestamp(valueToCheck: string): boolean {
  const datePart = valueToCheck.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (!datePart || !isValidCalendarDate(datePart[1])) return false;
  const parsed = new Date(valueToCheck);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() !== "Invalid Date";
}

type FieldRead<T> = { present: boolean; value?: T; invalid: boolean };

function dateField(record: RawRecord, ...keys: string[]): FieldRead<string> {
  const found = value(record, ...keys);
  if (found === undefined) return { present: false, invalid: false };
  if (found instanceof Date) return Number.isFinite(found.getTime()) ? { present: true, value: found.toISOString().slice(0, 10), invalid: false } : { present: true, invalid: true };
  const text = String(found).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isValidCalendarDate(text) ? { present: true, value: text, invalid: false } : { present: true, invalid: true };
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && isValidTimestamp(text)) return { present: true, value: text.slice(0, 10), invalid: false };
  return { present: true, invalid: true };
}

function timestampField(record: RawRecord, ...keys: string[]): FieldRead<string> {
  const found = value(record, ...keys);
  if (found === undefined) return { present: false, invalid: false };
  if (found instanceof Date) return Number.isFinite(found.getTime()) ? { present: true, value: found.toISOString(), invalid: false } : { present: true, invalid: true };
  const text = String(found).trim();
  return isValidTimestamp(text) ? { present: true, value: new Date(text).toISOString(), invalid: false } : { present: true, invalid: true };
}

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function decimalToCents(text: string, centsInput: boolean): number | undefined {
  const normalized = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!normalized || !/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const [whole, fraction = ""] = normalized.split(".");
  if (centsInput) {
    if (fraction.length > 0 || whole.length > 10) return undefined;
    const cents = Number(whole);
    return Number.isSafeInteger(cents) && cents <= POSTGRES_INTEGER_MAX ? cents : undefined;
  }
  if (fraction.length > 2 || whole.length > 10) return undefined;
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(cents) && cents <= POSTGRES_INTEGER_MAX ? cents : undefined;
}

type MoneyRead = FieldRead<number>;

function moneyField(record: RawRecord, ...keys: string[]): MoneyRead {
  const selectedKey = keys.find((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");
  if (!selectedKey) return { present: false, invalid: false };
  const found = record[selectedKey];
  if (typeof found === "number" && (!Number.isFinite(found) || found < 0)) return { present: true, invalid: true };
  const parsed = decimalToCents(String(found), selectedKey.toLowerCase().includes("cents"));
  return parsed === undefined ? { present: true, invalid: true } : { present: true, value: parsed, invalid: false };
}

function centsValue(record: RawRecord, ...keys: string[]): number | undefined {
  return moneyField(record, ...keys).value;
}

export interface RentManagerMoneyControlCounts {
  knownTotals: Record<string, number>;
  unknownCounts: Record<string, number>;
  invalidCounts: Record<string, number>;
}

/**
 * Counts money states without coercing a missing/invalid source value to
 * zero.  The returned diagnostics contain only collection names and counts;
 * source rows never cross this boundary.
 */
export function moneyControlCounts(input: RentManagerImportInput): RentManagerMoneyControlCounts {
  const knownTotals: Record<string, number> = {};
  const unknownCounts: Record<string, number> = {};
  const invalidCounts: Record<string, number> = {};
  const add = (name: string, records: readonly RentManagerRawRecord[] | undefined, ...keys: string[]) => {
    let total = 0;
    let unknown = 0;
    let invalid = 0;
    for (const raw of records ?? []) {
      const read = moneyField(raw as RawRecord, ...keys);
      if (!read.present) unknown += 1;
      else if (read.invalid || read.value === undefined) invalid += 1;
      else total += read.value;
    }
    knownTotals[name] = total;
    unknownCounts[name] = unknown;
    invalidCounts[name] = invalid;
  };
  add("charges", input.charges, "amountCents", "amount");
  add("payments", input.payments, "amountCents", "amount");
  add("credits", input.credits, "amountCents", "amount");
  add("allocations", input.allocations, "amountCents", "amount");
  add("deposits", input.deposits, "amountHeldCents", "amount", "balance");
  add("hapAgencyObligationCents", input.subsidies, "agencyObligationCents", "agencyAmountCents", "agencyAmount");
  add("hapTenantObligationCents", input.subsidies, "tenantObligationCents", "tenantAmountCents", "tenantAmount");
  add("hapSubsidyTenantCents", input.subsidyTenants, "amountCents", "amount", "TenantAmountCents", "TenantAmount");
  add("hapSubsidyPaymentCents", input.subsidyPayments, "amountCents", "amount", "PaymentAmountCents", "PaymentAmount");
  return { knownTotals, unknownCounts, invalidCounts };
}

function boolValue(record: RawRecord, ...keys: string[]): boolean {
  const found = value(record, ...keys);
  return found === true || found === 1 || String(found).toLowerCase() === "true" || String(found).toLowerCase() === "yes";
}

function propertyStateFromEvidence(record: RawRecord): RentOpsProperty["state"] | null {
  const archived = value(record, "archived", "isArchived", "Archived", "IsArchived");
  if (archived !== undefined) return boolValue(record, "archived", "isArchived", "Archived", "IsArchived") ? "archived" : "active";
  const text = stringValue(record, "stateStatus", "status", "propertyStatus", "State", "StateStatus")?.toLowerCase();
  if (!text) return null;
  if (/archiv|inactive|closed|off.?market|terminated|decommission/.test(text)) return "archived";
  if (/^(active|open|operating|current|available|occupied)$/.test(text) || /\b(active|operating|available)\b/.test(text)) return "active";
  return null;
}

function unitReadinessFromEvidence(raw: string | undefined): RentOpsUnit["readiness"] | null {
  const text = raw?.toLowerCase();
  if (!text) return null;
  if (/off.?market|offline|unavailable/.test(text)) return "off_market";
  if (/not.?ready|make.?ready|turnover|rehab|maintenance|down/.test(text)) return "not_ready";
  if (/^ready$|rent.?ready|available/.test(text)) return "ready";
  return null;
}

function unitListingFromEvidence(raw: string | undefined): RentOpsUnit["listing"] | null {
  const text = raw?.toLowerCase();
  if (!text) return null;
  if (/off.?market|offline|unavailable/.test(text)) return "off_market";
  if (/not.?listed|unlisted|no.?listing/.test(text)) return "unlisted";
  if (/listed|advertis|marketed|on.?market/.test(text)) return "listed";
  return null;
}

function ledgerStatusFromEvidence(record: RawRecord): RentOpsLedgerTransaction["status"] | null {
  const voided = value(record, "voided", "isVoided", "Voided", "IsVoided");
  if (voided !== undefined && boolValue(record, "voided", "isVoided", "Voided", "IsVoided")) return "voided";
  const text = stringValue(record, "status", "transactionStatus", "Status", "TransactionStatus")?.toLowerCase();
  if (!text) return null;
  if (/void|cancelled|canceled/.test(text)) return "voided";
  if (/pending|unposted|open/.test(text)) return "pending";
  if (/posted|complete|completed|settled|paid|processed|approved/.test(text)) return "posted";
  return null;
}

function paymentMethodFromEvidence(raw: string | undefined): RentOpsLedgerTransaction["paymentMethod"] | undefined {
  const text = raw?.trim().toLowerCase();
  if (!text) return undefined;
  if (/^ach$|eft|electronic|bank/.test(text)) return "ach";
  if (/card|credit|debit/.test(text)) return "card";
  if (/^cash$/.test(text)) return "cash";
  if (/check|cheque/.test(text)) return "check";
  if (/money.?order/.test(text)) return "money_order";
  if (/zelle/.test(text)) return "zelle";
  if (/^other$/.test(text)) return "other";
  return undefined;
}

function sourceUpdatedAt(record: RawRecord): string | undefined {
  return timestampField(record, "updatedAt", "updated_at", "UpdateDate", "UpdatedDate", "ModifiedDate", "modifiedDate").value;
}

function sourceCreatedAt(record: RawRecord): string | undefined {
  // Create and update timestamps are independent source facts.  An update
  // timestamp (or this import's clock) must never masquerade as creation.
  return timestampField(record, "createdAt", "created_at", "CreateDate", "CreatedDate", "createDate").value;
}

function safeMetadata(record: RawRecord): Record<string, unknown> {
  return {
    sourceId: sourceId(record),
    entityType: String(record.entityType ?? "unknown"),
    sourceUpdatedAt: sourceUpdatedAt(record),
    fieldCount: Object.keys(record).length,
  };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
}

function hashRecord(record: RawRecord): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(record))).digest("hex");
}

function pushSource(
  context: MappingContext,
  sourceRecords: RentOpsSourceRecord[],
  entityType: ImportEntityType,
  record: RawRecord,
  mappedId: string,
  importedAt: string,
): void {
  sourceRecords.push({
    id: targetId(context, entityType, sourceId(record)),
    system: SYSTEM,
    entityType,
    sourceId: sourceId(record),
    sourceUpdatedAt: sourceUpdatedAt(record),
    importedAt,
    checksum: hashRecord(record),
    targetId: mappedId,
    rawMetadata: safeMetadata(record),
  });
}

function fieldException(
  exceptions: ImportMappingException[],
  code: string,
  field: string,
  entityType: ImportEntityType,
  record: RawRecord,
  severity: ImportMappingException["severity"] = "error",
): void {
  exception(exceptions, code, `${entityType} source ${sourceId(record)} has a missing or invalid ${field}`, entityType, record, undefined, severity);
}

function optionalDate(
  record: RawRecord,
  keys: string[],
  exceptions: ImportMappingException[],
  entityType: ImportEntityType,
  field: string,
): string | undefined {
  const result = dateField(record, ...keys);
  if (result.invalid) fieldException(exceptions, "invalid_date", field, entityType, record, "warning");
  return result.value;
}

function optionalTimestamp(
  record: RawRecord,
  keys: string[],
  exceptions: ImportMappingException[],
  entityType: ImportEntityType,
  field: string,
): string | undefined {
  const result = timestampField(record, ...keys);
  if (result.invalid) fieldException(exceptions, "invalid_timestamp", field, entityType, record, "warning");
  return result.value;
}

function requiredDate(
  record: RawRecord,
  keys: string[],
  exceptions: ImportMappingException[],
  entityType: ImportEntityType,
  field: string,
): string | undefined {
  const result = dateField(record, ...keys);
  if (!result.present) fieldException(exceptions, "missing_date", field, entityType, record);
  else if (result.invalid) fieldException(exceptions, "invalid_date", field, entityType, record);
  return result.value;
}

function requiredMoney(
  record: RawRecord,
  keys: string[],
  exceptions: ImportMappingException[],
  entityType: ImportEntityType,
  field: string,
  positive = false,
): number | undefined {
  const result = moneyField(record, ...keys);
  if (!result.present || result.invalid || result.value === undefined || (positive && result.value <= 0)) {
    const code = !result.present ? "amount_missing" : result.invalid ? "amount_invalid" : positive ? "amount_not_positive" : "amount_invalid";
    exception(exceptions, code, `${entityType} source ${sourceId(record)} has a missing, invalid, or non-positive ${field}`, entityType, record, result.value, "error");
    return undefined;
  }
  return result.value;
}

function exception(
  exceptions: ImportMappingException[],
  code: string,
  message: string,
  entityType?: ImportEntityType,
  source?: RawRecord,
  amountCents?: number,
  severity: ImportMappingException["severity"] = "warning",
): void {
  exceptions.push({ code, message, severity, entityType, sourceId: source ? sourceId(source) : undefined, amountCents });
}

function ensureSourceId(exceptions: ImportMappingException[], record: RawRecord, entityType: ImportEntityType): boolean {
  if (sourceId(record)) return true;
  exception(exceptions, "source_id_missing", `${entityType} has no source ID and was quarantined`, entityType, record, undefined, "error");
  return false;
}

function classifyCharge(record: RawRecord, definitions: RentManagerImportInput["chargeTypes"] = []): ChargeCategory {
  const typeId = stringValue(record, "chargeTypeId", "ChargeTypeID", "ChargeTypeId", "charge_code_id", "ChargeCodeID", "ChargeCodeId", "typeId", "TypeID", "TypeId");
  const definition = definitions?.find((candidate) => candidate.sourceId === typeId);
  if (definition?.category) return definition.category;
  const explicitCategory = stringValue(record, "category", "Category", "chargeCategory", "ChargeCategory");
  const supportedCategories: ChargeCategory[] = ["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"];
  if (explicitCategory && supportedCategories.includes(explicitCategory as ChargeCategory)) return explicitCategory as ChargeCategory;
  const text = ["chargeTypeName", "chargeType", "name", "Name", "description", "Description", "category", "Category"]
    .map((key) => stringValue(record, key))
    .filter((candidate): candidate is string => Boolean(candidate))
    .join(" ")
    .toLowerCase();
  if (/subsid|hap|voucher|agency/.test(text)) return "subsidy";
  if (/pet/.test(text) && /deposit/.test(text)) return "refundable_pet_deposit";
  if (/security/.test(text) || /deposit/.test(text)) return "security_deposit";
  if (/move.?in/.test(text)) return "move_in_funds";
  if (/rent/.test(text)) return "base_rent";
  if (/fee|late|utility|admin/.test(text)) return "recurring_fee";
  return "other";
}

function sourceChargeTypeId(record: RawRecord): string | undefined {
  return stringValue(record, "chargeTypeId", "ChargeTypeID", "ChargeTypeId", "charge_code_id", "ChargeCodeID", "ChargeCodeId", "typeId", "TypeID", "TypeId");
}

function strictChargeCategory(context: MappingContext, record: RawRecord): { value: ChargeCategory | null; knowledge: "source" | "unknown" } {
  const typeId = sourceChargeTypeId(record);
  const mapped = typeId === undefined ? undefined : strictFinancialValue(context, {
    sourceCollection: "chargeTypes",
    sourceField: "ChargeTypeID",
    semanticKind: "charge_category",
    rawValue: typeId,
  });
  const categories: readonly ChargeCategory[] = ["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"];
  return categories.includes(mapped as ChargeCategory)
    ? { value: mapped as ChargeCategory, knowledge: "source" }
    : { value: null, knowledge: "unknown" };
}

type PaymentPayer = NonNullable<RentOpsLedgerTransaction["payer"]>;

/**
 * Payer is deliberately sourced from an explicit RM field only. A tenant
 * relationship, memo text, payment method, or HAP-looking description is not
 * evidence of who actually paid. Unknown remains unknown and is handled as a
 * reconciliation exception below.
 */
function directPayer(record: RawRecord): PaymentPayer | undefined {
  const directFields = [
    "payer",
    "Payer",
    "payerType",
    "PayerType",
    "payerCategory",
    "PayerCategory",
    "receivedFromType",
    "ReceivedFromType",
    "paymentPayerType",
    "PaymentPayerType",
    "paymentSourceType",
    "PaymentSourceType",
  ];
  const directValues = directFields
    .map((field) => value(record, field))
    .filter((candidate): candidate is string | number => typeof candidate === "string" || typeof candidate === "number")
    .map((candidate) => String(candidate).trim().toLowerCase())
    .filter(Boolean);
  for (const candidate of directValues) {
    if (/^(tenant|resident|customer|lessee|applicant)$/.test(candidate)) return "tenant";
    if (/^(agency|housing authority|housing_authority|hap|voucher|subsidy|government)$/.test(candidate)) return "agency";
    if (/^(owner|landlord)$/.test(candidate)) return "owner";
    if (/^(unknown|unassigned|other|none)$/.test(candidate)) return "unknown";
  }
  if (boolValue(record, "isAgencyPayment", "IsAgencyPayment", "agencyPayment", "AgencyPayment")) return "agency";
  if (boolValue(record, "isTenantPayment", "IsTenantPayment", "tenantPayment", "TenantPayment")) return "tenant";
  return directValues.length > 0 ? "unknown" : undefined;
}

function looksLikeHapPayment(record: RawRecord): boolean {
  const description = `${stringValue(record, "description", "Description", "memo", "Memo", "name", "Name", "paymentType", "PaymentType") ?? ""}`.toLowerCase();
  return /subsid|hap|voucher|housing authority|agency payment/.test(description) || Boolean(value(record, "agencyName", "AgencyName", "housingAuthority", "HousingAuthority"));
}

function mapProperty(context: MappingContext, record: RawRecord, exceptions: ImportMappingException[]): RentOpsProperty | undefined {
  const id = targetId(context, "property", sourceId(record));
  const name = stringValue(record, "name", "propertyName");
  const addressLine1 = stringValue(record, "address", "addressLine1", "street");
  const city = stringValue(record, "city");
  const state = stringValue(record, "state");
  const postalCode = stringValue(record, "postalCode", "zip", "zipCode");
  if (isV3(context)) {
    const propertyTypeText = stringValue(record, "propertyType", "type")?.toLowerCase();
    const propertyType: RentOpsProperty["propertyType"] | null = propertyTypeText && /single/.test(propertyTypeText)
      ? "single_family"
      : propertyTypeText && /multi|apartment/.test(propertyTypeText)
        ? "multifamily"
        : propertyTypeText && /other/.test(propertyTypeText)
          ? "other"
          : null;
    const propertyState = propertyStateFromEvidence(record);
    if (!name || !addressLine1 || !city || !state || !postalCode) exception(exceptions, "property_fact_unknown", "Property retained with explicit unknown source fields", "property", record, undefined, "warning");
    if (propertyTypeText && !propertyType) exception(exceptions, "property_type_unknown", "Property type was not a recognized explicit RM value; retained as unknown", "property", record, undefined, "warning");
    if (!propertyTypeText) exception(exceptions, "property_type_unknown", "Property type was not returned by RM; retained as explicit unknown", "property", record, undefined, "warning");
    if (stringValue(record, "stateStatus", "status", "propertyStatus", "State", "StateStatus") && !propertyState) exception(exceptions, "property_state_unknown", "Property state was not a recognized explicit RM value; retained as unknown", "property", record, undefined, "warning");
    if (!propertyState) exception(exceptions, "property_state_unknown", "Property active/archive state was not returned by RM; retained as explicit unknown", "property", record, undefined, "warning");
    const completeAddress = Boolean(addressLine1 && city && state && state.length === 2 && postalCode);
    return {
      id,
      source: { system: SYSTEM, entityType: "property", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      name: name ?? null,
      slug: (stringValue(record, "slug", "shortName") ?? name ?? `property-${id.slice(-12)}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `property-${id.slice(-12)}`,
      address: { line1: addressLine1 ?? null, line2: stringValue(record, "addressLine2", "unitAddress") ?? null, city: city ?? null, state: state && state.length === 2 ? state : null, postalCode: postalCode ?? null },
      propertyType,
      state: propertyState,
      operatingContact: stringValue(record, "operatingContact", "contactName") ?? null,
      nameKnowledge: name ? "source" : "unknown",
      addressKnowledge: completeAddress ? "source" : "unknown",
      propertyTypeKnowledge: propertyType ? "source" : "unknown",
      stateKnowledge: propertyState ? "source" : "unknown",
      operatingContactKnowledge: stringValue(record, "operatingContact", "contactName") ? "source" : "unknown",
    } as unknown as RentOpsProperty;
  }
  if (!name || !addressLine1 || !city || !state || !postalCode) {
    if (isV3(context)) {
      exception(exceptions, "property_fact_unknown", "Property retained with explicit unknown source fields", "property", record, undefined, "warning");
      const propertyTypeText = stringValue(record, "propertyType", "type")?.toLowerCase();
      const propertyState = propertyStateFromEvidence(record);
      if (stringValue(record, "stateStatus", "status", "propertyStatus", "State", "StateStatus") && !propertyState) {
        exception(exceptions, "property_state_unknown", "Property state was not a recognized explicit RM value; retained as unknown", "property", record, undefined, "warning");
      }
      const propertyType: RentOpsProperty["propertyType"] | null = propertyTypeText && /single/.test(propertyTypeText)
        ? "single_family"
        : propertyTypeText && /multi|apartment/.test(propertyTypeText)
          ? "multifamily"
          : propertyTypeText && /other/.test(propertyTypeText)
            ? "other"
            : null;
      const value = {
        id,
        source: { system: SYSTEM, entityType: "property", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
        name: name ?? null,
        slug: (stringValue(record, "slug", "shortName") ?? name ?? `property-${id.slice(-12)}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `property-${id.slice(-12)}`,
        address: {
          line1: addressLine1 ?? null,
          line2: stringValue(record, "addressLine2", "unitAddress") ?? null,
          city: city ?? null,
          state: state && state.length === 2 ? state : null,
          postalCode: postalCode ?? null,
        },
        propertyType,
        state: propertyState,
        operatingContact: stringValue(record, "operatingContact", "contactName") ?? null,
        nameKnowledge: name ? "source" : "unknown",
        addressKnowledge: addressLine1 && city && state && postalCode ? "source" : "unknown",
        propertyTypeKnowledge: propertyType ? "source" : "unknown",
        stateKnowledge: propertyState ? "source" : "unknown",
        operatingContactKnowledge: stringValue(record, "operatingContact", "contactName") ? "source" : "unknown",
      };
      return value as unknown as RentOpsProperty;
    }
    exception(exceptions, "property_fact_incomplete", "Property was quarantined because its sourced name and complete address are required", "property", record, undefined, "error");
    return undefined;
  }
  const propertyTypeText = stringValue(record, "propertyType", "type")?.toLowerCase();
  const stateText = stringValue(record, "stateStatus", "status", "propertyStatus")?.toLowerCase();
  const parsedV3State = propertyStateFromEvidence(record);
  const hasExplicitState = parsedV3State !== null;
  if (isV3(context) && (!propertyTypeText || !hasExplicitState)) {
    if (!propertyTypeText) exception(exceptions, "property_type_unknown", "Property type was not returned by RM; retained as explicit unknown", "property", record, undefined, "warning");
    if (!hasExplicitState) exception(exceptions, "property_state_unknown", stateText ? "Property state was not a recognized explicit RM value; retained as explicit unknown" : "Property active/archive state was not returned by RM; retained as explicit unknown", "property", record, undefined, "warning");
    const explicitType: RentOpsProperty["propertyType"] | null = propertyTypeText && /single/.test(propertyTypeText)
      ? "single_family"
      : propertyTypeText && /multi|apartment/.test(propertyTypeText)
        ? "multifamily"
        : propertyTypeText && /other/.test(propertyTypeText)
          ? "other"
          : null;
    const explicitState = parsedV3State;
    return {
      id,
      source: { system: SYSTEM, entityType: "property", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      name,
      slug: (stringValue(record, "slug", "shortName") ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `property-${id.slice(-12)}`,
      address: { line1: addressLine1, line2: stringValue(record, "addressLine2", "unitAddress"), city, state: state && state.length === 2 ? state : null, postalCode },
      propertyType: explicitType,
      state: explicitState,
      operatingContact: stringValue(record, "operatingContact", "contactName"),
      nameKnowledge: "source",
      addressKnowledge: state && state.length === 2 ? "source" : "unknown",
      propertyTypeKnowledge: explicitType ? "source" : "unknown",
      stateKnowledge: explicitState ? "source" : "unknown",
      operatingContactKnowledge: stringValue(record, "operatingContact", "contactName") ? "source" : "unknown",
    } as unknown as RentOpsProperty;
  }
  const propertyType: RentOpsProperty["propertyType"] = propertyTypeText && /single/.test(propertyTypeText) ? "single_family" : propertyTypeText && /multi|apartment/.test(propertyTypeText) ? "multifamily" : propertyTypeText && /other/.test(propertyTypeText) ? "other" : "other";
  if (!propertyTypeText) exception(exceptions, "property_type_unknown", "Property type was not returned by RM; retained as explicit unknown", "property", record, undefined, "warning");
  const propertyState: RentOpsProperty["state"] = boolValue(record, "archived", "isArchived") || /archiv|inactive|closed/.test(stateText ?? "") ? "archived" : "active";
  if (!stateText && value(record, "archived", "isArchived") === undefined) exception(exceptions, "property_state_unknown", "Property active/archive state was not returned by RM; retained as explicit unknown-active", "property", record, undefined, "warning");
  return {
    id,
    source: { system: SYSTEM, entityType: "property", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
    name,
    slug: (stringValue(record, "slug", "shortName") ?? name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "unknown-property",
    address: {
      line1: addressLine1,
      line2: stringValue(record, "addressLine2", "unitAddress"),
      city,
      state: state.length === 2 ? state : "UN",
      postalCode,
    },
    propertyType,
    state: propertyState,
    operatingContact: stringValue(record, "operatingContact", "contactName"),
  };
}

function mapUnit(context: MappingContext, record: RawRecord, propertyId: string | null, exceptions: ImportMappingException[]): RentOpsUnit | undefined {
  const id = targetId(context, "unit", sourceId(record));
  const unitNumber = stringValue(record, "unitNumber", "unit", "name");
  const marketRent = moneyField(record, "marketRentCents", "marketRent", "rent");
  const defaultDeposit = moneyField(record, "defaultDepositCents", "defaultDeposit");
  if (!unitNumber) {
    if (isV3(context)) {
      exception(exceptions, "unit_number_unknown", "Unit retained with an explicit unknown unit number", "unit", record, undefined, "warning");
      const mapped = {
        id,
        propertyId,
        source: { system: SYSTEM, entityType: "unit", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
        unitNumber: null,
        unitType: stringValue(record, "unitType", "type") ?? null,
        bedrooms: typeof value(record, "bedrooms") === "number" ? Number(value(record, "bedrooms")) : null,
        bathrooms: typeof value(record, "bathrooms") === "number" ? Number(value(record, "bathrooms")) : null,
        squareFeet: typeof value(record, "squareFeet", "sqft") === "number" ? Number(value(record, "squareFeet", "sqft")) : null,
        marketRentCents: marketRent.value ?? null,
        defaultDepositCents: defaultDeposit.value ?? null,
        readiness: null,
        listing: null,
        propertyLinkKnowledge: propertyId ? "exact" : "unknown",
        unitNumberKnowledge: "unknown",
        unitTypeKnowledge: stringValue(record, "unitType", "type") ? "source" : "unknown",
        readinessKnowledge: "unknown",
        listingKnowledge: "unknown",
      };
      return mapped as unknown as RentOpsUnit;
    }
    exception(exceptions, "unit_fact_incomplete", "Unit was quarantined because a sourced unit number is required", "unit", record, undefined, "error");
    return undefined;
  }
  const readinessValue = stringValue(record, "readiness", "makeReadyStatus");
  const listingValue = stringValue(record, "listing", "listingStatus");
  const parsedReadiness = unitReadinessFromEvidence(readinessValue);
  const parsedListing = unitListingFromEvidence(listingValue);
  if (!readinessValue) exception(exceptions, "unit_readiness_unknown", "Unit readiness was not returned by RM; retained as explicit unknown", "unit", record, undefined, "warning");
  else if (!parsedReadiness) exception(exceptions, "unit_readiness_unknown", "Unit readiness was not a recognized explicit RM value; retained as explicit unknown", "unit", record, undefined, "warning");
  if (!listingValue) exception(exceptions, "unit_listing_unknown", "Unit listing state was not returned by RM; retained as explicit unknown", "unit", record, undefined, "warning");
  else if (!parsedListing) exception(exceptions, "unit_listing_unknown", "Unit listing state was not a recognized explicit RM value; retained as explicit unknown", "unit", record, undefined, "warning");
  if (isV3(context)) {
    const mapped = {
      id,
      propertyId,
      source: { system: SYSTEM, entityType: "unit", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      unitNumber,
      unitType: stringValue(record, "unitType", "type") ?? null,
      bedrooms: typeof value(record, "bedrooms") === "number" ? Number(value(record, "bedrooms")) : null,
      bathrooms: typeof value(record, "bathrooms") === "number" ? Number(value(record, "bathrooms")) : null,
      squareFeet: typeof value(record, "squareFeet", "sqft") === "number" ? Number(value(record, "squareFeet", "sqft")) : null,
      marketRentCents: marketRent.value ?? null,
      defaultDepositCents: defaultDeposit.value ?? null,
      readiness: parsedReadiness,
      listing: parsedListing,
      propertyLinkKnowledge: propertyId ? "exact" : "unknown",
      unitNumberKnowledge: "source",
      unitTypeKnowledge: stringValue(record, "unitType", "type") ? "source" : "unknown",
      readinessKnowledge: parsedReadiness ? "source" : "unknown",
      listingKnowledge: parsedListing ? "source" : "unknown",
      amenities: Array.isArray(record.amenities) ? record.amenities.filter((item): item is string => typeof item === "string") : null,
      accessNotes: stringValue(record, "accessNotes", "notes") ?? null,
    };
    return mapped as unknown as RentOpsUnit;
  }
  const readinessText = (readinessValue ?? "not_ready").toLowerCase();
  const listingText = (listingValue ?? "unlisted").toLowerCase();
  if (marketRent.invalid) exception(exceptions, "amount_invalid", `Unit source ${sourceId(record)} has an invalid market rent and it was quarantined`, "unit", record, undefined, "error");
  if (defaultDeposit.invalid) exception(exceptions, "amount_invalid", `Unit source ${sourceId(record)} has an invalid default deposit and it was quarantined`, "unit", record, undefined, "error");
  return {
    id,
    propertyId,
    source: { system: SYSTEM, entityType: "unit", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
    unitNumber,
    unitType: stringValue(record, "unitType", "type"),
    bedrooms: typeof value(record, "bedrooms") === "number" ? Number(value(record, "bedrooms")) : undefined,
    bathrooms: typeof value(record, "bathrooms") === "number" ? Number(value(record, "bathrooms")) : undefined,
    squareFeet: typeof value(record, "squareFeet", "sqft") === "number" ? Number(value(record, "squareFeet", "sqft")) : undefined,
    marketRentCents: marketRent.value,
    defaultDepositCents: defaultDeposit.value,
    readiness: /off/.test(readinessText) ? "off_market" : /ready/.test(readinessText) && !/not/.test(readinessText) ? "ready" : "not_ready",
    listing: /off/.test(listingText) ? "off_market" : /list/.test(listingText) ? "listed" : "unlisted",
    accessNotes: stringValue(record, "accessNotes", "notes"),
  } as unknown as RentOpsUnit;
}

function mapPerson(context: MappingContext, record: RawRecord, exceptions: ImportMappingException[]): RentOpsPerson | undefined {
  const phoneMethods = Array.isArray(record.phoneMethods)
    ? record.phoneMethods.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const method = candidate as RawRecord;
      const phone = stringValue(method, "value", "phone", "Number", "PhoneNumber");
      if (!phone) return [];
      const methodSourceId = stringValue(method, "id", "sourceId");
      return [{
        ...(methodSourceId ? { id: targetId(context, "person", `${sourceId(record)}:phone:${methodSourceId}`) } : {}),
        value: phone,
        ...(stringValue(method, "type", "phoneType", "PhoneType", "PhoneTypeName") ? { type: stringValue(method, "type", "phoneType", "PhoneType", "PhoneTypeName") } : {}),
        ...(value(method, "isPrimary", "IsPrimary") !== undefined ? { isPrimary: boolValue(method, "isPrimary", "IsPrimary") } : {}),
        ...(value(method, "isTextReady", "IsTextReady") !== undefined ? { isTextReady: boolValue(method, "isTextReady", "IsTextReady") } : {}),
      }];
    })
    : undefined;
  const fullNameText = stringValue(record, "name", "fullName", "Name", "FullName");
  const explicitFirstName = stringValue(record, "firstName", "first_name", "FirstName");
  const explicitLastName = stringValue(record, "lastName", "last_name", "LastName");
  const firstName = explicitFirstName ?? fullNameText?.trim().split(/\s+/)[0];
  const lastName = explicitLastName ?? fullNameText?.trim().split(/\s+/).slice(1).join(" ");
  if (!firstName || !lastName) {
    if (isV3(context)) {
      exception(exceptions, "person_name_unknown", "Person retained with explicit unknown name fields", "person", record, undefined, "warning");
      return {
        id: targetId(context, "person", sourceId(record)),
        source: { system: SYSTEM, entityType: "person", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
        firstName: (firstName ?? null) as unknown as string,
        lastName: (lastName ?? null) as unknown as string,
        email: stringValue(record, "email") ?? null as unknown as string,
        phone: stringValue(record, "phone", "mobile") ?? null as unknown as string,
        phoneMethods,
        firstNameKnowledge: explicitFirstName ? "source" : firstName ? "inferred" : "unknown",
        lastNameKnowledge: explicitLastName ? "source" : lastName ? "inferred" : "unknown",
        emailKnowledge: stringValue(record, "email") ? "source" : "unknown",
        phoneKnowledge: stringValue(record, "phone", "mobile") ? "source" : "unknown",
        renterInsuranceExpiresOn: optionalDate(record, ["renterInsuranceExpiresOn", "insuranceExpiration"], exceptions, "person", "renterInsuranceExpiresOn"),
        archived: value(record, "archived", "isArchived") === undefined ? null : boolValue(record, "archived", "isArchived"),
        archivedKnowledge: value(record, "archived", "isArchived") === undefined ? "unknown" : "source",
      };
    }
    exception(exceptions, "person_fact_incomplete", "Person was quarantined because sourced first and last names are required", "person", record, undefined, "error");
    return undefined;
  }
  return {
    id: targetId(context, "person", sourceId(record)),
    source: { system: SYSTEM, entityType: "person", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
    firstName,
    lastName,
    email: stringValue(record, "email"),
    phone: stringValue(record, "phone", "mobile"),
    phoneMethods,
    firstNameKnowledge: explicitFirstName ? "source" : firstName ? "inferred" : "unknown",
    lastNameKnowledge: explicitLastName ? "source" : lastName ? "inferred" : "unknown",
    emailKnowledge: stringValue(record, "email") ? "source" : "unknown",
    phoneKnowledge: stringValue(record, "phone", "mobile") ? "source" : "unknown",
    renterInsuranceExpiresOn: optionalDate(record, ["renterInsuranceExpiresOn", "insuranceExpiration"], exceptions, "person", "renterInsuranceExpiresOn"),
    archived: value(record, "archived", "isArchived") === undefined ? null : boolValue(record, "archived", "isArchived"),
    archivedKnowledge: value(record, "archived", "isArchived") === undefined ? "unknown" : "source",
  };
}

function sourceLink(record: RawRecord, ...keys: string[]): string | undefined {
  const linked = stringValue(record, ...keys);
  return linked ? linked : undefined;
}

function sourceKeyVariants(raw: string | undefined): string[] {
  if (!raw) return [];
  const variants = new Set<string>([raw]);
  const unnamespaced = raw.replace(/^(?:property|unit|person|tenant|lease|tenancy|subsidy|subsidy_tenant|subsidy_payment|payment|ledger_transaction):/i, "");
  if (unnamespaced !== raw) variants.add(unnamespaced);
  return Array.from(variants);
}

function sourceMapGet<T>(map: ReadonlyMap<string, T>, raw: string | undefined): T | undefined {
  for (const key of sourceKeyVariants(raw)) {
    const found = map.get(key);
    if (found) return found;
  }
  return undefined;
}

function hapStatusField(record: RawRecord): { value?: unknown; field?: string } {
  // Prefer the original RM-cased field when a normalizer row also carries a
  // canonical `status` alias. The crosswalk selector is bound to this source
  // field, so the alias by itself is never sufficient proof.
  for (const field of ["Status", "SubsidyStatus", "ContractStatus", "PaymentStatus", "status", "subsidyStatus", "contractStatus", "paymentStatus"]) {
    const candidate = value(record, field);
    if (candidate !== undefined) return { value: candidate, field };
  }
  return {};
}

function exactHapStatus(context: MappingContext, record: RawRecord, kind: "contract" | "payment", collection: RentManagerHapStatusCrosswalk["sourceCollection"]): { value?: HapContractStatus | HapPaymentStatus; knowledge: "source" | "unknown" } {
  const statusField = hapStatusField(record);
  // In v3, even a caller-supplied canonical status/statusKnowledge pair is
  // untrusted. Re-run the exact artifact-bound source-field crosswalk so a
  // direct mapper caller cannot bypass the evidence boundary. Legacy callers
  // retain the historical canonical pair behavior.
  const existing = stringValue(record, "status");
  const existingKnowledge = stringValue(record, "statusKnowledge");
  const allowed = kind === "contract" ? ["active", "ended", "pending", "exception"] : ["received", "pending", "voided", "reversed"];
  if (!isV3(context) && existing && existingKnowledge === "source" && allowed.includes(existing)) return { value: existing as HapContractStatus | HapPaymentStatus, knowledge: "source" };
  const result = normalizeHapStatusValue(statusField.value, kind, context.hapStatusCrosswalk, context.artifactSha256, collection, statusField.field);
  return { value: result.value, knowledge: result.value ? "source" : "unknown" };
}

function sanitizeFilename(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return clean || "document.bin";
}

function profileObject(valueToRead: unknown): Record<string, unknown> | undefined {
  return valueToRead && typeof valueToRead === "object" && !Array.isArray(valueToRead) ? valueToRead as Record<string, unknown> : undefined;
}

function profileString(valueToRead: unknown): string | undefined {
  if (typeof valueToRead !== "string" && typeof valueToRead !== "number") return undefined;
  const result = String(valueToRead).trim();
  return result || undefined;
}

function profileInteger(valueToRead: unknown): number | undefined {
  return typeof valueToRead === "number" && Number.isSafeInteger(valueToRead) && valueToRead >= 0 ? valueToRead : undefined;
}

function profileBoolean(valueToRead: unknown): boolean | undefined {
  return typeof valueToRead === "boolean" ? valueToRead : undefined;
}

function profileDate(valueToRead: unknown): string | undefined {
  return typeof valueToRead === "string" && isValidCalendarDate(valueToRead) ? valueToRead : undefined;
}

function copyProfileStringFields(source: Record<string, unknown> | undefined, fields: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!source) return result;
  for (const field of fields) {
    const valueToCopy = profileString(source[field]);
    if (valueToCopy !== undefined) result[field] = valueToCopy;
  }
  return result;
}

function mapApplicationProfile(record: RawRecord, exceptions: ImportMappingException[]): Pick<RentOpsApplication, "rentalHistory" | "employment" | "householdSummary" | "preferences" | "voucher" | "pets" | "vehicles" | "emergencyContact"> {
  const profile = (key: string): Record<string, unknown> | undefined => profileObject(record[key]);
  const rentalSource = profile("rentalHistory") ?? profile("rental_history");
  const rentalHistory = copyProfileStringFields(rentalSource, ["currentAddress", "priorAddress", "landlordName", "landlordContact", "reasonForMoving"]) as RentalHistory;

  const employmentSource = profile("employment");
  const employment = copyProfileStringFields(employmentSource, ["employerName", "jobTitle"]) as EmploymentInfo;
  const monthlyIncomeCents = profileInteger(employmentSource?.monthlyIncomeCents);
  const employmentStartOn = profileDate(employmentSource?.employmentStartOn);
  if (employmentSource?.monthlyIncomeCents !== undefined && monthlyIncomeCents === undefined) exception(exceptions, "application_profile_field_invalid", "Application employment monthly income was not a non-negative integer and was not mapped", "application", record, undefined, "warning");
  if (employmentSource?.employmentStartOn !== undefined && employmentStartOn === undefined) exception(exceptions, "application_profile_field_invalid", "Application employment start date was not a valid calendar date and was not mapped", "application", record, undefined, "warning");
  if (monthlyIncomeCents !== undefined) employment.monthlyIncomeCents = monthlyIncomeCents;
  if (employmentStartOn !== undefined) employment.employmentStartOn = employmentStartOn;

  const householdSource = profile("householdSummary") ?? profile("household_summary");
  const household: Record<string, unknown> = {};
  for (const field of ["adults", "children", "totalOccupants"] as const) {
    const parsed = profileInteger(householdSource?.[field]);
    if (parsed !== undefined) household[field] = parsed;
    else if (householdSource?.[field] !== undefined) exception(exceptions, "application_profile_field_invalid", `Application household ${field} was not a non-negative integer and was not mapped`, "application", record, undefined, "warning");
  }

  const preferencesSource = profile("preferences");
  const preferences: Record<string, unknown> = {};
  const desiredMoveInOn = profileDate(preferencesSource?.desiredMoveInOn);
  const desiredLeaseMonths = profileInteger(preferencesSource?.desiredLeaseMonths);
  const maxRentCents = profileInteger(preferencesSource?.maxRentCents);
  const bedrooms = profileInteger(preferencesSource?.bedrooms);
  if (desiredMoveInOn !== undefined) preferences.desiredMoveInOn = desiredMoveInOn;
  if (desiredLeaseMonths !== undefined) preferences.desiredLeaseMonths = desiredLeaseMonths;
  if (maxRentCents !== undefined) preferences.maxRentCents = maxRentCents;
  if (bedrooms !== undefined) preferences.bedrooms = bedrooms;
  for (const [field, raw] of [["desiredMoveInOn", preferencesSource?.desiredMoveInOn], ["desiredLeaseMonths", preferencesSource?.desiredLeaseMonths], ["maxRentCents", preferencesSource?.maxRentCents], ["bedrooms", preferencesSource?.bedrooms]] as const) {
    if (raw !== undefined && preferences[field] === undefined) exception(exceptions, "application_profile_field_invalid", `Application preference ${field} was invalid and was not mapped`, "application", record, undefined, "warning");
  }

  const voucherSource = profile("voucher");
  const voucher: Record<string, unknown> = {};
  const hasVoucher = profileBoolean(voucherSource?.hasVoucher);
  const tenantPortionCents = profileInteger(voucherSource?.tenantPortionCents);
  if (hasVoucher !== undefined) voucher.hasVoucher = hasVoucher;
  for (const field of ["agencyName", "caseNumber"] as const) {
    const parsed = profileString(voucherSource?.[field]);
    if (parsed !== undefined) voucher[field] = parsed;
  }
  if (tenantPortionCents !== undefined) voucher.tenantPortionCents = tenantPortionCents;
  if (voucherSource?.hasVoucher !== undefined && hasVoucher === undefined) exception(exceptions, "application_profile_field_invalid", "Application voucher flag was invalid and was not mapped", "application", record, undefined, "warning");
  if (voucherSource?.tenantPortionCents !== undefined && tenantPortionCents === undefined) exception(exceptions, "application_profile_field_invalid", "Application voucher tenant portion was invalid and was not mapped", "application", record, undefined, "warning");

  const petsSource = Array.isArray(record.pets) ? record.pets : undefined;
  const pets = petsSource?.flatMap((candidate): PetInfo[] => {
    const item = profileObject(candidate);
    const type = profileString(item?.type);
    if (!item || !type) {
      exception(exceptions, "application_profile_field_invalid", "Application pet entry has no sourced type and was not mapped", "application", record, undefined, "warning");
      return [];
    }
    const weightLb = profileInteger(item.weightLb);
    return [{ type, ...(profileString(item.name) ? { name: profileString(item.name) } : {}), ...(weightLb === undefined ? {} : { weightLb }) }];
  });

  const vehiclesSource = Array.isArray(record.vehicles) ? record.vehicles : undefined;
  const vehicles = vehiclesSource?.flatMap((candidate): VehicleInfo[] => {
    const item = profileObject(candidate);
    if (!item) {
      exception(exceptions, "application_profile_field_invalid", "Application vehicle entry was not an object and was not mapped", "application", record, undefined, "warning");
      return [];
    }
    const mapped: VehicleInfo = {};
    for (const field of ["makeModel", "plateState", "plateLastFour"] as const) {
      const parsed = profileString(item[field]);
      if (parsed !== undefined) mapped[field] = parsed;
    }
    return Object.keys(mapped).length > 0 ? [mapped] : [];
  });

  const emergencySource = profile("emergencyContact") ?? profile("emergency_contact");
  const emergencyName = profileString(emergencySource?.name);
  const emergencyPhone = profileString(emergencySource?.phone);
  const emergencyContact = emergencyName && emergencyPhone ? { name: emergencyName, phone: emergencyPhone, ...(profileString(emergencySource?.relationship) ? { relationship: profileString(emergencySource?.relationship) } : {}) } as EmergencyContact : undefined;
  if (emergencySource && (!emergencyName || !emergencyPhone)) exception(exceptions, "application_profile_field_invalid", "Application emergency contact requires sourced name and phone and was not mapped", "application", record, undefined, "warning");

  return {
    ...(Object.keys(rentalHistory).length > 0 ? { rentalHistory } : {}),
    ...(Object.keys(employment).length > 0 ? { employment } : {}),
    ...(Object.keys(household).length > 0 ? { householdSummary: household as unknown as HouseholdSummary } : {}),
    ...(Object.keys(preferences).length > 0 ? { preferences: preferences as ApplicationPreferences } : {}),
    ...(Object.keys(voucher).length > 0 ? { voucher: voucher as unknown as VoucherInfo } : {}),
    ...(pets && pets.length > 0 ? { pets } : {}),
    ...(vehicles && vehicles.length > 0 ? { vehicles } : {}),
    ...(emergencyContact ? { emergencyContact } : {}),
  };
}

function mapTenancy(context: MappingContext, record: RawRecord, propertyBySource: Map<string, RentOpsProperty>, unitBySource: Map<string, RentOpsUnit>, personBySource: Map<string, RentOpsPerson>, exceptions: ImportMappingException[], importedAt: string): RentOpsTenancy | undefined {
  const propertySource = sourceLink(record, "propertyId", "propertySourceId");
  const unitSource = sourceLink(record, "unitId", "unitSourceId");
  const personSource = sourceLink(record, "tenantId", "personId", "tenantSourceId");
  const property = propertyBySource.get(propertySource ?? "");
  const unit = unitBySource.get(unitSource ?? "");
  const person = personBySource.get(personSource ?? "");
  if ((!property || !unit || !person) && !isV3(context)) return undefined;
  const statusSource = stringValue(record, "status", "tenantStatus");
  const statusText = (statusSource ?? "").toLowerCase();
  const explicitPlannedMoveInOn = optionalDate(record, ["plannedMoveInOn", "plannedMoveIn", "desiredMoveInOn", "requestedMoveInOn"], exceptions, "tenancy", "plannedMoveInOn");
  const sourceMoveInOn = optionalDate(record, ["moveInDate", "moveIn"], exceptions, "tenancy", "moveInDate");
  const explicitActualMoveInOn = optionalDate(record, ["actualMoveInOn", "actualMoveIn"], exceptions, "tenancy", "actualMoveInOn");
  const noticeOn = optionalDate(record, ["noticeOn", "noticeDate"], exceptions, "tenancy", "noticeOn");
  const expectedMoveOutOn = optionalDate(record, ["expectedMoveOutOn", "expectedMoveOut", "moveOutDate"], exceptions, "tenancy", "expectedMoveOutOn");
  const actualMoveOutOn = optionalDate(record, ["actualMoveOutOn", "actualMoveOut"], exceptions, "tenancy", "actualMoveOutOn");
  if (!statusSource && !actualMoveOutOn && !isV3(context)) {
    exception(exceptions, "tenancy_status_unknown", "Tenancy status was not returned by RM and was not defaulted", "tenancy", record, undefined, "error");
    return undefined;
  }
  const sourceCollection = stringValue(record, "sourceCollection");
  const observedPartition = value(record, "$partition", "partition", "sourcePartition") ?? sourceCollection?.match(/^tenants\.(current|future|former)$/i)?.[1];
  const strictStatus = strictFinancialValue(context, {
    sourceCollection: sourceCollection ?? "",
    sourceField: "$partition",
    semanticKind: "tenancy_status",
    rawValue: observedPartition,
  });
  const status = isV3(context)
    ? strictStatus === "current" || strictStatus === "future" || strictStatus === "past" || strictStatus === "notice" || strictStatus === "cancelled" ? strictStatus : null
    : statusSource
      ? (/future|prelease/.test(statusText) ? "future" : /current|active|occupied/.test(statusText) ? "current" : /past|former|ended/.test(statusText) ? "past" : /notice/.test(statusText) ? "notice" : /cancel/.test(statusText) ? "cancelled" : null)
      : actualMoveOutOn ? "past" : null;
  const futureStatus = status === "future";
  const plannedMoveInOn = explicitPlannedMoveInOn ?? (!isV3(context) && futureStatus ? sourceMoveInOn : undefined);
  const actualMoveInOn = explicitActualMoveInOn ?? (!isV3(context) && !futureStatus && status !== null ? sourceMoveInOn : undefined);
  if (isV3(context) && statusSource && !status) exception(exceptions, "tenancy_status_unknown", "Tenancy status was not a recognized explicit RM status; retained as unknown", "tenancy", record, undefined, "warning");
  const updatedAt = optionalTimestamp(record, ["updatedAt", "updated_at"], exceptions, "tenancy", "updatedAt");
  const createdAt = sourceCreatedAt(record);
  if (!createdAt) exception(exceptions, "tenancy_created_at_unknown", "Tenancy creation timestamp was not returned by RM; retained as explicit unknown", "tenancy", record, undefined, "warning");
  const mapped = {
    id: targetId(context, "tenancy", sourceId(record)),
    source: { system: SYSTEM, entityType: "tenancy", sourceId: sourceId(record), sourceUpdatedAt: updatedAt },
    propertyId: property?.id ?? null,
    unitId: unit?.id ?? null,
    primaryPersonId: person?.id ?? null,
    status,
    plannedMoveInOn,
    actualMoveInOn,
    noticeOn,
    expectedMoveOutOn,
    actualMoveOutOn,
    applicationId: stringValue(record, "applicationId") ? targetId(context, "application", stringValue(record, "applicationId") as string) : undefined,
    createdAt: isV3(context) ? (createdAt ?? null) : (createdAt ?? importedAt),
    propertyLinkKnowledge: property ? "exact" : "unknown",
    unitLinkKnowledge: unit ? "exact" : "unknown",
    primaryPersonLinkKnowledge: person ? "exact" : "unknown",
    statusKnowledge: status ? "source" : "unknown",
    plannedMoveInKnowledge: plannedMoveInOn ? "source" : "unknown",
    actualMoveInKnowledge: actualMoveInOn ? "source" : "unknown",
    noticeKnowledge: noticeOn ? "source" : "unknown",
    expectedMoveOutKnowledge: expectedMoveOutOn ? "source" : "unknown",
    actualMoveOutKnowledge: actualMoveOutOn ? "source" : "unknown",
    createdAtKnowledge: createdAt ? "source" : "unknown",
  };
  return mapped as unknown as RentOpsTenancy;
}

function mapLeaseTerm(context: MappingContext, record: RawRecord, tenancyBySource: Map<string, RentOpsTenancy>, exceptions: ImportMappingException[], importedAt: string): RentOpsLeaseTerm | undefined {
  // TenantID identifies a person/account, not a lease.  It is deliberately
  // not a fallback for the tenancy relationship; coincident RM identifiers
  // must never turn an unrelated term into an exact lease term.
  const tenancySource = sourceLink(record, "tenancyId", "leaseId", "TenancyID", "LeaseID");
  const tenancy = tenancyBySource.get(tenancySource ?? "");
  if (!tenancy && !isV3(context)) return undefined;
  const startRead = dateField(record, "contractStartOn", "termStart", "startDate");
  const start = startRead.value;
  if (startRead.invalid) fieldException(exceptions, "invalid_date", "contractStartOn", "lease_term", record, isV3(context) ? "warning" : "error");
  if (!start && !isV3(context)) fieldException(exceptions, "missing_date", "contractStartOn", "lease_term", record);
  const endRead = dateField(record, "contractEndOn", "termEnd", "endDate");
  if (endRead.invalid) fieldException(exceptions, "invalid_date", "contractEndOn", "lease_term", record);
  const end = endRead.value;
  if ((!start || (endRead.present && !end)) && !isV3(context)) return undefined;
  if (end && start && end < start) {
    exception(exceptions, "date_order_invalid", "Lease term contractEndOn cannot precede contractStartOn", "lease_term", record, undefined, "error");
    return undefined;
  }
  const monthToMonthSource = value(record, "monthToMonth", "isMonthToMonth");
  const monthToMonth = monthToMonthSource === undefined && isV3(context) ? null : boolValue(record, "monthToMonth", "isMonthToMonth") || (!end && !isV3(context));
  const statusSource = stringValue(record, "status", "termStatus", "leaseStatus")?.toLowerCase();
  const explicitStatus: RentOpsLeaseTerm["status"] | null = statusSource
    ? /cancel/.test(statusSource) ? "cancelled" : /month.?to.?month|mtm/.test(statusSource) ? "month_to_month" : /execut|signed/.test(statusSource) ? "executed" : /expir|ended/.test(statusSource) ? "expired" : /draft|pending/.test(statusSource) ? "draft" : null
    : null;
  if (isV3(context) && statusSource && !explicitStatus) exception(exceptions, "lease_term_status_unknown", "Lease-term status was not a recognized explicit RM status; retained as unknown", "lease_term", record, undefined, "warning");
  const signedOn = optionalDate(record, ["signedOn", "signedDate"], exceptions, "lease_term", "signedOn");
  const updatedAt = optionalTimestamp(record, ["updatedAt", "updated_at"], exceptions, "lease_term", "updatedAt");
  const createdAt = sourceCreatedAt(record);
  if (!createdAt) exception(exceptions, "lease_term_created_at_unknown", "Lease-term creation timestamp was not returned by RM; retained as explicit unknown", "lease_term", record, undefined, "warning");
  const mapped = {
    id: targetId(context, "lease_term", sourceId(record)),
    tenancyId: tenancy?.id ?? null,
    source: { system: SYSTEM, entityType: "lease_term", sourceId: sourceId(record), sourceUpdatedAt: updatedAt },
    status: isV3(context) ? null : (start || value(record, "status") ? (monthToMonth ? "month_to_month" : boolValue(record, "signed", "executed") ? "executed" : "draft") : null),
    contractStartOn: start ?? null,
    contractEndOn: end ?? null,
    monthToMonth,
    signedOn,
    executedDocumentId: stringValue(record, "executedDocumentId") ? targetId(context, "document", stringValue(record, "executedDocumentId") as string) : undefined,
    renewalOfId: stringValue(record, "renewalOfId") ? targetId(context, "lease_term", stringValue(record, "renewalOfId") as string) : undefined,
    createdAt: isV3(context) ? (createdAt ?? null) : (createdAt ?? importedAt),
    tenancyLinkKnowledge: tenancy ? "exact" : "unknown",
    statusKnowledge: isV3(context) ? "unknown" : (start || value(record, "status")) ? "source" : "unknown",
    contractStartKnowledge: start ? "source" : "unknown",
    contractEndKnowledge: end ? "source" : "unknown",
    signedOnKnowledge: signedOn ? "source" : "unknown",
    monthToMonthKnowledge: monthToMonthSource === undefined ? "unknown" : "source",
    createdAtKnowledge: createdAt ? "source" : "unknown",
  };
  return mapped as unknown as RentOpsLeaseTerm;
}

function canonicalRecurringScope(valueToRead: string | undefined): RentOpsRecurringChargeSchedule["scopeType"] | undefined {
  if (!valueToRead) return undefined;
  if (/tenant|customer|resident|person/i.test(valueToRead)) return "tenant";
  if (/unit/i.test(valueToRead)) return "unit";
  if (/property|building/i.test(valueToRead)) return "property";
  return undefined;
}

function chargeDefinition(
  context: MappingContext,
  record: RawRecord,
  category: ChargeCategory | null,
  definitions: readonly { sourceId: string }[] = [],
): { id?: string | null; key?: string | null; knowledge: "source" | "unknown" } {
  const id = stringValue(record, "chargeDefinitionId", "ChargeTypeID", "ChargeTypeId", "ChargeCodeID", "ChargeCodeId", "typeId");
  const explicitKey = stringValue(record, "chargeDefinitionKey", "ChargeTypeKey", "ChargeCode", "ChargeKey");
  if (isV3(context)) {
    const sourceDefinition = id;
    if (!sourceDefinition) {
      return { id: null, key: null, knowledge: "unknown" };
    }
    // A ChargeTypeID is only an exact definition link when its opaque
    // definition row was actually observed in this same artifact.  Preserve
    // the schedule row with an unknown/unlinked definition otherwise; never
    // manufacture an orphan FK from a dangling source ID.
    if (!definitions.some((definition) => String(definition.sourceId) === sourceDefinition)) {
      return { id: null, key: null, knowledge: "unknown" };
    }
    const opaque = targetId(context, "charge_definition", sourceDefinition);
    return { id: opaque, key: opaque, knowledge: "source" };
  }
  // Charge-definition IDs are RM source identifiers, not safe operational
  // identifiers.  Keep them in the restricted source row only and derive an
  // opaque keyed target identity for both persisted grouping fields.  Using
  // the explicit key as a fallback still goes through the factory because RM
  // sometimes embeds its numeric type ID in an otherwise human-looking key.
  const sourceDefinition = id ?? explicitKey;
  if (sourceDefinition) {
    const opaque = targetId(context, "charge_definition", sourceDefinition);
    return { id: opaque, key: opaque, knowledge: "source" };
  }
  const description = stringValue(record, "description", "name", "chargeTypeName", "ChargeTypeName")?.trim();
  if (description) {
    // A directly returned description is a usable source definition, but its
    // target grouping identity is still keyed and opaque.
    const opaque = targetId(context, "charge_definition", `description:${description.toLowerCase()}`);
    return { id: opaque, key: opaque, knowledge: "source" };
  }
  // The row itself is the only stable identity when RM returns no definition
  // ID, key, or description.  Keep schedules distinct while explicitly
  // marking the semantic definition unknown; category is not a definition.
  const rowIdentity = stringValue(record, "sourceId", "id", "ID", "RecurringChargeID", "RecurringScheduleID") ?? `${category ?? "other"}:unknown-row`;
  const opaque = targetId(context, "charge_definition", `row:${rowIdentity}`);
  return { id: opaque, key: opaque, knowledge: "unknown" };
}

interface RecurringScopeResolution {
  scopeType: NonNullable<RentOpsRecurringChargeSchedule["scopeType"]>;
  scopeId: string;
  tenancy?: RentOpsTenancy;
  person?: RentOpsPerson;
  unit?: RentOpsUnit;
  property?: RentOpsProperty;
}

function resolveRecurringScope(
  record: RawRecord,
  propertyBySource: Map<string, RentOpsProperty>,
  unitBySource: Map<string, RentOpsUnit>,
  personBySource: Map<string, RentOpsPerson>,
  tenancyBySource: Map<string, RentOpsTenancy>,
  exceptions: ImportMappingException[],
  strictSourceScope = false,
  strictScopeType?: RentOpsRecurringChargeSchedule["scopeType"],
): RecurringScopeResolution | undefined {
  const explicitTenancySource = sourceLink(record, "tenancyId", "leaseId", "TenancyID", "LeaseID");
  const tenancy = explicitTenancySource ? tenancyBySource.get(explicitTenancySource) : undefined;
  const rawScopeType = stringValue(record, "scopeType", "EntityType", "EntityTypeName", "ScopeType");
  const rawScopeId = stringValue(record, "scopeId", "EntityKeyID", "EntityKeyId");
  // v3 requires RM's explicit EntityType/ScopeType.  Inferring a scope from
  // convenient link fields changes the meaning of a source row and can make
  // two same-category schedules collapse into a false tenant/unit/property
  // fact.  Legacy v1/v2 callers retain their historical fallback only until
  // their next migration.
  const scopeType = strictSourceScope
    ? strictScopeType ?? undefined
    : canonicalRecurringScope(rawScopeType) ?? (tenancy ? "tenant" : stringValue(record, "unitId", "unitSourceId") ? "unit" : stringValue(record, "propertyId", "propertySourceId") ? "property" : undefined);
  const tenancyPersonSource = tenancy ? Array.from(personBySource.entries()).find(([, candidate]) => candidate.id === tenancy.primaryPersonId)?.[0] : undefined;
  const scopeSourceId = rawScopeId ?? (scopeType === "tenant" ? sourceLink(record, "tenantId", "personId", "tenantSourceId") ?? tenancyPersonSource : scopeType === "unit" ? sourceLink(record, "unitId", "unitSourceId") : sourceLink(record, "propertyId", "propertySourceId"));
  if (!scopeType || !scopeSourceId) {
    exception(exceptions, "recurring_schedule_scope_missing", "Recurring schedule has no resolvable EntityType/EntityKeyID scope", "recurring_schedule", record, undefined, "error");
    return undefined;
  }

  if (scopeType === "tenant") {
    const personSource = rawScopeId ?? sourceLink(record, "tenantId", "personId", "tenantSourceId");
    const person = personSource
      ? personBySource.get(personSource)
      : tenancy
        ? Array.from(personBySource.values()).find((candidate) => candidate.id === tenancy.primaryPersonId)
        : undefined;
    if (!person) { exception(exceptions, "recurring_schedule_tenant_missing", "Tenant recurring schedule has no exact tenant person", "recurring_schedule", record, undefined, "error"); return undefined; }
    if (tenancy && tenancy.primaryPersonId !== person.id) { exception(exceptions, "recurring_schedule_tenant_mismatch", "Recurring schedule tenant scope conflicts with its explicit tenancy", "recurring_schedule", record, undefined, "error"); return undefined; }
    const unitSource = sourceLink(record, "unitId", "unitSourceId");
    const propertySource = sourceLink(record, "propertyId", "propertySourceId");
    const unit = unitSource ? unitBySource.get(unitSource) : tenancy ? unitBySource.get(tenancy.source?.sourceId ?? "") : undefined;
    const property = propertySource ? propertyBySource.get(propertySource) : undefined;
    const resolvedUnit = tenancy ? Array.from(unitBySource.values()).find((candidate) => candidate.id === tenancy.unitId) : unit;
    const resolvedProperty = tenancy ? Array.from(propertyBySource.values()).find((candidate) => candidate.id === tenancy.propertyId) : property ?? (resolvedUnit ? Array.from(propertyBySource.values()).find((candidate) => candidate.id === resolvedUnit.propertyId) : undefined);
    if (unitSource && !unit) { exception(exceptions, "recurring_schedule_unit_missing", "Recurring schedule unit scope was not resolved", "recurring_schedule", record, undefined, "error"); return undefined; }
    if (propertySource && !property) { exception(exceptions, "recurring_schedule_property_missing", "Recurring schedule property was not resolved", "recurring_schedule", record, undefined, "error"); return undefined; }
    if (!resolvedProperty) { exception(exceptions, "recurring_schedule_property_missing", "Tenant recurring schedule has no exact property relationship", "recurring_schedule", record, undefined, "error"); return undefined; }
    return { scopeType, scopeId: person.id, tenancy, person, unit: resolvedUnit ?? unit, property: resolvedProperty };
  }
  if (scopeType === "unit") {
    const unitSource = rawScopeId ?? sourceLink(record, "unitId", "unitSourceId");
    const unit = unitSource ? unitBySource.get(unitSource) : undefined;
    if (!unit) { exception(exceptions, "recurring_schedule_unit_missing", "Unit recurring schedule has no exact unit relationship", "recurring_schedule", record, undefined, "error"); return undefined; }
    const property = Array.from(propertyBySource.values()).find((candidate) => candidate.id === unit.propertyId);
    if (!property) { exception(exceptions, "recurring_schedule_property_missing", "Unit recurring schedule property was not resolved", "recurring_schedule", record, undefined, "error"); return undefined; }
    if (tenancy && (tenancy.unitId !== unit.id || tenancy.propertyId !== property.id)) { exception(exceptions, "recurring_schedule_unit_mismatch", "Recurring schedule unit scope conflicts with its explicit tenancy", "recurring_schedule", record, undefined, "error"); return undefined; }
    return { scopeType, scopeId: unit.id, tenancy: undefined, unit, property };
  }
  const propertySource = rawScopeId ?? sourceLink(record, "propertyId", "propertySourceId");
  const property = propertySource ? propertyBySource.get(propertySource) : undefined;
  if (!property) { exception(exceptions, "recurring_schedule_property_missing", "Property recurring schedule has no exact property relationship", "recurring_schedule", record, undefined, "error"); return undefined; }
  if (tenancy && tenancy.propertyId !== property.id) { exception(exceptions, "recurring_schedule_property_mismatch", "Recurring schedule property scope conflicts with its explicit tenancy", "recurring_schedule", record, undefined, "error"); return undefined; }
  return { scopeType, scopeId: property.id, property };
}

export function mapRentManagerExport(input: RentManagerImportInput, options: {
  now?: Date;
  mode?: RentOpsImportRun["mode"];
  sourceManifestHash?: string;
  targetIdFactory?: RentOpsTargetIdFactory;
  /** Additive operational model. v2 preserves the historical quarantine behavior. */
  fidelityVersion?: 2 | 3;
  operationalVersion?: 2 | 3;
  preserveUnknowns?: boolean;
  targetIdentity?: RentManagerTargetIdentityOptions;
  hapStatusCrosswalk?: readonly RentManagerHapStatusCrosswalk[];
  financialSemanticCrosswalk?: RentManagerFinancialSemanticCrosswalk;
  artifactSha256?: string;
  artifactObservationOn?: IsoDate;
} = {}) : import("../../../shared/rent-ops-contracts").RentManagerImportResult {
  const fidelityVersion: 2 | 3 = options.fidelityVersion ?? options.operationalVersion ?? (options.preserveUnknowns ? 3 : 2);
  if (process.env.NODE_ENV === "production" && !options.targetIdFactory) throw new Error("target_id_factory_required");
  const configuredArtifactSha256 = options.artifactSha256 ?? (input as RentManagerImportInput & { artifactSha256?: string }).artifactSha256;
  const configuredCrosswalkValue = input.financialSemanticCrosswalk ?? options.financialSemanticCrosswalk;
  const financialCrosswalkSelection = selectFinancialSemanticCrosswalk(configuredCrosswalkValue, configuredArtifactSha256);
  const configuredFinancialCrosswalk = financialCrosswalkSelection.crosswalk;
  const financialCrosswalkValidation = configuredFinancialCrosswalk
    ? validateFinancialSemanticCrosswalkForArtifact(configuredFinancialCrosswalk, configuredArtifactSha256)
    : financialCrosswalkSelection;
  const context: MappingContext = {
    targetIdFactory: options.targetIdFactory ?? developmentTargetIdFactory,
    fidelityVersion,
    hapStatusCrosswalk: options.hapStatusCrosswalk ?? input.hapStatusCrosswalk ?? [],
    financialSemanticCrosswalk: configuredFinancialCrosswalk,
    financialSemanticCrosswalkValid: financialCrosswalkValidation?.valid === true,
    artifactSha256: configuredArtifactSha256,
    artifactObservationOn: options.artifactObservationOn ?? input.artifactObservationOn,
    applicationStatusCrosswalk: input.applicationHistoryStatusCrosswalk ?? [],
  };
  const importedAt = nowIsoTimestamp(options.now ?? new Date());
  const snapshot = emptyRentOpsSnapshot();
  snapshot.modelVersion = fidelityVersion;
  const sourceRecords: RentOpsSourceRecord[] = [];
  const exceptions: ImportMappingException[] = [];
  if (isV3(context) && !context.financialSemanticCrosswalkValid) {
    const issueCodes = financialCrosswalkValidation?.issueCodes ?? ["crosswalk_missing_or_invalid"];
    exception(exceptions, "financial_semantic_crosswalk_invalid", `Financial semantic crosswalk is invalid: ${issueCodes.join(",")}`, undefined, undefined, undefined, "error");
  }
  const propertyBySource = new Map<string, RentOpsProperty>();
  const unitBySource = new Map<string, RentOpsUnit>();
  const personBySource = new Map<string, RentOpsPerson>();
  const tenancyBySource = new Map<string, RentOpsTenancy>();
  const tenantContacts: Array<{ record: RawRecord; tenantSourceId: string; person: RentOpsPerson; primary: boolean }> = [];
  const seenSourceKeys = new Set<string>();
  const claimSource = (entityType: ImportEntityType, record: RawRecord): boolean => {
    if (!ensureSourceId(exceptions, record, entityType)) return false;
    const id = sourceId(record);
    const key = `${entityType}:${id}`;
    if (seenSourceKeys.has(key)) {
      exception(exceptions, "duplicate_source_id", `Duplicate ${entityType} source ID ${id} was quarantined to prevent an ID collision`, entityType, record, undefined, "error");
      return false;
    }
    if (targetId(context, entityType, id).length > 160) {
      exception(exceptions, "source_id_too_long", `${entityType} source ID ${id} cannot produce a target ID within 160 characters`, entityType, record, undefined, "error");
      return false;
    }
    seenSourceKeys.add(key);
    return true;
  };
  const addSource = (entityType: ImportEntityType, record: RawRecord, mappedId: string) => {
    pushSource(context, sourceRecords, entityType, record, mappedId, importedAt);
  };

  // ChargeType rows are opaque definitions, not semantic labels. Preserve
  // every source row, including rows with no display name or unknown amount
  // semantics; category/active are populated only by the approved exact
  // artifact crosswalk in v3.
  for (const definition of input.chargeTypes ?? []) {
    const definitionSourceId = String(definition.sourceId ?? "").trim();
    const definitionRecord = definition as unknown as RawRecord;
    if (!definitionSourceId) {
      exception(exceptions, "source_id_missing", "Charge definition has no source ID and was quarantined", "charge_definition", definitionRecord, undefined, "error");
      continue;
    }
    if (!claimSource("charge_definition", definitionRecord)) continue;
    const strictCategoryValue = strictFinancialValue(context, {
      sourceCollection: "chargeTypes",
      sourceField: "ChargeTypeID",
      semanticKind: "charge_category",
      rawValue: definitionSourceId,
    });
    const strictActiveValue = strictFinancialValue(context, {
      sourceCollection: "chargeTypes",
      sourceField: "IsActive",
      semanticKind: "charge_definition_active",
      rawValue: definition.active,
    });
    const categoryValues: readonly ChargeCategory[] = ["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"];
    const category = isV3(context)
      ? categoryValues.includes(strictCategoryValue as ChargeCategory) ? strictCategoryValue as ChargeCategory : null
      : definition.category;
    const active = isV3(context) ? strictBooleanFromCrosswalk(strictActiveValue) : definition.active ?? null;
    const mappedDefinition = {
      id: targetId(context, "charge_definition", definitionSourceId),
      recordRevision: 1,
      source: { system: SYSTEM, entityType: "charge_definition", sourceId: definitionSourceId },
      // A valid artifact-bound v3 import always carries the artifact digest.
      // Keep the field omitted for direct/native mapping calls that do not
      // provide an artifact; never turn that absence into a fabricated null.
      sourceArtifactSha256: isV3(context) ? context.artifactSha256 : definition.artifactSha256 ?? context.artifactSha256,
      artifactObservationOn: isV3(context) ? context.artifactObservationOn : context.artifactObservationOn,
      displayName: definition.displayName ?? definition.name ?? null,
      displayNameKnowledge: (definition.displayName ?? definition.name) ? ("source" as const) : ("unknown" as const),
      category,
      categoryKnowledge: isV3(context) ? category ? "source" : "unknown" : definition.categoryKnowledge ?? (category ? "source" : "unknown"),
      active,
      activeKnowledge: isV3(context) ? strictActiveValue ? "source" : "unknown" : definition.activeKnowledge ?? "unknown",
    };
    snapshot.chargeDefinitions.push(mappedDefinition);
    addSource("charge_definition", definitionRecord, mappedDefinition.id);
  }

  for (const raw of input.properties ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("property", record)) continue;
    const property = mapProperty(context, record, exceptions);
    if (!property) continue;
    snapshot.properties.push(property);
    propertyBySource.set(sourceId(record), property);
    addSource("property", record, property.id);
  }
  for (const raw of input.units ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("unit", record)) continue;
    const property = propertyBySource.get(sourceLink(record, "propertyId", "propertySourceId") ?? "");
    if (!property && !isV3(context)) { exception(exceptions, "unit_property_missing", "Unit cannot be mapped without a property", "unit", record, undefined, "error"); continue; }
    const unit = mapUnit(context, record, property?.id ?? null, exceptions);
    if (!unit) continue;
    snapshot.units.push(unit);
    unitBySource.set(sourceId(record), unit);
    addSource("unit", record, unit.id);
  }
  for (const raw of input.tenants ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("person", record)) continue;
    const person = mapPerson(context, record, exceptions);
    if (!person) continue;
    snapshot.people.push(person);
    personBySource.set(sourceId(record), person);
    addSource("person", record, person.id);
  }
  for (const raw of input.contacts ?? []) {
    const original = raw as RawRecord;
    const parentType = (stringValue(original, "parentType", "ParentType", "entityTypeName", "EntityType") ?? "").toLowerCase();
    if (!/tenant|customer/.test(parentType)) continue;
    const tenantSourceId = sourceLink(original, "tenantId", "TenantID", "parentId", "ParentID", "entityKeyId", "EntityKeyID");
    const primaryPerson = personBySource.get(tenantSourceId ?? "");
    if (!tenantSourceId || !primaryPerson) {
      exception(exceptions, "contact_tenant_missing", "Tenant contact cannot be linked without an imported tenant", "person", original, undefined, "warning");
      continue;
    }
    const rawContactId = sourceId(original);
    if (!rawContactId) {
      exception(exceptions, "source_id_missing", "Tenant contact has no source ID and was quarantined", "person", original, undefined, "error");
      continue;
    }
    const contactRecord = { ...original, sourceId: rawContactId.startsWith("contact:") ? rawContactId : `contact:${rawContactId}` } as RawRecord;
    if (!claimSource("person", contactRecord)) continue;
    const primary = boolValue(contactRecord, "isPrimary", "IsPrimary", "primary", "Primary");
    const person = primary ? primaryPerson : mapPerson(context, contactRecord, exceptions);
    if (!person) continue;
    if (!primary) snapshot.people.push(person);
    personBySource.set(sourceId(contactRecord), person);
    tenantContacts.push({ record: contactRecord, tenantSourceId, person, primary });
    addSource("person", contactRecord, person.id);
  }
  for (const raw of input.leases ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("tenancy", record)) continue;
    const tenancy = mapTenancy(context, record, propertyBySource, unitBySource, personBySource, exceptions, importedAt);
    if (!tenancy) { exception(exceptions, "lease_reference_missing", "Lease cannot be mapped without exact references", "tenancy", record, undefined, isV3(context) ? "warning" : "error"); continue; }
    snapshot.tenancies.push(tenancy);
    tenancyBySource.set(sourceId(record), tenancy);
    addSource("tenancy", record, tenancy.id);
  }
  for (const contact of tenantContacts) {
    const primaryPerson = personBySource.get(contact.tenantSourceId);
    if (!primaryPerson) continue;
    const explicitTenancySource = sourceLink(contact.record, "tenancyId", "leaseId", "TenancyID", "LeaseID");
    const explicitApplicationSource = sourceLink(contact.record, "applicationId", "ApplicationID", "ProspectApplicationID");
    const relatedTenancies = explicitTenancySource
      ? snapshot.tenancies.filter((tenancy) => tenancy.source?.sourceId === explicitTenancySource)
      : [];
    const relationship = stringValue(contact.record, "relationship", "Relationship", "contactTypeName", "ContactTypeName");
    const responsibilitySource = value(contact.record, "isFinanciallyResponsible", "financiallyResponsible", "IsFinanciallyResponsible");
    const isFinanciallyResponsible = responsibilitySource === undefined ? null : boolValue(contact.record, "isFinanciallyResponsible", "financiallyResponsible", "IsFinanciallyResponsible");
    const roleText = stringValue(contact.record, "role", "Role", "relationship", "Relationship", "contactTypeName", "ContactTypeName");
    // v2 retains the historical primary-contact role.  v3 does not treat the
    // RM IsPrimary flag as a semantic relationship, so an absent role remains
    // explicitly unknown there.
    const role = roleText
      ? (/co.?applicant/i.test(roleText) ? "co_applicant" : /occupant/i.test(roleText) ? "occupant" : /emergency/i.test(roleText) ? "emergency_contact" : /primary/i.test(roleText) ? "primary" : "other_contact")
      : (contact.primary && !isV3(context) ? "primary" : null);
    if (!role) exception(exceptions, "contact_role_unknown", "Tenant contact role was not returned and remains unknown", "person", contact.record, undefined, "warning");
    const roleKnowledge = role ? "source" : "unknown";
    const relationshipKnowledge = relationship ? "source" : "unknown";
    const responsibilityKnowledge = responsibilitySource === undefined ? "unknown" : "source";
    if (relatedTenancies.length === 0 && !explicitApplicationSource) {
      // A tenant-account contact is still an exact source relationship even
      // when RM did not return a tenancy/application link.  Keep it scoped to
      // the account person; never fan it out to historical tenancies.
      snapshot.householdMemberships.push({
        id: targetId(context, "household_membership", `account:${primaryPerson.id}\u0000${sourceId(contact.record)}`),
        accountPersonId: primaryPerson.id,
        personId: contact.person.id,
        role: role as RentOpsHouseholdMembership["role"],
        relationship,
        isFinanciallyResponsible: isFinanciallyResponsible as unknown as boolean,
        roleKnowledge,
        relationshipKnowledge,
        responsibilityKnowledge,
      });
      continue;
    }
    for (const tenancy of relatedTenancies) {
      const membership: RentOpsHouseholdMembership = {
        id: targetId(context, "household_membership", `${tenancy.id}\u0000${sourceId(contact.record)}`),
        tenancyId: tenancy.id,
        personId: contact.person.id,
        role: (role ?? (isV3(context) ? null : "other_contact")) as RentOpsHouseholdMembership["role"],
        relationship,
        isFinanciallyResponsible: (isFinanciallyResponsible ?? (isV3(context) ? null : false)) as unknown as boolean,
        roleKnowledge,
        relationshipKnowledge,
        responsibilityKnowledge,
      };
      snapshot.householdMemberships.push(membership);
    }
    if (explicitApplicationSource && relatedTenancies.length === 0) {
      snapshot.householdMemberships.push({
        id: targetId(context, "household_membership", `${targetId(context, "application", explicitApplicationSource)}\u0000${sourceId(contact.record)}`),
        applicationId: targetId(context, "application", explicitApplicationSource),
        personId: contact.person.id,
        role: (role ?? (isV3(context) ? null : "other_contact")) as RentOpsHouseholdMembership["role"],
        relationship,
        isFinanciallyResponsible: (isFinanciallyResponsible ?? (isV3(context) ? null : false)) as unknown as boolean,
        roleKnowledge,
        relationshipKnowledge,
        responsibilityKnowledge,
      });
    }
  }
  for (const raw of input.leaseTerms ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("lease_term", record)) continue;
    const term = mapLeaseTerm(context, record, tenancyBySource, exceptions, importedAt);
    if (!term) { exception(exceptions, "lease_term_reference_missing", "Lease term retained with an explicit unknown lease relationship", "lease_term", record, undefined, isV3(context) ? "warning" : "error"); continue; }
    snapshot.leaseTerms.push(term);
    addSource("lease_term", record, term.id);
  }
  for (const raw of input.recurringSchedules ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("recurring_schedule", record)) continue;
    const rawScopeType = stringValue(record, "scopeType", "EntityType", "EntityTypeName", "ScopeType");
    const strictScopeType = strictFinancialValue(context, {
      sourceCollection: "recurringSchedules",
      sourceField: "EntityType",
      semanticKind: "recurring_scope",
      rawValue: rawScopeType,
    }) as RentOpsRecurringChargeSchedule["scopeType"];
    const resolved = resolveRecurringScope(record, propertyBySource, unitBySource, personBySource, tenancyBySource, exceptions, isV3(context), strictScopeType);
    const amountCents = moneyField(record, "amountCents", "amount", "monthlyAmount");
    if (!resolved) {
      exception(exceptions, "recurring_schedule_unmapped", "Recurring schedule is retained as an exception because no exact EntityType/EntityKeyID scope was mapped", "recurring_schedule", record, amountCents.value, "warning");
      if (!isV3(context)) {
        addSource("recurring_schedule", record, `rm:exception:recurring_schedule:${sourceId(record)}`);
        continue;
      }
    }
    if (!amountCents.present || amountCents.invalid || amountCents.value === undefined || amountCents.value <= 0) {
      exception(exceptions, "recurring_schedule_fact_incomplete", "Recurring schedule was quarantined because a positive amount is required", "recurring_schedule", record, amountCents.value, "error");
      if (!isV3(context)) {
        addSource("recurring_schedule", record, `rm:exception:recurring_schedule:${sourceId(record)}`);
        continue;
      }
    }
    // Recurring schedules are temporal facts only when RM supplies their
    // FromDate/ToDate fields.  Create/lease/move-in dates are deliberately
    // excluded: filling a missing lower bound would invent an effective date.
    const effectiveFromRead = dateField(record, "effectiveFrom", "FromDate", "fromDate");
    const effectiveToRead = dateField(record, "effectiveTo", "ToDate", "toDate");
    if (effectiveFromRead.invalid) fieldException(exceptions, "invalid_date", "effectiveFrom", "recurring_schedule", record);
    if (effectiveToRead.invalid) fieldException(exceptions, "invalid_date", "effectiveTo", "recurring_schedule", record);
    const effectiveFrom = effectiveFromRead.value;
    if (effectiveFromRead.invalid || effectiveToRead.invalid) {
      addSource("recurring_schedule", record, `rm:exception:recurring_schedule:${sourceId(record)}`);
      if (!isV3(context)) continue;
    }
    if (effectiveToRead.value && effectiveFrom && effectiveToRead.value < effectiveFrom) {
      exception(exceptions, "date_order_invalid", "Recurring schedule effectiveTo cannot precede effectiveFrom", "recurring_schedule", record, amountCents.value, "error");
      addSource("recurring_schedule", record, `rm:exception:recurring_schedule:${sourceId(record)}`);
      continue;
    }
    const strictCategory = strictChargeCategory(context, record);
    const category = isV3(context) ? strictCategory.value : classifyCharge(record, input.chargeTypes);
    if (category === "security_deposit" || category === "refundable_pet_deposit" || category === "move_in_funds") {
      exception(exceptions, "recurring_deposit_schedule", "Deposit-like recurring row was not treated as rent income", "recurring_schedule", record, amountCents.value, "warning");
    }
    const confidenceText = stringValue(record, "sourceConfidence");
    const sourceConfidence: RentOpsRecurringChargeSchedule["sourceConfidence"] = confidenceText === "inferred" || confidenceText === "exception" || confidenceText === "confirmed" ? confidenceText : undefined;
    if (isV3(context) && !sourceConfidence) exception(exceptions, "recurring_schedule_confidence_unknown", "Recurring schedule source confidence was not returned and remains unknown", "recurring_schedule", record, amountCents.value, "warning");
    if (sourceConfidence && sourceConfidence !== "confirmed") {
      exception(exceptions, "recurring_schedule_source_inferred", "Recurring schedule relationship or effective date is not source-confirmed and requires verification", "recurring_schedule", record, amountCents.value, "error");
    }
    const definition = chargeDefinition(context, record, category, input.chargeTypes ?? []);
    if (isV3(context) && definition.knowledge === "unknown") {
      exception(exceptions, "recurring_charge_definition_unknown", "Recurring charge definition was not returned by RM; schedule identity is retained but semantic grouping remains unknown", "recurring_schedule", record, amountCents.value, "warning");
    }
    const property = resolved?.property;
    if (!property && !isV3(context)) {
      exception(exceptions, "recurring_schedule_property_missing", "Recurring schedule has no exact property relationship", "recurring_schedule", record, amountCents.value, "error");
      addSource("recurring_schedule", record, `rm:exception:recurring_schedule:${sourceId(record)}`);
      continue;
    }
    const schedule: RentOpsRecurringChargeSchedule = {
      id: targetId(context, "recurring_schedule", sourceId(record)),
      source: { system: SYSTEM, entityType: "recurring_schedule", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      // EntityKeyID is a Rent Manager source-domain key, not a target ID.  A
      // recognized scope label without an exact target relationship therefore
      // remains wholly unknown in the operational model; the raw key lives
      // only in the restricted source archive.
      scopeType: resolved?.scopeType ?? (isV3(context) ? null : strictScopeType ?? null),
      scopeId: resolved?.scopeId ?? (isV3(context) ? null : stringValue(record, "scopeId", "EntityKeyID", "EntityKeyId") ?? null),
      scopeTypeKnowledge: resolved?.scopeType ? "source" : "unknown",
      scopeLinkKnowledge: resolved?.scopeId ? "exact" : "unknown",
      chargeDefinitionId: definition.id ?? null,
      chargeDefinitionKey: definition.key ?? null,
      chargeDefinitionKnowledge: definition.knowledge,
      chargeDefinitionLinkKnowledge: definition.id ? "exact" : "unknown",
      tenancyId: resolved?.tenancy?.id ?? (isV3(context) ? null : undefined),
      personId: resolved?.person?.id ?? (isV3(context) ? null : undefined),
      propertyId: property?.id ?? null,
      unitId: resolved?.unit?.id ?? (isV3(context) ? null : undefined),
      category,
      categoryKnowledge: isV3(context) ? strictCategory.knowledge : "source",
      description: isV3(context) ? stringValue(record, "description", "name", "chargeTypeName") ?? null : requiredString(record, "Imported recurring charge", "description", "name", "chargeTypeName"),
      descriptionKnowledge: stringValue(record, "description", "name", "chargeTypeName") ? "source" : "unknown",
      amountCents: amountCents.value ?? null,
      amountKnowledge: amountCents.value === undefined ? "unknown" : "known",
      effectiveFrom,
      effectiveFromKnowledge: effectiveFrom ? "source" : "unknown_open_start",
      effectiveTo: effectiveToRead.value,
      active: isV3(context) ? null : !boolValue(record, "inactive", "isInactive"),
      activeKnowledge: isV3(context) ? "unknown" : value(record, "active", "isActive", "inactive", "isInactive") === undefined ? "unknown" : "source",
      sourceConfidence,
      lineageRootId: targetId(context, "recurring_schedule", sourceId(record)),
      lineageRootOrigin: isV3(context) ? "artifact" : context.artifactSha256 ? "artifact" : "manual",
      versionOrigin: isV3(context) ? "artifact" : context.artifactSha256 ? "artifact" : "manual",
      versionAction: "root",
      recordRevision: 1,
      sourceArtifactSha256: isV3(context) ? context.artifactSha256 ?? null : context.artifactSha256,
      artifactObservationOn: isV3(context) ? context.artifactObservationOn : context.artifactObservationOn,
    };
    snapshot.recurringSchedules.push(schedule);
    addSource("recurring_schedule", record, schedule.id);
  }
  const mapLedger = (raw: RawRecord, kind: RentOpsLedgerTransaction["kind"]): RentOpsLedgerTransaction | undefined => {
    if (isV3(context)) {
      const property = propertyBySource.get(sourceLink(raw, "propertyId", "propertySourceId") ?? "");
      const unit = unitBySource.get(sourceLink(raw, "unitId", "unitSourceId") ?? "");
      // A tenant/person ID is not a tenancy relationship.  Only the direct
      // LeaseID/tenancyId fields may populate tenancyId in v3.
      const tenancy = tenancyBySource.get(sourceLink(raw, "tenancyId", "leaseId") ?? "");
      const person = personBySource.get(sourceLink(raw, "tenantId", "personId", "tenantSourceId") ?? "");
      if (!property) exception(exceptions, "ledger_property_unknown", "Ledger transaction has no exact property link; retained as unknown", "ledger_transaction", raw, undefined, "warning");
      const amountRead = moneyField(raw, "amountCents", "amount");
      if (!amountRead.present) exception(exceptions, "ledger_amount_unknown", "Ledger transaction amount was not returned as a reportable value", "ledger_transaction", raw, undefined, "warning");
      else if (amountRead.invalid) exception(exceptions, "ledger_amount_invalid", "Ledger transaction amount was not a reportable monetary value", "ledger_transaction", raw, undefined, "warning");
      const postedRead = dateField(raw, "postedOn", "date", "transactionDate");
      if (postedRead.invalid) exception(exceptions, "invalid_date", "postedOn", "ledger_transaction", raw, undefined, "warning");
      const dueRead = dateField(raw, "dueOn", "dueDate");
      if (dueRead.invalid) exception(exceptions, "invalid_date", "dueOn", "ledger_transaction", raw, undefined, "warning");
      const updatedAt = optionalTimestamp(raw, ["updatedAt", "updated_at", "UpdateDate", "UpdatedDate", "ModifiedDate"], exceptions, "ledger_transaction", "updatedAt");
      const strictCategory = strictChargeCategory(context, raw);
      const category = isV3(context) ? strictCategory.value : classifyCharge(raw, input.chargeTypes);
      const payerEvidence = isV3(context) ? undefined : directPayer(raw);
      const payer = isV3(context)
        ? null
        : kind === "payment" ? payerEvidence === "tenant" || payerEvidence === "agency" ? payerEvidence : "unknown" : payerEvidence;
      if (!isV3(context) && kind === "payment" && payer === "unknown") exception(exceptions, looksLikeHapPayment(raw) ? "hap_payer_unknown" : "payment_payer_unknown", "Payment payer evidence is unknown and remains excluded from payer-specific reconciliation", "ledger_transaction", raw, amountRead.value, "warning");
      const rawKind = stringValue(raw, "kind", "transactionKind", "transactionType", "type")?.toLowerCase();
      const reversalOfSource = stringValue(raw, "reversalOfId", "reversalId", "reversesTransactionId");
      const explicitReversalKind = !isV3(context) && Boolean(rawKind && /^(reversal|reversal_transaction|reversed_transaction)$/.test(rawKind));
      const isReversal = Boolean(reversalOfSource) || explicitReversalKind;
      const mappedKind: RentOpsLedgerTransaction["kind"] = isReversal ? "reversal" : kind;
      const statusSource = stringValue(raw, "status", "transactionStatus");
      const status = isV3(context) ? null : ledgerStatusFromEvidence(raw);
      if (!isV3(context) && statusSource && !status) exception(exceptions, "ledger_status_unknown", "Ledger status was not a recognized explicit RM value; retained as explicit unknown", "ledger_transaction", raw, amountRead.value, "warning");
      if (explicitReversalKind && !reversalOfSource) exception(exceptions, "ledger_reversal_link_unknown", "Ledger reversal kind was explicit but its parent transaction link was not returned", "ledger_transaction", raw, amountRead.value, "warning");
      const description = stringValue(raw, "description", "memo", "name");
      if (!description) exception(exceptions, "ledger_description_unknown", "Ledger description was not returned and remains unknown", "ledger_transaction", raw, amountRead.value, "warning");
      const paymentMethodSource = stringValue(raw, "paymentMethod", "PaymentMethod", "PaymentMethodName", "PaymentType", "PaymentTypeName");
      const paymentMethod = isV3(context) ? null : paymentMethodFromEvidence(paymentMethodSource);
      if (!isV3(context) && paymentMethodSource && !paymentMethod) exception(exceptions, "ledger_payment_method_unknown", "Ledger payment method was not a recognized explicit RM value; retained as unknown", "ledger_transaction", raw, amountRead.value, "warning");
      const chargeTypeId = sourceChargeTypeId(raw);
      const knownChargeDefinition = Boolean(chargeTypeId && (input.chargeTypes ?? []).some((definition) => definition.sourceId === chargeTypeId));
      const chargeDefinitionId = !isV3(context) || kind === "payment"
        ? undefined
        : knownChargeDefinition && chargeTypeId ? targetId(context, "charge_definition", chargeTypeId) : null;
      const mapped = {
        id: targetId(context, "ledger_transaction", sourceId(raw)),
        source: { system: SYSTEM, entityType: "ledger_transaction", sourceId: sourceId(raw), sourceUpdatedAt: updatedAt },
        propertyId: property?.id ?? null,
        unitId: unit?.id ?? null,
        tenancyId: tenancy?.id ?? null,
        personId: person?.id ?? null,
        kind: mappedKind,
        category: isV3(context) ? mappedKind === "payment" ? null : category : mappedKind === "payment" ? "other" : category,
        categoryKnowledge: isV3(context) ? mappedKind === "payment" ? "unknown" : strictCategory.knowledge : "source",
        status,
        amountCents: amountRead.value ?? null,
        postedOn: postedRead.value ?? null,
        dueOn: dueRead.value ?? null,
        paymentMethod,
        paymentMethodKnowledge: isV3(context) ? "unknown" : paymentMethod ? "source" : "unknown",
        description: description ?? null,
        reversalOfId: reversalOfSource ? targetId(context, "ledger_transaction", reversalOfSource) : null,
        payer,
        payerKnowledge: isV3(context) ? "unknown" : payerEvidence ? "source" : "unknown",
        propertyLinkKnowledge: property ? "exact" : "unknown",
        unitLinkKnowledge: unit ? "exact" : "unknown",
        tenancyLinkKnowledge: tenancy ? "exact" : "unknown",
        personLinkKnowledge: person ? "exact" : "unknown",
        amountKnowledge: amountRead.value === undefined ? "unknown" : "known",
        postedOnKnowledge: postedRead.value ? "source" : "unknown",
        dueOnKnowledge: dueRead.value ? "source" : "unknown",
        descriptionKnowledge: description ? "source" : "unknown",
        statusKnowledge: isV3(context) ? "unknown" : status ? "source" : "unknown",
        allocationMode: isV3(context) ? null : undefined,
        chargeDefinitionId,
        chargeDefinitionLinkKnowledge: isV3(context) ? chargeDefinitionId ? "exact" : "unknown" : undefined,
        sourceArtifactSha256: isV3(context) ? context.artifactSha256 ?? null : context.artifactSha256,
        artifactObservationOn: isV3(context) ? context.artifactObservationOn ?? null : context.artifactObservationOn,
      };
      return mapped as unknown as RentOpsLedgerTransaction;
    }
    const property = propertyBySource.get(sourceLink(raw, "propertyId", "propertySourceId") ?? "");
    const unit = unitBySource.get(sourceLink(raw, "unitId", "unitSourceId") ?? "");
    const tenancy = tenancyBySource.get(sourceLink(raw, "tenancyId", "leaseId", "TenancyID", "LeaseID") ?? "");
    const person = personBySource.get(sourceLink(raw, "tenantId", "personId", "tenantSourceId") ?? "");
    if (!property) { exception(exceptions, "ledger_property_missing", "Ledger transaction cannot be mapped without a property", "ledger_transaction", raw, centsValue(raw, "amountCents", "amount"), "error"); return undefined; }
    const amountCents = requiredMoney(raw, ["amountCents", "amount"], exceptions, "ledger_transaction", "amount", true);
    const postedOn = requiredDate(raw, ["postedOn", "date", "transactionDate"], exceptions, "ledger_transaction", "postedOn");
    const dueOnRead = dateField(raw, "dueOn", "dueDate");
    if (dueOnRead.invalid) fieldException(exceptions, "invalid_date", "dueOn", "ledger_transaction", raw);
    if (amountCents === undefined || !postedOn || (dueOnRead.present && !dueOnRead.value)) {
      exception(exceptions, "ledger_fact_incomplete", "Ledger transaction was quarantined because amount and posted date are required", "ledger_transaction", raw, amountCents, "error");
      return undefined;
    }
    const updatedAt = optionalTimestamp(raw, ["updatedAt", "updated_at"], exceptions, "ledger_transaction", "updatedAt");
    const category = classifyCharge(raw, input.chargeTypes);
    const payerEvidence = directPayer(raw);
    const payer = kind === "payment"
      ? payerEvidence === "tenant" || payerEvidence === "agency" ? payerEvidence : "unknown"
      : payerEvidence;
    if (kind === "payment" && payer === "unknown") {
      exception(
        exceptions,
        looksLikeHapPayment(raw) ? "hap_payer_unknown" : "payment_payer_unknown",
        looksLikeHapPayment(raw)
          ? "HAP-like payment has no direct tenant or agency payer evidence and cannot be used for HAP reconciliation"
          : "Payment has no direct tenant or agency payer evidence; payer was retained as unknown",
        "ledger_transaction",
        raw,
        amountCents,
        looksLikeHapPayment(raw) ? "error" : "warning",
      );
    }
    return {
      id: targetId(context, "ledger_transaction", sourceId(raw)),
      source: { system: SYSTEM, entityType: "ledger_transaction", sourceId: sourceId(raw), sourceUpdatedAt: updatedAt },
      propertyId: property.id,
      unitId: unit?.id,
      tenancyId: tenancy?.id,
      personId: person?.id,
      kind,
      category: kind === "payment" ? "other" : category,
      status: boolValue(raw, "voided", "isVoided") ? "voided" : "posted",
      amountCents,
      postedOn,
      dueOn: dueOnRead.value,
      paymentMethod: paymentMethodFromEvidence(stringValue(raw, "paymentMethod", "PaymentMethod", "PaymentMethodName", "PaymentType", "PaymentTypeName")),
      description: requiredString(raw, kind === "payment" ? "Imported payment" : kind === "credit" ? "Imported credit" : "Imported charge", "description", "memo", "name"),
      payer,
    };
  };
  for (const raw of input.charges ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("ledger_transaction", record)) continue;
    const transaction = mapLedger(record, "charge");
    if (transaction) { snapshot.ledgerTransactions.push(transaction); addSource("ledger_transaction", record, transaction.id); }
  }
  for (const raw of input.payments ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("ledger_transaction", record)) continue;
    const transaction = mapLedger(record, "payment");
    if (transaction) { snapshot.ledgerTransactions.push(transaction); addSource("ledger_transaction", record, transaction.id); }
  }
  for (const raw of input.credits ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("ledger_transaction", record)) continue;
    const transaction = mapLedger(record, "credit");
    if (transaction) { snapshot.ledgerTransactions.push(transaction); addSource("ledger_transaction", record, transaction.id); }
  }
  const transactionBySource = new Map(snapshot.ledgerTransactions.map((transaction) => [transaction.source?.sourceId, transaction]));
  for (const raw of input.allocations ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("payment_allocation", record)) continue;
    const payment = transactionBySource.get(sourceLink(record, "paymentId", "paymentSourceId"));
    const charge = transactionBySource.get(sourceLink(record, "chargeId", "chargeSourceId"));
    if (isV3(context)) {
      const amountRead = moneyField(record, "amountCents", "amount");
      const allocatedRead = dateField(record, "allocatedOn", "date");
      if (!amountRead.present) exception(exceptions, "allocation_amount_unknown", "Allocation amount was not returned as a reportable value", "payment_allocation", record, undefined, "warning");
      else if (amountRead.invalid) exception(exceptions, "allocation_amount_invalid", "Allocation amount was not a reportable monetary value", "payment_allocation", record, undefined, "warning");
      if (allocatedRead.invalid) exception(exceptions, "invalid_date", "allocatedOn", "payment_allocation", record, undefined, "warning");
      if (!payment || !charge) exception(exceptions, "allocation_reference_unknown", "Allocation payment or charge link is unknown; the raw allocation is retained", "payment_allocation", record, amountRead.value, "warning");
      if (allocatedRead.value && payment?.postedOn && charge?.postedOn && (allocatedRead.value < payment.postedOn || allocatedRead.value < charge.postedOn)) {
        exception(exceptions, "allocation_date_before_fact", "Allocation date precedes a linked payment or charge and is excluded from date-specific reporting", "payment_allocation", record, amountRead.value, "warning");
      }
      const paymentAmount = payment && typeof payment.amountCents === "number" ? payment.amountCents : undefined;
      const chargeAmount = charge && typeof charge.amountCents === "number" ? charge.amountCents : undefined;
      if (amountRead.value !== undefined && ((paymentAmount !== undefined && amountRead.value > paymentAmount) || (chargeAmount !== undefined && amountRead.value > chargeAmount))) {
        exception(exceptions, "allocation_exceeds_fact", "Allocation amount exceeds a linked known parent amount", "payment_allocation", record, amountRead.value, "error");
      }
      const allocation: RentOpsPaymentAllocation = {
        id: targetId(context, "payment_allocation", sourceId(record)),
        source: { system: SYSTEM, entityType: "payment_allocation", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
        paymentTransactionId: payment?.id ?? null,
        chargeTransactionId: charge?.id ?? null,
        amountCents: amountRead.value ?? null,
        allocatedOn: allocatedRead.value ?? null,
        paymentLinkKnowledge: payment ? "exact" : "unknown",
        chargeLinkKnowledge: charge ? "exact" : "unknown",
        amountKnowledge: amountRead.value === undefined ? "unknown" : "known",
        allocatedOnKnowledge: allocatedRead.value ? "source" : "unknown",
      };
      snapshot.paymentAllocations.push(allocation);
      addSource("payment_allocation", record, allocation.id);
      continue;
    }
    const amountCents = requiredMoney(record, ["amountCents", "amount"], exceptions, "payment_allocation", "amount", true);
    const allocatedOn = requiredDate(record, ["allocatedOn", "date"], exceptions, "payment_allocation", "allocatedOn");
    if (!payment || !charge) { exception(exceptions, "allocation_reference_missing", "Allocation cannot be mapped without payment and charge references", "payment_allocation", record, amountCents, "error"); continue; }
    if (amountCents === undefined || !allocatedOn) {
      exception(exceptions, "allocation_fact_incomplete", "Allocation was quarantined because a positive amount and allocated date are required", "payment_allocation", record, amountCents, "error");
      continue;
    }
    const paymentPostedOn = payment.postedOn;
    const chargePostedOn = charge.postedOn;
    const paymentAmountCents = payment.amountCents;
    const chargeAmountCents = charge.amountCents;
    if (!paymentPostedOn || !chargePostedOn || typeof paymentAmountCents !== "number" || typeof chargeAmountCents !== "number") {
      exception(exceptions, "allocation_fact_incomplete", "Allocation cannot be checked because a linked payment or charge fact is unknown", "payment_allocation", record, amountCents, "error");
      continue;
    }
    if (allocatedOn < paymentPostedOn || allocatedOn < chargePostedOn) {
      exception(exceptions, "allocation_date_before_fact", "Allocation date cannot precede its payment or charge date", "payment_allocation", record, amountCents, "error");
      continue;
    }
    if (amountCents > paymentAmountCents || amountCents > chargeAmountCents) {
      exception(exceptions, "allocation_exceeds_fact", "Allocation amount cannot exceed its payment or charge amount", "payment_allocation", record, amountCents, "error");
      continue;
    }
    const allocation: RentOpsPaymentAllocation = { id: targetId(context, "payment_allocation", sourceId(record)), source: { system: SYSTEM, entityType: "payment_allocation", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) }, paymentTransactionId: payment.id, chargeTransactionId: charge.id, amountCents, allocatedOn };
    snapshot.paymentAllocations.push(allocation);
    addSource("payment_allocation", record, allocation.id);
  }
  if (isV3(context)) {
    const allocationsByPayment = new Map<string, RentOpsPaymentAllocation[]>();
    for (const allocation of snapshot.paymentAllocations) {
      if (!allocation.paymentTransactionId) continue;
      const rows = allocationsByPayment.get(allocation.paymentTransactionId) ?? [];
      rows.push(allocation);
      allocationsByPayment.set(allocation.paymentTransactionId, rows);
    }
    for (const transaction of snapshot.ledgerTransactions) {
      if (transaction.kind !== "payment") continue;
      const allocations = allocationsByPayment.get(transaction.id) ?? [];
      const properties = new Set(allocations
        .map((allocation) => snapshot.ledgerTransactions.find((candidate) => candidate.id === allocation.chargeTransactionId)?.propertyId)
        .filter((propertyId): propertyId is string => Boolean(propertyId)));
      transaction.allocationMode = allocations.length === 0 || allocations.some((allocation) => allocation.chargeLinkKnowledge !== "exact") || properties.size === 0
        ? "unknown"
        : properties.size === 1 ? "allocation_single" : "multi_property";
    }
  }
  const subsidyBySource = new Map<string, RentOpsSubsidyContract>();
  const mapHapChildren = () => {
  const paymentBySource = new Map<string, RentOpsLedgerTransaction>();
  for (const transaction of snapshot.ledgerTransactions.filter((candidate) => candidate.kind === "payment")) {
    for (const key of sourceKeyVariants(transaction.source?.sourceId)) paymentBySource.set(key, transaction);
  }
  const exactChildLink = <T extends { id: string }>(
    record: RawRecord,
    map: ReadonlyMap<string, T>,
    keys: string[],
  ): { source?: string; target?: T; knowledge: "exact" | "unknown" } => {
    const source = sourceLink(record, ...keys);
    const target = sourceMapGet(map, source);
    return { source, target, knowledge: source && target ? "exact" : "unknown" };
  };
  const propertyById = new Map(snapshot.properties.map((row) => [row.id, row]));
  const unitById = new Map(snapshot.units.map((row) => [row.id, row]));
  const tenancyById = new Map(snapshot.tenancies.map((row) => [row.id, row]));
  const personById = new Map(snapshot.people.map((row) => [row.id, row]));
  const childScope = (record: RawRecord, contract: RentOpsSubsidyContract | undefined) => {
    const directTenancy = exactChildLink(record, tenancyBySource, ["tenancyId", "leaseId", "TenancyID", "LeaseID"]);
    const directProperty = exactChildLink(record, propertyBySource, ["propertyId", "PropertyID"]);
    const directUnit = exactChildLink(record, unitBySource, ["unitId", "UnitID"]);
    const tenancy = directTenancy.source ? directTenancy.target : contract ? tenancyById.get(contract.tenancyId) : undefined;
    const property = directProperty.source ? directProperty.target : contract ? propertyById.get(contract.propertyId) : undefined;
    const unit = directUnit.source ? directUnit.target : contract ? unitById.get(contract.unitId) : undefined;
    if (directTenancy.source && !directTenancy.target) exception(exceptions, "subsidy_child_tenancy_unknown", "Subsidy child tenancy link was returned but did not match an exact imported tenancy", "subsidy_tenant", record, undefined, "warning");
    if (directProperty.source && !directProperty.target) exception(exceptions, "subsidy_child_property_unknown", "Subsidy child property link was returned but did not match an exact imported property", "subsidy_tenant", record, undefined, "warning");
    if (directUnit.source && !directUnit.target) exception(exceptions, "subsidy_child_unit_unknown", "Subsidy child unit link was returned but did not match an exact imported unit", "subsidy_tenant", record, undefined, "warning");
    return {
      tenancy,
      property,
      unit,
      tenancyLinkKnowledge: directTenancy.source ? directTenancy.knowledge : tenancy ? "exact" : "unknown",
      propertyLinkKnowledge: directProperty.source ? directProperty.knowledge : property ? "exact" : "unknown",
      unitLinkKnowledge: directUnit.source ? directUnit.knowledge : unit ? "exact" : "unknown",
    } as const;
  };
  const subsidyTenantBySource = new Map<string, RentOpsSubsidyTenant>();
  for (const raw of input.subsidyTenants ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("subsidy_tenant", record)) continue;
    const contractSource = sourceLink(record, "subsidyContractSourceId", "subsidyId", "SubsidyID", "SubsidyContractID", "SubsidyContractId");
    const contract = sourceMapGet(subsidyBySource, contractSource);
    if (!contract) exception(exceptions, "subsidy_child_contract_unknown", "SubsidyTenant row has no exact SubsidyID contract link; retained with an unknown link", "subsidy_tenant", record, undefined, "warning");
    const personLink = exactChildLink(record, personBySource, ["personId", "PersonID", "tenantId", "TenantID", "AccountID"]);
    const scope = childScope(record, contract);
    const effectiveFromRead = dateField(record, "effectiveFrom", "EffectiveFrom", "startDate", "StartDate", "beginDate", "BeginDate");
    const effectiveToRead = dateField(record, "effectiveTo", "EffectiveTo", "endDate", "EndDate", "expireDate", "ExpireDate");
    if (effectiveFromRead.invalid) fieldException(exceptions, "invalid_date", "effectiveFrom", "subsidy_tenant", record, "warning");
    if (effectiveToRead.invalid) fieldException(exceptions, "invalid_date", "effectiveTo", "subsidy_tenant", record, "warning");
    if (effectiveFromRead.value && effectiveToRead.value && effectiveToRead.value < effectiveFromRead.value) exception(exceptions, "date_order_invalid", "SubsidyTenant effectiveTo cannot precede effectiveFrom", "subsidy_tenant", record, undefined, "warning");
    const amountRead = moneyField(record, "amountCents", "amount", "TenantAmount", "TenantAmountCents");
    if (amountRead.invalid) fieldException(exceptions, "amount_invalid", "amountCents", "subsidy_tenant", record, "warning");
    // HAP child payer fields have no approved artifact-bound semantic
    // crosswalk yet. In v3, prose and boolean flags remain unknown rather
    // than becoming source-confirmed payer facts; legacy retains its direct
    // field behavior.
    const payerEvidence = isV3(context) ? undefined : directPayer(record);
    const statusResult = exactHapStatus(context, record, "contract", "SubsidyTenants");
    if (hapStatusField(record).value !== undefined && !statusResult.value) exception(exceptions, "subsidy_tenant_status_unknown", "SubsidyTenant status remains unknown without its exact artifact-bound crosswalk", "subsidy_tenant", record, amountRead.value, "warning");
    const tenant: RentOpsSubsidyTenant = {
      id: targetId(context, "subsidy_tenant", sourceId(record)),
      source: { system: SYSTEM, entityType: "subsidy_tenant", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      subsidyContractId: contract?.id,
      subsidyContractLinkKnowledge: contract ? "exact" : "unknown",
      tenancyId: scope.tenancy?.id,
      tenancyLinkKnowledge: scope.tenancyLinkKnowledge,
      personId: personLink.target?.id,
      personLinkKnowledge: personLink.knowledge,
      propertyId: scope.property?.id,
      propertyLinkKnowledge: scope.propertyLinkKnowledge,
      unitId: scope.unit?.id,
      unitLinkKnowledge: scope.unitLinkKnowledge,
      effectiveFrom: effectiveFromRead.value,
      effectiveFromKnowledge: effectiveFromRead.value ? "source" : "unknown",
      effectiveTo: effectiveToRead.value,
      effectiveToKnowledge: effectiveToRead.value ? "source" : "unknown",
      amountCents: amountRead.value,
      amountKnowledge: amountRead.value === undefined ? "unknown" : "known",
      payer: payerEvidence ?? (isV3(context) ? "unknown" : undefined),
      payerKnowledge: payerEvidence ? "source" : "unknown",
      status: statusResult.value as HapContractStatus | undefined,
      statusKnowledge: statusResult.knowledge,
    };
    snapshot.subsidyTenants.push(tenant);
    subsidyTenantBySource.set(sourceId(record), tenant);
    for (const key of sourceKeyVariants(sourceId(record))) subsidyTenantBySource.set(key, tenant);
    addSource("subsidy_tenant", record, tenant.id);
  }
  for (const raw of input.subsidyPayments ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("subsidy_payment", record)) continue;
    const contractSource = sourceLink(record, "subsidyContractSourceId", "subsidyId", "SubsidyID", "SubsidyContractID", "SubsidyContractId");
    const contract = sourceMapGet(subsidyBySource, contractSource);
    if (!contract) exception(exceptions, "subsidy_child_contract_unknown", "SubsidyPayment row has no exact SubsidyID contract link; retained with an unknown link", "subsidy_payment", record, undefined, "warning");
    const tenantSource = sourceLink(record, "subsidyTenantSourceId", "SubsidyTenantID", "SubsidyTenantId");
    const subsidyTenant = sourceMapGet(subsidyTenantBySource, tenantSource);
    if (tenantSource && !subsidyTenant) exception(exceptions, "subsidy_payment_tenant_unknown", "SubsidyPayment tenant link did not match an exact SubsidyTenant row", "subsidy_payment", record, undefined, "warning");
    const directTenancy = exactChildLink(record, tenancyBySource, ["tenancyId", "leaseId", "TenancyID", "LeaseID"]);
    const directProperty = exactChildLink(record, propertyBySource, ["propertyId", "PropertyID"]);
    const directUnit = exactChildLink(record, unitBySource, ["unitId", "UnitID"]);
    const tenancy = directTenancy.source ? directTenancy.target : contract ? tenancyById.get(contract.tenancyId) : subsidyTenant?.tenancyId ? tenancyById.get(subsidyTenant.tenancyId) : undefined;
    const property = directProperty.source ? directProperty.target : contract ? propertyById.get(contract.propertyId) : subsidyTenant?.propertyId ? propertyById.get(subsidyTenant.propertyId) : undefined;
    const unit = directUnit.source ? directUnit.target : contract ? unitById.get(contract.unitId) : subsidyTenant?.unitId ? unitById.get(subsidyTenant.unitId) : undefined;
    const personLink = exactChildLink(record, personBySource, ["personId", "PersonID", "tenantId", "TenantID", "AccountID"]);
    const paymentSource = sourceLink(record, "paymentSourceId", "paymentId", "PaymentID", "PaymentId", "PaymentTransactionID", "PaymentTransactionId");
    const payment = sourceMapGet(paymentBySource, paymentSource);
    if (paymentSource && !payment) exception(exceptions, "subsidy_payment_ledger_link_unknown", "SubsidyPayment PaymentID did not match an exact generic ledger payment; description text is not a link", "subsidy_payment", record, undefined, "warning");
    const paymentOnRead = dateField(record, "paymentOn", "PaymentOn", "paymentDate", "PaymentDate", "paidOn", "PaidOn", "transactionDate", "TransactionDate", "date", "Date");
    if (paymentOnRead.invalid) fieldException(exceptions, "invalid_date", "paymentOn", "subsidy_payment", record, "warning");
    const amountRead = moneyField(record, "amountCents", "amount", "PaymentAmount", "PaymentAmountCents");
    if (amountRead.invalid) fieldException(exceptions, "amount_invalid", "amountCents", "subsidy_payment", record, "warning");
    // HAP child payer fields have no approved artifact-bound semantic
    // crosswalk yet. In v3, prose and boolean flags remain unknown rather
    // than becoming source-confirmed payer facts; legacy retains its direct
    // field behavior.
    const payerEvidence = isV3(context) ? undefined : directPayer(record);
    const statusResult = exactHapStatus(context, record, "payment", "SubsidyPayments");
    if (hapStatusField(record).value !== undefined && !statusResult.value) exception(exceptions, "subsidy_payment_status_unknown", "SubsidyPayment status remains unknown without its exact artifact-bound crosswalk", "subsidy_payment", record, amountRead.value, "warning");
    const subsidyPayment: RentOpsSubsidyPayment = {
      id: targetId(context, "subsidy_payment", sourceId(record)),
      source: { system: SYSTEM, entityType: "subsidy_payment", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      subsidyContractId: contract?.id,
      subsidyContractLinkKnowledge: contract ? "exact" : "unknown",
      subsidyTenantId: subsidyTenant?.id,
      subsidyTenantLinkKnowledge: tenantSource && subsidyTenant ? "exact" : "unknown",
      tenancyId: tenancy?.id,
      tenancyLinkKnowledge: directTenancy.source ? directTenancy.knowledge : tenancy ? "exact" : "unknown",
      personId: personLink.target?.id,
      personLinkKnowledge: personLink.knowledge,
      propertyId: property?.id,
      propertyLinkKnowledge: directProperty.source ? directProperty.knowledge : property ? "exact" : "unknown",
      unitId: unit?.id,
      unitLinkKnowledge: directUnit.source ? directUnit.knowledge : unit ? "exact" : "unknown",
      paymentTransactionId: payment?.id,
      paymentLinkKnowledge: paymentSource && payment ? "exact" : "unknown",
      paymentOn: paymentOnRead.value,
      paymentOnKnowledge: paymentOnRead.value ? "source" : "unknown",
      amountCents: amountRead.value,
      amountKnowledge: amountRead.value === undefined ? "unknown" : "known",
      payer: payerEvidence ?? (isV3(context) ? "unknown" : undefined),
      payerKnowledge: payerEvidence ? "source" : "unknown",
      status: statusResult.value as HapPaymentStatus | undefined,
      statusKnowledge: statusResult.knowledge,
    };
    snapshot.subsidyPayments.push(subsidyPayment);
    addSource("subsidy_payment", record, subsidyPayment.id);
  }
  };
  for (const raw of input.deposits ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("deposit", record)) continue;
    const tenancySource = sourceLink(record, "tenancyId", "leaseId", "TenancyID", "LeaseID");
    const tenancy = tenancySource ? tenancyBySource.get(tenancySource) : undefined;
    const explicitPersonSource = sourceLink(record, "personId", "personSourceId", "tenantId", "tenantSourceId", "TenantID", "AccountID", "parentSourceId", "ParentID");
    const explicitPerson = explicitPersonSource ? personBySource.get(explicitPersonSource) : undefined;
    const person = isV3(context) ? explicitPerson : explicitPerson ?? (tenancy ? Array.from(personBySource.values()).find((candidate) => candidate.id === tenancy.primaryPersonId) : undefined);
    const explicitUnitSource = sourceLink(record, "unitId", "unitSourceId", "UnitID");
    const explicitUnit = explicitUnitSource ? unitBySource.get(explicitUnitSource) : undefined;
    const unit = isV3(context) ? explicitUnit : explicitUnit ?? (tenancy ? Array.from(unitBySource.values()).find((candidate) => candidate.id === tenancy.unitId) : undefined);
    const explicitPropertySource = sourceLink(record, "propertyId", "propertySourceId", "PropertyID");
    const explicitProperty = explicitPropertySource ? propertyBySource.get(explicitPropertySource) : undefined;
    const property = isV3(context)
      ? explicitProperty
      : explicitProperty ?? (tenancy ? Array.from(propertyBySource.values()).find((candidate) => candidate.id === tenancy.propertyId) : unit ? Array.from(propertyBySource.values()).find((candidate) => candidate.id === unit.propertyId) : undefined);
    const amountHeldCents = requiredMoney(record, ["amountHeldCents", "amount"], exceptions, "deposit", "amountHeldCents", true);
    const receivedOnRead = dateField(record, "receivedOn", "ReceivedOn", "ReceivedDate");
    if (receivedOnRead.invalid) fieldException(exceptions, "invalid_date", "receivedOn", "deposit", record);
    const receivedOn = receivedOnRead.value;
    const sourceConfidence = stringValue(record, "sourceConfidence");
    if (sourceConfidence === "inferred" || sourceConfidence === "exception") {
      exception(exceptions, "deposit_source_inferred", "Deposit receipt or relationship is not source-confirmed and requires verification", "deposit", record, amountHeldCents, "error");
    }
    if (tenancy && explicitPerson && tenancy.primaryPersonId !== explicitPerson.id) {
      exception(exceptions, "deposit_person_tenancy_mismatch", "Deposit person does not match its exact tenancy", "deposit", record, amountHeldCents, "error");
    }
    if (tenancy && explicitUnit && tenancy.unitId !== explicitUnit.id) {
      exception(exceptions, "deposit_unit_tenancy_mismatch", "Deposit unit does not match its exact tenancy", "deposit", record, amountHeldCents, "error");
    }
    if (tenancy && explicitProperty && tenancy.propertyId !== explicitProperty.id) {
      exception(exceptions, "deposit_property_tenancy_mismatch", "Deposit property does not match its exact tenancy", "deposit", record, amountHeldCents, "error");
    }
    if (unit && property && unit.propertyId !== property.id) {
      exception(exceptions, "deposit_property_unit_mismatch", "Deposit property does not match its exact unit", "deposit", record, amountHeldCents, "error");
    }
    const mismatch = Boolean(
      (tenancy && explicitPerson && tenancy.primaryPersonId !== explicitPerson.id) ||
      (tenancy && explicitUnit && tenancy.unitId !== explicitUnit.id) ||
      (tenancy && explicitProperty && tenancy.propertyId !== explicitProperty.id) ||
      (unit && property && unit.propertyId !== property.id),
    );
    if (!property || !person) {
      exception(exceptions, "deposit_reference_missing", "Deposit property/person relationship was not returned as an exact direct source link; retained as unknown", "deposit", record, amountHeldCents, isV3(context) ? "warning" : "error");
    }
    if (mismatch || amountHeldCents === undefined || receivedOnRead.invalid || (!isV3(context) && (!property || !person))) {
      exception(exceptions, "deposit_fact_incomplete", "Deposit was retained as an exception because its exact relationships or amount are incomplete", "deposit", record, amountHeldCents, "error");
      addSource("deposit", record, `rm:exception:deposit:${sourceId(record)}`);
      continue;
    }
    const typeSource = stringValue(record, "type", "depositType", "name");
    const typeText = typeSource?.toLowerCase() ?? "";
    const parsedType: NonNullable<RentOpsSecurityDeposit["type"]> | null = typeText
      && !isV3(context)
      ? /pet/.test(typeText) ? "refundable_pet" : /security/.test(typeText) ? "security" : /other|utility|animal|damage|key|last.?month/.test(typeText) ? "other_refundable" : null
      : null;
    if (isV3(context) && !parsedType) exception(exceptions, "deposit_type_unknown", "Deposit type was not returned as an explicit source value and remains unknown", "deposit", record, amountHeldCents, "warning");
    const type: RentOpsSecurityDeposit["type"] = isV3(context) ? parsedType ?? undefined : parsedType ?? "security";
    const disposedOnRead = dateField(record, "disposedOn", "DisposedOn", "DispositionDate");
    if (disposedOnRead.invalid) fieldException(exceptions, "invalid_date", "disposedOn", "deposit", record, "warning");
    const dispositionSource = stringValue(record, "dispositionStatus", "DispositionStatus", "status", "Status");
    const dispositionText = dispositionSource?.toLowerCase() ?? "";
    const parsedDisposition: NonNullable<RentOpsSecurityDeposit["dispositionStatus"]> | null = dispositionText
      && !isV3(context)
      ? /partial/.test(dispositionText) ? "partially_disposed" : /return/.test(dispositionText) ? "returned" : /dispos/.test(dispositionText) ? "disposed" : /held/.test(dispositionText) ? "held" : null
      : null;
    if (isV3(context) && !parsedDisposition) exception(exceptions, "deposit_disposition_unknown", "Deposit disposition was not returned as an explicit source value and remains unknown", "deposit", record, amountHeldCents, "warning");
    const dispositionStatus: RentOpsSecurityDeposit["dispositionStatus"] = isV3(context) ? parsedDisposition ?? undefined : parsedDisposition ?? "held";
    const deposit = {
      id: targetId(context, "deposit", sourceId(record)),
      source: { system: SYSTEM, entityType: "deposit", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      propertyId: property?.id,
      propertyLinkKnowledge: property ? "exact" : "unknown",
      unitId: unit?.id,
      unitLinkKnowledge: unit ? "exact" : "unknown",
      tenancyId: tenancy?.id,
      personId: person?.id,
      personLinkKnowledge: person ? "exact" : "unknown",
      type,
      typeKnowledge: parsedType ? "source" : "unknown",
      amountHeldCents,
      receivedOn,
      receivedOnKnowledge: receivedOn ? "source" : "unknown",
      dispositionStatus,
      dispositionStatusKnowledge: parsedDisposition ? "source" : "unknown",
      disposedOn: disposedOnRead.value,
      dispositionNotes: stringValue(record, "dispositionNotes", "DispositionNotes", "notes", "Notes"),
    } as unknown as RentOpsSecurityDeposit;
    snapshot.securityDeposits.push(deposit);
    addSource("deposit", record, deposit.id);
  }
  for (const raw of input.subsidies ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("subsidy", record)) continue;
    // TenantID is a person/account relationship and is never a LeaseID
    // fallback.  Preserve the person link separately where the source has it.
    const tenancy = tenancyBySource.get(sourceLink(record, "tenancyId", "leaseId", "TenancyID", "LeaseID") ?? "");
    const unit = unitBySource.get(sourceLink(record, "unitId", "unitSourceId") ?? "") ?? (tenancy ? snapshot.units.find((candidate) => candidate.id === tenancy.unitId) : undefined);
    const agencyName = stringValue(record, "agencyName", "agency");
    const effectiveFrom = requiredDate(record, ["effectiveFrom", "startDate"], exceptions, "subsidy", "effectiveFrom");
    const effectiveToRead = dateField(record, "effectiveTo", "endDate");
    if (effectiveToRead.invalid) fieldException(exceptions, "invalid_date", "effectiveTo", "subsidy", record);
    const agencyObligationCents = requiredMoney(record, ["agencyObligationCents", "agencyAmount"], exceptions, "subsidy", "agencyObligationCents");
    const tenantObligationCents = requiredMoney(record, ["tenantObligationCents", "tenantAmount"], exceptions, "subsidy", "tenantObligationCents");
    if (!tenancy || !unit) { exception(exceptions, "subsidy_reference_missing", "Subsidy contract cannot be mapped without tenancy and unit", "subsidy", record, undefined, "error"); continue; }
    if (!agencyName) { fieldException(exceptions, "missing_field", "agencyName", "subsidy", record); continue; }
    if (!effectiveFrom || (effectiveToRead.present && !effectiveToRead.value) || agencyObligationCents === undefined || tenantObligationCents === undefined) {
      exception(exceptions, "subsidy_fact_incomplete", "Subsidy contract was quarantined because effective date and both obligation amounts are required", "subsidy", record, undefined, "error");
      continue;
    }
    if (effectiveToRead.value && effectiveToRead.value < effectiveFrom) {
      exception(exceptions, "date_order_invalid", "Subsidy effectiveTo cannot precede effectiveFrom", "subsidy", record, undefined, "error");
      continue;
    }
    if (agencyObligationCents + tenantObligationCents <= 0) {
      exception(exceptions, "subsidy_obligation_non_positive", "At least one subsidy obligation must be greater than zero", "subsidy", record, undefined, "error");
      continue;
    }
    const statusSource = hapStatusField(record).value;
    const statusResult = exactHapStatus(context, record, "contract", "Subsidies");
    const parsedStatus = statusResult.value as RentOpsSubsidyContract["status"] | undefined;
    if (isV3(context) && statusSource !== undefined && !parsedStatus) exception(exceptions, "subsidy_status_unknown", "Housing-assistance status was not returned through the exact artifact-bound crosswalk and remains unknown", "subsidy", record, undefined, "warning");
    const subsidy: RentOpsSubsidyContract = { id: targetId(context, "subsidy", sourceId(record)), source: { system: SYSTEM, entityType: "subsidy", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) }, propertyId: tenancy.propertyId, unitId: unit.id, tenancyId: tenancy.id, agencyName, contractNumber: stringValue(record, "contractNumber", "number"), effectiveFrom, effectiveTo: effectiveToRead.value, agencyObligationCents, tenantObligationCents, status: isV3(context) ? parsedStatus : parsedStatus ?? "active", statusKnowledge: statusResult.knowledge };
    snapshot.subsidyContracts.push(subsidy);
    addSource("subsidy", record, subsidy.id);
  }
  for (const contract of snapshot.subsidyContracts) {
    for (const key of sourceKeyVariants(contract.source?.sourceId)) subsidyBySource.set(key, contract);
  }
  mapHapChildren();
  // The legacy combined HAP alias is restricted archive input only. The
  // operational child projections below are populated from their explicit
  // source collections and never from this alias.
  for (const raw of input.hap ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("subsidy", record)) continue;
    addSource("subsidy", record, `rm:exception:hap:${sourceId(record)}`);
  }
  for (const raw of input.applications ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("application", record)) continue;
    const id = targetId(context, "application", sourceId(record));
    const submittedOnRead = dateField(record, "submittedOn", "submittedDate");
    if (submittedOnRead.invalid) fieldException(exceptions, "invalid_date", "submittedOn", "application", record, isV3(context) ? "warning" : "error");
    const updatedAt = optionalTimestamp(record, ["updatedAt", "updated_at"], exceptions, "application", "updatedAt");
    const createdAt = sourceCreatedAt(record);
    const email = stringValue(record, "email");
    const firstName = stringValue(record, "firstName", "first_name");
    const lastName = stringValue(record, "lastName", "last_name");
    const rmStatusSource = stringValue(record, "Status", "ApplicationStatus", "status", "applicationStatus");
    if ((!email || !firstName || !lastName || !rmStatusSource) && !isV3(context)) {
      exception(exceptions, "application_fact_incomplete", "Application was quarantined because sourced identity, status, and timestamps are required", "application", record, undefined, "error");
      continue;
    }
    if (!createdAt) exception(exceptions, "application_created_at_unknown", "Application creation timestamp was not returned by RM; import timestamp is retained as explicit unknown", "application", record, undefined, "warning");
    if (!updatedAt) exception(exceptions, "application_updated_at_unknown", "Application update timestamp was not returned by RM; import timestamp is retained as explicit unknown", "application", record, undefined, "warning");
    const rmApplicationStatus = rmStatusSource?.toLowerCase();
    const legacyApplicationStatus: RentOpsApplication["status"] | null = rmApplicationStatus
      ? /complete|submitted/.test(rmApplicationStatus) ? "submitted" : /progress|awaiting|draft/.test(rmApplicationStatus) ? "draft" : /under.?review|review/.test(rmApplicationStatus) ? "under_review" : /missing/.test(rmApplicationStatus) ? "missing_information" : /approv/.test(rmApplicationStatus) ? "approved" : /declin|denied|reject/.test(rmApplicationStatus) ? "declined" : /withdraw|cancel/.test(rmApplicationStatus) ? "withdrawn" : /convert/.test(rmApplicationStatus) ? "converted" : null
      : null;
    const applicationStatus = isV3(context) ? strictApplicationStatus(context, record) : legacyApplicationStatus;
    if (isV3(context) && rmStatusSource && !applicationStatus) exception(exceptions, "application_status_unknown", "Application status was not returned through the exact artifact-bound crosswalk; retained as unknown", "application", record, undefined, "warning");
    const application = {
      id,
      source: { system: SYSTEM, entityType: "application", sourceId: sourceId(record), sourceUpdatedAt: updatedAt },
      sourceType: "rm_import",
      status: applicationStatus,
      email: email ?? null,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      phone: stringValue(record, "phone") ?? null,
      propertyId: propertyBySource.get(sourceLink(record, "propertyId") ?? "")?.id,
      unitId: unitBySource.get(sourceLink(record, "unitId") ?? "")?.id,
      submittedOn: submittedOnRead.value ?? null,
      createdAt: isV3(context) ? (createdAt ?? null) : (createdAt ?? importedAt),
      updatedAt: isV3(context) ? (updatedAt ?? null) : (updatedAt ?? importedAt),
      ...mapApplicationProfile(record, exceptions),
      // rm_import is the target's classification of this row, not a field
      // RM attested as a source semantic.  Keep that distinction explicit.
      sourceTypeKnowledge: "inferred",
      statusKnowledge: applicationStatus ? "source" : "unknown",
      emailKnowledge: email ? "source" : "unknown",
      firstNameKnowledge: firstName ? "source" : "unknown",
      lastNameKnowledge: lastName ? "source" : "unknown",
      phoneKnowledge: stringValue(record, "phone") ? "source" : "unknown",
      propertyLinkKnowledge: propertyBySource.get(sourceLink(record, "propertyId") ?? "") ? "exact" : "unknown",
      unitLinkKnowledge: unitBySource.get(sourceLink(record, "unitId") ?? "") ? "exact" : "unknown",
      submittedOnKnowledge: submittedOnRead.value ? "source" : "unknown",
      createdAtKnowledge: createdAt ? "source" : "unknown",
      updatedAtKnowledge: updatedAt ? "source" : "unknown",
    } as unknown as RentOpsApplication;
    snapshot.applications.push(application);
    addSource("application", record, id);
  }
  for (const raw of input.documents ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("document", record)) continue;
    const id = targetId(context, "document", sourceId(record));
    const linkedProperty = propertyBySource.get(sourceLink(record, "propertyId", "propertySourceId") ?? "");
    const linkedUnit = unitBySource.get(sourceLink(record, "unitId", "unitSourceId") ?? "");
    const linkedPerson = personBySource.get(sourceLink(record, "tenantId", "personId", "tenantSourceId") ?? "");
    const linkedTenancy = tenancyBySource.get(sourceLink(record, "tenancyId", "leaseId", "TenancyID", "LeaseID") ?? "");
    const hasLink = Boolean(sourceLink(record, "propertyId", "propertySourceId", "unitId", "unitSourceId", "tenantId", "personId", "tenantSourceId", "tenancyId", "leaseId"));
    if (hasLink && !linkedProperty && !linkedUnit && !linkedPerson && !linkedTenancy) exception(exceptions, "document_reference_missing", "Document reference did not resolve to an imported entity", "document", record, undefined, "warning");
    const checksum = stringValue(record, "checksumSha256", "checksum", "sha256");
    const binaryAvailable = boolValue(record, "binaryAvailable", "downloaded", "fileAvailable");
    if (!binaryAvailable || !checksum) exception(exceptions, "document_binary_missing", "Document metadata was imported without verified binary/checksum", "document", record, undefined, "warning");
    if (checksum && !/^[a-f0-9]{64}$/i.test(checksum)) {
      exception(exceptions, "document_checksum_invalid", "Document checksum is not a valid SHA-256 value and remains metadata-only", "document", record, undefined, isV3(context) ? "warning" : "error");
      if (!isV3(context)) continue;
    }
    const rawSize = value(record, "sizeBytes", "size");
    let sizeBytes: number | undefined;
    if (rawSize !== undefined) {
      sizeBytes = typeof rawSize === "number" ? rawSize : typeof rawSize === "string" && /^\d+$/.test(rawSize.trim()) ? Number(rawSize.trim()) : Number.NaN;
    }
    if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
      exception(exceptions, "document_size_invalid", "Document size must be a non-negative integer and remains metadata-only", "document", record, undefined, isV3(context) ? "warning" : "error");
      if (!isV3(context)) continue;
    }
    const updatedAt = optionalTimestamp(record, ["updatedAt", "updated_at"], exceptions, "document", "updatedAt");
    const fileName = sanitizeFilename(requiredString(record, `${sourceId(record)}.bin`, "fileName", "name"));
    const archivePath = stringValue(record, "archivePath", "storageKey");
    const safeArchivePath = archivePath && /^binaries\/[A-Za-z0-9._-]+\.bin$/.test(archivePath) ? archivePath : undefined;
    if (archivePath && !safeArchivePath) exception(exceptions, "document_storage_key_invalid", "Document archive path was not a restricted relative binary path and was not treated as transferred", "document", record, undefined, "warning");
    const verifiedBinary = binaryAvailable && Boolean(checksum) && Boolean(safeArchivePath) && sizeBytes !== undefined;
    if (binaryAvailable && !verifiedBinary) exception(exceptions, "document_binary_unverified", "Document indicated available bytes but lacked a verified archive path, checksum, or size", "document", record, undefined, "warning");
    // Only an exporter-verified archive descriptor can become a transferred
    // document. Metadata-only rows retain the requested state and a synthetic
    // non-file storage key; no source checksum/size is presented as verified.
    const document = isV3(context)
      ? {
          id,
          source: { system: SYSTEM, entityType: "document", sourceId: sourceId(record), sourceUpdatedAt: updatedAt },
          propertyId: linkedProperty?.id,
          unitId: linkedUnit?.id,
          personId: linkedPerson?.id,
          tenancyId: linkedTenancy?.id,
          type: "other" as const,
          state: "requested" as const,
          fileName: stringValue(record, "fileName", "name") ?? null,
          mimeType: stringValue(record, "mimeType") ?? null,
          sizeBytes: null,
          checksumSha256: null,
          storageKey: null,
          uploadedAt: null,
          verifiedAt: null,
          availability: binaryAvailable || checksum || sizeBytes !== undefined ? "metadata" as const : "unavailable" as const,
          storageKeyKnowledge: "unknown" as const,
          metadataSizeBytes: sizeBytes ?? null,
          metadataChecksumSha256: checksum && /^[a-f0-9]{64}$/i.test(checksum) ? checksum : null,
        }
      : { id, source: { system: SYSTEM, entityType: "document", sourceId: sourceId(record), sourceUpdatedAt: updatedAt }, propertyId: linkedProperty?.id, unitId: linkedUnit?.id, personId: linkedPerson?.id, tenancyId: linkedTenancy?.id, type: "other" as const, state: verifiedBinary ? "verified" as const : "requested" as const, fileName, mimeType: requiredString(record, "application/octet-stream", "mimeType"), ...(verifiedBinary ? { sizeBytes, checksumSha256: checksum, storageKey: safeArchivePath!, uploadedAt: importedAt, verifiedAt: importedAt } : { storageKey: `rent-manager/${sourceId(record).replace(/[^a-zA-Z0-9_-]/g, "_")}/${fileName}`, uploadedAt: updatedAt ?? importedAt }) };
    snapshot.documents.push(document as unknown as RentOpsDocument);
    addSource("document", record, id);
  }
  for (const raw of input.activities ?? []) {
    const record = raw as RawRecord;
    if (!claimSource("activity", record)) continue;
    const linkedProperty = propertyBySource.get(sourceLink(record, "propertyId", "propertySourceId") ?? "");
    const linkedUnit = unitBySource.get(sourceLink(record, "unitId", "unitSourceId") ?? "");
    const linkedPerson = personBySource.get(sourceLink(record, "tenantId", "personId", "tenantSourceId") ?? "");
    const linkedTenancy = tenancyBySource.get(sourceLink(record, "tenancyId", "leaseId", "TenancyID", "LeaseID") ?? "");
    const occurredAt = optionalTimestamp(record, ["occurredAt", "occurred_at", "sentDate", "receivedDate", "historyDate", "updatedAt", "updated_at"], exceptions, "activity", "occurredAt");
    const actor = stringValue(record, "actor", "user", "createdBy", "createUserId", "sentUserId");
    const summary = stringValue(record, "summary", "subject", "description", "historyType", "result");
    const typeText = stringValue(record, "type", "activityType")?.toLowerCase();
    if (!occurredAt) exception(exceptions, "activity_occurred_at_missing", "Activity was retained with an explicit unknown source event timestamp", "activity", record, undefined, isV3(context) ? "warning" : "error");
    if (!actor) exception(exceptions, "activity_actor_unknown", "Activity actor was not returned by RM; retained as explicit unknown", "activity", record, undefined, "warning");
    if (!summary) exception(exceptions, "activity_summary_unknown", "Activity summary was not returned by RM; retained as explicit unknown", "activity", record, undefined, "warning");
    const activityTypes: RentOpsActivityEvent["type"][] = ["note", "call", "email", "text", "promise_to_pay", "hold", "notice", "system"];
    if (typeText && !activityTypes.includes(typeText as RentOpsActivityEvent["type"])) exception(exceptions, "activity_type_unknown", "Activity type was not one of the supported source values; retained as system", "activity", record, undefined, "warning");
    if (!occurredAt && !isV3(context)) continue;
    const activity = {
      id: targetId(context, "activity", sourceId(record)),
      source: { system: SYSTEM, entityType: "activity", sourceId: sourceId(record), sourceUpdatedAt: sourceUpdatedAt(record) },
      propertyId: linkedProperty?.id,
      unitId: linkedUnit?.id,
      personId: linkedPerson?.id,
      tenancyId: linkedTenancy?.id,
      type: activityTypes.includes(typeText as RentOpsActivityEvent["type"]) ? typeText as RentOpsActivityEvent["type"] : isV3(context) ? null : "system",
      occurredAt: occurredAt ?? null,
      actor: actor ?? (isV3(context) ? null : "Unknown actor"),
      summary: summary ?? (isV3(context) ? null : "Unknown activity"),
      detail: stringValue(record, "detail", "notes", "note", "body", "message", "messageBody"),
      occurredAtKnowledge: occurredAt ? "source" : "unknown",
      actorKnowledge: actor ? "source" : "unknown",
      summaryKnowledge: summary ? "source" : "unknown",
      typeKnowledge: typeText && activityTypes.includes(typeText as RentOpsActivityEvent["type"]) ? "source" : "unknown",
      propertyLinkKnowledge: linkedProperty ? "exact" : "unknown",
      unitLinkKnowledge: linkedUnit ? "exact" : "unknown",
      personLinkKnowledge: linkedPerson ? "exact" : "unknown",
      tenancyLinkKnowledge: linkedTenancy ? "exact" : "unknown",
    } as unknown as RentOpsActivityEvent;
    snapshot.activityEvents.push(activity);
    addSource("activity", record, activity.id);
  }

  const counts: RentOpsImportRun["counts"] = {};
  for (const sourceRecord of sourceRecords) counts[sourceRecord.entityType] = (counts[sourceRecord.entityType] ?? 0) + 1;
  const importRun: RentOpsImportRun = { id: `rm-import:${importedAt}`, system: SYSTEM, startedAt: importedAt, completedAt: importedAt, mode: options.mode ?? "dry_run", sourceManifestHash: options.sourceManifestHash, counts, exceptionCount: exceptions.length, status: "running" };
  snapshot.sourceRecords = sourceRecords;
  snapshot.importRuns = [importRun];
  try { assertValidSnapshot(snapshot); } catch (error) {
    exception(exceptions, "snapshot_invariant_failed", error instanceof Error ? error.message : "Mapped snapshot failed invariant validation", undefined, undefined, undefined, "error");
  }
  importRun.exceptionCount = exceptions.length;
  importRun.status = exceptions.some((item) => item.severity === "error") ? "failed" : "completed";
  const result = { snapshot, sourceRecords, importRun, exceptions, financialSemanticCrosswalk: configuredFinancialCrosswalk };
  return result;
}

export interface RentManagerControlTotals {
  counts?: Partial<Record<ImportEntityType, number>>;
  totalsCents?: Record<string, number>;
  unknownCounts?: Record<string, number>;
  invalidMoneyCounts?: Record<string, number>;
}

export function reconcileRentManagerImport(result: import("../../../shared/rent-ops-contracts").RentManagerImportResult, input: RentManagerImportInput, controls: RentManagerControlTotals = {}): ReconciliationReport {
  const mismatches: ReconciliationReport["mismatches"] = [];
  const counts: ReconciliationReport["counts"] = {};
  const totalsCents: ReconciliationReport["totalsCents"] = {};
  const expectedCounts = controls.counts ?? {};
  const actualCounts: Record<string, number> = {};
  for (const record of result.sourceRecords) actualCounts[record.entityType] = (actualCounts[record.entityType] ?? 0) + 1;
  for (const type of Array.from(new Set([...Object.keys(expectedCounts), ...Object.keys(actualCounts)]))) {
    const expected = expectedCounts[type as ImportEntityType] ?? actualCounts[type] ?? 0;
    const actual = actualCounts[type] ?? 0;
    counts[type] = { expected, actual };
    if (expected !== actual) mismatches.push({ code: "count_mismatch", severity: "error", metric: type, expected, actual, message: `${type} count expected ${expected}, mapped ${actual}` });
  }
  const mappedChargeRows = result.snapshot.ledgerTransactions.filter((transaction) => transaction.kind === "charge");
  const mappedPaymentRows = result.snapshot.ledgerTransactions.filter((transaction) => transaction.kind === "payment");
  const mappedCreditRows = result.snapshot.ledgerTransactions.filter((transaction) => transaction.kind === "credit");
  const mappedChargeTotal = mappedChargeRows.reduce((sum, transaction) => sum + (typeof transaction.amountCents === "number" && Number.isSafeInteger(transaction.amountCents) ? transaction.amountCents : 0), 0);
  const mappedPaymentTotal = mappedPaymentRows.reduce((sum, transaction) => sum + (typeof transaction.amountCents === "number" && Number.isSafeInteger(transaction.amountCents) ? transaction.amountCents : 0), 0);
  const mappedCreditTotal = mappedCreditRows.reduce((sum, transaction) => sum + (typeof transaction.amountCents === "number" && Number.isSafeInteger(transaction.amountCents) ? transaction.amountCents : 0), 0);
  const actualTotals: Record<string, number> = { charges: mappedChargeTotal, payments: mappedPaymentTotal, credits: mappedCreditTotal };
  const money = moneyControlCounts(input);
  const inputChargeTotal = money.knownTotals.charges ?? 0;
  const inputPaymentTotal = money.knownTotals.payments ?? 0;
  const inputCreditTotal = money.knownTotals.credits ?? 0;
  const expectedTotals: Record<string, number> = { charges: controls.totalsCents?.charges ?? inputChargeTotal, payments: controls.totalsCents?.payments ?? inputPaymentTotal, credits: controls.totalsCents?.credits ?? inputCreditTotal };
  for (const key of Array.from(new Set([...Object.keys(expectedTotals), ...Object.keys(actualTotals)]))) {
    const expected = expectedTotals[key] ?? 0;
    const actual = actualTotals[key] ?? 0;
    totalsCents[key] = { expected, actual };
    if (expected !== actual) mismatches.push({ code: "amount_mismatch", severity: "error", metric: key, amountCents: actual - expected, message: `${key} total expected ${expected} cents, mapped ${actual} cents` });
  }
  const actualUnknownCounts: Record<string, number> = {
    charges: mappedChargeRows.filter((row) => typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents)).length,
    payments: mappedPaymentRows.filter((row) => typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents)).length,
    credits: mappedCreditRows.filter((row) => typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents)).length,
    allocations: result.snapshot.paymentAllocations.filter((row) => typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents)).length,
  };
  const moneySourceKinds = new Map<string, string>();
  for (const [key, records] of [["charges", input.charges], ["payments", input.payments], ["credits", input.credits], ["allocations", input.allocations]] as const) {
    for (const record of records ?? []) {
      const source = String((record as RawRecord).sourceId ?? (record as RawRecord).id ?? (record as RawRecord).ID ?? "");
      if (source) moneySourceKinds.set(`${key}\u0000${source}`, key);
    }
  }
  const actualInvalidCounts: Record<string, number> = {};
  for (const exception of result.exceptions) {
    if (exception.code === "allocation_amount_invalid" && exception.entityType === "payment_allocation") actualInvalidCounts.allocations = (actualInvalidCounts.allocations ?? 0) + 1;
    if (exception.code !== "ledger_amount_invalid" || exception.entityType !== "ledger_transaction" || !exception.sourceId) continue;
    for (const key of ["charges", "payments", "credits"]) {
      if (moneySourceKinds.has(`${key}\u0000${exception.sourceId}`)) {
        actualInvalidCounts[key] = (actualInvalidCounts[key] ?? 0) + 1;
        break;
      }
    }
  }
  const expectedUnknownCounts = controls.unknownCounts ?? money.unknownCounts;
  const expectedInvalidCounts = controls.invalidMoneyCounts ?? money.invalidCounts;
  for (const key of Array.from(new Set([...Object.keys(expectedUnknownCounts), ...Object.keys(actualUnknownCounts)]))) {
    const expected = expectedUnknownCounts[key] ?? 0;
    const actual = actualUnknownCounts[key] ?? 0;
    if (expected !== actual) mismatches.push({ code: "amount_unknown_mismatch", severity: "error", metric: key, expected, actual, message: `${key} unknown amount count expected ${expected}, mapped ${actual}` });
  }
  for (const key of Array.from(new Set([...Object.keys(expectedInvalidCounts), ...Object.keys(actualInvalidCounts)]))) {
    const expected = expectedInvalidCounts[key] ?? 0;
    const actual = actualInvalidCounts[key] ?? 0;
    if (expected !== actual) mismatches.push({ code: "amount_invalid_mismatch", severity: "error", metric: key, expected, actual, message: `${key} invalid amount count expected ${expected}, mapped ${actual}` });
  }
  for (const mappingException of result.exceptions) mismatches.push({ code: mappingException.code, severity: mappingException.severity, metric: mappingException.entityType ?? "import", amountCents: mappingException.amountCents, message: mappingException.message });
  return { passed: mismatches.every((mismatch) => mismatch.severity !== "error"), mismatches, counts, totalsCents };
}
