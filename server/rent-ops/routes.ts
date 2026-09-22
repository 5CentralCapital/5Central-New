import {sendAdminSnapshot} from "./presentation/snapshot-transport";
import { phoneMethodsSchema } from "./domain/phone-methods";
import { RentOpsRetryableConflict } from "./runtime-database";
import { manualPaymentSchema, createChargeDefinitionSchema, patchChargeDefinitionSchema } from "./services/operational-inputs";
import type { Express, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { Readable, Transform } from "node:stream";
import { z } from "zod";
import {
  addressSchema,
  applicantCertificationSchema,
  applicantSaveSchema,
  applicantStartSchema,
  applicationStatusSchema,
  centsSchema,
  isoDateSchema,
  isoMonthSchema,
  rentOpsFiltersSchema,
  type FixedReportName,
  type RentOpsPatchEntityType,
  type RentOpsDocument,
  type RentOpsFilters,
  type RentOpsRouteOptions,
} from "../../shared/rent-ops-contracts";
import { RentOpsInvariantError } from "./domain/invariants";
import { nowIsoDate } from "./domain/dates";
import { validateReportFilters, deriveApplicantPipeline, deriveDashboardSummary, deriveFixedReport, deriveRentRoll, deriveTenantProfile } from "./domain/reports";
import { toCsv } from "./services/csv";
import { RentOpsService } from "./services/service";
import { MagicLinkDeliveryError } from "./services/notifier";
import type { ContentAddressedObjectStore, StorageReadAdapter } from "./storage";
import {
  serializeAdminActivity,
  serializeAdminApplication,
  serializeAdminApplicationRequirement,
  serializeAdminDashboard,
  serializeAdminDashboardSummary,
  serializeAdminDocument,
  serializeAdminHouseholdMembership,
  serializeAdminLeaseTerm,
  serializeAdminLedgerTransaction,
  serializeAdminPaymentAllocation,
  serializeAdminPerson,
  serializeAdminProperty,
  serializeAdminRecurringSchedule,
  serializeAdminSecurityDeposit,
  serializeAdminSubsidyContract,
  serializeAdminTenantProfile,
  serializeAdminTenancy,
  serializeAdminUnit,
  serializeAdminApplicationView,
  serializeAdminApplicationHistoryCase,
  serializeAdminChargeDefinition,
  serializeApplicantPipelineRow,
  serializeCsvRows,
  errorBody,
  serializePresentationError,
  serializePublicApplication,
  serializePublicApplicationResult,
  serializeReportEnvelope,
  serializeReportRows,
} from "./presentation";

const reportAliases: Record<string, FixedReportName> = {
  "rent-roll": "rent-roll",
  occupancy: "occupancy",
  "scheduled-income": "scheduled-income",
  "collected-income": "collected-income",
  "scheduled-vs-collected": "scheduled-vs-collected",
  delinquency: "delinquency",
  "tenant-ledger": "tenant-ledger",
  "lease-expiration": "lease-expiration",
  "lease-expirations": "lease-expirations",
  "security-deposit": "security-deposit",
  deposits: "deposits",
  "applicant-pipeline": "applicant-pipeline",
  hap: "hap",
};

const propertySchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(120),
  address: addressSchema,
  propertyType: z.enum(["multifamily", "single_family", "other"]),
  state: z.enum(["active", "archived"]),
  operatingContact: z.string().max(160).optional(),
}).strict();

const unitSchema = z.object({
  id: z.string().min(1).max(160),
  propertyId: z.string().min(1).max(160),
  unitNumber: z.string().trim().min(1).max(80),
  unitType: z.string().max(100).optional(),
  bedrooms: z.number().int().min(0).max(50).optional(),
  bathrooms: z.number().finite().min(0).max(50).optional(),
  squareFeet: z.number().int().min(0).max(100000).optional(),
  marketRentCents: centsSchema.nonnegative().optional(),
  defaultDepositCents: centsSchema.nonnegative().optional(),
  readiness: z.enum(["ready", "not_ready", "off_market"]),
  listing: z.enum(["listed", "unlisted", "off_market"]),
  amenities: z.array(z.string().max(100)).max(100).optional(),
  accessNotes: z.string().max(1000).optional(),
}).strict();

const personSchema = z.object({
  id: z.string().min(1).max(160),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().email().max(240).optional(),
  phone: z.string().max(40).optional(),
  phoneMethods: phoneMethodsSchema.optional(),
  renterInsuranceExpiresOn: isoDateSchema.optional(),
  archived: z.boolean().optional(),
}).strict();

const tenancySchema = z.object({
  id: z.string().min(1).max(160),
  propertyId: z.string().min(1).max(160),
  unitId: z.string().min(1).max(160),
  primaryPersonId: z.string().min(1).max(160),
  status: z.enum(["future", "current", "notice", "past", "cancelled"]),
  plannedMoveInOn: isoDateSchema.optional(),
  actualMoveInOn: isoDateSchema.optional(),
  noticeOn: isoDateSchema.optional(),
  expectedMoveOutOn: isoDateSchema.optional(),
  actualMoveOutOn: isoDateSchema.optional(),
  applicationId: z.string().max(160).optional(),
  createdAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
}).strict();

const leaseTermSchema = z.object({
  id: z.string().min(1).max(160),
  tenancyId: z.string().min(1).max(160),
  status: z.enum(["draft", "executed", "expired", "month_to_month", "cancelled"]),
  contractStartOn: isoDateSchema,
  contractEndOn: isoDateSchema.optional(),
  monthToMonth: z.boolean(),
  signedOn: isoDateSchema.optional(),
  executedDocumentId: z.string().max(160).optional(),
  renewalOfId: z.string().max(160).optional(),
  createdAt: z.string().datetime().optional(),
}).strict();

const targetIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/);

/**
 * The only recurring-schedule body accepted by the admin route is a positive
 * manual root. Source/artifact/knowledge fields are intentionally absent;
 * Zod strictness turns their presence into a 400 instead of allowing a
 * browser to forge a provenance marker or server revision.
 */
const recurringScheduleSchema = z.object({
  billingFrequency: z.literal("monthly"),
  id: targetIdSchema,
  scopeType: z.enum(["tenant", "unit", "property"]),
  scopeId: targetIdSchema,
  tenancyId: targetIdSchema.optional(),
  personId: targetIdSchema.optional(),
  propertyId: targetIdSchema,
  unitId: targetIdSchema.optional(),
  chargeDefinitionId: targetIdSchema,
  category: z.enum(["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"]),
  description: z.string().trim().min(1).max(240),
  amountCents: centsSchema.positive(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.optional(),
  active: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "Effective end cannot predate the start" });
  if (value.scopeType === "property") {
    if (value.scopeId !== value.propertyId || value.unitId || value.tenancyId || value.personId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeType"], message: "Property scope requires only the selected property" });
  }
  if (value.scopeType === "unit") {
    if (!value.unitId || value.tenancyId || value.personId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["unitId"], message: "Unit scope requires one exact unit and no tenant fields" });
  }
  if (value.scopeType === "tenant") {
    if (!value.unitId || !value.tenancyId || !value.personId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeType"], message: "Tenant scope requires an exact tenant, tenancy, unit, and property" });
  }
});

const recurringSuccessorSchema = z.object({
  billingFrequency: z.literal("monthly").optional(),
  id: targetIdSchema.optional(),
  expectedRevision: z.number().int().min(1),
  action: z.enum(["replace", "end"]),
  effectiveFrom: isoDateSchema,
  amountCents: centsSchema.positive().optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "replace" && value.amountCents === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "Replacement amount is required" });
  if (value.action === "end" && value.amountCents !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "An end successor cannot carry an amount" });
});

