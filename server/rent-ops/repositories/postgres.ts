import { createHash } from "node:crypto";
import type {
  RentOpsActivityEvent,
  RentOpsChargeDefinition,
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
  RentOpsProspect,
  RentOpsApplicationRecord,
  RentOpsApplicationHouseholdMember,
  RentOpsApplicationRequirement,
  RentOpsDocument,
  RentOpsDocumentObjectBinding,
  RentOpsHouseholdMembership,
  RentOpsLeaseTerm,
  RentOpsLedgerTransaction,
  RentOpsPaymentAllocation,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsRepository,
  RentOpsRecordChange,
  RentOpsRecordPatchUpdate,
  RentOpsPatchEntityType,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsSubsidyContract,
  RentOpsSubsidyTenant,
  RentOpsSubsidyPayment,
  RentOpsTenancy,
  RentOpsUnit,
  RentOpsTransactionOptions,
} from "../../../shared/rent-ops-contracts";
import { emptyRentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { RENT_OPS_REQUIRED_TABLES, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { assertPositiveCents, assertCents, assertValidSnapshot, documentReferenceViolations, assertPrivateStorageKey, RentOpsInvariantError } from "../domain/invariants";
import { assertValidApplicationHistory } from "../domain/application-history";
import { applicationHistoryCase } from "../application-history/projection";

/**
 * Small adapter interface accepted by node-postgres, Neon Pool, or a wrapper
 * around Drizzle's execute method. No connection is created here.
 */
export interface RentOpsQueryExecutor {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  /** Optional repeatable-read boundary for coherent reads and atomic writes. */
  transaction?<T>(work: (executor: RentOpsQueryExecutor) => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
}

export class RentOpsTablesMissingError extends Error {
  readonly missingTables: string[];

  constructor(missingTables: string[]) {
    super(`Rent Operations tables are missing: ${missingTables.join(", ")}. Run the explicit v1 migration before enabling production routes.`);
    this.name = "RentOpsTablesMissingError";
    this.missingTables = missingTables;
  }
}

export class RentOpsRuntimePrivilegeError extends Error {
  constructor() {
    super("Rent Operations runtime role has a forbidden table privilege");
    this.name = "RentOpsRuntimePrivilegeError";
  }
}

const tableNames = new Set<string>(RENT_OPS_RUNTIME_REQUIRED_TABLES);
const patchTables: Record<RentOpsPatchEntityType, string> = {
  property: "rent_ops_properties",
  unit: "rent_ops_units",
  person: "rent_ops_people",
  household_membership: "rent_ops_household_memberships",
  tenancy: "rent_ops_tenancies",
  lease_term: "rent_ops_lease_terms",
  security_deposit: "rent_ops_security_deposits",
  subsidy_contract: "rent_ops_subsidy_contracts",
  application: "rent_ops_applications",
  document: "rent_ops_documents",
  activity: "rent_ops_activity_events",
};
/** Runtime admin POSTs are create-only.  Importer persistence has its own
 * archive/upsert path and never enters these repository methods. */
const runtimeCreateOnlyTables = new Set([
  "rent_ops_properties",
  "rent_ops_units",
  "rent_ops_people",
  "rent_ops_household_memberships",
  "rent_ops_tenancies",
  "rent_ops_lease_terms",
  "rent_ops_recurring_charge_schedules",
  "rent_ops_security_deposits",
  "rent_ops_subsidy_contracts",
  "rent_ops_documents",
]);
const patchColumns: Record<RentOpsPatchEntityType, ReadonlySet<string>> = {
  property: new Set(["name", "slug", "address_line1", "address_line2", "city", "state", "postal_code", "property_type", "state_status", "operating_contact", "name_knowledge", "address_knowledge", "property_type_knowledge", "state_knowledge", "operating_contact_knowledge"]),
  unit: new Set(["property_id", "unit_number", "unit_type", "bedrooms", "bathrooms", "square_feet", "market_rent_cents", "default_deposit_cents", "readiness", "listing", "amenities", "access_notes", "property_link_knowledge", "unit_number_knowledge", "unit_type_knowledge", "readiness_knowledge", "listing_knowledge"]),
  person: new Set(["first_name", "last_name", "email", "phone", "renter_insurance_expires_on", "archived", "first_name_knowledge", "last_name_knowledge", "email_knowledge", "phone_knowledge", "archived_knowledge"]),
  household_membership: new Set(["tenancy_id", "application_id", "account_person_id", "person_id", "role", "relationship", "is_financially_responsible", "role_knowledge", "relationship_knowledge", "responsibility_knowledge"]),
  tenancy: new Set(["property_id", "unit_id", "primary_person_id", "status", "planned_move_in_on", "actual_move_in_on", "notice_on", "expected_move_out_on", "actual_move_out_on", "application_id", "ended_at", "property_link_knowledge", "unit_link_knowledge", "primary_person_link_knowledge", "status_knowledge", "planned_move_in_knowledge", "actual_move_in_knowledge", "notice_knowledge", "expected_move_out_knowledge", "actual_move_out_knowledge", "ended_at_knowledge"]),
  lease_term: new Set(["tenancy_id", "status", "contract_start_on", "contract_end_on", "month_to_month", "signed_on", "executed_document_id", "renewal_of_id", "tenancy_link_knowledge", "status_knowledge", "contract_start_knowledge", "contract_end_knowledge", "signed_on_knowledge", "month_to_month_knowledge"]),
  security_deposit: new Set(["property_id", "unit_id", "tenancy_id", "person_id", "type", "amount_held_cents", "source_balance_cents", "received_on", "disposition_status", "disposed_on", "disposition_notes", "property_link_knowledge", "unit_link_knowledge", "person_link_knowledge", "type_knowledge", "received_on_knowledge", "disposition_status_knowledge"]),
  subsidy_contract: new Set(["status", "status_knowledge"]),
  application: new Set(["status", "email", "first_name", "last_name", "phone", "property_id", "unit_id", "submitted_on", "certification_accepted_on", "rental_history", "employment", "household_summary", "preferences", "voucher", "pets", "vehicles", "emergency_contact", "profile_answers", "status_knowledge", "email_knowledge", "first_name_knowledge", "last_name_knowledge", "phone_knowledge", "property_link_knowledge", "unit_link_knowledge", "submitted_on_knowledge", "certification_accepted_on_knowledge"]),
  document: new Set(["property_id", "unit_id", "person_id", "tenancy_id", "application_id", "type", "type_knowledge", "state", "state_knowledge", "file_name", "mime_type"]),
  activity: new Set(["property_id", "unit_id", "person_id", "tenancy_id", "application_id", "type", "summary", "detail", "type_knowledge", "summary_knowledge", "property_link_knowledge", "unit_link_knowledge", "person_link_knowledge", "tenancy_link_knowledge", "application_link_knowledge"]),
};
/** Tables deliberately invisible to the runtime role. */
const runtimeForbiddenTables = RENT_OPS_REQUIRED_TABLES.filter((table) => !RENT_OPS_RUNTIME_REQUIRED_TABLES.includes(table));

const chargeDefinitionColumns = [
  "id", "display_name", "display_name_knowledge", "category", "category_knowledge", "active", "active_knowledge",
  "record_revision", "source_artifact_sha256", "artifact_observation_on", "source_system", "source_id",
] as const;

const recurringScheduleColumns = [
  "id", "scope_type", "scope_id", "scope_type_knowledge", "scope_link_knowledge", "charge_definition_id", "charge_definition_key",
  "tenancy_id", "person_id", "property_id", "unit_id", "category", "category_knowledge", "description", "description_knowledge",
  "amount_cents", "amount_knowledge", "effective_from", "effective_from_knowledge", "effective_to", "active", "active_knowledge",
  "source_confidence", "charge_definition_knowledge", "charge_definition_link_knowledge", "source_artifact_sha256", "artifact_observation_on",
  "lineage_root_id", "lineage_root_origin", "version_origin", "supersedes_id", "version_action", "record_revision", "source_system", "source_id",
] as const;

/** v9 history is an immutable importer-owned projection.  These column
 * lists are shared by the insert/replay checks so a retry compares the exact
 * persisted payload and never takes an UPDATE path through the immutable
 * database triggers. */
const historyProspectColumns = [
  "id", "source_system", "source_id", "source_updated_at", "person_id", "person_link_knowledge", "contact_id", "contact_link_knowledge",
  "first_name", "last_name", "email", "phone", "status", "status_knowledge", "created_on", "created_on_knowledge", "updated_on", "updated_on_knowledge", "record_revision",
] as const;
const historyApplicationColumns = [
  "id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "person_id", "person_link_knowledge",
  "first_name", "last_name", "email", "phone", "status", "status_knowledge", "submitted_on", "submitted_on_knowledge", "created_on", "created_on_knowledge", "updated_on", "updated_on_knowledge", "record_revision",
] as const;
const historyInterestColumns = [
  "id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge",
  "source_order", "source_rank", "preference", "preference_knowledge", "interested_on", "interested_on_knowledge", "rent_cents", "rent_knowledge", "bedrooms", "bedrooms_knowledge", "status", "status_knowledge", "record_revision",
] as const;
const historyParticipantColumns = [
  "id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "person_id", "person_link_knowledge", "source_order",
  "role", "role_knowledge", "relationship", "relationship_knowledge", "is_minor", "minor_knowledge", "is_financially_responsible", "financial_responsibility_knowledge", "origin", "record_revision",
] as const;
const historyRequirementColumns = [
  "id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "key", "label", "status", "status_knowledge",
  "requested_on", "requested_on_knowledge", "resolved_on", "resolved_on_knowledge", "document_id", "document_link_knowledge", "origin", "record_revision",
] as const;
const historyTemplateColumns = ["id", "source_system", "source_id", "source_updated_at", "name", "name_knowledge", "active", "active_knowledge", "record_revision"] as const;
const historySectionColumns = ["id", "source_system", "source_id", "source_updated_at", "template_id", "template_link_knowledge", "name", "name_knowledge", "source_order", "record_revision"] as const;
const historyFieldColumns = ["id", "source_system", "source_id", "source_updated_at", "template_id", "template_link_knowledge", "section_id", "section_link_knowledge", "key", "label", "value_type", "sensitive", "source_order", "record_revision"] as const;
const historyAnswerColumns = ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "field_id", "field_link_knowledge", "value_type", "safe_value", "value_knowledge", "record_revision"] as const;
const historyDocumentColumns = ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "type", "type_knowledge", "state", "state_knowledge", "file_name", "mime_type", "metadata_size_bytes", "metadata_checksum_sha256", "availability", "record_revision"] as const;
const historyActivityColumns = ["id", "source_system", "source_id", "source_updated_at", "prospect_id", "prospect_link_knowledge", "application_id", "application_link_knowledge", "type", "occurred_at", "occurred_at_knowledge", "actor", "actor_knowledge", "summary", "summary_knowledge", "record_revision"] as const;
const historyBlockerColumns = ["id", "code", "application_id", "prospect_id", "occurrence_count", "reason"] as const;
const historyAggregateColumns = ["id", "restricted_answer_count", "unmapped_answer_count", "missing_answer_applications", "metadata_only_document_count", "unavailable_document_count", "unlinked_activity_count", "unlinked_interest_count", "record_revision"] as const;
const HISTORY_AGGREGATE_ID = "rent-ops-application-history";

type HistoryInsertDescriptor = {
  table: string;
  columns: readonly string[];
  rows: readonly unknown[][];
};

const recurringChangeFields = new Set([
  "scopeType", "scopeId", "scopeTypeKnowledge", "scopeLinkKnowledge", "chargeDefinitionId", "chargeDefinitionKey",
  "tenancyId", "personId", "propertyId", "unitId", "category", "categoryKnowledge", "description", "descriptionKnowledge",
  "amountCents", "amountKnowledge", "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "active", "activeKnowledge",
  "sourceConfidence", "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge", "artifactObservationOn", "lineageRootId",
  "lineageRootOrigin", "versionOrigin", "supersedesId", "versionAction", "recordRevision",
]);

function chargeDefinitionValues(value: RentOpsChargeDefinition): unknown[] {
  return [
    value.id, value.displayName ?? null, value.displayNameKnowledge ?? null, value.category ?? null, value.categoryKnowledge ?? null,
    value.active ?? null, value.activeKnowledge ?? null, value.recordRevision ?? 1, value.sourceArtifactSha256 ?? null,
    value.artifactObservationOn ?? null, value.source?.system ?? null, value.source?.sourceId ?? null,
  ];
}

function recurringScheduleValues(value: RentOpsRecurringChargeSchedule): unknown[] {
  return [
    value.id, value.scopeType ?? null, value.scopeId ?? null, value.scopeTypeKnowledge ?? null, value.scopeLinkKnowledge ?? null,
    value.chargeDefinitionId ?? null, value.chargeDefinitionKey ?? null, value.tenancyId ?? null, value.personId ?? null,
    value.propertyId ?? null, value.unitId ?? null, value.category ?? null, value.categoryKnowledge ?? null, value.description ?? null,
    value.descriptionKnowledge ?? null, value.amountCents ?? null, value.amountKnowledge ?? null, value.effectiveFrom ?? null,
    value.effectiveFromKnowledge ?? null, value.effectiveTo ?? null, value.active ?? null, value.activeKnowledge ?? null,
    value.sourceConfidence ?? null, value.chargeDefinitionKnowledge ?? null, value.chargeDefinitionLinkKnowledge ?? null,
    value.sourceArtifactSha256 ?? null, value.artifactObservationOn ?? null, value.lineageRootId, value.lineageRootOrigin, value.versionOrigin,
    value.supersedesId ?? null, value.versionAction, value.recordRevision ?? 1, value.source?.system ?? null, value.source?.sourceId ?? null,
  ];
}

function samePersistedValue(actual: unknown, expected: unknown): boolean {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return (actual === null || actual === undefined) && (expected === null || expected === undefined);
  if (actual instanceof Date) {
    const text = actual.toISOString();
    return typeof expected === "string" && (expected.length === 10 ? text.slice(0, 10) === expected : text === expected);
  }
  return Object.is(actual, expected) || String(actual) === String(expected);
}

function requireOwnFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) throw new RentOpsInvariantError(`${label} v8 row is incomplete`);
}

function assertImportedChargeDefinition(value: RentOpsChargeDefinition): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, [
    "displayName", "displayNameKnowledge", "category", "categoryKnowledge", "active", "activeKnowledge",
    "recordRevision", "sourceArtifactSha256", "artifactObservationOn",
  ], "Charge definition");
  if (!value.source.system || !value.source.sourceId || !value.sourceArtifactSha256 || !/^[a-f0-9]{64}$/.test(value.sourceArtifactSha256) || !value.artifactObservationOn) throw new RentOpsInvariantError("Imported charge definition artifact provenance is incomplete");
}

function assertImportedSchedule(value: RentOpsRecurringChargeSchedule): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, [
    "scopeType", "scopeId", "scopeTypeKnowledge", "scopeLinkKnowledge", "chargeDefinitionId", "chargeDefinitionKey",
    "tenancyId", "personId", "propertyId", "unitId", "category", "categoryKnowledge", "description", "descriptionKnowledge",
    "amountCents", "amountKnowledge", "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "active", "activeKnowledge",
    "sourceConfidence", "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge", "sourceArtifactSha256", "artifactObservationOn",
    "lineageRootId", "lineageRootOrigin", "versionOrigin", "supersedesId", "versionAction", "recordRevision",
  ], "Recurring schedule");
}

function assertImportedLedger(value: RentOpsLedgerTransaction): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, [
    "propertyId", "unitId", "tenancyId", "personId", "kind", "category", "categoryKnowledge", "status", "amountCents", "postedOn",
    "dueOn", "paymentMethod", "paymentMethodKnowledge", "description", "reversalOfId", "payer", "payerKnowledge", "adjustmentDirection",
    "propertyLinkKnowledge", "unitLinkKnowledge", "tenancyLinkKnowledge", "personLinkKnowledge", "amountKnowledge", "postedOnKnowledge",
    "dueOnKnowledge", "descriptionKnowledge", "statusKnowledge", "allocationMode", "chargeDefinitionId", "chargeDefinitionLinkKnowledge",
    "sourceArtifactSha256", "artifactObservationOn",
  ], "Ledger transaction");
  if (!value.source.system || !value.source.sourceId || !value.sourceArtifactSha256 || !/^[a-f0-9]{64}$/.test(value.sourceArtifactSha256) || !value.artifactObservationOn) throw new RentOpsInvariantError("Imported ledger artifact provenance is incomplete");
}

function assertImportedAllocation(value: RentOpsPaymentAllocation): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, [
    "paymentTransactionId", "chargeTransactionId", "amountCents", "allocatedOn", "paymentLinkKnowledge", "chargeLinkKnowledge", "amountKnowledge", "allocatedOnKnowledge",
  ], "Payment allocation");
  if (!value.source.system || !value.source.sourceId) throw new RentOpsInvariantError("Imported payment allocation source provenance is incomplete");
}

function assertRecurringRootProvenance(value: RentOpsRecurringChargeSchedule): void {
  const hasSourcePair = Boolean(value.source?.system?.trim() && value.source?.sourceId?.trim());
  if (value.versionAction !== "root" || value.supersedesId !== undefined && value.supersedesId !== null) throw new RentOpsInvariantError("Recurring schedule root must have versionAction root and no predecessor");
  if (value.versionOrigin === "artifact") {
    if (value.lineageRootOrigin !== "artifact" || !hasSourcePair || !value.sourceArtifactSha256 || !value.artifactObservationOn) throw new RentOpsInvariantError("Artifact recurring schedule root requires source and artifact provenance");
    return;
  }
  if (value.versionOrigin === "manual") {
    if (value.lineageRootOrigin !== "manual" || value.source || value.sourceArtifactSha256 !== undefined && value.sourceArtifactSha256 !== null || value.artifactObservationOn !== undefined && value.artifactObservationOn !== null) throw new RentOpsInvariantError("Manual recurring schedule root cannot carry artifact provenance");
    return;
  }
  throw new RentOpsInvariantError("Recurring schedule version origin is invalid");
}

