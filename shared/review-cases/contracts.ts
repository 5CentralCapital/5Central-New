import { z } from "zod";
import {
  canonicalUuidSchema,
  centsSchema,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  revisionSchema,
} from "../company";
import {
  REVIEW_CAUSE_FAMILIES,
  REVIEW_MATERIALITIES,
  REVIEW_REASON_CODES,
  REVIEW_SCOPE_LEVELS,
  REVIEW_SUPPORTED_OPERATION_KINDS,
} from "./reasons";
export { REVIEW_SUPPORTED_OPERATION_KINDS } from "./reasons";
export type { ReviewSupportedOperationKind } from "./reasons";
import { REVIEW_CASE_COMMAND_KINDS, REVIEW_CASE_STATES, type ReviewCaseCommandKind } from "./transitions";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type ReviewCaseId = Brand<string, "ReviewCaseId">;
export const reviewCaseIdSchema = canonicalUuidSchema.transform((value) => value as ReviewCaseId);

export const reviewCaseStateSchema = z.enum(REVIEW_CASE_STATES);
export const reviewMaterialitySchema = z.enum(REVIEW_MATERIALITIES);
export const reviewCauseFamilySchema = z.enum(REVIEW_CAUSE_FAMILIES);
export const reviewReasonCodeSchema = z.enum(REVIEW_REASON_CODES);
export const reviewScopeLevelSchema = z.enum(REVIEW_SCOPE_LEVELS);

const safeText = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Text cannot contain control characters");
const referenceId = z.string().min(1).max(240).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Reference cannot contain control characters");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Records a case touches. Links are resolved by the client from kind and IDs. */
export const REVIEW_AFFECTED_RECORD_KINDS = [
  "organization", "legal_entity", "property", "unit", "tenancy", "person", "lease_term", "schedule",
  "ledger_transaction", "intake_packet", "intake_line", "qbo_object", "document",
] as const;
export type ReviewAffectedRecordKind = (typeof REVIEW_AFFECTED_RECORD_KINDS)[number];

export const reviewAffectedRecordSchema = z.object({
  kind: z.enum(REVIEW_AFFECTED_RECORD_KINDS),
  id: referenceId,
  label: z.string().max(240).nullable(),
  propertyId: referenceId.nullable(),
  unitId: referenceId.nullable(),
  tenancyId: referenceId.nullable(),
  personId: referenceId.nullable(),
  codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/)).max(50),
}).strict();
export type ReviewAffectedRecord = z.infer<typeof reviewAffectedRecordSchema>;

export const REVIEW_EVIDENCE_KINDS = ["detector", "document", "source_record", "email", "observation", "note"] as const;
export type ReviewEvidenceKind = (typeof REVIEW_EVIDENCE_KINDS)[number];

/** Evidence supplied by a person or agent. The server assigns identity, actor and time. */
export const reviewEvidenceInputSchema = z.object({
  kind: z.enum(["document", "source_record", "email", "observation", "note"]),
  reference: safeText(400),
  summary: safeText(1_000),
  documentId: referenceId.optional(),
  sha256: sha256Schema.optional(),
  observedOn: isoDateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "document" && !value.documentId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["documentId"], message: "Document evidence names its company document" });
});
export type ReviewEvidenceInput = z.infer<typeof reviewEvidenceInputSchema>;

export const reviewEvidenceSchema = z.object({
  id: referenceId,
  kind: z.enum(REVIEW_EVIDENCE_KINDS),
  origin: z.enum(["detector", "manual"]),
  reference: z.string().min(1).max(400),
  summary: z.string().min(1).max(1_000),
  documentId: referenceId.nullable(),
  sha256: sha256Schema.nullable(),
  observedOn: isoDateSchema.nullable(),
  count: z.number().int().nonnegative().nullable(),
  addedBy: z.string().min(1).max(160),
  addedAt: isoTimestampSchema,
}).strict();
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

/**
 * Guarded reconciliation operation kinds a case may apply. Kinds that need an
 * archived snapshot or a separate transfer phase stay in the maintenance CLI.
 */
/** A reconciliation operation without evidence; the server binds the verified evidence document. */
export const reviewOperationSchema = z.object({
  kind: z.enum(REVIEW_SUPPORTED_OPERATION_KINDS),
  targetId: referenceId,
  expectedRevision: z.number().int().positive(),
  beforeSha256: sha256Schema,
}).passthrough().superRefine((value, context) => {
  if ("evidence" in value) context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "Evidence is bound by the server from evidenceDocumentId" });
});
export type ReviewOperation = z.infer<typeof reviewOperationSchema>;

export const REVIEW_ACCOUNTING_ROUTES = ["accounting.journal_entry", "accounting.receipt_allocation", "accounting.qbo_correction", "accounting.pm_settlement"] as const;