const ledgerBaseSchema = z.object({
  id: z.string().min(1).max(160),
  propertyId: z.string().min(1).max(160),
  unitId: z.string().max(160).optional(),
  tenancyId: z.string().max(160).optional(),
  personId: z.string().max(160).optional(),
  category: z.enum(["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"]),
  status: z.enum(["posted", "voided", "pending"]),
  amountCents: centsSchema.nonnegative(),
  postedOn: isoDateSchema,
  dueOn: isoDateSchema.optional(),
  paymentMethod: z.enum(["ach", "card", "cash", "check", "money_order", "zelle", "other"]).optional(),
  description: z.string().trim().min(1).max(240),
  payer: z.enum(["tenant", "agency", "owner", "unknown"]).optional(),
});

// Reversals only enter through the linked reversal route. Adjustments carry
// an explicit direction so a malformed write can never silently become a
// debit. The discriminated union keeps this rule at the HTTP boundary.
const ledgerSchema = z.discriminatedUnion("kind", [
  ledgerBaseSchema.extend({ kind: z.literal("charge") }).strict(),
  ledgerBaseSchema.extend({ kind: z.literal("payment") }).strict(),
  ledgerBaseSchema.extend({ kind: z.literal("credit") }).strict(),
  ledgerBaseSchema.extend({ kind: z.literal("adjustment"), adjustmentDirection: z.enum(["debit", "credit"]) }).strict(),
]);

const allocationSchema = z.object({
  id: z.string().min(1).max(160),
  paymentTransactionId: z.string().min(1).max(160),
  chargeTransactionId: z.string().min(1).max(160),
  amountCents: centsSchema.positive(),
  allocatedOn: isoDateSchema,
}).strict();

const depositSchema = z.object({
  id: z.string().min(1).max(160),
  propertyId: z.string().min(1).max(160),
  unitId: z.string().min(1).max(160).optional(),
  unitLinkKnowledge: z.enum(["exact", "unknown"]).optional(),
  tenancyId: z.string().min(1).max(160).optional(),
  personId: z.string().min(1).max(160),
  type: z.enum(["security", "refundable_pet", "other_refundable"]),
  amountHeldCents: centsSchema.positive(),
  receivedOn: isoDateSchema.optional(),
  receivedOnKnowledge: z.enum(["source", "unknown"]).optional(),
  dispositionStatus: z.enum(["held", "partially_disposed", "disposed", "returned"]),
  disposedOn: isoDateSchema.optional(),
  dispositionNotes: z.string().max(1000).optional(),
}).strict();

const subsidySchema = z.object({
  id: z.string().min(1).max(160),
  propertyId: z.string().min(1).max(160),
  unitId: z.string().min(1).max(160),
  tenancyId: z.string().min(1).max(160),
  agencyName: z.string().trim().min(1).max(200),
  contractNumber: z.string().max(120).optional(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.optional(),
  agencyObligationCents: centsSchema.nonnegative(),
  tenantObligationCents: centsSchema.nonnegative(),
  status: z.enum(["active", "ended", "pending", "exception"]),
}).strict().refine((value) => value.agencyObligationCents + value.tenantObligationCents > 0, { message: "Housing-assistance obligations must total more than zero" });

const documentSchema = z.object({
  id: z.string().min(1).max(160),
  propertyId: z.string().max(160).optional(),
  unitId: z.string().max(160).optional(),
  personId: z.string().max(160).optional(),
  tenancyId: z.string().max(160).optional(),
  applicationId: z.string().max(160).optional(),
  type: z.enum(["lease", "addendum", "identity", "insurance", "notice", "application_attachment", "housing_assistance", "deposit_record", "other"]),
  state: z.enum(["requested", "received", "signed", "executed", "filed", "current", "verified", "rejected", "expired", "archived"]),
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().nonnegative().max(1000000000).optional(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  storageKey: z.string().trim().min(1).max(500),
  uploadedAt: z.string().datetime().optional(),
  verifiedAt: z.string().datetime().optional(),
}).strict();

const patchRevision = z.number().int().min(1);
const patchId = z.string().min(1).max(160).nullable().optional();
const patchText = (max: number) => z.string().max(max).nullable().optional();
const patchDate = isoDateSchema.nullable().optional();
const patchPropertySchema = z.object({ revision: patchRevision, name: z.string().trim().min(1).max(200).optional(), slug: z.string().trim().min(1).max(120).optional(), address: addressSchema.partial().nullable().optional(), propertyType: z.enum(["multifamily", "single_family", "other"]).optional(), state: z.enum(["active", "archived"]).optional(), operatingContact: patchText(160) }).strict();
const patchUnitSchema = z.object({ revision: patchRevision, propertyId: patchId, unitNumber: z.string().trim().min(1).max(80).optional(), unitType: patchText(100), bedrooms: z.number().int().min(0).max(50).nullable().optional(), bathrooms: z.number().finite().min(0).max(50).nullable().optional(), squareFeet: z.number().int().min(0).max(100000).nullable().optional(), marketRentCents: centsSchema.nonnegative().nullable().optional(), defaultDepositCents: centsSchema.nonnegative().nullable().optional(), readiness: z.enum(["ready", "not_ready", "off_market"]).optional(), listing: z.enum(["listed", "unlisted", "off_market"]).optional(), amenities: z.array(z.string().max(100)).max(100).nullable().optional(), accessNotes: patchText(1000) }).strict();
const patchPersonSchema = z.object({ revision: patchRevision, firstName: z.string().trim().min(1).max(80).optional(), lastName: z.string().trim().min(1).max(80).optional(), email: z.string().email().max(240).nullable().optional(), phone: patchText(40), phoneMethods: phoneMethodsSchema.optional(), renterInsuranceExpiresOn: patchDate, archived: z.boolean().nullable().optional() }).strict();
const patchHouseholdMembershipSchema = z.object({ revision: patchRevision, tenancyId: patchId, applicationId: patchId, accountPersonId: patchId, personId: z.string().min(1).max(160).optional(), role: z.enum(["primary", "co_applicant", "occupant", "minor", "emergency_contact", "other_contact"]).nullable().optional(), relationship: patchText(120), isFinanciallyResponsible: z.boolean().nullable().optional() }).strict();
const patchTenancySchema = z.object({ revision: patchRevision, propertyId: z.string().min(1).max(160).optional(), unitId: z.string().min(1).max(160).optional(), primaryPersonId: z.string().min(1).max(160).optional(), status: z.enum(["future", "current", "notice", "past", "cancelled"]).optional(), plannedMoveInOn: patchDate, actualMoveInOn: patchDate, noticeOn: patchDate, expectedMoveOutOn: patchDate, actualMoveOutOn: patchDate, applicationId: patchId, endedAt: z.string().datetime().nullable().optional() }).strict();
const patchLeaseTermSchema = z.object({ revision: patchRevision, tenancyId: z.string().min(1).max(160).optional(), status: z.enum(["draft", "executed", "expired", "month_to_month", "cancelled"]).optional(), contractStartOn: isoDateSchema.optional(), contractEndOn: patchDate, monthToMonth: z.boolean().optional(), signedOn: patchDate, executedDocumentId: patchId, renewalOfId: patchId }).strict();
const patchDepositSchema = z.object({ revision: patchRevision, propertyId: z.string().min(1).max(160).optional(), unitId: patchId, tenancyId: patchId, personId: z.string().min(1).max(160).optional(), type: z.enum(["security", "refundable_pet", "other_refundable"]).optional(), amountHeldCents: centsSchema.positive().optional(), receivedOn: patchDate, dispositionStatus: z.enum(["held", "partially_disposed", "disposed", "returned"]).nullable().optional(), disposedOn: patchDate, dispositionNotes: patchText(1000) }).strict();
const patchSubsidySchema = z.object({ revision: patchRevision, status: z.enum(["active", "ended", "pending", "exception"]).nullable().optional() }).strict();
const patchApplicationSchema = z.object({ revision: patchRevision, status: z.enum(["draft", "submitted", "missing_information", "under_review", "approved", "declined", "withdrawn", "converted", "complete", "in_progress", "awaiting_payment"]).optional(), email: z.string().email().max(240).optional(), firstName: z.string().trim().min(1).max(80).optional(), lastName: z.string().trim().min(1).max(80).optional(), phone: patchText(40), propertyId: patchId, unitId: patchId, submittedOn: patchDate, certificationAcceptedOn: patchDate, rentalHistory: z.record(z.unknown()).nullable().optional(), employment: z.record(z.unknown()).nullable().optional(), householdSummary: z.record(z.unknown()).nullable().optional(), preferences: z.record(z.unknown()).nullable().optional(), voucher: z.record(z.unknown()).nullable().optional(), pets: z.array(z.record(z.unknown())).max(20).nullable().optional(), vehicles: z.array(z.record(z.unknown())).max(20).nullable().optional(), emergencyContact: z.record(z.unknown()).nullable().optional(), profileAnswers: z.record(z.unknown()).nullable().optional() }).strict();
const patchDocumentSchema = z.object({ revision: patchRevision, propertyId: patchId, unitId: patchId, personId: patchId, tenancyId: patchId, applicationId: patchId, type: z.enum(["lease", "addendum", "identity", "insurance", "notice", "application_attachment", "housing_assistance", "deposit_record", "other"]).optional(), state: z.enum(["requested", "received", "signed", "executed", "filed", "current", "verified", "rejected", "expired", "archived"]).optional(), fileName: z.string().trim().min(1).max(240).optional(), mimeType: z.string().trim().min(1).max(120).optional() }).strict();
const patchActivitySchema = z.object({ revision: patchRevision, propertyId: patchId, unitId: patchId, personId: patchId, tenancyId: patchId, applicationId: patchId, type: z.enum(["note", "call", "email", "text", "promise_to_pay", "hold", "notice", "system"]).optional(), summary: z.string().trim().min(1).max(500).optional(), detail: patchText(5000) }).strict();

const conversionMemberSchema = z.object({
  /** `primary` identifies the applicant; every other value must be an exact
   * application household-member ID returned by the server. */
  applicationMemberId: z.string().trim().min(1).max(160),
  role: z.enum(["primary", "co_applicant", "occupant", "minor", "emergency_contact", "other_contact"]),
  isFinanciallyResponsible: z.boolean(),
  relationship: z.string().max(120).optional(),
}).strict();

/**
 * Conversion is an admin attestation boundary. Every fact used to create a
 * future tenancy is supplied here; applicant preferences and unit market rent
 * are never conversion inputs or fallbacks.
 */
const applicationConversionFactsSchema = z.object({
  propertyId: z.string().trim().min(1).max(160),
  unitId: z.string().trim().min(1).max(160),
  plannedMoveInOn: isoDateSchema,
  leaseStatus: z.enum(["draft", "executed", "expired", "month_to_month", "cancelled"]),
  contractStartOn: isoDateSchema,
  contractEndOn: isoDateSchema.optional(),
  monthToMonth: z.boolean(),
  baseRentCents: centsSchema.positive(),
  billingFrequency: z.literal("monthly"),
  chargeDefinitionId: targetIdSchema,
  category: z.enum(["base_rent", "recurring_fee", "one_time_fee", "subsidy", "security_deposit", "refundable_pet_deposit", "move_in_funds", "unapplied_cash", "other"]),
  scheduleDescription: z.string().trim().min(1).max(240),
  primaryFinanciallyResponsible: z.boolean(),
  members: z.array(conversionMemberSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.monthToMonth && value.contractEndOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ["contractEndOn"], message: "Month-to-month conversion cannot include a contract end" });
  if (!value.monthToMonth && !value.contractEndOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ["contractEndOn"], message: "A fixed-term conversion requires a contract end" });
  if (value.monthToMonth && value.leaseStatus !== "month_to_month") context.addIssue({ code: z.ZodIssueCode.custom, path: ["leaseStatus"], message: "Month-to-month conversion requires a month_to_month lease status" });
  if (!value.monthToMonth && value.leaseStatus === "month_to_month") context.addIssue({ code: z.ZodIssueCode.custom, path: ["leaseStatus"], message: "A fixed-term conversion cannot use month_to_month status" });
  if (value.contractEndOn && value.contractEndOn < value.contractStartOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ["contractEndOn"], message: "Contract end cannot predate contract start" });
  if (value.plannedMoveInOn < value.contractStartOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ["plannedMoveInOn"], message: "Planned move-in cannot predate contract start" });
  const primaryMembers = value.members.filter((member) => member.applicationMemberId === "primary");
  if (primaryMembers.length !== 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["members"], message: "Exactly one primary member is required" });
  if (primaryMembers[0] && (primaryMembers[0].role !== "primary" || primaryMembers[0].isFinanciallyResponsible !== value.primaryFinanciallyResponsible)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["members"], message: "Primary role and responsibility must match the explicit primary fact" });
});

