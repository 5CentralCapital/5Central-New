import { z } from "zod";
import {
  centsSchema,
  companyScopeSchema,
  currencyCodeSchema,
  documentReferenceIdSchema,
  isoDateSchema,
  isoTimestampSchema,
  propertyReferenceIdSchema,
  recordReferenceIdSchema,
  type CompanyScope,
  type CurrencyCode,
  type IsoDate,
  type IsoTimestamp,
  type MoneyCents,
  type RecordReferenceId,
} from "../company";

/** The source packet is retained as an observation; it is never a command. */
export const MRA_PACKET_FORMAT = "mra.owner_packet.v1" as const;
export const mraPacketFormatSchema = z.literal(MRA_PACKET_FORMAT);

export const INTAKE_PACKET_STATES = [
  "staged",
  "mapped",
  "previewed",
  "applying",
  "partially_applied",
  "applied",
  "held",
  "failed",
] as const;
export type IntakePacketState = (typeof INTAKE_PACKET_STATES)[number];
export const intakePacketStateSchema = z.enum(INTAKE_PACKET_STATES);

export const INTAKE_LINE_OUTCOMES = [
  "matched",
  "held_missing_identity",
  "held_ambiguous_identity",
  "held_unsupported",
  "duplicate",
  "overlap",
  "corrected",
  "applied",
  "apply_failed",
] as const;
export type IntakeLineOutcome = (typeof INTAKE_LINE_OUTCOMES)[number];
export const intakeLineOutcomeSchema = z.enum(INTAKE_LINE_OUTCOMES);

export const MRA_LINE_CATEGORIES = [
  "rent",
  "hap",
  "deposit",
  "fee",
  "credit",
  "refund",
  "adjustment",
  "other",
  "unknown",
] as const;
export type MraLineCategory = (typeof MRA_LINE_CATEGORIES)[number];
export const mraLineCategorySchema = z.enum(MRA_LINE_CATEGORIES);

export const MRA_PAYER_TYPES = [
  "tenant",
  "hap",
  "pm_custodian",
  "bank_settled",
  "unknown",
] as const;
export type MraPayerType = (typeof MRA_PAYER_TYPES)[number];
export const mraPayerTypeSchema = z.enum(MRA_PAYER_TYPES);

const sourceText = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Source text contains a control character");
const optionalSourceText = (max: number) => sourceText(max).nullable().optional();

/** Semantic meaning is independent of the accounting category. A positive
 * balance or charge is not evidence that cash was received. */
export const MRA_SOURCE_TRANSACTION_KINDS = [
  "charge",
  "payment",
  "credit",
  "refund",
  "adjustment",
  "balance_observation",
  "pm_remittance",
  "unknown",
] as const;
export type MraSourceTransactionKind = (typeof MRA_SOURCE_TRANSACTION_KINDS)[number];
export const mraSourceTransactionKindSchema = z.enum(MRA_SOURCE_TRANSACTION_KINDS);
export const mraSourceDirectionSchema = z.enum(["inflow", "outflow", "unknown"] as const);
export type MraSourceDirection = z.infer<typeof mraSourceDirectionSchema>;

export const mraSourceProvenanceSchema = z.object({
  sourceSystem: sourceText(120).default("mra"),
  adapter: z.enum(["structured", "xlsx", "pdf", "codex_extraction"]).default("structured"),
  extractionRunId: optionalSourceText(240),
}).strict();
export type MraSourceProvenance = z.infer<typeof mraSourceProvenanceSchema>;

export const MRA_LOCAL_TARGET_KINDS = [
  "tenant_account",
  "property_account",
  "unit_account",
  "unresolved",
] as const;
export type MraLocalTargetKind = (typeof MRA_LOCAL_TARGET_KINDS)[number];
export const mraLocalTargetKindSchema = z.enum(MRA_LOCAL_TARGET_KINDS);

