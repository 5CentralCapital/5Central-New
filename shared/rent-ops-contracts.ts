import { z } from "zod";

/**
 * Rent Operations is deliberately independent of the legacy application
 * schema. These contracts are the boundary shared by the domain, API, and
 * import tooling. Money is always integer cents outside the SQL adapter.
 */

export const POSTGRES_INTEGER_MIN = -2_147_483_648;
export const POSTGRES_INTEGER_MAX = 2_147_483_647;

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const isoDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine(isCalendarDate, "Expected a real calendar date");
export const isoMonthSchema = z.string()
  .regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM")
  .refine((value) => isCalendarDate(`${value}-01`), "Expected a real calendar month");
export const centsSchema = z.number()
  .int()
  .finite()
  .min(POSTGRES_INTEGER_MIN)
  .max(POSTGRES_INTEGER_MAX);
export const idSchema = z.string().min(1).max(160);

export type IsoDate = z.infer<typeof isoDateSchema>;
export type IsoMonth = z.infer<typeof isoMonthSchema>;
export type Cents = z.infer<typeof centsSchema>;

export const PROPERTY_STATES = ["active", "archived"] as const;
export type PropertyState = (typeof PROPERTY_STATES)[number];

export const PROPERTY_TYPES = ["multifamily", "single_family", "other"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const READINESS_STATES = ["ready", "not_ready", "off_market"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const LISTING_STATES = ["listed", "unlisted", "off_market"] as const;
export type ListingState = (typeof LISTING_STATES)[number];

export const OCCUPANCY_STATES = ["current", "future_preleased", "vacant", "unknown"] as const;
export type OccupancyState = (typeof OCCUPANCY_STATES)[number];

export const TENANCY_STATUSES = ["future", "current", "notice", "past", "cancelled"] as const;
export type TenancyStatus = (typeof TENANCY_STATUSES)[number];

export const LEASE_TERM_STATUSES = ["draft", "executed", "expired", "month_to_month", "cancelled"] as const;
export type LeaseTermStatus = (typeof LEASE_TERM_STATUSES)[number];

export const CHARGE_CATEGORIES = [
  "base_rent",
  "recurring_fee",
  "one_time_fee",
  "subsidy",
  "security_deposit",
  "refundable_pet_deposit",
  "move_in_funds",
  "unapplied_cash",
  "other",
] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

export const LEDGER_KINDS = ["charge", "payment", "credit", "reversal", "adjustment"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const LEDGER_STATUSES = ["posted", "voided", "pending"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const ADJUSTMENT_DIRECTIONS = ["debit", "credit"] as const;
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

export const PAYMENT_METHODS = ["ach", "card", "cash", "check", "money_order", "zelle", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DEPOSIT_TYPES = ["security", "refundable_pet", "other_refundable"] as const;
export type DepositType = (typeof DEPOSIT_TYPES)[number];

/** The polymorphic RM recurring-charge owner. EntityType is resolved before
 * EntityKeyID so colliding numeric keys can never cross scopes. */
export const RECURRING_SCOPE_TYPES = ["tenant", "unit", "property"] as const;
export type RecurringScopeType = (typeof RECURRING_SCOPE_TYPES)[number];
export const RECURRING_DATE_KNOWLEDGE = ["source", "unknown_open_start", "manual"] as const;
export type RecurringDateKnowledge = (typeof RECURRING_DATE_KNOWLEDGE)[number];
/** Distinguishes an artifact-imported lineage root from an operator-created
 * root. `root` is an explicit root action; native/manual roots never borrow
 * an artifact claim. */
export const RECURRING_LINEAGE_ROOT_ORIGINS = ["artifact", "manual"] as const;
export type RecurringLineageRootOrigin = (typeof RECURRING_LINEAGE_ROOT_ORIGINS)[number];
/** Provenance of this version row, independent of the root's lineage boundary. */
export const RECURRING_VERSION_ORIGINS = ["artifact", "manual"] as const;
export type RecurringVersionOrigin = (typeof RECURRING_VERSION_ORIGINS)[number];
export const DEPOSIT_DATE_KNOWLEDGE = ["source", "unknown", "manual"] as const;
export type DepositDateKnowledge = (typeof DEPOSIT_DATE_KNOWLEDGE)[number];
export const DEPOSIT_UNIT_LINK_KNOWLEDGE = ["exact", "unknown", "manual"] as const;
export type DepositUnitLinkKnowledge = (typeof DEPOSIT_UNIT_LINK_KNOWLEDGE)[number];

export const APPLICATION_STATUSES = [
  "complete",
  "in_progress",
  "awaiting_payment",
  "draft",
  "submitted",
  "missing_information",
  "under_review",
  "approved",
  "declined",
  "withdrawn",
  "converted",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_REQUIREMENT_STATUSES = ["requested", "received", "waived", "rejected"] as const;
export type ApplicationRequirementStatus = (typeof APPLICATION_REQUIREMENT_STATUSES)[number];

export const APPLICATION_SOURCES = ["public_portal", "manual", "rm_import", "referral", "other"] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

export const DOCUMENT_STATES = ["requested", "received", "signed", "executed", "filed", "current", "verified", "rejected", "expired", "archived"] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const DOCUMENT_TYPES = [
  "lease",
  "addendum",
  "identity",
  "insurance",
  "notice",
  "application_attachment",
  "housing_assistance",
  "deposit_record",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const ACTIVITY_TYPES = ["note", "call", "email", "text", "promise_to_pay", "hold", "notice", "system"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const IMPORT_ENTITY_TYPES = [
  "property",
  "unit",
  "person",
  "tenancy",
  "lease",
  "lease_term",
  "recurring_schedule",
  "ledger_transaction",
  "payment_allocation",
  "deposit",
  "subsidy",
  "application",
  "document",
  "activity",
  "charge_definition",
  "household_membership",
  "subsidy_tenant",
  "subsidy_payment",
] as const;
export type ImportEntityType = (typeof IMPORT_ENTITY_TYPES)[number];

/**
 * v3 keeps the source value and the fact that it is absent separate.  The
 * legacy v1/v2 fields remain available for existing callers; the nullable
 * runtime values below are intentionally paired with one of these markers.
 */
export const FACT_KNOWLEDGE = ["source", "unknown", "ambiguous", "inferred", "manual"] as const;
export type FactKnowledge = (typeof FACT_KNOWLEDGE)[number];
export const LINK_KNOWLEDGE = ["exact", "unknown", "ambiguous", "manual"] as const;
export type LinkKnowledge = (typeof LINK_KNOWLEDGE)[number];
export const AMOUNT_KNOWLEDGE = ["known", "unknown"] as const;
export type AmountKnowledge = (typeof AMOUNT_KNOWLEDGE)[number];
export const ALLOCATION_MODES = ["allocation_single", "multi_property", "unknown"] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];
export const DOCUMENT_AVAILABILITIES = ["metadata", "requested", "unavailable", "verified"] as const;
export type DocumentAvailability = (typeof DOCUMENT_AVAILABILITIES)[number];

/** Exact HAP status vocabulary. Unknown source values never enter one of
 * these states through substring matching (`inactive` is not `active`). */
export const HAP_CONTRACT_STATUSES = ["active", "ended", "pending", "exception"] as const;
export type HapContractStatus = (typeof HAP_CONTRACT_STATUSES)[number];
export const HAP_PAYMENT_STATUSES = ["received", "pending", "voided", "reversed"] as const;
export type HapPaymentStatus = (typeof HAP_PAYMENT_STATUSES)[number];

/**
 * Financial semantics are never inferred from prose.  Each value below is
 * an exact, artifact-bound mapping from one source collection/field/value to
 * a target semantic.  The raw value and source identity remain restricted to
 * the importer; browser DTOs expose only the resulting knowledge state.
 */
export const FINANCIAL_SEMANTIC_KINDS = [
  "tenancy_status",
  "lease_status",
  "ledger_status",
  "charge_category",
  "charge_definition_active",
  "recurring_active",
  "recurring_scope",
  "payment_method",
  "payer",
] as const;
export type FinancialSemanticKind = (typeof FINANCIAL_SEMANTIC_KINDS)[number];

export const FINANCIAL_SEMANTIC_NORMALIZATIONS = ["exact_v1", "trim_lower_unicode_v1"] as const;
export type FinancialSemanticNormalization = (typeof FINANCIAL_SEMANTIC_NORMALIZATIONS)[number];

export interface RentManagerFinancialSemanticCrosswalkEntry {
  artifactSha256: string;
  sourceCollection: string;
  sourceField: string;
  semanticKind: FinancialSemanticKind;
  normalization: FinancialSemanticNormalization;
  normalizedValue: string;
  targetValue: string;
}

export interface RentManagerFinancialSemanticCrosswalk {
  artifactSha256: string;
  normalization: FinancialSemanticNormalization;
  /** Exact entries; duplicate/conflicting keys are a blocking condition. */
  entries: RentManagerFinancialSemanticCrosswalkEntry[];
}

/**
 * Selects the one artifact-bound financial crosswalk accepted by v8.  Archive
 * compatibility still permits the historical array representation, but it is
 * deliberately not a collection: zero or multiple objects are invalid.  The
 * caller must fail closed rather than selecting the first object.
 */
export function selectFinancialSemanticCrosswalk(
  value: RentManagerFinancialSemanticCrosswalk | RentManagerFinancialSemanticCrosswalk[] | undefined,
  approvedArtifactSha256?: string,
): { crosswalk?: RentManagerFinancialSemanticCrosswalk; valid: boolean; issueCodes: string[] } {
  const candidates = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (candidates.length !== 1) {
    return { valid: false, issueCodes: [value === undefined ? "crosswalk_required" : "crosswalk_exactly_one"] };
  }
  const crosswalk = candidates[0];
  const validation = validateFinancialSemanticCrosswalkForArtifact(crosswalk, approvedArtifactSha256);
  return { crosswalk, valid: validation.valid, issueCodes: validation.issueCodes };
}

const FINANCIAL_SEMANTIC_SOURCE_FIELDS: Record<FinancialSemanticKind, readonly string[]> = {
  tenancy_status: ["tenants\u0000Status", "tenants.current\u0000$partition", "tenants.future\u0000$partition", "tenants.former\u0000$partition"],
  // The v4 artifact did not expose a lease/ledger status field. Keep the
  // semantic kind closed for future supplements, but do not admit an
  // unobserved parallel namespace into the production crosswalk.
  lease_status: [],
  ledger_status: ["charges\u0000TransactionType", "payments\u0000TransactionType", "credits\u0000TransactionType"],
  charge_category: ["chargeTypes\u0000ChargeTypeID"],
  charge_definition_active: ["chargeTypes\u0000IsActive"],
  recurring_active: [],
  recurring_scope: ["recurringSchedules\u0000EntityType"],
  payment_method: [],
  payer: [],
};

export function normalizeFinancialSemanticValue(value: unknown, normalization: FinancialSemanticNormalization): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const text = String(value);
  if (normalization === "exact_v1") return text;
  return text.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/** Builds an entry from the raw source value. Callers cannot accidentally
 * claim that an arbitrary payload-provided normalized string was verified. */
export function createFinancialSemanticCrosswalkEntry(input: {
  artifactSha256: string;
  sourceCollection: string;
  sourceField: string;
  semanticKind: FinancialSemanticKind;
  normalization: FinancialSemanticNormalization;
  rawValue: unknown;
  targetValue: string;
}): RentManagerFinancialSemanticCrosswalkEntry | undefined {
  const normalizedValue = normalizeFinancialSemanticValue(input.rawValue, input.normalization);
  if (normalizedValue === undefined) return undefined;
  return { artifactSha256: input.artifactSha256, sourceCollection: input.sourceCollection, sourceField: input.sourceField, semanticKind: input.semanticKind, normalization: input.normalization, normalizedValue, targetValue: input.targetValue };
}

const FINANCIAL_CROSSWALK_TARGETS: Record<FinancialSemanticKind, readonly string[]> = {
  tenancy_status: TENANCY_STATUSES,
  lease_status: LEASE_TERM_STATUSES,
  ledger_status: LEDGER_STATUSES,
  charge_category: CHARGE_CATEGORIES,
  charge_definition_active: ["true", "false"],
  recurring_active: ["true", "false"],
  recurring_scope: RECURRING_SCOPE_TYPES,
  payment_method: PAYMENT_METHODS,
  payer: ["tenant", "agency", "owner", "unknown"],
};

/**
 * Validates only structure and exact target-domain membership.  It does not
 * select a value, parse prose, or expose source labels.  Callers must treat
 * any issue as a blocking crosswalk failure and retain the source row as
 * unknown rather than falling back to a heuristic.
 */
export function validateFinancialSemanticCrosswalk(crosswalk: RentManagerFinancialSemanticCrosswalk, approvedArtifactSha256?: string): {
  valid: boolean;
  issueCodes: string[];
  entryCount: number;
} {
  return validateFinancialSemanticCrosswalkForArtifact(crosswalk, approvedArtifactSha256);
}

export function validateFinancialSemanticCrosswalkForArtifact(
  crosswalk: RentManagerFinancialSemanticCrosswalk,
  approvedArtifactSha256?: string,
): {
  valid: boolean;
  issueCodes: string[];
  entryCount: number;
} {
  const issueCodes = new Set<string>();
  if (!/^[a-f0-9]{64}$/.test(crosswalk.artifactSha256)) issueCodes.add("artifact_digest_invalid");
  if (!approvedArtifactSha256) issueCodes.add("artifact_approval_missing");
  else if (crosswalk.artifactSha256 !== approvedArtifactSha256) issueCodes.add("artifact_not_approved");
  if (!FINANCIAL_SEMANTIC_NORMALIZATIONS.includes(crosswalk.normalization)) issueCodes.add("normalization_unknown");
  const entries = Array.isArray(crosswalk.entries) ? crosswalk.entries : [];
  if (!Array.isArray(crosswalk.entries)) issueCodes.add("crosswalk_entries_invalid");
  if (entries.length > 4096) issueCodes.add("crosswalk_entry_limit_exceeded");
  const keys = new Map<string, string>();
  for (const entry of entries) {
    if (entry.artifactSha256 !== crosswalk.artifactSha256) issueCodes.add("artifact_mismatch");
    if (entry.normalization !== crosswalk.normalization || !FINANCIAL_SEMANTIC_NORMALIZATIONS.includes(entry.normalization)) issueCodes.add("normalization_mismatch");
    if (!entry.sourceCollection.trim()) issueCodes.add("source_collection_missing");
    if (!entry.sourceField.trim()) issueCodes.add("source_field_missing");
    if (!entry.normalizedValue.trim()) issueCodes.add("normalized_value_missing");
    if (entry.sourceCollection.length > 120 || entry.sourceField.length > 120 || entry.normalizedValue.length > 240 || entry.targetValue.length > 80) issueCodes.add("crosswalk_value_limit_exceeded");
    if (!FINANCIAL_SEMANTIC_SOURCE_FIELDS[entry.semanticKind]?.includes(`${entry.sourceCollection}\u0000${entry.sourceField}`)) issueCodes.add("source_field_not_approved");
    const allowed = FINANCIAL_CROSSWALK_TARGETS[entry.semanticKind];
    if (!allowed) issueCodes.add("semantic_kind_unknown");
    else if (!allowed.includes(entry.targetValue)) issueCodes.add("target_value_out_of_domain");
    const key = [entry.artifactSha256, entry.sourceCollection, entry.sourceField, entry.semanticKind, entry.normalization, entry.normalizedValue].join("\u0000");
    const prior = keys.get(key);
    if (prior !== undefined && prior !== entry.targetValue) issueCodes.add("crosswalk_conflict");
    else if (prior !== undefined) issueCodes.add("crosswalk_duplicate");
    keys.set(key, entry.targetValue);
  }
  if (entries.length === 0) issueCodes.add("crosswalk_empty");
  return { valid: issueCodes.size === 0, issueCodes: Array.from(issueCodes).sort(), entryCount: entries.length };
}

/** Exact lookup; an invalid/conflicting artifact must be rejected before this
 * helper is used.  The lookup intentionally performs no substring matching. */
export function financialSemanticCrosswalkValue(
  crosswalk: RentManagerFinancialSemanticCrosswalk | undefined,
  input: { artifactSha256: string; sourceCollection: string; sourceField: string; semanticKind: FinancialSemanticKind; rawValue: unknown },
): string | undefined {
  if (!crosswalk || crosswalk.artifactSha256 !== input.artifactSha256) return undefined;
  if (!FINANCIAL_SEMANTIC_SOURCE_FIELDS[input.semanticKind]?.includes(`${input.sourceCollection}\u0000${input.sourceField}`)) return undefined;
  const normalizedValue = normalizeFinancialSemanticValue(input.rawValue, crosswalk.normalization);
  if (normalizedValue === undefined) return undefined;
  let result: string | undefined;
  for (const entry of crosswalk.entries) {
    if (entry.artifactSha256 !== input.artifactSha256 || entry.sourceCollection !== input.sourceCollection || entry.sourceField !== input.sourceField || entry.semanticKind !== input.semanticKind || entry.normalization !== crosswalk.normalization || entry.normalizedValue !== normalizedValue) continue;
    if (result !== undefined && result !== entry.targetValue) return undefined;
    result = entry.targetValue;
  }
  return result;
}

export const RECONCILIATION_SEVERITIES = ["info", "warning", "error"] as const;
export type ReconciliationSeverity = (typeof RECONCILIATION_SEVERITIES)[number];

export const addressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(100).optional(),
  city: z.string().min(1).max(100),
  state: z.string().length(2),
  postalCode: z.string().min(3).max(20),
}).strict();
export type Address = z.infer<typeof addressSchema>;
export const sourceRefSchema = z.object({
  system: z.string().min(1).max(80),
  entityType: z.string().min(1).max(80),
  sourceId: z.string().min(1).max(200),
  sourceUpdatedAt: z.string().datetime().optional(),
}).strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;

export interface RentOpsProperty {
  id: string;
  /** Additive v7 optimistic-concurrency revision; imported rows start at 1. */
  recordRevision?: number;
  source?: SourceRef;
  name: string;
  slug: string;
  address: Address;
  propertyType: PropertyType;
  state: PropertyState;
  operatingContact?: string;
  /** v3 source-fidelity fields. Null means the source did not return a fact. */
  nameKnowledge?: FactKnowledge;
  addressKnowledge?: FactKnowledge;
  propertyTypeKnowledge?: FactKnowledge;
  stateKnowledge?: FactKnowledge;
  operatingContactKnowledge?: FactKnowledge;
}

export interface RentOpsUnit {
  id: string;
  recordRevision?: number;
  propertyId: string;
  source?: SourceRef;
  unitNumber: string;
  unitType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  marketRentCents?: Cents;
  defaultDepositCents?: Cents;
  readiness: ReadinessState;
  listing: ListingState;
  amenities?: string[];
  accessNotes?: string;
  propertyLinkKnowledge?: LinkKnowledge;
  unitNumberKnowledge?: FactKnowledge;
  unitTypeKnowledge?: FactKnowledge;
  readinessKnowledge?: FactKnowledge;
  listingKnowledge?: FactKnowledge;
}

export interface RentOpsPerson {
  id: string;
  /** Source-backed review uncertainty, never a subsidy amount or contract. */
  paymentReviewReason?: "assistance_responsibility_unverified" | null;
  paymentReviewArtifactSha256?: string | null;
  paymentReviewSourceReference?: string | null;
  recordRevision?: number;
  source?: SourceRef;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  phoneMethods?: RentOpsPhoneMethod[];
  renterInsuranceExpiresOn?: IsoDate;
  archived?: boolean | null;
  /** Target-local archived flag when RM omits an explicit archive state. */
  archivedKnowledge?: FactKnowledge;
  firstNameKnowledge?: FactKnowledge;
  lastNameKnowledge?: FactKnowledge;
  emailKnowledge?: FactKnowledge;
  phoneKnowledge?: FactKnowledge;
}

/** All RM phone methods are retained; `phone` is only the selected display
 * method and must never erase secondary/type/text-ready source facts. */
export interface RentOpsPhoneMethod {
  id?: string;
  value: string;
  type?: string;
  isPrimary?: boolean;
  isTextReady?: boolean;
}

export interface RentOpsHouseholdMembership {
  id: string;
  recordRevision?: number;
  tenancyId?: string;
  applicationId?: string;
  /** Exact tenant-account association when RM has no tenancy/application link. */
  accountPersonId?: string;
  personId: string;
  role?: "primary" | "co_applicant" | "occupant" | "minor" | "emergency_contact" | "other_contact" | null;
  relationship?: string | null;
  isFinanciallyResponsible?: boolean | null;
  roleKnowledge?: FactKnowledge;
  relationshipKnowledge?: FactKnowledge;
  responsibilityKnowledge?: FactKnowledge;
}

export interface RentOpsTenancy {
  id: string;
  recordRevision?: number;
  source?: SourceRef;
  propertyId: string;
  unitId: string;
  primaryPersonId: string;
  status: TenancyStatus;
  /** Prospective application intent; never treated as actual occupancy. */
  plannedMoveInOn?: IsoDate;
  actualMoveInOn?: IsoDate;
  noticeOn?: IsoDate;
  expectedMoveOutOn?: IsoDate;
  actualMoveOutOn?: IsoDate;
  createdAt: string;
  endedAt?: string;
  applicationId?: string;
  propertyLinkKnowledge?: LinkKnowledge;
  unitLinkKnowledge?: LinkKnowledge;
  primaryPersonLinkKnowledge?: LinkKnowledge;
  statusKnowledge?: FactKnowledge;
  plannedMoveInKnowledge?: FactKnowledge;
  actualMoveInKnowledge?: FactKnowledge;
  noticeKnowledge?: FactKnowledge;
  expectedMoveOutKnowledge?: FactKnowledge;
  actualMoveOutKnowledge?: FactKnowledge;
  createdAtKnowledge?: FactKnowledge;
  endedAtKnowledge?: FactKnowledge;
}

export interface RentOpsLeaseTerm {
  id: string;
  recordRevision?: number;
  tenancyId: string;
  source?: SourceRef;
  status: LeaseTermStatus;
  contractStartOn: IsoDate;
  contractEndOn?: IsoDate;
  monthToMonth: boolean;
  signedOn?: IsoDate;
  executedDocumentId?: string;
  renewalOfId?: string;
  createdAt: string;
  tenancyLinkKnowledge?: LinkKnowledge;
  statusKnowledge?: FactKnowledge;
  contractStartKnowledge?: FactKnowledge;
  contractEndKnowledge?: FactKnowledge;
  signedOnKnowledge?: FactKnowledge;
  monthToMonthKnowledge?: FactKnowledge;
  createdAtKnowledge?: FactKnowledge;
}

export interface RentOpsRecurringChargeSchedule {
  /** Null means cadence has not been explicitly configured. */
  billingFrequency?: "monthly" | null;
  id: string;
  recordRevision?: number;
  source?: SourceRef;
  /** Stable target identity for the polymorphic source scope. */
  scopeType?: RecurringScopeType | null;
  scopeId?: string | null;
  scopeTypeKnowledge?: FactKnowledge | null;
  scopeLinkKnowledge?: LinkKnowledge | null;
  /** RM charge definition identity; either/both may be present. */
  chargeDefinitionId?: string | null;
  chargeDefinitionKey?: string | null;
  tenancyId?: string | null;
  personId?: string | null;
  propertyId: string | null;
  unitId?: string | null;
  /** Runtime v8 may be null when categoryKnowledge is unknown; the legacy
   * structural type remains non-null for existing report callers until the
   * Phase 2 projection adapters consume the nullable DB column. */
  category: ChargeCategory | null;
  categoryKnowledge?: FactKnowledge | null;
  description?: string | null;
  descriptionKnowledge?: FactKnowledge | null;
  /** Runtime v8 may be null when amountKnowledge is unknown. */
  amountCents: Cents | null;
  amountKnowledge?: AmountKnowledge | null;
  effectiveFrom?: IsoDate | null;
  effectiveFromKnowledge?: RecurringDateKnowledge | null;
  effectiveTo?: IsoDate | null;
  active?: boolean | null;
  activeKnowledge?: FactKnowledge | null;
  sourceConfidence?: "confirmed" | "inferred" | "exception" | null;
  chargeDefinitionKnowledge?: FactKnowledge | null;
  chargeDefinitionLinkKnowledge?: LinkKnowledge | null;
  sourceArtifactSha256?: string | null;
  /** Approved artifact observation/configuration boundary used when a root
   * intentionally has an unknown open start. */
  artifactObservationOn?: IsoDate | null;
  /** Immutable append/version lineage. */
  lineageRootId: string;
  lineageRootOrigin: RecurringLineageRootOrigin;
  /** Imported roots are artifact rows; runtime roots and every successor are manual rows. */
  versionOrigin: RecurringVersionOrigin;
  supersedesId?: string | null;
  versionAction: "root" | "replace" | "end";
}

export interface RentOpsLedgerTransaction {
  id: string;
  source?: SourceRef;
  propertyId: string | null;
  unitId?: string | null;
  tenancyId?: string | null;
  personId?: string | null;
  kind: LedgerKind | null;
  category: ChargeCategory | null;
  categoryKnowledge?: FactKnowledge | null;
  status: LedgerStatus | null;
  amountCents: Cents | null;
  postedOn: IsoDate | null;
  dueOn?: IsoDate | null;
  paymentMethod?: PaymentMethod | null;
  paymentMethodKnowledge?: FactKnowledge | null;
  description: string | null;
  reversalOfId?: string | null;
  payer?: "tenant" | "agency" | "owner" | "unknown" | null;
  payerKnowledge?: FactKnowledge | null;
  adjustmentDirection?: AdjustmentDirection | null;
  propertyLinkKnowledge?: LinkKnowledge | null;
  unitLinkKnowledge?: LinkKnowledge | null;
  tenancyLinkKnowledge?: LinkKnowledge | null;
  personLinkKnowledge?: LinkKnowledge | null;
  amountKnowledge?: AmountKnowledge | null;
  postedOnKnowledge?: FactKnowledge | null;
  dueOnKnowledge?: FactKnowledge | null;
  descriptionKnowledge?: FactKnowledge | null;
  statusKnowledge?: FactKnowledge | null;
  allocationMode?: AllocationMode | null;
  chargeDefinitionId?: string | null;
  chargeDefinitionLinkKnowledge?: LinkKnowledge | null;
  sourceArtifactSha256?: string | null;
  artifactObservationOn?: IsoDate | null;
}

/** Operational definition identity.  `source` is server/importer-only and is
 * omitted by the positive browser DTO. */
export interface RentOpsChargeDefinition {
  id: string;
  source?: SourceRef;
  sourceArtifactSha256?: string | null;
  artifactObservationOn?: IsoDate | null;
  /** A source ChargeType row may have no name; preserve that SQL-null fact. */
  displayName?: string | null;
  displayNameKnowledge?: FactKnowledge | null;
  category: ChargeCategory | null;
  categoryKnowledge?: FactKnowledge | null;
  active?: boolean | null;
  activeKnowledge?: FactKnowledge | null;
  recordRevision?: number;
}

export interface RentOpsPaymentAllocation {
  id: string;
  kind?: "allocation" | "reversal" | "transfer" | "credit_allocation";
  sourcePropertyId?: string | null;
  creditTransactionId?: string | null;
  creditLinkKnowledge?: LinkKnowledge | null;
  sourceArtifactSha256?: string | null;
  artifactObservationOn?: IsoDate | null;
  source?: SourceRef;
  paymentTransactionId: string | null;
  chargeTransactionId: string | null;
  amountCents: Cents | null;
  allocatedOn: IsoDate | null;
  paymentLinkKnowledge?: LinkKnowledge | null;
  chargeLinkKnowledge?: LinkKnowledge | null;
  amountKnowledge?: AmountKnowledge | null;
  allocatedOnKnowledge?: FactKnowledge | null;
}

export interface RentOpsSecurityDeposit {
  id: string;
  recordRevision?: number;
  source?: SourceRef;
  propertyId: string;
  propertyLinkKnowledge?: LinkKnowledge;
  /** RM deposit summaries may omit UnitID; absence is retained as unknown. */
  unitId?: string;
  unitLinkKnowledge?: DepositUnitLinkKnowledge;
  /** A summary may be exact to a tenancy, or only to person + unit. */
  tenancyId?: string;
  personId: string;
  personLinkKnowledge?: LinkKnowledge;
  type?: DepositType;
  typeKnowledge?: FactKnowledge;
  amountHeldCents: Cents | null;
  /** Exact signed RM summary balance; a negative value is not cash held. */
  sourceBalanceCents?: Cents | null;
  receivedOn?: IsoDate;
  receivedOnKnowledge?: DepositDateKnowledge;
  dispositionStatus?: "held" | "partially_disposed" | "disposed" | "returned";
  dispositionStatusKnowledge?: FactKnowledge;
  disposedOn?: IsoDate;
  dispositionNotes?: string;
}

export interface RentOpsSubsidyContract {
  id: string;
  recordRevision?: number;
  source?: SourceRef;
  propertyId: string;
  unitId: string;
  tenancyId: string;
  agencyName: string;
  contractNumber?: string;
  effectiveFrom: IsoDate;
  effectiveTo?: IsoDate;
  agencyObligationCents: Cents;
  tenantObligationCents: Cents;
  status?: HapContractStatus;
  statusKnowledge?: FactKnowledge;
}

/** Exact `/SubsidyTenants` projection. Every relationship and fact remains
 * nullable in v3 so an orphan source row is retained without a guessed link. */
export interface RentOpsSubsidyTenant {
  id: string;
  source?: SourceRef;
  subsidyContractId?: string;
  subsidyContractLinkKnowledge?: LinkKnowledge;
  tenancyId?: string;
  tenancyLinkKnowledge?: LinkKnowledge;
  personId?: string;
  personLinkKnowledge?: LinkKnowledge;
  propertyId?: string;
  propertyLinkKnowledge?: LinkKnowledge;
  unitId?: string;
  unitLinkKnowledge?: LinkKnowledge;
  effectiveFrom?: IsoDate;
  effectiveFromKnowledge?: FactKnowledge;
  effectiveTo?: IsoDate;
  effectiveToKnowledge?: FactKnowledge;
  amountCents?: Cents;
  amountKnowledge?: AmountKnowledge;
  payer?: "tenant" | "agency" | "owner" | "unknown";
  payerKnowledge?: FactKnowledge;
  status?: HapContractStatus;
  statusKnowledge?: FactKnowledge;
}

/** Compatibility name for callers that call a contract member a tenant. */
export type RentOpsSubsidyContractMember = RentOpsSubsidyTenant;

/** Exact `/SubsidyPayments` projection. A generic ledger payment is linked
 * only from direct PaymentID evidence on this source row. */
export interface RentOpsSubsidyPayment {
  id: string;
  source?: SourceRef;
  subsidyContractId?: string;
  subsidyContractLinkKnowledge?: LinkKnowledge;
  subsidyTenantId?: string;
  subsidyTenantLinkKnowledge?: LinkKnowledge;
  tenancyId?: string;
  tenancyLinkKnowledge?: LinkKnowledge;
  personId?: string;
  personLinkKnowledge?: LinkKnowledge;
  propertyId?: string;
  propertyLinkKnowledge?: LinkKnowledge;
  unitId?: string;
  unitLinkKnowledge?: LinkKnowledge;
  paymentTransactionId?: string;
  paymentLinkKnowledge?: LinkKnowledge;
  paymentOn?: IsoDate;
  paymentOnKnowledge?: FactKnowledge;
  amountCents?: Cents;
  amountKnowledge?: AmountKnowledge;
  payer?: "tenant" | "agency" | "owner" | "unknown";
  payerKnowledge?: FactKnowledge;
  status?: HapPaymentStatus;
  statusKnowledge?: FactKnowledge;
}

/** A normalized status map is valid only for the exact export artifact that
 * produced it. It is never inferred from a description or row position. */
export interface RentManagerHapStatusCrosswalk {
  artifactSha256: string;
  sourceCollection: "Subsidies" | "SubsidyTenants" | "SubsidyPayments";
  sourceField: string;
  values: Record<string, HapContractStatus | HapPaymentStatus>;
}

export interface RentOpsApplication {
  id: string;
  recordRevision?: number;
  source?: SourceRef;
  sourceType: ApplicationSource;
  status: ApplicationStatus;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  propertyId?: string;
  unitId?: string;
  submittedOn?: IsoDate;
  certificationAcceptedOn?: IsoDate;
  convertedTenancyId?: string;
  createdAt: string;
  updatedAt: string;
  rentalHistory?: RentalHistory;
  employment?: EmploymentInfo;
  householdSummary?: HouseholdSummary;
  preferences?: ApplicationPreferences;
  voucher?: VoucherInfo;
  pets?: PetInfo[];
  vehicles?: VehicleInfo[];
  emergencyContact?: EmergencyContact;
  profileAnswers?: Record<string, unknown>;
  sourceTypeKnowledge?: FactKnowledge;
  statusKnowledge?: FactKnowledge;
  emailKnowledge?: FactKnowledge;
  firstNameKnowledge?: FactKnowledge;
  lastNameKnowledge?: FactKnowledge;
  phoneKnowledge?: FactKnowledge;
  propertyLinkKnowledge?: LinkKnowledge;
  unitLinkKnowledge?: LinkKnowledge;
  submittedOnKnowledge?: FactKnowledge;
  certificationAcceptedOnKnowledge?: FactKnowledge;
  createdAtKnowledge?: FactKnowledge;
  updatedAtKnowledge?: FactKnowledge;
}

/** Server-only persistence shape. Never serialize this type from an API route. */
export interface RentOpsApplicationRecord extends RentOpsApplication {
  resumeTokenHash?: string;
  resumeTokenExpiresAt?: string;
}

export interface RentalHistory {
  currentAddress?: string;
  priorAddress?: string;
  landlordName?: string;
  landlordContact?: string;
  reasonForMoving?: string;
}

export interface EmploymentInfo {
  employerName?: string;
  jobTitle?: string;
  monthlyIncomeCents?: Cents;
  employmentStartOn?: IsoDate;
}

export interface HouseholdSummary {
  adults: number;
  children: number;
  totalOccupants: number;
}

export interface ApplicationPreferences {
  desiredMoveInOn?: IsoDate;
  desiredLeaseMonths?: number;
  maxRentCents?: Cents;
  bedrooms?: number;
}

export interface VoucherInfo {
  hasVoucher: boolean;
  agencyName?: string;
  caseNumber?: string;
  tenantPortionCents?: Cents;
}

export interface PetInfo {
  type: string;
  name?: string;
  weightLb?: number;
}

export interface VehicleInfo {
  makeModel?: string;
  plateState?: string;
  plateLastFour?: string;
}

export interface EmergencyContact {
  name: string;
  phone: string;
  relationship?: string;
}

export interface RentOpsApplicationHouseholdMember {
  id: string;
  applicationId: string;
  firstName: string;
  lastName: string;
  relationship?: string;
  email?: string;
  phone?: string;
  isMinor: boolean;
}

export interface RentOpsApplicationRequirement {
  id: string;
  applicationId: string;
  key: string;
  label: string;
  status: ApplicationRequirementStatus;
  documentId?: string;
  requestedOn: IsoDate;
  resolvedOn?: IsoDate;
}

export interface RentOpsDocument {
  id: string;
  recordRevision?: number;
  source?: SourceRef;
  propertyId?: string;
  unitId?: string;
  personId?: string;
  tenancyId?: string;
  applicationId?: string;
  type: DocumentType;
  state: DocumentState;
  /** v3 source-fidelity markers; a missing marker is not a verified fact. */
  typeKnowledge?: FactKnowledge;
  stateKnowledge?: FactKnowledge;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  checksumSha256?: string;
  storageKey?: string;
  uploadedAt?: string;
  verifiedAt?: string;
  availability?: DocumentAvailability;
  storageKeyKnowledge?: FactKnowledge;
  metadataSizeBytes?: number;
  metadataChecksumSha256?: string;
}

/**
 * Server-only immutable object binding.  The browser never receives this
 * record: it is the database proof that the positive document row points at
 * the exact object generation that was transferred and verified.
 */
export interface RentOpsDocumentObjectBinding {
  documentId: string;
  /** Applicant uploads and restricted import transfers are separate trust domains. */
  bindingKind: "applicant" | "import" | "admin";
  /** Exact restricted source-binary row for an imported archive transfer. */
  sourceBinaryId?: string;
  /** Must be the import run referenced by sourceBinaryId for an import binding. */
  importRunId?: string;
  sourceSystem?: string;
  sourceCollection?: string;
  backend: string;
  logicalKey: string;
  checksumSha256: string;
  sizeBytes: number;
  immutableGeneration?: string;
  immutableVersion?: string;
  verifiedAt: string;
}

export interface RentOpsActivityEvent {
  id: string;
  recordRevision?: number;
  propertyId?: string;
  unitId?: string;
  personId?: string;
  tenancyId?: string;
  applicationId?: string;
  type: ActivityType;
  occurredAt: string;
  actor: string;
  summary: string;
  detail?: string;
  source?: SourceRef;
  occurredAtKnowledge?: FactKnowledge;
  actorKnowledge?: FactKnowledge;
  summaryKnowledge?: FactKnowledge;
  typeKnowledge?: FactKnowledge;
  propertyLinkKnowledge?: LinkKnowledge;
  unitLinkKnowledge?: LinkKnowledge;
  personLinkKnowledge?: LinkKnowledge;
  tenancyLinkKnowledge?: LinkKnowledge;
  applicationLinkKnowledge?: LinkKnowledge;
}

/**
 * v9 historical application/prospect projection.  These records are kept
 * separate from the current public-portal application model: RM source rows
 * are immutable occurrences, nullable when the export did not establish a
 * fact, and never merged by name or contact value.
 */
export const APPLICATION_HISTORY_BLOCKER_CODES = ["application_answers_missing"] as const;
export type ApplicationHistoryBlockerCode = (typeof APPLICATION_HISTORY_BLOCKER_CODES)[number];

export const APPLICATION_HISTORY_ORIGINS = ["source", "manual", "unknown"] as const;
export type ApplicationHistoryOrigin = (typeof APPLICATION_HISTORY_ORIGINS)[number];

export const APPLICATION_HISTORY_ANSWER_VALUE_TYPES = [
  "unknown",
  "text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "choice",
  "multi_choice",
  "money",
] as const;
export type ApplicationHistoryAnswerValueType = (typeof APPLICATION_HISTORY_ANSWER_VALUE_TYPES)[number];

export const APPLICATION_HISTORY_VALUE_KNOWLEDGE = ["known", "unknown", "ambiguous", "restricted"] as const;
export type ApplicationHistoryValueKnowledge = (typeof APPLICATION_HISTORY_VALUE_KNOWLEDGE)[number];

export type ApplicationHistoryAnswerValue = string | number | boolean | string[];

export interface RentOpsProspect {
  id: string;
  source: SourceRef;
  personId?: string | null;
  personLinkKnowledge?: LinkKnowledge | null;
  contactId?: string | null;
  contactLinkKnowledge?: LinkKnowledge | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string | null;
  statusKnowledge: FactKnowledge;
  createdOn?: IsoDate | null;
  createdOnKnowledge: FactKnowledge;
  updatedOn?: IsoDate | null;
  updatedOnKnowledge: FactKnowledge;
  recordRevision: number;
}

/** Historical source application. `status` is target-domain nullable; source
 * labels are never regex-mapped and are retained only in restricted input. */
export interface RentOpsHistoricalApplication {
  id: string;
  source: SourceRef;
  prospectId?: string | null;
  prospectLinkKnowledge?: LinkKnowledge | null;
  personId?: string | null;
  personLinkKnowledge?: LinkKnowledge | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  status: ApplicationStatus | null;
  statusKnowledge: FactKnowledge;
  submittedOn?: IsoDate | null;
  submittedOnKnowledge: FactKnowledge;
  createdOn?: IsoDate | null;
  createdOnKnowledge: FactKnowledge;
  updatedOn?: IsoDate | null;
  updatedOnKnowledge: FactKnowledge;
  recordRevision: number;
}

/** Compatibility name for callers that use the shorter historical label. */
export type RentOpsApplicationHistory = RentOpsHistoricalApplication;

/** One source InterestedRental occurrence.  `sourceOrder`/`sourceRank` are
 * preserved independently so response order is never mistaken for rank. */
export interface RentOpsApplicationInterest {
  id: string;
  source: SourceRef;
  prospectId?: string | null;
  prospectLinkKnowledge?: LinkKnowledge | null;
  applicationId?: string | null;
  applicationLinkKnowledge?: LinkKnowledge | null;
  propertyId?: string | null;
  propertyLinkKnowledge?: LinkKnowledge | null;
  unitId?: string | null;
  unitLinkKnowledge?: LinkKnowledge | null;
  sourceOrder: number | null;
  sourceRank: number | null;
  preference?: string | null;
  preferenceKnowledge: FactKnowledge;
  interestedOn?: IsoDate | null;
  interestedOnKnowledge: FactKnowledge;
  rentCents?: Cents | null;
  rentKnowledge: AmountKnowledge;
  bedrooms?: number | null;
  bedroomsKnowledge: FactKnowledge;
  status?: string | null;
  statusKnowledge: FactKnowledge;
  recordRevision: number;
}

/** Exact source participant/household occurrence. No name/email fan-out is
 * performed when an exact person link is unavailable. */
export interface RentOpsApplicationParticipant {
  id: string;
  source: SourceRef;
  prospectId?: string | null;
  prospectLinkKnowledge?: LinkKnowledge | null;
  applicationId?: string | null;
  applicationLinkKnowledge?: LinkKnowledge | null;
  personId?: string | null;
  personLinkKnowledge?: LinkKnowledge | null;
  sourceOrder: number | null;
  role?: string | null;
  roleKnowledge: FactKnowledge;
  relationship?: string | null;
  relationshipKnowledge: FactKnowledge;
  isMinor?: boolean | null;
  minorKnowledge: FactKnowledge;
  isFinanciallyResponsible?: boolean | null;
  financialResponsibilityKnowledge: FactKnowledge;
  origin: ApplicationHistoryOrigin;
  recordRevision: number;
}

/** A requirement occurrence, never a template definition. `status` and
 * dates stay nullable; no synthetic "requested" default is allowed. */
export interface RentOpsApplicationRequirementOccurrence {
  id: string;
  source: SourceRef;
  prospectId?: string | null;
  prospectLinkKnowledge?: LinkKnowledge | null;
  applicationId?: string | null;
  applicationLinkKnowledge?: LinkKnowledge | null;
  key?: string | null;
  label?: string | null;
  status?: ApplicationRequirementStatus | null;
  statusKnowledge: FactKnowledge;
  requestedOn?: IsoDate | null;
  requestedOnKnowledge: FactKnowledge;
  resolvedOn?: IsoDate | null;
  resolvedOnKnowledge: FactKnowledge;
  documentId?: string | null;
  documentLinkKnowledge?: LinkKnowledge | null;
  origin: Exclude<ApplicationHistoryOrigin, "unknown"> | "unknown";
  recordRevision: number;
}

/** Safe template/section/field definitions only. Definitions create zero
 * requirement or answer instances by themselves. */
export interface RentOpsApplicationTemplateDefinition {
  id: string;
  source: SourceRef;
  name?: string | null;
  nameKnowledge: FactKnowledge;
  active?: boolean | null;
  activeKnowledge: FactKnowledge;
  recordRevision: number;
}

export interface RentOpsApplicationTemplateSectionDefinition {
  id: string;
  source: SourceRef;
  templateId?: string | null;
  templateLinkKnowledge?: LinkKnowledge | null;
  name?: string | null;
  nameKnowledge: FactKnowledge;
  sourceOrder: number | null;
  recordRevision: number;
}

export interface RentOpsApplicationTemplateFieldDefinition {
  id: string;
  source: SourceRef;
  templateId?: string | null;
  templateLinkKnowledge?: LinkKnowledge | null;
  sectionId?: string | null;
  sectionLinkKnowledge?: LinkKnowledge | null;
  key?: string | null;
  label?: string | null;
  valueType?: ApplicationHistoryAnswerValueType | null;
  sensitive: boolean;
  sourceOrder: number | null;
  recordRevision: number;
}

export interface RentOpsApplicationAnswerOccurrence {
  id: string;
  source: SourceRef;
  prospectId?: string | null;
  prospectLinkKnowledge?: LinkKnowledge | null;
  applicationId?: string | null;
  applicationLinkKnowledge?: LinkKnowledge | null;
  fieldId?: string | null;
  fieldLinkKnowledge?: LinkKnowledge | null;
  valueType: ApplicationHistoryAnswerValueType;
  /** Safe allowlisted value only. Restricted/unmapped values have no value. */
  value?: ApplicationHistoryAnswerValue | null;
  valueKnowledge: ApplicationHistoryValueKnowledge;
  recordRevision: number;
}

export interface RentOpsApplicationHistoryDocument {
  id: string;
  source: SourceRef;
  prospectId?: string | null;
  prospectLinkKnowledge?: LinkKnowledge | null;
  applicationId?: string | null;
  applicationLinkKnowledge?: LinkKnowledge | null;
  type?: DocumentType | null;
  typeKnowledge: FactKnowledge;
  state?: DocumentState | null;
  stateKnowledge: FactKnowledge;
  fileName?: string | null;
  mimeType?: string | null;
  metadataSizeBytes?: number | null;
  metadataChecksumSha256?: string | null;
  /** Metadata rows never imply verified bytes. A verified state requires the
   * separate document-object binding contract and is intentionally excluded
   * from this metadata-only historical projection. */
  availability: Exclude<DocumentAvailability, "requested" | "verified">;
  recordRevision: number;
}

export interface RentOpsApplicationHistoryActivity {
  id: string;
  source: SourceRef;
  prospectId?: string | null;
  prospectLinkKnowledge?: LinkKnowledge | null;
  applicationId?: string | null;
  applicationLinkKnowledge?: LinkKnowledge | null;
  type?: ActivityType | null;
  occurredAt?: string | null;
  occurredAtKnowledge: FactKnowledge;
  actor?: string | null;
  actorKnowledge: FactKnowledge;
  summary?: string | null;
  summaryKnowledge: FactKnowledge;
  recordRevision: number;
}

export interface RentOpsApplicationHistoryBlocker {
  code: ApplicationHistoryBlockerCode;
  applicationId?: string | null;
  prospectId?: string | null;
  occurrenceCount: number;
  reason: "source_collection_missing" | "source_collection_empty" | "source_rows_unusable";
}

export interface RentOpsApplicationHistoryUnknownRestricted {
  restrictedAnswerCount: number;
  unmappedAnswerCount: number;
  missingAnswerApplications: number;
  metadataOnlyDocumentCount: number;
  unavailableDocumentCount: number;
  unlinkedActivityCount: number;
  unlinkedInterestCount: number;
}

export interface RentOpsApplicationHistorySnapshot {
  prospects: RentOpsProspect[];
  applications: RentOpsHistoricalApplication[];
  interests: RentOpsApplicationInterest[];
  participants: RentOpsApplicationParticipant[];
  requirements: RentOpsApplicationRequirementOccurrence[];
  templates: RentOpsApplicationTemplateDefinition[];
  templateSections: RentOpsApplicationTemplateSectionDefinition[];
  templateFields: RentOpsApplicationTemplateFieldDefinition[];
  answers: RentOpsApplicationAnswerOccurrence[];
  documents: RentOpsApplicationHistoryDocument[];
  activities: RentOpsApplicationHistoryActivity[];
  blockers: RentOpsApplicationHistoryBlocker[];
  unknownRestricted: RentOpsApplicationHistoryUnknownRestricted;
}

/** Internal case aggregate used by the admin-only positive route. */
export interface RentOpsApplicationCase {
  application?: RentOpsHistoricalApplication;
  prospect?: RentOpsProspect;
  interests: RentOpsApplicationInterest[];
  participants: RentOpsApplicationParticipant[];
  requirements: RentOpsApplicationRequirementOccurrence[];
  answers: RentOpsApplicationAnswerOccurrence[];
  documents: RentOpsApplicationHistoryDocument[];
  activities: RentOpsApplicationHistoryActivity[];
  blockers: RentOpsApplicationHistoryBlocker[];
  unknownRestricted: RentOpsApplicationHistoryUnknownRestricted;
}

export interface RentOpsSourceRecord {
  id: string;
  system: string;
  entityType: ImportEntityType;
  sourceId: string;
  sourceUpdatedAt?: string;
  importedAt: string;
  checksum?: string;
  targetId: string;
  rawMetadata?: Record<string, unknown>;
}

export interface RentOpsImportRun {
  id: string;
  system: string;
  startedAt: string;
  completedAt?: string;
  mode: "dry_run" | "apply";
  sourceManifestHash?: string;
  counts: Partial<Record<ImportEntityType, number>>;
  exceptionCount: number;
  status: "running" | "completed" | "failed";
}

export interface RentOpsSnapshot {
  properties: RentOpsProperty[];
  units: RentOpsUnit[];
  people: RentOpsPerson[];
  householdMemberships: RentOpsHouseholdMembership[];
  tenancies: RentOpsTenancy[];
  leaseTerms: RentOpsLeaseTerm[];
  chargeDefinitions: RentOpsChargeDefinition[];
  recurringSchedules: RentOpsRecurringChargeSchedule[];
  ledgerTransactions: RentOpsLedgerTransaction[];
  paymentAllocations: RentOpsPaymentAllocation[];
  securityDeposits: RentOpsSecurityDeposit[];
  subsidyContracts: RentOpsSubsidyContract[];
  subsidyTenants: RentOpsSubsidyTenant[];
  /** Additive alias used by contract-member terminology. */
  subsidyContractMembers?: RentOpsSubsidyTenant[];
  subsidyPayments: RentOpsSubsidyPayment[];
  applications: RentOpsApplicationRecord[];
  applicationHouseholdMembers: RentOpsApplicationHouseholdMember[];
  applicationRequirements: RentOpsApplicationRequirement[];
  documents: RentOpsDocument[];
  activityEvents: RentOpsActivityEvent[];
  sourceRecords: RentOpsSourceRecord[];
  importRuns: RentOpsImportRun[];
  /** Admin historical application/prospect projection; omitted from lean
   * snapshots and never serialized by public routes. */
  applicationHistory?: RentOpsApplicationHistorySnapshot;
  /** v3 is additive; v1/v2 snapshots omit this marker. */
  modelVersion?: 2 | 3;
}

export const emptyRentOpsSnapshot = (): RentOpsSnapshot => ({
  properties: [],
  units: [],
  people: [],
  householdMemberships: [],
  tenancies: [],
  leaseTerms: [],
  chargeDefinitions: [],
  recurringSchedules: [],
  ledgerTransactions: [],
  paymentAllocations: [],
  securityDeposits: [],
  subsidyContracts: [],
  subsidyTenants: [],
  subsidyContractMembers: [],
  subsidyPayments: [],
  applications: [],
  applicationHouseholdMembers: [],
  applicationRequirements: [],
  documents: [],
  activityEvents: [],
  sourceRecords: [],
  importRuns: [],
  modelVersion: 2,
});

export interface RentOpsFilters {
  /**
   * Operational reports may opt into the active portfolio. The omitted
   * value intentionally preserves the complete imported snapshot for
   * migration/audit callers; admin preview routes choose "active" explicitly.
   */
  propertyScope?: "active" | "all";
  propertyId?: string;
  unitId?: string;
  tenancyId?: string;
  personId?: string;
  asOfDate?: IsoDate;
  /** Inclusive receipt/activity range; supported only by flow reports. */
  fromDate?: IsoDate;
  toDate?: IsoDate;
  month?: IsoMonth;
  occupancy?: OccupancyState[];
  readiness?: ReadinessState[];
  listing?: ListingState[];
  balanceStatus?: "all" | "due" | "credit" | "zero";
  status?: string[];
  search?: string;
}

export const rentOpsFiltersSchema = z.object({
  propertyScope: z.enum(["active", "all"]).optional(),
  propertyId: idSchema.optional(),
  unitId: idSchema.optional(),
  tenancyId: idSchema.optional(),
  personId: idSchema.optional(),
  asOfDate: isoDateSchema.optional(),
  fromDate: isoDateSchema.optional(),
  toDate: isoDateSchema.optional(),
  month: isoMonthSchema.optional(),
  occupancy: z.array(z.enum(OCCUPANCY_STATES)).optional(),
  readiness: z.array(z.enum(READINESS_STATES)).optional(),
  listing: z.array(z.enum(LISTING_STATES)).optional(),
  balanceStatus: z.enum(["all", "due", "credit", "zero"]).optional(),
  status: z.array(z.string().min(1)).optional(),
  search: z.string().max(120).optional(),
}).strict();

export interface RentRollRow {
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitNumber: string;
  bedrooms?: number;
  bathrooms?: number;
  marketRentCents?: Cents;
  readiness: ReadinessState;
  listing: ListingState;
  occupancy: OccupancyState;
  currentPersonId?: string;
  currentTenantName?: string;
  futurePersonId?: string;
  futureTenantName?: string;
  tenancyId?: string;
  actualMoveInOn?: IsoDate;
  noticeOn?: IsoDate;
  expectedMoveOutOn?: IsoDate;
  actualMoveOutOn?: IsoDate;
  contractStartOn?: IsoDate;
  contractEndOn?: IsoDate;
  monthToMonth?: boolean;
  baseRentCents?: Cents;
  recurringFeesCents: Cents;
  subsidyCents: Cents;
  tenantPortionCents?: Cents;
  totalScheduledCents: Cents;
  balanceDueCents: Cents;
  oldestUnpaidRentOn?: IsoDate;
  exceptionCodes: string[];
}

export interface OccupancyRow {
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitNumber: string;
  occupancy: OccupancyState;
  readiness: ReadinessState;
  listing: ListingState;
  daysVacant?: number;
  tenancyId?: string;
  /** Unknown/ambiguous source relationships are retained but never treated as vacant. */
  exceptionCodes?: string[];
}

export interface ScheduledIncomeRow {
  propertyId: string | null;
  propertyName: string | null;
  unitId?: string | null;
  unitNumber?: string | null;
  tenancyId?: string | null;
  personId?: string | null;
  tenantName?: string | null;
  month: IsoMonth;
  category: ChargeCategory | null;
  description: string | null;
  amountCents: Cents | null;
  scheduleId: string;
  scopeType?: RecurringScopeType | null;
  chargeDefinitionId?: string | null;
  /** Legacy source keys are intentionally absent from positive report rows. */
  /** Unknown-open-start rows are usable for current configuration only. */
  effectiveFromKnowledge?: RecurringDateKnowledge | null;
  temporalUncertainty?: boolean;
  exceptionCodes?: string[];
  amountKnowledge?: AmountKnowledge | null;
  categoryKnowledge?: FactKnowledge | null;
  chargeDefinitionLinkKnowledge?: LinkKnowledge | null;
  known?: boolean;
  uncertain?: boolean;
  unclassified?: boolean;
}

export interface CollectedIncomeRow {
  propertyId: string | null;
  propertyName: string | null;
  unitId?: string | null;
  unitNumber?: string | null;
  tenancyId?: string | null;
  personId?: string | null;
  tenantName?: string | null;
  paymentTransactionId: string | null;
  chargeTransactionId: string | null;
  paymentOn: IsoDate | null;
  category: ChargeCategory | null;
  amountCents: Cents | null;
  description: string | null;
}

export interface ScheduledVsCollectedRow {
  propertyId: string | null;
  propertyName: string | null;
  month: IsoMonth;
  scheduledCents: Cents;
  collectedCents: Cents;
  varianceCents: Cents | null;
  scheduledKnownCents?: Cents;
  scheduledUncertainCents?: Cents;
  scheduledUnknownAmountCount?: number;
  collectedKnownCents?: Cents;
  collectedUncertainCents?: Cents;
  collectedUnknownAmountCount?: number;
  complete?: boolean;
  uncertaintyCodes?: string[];
}

export interface DelinquencyRow {
  propertyId: string;
  propertyName: string;
  unitId?: string;
  unitNumber?: string;
  tenancyId: string;
  personId: string;
  tenantName: string;
  rentOnlyBalanceCents: Cents;
  nonRentBalanceCents: Cents;
  grossBalanceCents: Cents;
  totalBalanceCents: Cents;
  netAccountBalanceCents: Cents;
  unappliedCashCents: Cents;
  prepaidCents: Cents;
  oldestUnpaidRentOn?: IsoDate;
  lastPaymentOn?: IsoDate;
  hasPromiseOrHold: boolean;
  noticeStatus?: string;
}

export interface LedgerRow {
  /** Opening rows are report-only, never ledger transactions. */
  rowType?: "transaction" | "opening_balance";
  openingBalanceCents?: Cents;
  transaction: RentOpsLedgerTransaction;
  allocatedCents: Cents;
  openCents: Cents;
  runningBalanceCents: Cents;
}

export interface LeaseExpirationRow {
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitNumber: string;
  tenancyId: string;
  personId: string;
  tenantName: string;
  contractEndOn?: IsoDate;
  monthToMonth: boolean;
  currentBaseRentCents?: Cents;
  noticeDeadlineOn?: IsoDate;
  actionStatus: "expiring" | "month_to_month" | "not_due";
}

export interface DepositLiabilityRow {
  propertyId: string;
  propertyName: string;
  unitId?: string;
  unitNumber?: string;
  tenancyId?: string;
  personId: string;
  tenantName: string;
  securityHeldCents: Cents | null;
  refundablePetHeldCents: Cents | null;
  otherRefundableHeldCents: Cents | null;
  totalHeldCents: Cents | null;
  sourceBalanceCents?: Cents | null;
  unknownHeldCount?: number;
  dispositionStatus: RentOpsSecurityDeposit["dispositionStatus"] | "none";
  unknownReceiptCount: number;
  hasUnknownReceiptDate: boolean;
  temporalUncertainty: boolean;
}

export interface HapRow {
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitNumber: string;
  tenancyId: string;
  tenantName: string;
  agencyName: string;
  month: IsoMonth;
  agencyObligationCents: Cents;
  tenantObligationCents: Cents;
  expectedTotalCents: Cents;
  receivedAgencyCents: Cents;
  varianceCents: Cents;
  exception: boolean;
  receiptCount?: number;
  knownReceiptCount?: number;
  unknownReceiptCount?: number;
  uncertainty?: boolean;
  uncertaintyCodes?: string[];
}

export interface ApplicantPipelineRow {
  id: string;
  displayName: string;
  propertyId?: string;
  propertyName?: string;
  unitId?: string;
  unitInterest?: string;
  submittedOn?: IsoDate;
  status: ApplicationStatus;
  missingItems: string[];
  daysInStage: number;
  source: ApplicationSource;
}

export interface DashboardSummary {
  asOfDate: IsoDate;
  propertyCount: number;
  unitCount: number;
  occupiedUnits: number;
  futurePreleasedUnits: number;
  genuineVacantUnits: number;
  readyVacantUnits: number;
  notReadyUnits: number;
  offMarketUnits: number;
  physicalOccupancyPercent: number;
  scheduledRentCents: Cents;
  scheduledRentConfirmedCents: Cents;
  scheduledRentUnresolvedCount: number;
  scheduledRentComplete: boolean;
  /** Recurring configuration is not a monthly projection without cadence evidence. */
  scheduledRentCadenceComplete: boolean;
  collectedRentCents: Cents;
  rentOnlyDelinquencyCents: Cents;
  totalDelinquencyCents: Cents;
  unappliedCashCents: Cents;
  expiringIn30Days: number;
  expiringIn60Days: number;
  expiringIn90Days: number;
  monthToMonthCount: number;
  applicationsSubmitted: number;
  applicationsMissingInformation: number;
  securityDepositLiabilityCents: Cents | null;
  drilldowns: Record<string, { report: string; filters: RentOpsFilters }>;
}

export interface TenantProfile {
  person: RentOpsPerson;
  household: RentOpsHouseholdMembership[];
  /** Current summary tenancy plus complete person-linked tenancy history. */
  tenancy?: RentOpsTenancy;
  /** Complete person-linked history when returned by the server. */
  tenancies?: RentOpsTenancy[];
  leaseTerms: RentOpsLeaseTerm[];
  schedules: RentOpsRecurringChargeSchedule[];
  ledger: LedgerRow[];
  deposits: RentOpsSecurityDeposit[];
  subsidyContracts: RentOpsSubsidyContract[];
  documents: RentOpsDocument[];
  activity: RentOpsActivityEvent[];
}

/** Backwards-compatible name for the client adapter while the module is integrated. */
export type RentOpsTenantProfile = TenantProfile;

export interface ApplicantPublicView {
  id: string;
  status: ApplicationStatus;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  propertyId?: string;
  unitId?: string;
  submittedOn?: IsoDate;
  certificationAcceptedOn?: IsoDate;
  rentalHistory?: RentalHistory;
  employment?: EmploymentInfo;
  householdSummary?: HouseholdSummary;
  preferences?: ApplicationPreferences;
  voucher?: VoucherInfo;
  pets?: PetInfo[];
  vehicles?: VehicleInfo[];
  emergencyContact?: EmergencyContact;
  householdMembers: RentOpsApplicationHouseholdMember[];
  requirements: RentOpsApplicationRequirement[];
  documents: Array<Pick<RentOpsDocument, "id" | "type" | "state" | "fileName" | "mimeType" | "sizeBytes" | "uploadedAt">>;
}

export interface ApplicantStartInput {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  currentAddress: string;
}

export interface ApplicantSaveInput {
  phone?: string;
  propertyId?: string;
  unitId?: string;
  rentalHistory?: RentalHistory;
  employment?: EmploymentInfo;
  householdSummary?: HouseholdSummary;
  preferences?: ApplicationPreferences;
  voucher?: VoucherInfo;
  pets?: PetInfo[];
  vehicles?: VehicleInfo[];
  emergencyContact?: EmergencyContact;
}

export interface ApplicantHouseholdMemberInput {
  id?: string;
  firstName: string;
  lastName: string;
  relationship?: string;
  email?: string;
  phone?: string;
  isMinor: boolean;
}

export interface ApplicantDocumentMetadataInput {
  type: DocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  checksumSha256?: string;
}

export const applicantStartSchema = z.object({
  email: z.string().email().max(240),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(3).max(40),
  currentAddress: z.string().trim().min(1).max(240),
}).strict();

const rentalHistorySchema = z.object({
  currentAddress: z.string().max(240).optional(),
  priorAddress: z.string().max(240).optional(),
  landlordName: z.string().max(120).optional(),
  landlordContact: z.string().max(160).optional(),
  reasonForMoving: z.string().max(500).optional(),
}).strict();

const employmentSchema = z.object({
  employerName: z.string().max(160).optional(),
  jobTitle: z.string().max(120).optional(),
  monthlyIncomeCents: centsSchema.nonnegative().optional(),
  employmentStartOn: isoDateSchema.optional(),
}).strict();

const householdSummarySchema = z.object({ adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(20), totalOccupants: z.number().int().min(1).max(40) }).strict();
const preferencesSchema = z.object({ desiredMoveInOn: isoDateSchema.optional(), desiredLeaseMonths: z.number().int().min(1).max(60).optional(), maxRentCents: centsSchema.nonnegative().optional(), bedrooms: z.number().int().min(0).max(20).optional() }).strict();
const voucherSchema = z.object({ hasVoucher: z.boolean(), agencyName: z.string().max(160).optional(), caseNumber: z.string().max(100).optional(), tenantPortionCents: centsSchema.nonnegative().optional() }).strict();
const petSchema = z.object({ type: z.string().trim().min(1).max(80), name: z.string().max(80).optional(), weightLb: z.number().finite().nonnegative().max(1000).optional() }).strict();
const vehicleSchema = z.object({ makeModel: z.string().max(120).optional(), plateState: z.string().max(2).optional(), plateLastFour: z.string().regex(/^\d{0,4}$/).optional() }).strict();
const emergencyContactSchema = z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(3).max(40), relationship: z.string().max(80).optional() }).strict();

export const applicantSaveSchema = z.object({
  phone: z.string().trim().max(40).optional(),
  propertyId: idSchema.optional(),
  unitId: idSchema.optional(),
  rentalHistory: rentalHistorySchema.optional(),
  employment: employmentSchema.optional(),
  householdSummary: householdSummarySchema.optional(),
  preferences: preferencesSchema.optional(),
  voucher: voucherSchema.optional(),
  pets: z.array(petSchema).max(20).optional(),
  vehicles: z.array(vehicleSchema).max(20).optional(),
  emergencyContact: emergencyContactSchema.optional(),
}).strict();

export const applicantCertificationSchema = z.object({
  certify: z.literal(true),
}).strict();

export const applicationStatusSchema = z.object({
  revision: z.number().int().min(1),
  status: z.enum(APPLICATION_STATUSES),
  note: z.string().max(1000).optional(),
}).strict();

/** Admin-owned record kinds that support sparse, revision-checked edits. */
export const RENT_OPS_PATCH_ENTITY_TYPES = [
  "charge_definition",
  "property",
  "unit",
  "person",
  "household_membership",
  "tenancy",
  "lease_term",
  "security_deposit",
  "subsidy_contract",
  "application",
  "document",
  "activity",
] as const;
export type RentOpsPatchEntityType = (typeof RENT_OPS_PATCH_ENTITY_TYPES)[number];
export const RENT_OPS_RECORD_CHANGE_ENTITY_TYPES = [...RENT_OPS_PATCH_ENTITY_TYPES, "recurring_schedule"] as const;
export type RentOpsRecordChangeEntityType = (typeof RENT_OPS_RECORD_CHANGE_ENTITY_TYPES)[number];

export interface RentOpsRecordChange {
  id: string;
  entityType: RentOpsRecordChangeEntityType;
  targetId: string;
  revision: number;
  origin: "admin" | "system" | "applicant";
  /** Admin mutations carry the authenticated subject; future system/applicant
   * writers may intentionally have no human subject. */
  actorSubject?: string;
  occurredAt: string;
  /** Sorted field names only. Values, source IDs, and PII never enter this row. */
  changedFields: string[];
}

export interface RentOpsRecordPatchUpdate {
  entityType: RentOpsPatchEntityType;
  targetId: string;
  expectedRevision: number;
  nextRevision: number;
  /** SQL adapter receives only positive allowlisted persistence columns. */
  values: Record<string, unknown>;
}

export interface RentOpsRepository {
  /** Runs a multi-record business operation atomically. */
  transaction<T>(work: (repository: RentOpsRepository) => Promise<T>, options?: RentOpsTransactionOptions): Promise<T>;
  getSnapshot(): Promise<RentOpsSnapshot>;
  saveProperty(property: RentOpsProperty): Promise<RentOpsProperty>;
  saveUnit(unit: RentOpsUnit): Promise<RentOpsUnit>;
  savePerson(person: RentOpsPerson): Promise<RentOpsPerson>;
  saveHouseholdMembership(membership: RentOpsHouseholdMembership): Promise<RentOpsHouseholdMembership>;
  getApplicationById(id: string): Promise<RentOpsApplicationRecord | undefined>;
  getApplicationByResumeTokenHash(hash: string): Promise<RentOpsApplicationRecord | undefined>;
  getApplicationHistoryCaseById(id: string): Promise<RentOpsApplicationCase | undefined>;
  saveApplication(application: RentOpsApplicationRecord): Promise<RentOpsApplicationRecord>;
  saveApplicationHistory(history: RentOpsApplicationHistorySnapshot): Promise<void>;
  saveApplicationHouseholdMember(member: RentOpsApplicationHouseholdMember): Promise<RentOpsApplicationHouseholdMember>;
  saveApplicationRequirement(requirement: RentOpsApplicationRequirement): Promise<RentOpsApplicationRequirement>;
  saveTenancy(tenancy: RentOpsTenancy): Promise<RentOpsTenancy>;
  saveLeaseTerm(term: RentOpsLeaseTerm): Promise<RentOpsLeaseTerm>;
  saveChargeDefinition?(definition: RentOpsChargeDefinition): Promise<RentOpsChargeDefinition>;
  saveRecurringSchedule(schedule: RentOpsRecurringChargeSchedule): Promise<RentOpsRecurringChargeSchedule>;
  /** Atomic manual-root create plus its authenticated redacted change row. */
  saveRecurringScheduleRoot(input: { schedule: RentOpsRecurringChargeSchedule; change: RentOpsRecordChange }): Promise<RentOpsRecurringChargeSchedule>;
  saveRecurringScheduleSuccessor(input: { predecessorId: string; successor: RentOpsRecurringChargeSchedule; expectedRevision: number; change: RentOpsRecordChange }): Promise<RentOpsRecurringChargeSchedule>;
  saveLedgerTransaction(transaction: RentOpsLedgerTransaction): Promise<RentOpsLedgerTransaction>;
  savePaymentAllocation(allocation: RentOpsPaymentAllocation): Promise<RentOpsPaymentAllocation>;
  saveSecurityDeposit(deposit: RentOpsSecurityDeposit): Promise<RentOpsSecurityDeposit>;
  saveSubsidyContract(contract: RentOpsSubsidyContract): Promise<RentOpsSubsidyContract>;
  saveSubsidyTenant(tenant: RentOpsSubsidyTenant): Promise<RentOpsSubsidyTenant>;
  saveSubsidyPayment(payment: RentOpsSubsidyPayment): Promise<RentOpsSubsidyPayment>;
  saveDocument(document: RentOpsDocument): Promise<RentOpsDocument>;
  /** Optional document-storage extension; production Postgres implements it. */
  saveDocumentObjectBinding?(binding: RentOpsDocumentObjectBinding): Promise<RentOpsDocumentObjectBinding>;
  getDocumentObjectBinding?(documentId: string): Promise<RentOpsDocumentObjectBinding | undefined>;
  saveActivity(event: RentOpsActivityEvent): Promise<RentOpsActivityEvent>;
  /** Applies an already-validated sparse patch inside the caller's transaction. */
  applyRecordPatch?(update: RentOpsRecordPatchUpdate): Promise<void>;
  /** Appends the redacted revision row in the same transaction as the patch. */
  saveRecordChange?(change: RentOpsRecordChange): Promise<void>;
  getRecordChanges?(): Promise<RentOpsRecordChange[]>;
}

/**
 * Optional row locks requested by a business operation. The SQL adapter turns
 * these into SELECT ... FOR UPDATE statements inside the same transaction;
 * the synthetic adapter intentionally ignores them because it commits a
 * staged copy synchronously.
 */
export interface RentOpsTransactionOptions {
  lockApplicationId?: string;
  lockTransactionIds?: string[];
  /** Shared with Stripe: serialize financial writes for the whole person account. */
  lockAccountPersonId?: string;
  /** One target row is locked with SELECT ... FOR UPDATE before a patch merge. */
  lockRecord?: { entityType: RentOpsPatchEntityType; targetId: string };
  /** Serialize tenancy occupancy invariants for every tenancy on the target unit. */
  lockTenancySiblings?: boolean;
  /** Additional unit IDs touched by a tenancy move; locked with the old unit set. */
  lockTenancyUnitIds?: string[];
  /** Serialize lease-overlap invariants for every lease on the target tenancy. */
  lockLeaseSiblings?: boolean;
  /** Additional tenancy IDs touched by a lease move; locked with the old tenancy set. */
  lockLeaseTenancyIds?: string[];
}

export interface RentOpsRouteOptions {
  repository: RentOpsRepository;
  requireAdmin?: import("express").RequestHandler;
  now?: () => Date;
  /** Source label shown by the manager preview context; production defaults to live. */
  previewSource?: "live" | "synthetic";
  resumeTokenTtlMs?: number;
  enableDemoGuard?: boolean;
  resumeTokenNotifier?: (input: { applicationId: string; email: string; token: string; expiresAt: string }) => Promise<void>;
  exposeResumeToken?: boolean;
  /** Inject a shared limiter (for example Redis-backed) in multi-instance production. */
  publicRateLimiter?: import("express").RequestHandler;
  /** Content-addressed private document store. Production must inject one. */
  documentStorage?: unknown;
  /** Alias retained for adapters that name the seam `documentStore`. */
  documentStore?: unknown;
  /** Dedicated upload-writer store. Keep the admin/runtime store read-only. */
  documentUploadStorage?: unknown;
  /** Alias retained for adapters that name the seam `documentUploadStore`. */
  documentUploadStore?: unknown;
  /** Maximum applicant upload body; the storage adapter enforces its own limit too. */
  documentUploadMaxBytes?: number;
}

export interface ImportSourceRecordInput {
  entityType: ImportEntityType;
  sourceId: string;
  sourceUpdatedAt?: string;
  rawMetadata?: Record<string, unknown>;
}

export interface RentManagerRawRecord {
  entityType: ImportEntityType | string;
  sourceId: string | number;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface RentManagerChargeTypeDefinition {
  sourceId: string;
  /** Raw source label is importer/restricted only. */
  name?: string;
  displayName?: string;
  category: ChargeCategory | null;
  categoryKnowledge?: FactKnowledge;
  active?: boolean | null;
  activeKnowledge?: FactKnowledge;
  artifactSha256?: string;
}

/** Exact, externally approved historical-application status semantics. */
export interface RentManagerApplicationStatusCrosswalkEntry {
  artifactSha256: string;
  sourceCollection: string;
  sourceField: "status" | "Status" | "ApplicationStatus";
  sourceValue: string;
  targetStatus: ApplicationStatus;
}

export interface RentManagerFinancialReviewHold {
  tenantSourceId: string;
  reason: "assistance_responsibility_unverified";
  artifactSha256: string;
  evidenceCollection: "tenants" | "payments";
  evidenceSourceId: string;
  evidenceRecordSha256: string;
  sourceReference: string;
}

export interface RentManagerImportInput {
  financialReviewHolds?: RentManagerFinancialReviewHold[];
  properties?: RentManagerRawRecord[];
  units?: RentManagerRawRecord[];
  tenants?: RentManagerRawRecord[];
  /** Tenant-parent contacts only; prospect/vendor/owner contacts stay in the restricted archive. */
  contacts?: RentManagerRawRecord[];
  leases?: RentManagerRawRecord[];
  leaseTerms?: RentManagerRawRecord[];
  recurringSchedules?: RentManagerRawRecord[];
  charges?: RentManagerRawRecord[];
  payments?: RentManagerRawRecord[];
  credits?: RentManagerRawRecord[];
  allocations?: RentManagerRawRecord[];
  deposits?: RentManagerRawRecord[];
  subsidies?: RentManagerRawRecord[];
  /** Exact `/SubsidyTenants` child rows. */
  subsidyTenants?: RentManagerRawRecord[];
  /** Exact `/SubsidyPayments` child rows. */
  subsidyPayments?: RentManagerRawRecord[];
  /** Legacy combined child-row alias retained for restricted archive replay. */
  hap?: RentManagerRawRecord[];
  hapStatusCrosswalk?: RentManagerHapStatusCrosswalk[];
  applications?: RentManagerRawRecord[];
  applicationHistoryStatusCrosswalk?: RentManagerApplicationStatusCrosswalkEntry[];
  documents?: RentManagerRawRecord[];
  activities?: RentManagerRawRecord[];
  chargeTypes?: RentManagerChargeTypeDefinition[];
  /** One artifact-bound semantic crosswalk is authoritative. The array form
   * remains accepted for archive compatibility; import code must select and
   * validate exactly one artifact before applying a semantic lookup. */
  financialSemanticCrosswalk?: RentManagerFinancialSemanticCrosswalk | RentManagerFinancialSemanticCrosswalk[];
  /** Trusted observation/configuration boundary supplied by the artifact
   * manifest; never inferred from an import timestamp. */
  artifactObservationOn?: IsoDate;
}

export interface ImportMappingException {
  code: string;
  severity: ReconciliationSeverity;
  entityType?: ImportEntityType;
  sourceId?: string;
  message: string;
  amountCents?: Cents;
}

export interface RentManagerImportResult {
  snapshot: RentOpsSnapshot;
  sourceRecords: RentOpsSourceRecord[];
  importRun: RentOpsImportRun;
  exceptions: ImportMappingException[];
  /** The exact artifact-bound financial crosswalk used during mapping. */
  financialSemanticCrosswalk?: RentManagerFinancialSemanticCrosswalk;
}

export interface RentManagerTargetIdentityOptions {
  /** Explicit key identity, safe to report without exposing key material. */
  keyId?: string;
  keyVersion?: string;
}

export interface ReconciliationMismatch {
  code: string;
  severity: ReconciliationSeverity;
  metric: string;
  expected?: number;
  actual?: number;
  amountCents?: Cents;
  message: string;
}

export interface ReconciliationReport {
  passed: boolean;
  mismatches: ReconciliationMismatch[];
  counts: Record<string, { expected: number; actual: number }>;
  totalsCents: Record<string, { expected: Cents; actual: Cents }>;
}

export type FixedReportName =
  | "rent-roll"
  | "occupancy"
  | "scheduled-income"
  | "collected-income"
  | "scheduled-vs-collected"
  | "delinquency"
  | "tenant-ledger"
  | "lease-expirations"
  | "deposits"
  | "lease-expiration"
  | "security-deposit"
  | "applicant-pipeline"
  | "hap";