const activitySchema = z.object({
  id: z.string().min(1).max(160),
  propertyId: z.string().max(160).optional(),
  unitId: z.string().max(160).optional(),
  personId: z.string().max(160).optional(),
  tenancyId: z.string().max(160).optional(),
  applicationId: z.string().max(160).optional(),
  type: z.enum(["note", "call", "email", "text", "promise_to_pay", "hold", "notice", "system"]),
  occurredAt: z.string().datetime(),
  actor: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(500),
  detail: z.string().max(5000).optional(),
}).strict();

const requirementSchema = z.object({
  key: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(240),
  status: z.enum(["requested", "received", "waived", "rejected"]),
  documentId: z.string().max(160).optional(),
  requestedOn: isoDateSchema,
  resolvedOn: isoDateSchema.optional(),
}).strict();

const householdMembershipSchema = z.object({
  id: z.string().min(1).max(160),
  tenancyId: z.string().min(1).max(160),
  personId: z.string().min(1).max(160),
  role: z.enum(["primary", "co_applicant", "occupant", "minor", "emergency_contact", "other_contact"]),
  relationship: z.string().max(120).optional(),
  isFinanciallyResponsible: z.boolean(),
}).strict();

const publicHouseholdMemberSchema = z.object({
  id: z.string().max(160).optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  relationship: z.string().max(80).optional(),
  email: z.string().email().max(240).optional(),
  phone: z.string().max(40).optional(),
  isMinor: z.boolean(),
}).strict();