export const intakeEvidenceSchema = z.object({
  page: z.number().int().positive().optional(),
  row: z.number().int().positive().optional(),
  section: optionalSourceText(160),
  sourcePath: optionalSourceText(400),
  excerptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((value) => value.page !== undefined || value.row !== undefined || value.sourcePath !== undefined, {
  message: "Document evidence must identify a page, row, or source path",
});
export type IntakeEvidence = z.infer<typeof intakeEvidenceSchema>;

export const intakeSourceObjectSchema = z.object({
  documentId: documentReferenceIdSchema,
  fileName: sourceText(240),
  declaredContentType: sourceText(120),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backend: sourceText(120),
  logicalKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  immutableGeneration: sourceText(256).optional(),
  immutableVersion: sourceText(256).optional(),
  verifiedAt: isoTimestampSchema,
}).strict().refine((value) => value.immutableGeneration !== undefined || value.immutableVersion !== undefined, {
  message: "An immutable object version is required",
}).refine((value) => value.logicalKey === `sha256:${value.checksumSha256}`, {
  path: ["logicalKey"],
  message: "The logical object key must match the source checksum",
});
export type IntakeSourceObject = z.infer<typeof intakeSourceObjectSchema>;

export const mraPacketPeriodSchema = z.object({
  from: isoDateSchema,
  through: isoDateSchema,
}).strict().refine((value) => value.through >= value.from, {
  path: ["through"],
  message: "The packet period must be ordered",
});
export type MraPacketPeriod = z.infer<typeof mraPacketPeriodSchema>;

/** Candidate values are deliberately separate from local target identities. */
export const mraSourceLineCandidateSchema = z.object({
  sourceLineKey: sourceText(240).optional(),
  /** Stable provider identity when the source supplies one. */
  providerTransactionId: optionalSourceText(240),
  originalSourceIdentity: optionalSourceText(240),
  sourceAccountId: sourceText(200),
  sourceAccountName: optionalSourceText(240),
  sourceRevision: sourceText(120).default("packet"),
  tenantSourceId: optionalSourceText(200),
  tenantDisplayName: optionalSourceText(240),
  propertySourceId: optionalSourceText(200),
  unitSourceId: optionalSourceText(200),
  postedOn: isoDateSchema,
  dueOn: isoDateSchema.nullable().optional(),
  periodMonth: isoDateSchema.nullable().optional(),
  amountCents: centsSchema,
  currency: currencyCodeSchema,
  category: mraLineCategorySchema.default("unknown"),
  payer: mraPayerTypeSchema.default("unknown"),
  transactionKind: mraSourceTransactionKindSchema.default("unknown"),
  direction: mraSourceDirectionSchema.default("unknown"),
  provenance: mraSourceProvenanceSchema.default({ sourceSystem: "mra", adapter: "structured" }),
  description: optionalSourceText(500),
  correctsSourceLineKey: sourceText(240).optional(),
  evidence: z.array(intakeEvidenceSchema).min(1).max(32),
}).strict();
export type MraSourceLineCandidate = z.infer<typeof mraSourceLineCandidateSchema>;

export const mraAccountCandidateSchema = z.object({
  sourceAccountId: sourceText(200),
  sourceAccountName: optionalSourceText(240),
  currency: currencyCodeSchema,
  lines: z.array(mraSourceLineCandidateSchema).max(100_000),
  evidence: z.array(intakeEvidenceSchema).max(32).default([]),
}).strict();
export type MraAccountCandidate = z.infer<typeof mraAccountCandidateSchema>;

export const mraPacketCandidateSchema = z.object({
  format: mraPacketFormatSchema,
  packetRevision: sourceText(120).default("1"),
  period: mraPacketPeriodSchema,
  accounts: z.array(mraAccountCandidateSchema).max(10_000),
  extractionWarnings: z.array(sourceText(500)).max(1_000).default([]),
}).strict();
export type MraPacketCandidate = z.infer<typeof mraPacketCandidateSchema>;

export const mraMappingSchema = z.object({
  sourceLineKey: sourceText(240),
  outcome: z.enum(["exact", "ambiguous", "missing", "held"]),
  localTargetKind: mraLocalTargetKindSchema,
  localTargetId: recordReferenceIdSchema.optional(),
  tenancyId: recordReferenceIdSchema.optional(),
  personId: recordReferenceIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  reason: sourceText(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "exact" && (!value.localTargetId || value.localTargetKind === "unresolved")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["localTargetId"], message: "An exact mapping requires a local target" });
  }
  if (value.outcome !== "exact" && !value.reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Held mappings require a reason" });
  }
});
export type MraMapping = z.infer<typeof mraMappingSchema>;