export const reviewCorrectionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("operational"),
    summary: safeText(1_000),
    operation: reviewOperationSchema,
    /** A verified company document whose bytes the guarded writer re-hashes before any change. */
    evidenceDocumentId: referenceId,
  }).strict(),
  z.object({
    kind: z.literal("financial"),
    summary: safeText(1_000),
    route: z.enum(REVIEW_ACCOUNTING_ROUTES),
    amountCents: centsSchema.nullable(),
    currency: currencyCodeSchema.default("USD"),
    detail: safeText(2_000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("connection"),
    summary: safeText(1_000),
    action: safeText(1_000),
  }).strict(),
]);
export type ReviewCorrectionInput = z.infer<typeof reviewCorrectionInputSchema>;

export const reviewCorrectionPreviewSchema = z.object({
  planToken: sha256Schema,
  changes: z.array(z.object({
    targetId: z.string(),
    beforeSha256: sha256Schema,
    afterSha256: sha256Schema,
    before: z.unknown(),
    after: z.unknown(),
  }).strict()).max(50),
  ledgerUnchanged: z.literal(true),
}).strict();

/** Stored proposal: the input plus the server-computed dry-run and routing state. */
export const reviewProposedCorrectionSchema = z.object({
  input: reviewCorrectionInputSchema,
  preview: reviewCorrectionPreviewSchema.nullable(),
  proposedBy: z.string().min(1).max(160),
  proposedAt: isoTimestampSchema,
  routing: z.object({
    status: z.literal("routed_to_accounting"),
    reason: z.string().min(1).max(500),
    routedAt: isoTimestampSchema,
    routedBy: z.string().min(1).max(160),
  }).strict().nullable(),
}).strict();
export type ReviewProposedCorrection = z.infer<typeof reviewProposedCorrectionSchema>;

export const reviewCaseSummarySchema = z.object({
  id: reviewCaseIdSchema,
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema.nullable(),
  propertyId: propertyReferenceIdSchema.nullable(),
  reasonCode: reviewReasonCodeSchema,
  shortLabel: z.string(),
  causeFamily: reviewCauseFamilySchema,
  causeKey: z.string(),
  scopeKey: z.string(),
  scopeLabel: z.string().nullable(),
  state: reviewCaseStateSchema,
  materiality: reviewMaterialitySchema,
  asOf: isoDateSchema,
  /** Null means unknown. It is never reported as zero. */
  impactCents: centsSchema.nullable(),
  impactCurrency: currencyCodeSchema.nullable(),
  affectedCount: z.number().int().nonnegative(),
  blockedOn: z.string().nullable(),
  detectedBy: z.enum(["detector", "manual", "intake", "accounting"]),
  reopenedCount: z.number().int().nonnegative(),
  recordRevision: revisionSchema,
  firstDetectedAt: isoTimestampSchema,
  lastDetectedAt: isoTimestampSchema,
  resolvedAt: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema,
  nextAction: z.string(),
}).strict();
export type ReviewCaseSummary = z.infer<typeof reviewCaseSummarySchema>;

export const REVIEW_CASE_EVENT_KINDS = ["detected", "refreshed", "transitioned", "proposed", "applied", "verified", "reopened", "auto_resolved", "note"] as const;
export type ReviewCaseEventKind = (typeof REVIEW_CASE_EVENT_KINDS)[number];

export const reviewCaseEventSchema = z.object({
  id: canonicalUuidSchema,
  kind: z.enum(REVIEW_CASE_EVENT_KINDS),
  fromState: reviewCaseStateSchema.nullable(),
  toState: reviewCaseStateSchema,
  caseRevision: revisionSchema,
  actorId: z.string(),
  sourceFingerprint: sha256Schema,
  detail: z.record(z.string(), z.unknown()),
  occurredAt: isoTimestampSchema,
}).strict();
export type ReviewCaseEvent = z.infer<typeof reviewCaseEventSchema>;

export const reviewCaseDetailSchema = reviewCaseSummarySchema.extend({
  sourceFingerprint: sha256Schema,
  affectedRecords: z.array(reviewAffectedRecordSchema).max(500),
  affectedRecordsTruncated: z.boolean(),
  evidence: z.array(reviewEvidenceSchema).max(200),
  proposedCorrection: reviewProposedCorrectionSchema.nullable(),
  history: z.array(reviewCaseEventSchema).max(1_000),
  allowedCommands: z.array(z.enum(REVIEW_CASE_COMMAND_KINDS)),
  researchGuidance: z.string(),
  requiredVerification: z.string(),
  resolution: z.enum(["operational", "financial", "connection"]),
}).strict();
export type ReviewCaseDetail = z.infer<typeof reviewCaseDetailSchema>;