const publicDocumentMetadataSchema = z.object({
  type: z.enum(["lease", "addendum", "identity", "insurance", "notice", "application_attachment", "housing_assistance", "deposit_record", "other"]),
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().nonnegative().max(1000000000).optional(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).strict();

function asString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function asList(value: unknown): string[] | undefined {
  const stringValue = asString(value);
  return stringValue ? stringValue.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

function parseFilters(query: Request["query"], defaultAsOfDate?: string): RentOpsFilters {
  const candidate = {
    // Admin report callers default to the operational portfolio. Direct
    // domain/migration callers omit this field when they need source totals.
    propertyScope: asString(query.propertyScope) ?? "active",
    propertyId: asString(query.propertyId),
    unitId: asString(query.unitId),
    tenancyId: asString(query.tenancyId),
    personId: asString(query.personId),
    asOfDate: asString(query.asOfDate) ?? defaultAsOfDate,
    month: asString(query.month),
    fromDate: asString(query.fromDate),
    toDate: asString(query.toDate),
    occupancy: asList(query.occupancy),
    readiness: asList(query.readiness),
    listing: asList(query.listing),
    balanceStatus: asString(query.balanceStatus),
    status: asList(query.status),
    search: asString(query.search),
  };
  return rentOpsFiltersSchema.parse(candidate);
}

function publicError(res: Response, error: unknown): void {
  if (error instanceof MagicLinkDeliveryError) {
    res.status(503).json(errorBody("temporarily_unavailable"));
    return;
  }
  const message = error instanceof Error ? error.message : "";
  if (/delivery is not configured/i.test(message)) {
    res.status(503).json(errorBody("temporarily_unavailable"));
    return;
  }
  if (/resume token/i.test(message)) {
    res.status(404).json(errorBody("not_found"));
    return;
  }
  if (/upload is too large/i.test(message)) {
    res.status(413).json(errorBody("invalid_input"));
    return;
  }
  if (/verified upload|metadata-only|verified_upload_required/i.test(message)) {
    res.status(503).json({ code: "verified_upload_required" });
    return;
  }
  res.status(400).json(serializePresentationError(error));
}

function publicResumeToken(req: Request): string {
  const authorization = req.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,200})$/.exec(authorization);
  if (!match) throw new RentOpsInvariantError("Application resume token invalid or expired");
  return match[1];
}

const DOCUMENT_TYPES = new Set(["lease", "addendum", "identity", "insurance", "notice", "application_attachment", "housing_assistance", "deposit_record", "other"]);
const MAX_DOCUMENT_UPLOAD_BYTES = 50 * 1024 * 1024;

function isStorageReadAdapter(value: unknown): value is StorageReadAdapter {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.backend === "string"
    && typeof candidate.stat === "function"
    && typeof candidate.open === "function"
    && typeof candidate.verify === "function"
    && typeof candidate.openVerified === "function";
}

function isContentAddressedObjectStore(value: unknown): value is ContentAddressedObjectStore {
  return isStorageReadAdapter(value) && typeof (value as unknown as Record<string, unknown>).putIfAbsent === "function";
}

function documentHeader(req: Request, name: string): string | undefined {
  const value = req.get(name);
  return value && value.trim() ? value.trim() : undefined;
}

function uploadDocumentInput(req: Request, stream: Readable, sizeBytes?: number): { type: RentOpsDocument["type"]; fileName: string; mimeType: string; stream: Readable; sizeBytes?: number; checksumSha256?: string; requirementId?: string } | undefined {
  const type = documentHeader(req, "x-document-type");
  const fileName = documentHeader(req, "x-document-name");
  const mimeType = (req.get("content-type") ?? "").split(";", 1)[0]?.trim();
  if (!type || !DOCUMENT_TYPES.has(type) || !fileName || !mimeType) throw new RentOpsInvariantError("Document upload metadata is invalid");
  if (documentHeader(req, "x-document-id")) throw new RentOpsInvariantError("Applicant document IDs are server-generated");
  return {
    type: type as RentOpsDocument["type"],
    fileName,
    mimeType,
    stream,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    checksumSha256: documentHeader(req, "x-document-checksum-sha256"),
    requirementId: documentHeader(req, "x-application-requirement-id") ?? documentHeader(req, "x-requirement-id"),
  };
}

/**
 * Consume only the bounded raw body after the bearer/application middleware
 * has run.  Express's raw parser buffers before route code can authenticate;
 * this reader enforces Content-Length and the actual streamed byte count.
 */
function boundedUploadStream(req: Request, maxBytes: number): { stream: Readable; sizeBytes?: number } | undefined {
  if (req.readableEnded && !Buffer.isBuffer(req.body)) return undefined;
  const lengthHeader = req.get("content-length");
  let declaredSize: number | undefined;
  if (lengthHeader !== undefined) {
    if (!/^\d+$/.test(lengthHeader.trim())) throw new RentOpsInvariantError("Document upload length is invalid");
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared)) throw new RentOpsInvariantError("Document upload length is invalid");
    if (declared > maxBytes) {
      req.resume();
      throw new RentOpsInvariantError("Document upload is too large");
    }
    declaredSize = declared;
  }
  if (req.readableEnded) return Buffer.isBuffer(req.body) ? { stream: Readable.from([req.body]), sizeBytes: req.body.byteLength } : undefined;
  let size = 0;
  const limiter = new Transform({
    transform(raw: Buffer | string, _encoding, callback) {
      const chunk = Buffer.from(raw);
      size += chunk.byteLength;
      if (size > maxBytes) { callback(new RentOpsInvariantError("Document upload is too large")); return; }
      callback(null, chunk);
    },
    flush(callback) {
      if (declaredSize !== undefined && size !== declaredSize) { callback(new RentOpsInvariantError("Document upload length is invalid")); return; }
      callback();
    },
  });
  req.pipe(limiter);
  return { stream: limiter, ...(declaredSize !== undefined ? { sizeBytes: declaredSize } : {}) };
}

function safeDownloadName(fileName: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ._()'\-]{0,239}$/.test(fileName) && !fileName.includes("..")) return fileName;
  return "document";
}

function adminError(res: Response, error: unknown): void {
  if (error instanceof RentOpsRetryableConflict) { res.status(409).json({code: error.code, retryable: true}); return; }
  if (error instanceof z.ZodError) {
    res.status(400).json(serializePresentationError(new Error("invalid input")));
    return;
  }
  if (error instanceof RentOpsInvariantError) {
    if (/versioned_schedule_required/i.test(error.message)) {
      res.status(409).json(errorBody("versioned_schedule_required"));
      return;
    }
    if (/activity_append_only/i.test(error.message)) {
      res.status(409).json(errorBody("activity_append_only"));
      return;
    }
    if (/revision is stale|conflict|successor branch already exists|successor conflicts|already has a successor/i.test(error.message)) {
      res.status(409).json(errorBody("conflict"));
      return;
    }
    const status = /not found/i.test(error.message) ? 404 : 400;
    if (/already exists|use PATCH/i.test(error.message)) { res.status(status).json(errorBody("invalid_input")); return; }
    res.status(status).json(serializePresentationError(error));
    return;
  }
  res.status(500).json(serializePresentationError(error));
}

function createRateLimiter(limit: number, windowMs: number, maxEntries = 5_000): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    // Bound memory for the safe single-process default. Multi-instance
    // deployments inject a shared limiter through RentOpsRouteOptions.
    if (hits.size >= maxEntries && !hits.has(key)) {
      for (const [candidate, value] of Array.from(hits.entries())) {
        if (value.resetAt <= now) hits.delete(candidate);
      }
      if (hits.size >= maxEntries) hits.delete(hits.keys().next().value as string);
    }
    const current = hits.get(key);
    if (!current || current.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
    else current.count += 1;
    const updated = hits.get(key)!;
    if (updated.count > limit) {
      res.status(429).json(errorBody("rate_limited"));
      return;
    }
    next();
  };
}