function assertRecurringSuccessorShape(predecessor: RentOpsRecurringChargeSchedule, root: RentOpsRecurringChargeSchedule, successor: RentOpsRecurringChargeSchedule, expectedRevision: number): void {
  if (successor.id === predecessor.id || successor.supersedesId !== predecessor.id) throw new RentOpsInvariantError("Recurring schedule successor must supersede its predecessor");
  if (successor.lineageRootId !== predecessor.lineageRootId || successor.lineageRootId !== root.id || successor.lineageRootOrigin !== predecessor.lineageRootOrigin || successor.lineageRootOrigin !== root.lineageRootOrigin) throw new RentOpsInvariantError("Recurring schedule lineage is immutable");
  if (successor.versionOrigin !== "manual" || successor.source || successor.sourceArtifactSha256 !== root.sourceArtifactSha256 || successor.artifactObservationOn !== root.artifactObservationOn) throw new RentOpsInvariantError("Recurring schedule successor provenance is invalid");
  for (const field of [
    "scopeType", "scopeId", "scopeTypeKnowledge", "scopeLinkKnowledge", "chargeDefinitionId", "chargeDefinitionKey",
    "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge", "tenancyId", "personId", "propertyId", "unitId",
    "category", "categoryKnowledge", "description", "descriptionKnowledge", "sourceConfidence", "sourceArtifactSha256",
    "artifactObservationOn", "lineageRootId", "lineageRootOrigin",
  ] as const) {
    if (!Object.is(successor[field], predecessor[field])) throw new RentOpsInvariantError("Recurring schedule successor changed immutable fields");
  }
  if (successor.versionAction === "root") throw new RentOpsInvariantError("Recurring schedule successor cannot be a root");
  if (successor.effectiveFromKnowledge !== "manual") throw new RentOpsInvariantError("Recurring schedule successor effectiveFrom must be manual");
  if (predecessor.effectiveTo && successor.effectiveFrom && successor.effectiveFrom > predecessor.effectiveTo) throw new RentOpsInvariantError("Recurring schedule successor starts after predecessor end");
  if (successor.recordRevision !== expectedRevision + 1) throw new RentOpsInvariantError("Recurring schedule successor revision is stale");
  if (successor.versionAction === "replace" && (successor.effectiveTo !== predecessor.effectiveTo || successor.active !== predecessor.active || successor.activeKnowledge !== predecessor.activeKnowledge)) throw new RentOpsInvariantError("Recurring schedule successor changed immutable fields");
  if (successor.versionAction === "end" && (successor.amountCents !== null || successor.amountKnowledge !== "unknown" || successor.active !== false || successor.activeKnowledge !== "manual" || successor.effectiveTo !== successor.effectiveFrom)) {
    throw new RentOpsInvariantError("Recurring schedule end successor must be terminal");
  }
}

function assertRecurringChange(change: RentOpsRecordChange, successor: RentOpsRecurringChargeSchedule): void {
  if (change.entityType !== "recurring_schedule" || change.targetId !== successor.id || change.revision !== successor.recordRevision) throw new RentOpsInvariantError("Recurring schedule change record target is invalid");
  if (change.changedFields.length === 0 || change.changedFields.length > 64) throw new RentOpsInvariantError("Recurring schedule change field list is invalid");
  const sortedFields = [...change.changedFields].sort();
  if (sortedFields.some((field, index) => field !== change.changedFields[index] || !recurringChangeFields.has(field)) || new Set(change.changedFields).size !== change.changedFields.length) throw new RentOpsInvariantError("Recurring schedule change field list is invalid");
  if (change.origin === "admin" && !change.actorSubject) throw new RentOpsInvariantError("Recurring schedule admin change actor is required");
}

function dateValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function timestampValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function get(row: Record<string, unknown>, camel: string, snake: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, camel)) return row[camel];
  if (Object.prototype.hasOwnProperty.call(row, snake)) return row[snake];
  return undefined;
}

function textValue(row: Record<string, unknown>, camel: string, snake: string, fallback?: string): string | undefined {
  const value = get(row, camel, snake);
  return value === undefined || value === null ? fallback : String(value);
}

function boolValue(row: Record<string, unknown>, camel: string, snake: string, fallback = false): boolean {
  const value = get(row, camel, snake);
  return value === undefined || value === null ? fallback : Boolean(value);
}