export const intakeLineRecordSchema = z.object({
  sourceLineKey: sourceText(240),
  providerTransactionId: z.string().nullable().default(null),
  originalSourceIdentity: z.string().nullable().default(null),
  sourceAccountId: sourceText(200),
  sourceAccountName: z.string().nullable(),
  sourceRevision: sourceText(120),
  tenantSourceId: z.string().nullable(),
  tenantDisplayName: z.string().nullable(),
  propertySourceId: z.string().nullable(),
  unitSourceId: z.string().nullable(),
  postedOn: isoDateSchema,
  dueOn: isoDateSchema.nullable(),
  periodMonth: isoDateSchema.nullable(),
  amountCents: centsSchema,
  currency: currencyCodeSchema,
  category: mraLineCategorySchema,
  payer: mraPayerTypeSchema,
  transactionKind: mraSourceTransactionKindSchema.default("unknown"),
  direction: mraSourceDirectionSchema.default("unknown"),
  provenance: mraSourceProvenanceSchema.default({ sourceSystem: "mra", adapter: "structured" }),
  description: z.string().nullable(),
  correctsSourceLineKey: z.string().nullable(),
  evidence: z.array(intakeEvidenceSchema).min(1).max(32),
  mapping: mraMappingSchema.nullable(),
  outcome: intakeLineOutcomeSchema.nullable(),
  outcomeReason: z.string().nullable(),
}).strict();
export type IntakeLineRecord = z.infer<typeof intakeLineRecordSchema>;

export const intakeAmountTotalsSchema = z.object({
  currency: currencyCodeSchema,
  inputCents: centsSchema,
  matchedCents: centsSchema,
  heldCents: centsSchema,
  duplicateCents: centsSchema,
  overlapCents: centsSchema,
  appliedCents: centsSchema,
}).strict();
export type IntakeAmountTotals = z.infer<typeof intakeAmountTotalsSchema>;

export const intakeAccountOutcomeSchema = z.object({
  sourceAccountId: sourceText(200),
  sourceAccountName: z.string().nullable(),
  lineCount: z.number().int().nonnegative(),
  matchedCount: z.number().int().nonnegative(),
  heldCount: z.number().int().nonnegative(),
  appliedCount: z.number().int().nonnegative(),
  state: z.enum(["ready", "held", "applied", "failed"]),
  message: z.string().nullable(),
}).strict();
export type IntakeAccountOutcome = z.infer<typeof intakeAccountOutcomeSchema>;

export const intakeReconciliationSchema = z.object({
  totals: z.array(intakeAmountTotalsSchema).max(100),
  accounts: z.array(intakeAccountOutcomeSchema).max(10_000),
  sourceLineCount: z.number().int().nonnegative(),
  matchedLineCount: z.number().int().nonnegative(),
  heldLineCount: z.number().int().nonnegative(),
  duplicateLineCount: z.number().int().nonnegative(),
  overlapLineCount: z.number().int().nonnegative(),
  correctedLineCount: z.number().int().nonnegative(),
  appliedLineCount: z.number().int().nonnegative(),
}).strict();
export type IntakeReconciliation = z.infer<typeof intakeReconciliationSchema>;

export const mraPacketRecordSchema = z.object({
  id: recordReferenceIdSchema,
  scope: companyScopeSchema,
  state: intakePacketStateSchema,
  source: intakeSourceObjectSchema,
  candidate: mraPacketCandidateSchema,
  lines: z.array(intakeLineRecordSchema).max(100_000),
  reconciliation: intakeReconciliationSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  mappedAt: isoTimestampSchema.nullable(),
  previewedAt: isoTimestampSchema.nullable(),
  appliedAt: isoTimestampSchema.nullable(),
  revision: z.number().int().positive(),
}).strict();
export type MraPacketRecord = z.infer<typeof mraPacketRecordSchema>;

export const mraPacketReadModelSchema = mraPacketRecordSchema.omit({ candidate: true }).extend({
  /** The browser receives normalized rows and evidence, never raw packet bytes. */
  candidateWarnings: z.array(z.string()).max(1_000),
}).strict();
export type MraPacketReadModel = z.infer<typeof mraPacketReadModelSchema>;