function buildClientSnapshot(snapshot: Awaited<ReturnType<RentOpsService["snapshot"]>>, filters: RentOpsFilters): ReturnType<typeof serializeAdminDashboard> {
  const reports = {
    "rent-roll": deriveRentRoll(snapshot, filters),
    occupancy: deriveFixedReport(snapshot, "occupancy", filters),
    "scheduled-income": deriveFixedReport(snapshot, "scheduled-income", filters),
    "collected-income": deriveFixedReport(snapshot, "collected-income", filters),
    "scheduled-vs-collected": deriveFixedReport(snapshot, "scheduled-vs-collected", filters),
    delinquency: deriveFixedReport(snapshot, "delinquency", filters),
    "tenant-ledger": deriveFixedReport(snapshot, "tenant-ledger", filters),
    "lease-expiration": deriveFixedReport(snapshot, "lease-expiration", filters),
    "security-deposit": deriveFixedReport(snapshot, "security-deposit", filters),
    "applicant-pipeline": deriveApplicantPipeline(snapshot, filters),
    hap: deriveFixedReport(snapshot, "hap", filters),
  };
  // Include exact household/account contacts as reachable operational
  // profiles.  Membership is an explicit relationship; it must not be
  // turned into an inferred tenancy just to make the contact visible.
  const profilePersonIds = new Set([
    ...snapshot.tenancies.map((tenancy) => tenancy.primaryPersonId),
    ...snapshot.householdMemberships.flatMap((membership) => [membership.personId, membership.accountPersonId]),
  ].filter((personId): personId is string => typeof personId === "string" && personId.length > 0));
  const tenantProfiles = snapshot.people
    .filter((person) => profilePersonIds.has(person.id))
    .map((person) => deriveTenantProfile(snapshot, person.id, filters))
    .filter((profile): profile is NonNullable<ReturnType<typeof deriveTenantProfile>> => Boolean(profile))
    // A scoped operational bundle must not turn a person whose only tenancy
    // is outside the selected portfolio into a resident card. The profile
    // derivation already applies the exact property scope to `tenancies`; an
    // explicit all-history request keeps the complete imported contact set.
    .filter((profile) =>
      (!filters.propertyId && filters.propertyScope !== "active") || (profile.tenancies?.length ?? 0) > 0,
    )
    .map((profile) => {
      const personId = profile.person.id;
      const hasPrimaryTenancy = snapshot.tenancies.some((tenancy) => tenancy.primaryPersonId === personId);
      const hasPersonMembership = snapshot.householdMemberships.some((membership) => membership.personId === personId);
      const accountOnly = !hasPrimaryTenancy && !hasPersonMembership && snapshot.householdMemberships.some((membership) => membership.accountPersonId === personId);
      // An account contact is reachable because of an exact accountPersonId
      // relationship, but that relationship is not a tenancy.  Keep only
      // records directly owned by the contact and do not render household
      // membership as an inferred lease/occupancy.
      const visibleProfile = accountOnly ? {
        ...profile,
        tenancy: undefined,
        tenancies: [],
        leaseTerms: [],
        ledger: [],
        deposits: [],
        subsidyContracts: [],
        schedules: snapshot.recurringSchedules.filter((schedule) => schedule.personId === personId && !schedule.tenancyId),
        documents: snapshot.documents.filter((document) => document.personId === personId && !document.tenancyId),
        activity: snapshot.activityEvents.filter((event) => event.personId === personId && !event.tenancyId),
      } : profile;
      const property = visibleProfile.tenancy ? snapshot.properties.find((candidate) => candidate.id === visibleProfile.tenancy?.propertyId) : undefined;
      const unit = visibleProfile.tenancy ? snapshot.units.find((candidate) => candidate.id === visibleProfile.tenancy?.unitId) : undefined;
      const primaryLease = visibleProfile.tenancy
        ? visibleProfile.leaseTerms
          .filter((term) => term.status !== "cancelled")
          .sort((left, right) => String(right.contractStartOn ?? "").localeCompare(String(left.contractStartOn ?? "")))[0]
        : undefined;
      return { ...visibleProfile, property, unit, primaryLease };
    });
  const bundle = serializeAdminDashboard({
    generatedAt: new Date().toISOString(),
    summary: deriveDashboardSummary(snapshot, filters),
    snapshot,
    reports,
    tenants: tenantProfiles,
    // Keep applicant cards aligned with the pipeline report's property,
    // status, and search scope. An all-history query expands the same
    // report-derived set back to every imported property.
    applicants: snapshot.applications.filter((application) =>
      reports["applicant-pipeline"].some((row) => row.id === application.id),
    ),
    documents: snapshot.documents,
    activities: snapshot.activityEvents,
  });
  // `serializeAdminDashboard` returns the positive presentation DTO. Do not
  // add a persistence-shaped alias here: the browser must have one explicit
  // response contract and the recursive presentation canary must cover every
  // route response without exemptions.
  return bundle;
}

type RentOpsSnapshotValue = Awaited<ReturnType<RentOpsService["snapshot"]>>;

function adminApplicationView(snapshot: RentOpsSnapshotValue, application: RentOpsSnapshotValue["applications"][number]) {
  return serializeAdminApplicationView({
    application,
    householdMembers: snapshot.applicationHouseholdMembers.filter((member) => member.applicationId === application.id),
    requirements: snapshot.applicationRequirements.filter((requirement) => requirement.applicationId === application.id),
    documents: snapshot.documents.filter((document) => document.applicationId === application.id),
  });
}