function numberValue(row: Record<string, unknown>, camel: string, snake: string): number | undefined {
  const value = get(row, camel, snake);
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** Financial v8 decoders must preserve database NULL as NULL. These helpers
 * deliberately do not use the legacy optional-value helpers above. */
function nullableTextValue(row: Record<string, unknown>, camel: string, snake: string): string | null {
  const value = get(row, camel, snake);
  return value === undefined || value === null ? null : String(value);
}

function nullableNumberValue(row: Record<string, unknown>, camel: string, snake: string): number | null {
  const value = get(row, camel, snake);
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableDateValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function nullableBooleanValue(row: Record<string, unknown>, camel: string, snake: string): boolean | null {
  const value = get(row, camel, snake);
  return value === undefined || value === null ? null : Boolean(value);
}

function revisionValue(row: Record<string, unknown>): number | undefined {
  return numberValue(row, "recordRevision", "record_revision");
}

function jsonValue<T>(row: Record<string, unknown>, camel: string, snake: string): T | undefined {
  const value = get(row, camel, snake);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

function source(row: Record<string, unknown>, entityType: string): RentOpsProperty["source"] {
  const system = textValue(row, "sourceSystem", "source_system");
  const sourceId = textValue(row, "sourceId", "source_id");
  if (!system || !sourceId) return undefined;
  return { system, entityType, sourceId, sourceUpdatedAt: timestampValue(get(row, "sourceUpdatedAt", "source_updated_at")) };
}

function rowToProperty(row: Record<string, unknown>): RentOpsProperty {
  return { id: String(row.id), recordRevision: revisionValue(row), source: source(row, "property"), name: textValue(row, "name", "name") as unknown as string, slug: String(row.slug), address: { line1: textValue(row, "addressLine1", "address_line1") as unknown as string, line2: textValue(row, "addressLine2", "address_line2"), city: textValue(row, "city", "city") as unknown as string, state: textValue(row, "state", "state") as unknown as string, postalCode: textValue(row, "postalCode", "postal_code") as unknown as string }, propertyType: textValue(row, "propertyType", "property_type") as RentOpsProperty["propertyType"], state: textValue(row, "stateStatus", "state_status") as RentOpsProperty["state"], operatingContact: textValue(row, "operatingContact", "operating_contact"), nameKnowledge: textValue(row, "nameKnowledge", "name_knowledge") as RentOpsProperty["nameKnowledge"], addressKnowledge: textValue(row, "addressKnowledge", "address_knowledge") as RentOpsProperty["addressKnowledge"], propertyTypeKnowledge: textValue(row, "propertyTypeKnowledge", "property_type_knowledge") as RentOpsProperty["propertyTypeKnowledge"], stateKnowledge: textValue(row, "stateKnowledge", "state_knowledge") as RentOpsProperty["stateKnowledge"], operatingContactKnowledge: textValue(row, "operatingContactKnowledge", "operating_contact_knowledge") as RentOpsProperty["operatingContactKnowledge"] } as unknown as RentOpsProperty;
}

function rowToUnit(row: Record<string, unknown>): RentOpsUnit {
  return { id: String(row.id), recordRevision: revisionValue(row), propertyId: textValue(row, "propertyId", "property_id") as unknown as string, source: source(row, "unit"), unitNumber: textValue(row, "unitNumber", "unit_number") as unknown as string, unitType: textValue(row, "unitType", "unit_type"), bedrooms: numberValue(row, "bedrooms", "bedrooms"), bathrooms: numberValue(row, "bathrooms", "bathrooms"), squareFeet: numberValue(row, "squareFeet", "square_feet"), marketRentCents: numberValue(row, "marketRentCents", "market_rent_cents"), defaultDepositCents: numberValue(row, "defaultDepositCents", "default_deposit_cents"), readiness: textValue(row, "readiness", "readiness") as RentOpsUnit["readiness"], listing: textValue(row, "listing", "listing") as RentOpsUnit["listing"], amenities: jsonValue<string[]>(row, "amenities", "amenities"), accessNotes: textValue(row, "accessNotes", "access_notes"), propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsUnit["propertyLinkKnowledge"], unitNumberKnowledge: textValue(row, "unitNumberKnowledge", "unit_number_knowledge") as RentOpsUnit["unitNumberKnowledge"], unitTypeKnowledge: textValue(row, "unitTypeKnowledge", "unit_type_knowledge") as RentOpsUnit["unitTypeKnowledge"], readinessKnowledge: textValue(row, "readinessKnowledge", "readiness_knowledge") as RentOpsUnit["readinessKnowledge"], listingKnowledge: textValue(row, "listingKnowledge", "listing_knowledge") as RentOpsUnit["listingKnowledge"] } as unknown as RentOpsUnit;
}

function rowToPerson(row: Record<string, unknown>): RentOpsPerson {
  const archivedValue = get(row, "archived", "archived");
  return { id: String(row.id), recordRevision: revisionValue(row), source: source(row, "person"), firstName: textValue(row, "firstName", "first_name") as unknown as string, lastName: textValue(row, "lastName", "last_name") as unknown as string, email: textValue(row, "email", "email"), phone: textValue(row, "phone", "phone"), phoneMethods: jsonValue<RentOpsPerson["phoneMethods"]>(row, "phoneMethods", "phone_methods"), firstNameKnowledge: textValue(row, "firstNameKnowledge", "first_name_knowledge") as RentOpsPerson["firstNameKnowledge"], lastNameKnowledge: textValue(row, "lastNameKnowledge", "last_name_knowledge") as RentOpsPerson["lastNameKnowledge"], emailKnowledge: textValue(row, "emailKnowledge", "email_knowledge") as RentOpsPerson["emailKnowledge"], phoneKnowledge: textValue(row, "phoneKnowledge", "phone_knowledge") as RentOpsPerson["phoneKnowledge"], renterInsuranceExpiresOn: dateValue(get(row, "renterInsuranceExpiresOn", "renter_insurance_expires_on")) as RentOpsPerson["renterInsuranceExpiresOn"], archived: archivedValue === undefined || archivedValue === null ? undefined : boolValue(row, "archived", "archived"), archivedKnowledge: textValue(row, "archivedKnowledge", "archived_knowledge") as RentOpsPerson["archivedKnowledge"] } as unknown as RentOpsPerson;
}

function rowToTenancy(row: Record<string, unknown>): RentOpsTenancy {
  return { id: String(row.id), recordRevision: revisionValue(row), source: source(row, "tenancy"), propertyId: textValue(row, "propertyId", "property_id") as unknown as string, unitId: textValue(row, "unitId", "unit_id") as unknown as string, primaryPersonId: textValue(row, "primaryPersonId", "primary_person_id") as unknown as string, status: textValue(row, "status", "status") as RentOpsTenancy["status"], plannedMoveInOn: dateValue(get(row, "plannedMoveInOn", "planned_move_in_on")) as RentOpsTenancy["plannedMoveInOn"], actualMoveInOn: dateValue(get(row, "actualMoveInOn", "actual_move_in_on")) as RentOpsTenancy["actualMoveInOn"], noticeOn: dateValue(get(row, "noticeOn", "notice_on")) as RentOpsTenancy["noticeOn"], expectedMoveOutOn: dateValue(get(row, "expectedMoveOutOn", "expected_move_out_on")) as RentOpsTenancy["expectedMoveOutOn"], actualMoveOutOn: dateValue(get(row, "actualMoveOutOn", "actual_move_out_on")) as RentOpsTenancy["actualMoveOutOn"], applicationId: textValue(row, "applicationId", "application_id"), createdAt: timestampValue(get(row, "createdAt", "created_at")) as unknown as string, endedAt: timestampValue(get(row, "endedAt", "ended_at")), propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsTenancy["propertyLinkKnowledge"], unitLinkKnowledge: textValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsTenancy["unitLinkKnowledge"], primaryPersonLinkKnowledge: textValue(row, "primaryPersonLinkKnowledge", "primary_person_link_knowledge") as RentOpsTenancy["primaryPersonLinkKnowledge"], statusKnowledge: textValue(row, "statusKnowledge", "status_knowledge") as RentOpsTenancy["statusKnowledge"], plannedMoveInKnowledge: textValue(row, "plannedMoveInKnowledge", "planned_move_in_knowledge") as RentOpsTenancy["plannedMoveInKnowledge"], actualMoveInKnowledge: textValue(row, "actualMoveInKnowledge", "actual_move_in_knowledge") as RentOpsTenancy["actualMoveInKnowledge"], noticeKnowledge: textValue(row, "noticeKnowledge", "notice_knowledge") as RentOpsTenancy["noticeKnowledge"], expectedMoveOutKnowledge: textValue(row, "expectedMoveOutKnowledge", "expected_move_out_knowledge") as RentOpsTenancy["expectedMoveOutKnowledge"], actualMoveOutKnowledge: textValue(row, "actualMoveOutKnowledge", "actual_move_out_knowledge") as RentOpsTenancy["actualMoveOutKnowledge"], createdAtKnowledge: textValue(row, "createdAtKnowledge", "created_at_knowledge") as RentOpsTenancy["createdAtKnowledge"], endedAtKnowledge: textValue(row, "endedAtKnowledge", "ended_at_knowledge") as RentOpsTenancy["endedAtKnowledge"] } as unknown as RentOpsTenancy;
}

function rowToLeaseTerm(row: Record<string, unknown>): RentOpsLeaseTerm {
  return { id: String(row.id), recordRevision: revisionValue(row), tenancyId: textValue(row, "tenancyId", "tenancy_id") as unknown as string, source: source(row, "lease_term"), status: textValue(row, "status", "status") as RentOpsLeaseTerm["status"], contractStartOn: dateValue(get(row, "contractStartOn", "contract_start_on")) as RentOpsLeaseTerm["contractStartOn"], contractEndOn: dateValue(get(row, "contractEndOn", "contract_end_on")) as RentOpsLeaseTerm["contractEndOn"], monthToMonth: (get(row, "monthToMonth", "month_to_month") === null || get(row, "monthToMonth", "month_to_month") === undefined ? null : boolValue(row, "monthToMonth", "month_to_month")) as unknown as boolean, signedOn: dateValue(get(row, "signedOn", "signed_on")) as RentOpsLeaseTerm["signedOn"], executedDocumentId: textValue(row, "executedDocumentId", "executed_document_id"), renewalOfId: textValue(row, "renewalOfId", "renewal_of_id"), createdAt: timestampValue(get(row, "createdAt", "created_at")) as unknown as string, tenancyLinkKnowledge: textValue(row, "tenancyLinkKnowledge", "tenancy_link_knowledge") as RentOpsLeaseTerm["tenancyLinkKnowledge"], statusKnowledge: textValue(row, "statusKnowledge", "status_knowledge") as RentOpsLeaseTerm["statusKnowledge"], contractStartKnowledge: textValue(row, "contractStartKnowledge", "contract_start_knowledge") as RentOpsLeaseTerm["contractStartKnowledge"], contractEndKnowledge: textValue(row, "contractEndKnowledge", "contract_end_knowledge") as RentOpsLeaseTerm["contractEndKnowledge"], signedOnKnowledge: textValue(row, "signedOnKnowledge", "signed_on_knowledge") as RentOpsLeaseTerm["signedOnKnowledge"], monthToMonthKnowledge: textValue(row, "monthToMonthKnowledge", "month_to_month_knowledge") as RentOpsLeaseTerm["monthToMonthKnowledge"], createdAtKnowledge: textValue(row, "createdAtKnowledge", "created_at_knowledge") as RentOpsLeaseTerm["createdAtKnowledge"] } as unknown as RentOpsLeaseTerm;
}

function rowToSubsidyTenant(row: Record<string, unknown>): RentOpsSubsidyTenant {
  return {
    id: String(row.id),
    source: source(row, "subsidy_tenant"),
    subsidyContractId: textValue(row, "subsidyContractId", "subsidy_contract_id"),
    subsidyContractLinkKnowledge: textValue(row, "subsidyContractLinkKnowledge", "subsidy_contract_link_knowledge") as RentOpsSubsidyTenant["subsidyContractLinkKnowledge"],
    tenancyId: textValue(row, "tenancyId", "tenancy_id"),
    tenancyLinkKnowledge: textValue(row, "tenancyLinkKnowledge", "tenancy_link_knowledge") as RentOpsSubsidyTenant["tenancyLinkKnowledge"],
    personId: textValue(row, "personId", "person_id"),
    personLinkKnowledge: textValue(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsSubsidyTenant["personLinkKnowledge"],
    propertyId: textValue(row, "propertyId", "property_id"),
    propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsSubsidyTenant["propertyLinkKnowledge"],
    unitId: textValue(row, "unitId", "unit_id"),
    unitLinkKnowledge: textValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsSubsidyTenant["unitLinkKnowledge"],
    effectiveFrom: dateValue(get(row, "effectiveFrom", "effective_from")) as RentOpsSubsidyTenant["effectiveFrom"],
    effectiveFromKnowledge: textValue(row, "effectiveFromKnowledge", "effective_from_knowledge") as RentOpsSubsidyTenant["effectiveFromKnowledge"],
    effectiveTo: dateValue(get(row, "effectiveTo", "effective_to")) as RentOpsSubsidyTenant["effectiveTo"],
    effectiveToKnowledge: textValue(row, "effectiveToKnowledge", "effective_to_knowledge") as RentOpsSubsidyTenant["effectiveToKnowledge"],
    amountCents: numberValue(row, "amountCents", "amount_cents"),
    amountKnowledge: textValue(row, "amountKnowledge", "amount_knowledge") as RentOpsSubsidyTenant["amountKnowledge"],
    payer: textValue(row, "payer", "payer") as RentOpsSubsidyTenant["payer"],
    payerKnowledge: textValue(row, "payerKnowledge", "payer_knowledge") as RentOpsSubsidyTenant["payerKnowledge"],
    status: textValue(row, "status", "status") as RentOpsSubsidyTenant["status"],
    statusKnowledge: textValue(row, "statusKnowledge", "status_knowledge") as RentOpsSubsidyTenant["statusKnowledge"],
  };
}

function rowToSubsidyPayment(row: Record<string, unknown>): RentOpsSubsidyPayment {
  return {
    id: String(row.id),
    source: source(row, "subsidy_payment"),
    subsidyContractId: textValue(row, "subsidyContractId", "subsidy_contract_id"),
    subsidyContractLinkKnowledge: textValue(row, "subsidyContractLinkKnowledge", "subsidy_contract_link_knowledge") as RentOpsSubsidyPayment["subsidyContractLinkKnowledge"],
    subsidyTenantId: textValue(row, "subsidyTenantId", "subsidy_tenant_id"),
    subsidyTenantLinkKnowledge: textValue(row, "subsidyTenantLinkKnowledge", "subsidy_tenant_link_knowledge") as RentOpsSubsidyPayment["subsidyTenantLinkKnowledge"],
    tenancyId: textValue(row, "tenancyId", "tenancy_id"),
    tenancyLinkKnowledge: textValue(row, "tenancyLinkKnowledge", "tenancy_link_knowledge") as RentOpsSubsidyPayment["tenancyLinkKnowledge"],
    personId: textValue(row, "personId", "person_id"),
    personLinkKnowledge: textValue(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsSubsidyPayment["personLinkKnowledge"],
    propertyId: textValue(row, "propertyId", "property_id"),
    propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsSubsidyPayment["propertyLinkKnowledge"],
    unitId: textValue(row, "unitId", "unit_id"),
    unitLinkKnowledge: textValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsSubsidyPayment["unitLinkKnowledge"],
    paymentTransactionId: textValue(row, "paymentTransactionId", "payment_transaction_id"),
    paymentLinkKnowledge: textValue(row, "paymentLinkKnowledge", "payment_link_knowledge") as RentOpsSubsidyPayment["paymentLinkKnowledge"],
    paymentOn: dateValue(get(row, "paymentOn", "payment_on")) as RentOpsSubsidyPayment["paymentOn"],
    paymentOnKnowledge: textValue(row, "paymentOnKnowledge", "payment_on_knowledge") as RentOpsSubsidyPayment["paymentOnKnowledge"],
    amountCents: numberValue(row, "amountCents", "amount_cents"),
    amountKnowledge: textValue(row, "amountKnowledge", "amount_knowledge") as RentOpsSubsidyPayment["amountKnowledge"],
    payer: textValue(row, "payer", "payer") as RentOpsSubsidyPayment["payer"],
    payerKnowledge: textValue(row, "payerKnowledge", "payer_knowledge") as RentOpsSubsidyPayment["payerKnowledge"],
    status: textValue(row, "status", "status") as RentOpsSubsidyPayment["status"],
    statusKnowledge: textValue(row, "statusKnowledge", "status_knowledge") as RentOpsSubsidyPayment["statusKnowledge"],
  };
}

function rowToScheduleLegacy(row: Record<string, unknown>): RentOpsRecurringChargeSchedule {
  return { id: String(row.id), recordRevision: revisionValue(row), source: source(row, "recurring_schedule"), scopeType: textValue(row, "scopeType", "scope_type") as RentOpsRecurringChargeSchedule["scopeType"], scopeId: textValue(row, "scopeId", "scope_id"), chargeDefinitionId: textValue(row, "chargeDefinitionId", "charge_definition_id"), chargeDefinitionKey: textValue(row, "chargeDefinitionKey", "charge_definition_key"), tenancyId: textValue(row, "tenancyId", "tenancy_id"), personId: textValue(row, "personId", "person_id"), propertyId: textValue(row, "propertyId", "property_id") as unknown as string, unitId: textValue(row, "unitId", "unit_id"), category: textValue(row, "category", "category") as RentOpsRecurringChargeSchedule["category"], description: textValue(row, "description", "description"), descriptionKnowledge: textValue(row, "descriptionKnowledge", "description_knowledge") as RentOpsRecurringChargeSchedule["descriptionKnowledge"], amountCents: numberValue(row, "amountCents", "amount_cents") as unknown as number, effectiveFrom: dateValue(get(row, "effectiveFrom", "effective_from")) as RentOpsRecurringChargeSchedule["effectiveFrom"], effectiveFromKnowledge: textValue(row, "effectiveFromKnowledge", "effective_from_knowledge") as RentOpsRecurringChargeSchedule["effectiveFromKnowledge"], effectiveTo: dateValue(get(row, "effectiveTo", "effective_to")) as RentOpsRecurringChargeSchedule["effectiveTo"], active: get(row, "active", "active") === null || get(row, "active", "active") === undefined ? undefined : boolValue(row, "active", "active"), activeKnowledge: textValue(row, "activeKnowledge", "active_knowledge") as RentOpsRecurringChargeSchedule["activeKnowledge"], sourceConfidence: textValue(row, "sourceConfidence", "source_confidence") as RentOpsRecurringChargeSchedule["sourceConfidence"], chargeDefinitionKnowledge: textValue(row, "chargeDefinitionKnowledge", "charge_definition_knowledge") as RentOpsRecurringChargeSchedule["chargeDefinitionKnowledge"] } as unknown as RentOpsRecurringChargeSchedule;
}

function rowToLedgerLegacy(row: Record<string, unknown>): RentOpsLedgerTransaction {
  return { id: String(row.id), source: source(row, "ledger_transaction"), propertyId: textValue(row, "propertyId", "property_id") as unknown as string, unitId: textValue(row, "unitId", "unit_id"), tenancyId: textValue(row, "tenancyId", "tenancy_id"), personId: textValue(row, "personId", "person_id"), kind: textValue(row, "kind", "kind") as RentOpsLedgerTransaction["kind"], category: textValue(row, "category", "category") as RentOpsLedgerTransaction["category"], status: textValue(row, "status", "status") as RentOpsLedgerTransaction["status"], amountCents: numberValue(row, "amountCents", "amount_cents") as unknown as number, postedOn: dateValue(get(row, "postedOn", "posted_on")) as unknown as string, dueOn: dateValue(get(row, "dueOn", "due_on")) as RentOpsLedgerTransaction["dueOn"], paymentMethod: textValue(row, "paymentMethod", "payment_method") as RentOpsLedgerTransaction["paymentMethod"], description: textValue(row, "description", "description") as unknown as string, reversalOfId: textValue(row, "reversalOfId", "reversal_of_id"), payer: textValue(row, "payer", "payer") as RentOpsLedgerTransaction["payer"], adjustmentDirection: textValue(row, "adjustmentDirection", "adjustment_direction") as RentOpsLedgerTransaction["adjustmentDirection"], propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsLedgerTransaction["propertyLinkKnowledge"], unitLinkKnowledge: textValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsLedgerTransaction["unitLinkKnowledge"], tenancyLinkKnowledge: textValue(row, "tenancyLinkKnowledge", "tenancy_link_knowledge") as RentOpsLedgerTransaction["tenancyLinkKnowledge"], personLinkKnowledge: textValue(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsLedgerTransaction["personLinkKnowledge"], amountKnowledge: textValue(row, "amountKnowledge", "amount_knowledge") as RentOpsLedgerTransaction["amountKnowledge"], postedOnKnowledge: textValue(row, "postedOnKnowledge", "posted_on_knowledge") as RentOpsLedgerTransaction["postedOnKnowledge"], dueOnKnowledge: textValue(row, "dueOnKnowledge", "due_on_knowledge") as RentOpsLedgerTransaction["dueOnKnowledge"], descriptionKnowledge: textValue(row, "descriptionKnowledge", "description_knowledge") as RentOpsLedgerTransaction["descriptionKnowledge"], statusKnowledge: textValue(row, "statusKnowledge", "status_knowledge") as RentOpsLedgerTransaction["statusKnowledge"], allocationMode: textValue(row, "allocationMode", "allocation_mode") as RentOpsLedgerTransaction["allocationMode"] } as unknown as RentOpsLedgerTransaction;
}

function rowToApplicationV3(row: Record<string, unknown>): RentOpsApplicationRecord {
  return {
    id: String(row.id),
    recordRevision: revisionValue(row),
    source: source(row, "application"),
    sourceType: textValue(row, "sourceType", "source_type") as RentOpsApplicationRecord["sourceType"],
    status: textValue(row, "status", "status") as RentOpsApplicationRecord["status"],
    email: textValue(row, "email", "email") as unknown as string,
    firstName: textValue(row, "firstName", "first_name") as unknown as string,
    lastName: textValue(row, "lastName", "last_name") as unknown as string,
    phone: textValue(row, "phone", "phone"),
    propertyId: textValue(row, "propertyId", "property_id"),
    unitId: textValue(row, "unitId", "unit_id"),
    submittedOn: dateValue(get(row, "submittedOn", "submitted_on")) as RentOpsApplicationRecord["submittedOn"],
    certificationAcceptedOn: dateValue(get(row, "certificationAcceptedOn", "certification_accepted_on")) as RentOpsApplicationRecord["certificationAcceptedOn"],
    resumeTokenHash: textValue(row, "resumeTokenHash", "resume_token_hash"),
    resumeTokenExpiresAt: timestampValue(get(row, "resumeTokenExpiresAt", "resume_token_expires_at")),
    convertedTenancyId: textValue(row, "convertedTenancyId", "converted_tenancy_id"),
    createdAt: timestampValue(get(row, "createdAt", "created_at")) as unknown as string,
    updatedAt: timestampValue(get(row, "updatedAt", "updated_at")) as unknown as string,
    rentalHistory: jsonValue<RentOpsApplicationRecord["rentalHistory"]>(row, "rentalHistory", "rental_history"),
    employment: jsonValue<RentOpsApplicationRecord["employment"]>(row, "employment", "employment"),
    householdSummary: jsonValue<RentOpsApplicationRecord["householdSummary"]>(row, "householdSummary", "household_summary"),
    preferences: jsonValue<RentOpsApplicationRecord["preferences"]>(row, "preferences", "preferences"),
    voucher: jsonValue<RentOpsApplicationRecord["voucher"]>(row, "voucher", "voucher"),
    pets: jsonValue<RentOpsApplicationRecord["pets"]>(row, "pets", "pets"),
    vehicles: jsonValue<RentOpsApplicationRecord["vehicles"]>(row, "vehicles", "vehicles"),
    emergencyContact: jsonValue<RentOpsApplicationRecord["emergencyContact"]>(row, "emergencyContact", "emergency_contact"),
    profileAnswers: jsonValue<RentOpsApplicationRecord["profileAnswers"]>(row, "profileAnswers", "profile_answers"),
    sourceTypeKnowledge: textValue(row, "sourceTypeKnowledge", "source_type_knowledge") as RentOpsApplicationRecord["sourceTypeKnowledge"],
    statusKnowledge: textValue(row, "statusKnowledge", "status_knowledge") as RentOpsApplicationRecord["statusKnowledge"],
    emailKnowledge: textValue(row, "emailKnowledge", "email_knowledge") as RentOpsApplicationRecord["emailKnowledge"],
    firstNameKnowledge: textValue(row, "firstNameKnowledge", "first_name_knowledge") as RentOpsApplicationRecord["firstNameKnowledge"],
    lastNameKnowledge: textValue(row, "lastNameKnowledge", "last_name_knowledge") as RentOpsApplicationRecord["lastNameKnowledge"],
    phoneKnowledge: textValue(row, "phoneKnowledge", "phone_knowledge") as RentOpsApplicationRecord["phoneKnowledge"],
    propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsApplicationRecord["propertyLinkKnowledge"],
    unitLinkKnowledge: textValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsApplicationRecord["unitLinkKnowledge"],
    submittedOnKnowledge: textValue(row, "submittedOnKnowledge", "submitted_on_knowledge") as RentOpsApplicationRecord["submittedOnKnowledge"],
    certificationAcceptedOnKnowledge: textValue(row, "certificationAcceptedOnKnowledge", "certification_accepted_on_knowledge") as RentOpsApplicationRecord["certificationAcceptedOnKnowledge"],
    createdAtKnowledge: textValue(row, "createdAtKnowledge", "created_at_knowledge") as RentOpsApplicationRecord["createdAtKnowledge"],
    updatedAtKnowledge: textValue(row, "updatedAtKnowledge", "updated_at_knowledge") as RentOpsApplicationRecord["updatedAtKnowledge"],
  } as unknown as RentOpsApplicationRecord;
}

function rowToApplication(row: Record<string, unknown>): RentOpsApplicationRecord {
  // Kept as a compatibility symbol for older internal callers.  The v3
  // decoder is authoritative and deliberately preserves null/unknown facts.
  return rowToApplicationV3(row);
}

function rowToHouseholdMembership(row: Record<string, unknown>): RentOpsHouseholdMembership {
  return {
    id: String(row.id),
    recordRevision: revisionValue(row),
    tenancyId: textValue(row, "tenancyId", "tenancy_id"),
    applicationId: textValue(row, "applicationId", "application_id"),
    accountPersonId: textValue(row, "accountPersonId", "account_person_id"),
    personId: String(get(row, "personId", "person_id")),
    role: textValue(row, "role", "role") as RentOpsHouseholdMembership["role"],
    relationship: textValue(row, "relationship", "relationship"),
    isFinanciallyResponsible: (get(row, "isFinanciallyResponsible", "is_financially_responsible") === null || get(row, "isFinanciallyResponsible", "is_financially_responsible") === undefined)
      ? undefined
      : boolValue(row, "isFinanciallyResponsible", "is_financially_responsible"),
    roleKnowledge: textValue(row, "roleKnowledge", "role_knowledge") as RentOpsHouseholdMembership["roleKnowledge"],
    relationshipKnowledge: textValue(row, "relationshipKnowledge", "relationship_knowledge") as RentOpsHouseholdMembership["relationshipKnowledge"],
    responsibilityKnowledge: textValue(row, "responsibilityKnowledge", "responsibility_knowledge") as RentOpsHouseholdMembership["responsibilityKnowledge"],
  } as unknown as RentOpsHouseholdMembership;
}

function rowToAllocationLegacy(row: Record<string, unknown>): RentOpsPaymentAllocation {
  return {
    id: String(row.id),
    source: source(row, "payment_allocation"),
    kind: (nullableTextValue(row, "kind", "kind") ?? "allocation") as RentOpsPaymentAllocation["kind"],
    sourceArtifactSha256: nullableTextValue(row, "sourceArtifactSha256", "source_artifact_sha256"),
    artifactObservationOn: nullableDateValue(get(row, "artifactObservationOn", "artifact_observation_on")),
    paymentTransactionId: textValue(row, "paymentTransactionId", "payment_transaction_id") as unknown as string,
    chargeTransactionId: textValue(row, "chargeTransactionId", "charge_transaction_id") as unknown as string,
    amountCents: numberValue(row, "amountCents", "amount_cents") as unknown as number,
    allocatedOn: dateValue(get(row, "allocatedOn", "allocated_on")) as unknown as RentOpsPaymentAllocation["allocatedOn"],
    paymentLinkKnowledge: textValue(row, "paymentLinkKnowledge", "payment_link_knowledge") as RentOpsPaymentAllocation["paymentLinkKnowledge"],
    chargeLinkKnowledge: textValue(row, "chargeLinkKnowledge", "charge_link_knowledge") as RentOpsPaymentAllocation["chargeLinkKnowledge"],
    amountKnowledge: textValue(row, "amountKnowledge", "amount_knowledge") as RentOpsPaymentAllocation["amountKnowledge"],
    allocatedOnKnowledge: textValue(row, "allocatedOnKnowledge", "allocated_on_knowledge") as RentOpsPaymentAllocation["allocatedOnKnowledge"],
  } as unknown as RentOpsPaymentAllocation;
}

/** v8 financial decoders preserve SQL NULL exactly; missing facts are not
 * converted to undefined, false, empty strings, or zero. */
function rowToAllocation(row: Record<string, unknown>): RentOpsPaymentAllocation {
  return {
    id: String(row.id),
    source: source(row, "payment_allocation"),
    kind: (nullableTextValue(row, "kind", "kind") ?? "allocation") as RentOpsPaymentAllocation["kind"],
    sourceArtifactSha256: nullableTextValue(row, "sourceArtifactSha256", "source_artifact_sha256"),
    artifactObservationOn: nullableDateValue(get(row, "artifactObservationOn", "artifact_observation_on")),
    creditTransactionId: nullableTextValue(row,"creditTransactionId","credit_transaction_id"),
    creditLinkKnowledge: nullableTextValue(row,"creditLinkKnowledge","credit_link_knowledge") as RentOpsPaymentAllocation["creditLinkKnowledge"],
    paymentTransactionId: nullableTextValue(row, "paymentTransactionId", "payment_transaction_id"),
    chargeTransactionId: nullableTextValue(row, "chargeTransactionId", "charge_transaction_id"),
    amountCents: nullableNumberValue(row, "amountCents", "amount_cents"),
    allocatedOn: nullableDateValue(get(row, "allocatedOn", "allocated_on")),
    paymentLinkKnowledge: nullableTextValue(row, "paymentLinkKnowledge", "payment_link_knowledge") as RentOpsPaymentAllocation["paymentLinkKnowledge"],
    chargeLinkKnowledge: nullableTextValue(row, "chargeLinkKnowledge", "charge_link_knowledge") as RentOpsPaymentAllocation["chargeLinkKnowledge"],
    amountKnowledge: nullableTextValue(row, "amountKnowledge", "amount_knowledge") as RentOpsPaymentAllocation["amountKnowledge"],
    allocatedOnKnowledge: nullableTextValue(row, "allocatedOnKnowledge", "allocated_on_knowledge") as RentOpsPaymentAllocation["allocatedOnKnowledge"],
  };
}

function rowToSchedule(row: Record<string, unknown>): RentOpsRecurringChargeSchedule {
  return {
    id: String(row.id),
    recordRevision: revisionValue(row),
    source: source(row, "recurring_schedule"),
    scopeType: nullableTextValue(row, "scopeType", "scope_type") as RentOpsRecurringChargeSchedule["scopeType"],
    scopeId: nullableTextValue(row, "scopeId", "scope_id"),
    scopeTypeKnowledge: nullableTextValue(row, "scopeTypeKnowledge", "scope_type_knowledge") as RentOpsRecurringChargeSchedule["scopeTypeKnowledge"],
    scopeLinkKnowledge: nullableTextValue(row, "scopeLinkKnowledge", "scope_link_knowledge") as RentOpsRecurringChargeSchedule["scopeLinkKnowledge"],
    chargeDefinitionId: nullableTextValue(row, "chargeDefinitionId", "charge_definition_id"),
    chargeDefinitionKey: nullableTextValue(row, "chargeDefinitionKey", "charge_definition_key"),
    tenancyId: nullableTextValue(row, "tenancyId", "tenancy_id"),
    personId: nullableTextValue(row, "personId", "person_id"),
    propertyId: nullableTextValue(row, "propertyId", "property_id"),
    unitId: nullableTextValue(row, "unitId", "unit_id"),
    category: nullableTextValue(row, "category", "category") as RentOpsRecurringChargeSchedule["category"],
    categoryKnowledge: nullableTextValue(row, "categoryKnowledge", "category_knowledge") as RentOpsRecurringChargeSchedule["categoryKnowledge"],
    description: nullableTextValue(row, "description", "description"),
    descriptionKnowledge: nullableTextValue(row, "descriptionKnowledge", "description_knowledge") as RentOpsRecurringChargeSchedule["descriptionKnowledge"],
    amountCents: nullableNumberValue(row, "amountCents", "amount_cents"),
    amountKnowledge: nullableTextValue(row, "amountKnowledge", "amount_knowledge") as RentOpsRecurringChargeSchedule["amountKnowledge"],
    effectiveFrom: nullableDateValue(get(row, "effectiveFrom", "effective_from")),
    effectiveFromKnowledge: nullableTextValue(row, "effectiveFromKnowledge", "effective_from_knowledge") as RentOpsRecurringChargeSchedule["effectiveFromKnowledge"],
    effectiveTo: nullableDateValue(get(row, "effectiveTo", "effective_to")),
    active: nullableBooleanValue(row, "active", "active"),
    activeKnowledge: nullableTextValue(row, "activeKnowledge", "active_knowledge") as RentOpsRecurringChargeSchedule["activeKnowledge"],
    sourceConfidence: nullableTextValue(row, "sourceConfidence", "source_confidence") as RentOpsRecurringChargeSchedule["sourceConfidence"],
    chargeDefinitionKnowledge: nullableTextValue(row, "chargeDefinitionKnowledge", "charge_definition_knowledge") as RentOpsRecurringChargeSchedule["chargeDefinitionKnowledge"],
    chargeDefinitionLinkKnowledge: nullableTextValue(row, "chargeDefinitionLinkKnowledge", "charge_definition_link_knowledge") as RentOpsRecurringChargeSchedule["chargeDefinitionLinkKnowledge"],
    sourceArtifactSha256: nullableTextValue(row, "sourceArtifactSha256", "source_artifact_sha256"),
    artifactObservationOn: nullableDateValue(get(row, "artifactObservationOn", "artifact_observation_on")),
    lineageRootId: nullableTextValue(row, "lineageRootId", "lineage_root_id") as string,
    lineageRootOrigin: nullableTextValue(row, "lineageRootOrigin", "lineage_root_origin") as RentOpsRecurringChargeSchedule["lineageRootOrigin"],
    versionOrigin: nullableTextValue(row, "versionOrigin", "version_origin") as RentOpsRecurringChargeSchedule["versionOrigin"],
    supersedesId: nullableTextValue(row, "supersedesId", "supersedes_id"),
    versionAction: nullableTextValue(row, "versionAction", "version_action") as RentOpsRecurringChargeSchedule["versionAction"],
  };
}

function rowToLedger(row: Record<string, unknown>): RentOpsLedgerTransaction {
  return {
    id: String(row.id),
    source: source(row, "ledger_transaction"),
    propertyId: nullableTextValue(row, "propertyId", "property_id"),
    unitId: nullableTextValue(row, "unitId", "unit_id"),
    tenancyId: nullableTextValue(row, "tenancyId", "tenancy_id"),
    personId: nullableTextValue(row, "personId", "person_id"),
    kind: nullableTextValue(row, "kind", "kind") as RentOpsLedgerTransaction["kind"],
    category: nullableTextValue(row, "category", "category") as RentOpsLedgerTransaction["category"],
    categoryKnowledge: nullableTextValue(row, "categoryKnowledge", "category_knowledge") as RentOpsLedgerTransaction["categoryKnowledge"],
    status: nullableTextValue(row, "status", "status") as RentOpsLedgerTransaction["status"],
    amountCents: nullableNumberValue(row, "amountCents", "amount_cents"),
    postedOn: nullableDateValue(get(row, "postedOn", "posted_on")),
    dueOn: nullableDateValue(get(row, "dueOn", "due_on")),
    paymentMethod: nullableTextValue(row, "paymentMethod", "payment_method") as RentOpsLedgerTransaction["paymentMethod"],
    paymentMethodKnowledge: nullableTextValue(row, "paymentMethodKnowledge", "payment_method_knowledge") as RentOpsLedgerTransaction["paymentMethodKnowledge"],
    description: nullableTextValue(row, "description", "description"),
    reversalOfId: nullableTextValue(row, "reversalOfId", "reversal_of_id"),
    payer: nullableTextValue(row, "payer", "payer") as RentOpsLedgerTransaction["payer"],
    payerKnowledge: nullableTextValue(row, "payerKnowledge", "payer_knowledge") as RentOpsLedgerTransaction["payerKnowledge"],
    adjustmentDirection: nullableTextValue(row, "adjustmentDirection", "adjustment_direction") as RentOpsLedgerTransaction["adjustmentDirection"],
    propertyLinkKnowledge: nullableTextValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsLedgerTransaction["propertyLinkKnowledge"],
    unitLinkKnowledge: nullableTextValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsLedgerTransaction["unitLinkKnowledge"],
    tenancyLinkKnowledge: nullableTextValue(row, "tenancyLinkKnowledge", "tenancy_link_knowledge") as RentOpsLedgerTransaction["tenancyLinkKnowledge"],
    personLinkKnowledge: nullableTextValue(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsLedgerTransaction["personLinkKnowledge"],
    amountKnowledge: nullableTextValue(row, "amountKnowledge", "amount_knowledge") as RentOpsLedgerTransaction["amountKnowledge"],
    postedOnKnowledge: nullableTextValue(row, "postedOnKnowledge", "posted_on_knowledge") as RentOpsLedgerTransaction["postedOnKnowledge"],
    dueOnKnowledge: nullableTextValue(row, "dueOnKnowledge", "due_on_knowledge") as RentOpsLedgerTransaction["dueOnKnowledge"],
    descriptionKnowledge: nullableTextValue(row, "descriptionKnowledge", "description_knowledge") as RentOpsLedgerTransaction["descriptionKnowledge"],
    statusKnowledge: nullableTextValue(row, "statusKnowledge", "status_knowledge") as RentOpsLedgerTransaction["statusKnowledge"],
    allocationMode: nullableTextValue(row, "allocationMode", "allocation_mode") as RentOpsLedgerTransaction["allocationMode"],
    chargeDefinitionId: nullableTextValue(row, "chargeDefinitionId", "charge_definition_id"),
    chargeDefinitionLinkKnowledge: nullableTextValue(row, "chargeDefinitionLinkKnowledge", "charge_definition_link_knowledge") as RentOpsLedgerTransaction["chargeDefinitionLinkKnowledge"],
    sourceArtifactSha256: nullableTextValue(row, "sourceArtifactSha256", "source_artifact_sha256"),
    artifactObservationOn: nullableDateValue(get(row, "artifactObservationOn", "artifact_observation_on")),
  };
}

function rowToChargeDefinition(row: Record<string, unknown>): RentOpsChargeDefinition {
  return {
    id: String(row.id),
    recordRevision: revisionValue(row),
    source: source(row, "charge_definition"),
    sourceArtifactSha256: nullableTextValue(row, "sourceArtifactSha256", "source_artifact_sha256"),
    artifactObservationOn: nullableDateValue(get(row, "artifactObservationOn", "artifact_observation_on")),
    displayName: nullableTextValue(row, "displayName", "display_name"),
    displayNameKnowledge: nullableTextValue(row, "displayNameKnowledge", "display_name_knowledge") as RentOpsChargeDefinition["displayNameKnowledge"],
    category: nullableTextValue(row, "category", "category") as RentOpsChargeDefinition["category"],
    categoryKnowledge: nullableTextValue(row, "categoryKnowledge", "category_knowledge") as RentOpsChargeDefinition["categoryKnowledge"],
    active: nullableBooleanValue(row, "active", "active"),
    activeKnowledge: nullableTextValue(row, "activeKnowledge", "active_knowledge") as RentOpsChargeDefinition["activeKnowledge"],
  };
}

function rowToDocument(row: Record<string, unknown>): RentOpsDocument {
  return {
    id: String(row.id),
    recordRevision: revisionValue(row),
    source: source(row, "document"),
    propertyId: textValue(row, "propertyId", "property_id"),
    unitId: textValue(row, "unitId", "unit_id"),
    personId: textValue(row, "personId", "person_id"),
    tenancyId: textValue(row, "tenancyId", "tenancy_id"),
    applicationId: textValue(row, "applicationId", "application_id"),
    type: textValue(row, "type", "type") as RentOpsDocument["type"],
    typeKnowledge: textValue(row, "typeKnowledge", "type_knowledge") as RentOpsDocument["typeKnowledge"],
    state: textValue(row, "state", "state") as RentOpsDocument["state"],
    stateKnowledge: textValue(row, "stateKnowledge", "state_knowledge") as RentOpsDocument["stateKnowledge"],
    fileName: textValue(row, "fileName", "file_name") as unknown as string,
    mimeType: textValue(row, "mimeType", "mime_type") as unknown as string,
    sizeBytes: numberValue(row, "sizeBytes", "size_bytes"),
    checksumSha256: textValue(row, "checksumSha256", "checksum_sha256"),
    storageKey: textValue(row, "storageKey", "storage_key") as unknown as string,
    uploadedAt: timestampValue(get(row, "uploadedAt", "uploaded_at")) as unknown as string,
    verifiedAt: timestampValue(get(row, "verifiedAt", "verified_at")),
    availability: textValue(row, "availability", "availability") as RentOpsDocument["availability"],
    storageKeyKnowledge: textValue(row, "storageKeyKnowledge", "storage_key_knowledge") as RentOpsDocument["storageKeyKnowledge"],
    metadataSizeBytes: numberValue(row, "metadataSizeBytes", "metadata_size_bytes"),
    metadataChecksumSha256: textValue(row, "metadataChecksumSha256", "metadata_checksum_sha256"),
  } as unknown as RentOpsDocument;
}

function rowToActivity(row: Record<string, unknown>): RentOpsActivityEvent {
  return {
    id: String(row.id),
    recordRevision: revisionValue(row),
    propertyId: textValue(row, "propertyId", "property_id"),
    unitId: textValue(row, "unitId", "unit_id"),
    personId: textValue(row, "personId", "person_id"),
    tenancyId: textValue(row, "tenancyId", "tenancy_id"),
    applicationId: textValue(row, "applicationId", "application_id"),
    type: textValue(row, "type", "type") as RentOpsActivityEvent["type"],
    occurredAt: timestampValue(get(row, "occurredAt", "occurred_at")) as unknown as string,
    actor: textValue(row, "actor", "actor") as unknown as string,
    summary: textValue(row, "summary", "summary") as unknown as string,
    detail: textValue(row, "detail", "detail"),
    source: source(row, "activity"),
    occurredAtKnowledge: textValue(row, "occurredAtKnowledge", "occurred_at_knowledge") as RentOpsActivityEvent["occurredAtKnowledge"],
    actorKnowledge: textValue(row, "actorKnowledge", "actor_knowledge") as RentOpsActivityEvent["actorKnowledge"],
    summaryKnowledge: textValue(row, "summaryKnowledge", "summary_knowledge") as RentOpsActivityEvent["summaryKnowledge"],
    typeKnowledge: textValue(row, "typeKnowledge", "type_knowledge") as RentOpsActivityEvent["typeKnowledge"],
    propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsActivityEvent["propertyLinkKnowledge"],
    unitLinkKnowledge: textValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsActivityEvent["unitLinkKnowledge"],
    personLinkKnowledge: textValue(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsActivityEvent["personLinkKnowledge"],
    tenancyLinkKnowledge: textValue(row, "tenancyLinkKnowledge", "tenancy_link_knowledge") as RentOpsActivityEvent["tenancyLinkKnowledge"],
    applicationLinkKnowledge: textValue(row, "applicationLinkKnowledge", "application_link_knowledge") as RentOpsActivityEvent["applicationLinkKnowledge"],
  } as unknown as RentOpsActivityEvent;
}

function historyNullableText(row: Record<string, unknown>, camel: string, snake: string): string | null {
  const value = get(row, camel, snake);
  return value === undefined || value === null ? null : String(value);
}

function historyNullableNumber(row: Record<string, unknown>, camel: string, snake: string): number | null {
  const value = get(row, camel, snake);
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function historyNullableBoolean(row: Record<string, unknown>, camel: string, snake: string): boolean | null {
  const value = get(row, camel, snake);
  return value === undefined || value === null ? null : Boolean(value);
}

function historySource(row: Record<string, unknown>, entityType: string): NonNullable<RentOpsProspect["source"]> {
  const system = historyNullableText(row, "sourceSystem", "source_system");
  const sourceId = historyNullableText(row, "sourceId", "source_id");
  if (!system || !sourceId) throw new RentOpsInvariantError("Application history source identity is incomplete");
  const updated = timestampValue(get(row, "sourceUpdatedAt", "source_updated_at"));
  return { system, entityType, sourceId, ...(updated ? { sourceUpdatedAt: updated } : {}) };
}

function rowToHistoryProspect(row: Record<string, unknown>): RentOpsProspect {
  return {
    id: String(row.id),
    source: historySource(row, "prospect"),
    personId: historyNullableText(row, "personId", "person_id"),
    personLinkKnowledge: historyNullableText(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsProspect["personLinkKnowledge"],
    contactId: historyNullableText(row, "contactId", "contact_id"),
    contactLinkKnowledge: historyNullableText(row, "contactLinkKnowledge", "contact_link_knowledge") as RentOpsProspect["contactLinkKnowledge"],
    firstName: historyNullableText(row, "firstName", "first_name"),
    lastName: historyNullableText(row, "lastName", "last_name"),
    email: historyNullableText(row, "email", "email"),
    phone: historyNullableText(row, "phone", "phone"),
    status: historyNullableText(row, "status", "status"),
    statusKnowledge: String(get(row, "statusKnowledge", "status_knowledge")) as RentOpsProspect["statusKnowledge"],
    createdOn: nullableDateValue(get(row, "createdOn", "created_on")),
    createdOnKnowledge: String(get(row, "createdOnKnowledge", "created_on_knowledge")) as RentOpsProspect["createdOnKnowledge"],
    updatedOn: nullableDateValue(get(row, "updatedOn", "updated_on")),
    updatedOnKnowledge: String(get(row, "updatedOnKnowledge", "updated_on_knowledge")) as RentOpsProspect["updatedOnKnowledge"],
    recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1),
  };
}

function rowToHistoryApplication(row: Record<string, unknown>): RentOpsHistoricalApplication {
  return {
    id: String(row.id),
    source: historySource(row, "application_history"),
    prospectId: historyNullableText(row, "prospectId", "prospect_id"),
    prospectLinkKnowledge: historyNullableText(row, "prospectLinkKnowledge", "prospect_link_knowledge") as RentOpsHistoricalApplication["prospectLinkKnowledge"],
    personId: historyNullableText(row, "personId", "person_id"),
    personLinkKnowledge: historyNullableText(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsHistoricalApplication["personLinkKnowledge"],
    firstName: historyNullableText(row, "firstName", "first_name"),
    lastName: historyNullableText(row, "lastName", "last_name"),
    email: historyNullableText(row, "email", "email"),
    phone: historyNullableText(row, "phone", "phone"),
    status: historyNullableText(row, "status", "status") as RentOpsHistoricalApplication["status"],
    statusKnowledge: String(get(row, "statusKnowledge", "status_knowledge")) as RentOpsHistoricalApplication["statusKnowledge"],
    submittedOn: nullableDateValue(get(row, "submittedOn", "submitted_on")),
    submittedOnKnowledge: String(get(row, "submittedOnKnowledge", "submitted_on_knowledge")) as RentOpsHistoricalApplication["submittedOnKnowledge"],
    createdOn: nullableDateValue(get(row, "createdOn", "created_on")),
    createdOnKnowledge: String(get(row, "createdOnKnowledge", "created_on_knowledge")) as RentOpsHistoricalApplication["createdOnKnowledge"],
    updatedOn: nullableDateValue(get(row, "updatedOn", "updated_on")),
    updatedOnKnowledge: String(get(row, "updatedOnKnowledge", "updated_on_knowledge")) as RentOpsHistoricalApplication["updatedOnKnowledge"],
    recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1),
  };
}

function rowToHistoryInterest(row: Record<string, unknown>): RentOpsApplicationInterest {
  return {
    id: String(row.id), source: historySource(row, "interest"),
    prospectId: historyNullableText(row, "prospectId", "prospect_id"), prospectLinkKnowledge: historyNullableText(row, "prospectLinkKnowledge", "prospect_link_knowledge") as RentOpsApplicationInterest["prospectLinkKnowledge"],
    applicationId: historyNullableText(row, "applicationId", "application_id"), applicationLinkKnowledge: historyNullableText(row, "applicationLinkKnowledge", "application_link_knowledge") as RentOpsApplicationInterest["applicationLinkKnowledge"],
    propertyId: historyNullableText(row, "propertyId", "property_id"), propertyLinkKnowledge: historyNullableText(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsApplicationInterest["propertyLinkKnowledge"],
    unitId: historyNullableText(row, "unitId", "unit_id"), unitLinkKnowledge: historyNullableText(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsApplicationInterest["unitLinkKnowledge"],
    sourceOrder: historyNullableNumber(row, "sourceOrder", "source_order"), sourceRank: historyNullableNumber(row, "sourceRank", "source_rank"),
    preference: historyNullableText(row, "preference", "preference"), preferenceKnowledge: String(get(row, "preferenceKnowledge", "preference_knowledge")) as RentOpsApplicationInterest["preferenceKnowledge"],
    interestedOn: nullableDateValue(get(row, "interestedOn", "interested_on")), interestedOnKnowledge: String(get(row, "interestedOnKnowledge", "interested_on_knowledge")) as RentOpsApplicationInterest["interestedOnKnowledge"],
    rentCents: historyNullableNumber(row, "rentCents", "rent_cents"), rentKnowledge: String(get(row, "rentKnowledge", "rent_knowledge")) as RentOpsApplicationInterest["rentKnowledge"],
    bedrooms: historyNullableNumber(row, "bedrooms", "bedrooms"), bedroomsKnowledge: String(get(row, "bedroomsKnowledge", "bedrooms_knowledge")) as RentOpsApplicationInterest["bedroomsKnowledge"],
    status: historyNullableText(row, "status", "status"), statusKnowledge: String(get(row, "statusKnowledge", "status_knowledge")) as RentOpsApplicationInterest["statusKnowledge"],
    recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1),
  };
}

function rowToHistoryParticipant(row: Record<string, unknown>): RentOpsApplicationParticipant {
  return {
    id: String(row.id), source: historySource(row, "participant"),
    prospectId: historyNullableText(row, "prospectId", "prospect_id"), prospectLinkKnowledge: historyNullableText(row, "prospectLinkKnowledge", "prospect_link_knowledge") as RentOpsApplicationParticipant["prospectLinkKnowledge"],
    applicationId: historyNullableText(row, "applicationId", "application_id"), applicationLinkKnowledge: historyNullableText(row, "applicationLinkKnowledge", "application_link_knowledge") as RentOpsApplicationParticipant["applicationLinkKnowledge"],
    personId: historyNullableText(row, "personId", "person_id"), personLinkKnowledge: historyNullableText(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsApplicationParticipant["personLinkKnowledge"],
    sourceOrder: historyNullableNumber(row, "sourceOrder", "source_order"), role: historyNullableText(row, "role", "role"), roleKnowledge: String(get(row, "roleKnowledge", "role_knowledge")) as RentOpsApplicationParticipant["roleKnowledge"],
    relationship: historyNullableText(row, "relationship", "relationship"), relationshipKnowledge: String(get(row, "relationshipKnowledge", "relationship_knowledge")) as RentOpsApplicationParticipant["relationshipKnowledge"],
    isMinor: historyNullableBoolean(row, "isMinor", "is_minor"), minorKnowledge: String(get(row, "minorKnowledge", "minor_knowledge")) as RentOpsApplicationParticipant["minorKnowledge"],
    isFinanciallyResponsible: historyNullableBoolean(row, "isFinanciallyResponsible", "is_financially_responsible"), financialResponsibilityKnowledge: String(get(row, "financialResponsibilityKnowledge", "financial_responsibility_knowledge")) as RentOpsApplicationParticipant["financialResponsibilityKnowledge"],
    origin: String(get(row, "origin", "origin")) as RentOpsApplicationParticipant["origin"], recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1),
  };
}

function rowToHistoryRequirement(row: Record<string, unknown>): RentOpsApplicationRequirementOccurrence {
  return {
    id: String(row.id), source: historySource(row, "requirement"),
    prospectId: historyNullableText(row, "prospectId", "prospect_id"), prospectLinkKnowledge: historyNullableText(row, "prospectLinkKnowledge", "prospect_link_knowledge") as RentOpsApplicationRequirementOccurrence["prospectLinkKnowledge"],
    applicationId: historyNullableText(row, "applicationId", "application_id"), applicationLinkKnowledge: historyNullableText(row, "applicationLinkKnowledge", "application_link_knowledge") as RentOpsApplicationRequirementOccurrence["applicationLinkKnowledge"],
    key: historyNullableText(row, "key", "key"), label: historyNullableText(row, "label", "label"), status: historyNullableText(row, "status", "status") as RentOpsApplicationRequirementOccurrence["status"], statusKnowledge: String(get(row, "statusKnowledge", "status_knowledge")) as RentOpsApplicationRequirementOccurrence["statusKnowledge"],
    requestedOn: nullableDateValue(get(row, "requestedOn", "requested_on")), requestedOnKnowledge: String(get(row, "requestedOnKnowledge", "requested_on_knowledge")) as RentOpsApplicationRequirementOccurrence["requestedOnKnowledge"],
    resolvedOn: nullableDateValue(get(row, "resolvedOn", "resolved_on")), resolvedOnKnowledge: String(get(row, "resolvedOnKnowledge", "resolved_on_knowledge")) as RentOpsApplicationRequirementOccurrence["resolvedOnKnowledge"],
    documentId: historyNullableText(row, "documentId", "document_id"), documentLinkKnowledge: historyNullableText(row, "documentLinkKnowledge", "document_link_knowledge") as RentOpsApplicationRequirementOccurrence["documentLinkKnowledge"],
    origin: String(get(row, "origin", "origin")) as RentOpsApplicationRequirementOccurrence["origin"], recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1),
  };
}

function rowToHistoryTemplate(row: Record<string, unknown>): RentOpsApplicationTemplateDefinition {
  return { id: String(row.id), source: historySource(row, "template"), name: historyNullableText(row, "name", "name"), nameKnowledge: String(get(row, "nameKnowledge", "name_knowledge")) as RentOpsApplicationTemplateDefinition["nameKnowledge"], active: historyNullableBoolean(row, "active", "active"), activeKnowledge: String(get(row, "activeKnowledge", "active_knowledge")) as RentOpsApplicationTemplateDefinition["activeKnowledge"], recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1) };
}

function rowToHistorySection(row: Record<string, unknown>): RentOpsApplicationTemplateSectionDefinition {
  return { id: String(row.id), source: historySource(row, "template_section"), templateId: historyNullableText(row, "templateId", "template_id"), templateLinkKnowledge: historyNullableText(row, "templateLinkKnowledge", "template_link_knowledge") as RentOpsApplicationTemplateSectionDefinition["templateLinkKnowledge"], name: historyNullableText(row, "name", "name"), nameKnowledge: String(get(row, "nameKnowledge", "name_knowledge")) as RentOpsApplicationTemplateSectionDefinition["nameKnowledge"], sourceOrder: historyNullableNumber(row, "sourceOrder", "source_order"), recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1) };
}

function rowToHistoryField(row: Record<string, unknown>): RentOpsApplicationTemplateFieldDefinition {
  return { id: String(row.id), source: historySource(row, "template_field"), templateId: historyNullableText(row, "templateId", "template_id"), templateLinkKnowledge: historyNullableText(row, "templateLinkKnowledge", "template_link_knowledge") as RentOpsApplicationTemplateFieldDefinition["templateLinkKnowledge"], sectionId: historyNullableText(row, "sectionId", "section_id"), sectionLinkKnowledge: historyNullableText(row, "sectionLinkKnowledge", "section_link_knowledge") as RentOpsApplicationTemplateFieldDefinition["sectionLinkKnowledge"], key: historyNullableText(row, "key", "key"), label: historyNullableText(row, "label", "label"), valueType: historyNullableText(row, "valueType", "value_type") as RentOpsApplicationTemplateFieldDefinition["valueType"], sensitive: historyNullableBoolean(row, "sensitive", "sensitive") ?? false, sourceOrder: historyNullableNumber(row, "sourceOrder", "source_order"), recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1) };
}

function rowToHistoryAnswer(row: Record<string, unknown>): RentOpsApplicationAnswerOccurrence {
  const rawValue = get(row, "value", "safe_value");
  return { id: String(row.id), source: historySource(row, "answer"), prospectId: historyNullableText(row, "prospectId", "prospect_id"), prospectLinkKnowledge: historyNullableText(row, "prospectLinkKnowledge", "prospect_link_knowledge") as RentOpsApplicationAnswerOccurrence["prospectLinkKnowledge"], applicationId: historyNullableText(row, "applicationId", "application_id"), applicationLinkKnowledge: historyNullableText(row, "applicationLinkKnowledge", "application_link_knowledge") as RentOpsApplicationAnswerOccurrence["applicationLinkKnowledge"], fieldId: historyNullableText(row, "fieldId", "field_id"), fieldLinkKnowledge: historyNullableText(row, "fieldLinkKnowledge", "field_link_knowledge") as RentOpsApplicationAnswerOccurrence["fieldLinkKnowledge"], valueType: String(get(row, "valueType", "value_type")) as RentOpsApplicationAnswerOccurrence["valueType"], value: rawValue === undefined || rawValue === null ? null : (typeof rawValue === "string" ? (() => { try { return JSON.parse(rawValue); } catch { return null; } })() : rawValue) as RentOpsApplicationAnswerOccurrence["value"], valueKnowledge: String(get(row, "valueKnowledge", "value_knowledge")) as RentOpsApplicationAnswerOccurrence["valueKnowledge"], recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1) };
}

function rowToHistoryDocument(row: Record<string, unknown>): RentOpsApplicationHistoryDocument {
  return { id: String(row.id), source: historySource(row, "document"), prospectId: historyNullableText(row, "prospectId", "prospect_id"), prospectLinkKnowledge: historyNullableText(row, "prospectLinkKnowledge", "prospect_link_knowledge") as RentOpsApplicationHistoryDocument["prospectLinkKnowledge"], applicationId: historyNullableText(row, "applicationId", "application_id"), applicationLinkKnowledge: historyNullableText(row, "applicationLinkKnowledge", "application_link_knowledge") as RentOpsApplicationHistoryDocument["applicationLinkKnowledge"], type: historyNullableText(row, "type", "type") as RentOpsApplicationHistoryDocument["type"], typeKnowledge: String(get(row, "typeKnowledge", "type_knowledge")) as RentOpsApplicationHistoryDocument["typeKnowledge"], state: historyNullableText(row, "state", "state") as RentOpsApplicationHistoryDocument["state"], stateKnowledge: String(get(row, "stateKnowledge", "state_knowledge")) as RentOpsApplicationHistoryDocument["stateKnowledge"], fileName: historyNullableText(row, "fileName", "file_name"), mimeType: historyNullableText(row, "mimeType", "mime_type"), metadataSizeBytes: historyNullableNumber(row, "metadataSizeBytes", "metadata_size_bytes"), metadataChecksumSha256: historyNullableText(row, "metadataChecksumSha256", "metadata_checksum_sha256"), availability: String(get(row, "availability", "availability")) as RentOpsApplicationHistoryDocument["availability"], recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1) };
}

function rowToHistoryActivity(row: Record<string, unknown>): RentOpsApplicationHistoryActivity {
  return { id: String(row.id), source: historySource(row, "activity"), prospectId: historyNullableText(row, "prospectId", "prospect_id"), prospectLinkKnowledge: historyNullableText(row, "prospectLinkKnowledge", "prospect_link_knowledge") as RentOpsApplicationHistoryActivity["prospectLinkKnowledge"], applicationId: historyNullableText(row, "applicationId", "application_id"), applicationLinkKnowledge: historyNullableText(row, "applicationLinkKnowledge", "application_link_knowledge") as RentOpsApplicationHistoryActivity["applicationLinkKnowledge"], type: historyNullableText(row, "type", "type") as RentOpsApplicationHistoryActivity["type"], occurredAt: timestampValue(get(row, "occurredAt", "occurred_at")) ?? null, occurredAtKnowledge: String(get(row, "occurredAtKnowledge", "occurred_at_knowledge")) as RentOpsApplicationHistoryActivity["occurredAtKnowledge"], actor: historyNullableText(row, "actor", "actor"), actorKnowledge: String(get(row, "actorKnowledge", "actor_knowledge")) as RentOpsApplicationHistoryActivity["actorKnowledge"], summary: historyNullableText(row, "summary", "summary"), summaryKnowledge: String(get(row, "summaryKnowledge", "summary_knowledge")) as RentOpsApplicationHistoryActivity["summaryKnowledge"], recordRevision: Number(get(row, "recordRevision", "record_revision") ?? 1) };
}

function historyBlockerId(value: RentOpsApplicationHistoryBlocker): string {
  const key = `${value.code}\u0000${value.applicationId ?? ""}\u0000${value.prospectId ?? ""}`;
  return `rm-history:blocker:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

function rowToHistoryBlocker(row: Record<string, unknown>): RentOpsApplicationHistoryBlocker {
  return { code: String(get(row, "code", "code")) as RentOpsApplicationHistoryBlocker["code"], applicationId: historyNullableText(row, "applicationId", "application_id") ?? undefined, prospectId: historyNullableText(row, "prospectId", "prospect_id") ?? undefined, occurrenceCount: Number(get(row, "occurrenceCount", "occurrence_count") ?? 0), reason: String(get(row, "reason", "reason")) as RentOpsApplicationHistoryBlocker["reason"] };
}

function historySourceValues(sourceRef: NonNullable<RentOpsProspect["source"]>): unknown[] {
  return [sourceRef.system, sourceRef.sourceId, sourceRef.sourceUpdatedAt ?? null];
}

function historyValues(history: RentOpsApplicationHistorySnapshot): HistoryInsertDescriptor[] {
  const prospects = history.prospects.map((row) => [row.id, ...historySourceValues(row.source), row.personId ?? null, row.personLinkKnowledge ?? null, row.contactId ?? null, row.contactLinkKnowledge ?? null, row.firstName ?? null, row.lastName ?? null, row.email ?? null, row.phone ?? null, row.status ?? null, row.statusKnowledge, row.createdOn ?? null, row.createdOnKnowledge, row.updatedOn ?? null, row.updatedOnKnowledge, row.recordRevision]);
  const applications = history.applications.map((row) => [row.id, ...historySourceValues(row.source), row.prospectId ?? null, row.prospectLinkKnowledge ?? null, row.personId ?? null, row.personLinkKnowledge ?? null, row.firstName ?? null, row.lastName ?? null, row.email ?? null, row.phone ?? null, row.status ?? null, row.statusKnowledge, row.submittedOn ?? null, row.submittedOnKnowledge, row.createdOn ?? null, row.createdOnKnowledge, row.updatedOn ?? null, row.updatedOnKnowledge, row.recordRevision]);
  const interests = history.interests.map((row) => [row.id, ...historySourceValues(row.source), row.prospectId ?? null, row.prospectLinkKnowledge ?? null, row.applicationId ?? null, row.applicationLinkKnowledge ?? null, row.propertyId ?? null, row.propertyLinkKnowledge ?? null, row.unitId ?? null, row.unitLinkKnowledge ?? null, row.sourceOrder ?? null, row.sourceRank ?? null, row.preference ?? null, row.preferenceKnowledge, row.interestedOn ?? null, row.interestedOnKnowledge, row.rentCents ?? null, row.rentKnowledge, row.bedrooms ?? null, row.bedroomsKnowledge, row.status ?? null, row.statusKnowledge, row.recordRevision]);
  const participants = history.participants.map((row) => [row.id, ...historySourceValues(row.source), row.prospectId ?? null, row.prospectLinkKnowledge ?? null, row.applicationId ?? null, row.applicationLinkKnowledge ?? null, row.personId ?? null, row.personLinkKnowledge ?? null, row.sourceOrder ?? null, row.role ?? null, row.roleKnowledge, row.relationship ?? null, row.relationshipKnowledge, row.isMinor ?? null, row.minorKnowledge, row.isFinanciallyResponsible ?? null, row.financialResponsibilityKnowledge, row.origin, row.recordRevision]);
  const requirements = history.requirements.map((row) => [row.id, ...historySourceValues(row.source), row.prospectId ?? null, row.prospectLinkKnowledge ?? null, row.applicationId ?? null, row.applicationLinkKnowledge ?? null, row.key ?? null, row.label ?? null, row.status ?? null, row.statusKnowledge, row.requestedOn ?? null, row.requestedOnKnowledge, row.resolvedOn ?? null, row.resolvedOnKnowledge, row.documentId ?? null, row.documentLinkKnowledge ?? null, row.origin, row.recordRevision]);
  const templates = history.templates.map((row) => [row.id, ...historySourceValues(row.source), row.name ?? null, row.nameKnowledge, row.active ?? null, row.activeKnowledge, row.recordRevision]);
  const sections = history.templateSections.map((row) => [row.id, ...historySourceValues(row.source), row.templateId ?? null, row.templateLinkKnowledge ?? null, row.name ?? null, row.nameKnowledge, row.sourceOrder ?? null, row.recordRevision]);
  const fields = history.templateFields.map((row) => [row.id, ...historySourceValues(row.source), row.templateId ?? null, row.templateLinkKnowledge ?? null, row.sectionId ?? null, row.sectionLinkKnowledge ?? null, row.key ?? null, row.label ?? null, row.valueType ?? null, row.sensitive, row.sourceOrder ?? null, row.recordRevision]);
  const answers = history.answers.map((row) => [row.id, ...historySourceValues(row.source), row.prospectId ?? null, row.prospectLinkKnowledge ?? null, row.applicationId ?? null, row.applicationLinkKnowledge ?? null, row.fieldId ?? null, row.fieldLinkKnowledge ?? null, row.valueType, row.value === undefined || row.value === null ? null : JSON.stringify(row.value), row.valueKnowledge, row.recordRevision]);
  const documents = history.documents.map((row) => [row.id, ...historySourceValues(row.source), row.prospectId ?? null, row.prospectLinkKnowledge ?? null, row.applicationId ?? null, row.applicationLinkKnowledge ?? null, row.type ?? null, row.typeKnowledge, row.state ?? null, row.stateKnowledge, row.fileName ?? null, row.mimeType ?? null, row.metadataSizeBytes ?? null, row.metadataChecksumSha256 ?? null, row.availability, row.recordRevision]);
  const activities = history.activities.map((row) => [row.id, ...historySourceValues(row.source), row.prospectId ?? null, row.prospectLinkKnowledge ?? null, row.applicationId ?? null, row.applicationLinkKnowledge ?? null, row.type ?? null, row.occurredAt ?? null, row.occurredAtKnowledge, row.actor ?? null, row.actorKnowledge, row.summary ?? null, row.summaryKnowledge, row.recordRevision]);
  const blockers = history.blockers.map((row) => [historyBlockerId(row), row.code, row.applicationId ?? null, row.prospectId ?? null, row.occurrenceCount, row.reason]);
  const aggregate = [[HISTORY_AGGREGATE_ID, history.unknownRestricted.restrictedAnswerCount, history.unknownRestricted.unmappedAnswerCount, history.unknownRestricted.missingAnswerApplications, history.unknownRestricted.metadataOnlyDocumentCount, history.unknownRestricted.unavailableDocumentCount, history.unknownRestricted.unlinkedActivityCount, history.unknownRestricted.unlinkedInterestCount, 1]];
  return [
    { table: "rent_ops_prospects", columns: [...historyProspectColumns], rows: prospects },
    { table: "rent_ops_application_history", columns: [...historyApplicationColumns], rows: applications },
    { table: "rent_ops_application_template_definitions", columns: [...historyTemplateColumns], rows: templates },
    { table: "rent_ops_application_template_sections", columns: [...historySectionColumns], rows: sections },
    { table: "rent_ops_application_template_fields", columns: [...historyFieldColumns], rows: fields },
    { table: "rent_ops_application_interests", columns: [...historyInterestColumns], rows: interests },
    { table: "rent_ops_application_participants", columns: [...historyParticipantColumns], rows: participants },
    { table: "rent_ops_application_history_documents", columns: [...historyDocumentColumns], rows: documents },
    { table: "rent_ops_application_requirement_occurrences", columns: [...historyRequirementColumns], rows: requirements },
    { table: "rent_ops_application_answer_occurrences", columns: [...historyAnswerColumns], rows: answers },
    { table: "rent_ops_application_history_activities", columns: [...historyActivityColumns], rows: activities },
    { table: "rent_ops_application_history_blockers", columns: [...historyBlockerColumns], rows: blockers },
    { table: "rent_ops_application_history_aggregates", columns: [...historyAggregateColumns], rows: aggregate },
  ];
}

function comparableHistoryValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function sameHistoryValue(left: unknown, right: unknown): boolean {
  const a = comparableHistoryValue(left);
  const b = comparableHistoryValue(right);
  if (typeof a === "string" && typeof b === "string") return a === b || (a.length === 10 && b.startsWith(`${a}T`)) || (b.length === 10 && a.startsWith(`${b}T`));
  return Object.is(a, b) || String(a) === String(b);
}

export class PostgresRentOpsRepository implements RentOpsRepository {
  private ready = false;

  constructor(private readonly client: RentOpsQueryExecutor, private readonly inTransaction = false) {}

  async transaction<T>(work: (repository: RentOpsRepository) => Promise<T>, options: RentOpsTransactionOptions = {}): Promise<T> {
    if (!this.client.transaction) throw new RentOpsInvariantError("Rent Operations database executor does not support atomic transactions");
    await this.assertReady();
    return this.client.transaction(async (executor) => {
      const repository = new PostgresRentOpsRepository(executor, true);
      repository.ready = true;
      await repository.lockRowsForOperation(options);
      return work(repository);
    }, { readOnly: false });
  }

  /** Serialize operations whose invariants span multiple append-only rows. */
  private async lockRowsForOperation(options: RentOpsTransactionOptions): Promise<void> {
    if (options.lockRecord) {
      const table = patchTables[options.lockRecord.entityType];
      if (!table) throw new RentOpsInvariantError("Unknown Rent Operations patch target");
      if (options.lockTenancySiblings) {
        const requestedUnitIds = Array.from(new Set(options.lockTenancyUnitIds ?? [])).filter((id) => id.length > 0).sort();
        await this.client.query(
          "SELECT id FROM rent_ops_tenancies WHERE unit_id = (SELECT unit_id FROM rent_ops_tenancies WHERE id = $1) OR unit_id = ANY($2::varchar[]) ORDER BY unit_id, id FOR UPDATE",
          [options.lockRecord.targetId, requestedUnitIds],
        );
      }
      if (options.lockLeaseSiblings) {
        const requestedTenancyIds = Array.from(new Set(options.lockLeaseTenancyIds ?? [])).filter((id) => id.length > 0).sort();
        // Lock the source and requested destination tenancy rows first. A
        // destination with no lease rows still needs a lock, otherwise two
        // concurrent moves could both pass the sibling-overlap check.
        await this.client.query(
          "SELECT id FROM rent_ops_tenancies WHERE id = (SELECT tenancy_id FROM rent_ops_lease_terms WHERE id = $1) OR id = ANY($2::varchar[]) ORDER BY id FOR UPDATE",
          [options.lockRecord.targetId, requestedTenancyIds],
        );
        await this.client.query(
          "SELECT id FROM rent_ops_lease_terms WHERE tenancy_id = (SELECT tenancy_id FROM rent_ops_lease_terms WHERE id = $1) OR tenancy_id = ANY($2::varchar[]) ORDER BY tenancy_id, id FOR UPDATE",
          [options.lockRecord.targetId, requestedTenancyIds],
        );
      }
      // Parent sibling sets are locked first in deterministic order. This
      // prevents two cross-parent moves from deadlocking on each other's old
      // target rows while still locking the target itself below.
      await this.client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [options.lockRecord.targetId]);
    }
    if (options.lockApplicationId) {
      const application = await this.client.query<{ unit_id?: string | null }>("SELECT unit_id FROM rent_ops_applications WHERE id = $1 FOR UPDATE", [options.lockApplicationId]);
      const unitId = application.rows[0]?.unit_id;
      if (unitId) await this.client.query("SELECT id FROM rent_ops_units WHERE id = $1 FOR UPDATE", [unitId]);
    }
    const transactionIds = Array.from(new Set(options.lockTransactionIds ?? [])).sort();
    if (transactionIds.length > 0) await this.client.query("SELECT id FROM rent_ops_ledger_transactions WHERE id = ANY($1::varchar[]) FOR UPDATE", [transactionIds]);
  }

  async assertReady(): Promise<void> {
    if (this.ready) return;
    try {
      const result = await this.client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])", [Array.from(RENT_OPS_RUNTIME_REQUIRED_TABLES)]);
      const found = new Set(result.rows.map((row) => row.table_name));
      const missing = RENT_OPS_RUNTIME_REQUIRED_TABLES.filter((tableName) => !found.has(tableName));
      if (missing.length > 0) throw new RentOpsTablesMissingError(missing);
      const privilegeResult = await this.client.query<{ table_name?: string; can_select?: boolean; can_insert?: boolean; can_update?: boolean; can_delete?: boolean }>(
        "SELECT table_name, has_table_privilege(current_user, table_name, 'SELECT') AS can_select, has_table_privilege(current_user, table_name, 'INSERT') AS can_insert, has_table_privilege(current_user, table_name, 'UPDATE') AS can_update, has_table_privilege(current_user, table_name, 'DELETE') AS can_delete FROM unnest($1::text[]) AS table_name",
        [runtimeForbiddenTables],
      );
      if (privilegeResult.rows.length !== runtimeForbiddenTables.length || privilegeResult.rows.some((row) => row.can_select === true || row.can_insert === true || row.can_update === true || row.can_delete === true)) {
        throw new RentOpsRuntimePrivilegeError();
      }
      this.ready = true;
    } catch (error) {
      if (error instanceof RentOpsTablesMissingError || error instanceof RentOpsRuntimePrivilegeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/relation .* does not exist|undefined table|42P01/i.test(message)) throw new RentOpsTablesMissingError([...RENT_OPS_RUNTIME_REQUIRED_TABLES]);
      throw error;
    }
  }

  private async rows(tableName: string, executor: RentOpsQueryExecutor = this.client): Promise<Record<string, unknown>[]> {
    if (!tableNames.has(tableName)) throw new Error(`Unsafe Rent Operations table name: ${tableName}`);
    const result = await executor.query<Record<string, unknown>>(`SELECT * FROM ${tableName}`);
    return result.rows;
  }

  async getSnapshot(): Promise<RentOpsSnapshot> {
    await this.assertReady();
    const snapshot = this.client.transaction
      ? await this.client.transaction((executor) => this.loadSnapshot(executor), { readOnly: true })
      : await this.loadSnapshot(this.client);
    assertValidSnapshot(snapshot);
    return snapshot;
  }

  private async loadSnapshot(executor: RentOpsQueryExecutor): Promise<RentOpsSnapshot> {
    const snapshot = emptyRentOpsSnapshot();
    const [propertyRows, unitRows, peopleRows, tenancyRows, householdRows, leaseRows, chargeDefinitionRows, scheduleRows, ledgerRows, allocationRows, depositRows, subsidyRows, subsidyTenantRows, subsidyPaymentRows, applicationRows, applicationMemberRows, requirementRows, documentRows, activityRows, historyProspectRows, historyApplicationRows, historyInterestRows, historyParticipantRows, historyRequirementRows, historyTemplateRows, historySectionRows, historyFieldRows, historyAnswerRows, historyDocumentRows, historyActivityRows, historyBlockerRows, historyAggregateRows] = await Promise.all([
      this.rows("rent_ops_properties", executor),
      this.rows("rent_ops_units", executor),
      this.rows("rent_ops_people", executor),
      this.rows("rent_ops_tenancies", executor),
      this.rows("rent_ops_household_memberships", executor),
      this.rows("rent_ops_lease_terms", executor),
      this.rows("rent_ops_charge_definitions", executor),
      this.rows("rent_ops_recurring_charge_schedules", executor),
      this.rows("rent_ops_ledger_transactions", executor),
      this.rows("rent_ops_payment_allocations", executor),
      this.rows("rent_ops_security_deposits", executor),
      this.rows("rent_ops_subsidy_contracts", executor),
      this.rows("rent_ops_subsidy_tenants", executor),
      this.rows("rent_ops_subsidy_payments", executor),
      this.rows("rent_ops_applications", executor),
      this.rows("rent_ops_application_household_members", executor),
      this.rows("rent_ops_application_requirements", executor),
      this.rows("rent_ops_documents", executor),
      this.rows("rent_ops_activity_events", executor),
      this.rows("rent_ops_prospects", executor),
      this.rows("rent_ops_application_history", executor),
      this.rows("rent_ops_application_interests", executor),
      this.rows("rent_ops_application_participants", executor),
      this.rows("rent_ops_application_requirement_occurrences", executor),
      this.rows("rent_ops_application_template_definitions", executor),
      this.rows("rent_ops_application_template_sections", executor),
      this.rows("rent_ops_application_template_fields", executor),
      this.rows("rent_ops_application_answer_occurrences", executor),
      this.rows("rent_ops_application_history_documents", executor),
      this.rows("rent_ops_application_history_activities", executor),
      this.rows("rent_ops_application_history_blockers", executor),
      this.rows("rent_ops_application_history_aggregates", executor),
    ]);
    snapshot.properties = propertyRows.map(rowToProperty);
    snapshot.units = unitRows.map(rowToUnit);
    snapshot.people = peopleRows.map(rowToPerson);
    snapshot.tenancies = tenancyRows.map(rowToTenancy);
    snapshot.householdMemberships = householdRows.map(rowToHouseholdMembership);
    snapshot.leaseTerms = leaseRows.map(rowToLeaseTerm);
    snapshot.chargeDefinitions = chargeDefinitionRows.map(rowToChargeDefinition);
    snapshot.recurringSchedules = scheduleRows.map(rowToSchedule);
    snapshot.ledgerTransactions = ledgerRows.map(rowToLedger);
    snapshot.paymentAllocations = allocationRows.map(rowToAllocation);
    snapshot.securityDeposits = depositRows.map((row) => ({ id: String(row.id), recordRevision: revisionValue(row), source: source(row, "deposit"), propertyId: textValue(row, "propertyId", "property_id"), propertyLinkKnowledge: textValue(row, "propertyLinkKnowledge", "property_link_knowledge") as RentOpsSecurityDeposit["propertyLinkKnowledge"], unitId: textValue(row, "unitId", "unit_id"), unitLinkKnowledge: textValue(row, "unitLinkKnowledge", "unit_link_knowledge") as RentOpsSecurityDeposit["unitLinkKnowledge"], tenancyId: textValue(row, "tenancyId", "tenancy_id"), personId: textValue(row, "personId", "person_id"), personLinkKnowledge: textValue(row, "personLinkKnowledge", "person_link_knowledge") as RentOpsSecurityDeposit["personLinkKnowledge"], type: textValue(row, "type", "type") as RentOpsSecurityDeposit["type"], typeKnowledge: textValue(row, "typeKnowledge", "type_knowledge") as RentOpsSecurityDeposit["typeKnowledge"], amountHeldCents: numberValue(row, "amountHeldCents", "amount_held_cents") ?? null, sourceBalanceCents: numberValue(row, "sourceBalanceCents", "source_balance_cents") ?? null, receivedOn: dateValue(get(row, "receivedOn", "received_on")) as RentOpsSecurityDeposit["receivedOn"], receivedOnKnowledge: textValue(row, "receivedOnKnowledge", "received_on_knowledge") as RentOpsSecurityDeposit["receivedOnKnowledge"], dispositionStatus: textValue(row, "dispositionStatus", "disposition_status") as RentOpsSecurityDeposit["dispositionStatus"], dispositionStatusKnowledge: textValue(row, "dispositionStatusKnowledge", "disposition_status_knowledge") as RentOpsSecurityDeposit["dispositionStatusKnowledge"], disposedOn: dateValue(get(row, "disposedOn", "disposed_on")) as RentOpsSecurityDeposit["disposedOn"], dispositionNotes: textValue(row, "dispositionNotes", "disposition_notes") })) as unknown as RentOpsSecurityDeposit[];
    snapshot.subsidyContracts = subsidyRows.map((row) => ({ id: String(row.id), recordRevision: revisionValue(row), source: source(row, "subsidy"), propertyId: textValue(row, "propertyId", "property_id") as unknown as string, unitId: textValue(row, "unitId", "unit_id") as unknown as string, tenancyId: textValue(row, "tenancyId", "tenancy_id") as unknown as string, agencyName: textValue(row, "agencyName", "agency_name") as unknown as string, contractNumber: textValue(row, "contractNumber", "contract_number"), effectiveFrom: dateValue(get(row, "effectiveFrom", "effective_from")) as unknown as string, effectiveTo: dateValue(get(row, "effectiveTo", "effective_to")) as RentOpsSubsidyContract["effectiveTo"], agencyObligationCents: numberValue(row, "agencyObligationCents", "agency_obligation_cents") as unknown as number, tenantObligationCents: numberValue(row, "tenantObligationCents", "tenant_obligation_cents") as unknown as number, status: textValue(row, "status", "status") as RentOpsSubsidyContract["status"], statusKnowledge: textValue(row, "statusKnowledge", "status_knowledge") as RentOpsSubsidyContract["statusKnowledge"] })) as unknown as RentOpsSubsidyContract[];
    snapshot.subsidyTenants = subsidyTenantRows.map(rowToSubsidyTenant);
    snapshot.subsidyContractMembers = snapshot.subsidyTenants;
    snapshot.subsidyPayments = subsidyPaymentRows.map(rowToSubsidyPayment);
    snapshot.applications = applicationRows.map(rowToApplicationV3);
    snapshot.applicationHouseholdMembers = applicationMemberRows.map((row) => ({ id: String(row.id), applicationId: String(get(row, "applicationId", "application_id")), firstName: String(get(row, "firstName", "first_name")), lastName: String(get(row, "lastName", "last_name")), relationship: textValue(row, "relationship", "relationship"), email: textValue(row, "email", "email"), phone: textValue(row, "phone", "phone"), isMinor: boolValue(row, "isMinor", "is_minor") }));
    snapshot.applicationRequirements = requirementRows.map((row) => ({ id: String(row.id), applicationId: String(get(row, "applicationId", "application_id")), key: String(row.key), label: String(row.label), status: String(row.status) as RentOpsApplicationRequirement["status"], documentId: textValue(row, "documentId", "document_id"), requestedOn: String(get(row, "requestedOn", "requested_on")), resolvedOn: dateValue(get(row, "resolvedOn", "resolved_on")) as RentOpsApplicationRequirement["resolvedOn"] }));
    snapshot.documents = documentRows.map(rowToDocument);
    snapshot.activityEvents = activityRows.map(rowToActivity);
    const hasApplicationHistoryRows = [historyProspectRows, historyApplicationRows, historyInterestRows, historyParticipantRows, historyRequirementRows, historyTemplateRows, historySectionRows, historyFieldRows, historyAnswerRows, historyDocumentRows, historyActivityRows, historyBlockerRows, historyAggregateRows].some((rows) => rows.length > 0);
    if (hasApplicationHistoryRows) {
      if (historyAggregateRows.length !== 1) throw new RentOpsInvariantError("Application history aggregate is missing or duplicated");
      snapshot.applicationHistory = {
        prospects: historyProspectRows.map(rowToHistoryProspect),
        applications: historyApplicationRows.map(rowToHistoryApplication),
        interests: historyInterestRows.map(rowToHistoryInterest),
        participants: historyParticipantRows.map(rowToHistoryParticipant),
        requirements: historyRequirementRows.map(rowToHistoryRequirement),
        templates: historyTemplateRows.map(rowToHistoryTemplate),
        templateSections: historySectionRows.map(rowToHistorySection),
        templateFields: historyFieldRows.map(rowToHistoryField),
        answers: historyAnswerRows.map(rowToHistoryAnswer),
        documents: historyDocumentRows.map(rowToHistoryDocument),
        activities: historyActivityRows.map(rowToHistoryActivity),
        blockers: historyBlockerRows.map(rowToHistoryBlocker),
        unknownRestricted: {
          restrictedAnswerCount: Number(get(historyAggregateRows[0], "restrictedAnswerCount", "restricted_answer_count") ?? 0),
          unmappedAnswerCount: Number(get(historyAggregateRows[0], "unmappedAnswerCount", "unmapped_answer_count") ?? 0),
          missingAnswerApplications: Number(get(historyAggregateRows[0], "missingAnswerApplications", "missing_answer_applications") ?? 0),
          metadataOnlyDocumentCount: Number(get(historyAggregateRows[0], "metadataOnlyDocumentCount", "metadata_only_document_count") ?? 0),
          unavailableDocumentCount: Number(get(historyAggregateRows[0], "unavailableDocumentCount", "unavailable_document_count") ?? 0),
          unlinkedActivityCount: Number(get(historyAggregateRows[0], "unlinkedActivityCount", "unlinked_activity_count") ?? 0),
          unlinkedInterestCount: Number(get(historyAggregateRows[0], "unlinkedInterestCount", "unlinked_interest_count") ?? 0),
        },
      };
      assertValidApplicationHistory(snapshot.applicationHistory);
    }
    if (propertyRows.some((row) => Object.prototype.hasOwnProperty.call(row, "name_knowledge"))
      || chargeDefinitionRows.length > 0
      || ledgerRows.some((row) => Object.prototype.hasOwnProperty.call(row, "amount_knowledge"))
      || documentRows.some((row) => Object.prototype.hasOwnProperty.call(row, "availability"))) snapshot.modelVersion = 3;
    return snapshot;
  }

  private async upsert(tableName: string, columns: string[], values: unknown[], updateColumns = columns.slice(1)): Promise<void> {
    if (!tableNames.has(tableName)) throw new Error(`Unsafe Rent Operations table name: ${tableName}`);
    if (runtimeCreateOnlyTables.has(tableName)) {
      await this.insertOnlyCreate(tableName, columns, values);
      return;
    }
    await this.assertReady();
    const sourceSystemIndex = columns.indexOf("source_system");
    const sourceIdIndex = columns.indexOf("source_id");
    if ((sourceSystemIndex >= 0) !== (sourceIdIndex >= 0)) throw new RentOpsInvariantError("Source provenance columns must be supplied as a pair");
    const safeUpdateColumns = updateColumns.filter((column) => column !== "source_system" && column !== "source_id");
    if (sourceSystemIndex >= 0 && sourceIdIndex >= 0) {
      const expectedSystem = values[sourceSystemIndex] ?? null;
      const expectedId = values[sourceIdIndex] ?? null;
      if ((expectedSystem === null) !== (expectedId === null)) throw new RentOpsInvariantError("Source provenance columns must be supplied as a pair");
      const existing = await this.client.query<{ source_system?: string | null; source_id?: string | null }>(`SELECT source_system, source_id FROM ${tableName} WHERE id = $1 LIMIT 1`, [values[0]]);
      const row = existing.rows[0];
      if (row && (row.source_system !== null && row.source_system !== undefined || row.source_id !== null && row.source_id !== undefined)) {
        if (expectedSystem !== null && String(row.source_system ?? "") !== String(expectedSystem)) throw new RentOpsInvariantError("Imported source_system is immutable");
        if (expectedId !== null && String(row.source_id ?? "") !== String(expectedId)) throw new RentOpsInvariantError("Imported source_id is immutable");
        if (expectedSystem === null || expectedId === null) throw new RentOpsInvariantError("Imported source provenance cannot be cleared");
      }
    }
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const updates = safeUpdateColumns.map((column) => `${column}=EXCLUDED.${column}`).join(", ");
    const conflict = safeUpdateColumns.length > 0 ? `DO UPDATE SET ${updates}` : "DO NOTHING";
    await this.client.query(`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (id) ${conflict}`, values);
  }

  private async insertOnlyCreate(tableName: string, columns: string[], values: unknown[]): Promise<void> {
    if (!tableNames.has(tableName)) throw new Error(`Unsafe Rent Operations table name: ${tableName}`);
    await this.assertReady();
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const inserted = await this.client.query<Record<string, unknown>>(`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING RETURNING id`, values);
    if (inserted.rows.length > 0) return;
    throw new RentOpsInvariantError(`${tableName} record already exists; use PATCH for an existing record`);
  }

  private async insertOnly(tableName: string, columns: string[], values: unknown[]): Promise<void> {
    if (!tableNames.has(tableName)) throw new Error(`Unsafe Rent Operations table name: ${tableName}`);
    await this.assertReady();
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const inserted = await this.client.query<Record<string, unknown>>(`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING RETURNING id`, values);
    if (inserted.rows.length > 0) return;
    const existing = await this.client.query<Record<string, unknown>>(`SELECT ${columns.join(", ")} FROM ${tableName} WHERE id = $1 LIMIT 1`, [values[0]]);
    const row = existing.rows[0];
    if (!row) throw new RentOpsInvariantError(`Append-only ${tableName} record ${String(values[0])} could not be persisted`);
    const same = columns.every((column, index) => samePersistedValue(row[column], values[index]));
    if (!same) throw new RentOpsInvariantError(`Append-only ${tableName} record ${String(values[0])} conflicts with an existing payload`);
  }

  private async saveRecurringScheduleChange(executor: RentOpsQueryExecutor, change: RentOpsRecordChange, successor: RentOpsRecurringChargeSchedule): Promise<void> {
    assertRecurringChange(change, successor);
    const changedFields = [...change.changedFields];
    const inserted = await executor.query<Record<string, unknown>>(
      "INSERT INTO rent_ops_record_changes (id, entity_type, target_id, revision, origin, actor_subject, occurred_at, changed_fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING id",
      [change.id, change.entityType, change.targetId, change.revision, change.origin, change.actorSubject ?? null, change.occurredAt, changedFields],
    );
    if (inserted.rows.length > 0) return;
    const existingResult = await executor.query<Record<string, unknown>>(
      "SELECT id, entity_type, target_id, revision, origin, actor_subject, occurred_at, changed_fields FROM rent_ops_record_changes WHERE id = $1 LIMIT 1",
      [change.id],
    );
    const row = existingResult.rows[0];
    const existingFields = row?.changed_fields;
    const same = Boolean(row)
      && samePersistedValue(row?.id, change.id)
      && samePersistedValue(row?.entity_type, change.entityType)
      && samePersistedValue(row?.target_id, change.targetId)
      && samePersistedValue(row?.revision, change.revision)
      && samePersistedValue(row?.origin, change.origin)
      && samePersistedValue(row?.actor_subject, change.actorSubject ?? null)
      && samePersistedValue(row?.occurred_at, change.occurredAt)
      && Array.isArray(existingFields)
      && existingFields.length === changedFields.length
      && existingFields.every((field, index) => samePersistedValue(field, changedFields[index]));
    if (!same) throw new RentOpsInvariantError("Recurring schedule change record conflicts with an existing payload");
  }

  async applyRecordPatch(update: RentOpsRecordPatchUpdate): Promise<void> {
    const table = patchTables[update.entityType];
    if (!table) throw new RentOpsInvariantError("Unknown Rent Operations patch target");
    const allowed = patchColumns[update.entityType];
    const entries = Object.entries(update.values).filter(([column]) => allowed.has(column));
    if (entries.length !== Object.keys(update.values).length) throw new RentOpsInvariantError("Patch contains a field outside the positive allowlist");
    await this.assertReady();
    const assignments = entries.map(([column], index) => `${column} = $${index + 1}`);
    assignments.push(`record_revision = $${entries.length + 1}`);
    const values = entries.map(([, value]) => value);
    values.push(update.nextRevision, update.targetId, update.expectedRevision);
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = $${entries.length + 2} AND record_revision = $${entries.length + 3} RETURNING id`,
      values,
    );
    if (result.rows.length > 0) return;
    const current = await this.client.query<{ id?: string; record_revision?: number }>(`SELECT id, record_revision FROM ${table} WHERE id = $1 LIMIT 1`, [update.targetId]);
    if (current.rows.length === 0) throw new RentOpsInvariantError("Rent Operations record not found");
    throw new RentOpsInvariantError("Rent Operations record revision is stale");
  }

  async saveRecordChange(change: RentOpsRecordChange): Promise<void> {
    await this.assertReady();
    const changedFields = [...change.changedFields].sort();
    if (changedFields.length === 0 || changedFields.some((field) => field.length === 0)) throw new RentOpsInvariantError("Record change field list is invalid");
    await this.client.query(
      "INSERT INTO rent_ops_record_changes (id, entity_type, target_id, revision, origin, actor_subject, occurred_at, changed_fields) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [change.id, change.entityType, change.targetId, change.revision, change.origin, change.actorSubject, change.occurredAt, changedFields],
    );
  }

  async getRecordChanges(): Promise<RentOpsRecordChange[]> {
    await this.assertReady();
    const result = await this.client.query<Record<string, unknown>>("SELECT id, entity_type, target_id, revision, origin, actor_subject, occurred_at, changed_fields FROM rent_ops_record_changes ORDER BY occurred_at, id");
    return result.rows.map((row) => ({
      id: String(get(row, "id", "id")),
      entityType: String(get(row, "entityType", "entity_type")) as RentOpsRecordChange["entityType"],
      targetId: String(get(row, "targetId", "target_id")),
      revision: Number(get(row, "revision", "revision")),
      origin: String(get(row, "origin", "origin")) as RentOpsRecordChange["origin"],
      actorSubject: textValue(row, "actorSubject", "actor_subject"),
      occurredAt: timestampValue(get(row, "occurredAt", "occurred_at")) ?? "",
      changedFields: Array.isArray(get(row, "changedFields", "changed_fields")) ? (get(row, "changedFields", "changed_fields") as unknown[]).filter((field): field is string => typeof field === "string").sort() : [],
    }));
  }

  async saveProperty(value: RentOpsProperty): Promise<RentOpsProperty> { await this.upsert("rent_ops_properties", ["id", "name", "slug", "address_line1", "address_line2", "city", "state", "postal_code", "property_type", "state_status", "operating_contact", "name_knowledge", "address_knowledge", "property_type_knowledge", "state_knowledge", "operating_contact_knowledge", "source_system", "source_id"], [value.id, value.name, value.slug, value.address.line1, value.address.line2, value.address.city, value.address.state, value.address.postalCode, value.propertyType, value.state, value.operatingContact, value.nameKnowledge, value.addressKnowledge, value.propertyTypeKnowledge, value.stateKnowledge, value.operatingContactKnowledge, value.source?.system, value.source?.sourceId]); return value; }
  async saveUnit(value: RentOpsUnit): Promise<RentOpsUnit> { await this.upsert("rent_ops_units", ["id", "property_id", "unit_number", "unit_type", "bedrooms", "bathrooms", "square_feet", "market_rent_cents", "default_deposit_cents", "readiness", "listing", "property_link_knowledge", "unit_number_knowledge", "unit_type_knowledge", "readiness_knowledge", "listing_knowledge", "amenities", "access_notes", "source_system", "source_id"], [value.id, value.propertyId, value.unitNumber, value.unitType, value.bedrooms, value.bathrooms, value.squareFeet, value.marketRentCents, value.defaultDepositCents, value.readiness, value.listing, value.propertyLinkKnowledge, value.unitNumberKnowledge, value.unitTypeKnowledge, value.readinessKnowledge, value.listingKnowledge, value.amenities ? JSON.stringify(value.amenities) : null, value.accessNotes, value.source?.system, value.source?.sourceId]); return value; }
  async savePerson(value: RentOpsPerson): Promise<RentOpsPerson> { await this.upsert("rent_ops_people", ["id", "first_name", "last_name", "email", "phone", "phone_methods", "first_name_knowledge", "last_name_knowledge", "email_knowledge", "phone_knowledge", "renter_insurance_expires_on", "archived", "archived_knowledge", "source_system", "source_id"], [value.id, value.firstName, value.lastName, value.email, value.phone, value.phoneMethods ? JSON.stringify(value.phoneMethods) : null, value.firstNameKnowledge, value.lastNameKnowledge, value.emailKnowledge, value.phoneKnowledge, value.renterInsuranceExpiresOn, value.archived, value.archivedKnowledge, value.source?.system, value.source?.sourceId]); return value; }
  async saveHouseholdMembership(value: RentOpsHouseholdMembership): Promise<RentOpsHouseholdMembership> { await this.upsert("rent_ops_household_memberships", ["id", "tenancy_id", "application_id", "account_person_id", "person_id", "role", "relationship", "is_financially_responsible", "role_knowledge", "relationship_knowledge", "responsibility_knowledge"], [value.id, value.tenancyId, value.applicationId, value.accountPersonId, value.personId, value.role, value.relationship, value.isFinanciallyResponsible, value.roleKnowledge, value.relationshipKnowledge, value.responsibilityKnowledge]); return value; }
  async getApplicationById(id: string): Promise<RentOpsApplicationRecord | undefined> { await this.assertReady(); const result = await this.client.query<Record<string, unknown>>("SELECT * FROM rent_ops_applications WHERE id = $1 LIMIT 1", [id]); return result.rows[0] ? rowToApplicationV3(result.rows[0]) : undefined; }
  async getApplicationByResumeTokenHash(hash: string): Promise<RentOpsApplicationRecord | undefined> { await this.assertReady(); const result = await this.client.query<Record<string, unknown>>("SELECT * FROM rent_ops_applications WHERE resume_token_hash = $1 LIMIT 1", [hash]); return result.rows[0] ? rowToApplicationV3(result.rows[0]) : undefined; }

  private async readApplicationHistory(executor: RentOpsQueryExecutor = this.client): Promise<RentOpsApplicationHistorySnapshot | undefined> {
    const [prospects, applications, interests, participants, requirements, templates, sections, fields, answers, documents, activities, blockers, aggregates] = await Promise.all([
      this.rows("rent_ops_prospects", executor),
      this.rows("rent_ops_application_history", executor),
      this.rows("rent_ops_application_interests", executor),
      this.rows("rent_ops_application_participants", executor),
      this.rows("rent_ops_application_requirement_occurrences", executor),
      this.rows("rent_ops_application_template_definitions", executor),
      this.rows("rent_ops_application_template_sections", executor),
      this.rows("rent_ops_application_template_fields", executor),
      this.rows("rent_ops_application_answer_occurrences", executor),
      this.rows("rent_ops_application_history_documents", executor),
      this.rows("rent_ops_application_history_activities", executor),
      this.rows("rent_ops_application_history_blockers", executor),
      this.rows("rent_ops_application_history_aggregates", executor),
    ]);
    const hasRows = [prospects, applications, interests, participants, requirements, templates, sections, fields, answers, documents, activities, blockers, aggregates].some((rows) => rows.length > 0);
    if (!hasRows) return undefined;
    const aggregate = aggregates[0];
    if (!aggregate) throw new RentOpsInvariantError("Application history aggregate is missing");
    if (aggregates.length > 1) throw new RentOpsInvariantError("Application history aggregate is duplicated");
    const snapshot: RentOpsApplicationHistorySnapshot = {
      prospects: prospects.map(rowToHistoryProspect),
      applications: applications.map(rowToHistoryApplication),
      interests: interests.map(rowToHistoryInterest),
      participants: participants.map(rowToHistoryParticipant),
      requirements: requirements.map(rowToHistoryRequirement),
      templates: templates.map(rowToHistoryTemplate),
      templateSections: sections.map(rowToHistorySection),
      templateFields: fields.map(rowToHistoryField),
      answers: answers.map(rowToHistoryAnswer),
      documents: documents.map(rowToHistoryDocument),
      activities: activities.map(rowToHistoryActivity),
      blockers: blockers.map(rowToHistoryBlocker),
      unknownRestricted: {
        restrictedAnswerCount: Number(get(aggregate, "restrictedAnswerCount", "restricted_answer_count") ?? 0),
        unmappedAnswerCount: Number(get(aggregate, "unmappedAnswerCount", "unmapped_answer_count") ?? 0),
        missingAnswerApplications: Number(get(aggregate, "missingAnswerApplications", "missing_answer_applications") ?? 0),
        metadataOnlyDocumentCount: Number(get(aggregate, "metadataOnlyDocumentCount", "metadata_only_document_count") ?? 0),
        unavailableDocumentCount: Number(get(aggregate, "unavailableDocumentCount", "unavailable_document_count") ?? 0),
        unlinkedActivityCount: Number(get(aggregate, "unlinkedActivityCount", "unlinked_activity_count") ?? 0),
        unlinkedInterestCount: Number(get(aggregate, "unlinkedInterestCount", "unlinked_interest_count") ?? 0),
      },
    };
    assertValidApplicationHistory(snapshot);
    return snapshot;
  }

  private async insertHistoryRow(executor: RentOpsQueryExecutor, descriptor: HistoryInsertDescriptor, values: readonly unknown[]): Promise<void> {
    const columns = descriptor.columns;
    const id = values[0];
    const sourceSystemIndex = columns.indexOf("source_system");
    const sourceIdIndex = columns.indexOf("source_id");
    const selectColumns = columns.join(", ");
    const existingById = await executor.query<Record<string, unknown>>(`SELECT ${selectColumns} FROM ${descriptor.table} WHERE id = $1 LIMIT 1`, [id]);
    if (existingById.rows[0]) {
      const same = columns.every((column, index) => sameHistoryValue(existingById.rows[0][column], values[index]));
      if (!same) throw new RentOpsInvariantError(`Application history ${descriptor.table} record conflicts with an existing payload`);
      return;
    }
    if (sourceSystemIndex >= 0 && sourceIdIndex >= 0) {
      const sourceSystem = values[sourceSystemIndex];
      const sourceId = values[sourceIdIndex];
      const existingBySource = await executor.query<Record<string, unknown>>(`SELECT ${selectColumns} FROM ${descriptor.table} WHERE source_system = $1 AND source_id = $2 LIMIT 1`, [sourceSystem, sourceId]);
      if (existingBySource.rows[0]) throw new RentOpsInvariantError(`Application history ${descriptor.table} source identity conflicts with an existing payload`);
    }
    const inserted = await executor.query<Record<string, unknown>>(
      `INSERT INTO ${descriptor.table} (${columns.join(", ")}) VALUES (${columns.map((_column, index) => `$${index + 1}`).join(", ")}) ON CONFLICT (id) DO NOTHING RETURNING id`,
      Array.from(values),
    );
    if (inserted.rows.length > 0) return;
    const persisted = await executor.query<Record<string, unknown>>(`SELECT ${selectColumns} FROM ${descriptor.table} WHERE id = $1 LIMIT 1`, [id]);
    if (!persisted.rows[0] || !columns.every((column, index) => sameHistoryValue(persisted.rows[0][column], values[index]))) {
      throw new RentOpsInvariantError(`Application history ${descriptor.table} insert could not be replayed exactly`);
    }
  }

  private async writeApplicationHistory(executor: RentOpsQueryExecutor, history: RentOpsApplicationHistorySnapshot): Promise<void> {
    for (const descriptor of historyValues(history)) {
      for (const values of descriptor.rows) await this.insertHistoryRow(executor, descriptor, values);
    }
  }

  async getApplicationHistoryCaseById(id: string): Promise<RentOpsApplicationCase | undefined> {
    await this.assertReady();
    const read = async (executor: RentOpsQueryExecutor) => {
      const history = await this.readApplicationHistory(executor);
      if (!history) return undefined;
      const result = applicationHistoryCase(history, id);
      return result;
    };
    if (this.inTransaction) return read(this.client);
    if (this.client.transaction) return this.client.transaction((executor) => read(executor), { readOnly: true });
    return read(this.client);
  }

  async saveApplicationHistory(history: RentOpsApplicationHistorySnapshot): Promise<void> {
    assertValidApplicationHistory(history);
    await this.assertReady();
    if (this.inTransaction) {
      await this.writeApplicationHistory(this.client, history);
      return;
    }
    if (!this.client.transaction) throw new RentOpsInvariantError("Rent Operations database executor does not support atomic application history writes");
    await this.client.transaction(async (executor) => {
      const repository = new PostgresRentOpsRepository(executor, true);
      repository.ready = true;
      await repository.writeApplicationHistory(executor, history);
    }, { readOnly: false });
  }

  async saveApplication(value: RentOpsApplicationRecord): Promise<RentOpsApplicationRecord> { await this.upsert("rent_ops_applications", ["id", "source_type", "status", "email", "first_name", "last_name", "phone", "property_id", "unit_id", "submitted_on", "certification_accepted_on", "resume_token_hash", "resume_token_expires_at", "converted_tenancy_id", "rental_history", "employment", "household_summary", "preferences", "voucher", "pets", "vehicles", "emergency_contact", "profile_answers", "source_type_knowledge", "status_knowledge", "email_knowledge", "first_name_knowledge", "last_name_knowledge", "phone_knowledge", "property_link_knowledge", "unit_link_knowledge", "submitted_on_knowledge", "certification_accepted_on_knowledge", "created_at_knowledge", "updated_at_knowledge", "source_system", "source_id", "created_at", "updated_at"], [value.id, value.sourceType, value.status, value.email, value.firstName, value.lastName, value.phone, value.propertyId, value.unitId, value.submittedOn, value.certificationAcceptedOn, value.resumeTokenHash, value.resumeTokenExpiresAt, value.convertedTenancyId, value.rentalHistory ? JSON.stringify(value.rentalHistory) : null, value.employment ? JSON.stringify(value.employment) : null, value.householdSummary ? JSON.stringify(value.householdSummary) : null, value.preferences ? JSON.stringify(value.preferences) : null, value.voucher ? JSON.stringify(value.voucher) : null, value.pets ? JSON.stringify(value.pets) : null, value.vehicles ? JSON.stringify(value.vehicles) : null, value.emergencyContact ? JSON.stringify(value.emergencyContact) : null, value.profileAnswers ? JSON.stringify(value.profileAnswers) : null, value.sourceTypeKnowledge, value.statusKnowledge, value.emailKnowledge, value.firstNameKnowledge, value.lastNameKnowledge, value.phoneKnowledge, value.propertyLinkKnowledge, value.unitLinkKnowledge, value.submittedOnKnowledge, value.certificationAcceptedOnKnowledge, value.createdAtKnowledge, value.updatedAtKnowledge, value.source?.system, value.source?.sourceId, value.createdAt, value.updatedAt], ["source_type", "status", "email", "first_name", "last_name", "phone", "property_id", "unit_id", "submitted_on", "certification_accepted_on", "resume_token_hash", "resume_token_expires_at", "converted_tenancy_id", "rental_history", "employment", "household_summary", "preferences", "voucher", "pets", "vehicles", "emergency_contact", "profile_answers", "source_type_knowledge", "status_knowledge", "email_knowledge", "first_name_knowledge", "last_name_knowledge", "phone_knowledge", "property_link_knowledge", "unit_link_knowledge", "submitted_on_knowledge", "certification_accepted_on_knowledge", "created_at_knowledge", "updated_at_knowledge", "updated_at"]); return value; }
  async saveApplicationHouseholdMember(value: RentOpsApplicationHouseholdMember): Promise<RentOpsApplicationHouseholdMember> { await this.upsert("rent_ops_application_household_members", ["id", "application_id", "first_name", "last_name", "relationship", "email", "phone", "is_minor"], [value.id, value.applicationId, value.firstName, value.lastName, value.relationship, value.email, value.phone, value.isMinor]); return value; }
  async saveApplicationRequirement(value: RentOpsApplicationRequirement): Promise<RentOpsApplicationRequirement> { await this.upsert("rent_ops_application_requirements", ["id", "application_id", "key", "label", "status", "document_id", "requested_on", "resolved_on"], [value.id, value.applicationId, value.key, value.label, value.status, value.documentId, value.requestedOn, value.resolvedOn]); return value; }
  async saveTenancy(value: RentOpsTenancy): Promise<RentOpsTenancy> { await this.upsert("rent_ops_tenancies", ["id", "property_id", "unit_id", "primary_person_id", "status", "planned_move_in_on", "actual_move_in_on", "notice_on", "expected_move_out_on", "actual_move_out_on", "application_id", "created_at", "ended_at", "property_link_knowledge", "unit_link_knowledge", "primary_person_link_knowledge", "status_knowledge", "planned_move_in_knowledge", "actual_move_in_knowledge", "notice_knowledge", "expected_move_out_knowledge", "actual_move_out_knowledge", "created_at_knowledge", "ended_at_knowledge", "source_system", "source_id"], [value.id, value.propertyId, value.unitId, value.primaryPersonId, value.status, value.plannedMoveInOn, value.actualMoveInOn, value.noticeOn, value.expectedMoveOutOn, value.actualMoveOutOn, value.applicationId, value.createdAt, value.endedAt, value.propertyLinkKnowledge, value.unitLinkKnowledge, value.primaryPersonLinkKnowledge, value.statusKnowledge, value.plannedMoveInKnowledge, value.actualMoveInKnowledge, value.noticeKnowledge, value.expectedMoveOutKnowledge, value.actualMoveOutKnowledge, value.createdAtKnowledge, value.endedAtKnowledge, value.source?.system, value.source?.sourceId]); return value; }
  async saveLeaseTerm(value: RentOpsLeaseTerm): Promise<RentOpsLeaseTerm> { await this.upsert("rent_ops_lease_terms", ["id", "tenancy_id", "status", "contract_start_on", "contract_end_on", "month_to_month", "signed_on", "executed_document_id", "renewal_of_id", "created_at", "tenancy_link_knowledge", "status_knowledge", "contract_start_knowledge", "contract_end_knowledge", "signed_on_knowledge", "month_to_month_knowledge", "created_at_knowledge", "source_system", "source_id"], [value.id, value.tenancyId, value.status, value.contractStartOn, value.contractEndOn, value.monthToMonth, value.signedOn, value.executedDocumentId, value.renewalOfId, value.createdAt, value.tenancyLinkKnowledge, value.statusKnowledge, value.contractStartKnowledge, value.contractEndKnowledge, value.signedOnKnowledge, value.monthToMonthKnowledge, value.createdAtKnowledge, value.source?.system, value.source?.sourceId]); return value; }
  async saveChargeDefinition(value: RentOpsChargeDefinition): Promise<RentOpsChargeDefinition> {
    assertImportedChargeDefinition(value);
    await this.insertOnly("rent_ops_charge_definitions", [...chargeDefinitionColumns], chargeDefinitionValues(value));
    return value;
  }

  async saveRecurringSchedule(value: RentOpsRecurringChargeSchedule): Promise<RentOpsRecurringChargeSchedule> {
    assertImportedSchedule(value);
    if (value.amountCents !== null && value.amountCents !== undefined) assertPositiveCents(value.amountCents, "recurring schedule amountCents");
    if (value.amountCents === undefined || value.lineageRootId === undefined || value.lineageRootOrigin === undefined || value.versionOrigin === undefined || value.versionAction === undefined) throw new RentOpsInvariantError("Recurring schedule v8 row is incomplete");
    assertRecurringRootProvenance(value);
    await this.insertOnly("rent_ops_recurring_charge_schedules", [...recurringScheduleColumns], recurringScheduleValues(value));
    return value;
  }

  async saveRecurringScheduleRoot(input: { schedule: RentOpsRecurringChargeSchedule; change: RentOpsRecordChange }): Promise<RentOpsRecurringChargeSchedule> {
    if (!this.client.transaction) throw new RentOpsInvariantError("Manual recurring schedule root requires an atomic transaction");
    const schedule = { ...input.schedule, recordRevision: input.schedule.recordRevision ?? 1 };
    if (schedule.versionOrigin !== "manual" || schedule.source || schedule.sourceArtifactSha256 !== undefined && schedule.sourceArtifactSha256 !== null || schedule.artifactObservationOn !== undefined && schedule.artifactObservationOn !== null) {
      throw new RentOpsInvariantError("Manual recurring schedule root cannot carry artifact provenance");
    }
    assertRecurringRootProvenance(schedule);
    assertRecurringChange(input.change, schedule);
    await this.assertReady();
    return this.client.transaction(async (executor) => {
      const repository = new PostgresRentOpsRepository(executor);
      repository.ready = true;
      await repository.saveRecurringSchedule(schedule);
      await repository.saveRecurringScheduleChange(executor, input.change, schedule);
      return schedule;
    }, { readOnly: false });
  }

  async saveRecurringScheduleSuccessor(input: { predecessorId: string; successor: RentOpsRecurringChargeSchedule; expectedRevision: number; change: RentOpsRecordChange }): Promise<RentOpsRecurringChargeSchedule> {
    if (!input.change) throw new RentOpsInvariantError("Recurring schedule successor requires an authenticated change record");
    if (!this.client.transaction) throw new RentOpsInvariantError("Recurring schedule successor requires an atomic transaction");
    await this.assertReady();
    return this.client.transaction(async (executor) => {
      const predecessorResult = await executor.query<Record<string, unknown>>(
        `SELECT ${recurringScheduleColumns.join(", ")} FROM rent_ops_recurring_charge_schedules WHERE id = $1 FOR UPDATE`,
        [input.predecessorId],
      );
      const predecessorRow = predecessorResult.rows[0];
      if (!predecessorRow) throw new RentOpsInvariantError("Recurring schedule predecessor was not found");
      const predecessor = rowToSchedule(predecessorRow);
      const predecessorRevision = revisionValue(predecessorRow);
      if (predecessorRevision !== input.expectedRevision) throw new RentOpsInvariantError("Recurring schedule predecessor revision is stale");
      if (predecessor.versionAction === "end") throw new RentOpsInvariantError("Recurring schedule predecessor is terminal");
      let root = predecessor;
      if (predecessor.lineageRootId !== predecessor.id) {
        const rootResult = await executor.query<Record<string, unknown>>(
          `SELECT ${recurringScheduleColumns.join(", ")} FROM rent_ops_recurring_charge_schedules WHERE id = $1 FOR UPDATE`,
          [predecessor.lineageRootId],
        );
        if (!rootResult.rows[0]) throw new RentOpsInvariantError("Recurring schedule lineage root was not found");
        root = rowToSchedule(rootResult.rows[0]);
      }
      if (root.lineageRootId !== root.id) throw new RentOpsInvariantError("Recurring schedule lineage root was not found");
      assertRecurringSuccessorShape(predecessor, root, input.successor, input.expectedRevision);
      const existingBranch = await executor.query<Record<string, unknown>>(
        `SELECT ${recurringScheduleColumns.join(", ")} FROM rent_ops_recurring_charge_schedules WHERE supersedes_id = $1 FOR UPDATE`,
        [input.predecessorId],
      );
      if (existingBranch.rows.length > 0) {
        const existing = existingBranch.rows[0];
        const expected = recurringScheduleValues(input.successor);
        const same = recurringScheduleColumns.every((column, index) => samePersistedValue(existing[column], expected[index]));
        if (!same) throw new RentOpsInvariantError("Recurring schedule successor branch already exists with a different payload");
        await this.saveRecurringScheduleChange(executor, input.change, input.successor);
        return rowToSchedule(existing);
      }
      const values = recurringScheduleValues(input.successor);
      const inserted = await executor.query<Record<string, unknown>>(
        `INSERT INTO rent_ops_recurring_charge_schedules (${recurringScheduleColumns.join(", ")}) VALUES (${recurringScheduleColumns.map((_column, index) => `$${index + 1}`).join(", ")}) ON CONFLICT (id) DO NOTHING RETURNING id`,
        values,
      );
      if (inserted.rows.length > 0) {
        await this.saveRecurringScheduleChange(executor, input.change, input.successor);
        return input.successor;
      }
      const existingById = await executor.query<Record<string, unknown>>(
        `SELECT ${recurringScheduleColumns.join(", ")} FROM rent_ops_recurring_charge_schedules WHERE id = $1 LIMIT 1`,
        [input.successor.id],
      );
      const existing = existingById.rows[0];
      if (!existing || !recurringScheduleColumns.every((column, index) => samePersistedValue(existing[column], values[index]))) throw new RentOpsInvariantError("Recurring schedule successor conflicts with an existing payload");
      await this.saveRecurringScheduleChange(executor, input.change, input.successor);
      return rowToSchedule(existing);
    }, { readOnly: false });
  }
  async saveLedgerTransaction(value: RentOpsLedgerTransaction): Promise<RentOpsLedgerTransaction> {
    assertImportedLedger(value);
    await this.insertOnly(
      "rent_ops_ledger_transactions",
      [
        "id", "property_id", "unit_id", "tenancy_id", "person_id", "kind", "category", "category_knowledge", "status",
        "amount_cents", "posted_on", "due_on", "payment_method", "payment_method_knowledge", "description", "reversal_of_id",
        "payer", "payer_knowledge", "adjustment_direction", "property_link_knowledge", "unit_link_knowledge", "tenancy_link_knowledge",
        "person_link_knowledge", "amount_knowledge", "posted_on_knowledge", "due_on_knowledge", "description_knowledge", "status_knowledge",
        "allocation_mode", "charge_definition_id", "charge_definition_link_knowledge", "source_artifact_sha256", "artifact_observation_on",
        "source_system", "source_id",
      ],
      [
        value.id, value.propertyId ?? null, value.unitId ?? null, value.tenancyId ?? null, value.personId ?? null, value.kind ?? null,
        value.category ?? null, value.categoryKnowledge ?? null, value.status ?? null, value.amountCents ?? null, value.postedOn ?? null,
        value.dueOn ?? null, value.paymentMethod ?? null, value.paymentMethodKnowledge ?? null, value.description ?? null,
        value.reversalOfId ?? null, value.payer ?? null, value.payerKnowledge ?? null, value.adjustmentDirection ?? null,
        value.propertyLinkKnowledge ?? null, value.unitLinkKnowledge ?? null, value.tenancyLinkKnowledge ?? null, value.personLinkKnowledge ?? null,
        value.amountKnowledge ?? null, value.postedOnKnowledge ?? null, value.dueOnKnowledge ?? null, value.descriptionKnowledge ?? null,
        value.statusKnowledge ?? null, value.allocationMode ?? null, value.chargeDefinitionId ?? null, value.chargeDefinitionLinkKnowledge ?? null,
        value.sourceArtifactSha256 ?? null, value.artifactObservationOn ?? null, value.source?.system ?? null, value.source?.sourceId ?? null,
      ],
    );
    return value;
  }
  async savePaymentAllocation(value: RentOpsPaymentAllocation): Promise<RentOpsPaymentAllocation> { assertImportedAllocation(value); await this.insertOnly("rent_ops_payment_allocations", ["id", "payment_transaction_id", "charge_transaction_id", "amount_cents", "allocated_on", "payment_link_knowledge", "charge_link_knowledge", "amount_knowledge", "allocated_on_knowledge", "source_system", "source_id", "kind", "source_artifact_sha256", "artifact_observation_on", "source_updated_at", "credit_transaction_id", "credit_link_knowledge"], [value.id, value.paymentTransactionId, value.chargeTransactionId, value.amountCents, value.allocatedOn, value.paymentLinkKnowledge, value.chargeLinkKnowledge, value.amountKnowledge, value.allocatedOnKnowledge, value.source?.system, value.source?.sourceId, value.kind ?? "allocation", value.sourceArtifactSha256 ?? null, value.artifactObservationOn ?? null, value.source?.sourceUpdatedAt ?? null, value.creditTransactionId ?? null, value.creditLinkKnowledge ?? null]); return value; }
  async saveSecurityDeposit(value: RentOpsSecurityDeposit): Promise<RentOpsSecurityDeposit> { if (value.amountHeldCents === null) { if (value.source?.system !== "rent_manager" || !Number.isSafeInteger(value.sourceBalanceCents) || value.sourceBalanceCents! >= 0) throw new RentOpsInvariantError("Unknown held deposit requires signed source balance"); } else { assertCents(value.amountHeldCents, "deposit amountHeldCents"); if (value.amountHeldCents < 0) throw new RentOpsInvariantError("Held deposit cannot be negative"); } await this.upsert("rent_ops_security_deposits", ["id", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge", "tenancy_id", "person_id", "person_link_knowledge", "type", "type_knowledge", "amount_held_cents", "source_balance_cents", "received_on", "received_on_knowledge", "disposition_status", "disposition_status_knowledge", "disposed_on", "disposition_notes", "source_system", "source_id"], [value.id, value.propertyId, value.propertyLinkKnowledge, value.unitId, value.unitLinkKnowledge, value.tenancyId, value.personId, value.personLinkKnowledge, value.type, value.typeKnowledge, value.amountHeldCents, value.sourceBalanceCents ?? null, value.receivedOn, value.receivedOnKnowledge, value.dispositionStatus, value.dispositionStatusKnowledge, value.disposedOn, value.dispositionNotes, value.source?.system, value.source?.sourceId]); return value; }
  async saveSubsidyContract(value: RentOpsSubsidyContract): Promise<RentOpsSubsidyContract> { if (value.agencyObligationCents < 0 || value.tenantObligationCents < 0 || value.agencyObligationCents + value.tenantObligationCents <= 0) throw new RentOpsInvariantError("Housing-assistance obligations must total more than zero"); await this.upsert("rent_ops_subsidy_contracts", ["id", "property_id", "unit_id", "tenancy_id", "agency_name", "contract_number", "effective_from", "effective_to", "agency_obligation_cents", "tenant_obligation_cents", "status", "status_knowledge", "source_system", "source_id"], [value.id, value.propertyId, value.unitId, value.tenancyId, value.agencyName, value.contractNumber, value.effectiveFrom, value.effectiveTo, value.agencyObligationCents, value.tenantObligationCents, value.status, value.statusKnowledge, value.source?.system, value.source?.sourceId]); return value; }
  async saveSubsidyTenant(value: RentOpsSubsidyTenant): Promise<RentOpsSubsidyTenant> {
    if (value.amountCents !== undefined) assertCents(value.amountCents, "subsidy tenant amountCents");
    await this.insertOnly("rent_ops_subsidy_tenants", ["id", "subsidy_contract_id", "subsidy_contract_link_knowledge", "tenancy_id", "tenancy_link_knowledge", "person_id", "person_link_knowledge", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge", "effective_from", "effective_from_knowledge", "effective_to", "effective_to_knowledge", "amount_cents", "amount_knowledge", "payer", "payer_knowledge", "status", "status_knowledge", "source_system", "source_id"], [value.id, value.subsidyContractId, value.subsidyContractLinkKnowledge, value.tenancyId, value.tenancyLinkKnowledge, value.personId, value.personLinkKnowledge, value.propertyId, value.propertyLinkKnowledge, value.unitId, value.unitLinkKnowledge, value.effectiveFrom, value.effectiveFromKnowledge, value.effectiveTo, value.effectiveToKnowledge, value.amountCents, value.amountKnowledge, value.payer, value.payerKnowledge, value.status, value.statusKnowledge, value.source?.system, value.source?.sourceId]);
    return value;
  }
  async saveSubsidyPayment(value: RentOpsSubsidyPayment): Promise<RentOpsSubsidyPayment> {
    if (value.amountCents !== undefined) assertCents(value.amountCents, "subsidy payment amountCents");
    await this.insertOnly("rent_ops_subsidy_payments", ["id", "subsidy_contract_id", "subsidy_contract_link_knowledge", "subsidy_tenant_id", "subsidy_tenant_link_knowledge", "tenancy_id", "tenancy_link_knowledge", "person_id", "person_link_knowledge", "property_id", "property_link_knowledge", "unit_id", "unit_link_knowledge", "payment_transaction_id", "payment_link_knowledge", "payment_on", "payment_on_knowledge", "amount_cents", "amount_knowledge", "payer", "payer_knowledge", "status", "status_knowledge", "source_system", "source_id"], [value.id, value.subsidyContractId, value.subsidyContractLinkKnowledge, value.subsidyTenantId, value.subsidyTenantLinkKnowledge, value.tenancyId, value.tenancyLinkKnowledge, value.personId, value.personLinkKnowledge, value.propertyId, value.propertyLinkKnowledge, value.unitId, value.unitLinkKnowledge, value.paymentTransactionId, value.paymentLinkKnowledge, value.paymentOn, value.paymentOnKnowledge, value.amountCents, value.amountKnowledge, value.payer, value.payerKnowledge, value.status, value.statusKnowledge, value.source?.system, value.source?.sourceId]);
    return value;
  }
  async saveDocument(value: RentOpsDocument): Promise<RentOpsDocument> { if (value.storageKey !== undefined && value.storageKey !== null) assertPrivateStorageKey(value.storageKey); const snapshot = await this.getSnapshot(); const violations = documentReferenceViolations(snapshot, value); if (violations.length > 0) throw new RentOpsInvariantError("Document references are invalid", violations); await this.upsert("rent_ops_documents", ["id", "property_id", "unit_id", "person_id", "tenancy_id", "application_id", "type", "type_knowledge", "state", "state_knowledge", "file_name", "mime_type", "size_bytes", "checksum_sha256", "storage_key", "uploaded_at", "verified_at", "availability", "storage_key_knowledge", "metadata_size_bytes", "metadata_checksum_sha256", "source_system", "source_id"], [value.id, value.propertyId, value.unitId, value.personId, value.tenancyId, value.applicationId, value.type, value.typeKnowledge, value.state, value.stateKnowledge, value.fileName, value.mimeType, value.sizeBytes, value.checksumSha256, value.storageKey, value.uploadedAt, value.verifiedAt, value.availability, value.storageKeyKnowledge, value.metadataSizeBytes, value.metadataChecksumSha256, value.source?.system, value.source?.sourceId]); return value; }
  async getDocumentObjectBinding(documentId: string): Promise<RentOpsDocumentObjectBinding | undefined> {
    await this.assertReady();
    const result = await this.client.query<Record<string, unknown>>(
      "SELECT document_id, binding_kind, source_binary_id, import_run_id, source_system, source_collection, backend, logical_key, checksum_sha256, size_bytes, immutable_generation, immutable_version, verified_at FROM rent_ops_document_objects WHERE document_id = $1 LIMIT 1",
      [documentId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const verifiedAt = timestampValue(get(row, "verifiedAt", "verified_at"));
    const backend = textValue(row, "backend", "backend");
    const logicalKey = textValue(row, "logicalKey", "logical_key");
    const checksumSha256 = textValue(row, "checksumSha256", "checksum_sha256");
    const sizeBytes = numberValue(row, "sizeBytes", "size_bytes");
    const bindingDocumentId = textValue(row, "documentId", "document_id");
    const bindingKind = textValue(row, "bindingKind", "binding_kind") as RentOpsDocumentObjectBinding["bindingKind"];
    const sourceBinaryId = textValue(row, "sourceBinaryId", "source_binary_id");
    const importRunId = textValue(row, "importRunId", "import_run_id");
    const sourceSystem = textValue(row, "sourceSystem", "source_system");
    const sourceCollection = textValue(row, "sourceCollection", "source_collection");
    if (!bindingDocumentId || !backend || !logicalKey || !checksumSha256 || sizeBytes === undefined || !verifiedAt || (bindingKind !== "applicant" && bindingKind !== "import")) throw new RentOpsInvariantError("Verified document binding is incomplete");
    if (bindingKind === "applicant" && (sourceBinaryId || importRunId || sourceSystem || sourceCollection)) throw new RentOpsInvariantError("Applicant document binding cannot reference an import source");
    if (bindingKind === "import" && (!sourceBinaryId || !importRunId || !sourceSystem || !sourceCollection)) throw new RentOpsInvariantError("Imported document binding is missing its exact source identity");
    if (!textValue(row, "immutableGeneration", "immutable_generation") && !textValue(row, "immutableVersion", "immutable_version")) throw new RentOpsInvariantError("Verified document binding version is missing");
    return { documentId: bindingDocumentId, bindingKind, ...(sourceBinaryId ? { sourceBinaryId } : {}), ...(importRunId ? { importRunId } : {}), ...(sourceSystem ? { sourceSystem } : {}), ...(sourceCollection ? { sourceCollection } : {}), backend, logicalKey, checksumSha256, sizeBytes, immutableGeneration: textValue(row, "immutableGeneration", "immutable_generation"), immutableVersion: textValue(row, "immutableVersion", "immutable_version"), verifiedAt };
  }
  async saveDocumentObjectBinding(value: RentOpsDocumentObjectBinding): Promise<RentOpsDocumentObjectBinding> {
    await this.assertReady();
    const existing = await this.getDocumentObjectBinding(value.documentId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(value)) throw new RentOpsInvariantError("Verified document object binding is immutable");
      return value;
    }
    await this.client.query(
      "INSERT INTO rent_ops_document_objects (document_id, binding_kind, source_binary_id, import_run_id, source_system, source_collection, backend, logical_key, checksum_sha256, size_bytes, immutable_generation, immutable_version, verified_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [value.documentId, value.bindingKind, value.sourceBinaryId, value.importRunId, value.sourceSystem, value.sourceCollection, value.backend, value.logicalKey, value.checksumSha256, value.sizeBytes, value.immutableGeneration, value.immutableVersion, value.verifiedAt],
    );
    return value;
  }
  async saveActivity(value: RentOpsActivityEvent): Promise<RentOpsActivityEvent> { await this.insertOnly("rent_ops_activity_events", ["id", "property_id", "unit_id", "person_id", "tenancy_id", "application_id", "type", "occurred_at", "actor", "summary", "detail", "occurred_at_knowledge", "actor_knowledge", "summary_knowledge", "type_knowledge", "property_link_knowledge", "unit_link_knowledge", "person_link_knowledge", "tenancy_link_knowledge", "application_link_knowledge", "source_system", "source_id"], [value.id, value.propertyId, value.unitId, value.personId, value.tenancyId, value.applicationId, value.type, value.occurredAt, value.actor, value.summary, value.detail, value.occurredAtKnowledge, value.actorKnowledge, value.summaryKnowledge, value.typeKnowledge, value.propertyLinkKnowledge, value.unitLinkKnowledge, value.personLinkKnowledge, value.tenancyLinkKnowledge, value.applicationLinkKnowledge, value.source?.system, value.source?.sourceId]); return value; }
}

export function createPostgresRentOpsRepository(client: RentOpsQueryExecutor): PostgresRentOpsRepository {
  return new PostgresRentOpsRepository(client);
}