export const reviewCaseListQuerySchema = z.object({
  scope: companyScopeSchema,
  states: z.array(reviewCaseStateSchema).min(1).max(REVIEW_CASE_STATES.length).optional(),
  reasonCodes: z.array(reviewReasonCodeSchema).min(1).max(REVIEW_REASON_CODES.length).optional(),
  materialities: z.array(reviewMaterialitySchema).min(1).max(REVIEW_MATERIALITIES.length).optional(),
  causeFamilies: z.array(reviewCauseFamilySchema).min(1).max(REVIEW_CAUSE_FAMILIES.length).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();
export type ReviewCaseListQuery = z.input<typeof reviewCaseListQuerySchema>;
export type ParsedReviewCaseListQuery = z.output<typeof reviewCaseListQuerySchema>;

export const reviewCaseGroupSchema = z.object({
  causeFamily: reviewCauseFamilySchema,
  materiality: reviewMaterialitySchema,
  caseCount: z.number().int().nonnegative(),
  /** Affected records are counted separately from cases; one case may cover many records. */
  affectedCount: z.number().int().nonnegative(),
}).strict();

export const reviewCaseListResponseSchema = z.object({
  items: z.array(reviewCaseSummarySchema).max(100),
  groups: z.array(reviewCaseGroupSchema).max(REVIEW_CAUSE_FAMILIES.length * REVIEW_MATERIALITIES.length),
  totals: z.object({ caseCount: z.number().int().nonnegative(), affectedCount: z.number().int().nonnegative() }).strict(),
  nextCursor: z.string().nullable(),
}).strict();
export type ReviewCaseListResponse = z.infer<typeof reviewCaseListResponseSchema>;

export const reviewDetectionSummarySchema = z.object({
  organizationId: organizationIdSchema,
  asOf: isoDateSchema,
  candidateCount: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  refreshed: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  reopened: z.number().int().nonnegative(),
  autoVerified: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  changedCaseIds: z.array(reviewCaseIdSchema).max(1_000),
  /** "preview" for a date other than the operating date: nothing was written. */
  mode: z.enum(["live", "preview"]),
  /** False when a rental report or input could not be read completely; nothing was verified by readback. */
  complete: z.boolean(),
  incompleteReasons: z.array(z.string().max(500)).max(20),
}).strict();
export type ReviewDetectionSummary = z.infer<typeof reviewDetectionSummarySchema>;

export const reviewInventorySchema = z.object({
  organizationId: organizationIdSchema,
  generatedAt: isoTimestampSchema,
  totals: z.object({
    activeCaseCount: z.number().int().nonnegative(),
    verifiedCaseCount: z.number().int().nonnegative(),
    affectedRecordCount: z.number().int().nonnegative(),
    overlappingRecordCount: z.number().int().nonnegative(),
    unknownImpactCaseCount: z.number().int().nonnegative(),
  }).strict(),
  byReason: z.array(z.object({
    reasonCode: reviewReasonCodeSchema, shortLabel: z.string(), causeFamily: reviewCauseFamilySchema,
    caseCount: z.number().int().nonnegative(), affectedCount: z.number().int().nonnegative(),
  }).strict()),
  byMateriality: z.array(z.object({ materiality: reviewMaterialitySchema, caseCount: z.number().int().nonnegative(), affectedCount: z.number().int().nonnegative() }).strict()),
  byState: z.array(z.object({ state: reviewCaseStateSchema, caseCount: z.number().int().nonnegative() }).strict()),
  overlap: z.array(z.object({ reasonCodes: z.tuple([reviewReasonCodeSchema, reviewReasonCodeSchema]), recordCount: z.number().int().positive() }).strict()).max(50),
  remaining: z.array(z.object({
    caseId: reviewCaseIdSchema,
    reasonCode: reviewReasonCodeSchema,
    shortLabel: z.string(),
    scopeLabel: z.string().nullable(),
    propertyId: propertyReferenceIdSchema.nullable(),
    state: reviewCaseStateSchema,
    materiality: reviewMaterialitySchema,
    affectedCount: z.number().int().nonnegative(),
    impactCents: centsSchema.nullable(),
    missingEvidence: z.string(),
    nextAction: z.string(),
  }).strict()).max(500),
  remainingTruncated: z.boolean(),
}).strict();
export type ReviewInventory = z.infer<typeof reviewInventorySchema>;

const caseRef = { caseId: reviewCaseIdSchema };
export const reviewCaseCommandPayloadSchemas = {
  "review_case.detect": z.object({ asOf: isoDateSchema.optional() }).strict(),
  "review_case.start_research": z.object({ ...caseRef, note: safeText(4_000).optional() }).strict(),
  "review_case.add_evidence": z.object({ ...caseRef, evidence: reviewEvidenceInputSchema }).strict(),
  "review_case.propose": z.object({ ...caseRef, correction: reviewCorrectionInputSchema }).strict(),
  "review_case.block": z.object({ ...caseRef, missingFact: safeText(500) }).strict(),
  "review_case.apply": z.object({ ...caseRef }).strict(),
  "review_case.verify": z.object({ ...caseRef }).strict(),
  "review_case.reopen": z.object({ ...caseRef, reason: safeText(1_000) }).strict(),
  "review_case.note": z.object({ ...caseRef, note: safeText(4_000) }).strict(),
} as const satisfies Record<ReviewCaseCommandKind, z.ZodTypeAny>;

export type ReviewCaseCommandPayload<K extends ReviewCaseCommandKind> = z.output<(typeof reviewCaseCommandPayloadSchemas)[K]>;