export function createRentOpsRouter(options: RentOpsRouteOptions): Router {
  if (options.enableDemoGuard && process.env.NODE_ENV === "production") throw new Error("Rent Operations demo routes cannot be enabled in production");
  if (options.exposeResumeToken && process.env.NODE_ENV === "production") throw new Error("Resume token exposure is disabled in production");
  const configuredDocumentStorage = options.documentStorage ?? options.documentStore;
  const configuredUploadStorage = options.documentUploadStorage ?? options.documentUploadStore;
  const documentStorage = isStorageReadAdapter(configuredDocumentStorage) ? configuredDocumentStorage : undefined;
  const documentUploadStorage = isContentAddressedObjectStore(configuredUploadStorage) ? configuredUploadStorage : undefined;
  const configuredNow = options.now ?? (() => new Date());
  const service = new RentOpsService(options.repository, configuredNow, options.resumeTokenTtlMs, options.resumeTokenNotifier, options.exposeResumeToken === true, { documentStorage, documentUploadStorage, allowEphemeralDocumentBindings: process.env.NODE_ENV !== "production" });
  const parseAdminFilters = (query: Request["query"]): RentOpsFilters => parseFilters(query, nowIsoDate(configuredNow()));
  const router = Router();
  const publicRouter = Router();
  const adminRouter = Router();
  const publicLimit = options.publicRateLimiter ?? createRateLimiter(60, 60_000);
  const requireAdmin = options.requireAdmin ?? ((req, res, next) => {
    if (!req.user || req.user.role !== "admin") { res.status(401).json(errorBody("not_authorized")); return; }
    next();
  });
  const authorizePublicUpload: RequestHandler = async (req, res, next) => {
    try {
      const token = publicResumeToken(req);
      await service.authorizePublicDocumentUpload(token);
      res.locals.rentOpsResumeToken = token;
      next();
    } catch (error) { publicError(res, error); }
  };

  publicRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); next(); });
  publicRouter.use(publicLimit);
  const publicListings = async (_req: Request, res: Response) => {
    try {
      res.json(await service.publicApplicationListings());
    } catch (error) { publicError(res, error); }
  };
  publicRouter.get("/application-options", publicListings);
  publicRouter.get("/listings", publicListings);
  publicRouter.post("/applications/start", async (req, res) => {
    const parsed = applicantStartSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      await service.startApplication(parsed.data);
      // In production the notifier is the only delivery channel. Never make
      // a usable token, applicant record, expiry, or private fields an API
      // response fallback when token exposure is not explicitly enabled.
      res.status(202).json(serializePublicApplicationResult({ accepted: true }));
    } catch (error) { publicError(res, error); }
  });
  publicRouter.get("/applications/resume", async (req, res) => {
    try { res.json(serializePublicApplication(await service.publicApplication(publicResumeToken(req)))); } catch (error) { publicError(res, error); }
  });
  publicRouter.patch("/applications/resume", async (req, res) => {
    const parsed = applicantSaveSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try { res.json(serializePublicApplication(await service.savePublicApplication(publicResumeToken(req), parsed.data))); } catch (error) { publicError(res, error); }
  });
  publicRouter.post("/applications/resume/certify", async (req, res) => {
    const parsed = applicantCertificationSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try { res.json(serializePublicApplication(await service.certifyPublicApplication(publicResumeToken(req)))); } catch (error) { publicError(res, error); }
  });
  publicRouter.post("/applications/resume/submit", async (req, res) => {
    try { res.json(serializePublicApplication(await service.submitPublicApplication(publicResumeToken(req)))); } catch (error) { publicError(res, error); }
  });
  publicRouter.post("/applications/resume/household-members", async (req, res) => {
    const parsed = publicHouseholdMemberSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try { res.json(serializePublicApplication(await service.savePublicHouseholdMember(publicResumeToken(req), parsed.data))); } catch (error) { publicError(res, error); }
  });
  // Raw bytes are accepted only on this bearer-scoped route. JSON metadata is
  // deliberately still rejected so a filename/checksum claim cannot satisfy
  // a requirement without an immutable verified object.
  publicRouter.post("/applications/resume/documents", authorizePublicUpload, async (req, res) => {
    try {
      const configuredMaxBytes = options.documentUploadMaxBytes;
      const maxBytes = configuredMaxBytes === undefined
        ? MAX_DOCUMENT_UPLOAD_BYTES
        : Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
          ? configuredMaxBytes
          : MAX_DOCUMENT_UPLOAD_BYTES;
      const upload = boundedUploadStream(req, maxBytes);
      if (!upload) { res.status(503).json({ code: "verified_upload_required" }); return; }
      const input = uploadDocumentInput(req, upload.stream, upload.sizeBytes);
      if (!input) { res.status(400).json(errorBody("invalid_input")); return; }
      res.status(201).json(serializePublicApplication(await service.savePublicVerifiedDocument(String(res.locals.rentOpsResumeToken), input)));
    } catch (error) { publicError(res, error); }
  });
  router.use("/public", publicRouter);

  adminRouter.use(requireAdmin);
  adminRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  /**
   * Mutations must be attributable to the dedicated Rent Ops admin session.
   * There is no synthetic fallback and no body-controlled actor field.  The
   * default production middleware sets `rentOpsAdminUser`; custom middleware
   * must do the same before allowing a mutation through.
   */
  const patchActorSubject = (req: Request): string => {
    const subject = req.rentOpsAdminUser?.id;
    if (typeof subject !== "string" || !subject.trim()) throw new RentOpsInvariantError("Rent Ops administrator subject is required");
    return subject;
  };
  const patchOccurredAt = (): string => (options.now ?? (() => new Date()))().toISOString();
  const patchAdminRecord = async (
    req: Request,
    res: Response,
    entityType: RentOpsPatchEntityType,
    schema: z.ZodTypeAny,
    present: (value: unknown) => unknown | Promise<unknown>,
  ): Promise<void> => {
    let actorSubject: string;
    try { actorSubject = patchActorSubject(req); } catch { res.status(401).json(errorBody("not_authorized")); return; }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    const input = parsed.data as { revision: number } & Record<string, unknown>;
    const { revision, ...patch } = input;
    try {
      const updated = await service.patchRecord(entityType, req.params.id, revision, patch, { actorSubject, occurredAt: patchOccurredAt() });
      res.json(await present(updated));
    } catch (error) { adminError(res, error); }
  };
  adminRouter.get("/preview-context", (_req, res) => { res.json({ asOfDate: nowIsoDate(configuredNow()), dataMode: options.previewSource ?? "live" }); });
  adminRouter.get("/dashboard", async (req, res) => { try { res.json(serializeAdminDashboardSummary(await service.dashboard(parseAdminFilters(req.query)))); } catch (error) { adminError(res, error); } });
  adminRouter.get("/snapshot", async (req, res) => { try { const filters = parseAdminFilters(req.query); validateReportFilters("overview", filters); await sendAdminSnapshot(req, res, buildClientSnapshot(await service.snapshot(), filters)); } catch (error) { adminError(res, error); } });
  /** Positive catalog used by manual recurring roots and application conversion. */
  adminRouter.get("/charge-definitions", async (_req, res) => {
    try {
      res.json((await service.chargeDefinitions()).map(serializeAdminChargeDefinition));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.post("/charge-definitions", async (req, res) => {
    const parsed = createChargeDefinitionSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      const actorSubject = req.rentOpsAdminUser?.id;
      if (!actorSubject) { res.status(401).json(errorBody("not_authorized")); return; }
      res.status(201).json(serializeAdminChargeDefinition(await service.createChargeDefinition(parsed.data, {actorSubject, occurredAt: patchOccurredAt()})));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.patch("/charge-definitions/:id", async (req, res) => {
    const parsed = z.object({expectedRevision: z.number().int().positive(), patch: patchChargeDefinitionSchema}).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      const actorSubject = patchActorSubject(req);
      res.json(serializeAdminChargeDefinition(await service.patchChargeDefinition(req.params.id, parsed.data.expectedRevision, parsed.data.patch, {actorSubject, occurredAt: patchOccurredAt()})));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.get("/reports/:report/csv", async (req, res) => {
    const report = reportAliases[req.params.report];
    if (!report) { res.status(404).json(errorBody("unknown_report")); return; }
    try {
      const filters = parseAdminFilters(req.query);
      const rows = serializeCsvRows(report, await service.report(report, filters));
      res.type("text/csv").set("Content-Disposition", `attachment; filename="rent-ops-${req.params.report}.csv"`).send(toCsv(rows));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.get("/reports/:report", async (req, res) => {
    const report = reportAliases[req.params.report];
    if (!report) { res.status(404).json(errorBody("unknown_report")); return; }
    try {
      const filters = parseAdminFilters(req.query);
      res.json(serializeReportEnvelope({ report, filters, rows: await service.report(report, filters) }));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.get("/properties", async (_req, res) => { try { res.json((await service.snapshot()).properties.map(serializeAdminProperty)); } catch (error) { adminError(res, error); } });
  adminRouter.post("/properties", async (req, res) => { const parsed = propertySchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminProperty(await service.saveProperty(parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.patch("/properties/:id", (req, res) => patchAdminRecord(req, res, "property", patchPropertySchema, (value) => serializeAdminProperty(value as Parameters<typeof serializeAdminProperty>[0])));
  adminRouter.get("/units", async (req, res) => { try { const snapshot = await service.snapshot(); const propertyId = asString(req.query.propertyId); res.json(snapshot.units.filter((unit) => !propertyId || unit.propertyId === propertyId).map(serializeAdminUnit)); } catch (error) { adminError(res, error); } });
  adminRouter.post("/units", async (req, res) => { const parsed = unitSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminUnit(await service.saveUnit(parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.patch("/units/:id", (req, res) => patchAdminRecord(req, res, "unit", patchUnitSchema, (value) => serializeAdminUnit(value as Parameters<typeof serializeAdminUnit>[0])));
  adminRouter.get("/tenants", async (req, res) => { try { const snapshot = await service.snapshot(); const personSearch = asString(req.query.search)?.toLowerCase(); res.json(snapshot.people.filter((person) => !personSearch || [person.firstName, person.lastName, person.email].filter((value): value is string => typeof value === "string").join(" ").toLowerCase().includes(personSearch)).map(serializeAdminPerson)); } catch (error) { adminError(res, error); } });
  adminRouter.get("/tenants/:personId", async (req, res) => { try { const profile = await service.tenantProfile(req.params.personId, parseAdminFilters(req.query)); if (!profile) { res.status(404).json(errorBody("not_found")); return; } res.json(serializeAdminTenantProfile(profile)); } catch (error) { adminError(res, error); } });
  adminRouter.post("/people", async (req, res) => { const parsed = personSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminPerson(await service.savePerson(parsed.data, {actorSubject: patchActorSubject(req), occurredAt: patchOccurredAt()}))); } catch (error) { adminError(res, error); } });
  adminRouter.patch("/people/:id", (req, res) => patchAdminRecord(req, res, "person", patchPersonSchema, (value) => serializeAdminPerson(value as Parameters<typeof serializeAdminPerson>[0])));
  adminRouter.post("/household-memberships", async (req, res) => { const parsed = householdMembershipSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminHouseholdMembership(await service.saveHouseholdMembership(parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.patch("/household-memberships/:id", (req, res) => patchAdminRecord(req, res, "household_membership", patchHouseholdMembershipSchema, (value) => serializeAdminHouseholdMembership(value as Parameters<typeof serializeAdminHouseholdMembership>[0])));
  adminRouter.post("/tenancies", async (req, res) => {
    const parsed = tenancySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      const snapshot = await service.snapshot();
      const existing = snapshot.tenancies.find((tenancy) => tenancy.id === parsed.data.id);
      // New manual records receive the server clock; POST cannot rewrite an existing record.
      const createdAt = existing?.createdAt ?? configuredNow().toISOString();
      res.status(201).json(serializeAdminTenancy(await service.saveTenancy({ ...parsed.data, createdAt })));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.patch("/tenancies/:id", (req, res) => patchAdminRecord(req, res, "tenancy", patchTenancySchema, (value) => serializeAdminTenancy(value as Parameters<typeof serializeAdminTenancy>[0])));
  adminRouter.post("/lease-terms", async (req, res) => {
    const parsed = leaseTermSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      const snapshot = await service.snapshot();
      const existing = snapshot.leaseTerms.find((term) => term.id === parsed.data.id);
      // New manual records receive the server clock; POST cannot rewrite an existing record.
      const createdAt = existing?.createdAt ?? configuredNow().toISOString();
      res.status(201).json(serializeAdminLeaseTerm(await service.saveLeaseTerm({ ...parsed.data, createdAt })));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.patch("/lease-terms/:id", (req, res) => patchAdminRecord(req, res, "lease_term", patchLeaseTermSchema, (value) => serializeAdminLeaseTerm(value as Parameters<typeof serializeAdminLeaseTerm>[0])));
  adminRouter.post("/recurring-schedules", async (req, res) => {
    let actorSubject: string;
    try { actorSubject = patchActorSubject(req); } catch { res.status(401).json(errorBody("not_authorized")); return; }
    const parsed = recurringScheduleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      const snapshot = await service.snapshot();
      const definition = snapshot.chargeDefinitions.find((candidate) => candidate.id === parsed.data.chargeDefinitionId);
      if (!definition || definition.category === null || definition.category !== parsed.data.category || definition.active !== true || (definition.activeKnowledge !== "source" && definition.activeKnowledge !== "manual") || (definition.categoryKnowledge !== "source" && definition.categoryKnowledge !== "manual")) {
        res.status(400).json(errorBody("invalid_input"));
        return;
      }
      // The service is the persistence/invariant boundary. The route only
      // supplies the positive body and server-owned lineage markers; the
      // authenticated actor is never read from JSON. The cast keeps this
      // route compatible with the service handoff while the context-aware
      // root-save signature lands.
      const recurringService = service as unknown as {
        saveRecurringSchedule: (schedule: unknown, context: { actorSubject: string; occurredAt: string }) => Promise<unknown>;
      };
      const saved = await recurringService.saveRecurringSchedule({ ...parsed.data, lineageRootId: parsed.data.id, lineageRootOrigin: "manual", versionOrigin: "manual", versionAction: "root" }, { actorSubject, occurredAt: patchOccurredAt() });
      res.status(201).json(serializeAdminRecurringSchedule(saved as never));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.post("/recurring-schedules/:id/successor", async (req, res) => {
    let actorSubject: string;
    try { actorSubject = patchActorSubject(req); } catch { res.status(401).json(errorBody("not_authorized")); return; }
    const predecessorId = req.params.id;
    if (!targetIdSchema.safeParse(predecessorId).success) { res.status(400).json(errorBody("invalid_target_id")); return; }
    const parsed = recurringSuccessorSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    const successorService = service as unknown as {
      saveRecurringScheduleSuccessor?: (predecessorId: string, input: typeof parsed.data, context: { actorSubject: string; occurredAt: string }) => Promise<unknown>;
    };
    if (!successorService.saveRecurringScheduleSuccessor) { res.status(503).json(errorBody("temporarily_unavailable")); return; }
    try {
      const saved = await successorService.saveRecurringScheduleSuccessor(predecessorId, parsed.data, { actorSubject, occurredAt: patchOccurredAt() });
      res.status(201).json(serializeAdminRecurringSchedule(saved as never));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.patch("/recurring-schedules/:id", (_req, res) => { res.status(409).json(errorBody("versioned_schedule_required")); });
  adminRouter.post("/manual-payments", async (req, res) => {
    const parsed = manualPaymentSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      const actorSubject = req.rentOpsAdminUser?.id;
      if (!actorSubject) { res.status(401).json(errorBody("not_authorized")); return; }
      const result = await service.recordManualPayment(parsed.data, {actorSubject, occurredAt: patchOccurredAt()});
      res.status(result.replayed ? 200 : 201).json({payment: serializeAdminLedgerTransaction(result.payment), allocations: result.allocations.map(serializeAdminPaymentAllocation), replayed: result.replayed});
    } catch (error) { adminError(res, error); }
  });
  adminRouter.post("/ledger/transactions", async (req, res) => { const parsed = ledgerSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminLedgerTransaction(await service.saveLedgerTransaction(parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.post("/ledger/allocations", async (req, res) => { const parsed = allocationSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminPaymentAllocation(await service.savePaymentAllocation(parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.post("/ledger/:id/reverse", async (req, res) => { const parsed = z.object({ id: z.string().max(160).optional(), postedOn: isoDateSchema, description: z.string().trim().min(1).max(240), payer: z.enum(["tenant", "agency", "owner", "unknown"]).optional(), status: z.enum(["posted", "voided", "pending"]).default("posted") }).strict().safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminLedgerTransaction(await service.reverseLedgerTransaction(req.params.id, parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.get("/ledger/:tenancyId", async (req, res) => { try { res.json(serializeReportRows("tenant-ledger", await service.report("tenant-ledger", { ...parseAdminFilters(req.query), tenancyId: req.params.tenancyId }))); } catch (error) { adminError(res, error); } });
  adminRouter.post("/deposits", async (req, res) => { const parsed = depositSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminSecurityDeposit(await service.saveSecurityDeposit(parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.patch("/deposits/:id", (req, res) => patchAdminRecord(req, res, "security_deposit", patchDepositSchema, (value) => serializeAdminSecurityDeposit(value as Parameters<typeof serializeAdminSecurityDeposit>[0])));
  // HAP creates stay disabled until agency/link/date/amount facts have
  // explicit provenance columns; accepting a native row would mislabel them.
  adminRouter.post("/subsidies", (_req, res) => { res.status(409).json(errorBody("hap_create_requires_provenance")); });
  adminRouter.patch("/subsidies/:id", (req, res) => patchAdminRecord(req, res, "subsidy_contract", patchSubsidySchema, (value) => serializeAdminSubsidyContract(value as Parameters<typeof serializeAdminSubsidyContract>[0])));
  adminRouter.get("/applications", async (req, res) => {
    try {
      const snapshot = await service.snapshot();
      const rows = deriveApplicantPipeline(snapshot, parseAdminFilters(req.query));
      res.json(rows.map((row) => {
        const application = snapshot.applications.find((candidate) => candidate.id === row.id);
        return { ...serializeApplicantPipelineRow(row), application: application ? adminApplicationView(snapshot, application) : undefined };
      }));
    } catch (error) { adminError(res, error); }
  });
  // Historical cases are a separate immutable read path. Keep this narrow
  // route available for a target that has no native portal row while the
  // native detail route below may attach the same positive section when both
  // records share the exact target application ID.
  adminRouter.get("/applications/:id/history", async (req, res) => {
    try {
      const history = await service.applicationHistoryCase(req.params.id);
      if (!history) { res.status(404).json(errorBody("not_found")); return; }
      res.json(serializeAdminApplicationHistoryCase(history));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.get("/applications/:id", async (req, res) => {
    try {
      const snapshot = await service.snapshot();
      const application = snapshot.applications.find((candidate) => candidate.id === req.params.id);
      const history = await service.applicationHistoryCase(req.params.id);
      if (!application && !history) { res.status(404).json(errorBody("not_found")); return; }
      if (!application) {
        // A history-only target remains available through the same detail
        // address for operators that arrive from an imported case index.
        res.json({ history: serializeAdminApplicationHistoryCase(history!) });
        return;
      }
      const view = adminApplicationView(snapshot, application);
      res.json(history ? { ...view, history: serializeAdminApplicationHistoryCase(history) } : view);
    } catch (error) { adminError(res, error); }
  });
  adminRouter.patch("/applications/:id", async (req, res) => {
    await patchAdminRecord(req, res, "application", patchApplicationSchema, async () => {
      const snapshot = await service.snapshot();
      const application = snapshot.applications.find((candidate) => candidate.id === req.params.id);
      if (!application) throw new RentOpsInvariantError("Rent Operations record not found");
      return adminApplicationView(snapshot, application);
    });
  });
  adminRouter.patch("/applications/:id/status", async (req, res) => {
    let actorSubject: string;
    try { actorSubject = patchActorSubject(req); } catch { res.status(401).json(errorBody("not_authorized")); return; }
    const parsed = applicationStatusSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      await service.patchApplicationStatus(req.params.id, parsed.data.revision, parsed.data.status, parsed.data.note, { actorSubject, occurredAt: patchOccurredAt() });
      const snapshot = await service.snapshot();
      const updated = snapshot.applications.find((candidate) => candidate.id === req.params.id);
      if (!updated) throw new RentOpsInvariantError("Rent Operations record not found");
      res.json(adminApplicationView(snapshot, updated));
    } catch (error) { adminError(res, error); }
  });
  adminRouter.post("/applications/:id/requirements", async (req, res) => { const parsed = requirementSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminApplicationRequirement(await service.saveApplicationRequirement(req.params.id, parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.post("/applications/:id/convert", async (req, res) => {
    let actorSubject: string;
    try { actorSubject = patchActorSubject(req); } catch { res.status(401).json(errorBody("not_authorized")); return; }
    const parsed = applicationConversionFactsSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; }
    try {
      const snapshot = await service.snapshot();
      const definition = snapshot.chargeDefinitions.find((candidate) => candidate.id === parsed.data.chargeDefinitionId);
      if (!definition || definition.category === null || definition.category !== parsed.data.category || definition.active !== true || (definition.activeKnowledge !== "source" && definition.activeKnowledge !== "manual") || (definition.categoryKnowledge !== "source" && definition.categoryKnowledge !== "manual")) {
        res.status(400).json(errorBody("invalid_input"));
        return;
      }
      const conversionService = service as unknown as {
        convertApplication: (applicationId: string, facts: typeof parsed.data, context: { actorSubject: string; occurredAt: string }) => Promise<{ application: unknown; tenancy: unknown }>;
      };
      const result = await conversionService.convertApplication(req.params.id, parsed.data, { actorSubject, occurredAt: patchOccurredAt() });
      res.status(201).json({ application: serializeAdminApplication(result.application as Parameters<typeof serializeAdminApplication>[0]), tenancy: serializeAdminTenancy(result.tenancy as Parameters<typeof serializeAdminTenancy>[0]) });
    } catch (error) { adminError(res, error); }
  });
  adminRouter.post("/tenancies/:id/lease-files", async (req, res) => {
    try {
      const actor = patchActorSubject(req);
      if (Object.keys(req.query).length || ["x-document-id", "x-person-id", "x-tenancy-id", "x-property-id", "x-unit-id", "x-application-id", "x-application-requirement-id"].some(name => req.get(name))) throw new RentOpsInvariantError("Lease scope is resolved from the tenancy only");
      if ((req.get("content-type") ?? "").split(";", 1)[0].trim() !== "application/pdf") throw new RentOpsInvariantError("Manager lease upload must be a PDF");
      const fileName = documentHeader(req, "x-document-name");
      if (!fileName) throw new RentOpsInvariantError("Document upload filename is required");
      const configured = options.documentUploadMaxBytes;
      const maxBytes = configured && Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, MAX_DOCUMENT_UPLOAD_BYTES) : MAX_DOCUMENT_UPLOAD_BYTES;
      const upload = boundedUploadStream(req, maxBytes);
      if (!upload) throw new RentOpsInvariantError("Document upload body is missing");
      const document = await service.saveManagerLeaseFile(req.params.id, { fileName, mimeType: "application/pdf", stream: upload.stream, sizeBytes: upload.sizeBytes }, actor);
      const documents = (await service.snapshot()).documents.filter(d => d.tenancyId === document.tenancyId && d.personId === document.personId && d.propertyId === document.propertyId && d.unitId === document.unitId && d.type === "lease");
      res.status(201).json({ document: serializeAdminDocument(document), documents: documents.map(serializeAdminDocument) });
    } catch (error) { adminError(res, error); }
  });
  // Metadata-only admin registration remains unavailable. Verified archive
  // transfers enter through the restricted importer/storage seam.
  adminRouter.post("/documents", (_req, res) => {
    res.status(503).json({ code: "verified_upload_required" });
  });
  adminRouter.get("/documents/:id/download", async (req, res) => {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(req.params.id)) { res.status(404).json(errorBody("not_found")); return; }
    try {
      const opened = await service.openVerifiedDocument(req.params.id);
      res.set("Cache-Control", "no-store");
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Type", opened.document.mimeType);
      res.set("Content-Disposition", `attachment; filename="${safeDownloadName(opened.document.fileName)}"`);
      opened.stream.on("error", () => { if (!res.headersSent) res.status(500).json(errorBody("temporarily_unavailable")); else res.destroy(); });
      opened.stream.pipe(res);
    } catch (error) { adminError(res, error); }
  });
  adminRouter.get("/documents", async (req, res) => { try { const snapshot = await service.snapshot(); const propertyId = asString(req.query.propertyId); res.json(snapshot.documents.filter((document) => !propertyId || document.propertyId === propertyId).map(serializeAdminDocument)); } catch (error) { adminError(res, error); } });
  adminRouter.patch("/documents/:id", (req, res) => patchAdminRecord(req, res, "document", patchDocumentSchema, (value) => serializeAdminDocument(value as Parameters<typeof serializeAdminDocument>[0])));
  adminRouter.post("/activity", async (req, res) => { const parsed = activitySchema.safeParse(req.body); if (!parsed.success) { res.status(400).json(errorBody("invalid_input")); return; } try { res.status(201).json(serializeAdminActivity(await service.saveActivity(parsed.data))); } catch (error) { adminError(res, error); } });
  adminRouter.get("/activity", async (req, res) => { try { const snapshot = await service.snapshot(); const personId = asString(req.query.personId); res.json(snapshot.activityEvents.filter((event) => !personId || event.personId === personId).sort((left, right) => String(right.occurredAt ?? "").localeCompare(String(left.occurredAt ?? ""))).map(serializeAdminActivity)); } catch (error) { adminError(res, error); } });
  // Activity events are append-only runtime records.  There is no edit form;
  // callers must post a new dated event rather than request UPDATE privilege.
  adminRouter.patch("/activity/:id", (_req, res) => { res.status(409).json(errorBody("activity_append_only")); });
  router.use(adminRouter);
  return router;
}

export function registerRentOpsRoutes(app: Express, options: RentOpsRouteOptions, mountPath = "/api/rent-ops"): Router {
  const router = createRentOpsRouter(options);
  app.use(mountPath, router);
  return router;
}