export const intakePageSchema = z.object({
  items: z.array(mraPacketReadModelSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict();
export type IntakePage = z.infer<typeof intakePageSchema>;

export const projectCostCandidateSchema = z.object({
  sourceLineKey: sourceText(240),
  scope: companyScopeSchema,
  projectId: recordReferenceIdSchema,
  scopeItemId: recordReferenceIdSchema.nullable().optional(),
  vendorName: optionalSourceText(200),
  description: sourceText(300),
  amountCents: centsSchema.refine((value) => BigInt(value) >= BigInt(0), "Project cost cannot be negative"),
  currency: currencyCodeSchema,
  incurredOn: isoDateSchema,
  evidence: z.array(intakeEvidenceSchema).min(1).max(32),
  duplicateOfSourceLineKey: sourceText(240).optional(),
}).strict();
export type ProjectCostCandidate = z.infer<typeof projectCostCandidateSchema>;

export const projectCostPreviewSchema = z.object({
  candidate: projectCostCandidateSchema,
  outcome: z.enum(["new_draft", "duplicate", "held"]),
  reason: z.string().nullable(),
}).strict();
export type ProjectCostPreview = z.infer<typeof projectCostPreviewSchema>;

export interface ProjectDraftCostCommandInput {
  readonly kind: "project.draft_cost.create";
  readonly scope: CompanyScope;
  readonly projectId: RecordReferenceId;
  readonly scopeItemId?: RecordReferenceId;
  readonly vendorName?: string | null;
  readonly description: string;
  readonly amountCents: MoneyCents;
  readonly incurredOn: IsoDate;
  readonly sourceLineKey: string;
  readonly sourceDocumentId: string;
}

/** Stable line identity used for duplicate/overlap/correction checks. */
export function deterministicMraSourceLineKey(input: {
  readonly sourceAccountId: string;
  readonly postedOn: string;
  readonly periodMonth?: string | null;
  readonly lineNumber: number;
  readonly tenantSourceId?: string | null;
}): string {
  const account = input.sourceAccountId.trim();
  const tenant = input.tenantSourceId?.trim() ?? "";
  const period = input.periodMonth?.trim() ?? "";
  if (!account || !/^\d{4}-\d{2}-\d{2}$/.test(input.postedOn) || !Number.isSafeInteger(input.lineNumber) || input.lineNumber < 1) {
    throw new Error("mra_source_line_identity_invalid");
  }
  return `mra:${encodeURIComponent(account)}:${input.postedOn}:${encodeURIComponent(period)}:${input.lineNumber}:${encodeURIComponent(tenant)}`;
}

export function sourceObjectVersionKey(source: Pick<IntakeSourceObject, "backend" | "logicalKey" | "immutableGeneration" | "immutableVersion">): string {
  return [source.backend, source.logicalKey, source.immutableGeneration ?? "", source.immutableVersion ?? ""].join("\u0000");
}

export function scopeForIntake(scope: CompanyScope): CompanyScope {
  return companyScopeSchema.parse(scope);
}

export type IntakePacketId = RecordReferenceId;
export type IntakeDocumentId = ReturnType<typeof documentReferenceIdSchema.parse>;
export type IntakeCurrency = CurrencyCode;
export type IntakePacketDate = IsoDate;
export type IntakeRecordedAt = IsoTimestamp;

/**
 * Stage command payload. The server computes the SHA-256 of the received bytes
 * and binds it (and the size) into this payload before the command runs, so the
 * idempotency key covers the exact bytes: replaying a key with different bytes
 * is a conflict, never a silent reuse.
 */
export const mraStagePayloadSchema = z.object({
  action: z.literal("stage"),
  fileName: sourceText(240),
  declaredContentType: sourceText(120),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
  /** Stage from an existing verified company document instead of uploaded bytes. */
  sourceDocumentId: documentReferenceIdSchema.optional(),
}).strict();
export type MraStagePayload = z.infer<typeof mraStagePayloadSchema>;

export const MRA_INGESTION_ACTIONS = ["map", "preview", "apply"] as const;
export type MraIngestionActionName = (typeof MRA_INGESTION_ACTIONS)[number];

export const intakeListQuerySchema = z.object({
  scope: companyScopeSchema,
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export type IntakeListQuery = z.input<typeof intakeListQuerySchema>;
