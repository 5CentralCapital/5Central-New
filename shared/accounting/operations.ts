import { z } from "zod";
import {
  canonicalUuidSchema,
  centsSchema,
  currencyCodeSchema,
  documentReferenceIdSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  revisionSchema,
} from "../company";

/*
 * Contracts for accounting integration operations: the durable job queue,
 * QuickBooks connector health, rental posting ownership, property-manager
 * gross-to-net settlements and the rental summary bridge preview. Money is
 * signed BIGINT cents as canonical decimal strings; unknown values are null.
 */

const cursorSchema = z.string().trim().min(1).max(512);
const realmIdSchema = z.string().regex(/^\d{1,32}$/, "QBO realm ID is invalid");
export const qboEnvironmentSchema = z.enum(["sandbox", "production"]);
export type QboEnvironment = z.infer<typeof qboEnvironmentSchema>;

/* ── Durable jobs ─────────────────────────────────────────────────────── */

export const JOB_STATES = ["queued", "running", "retry", "succeeded", "dead", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const jobStateSchema = z.enum(JOB_STATES);
export const JOB_ATTEMPT_OUTCOMES = ["succeeded", "retry", "dead", "lease_expired", "cancelled"] as const;
export const jobTopicSchema = z.string().min(1).max(120).regex(/^[a-z][a-z0-9_.-]*$/, "Job topic must be a stable machine name");
export const jobKeySchema = z.string().min(1).max(255).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "Job key is invalid");
export const jobIdSchema = canonicalUuidSchema;

export const jobSummarySchema = z.object({
  id: jobIdSchema,
  organizationId: organizationIdSchema.nullable(),
  jobKey: z.string(),
  topic: jobTopicSchema,
  state: jobStateSchema,
  priority: z.number().int(),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  runAfter: isoTimestampSchema,
  leaseOwner: z.string().nullable(),
  leaseUntil: isoTimestampSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().max(500).nullable(),
  hasCheckpoint: z.boolean(),
  outboxEventId: canonicalUuidSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  finishedAt: isoTimestampSchema.nullable(),
}).strict();
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  leaseOwner: z.string(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
  outcome: z.enum(JOB_ATTEMPT_OUTCOMES).nullable(),
  errorCode: z.string().nullable(),
}).strict();
export type JobAttempt = z.infer<typeof jobAttemptSchema>;

export const jobDetailSchema = jobSummarySchema.extend({
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  checkpoint: z.record(z.string(), z.unknown()).nullable(),
  attemptHistory: z.array(jobAttemptSchema),
}).strict();
export type JobDetail = z.infer<typeof jobDetailSchema>;

export const jobListQuerySchema = z.object({
  organizationId: organizationIdSchema,
  states: z.array(jobStateSchema).min(1).max(JOB_STATES.length).optional(),
  topics: z.array(jobTopicSchema).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: cursorSchema.optional(),
}).strict();
export type JobListQuery = z.input<typeof jobListQuerySchema>;

export const jobListResponseSchema = z.object({
  items: z.array(jobSummarySchema),
  nextCursor: z.string().nullable(),
  counts: z.record(jobStateSchema, z.number().int().min(0)),
}).strict();
export type JobListResponse = z.infer<typeof jobListResponseSchema>;

export const JOB_COMMAND_KINDS = ["job.requeue", "job.cancel"] as const;
export type JobCommandKind = (typeof JOB_COMMAND_KINDS)[number];
export const requeueJobPayloadSchema = z.object({
  jobId: jobIdSchema,
  additionalAttempts: z.number().int().min(1).max(20).default(3),
}).strict();
export const cancelJobPayloadSchema = z.object({ jobId: jobIdSchema }).strict();
export const jobCommandPayloadSchemas = {
  "job.requeue": requeueJobPayloadSchema,
  "job.cancel": cancelJobPayloadSchema,
} as const satisfies Record<JobCommandKind, z.ZodTypeAny>;
export const JOB_MCP_TOOL_NAMES: Readonly<Record<JobCommandKind, string>> = {
  "job.requeue": "requeue_job",
  "job.cancel": "cancel_job",
};

/* ── Connector health ─────────────────────────────────────────────────── */

export const connectorScopeSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: qboEnvironmentSchema,
  realmId: realmIdSchema,
}).strict();
export type ConnectorScope = z.infer<typeof connectorScopeSchema>;

export const CONNECTOR_FRESHNESS = ["current", "stale", "never_synced", "disconnected"] as const;
export const connectorHealthSchema = z.object({
  scope: connectorScopeSchema,
  legalEntityName: z.string(),
  companyName: z.string().nullable(),
  connection: z.object({
    status: z.enum(["active", "needs_reconnect", "revoked", "missing"]),
    readEnabled: z.boolean(),
    accessTokenExpiresAt: isoTimestampSchema.nullable(),
    refreshTokenHardExpiresAt: isoTimestampSchema.nullable(),
  }).strict(),
  freshness: z.enum(CONNECTOR_FRESHNESS),
  lastSuccessfulSyncAt: isoTimestampSchema.nullable(),
  lastChangeSyncAt: isoTimestampSchema.nullable(),
  lastVerifiedFullReplayAt: isoTimestampSchema.nullable(),
  lagSeconds: z.number().int().min(0).nullable(),
  coverage: z.object({ status: z.enum(["unavailable", "partial", "complete"]), reason: z.string().nullable() }).strict(),
  openSyncExceptions: z.number().int().min(0),
  /** Objects still deleted whose deletion was detected in the last 30 days. */
  activeTombstones: z.number().int().min(0),
  jobs: z.object({
    queued: z.number().int().min(0),
    running: z.number().int().min(0),
    retry: z.number().int().min(0),
    dead: z.number().int().min(0),
    lastFailureCode: z.string().nullable(),
  }).strict(),
  lastWebhookAt: isoTimestampSchema.nullable(),
  rateLimitedUntil: isoTimestampSchema.nullable(),
}).strict();
export type ConnectorHealth = z.infer<typeof connectorHealthSchema>;
export const connectorHealthResponseSchema = z.object({
  items: z.array(connectorHealthSchema),
  workers: z.object({ active: z.number().int().min(0), lastSeenAt: isoTimestampSchema.nullable() }).strict(),
  generatedAt: isoTimestampSchema,
}).strict();
export type ConnectorHealthResponse = z.infer<typeof connectorHealthResponseSchema>;

/* ── Rental posting ownership ─────────────────────────────────────────── */

export const RENTAL_POSTING_METHODS = ["native_receivables", "summary_bridge", "not_posted"] as const;
export type RentalPostingMethod = (typeof RENTAL_POSTING_METHODS)[number];
export const rentalPostingMethodSchema = z.enum(RENTAL_POSTING_METHODS);

const reasonSchema = z.string().trim().min(1).max(1000);
const referenceTextSchema = z.string().trim().min(1).max(240);

export const setRentalPostingPolicyPayloadSchema = z.object({
  method: rentalPostingMethodSchema,
  effectiveFrom: isoDateSchema,
  effectiveUntil: isoDateSchema.nullable().optional(),
  cutoffDate: isoDateSchema,
  openingBalanceBridgeReference: referenceTextSchema.nullable().optional(),
  invoiceDeliveryVerified: z.boolean().default(false),
  reason: reasonSchema,
}).strict().superRefine((value, context) => {
  if (value.effectiveUntil && value.effectiveUntil <= value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveUntil"], message: "The end date must be after the start date" });
  if (value.cutoffDate < value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cutoffDate"], message: "The cutoff date cannot be before the start date" });
  if (value.method === "native_receivables" && !value.invoiceDeliveryVerified) context.addIssue({ code: z.ZodIssueCode.custom, path: ["invoiceDeliveryVerified"], message: "Confirm QuickBooks invoice email delivery is off before choosing native receivables" });
});
export const closeRentalPostingPolicyPayloadSchema = z.object({
  policyId: canonicalUuidSchema,
  effectiveUntil: isoDateSchema,
  reason: reasonSchema,
}).strict();

export const RENTAL_POSTING_COMMAND_KINDS = ["accounting.rental_posting_policy.set", "accounting.rental_posting_policy.close"] as const;
export type RentalPostingCommandKind = (typeof RENTAL_POSTING_COMMAND_KINDS)[number];
export const rentalPostingCommandPayloadSchemas = {
  "accounting.rental_posting_policy.set": setRentalPostingPolicyPayloadSchema,
  "accounting.rental_posting_policy.close": closeRentalPostingPolicyPayloadSchema,
} as const satisfies Record<RentalPostingCommandKind, z.ZodTypeAny>;

export const rentalPostingPolicySchema = z.object({
  id: canonicalUuidSchema,
  legalEntityId: legalEntityIdSchema,
  method: rentalPostingMethodSchema,
  effectiveFrom: isoDateSchema,
  effectiveUntil: isoDateSchema.nullable(),
  cutoffDate: isoDateSchema,
  openingBalanceBridgeReference: z.string().nullable(),
  invoiceDeliveryVerified: z.boolean(),
  approvedBy: z.string(),
  approvedAt: isoTimestampSchema,
  reason: z.string(),
  recordRevision: revisionSchema,
}).strict();
export type RentalPostingPolicy = z.infer<typeof rentalPostingPolicySchema>;
export const rentalPostingPolicyListSchema = z.object({ items: z.array(rentalPostingPolicySchema) }).strict();

/* ── Property-manager settlements ─────────────────────────────────────── */

export const PM_SETTLEMENT_STATES = ["draft", "reconciled", "exception"] as const;
export const pmSettlementStateSchema = z.enum(PM_SETTLEMENT_STATES);
export const PM_SETTLEMENT_LINE_KINDS = ["rent_receipt", "subsidy_receipt", "deposit_receipt", "other_receipt", "pm_fee", "pm_expense", "other_deduction", "owner_remittance"] as const;
export type PmSettlementLineKind = (typeof PM_SETTLEMENT_LINE_KINDS)[number];
export const pmSettlementLineKindSchema = z.enum(PM_SETTLEMENT_LINE_KINDS);
export const PM_COLLECTION_KINDS: readonly PmSettlementLineKind[] = ["rent_receipt", "subsidy_receipt", "deposit_receipt", "other_receipt"];

const nonNegativeCentsSchema = centsSchema.refine(value => !value.startsWith("-"), "Amount cannot be negative");

export const pmSettlementLineInputSchema = z.object({
  kind: pmSettlementLineKindSchema,
  tenancyId: z.string().min(1).max(160).nullable().optional(),
  unitId: z.string().min(1).max(160).nullable().optional(),
  description: z.string().trim().min(1).max(500),
  amountCents: nonNegativeCentsSchema,
  occurredOn: isoDateSchema.nullable().optional(),
  sourcePage: z.number().int().min(1).max(100_000).nullable().optional(),
}).strict();
export type PmSettlementLineInput = z.input<typeof pmSettlementLineInputSchema>;

export const qboReferenceSchema = z.object({
  objectType: z.string().regex(/^[A-Z][A-Za-z0-9_]{0,119}$/),
  objectId: z.string().min(1).max(200),
  lineId: z.string().min(1).max(200).nullable().optional(),
}).strict();

const settlementContentShape = {
  managerName: z.string().trim().min(1).max(200),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  currency: currencyCodeSchema,
  openingHeldCents: centsSchema,
  grossCollectionsCents: nonNegativeCentsSchema,
  pmFeesCents: nonNegativeCentsSchema,
  pmExpensesCents: nonNegativeCentsSchema,
  otherDeductionsCents: nonNegativeCentsSchema.default("0"),
  ownerRemittanceCents: nonNegativeCentsSchema,
  closingHeldCents: centsSchema,
  statementDocumentId: documentReferenceIdSchema.nullable().optional(),
  intakePacketId: canonicalUuidSchema.nullable().optional(),
  qboReferences: z.array(qboReferenceSchema).max(200).default([]),
  lines: z.array(pmSettlementLineInputSchema).min(1).max(2_000),
};

function periodOrder(value: { periodStart: string; periodEnd: string }, context: z.RefinementCtx) {
  if (value.periodEnd < value.periodStart) context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodEnd"], message: "The period end cannot be before its start" });
}

export const createPmSettlementPayloadSchema = z.object({ propertyId: propertyReferenceIdSchema, ...settlementContentShape }).strict().superRefine(periodOrder);
export const updatePmSettlementPayloadSchema = z.object({ settlementId: canonicalUuidSchema, ...settlementContentShape }).strict().superRefine(periodOrder);
export const reconcilePmSettlementPayloadSchema = z.object({
  settlementId: canonicalUuidSchema,
  bankObservationReference: z.string().trim().min(1).max(500).nullable().optional(),
  bankSettledOn: isoDateSchema.nullable().optional(),
}).strict();
export const markPmSettlementExceptionPayloadSchema = z.object({ settlementId: canonicalUuidSchema, reason: z.string().trim().min(1).max(1000) }).strict();
export const clearPmSettlementExceptionPayloadSchema = z.object({ settlementId: canonicalUuidSchema }).strict();

export const PM_SETTLEMENT_COMMAND_KINDS = [
  "accounting.pm_settlement.create",
  "accounting.pm_settlement.update",
  "accounting.pm_settlement.reconcile",
  "accounting.pm_settlement.exception.mark",
  "accounting.pm_settlement.exception.clear",
] as const;
export type PmSettlementCommandKind = (typeof PM_SETTLEMENT_COMMAND_KINDS)[number];
export const PM_SETTLEMENT_REVISIONED_COMMANDS: readonly PmSettlementCommandKind[] = PM_SETTLEMENT_COMMAND_KINDS.filter(kind => kind !== "accounting.pm_settlement.create");
export const pmSettlementCommandPayloadSchemas = {
  "accounting.pm_settlement.create": createPmSettlementPayloadSchema,
  "accounting.pm_settlement.update": updatePmSettlementPayloadSchema,
  "accounting.pm_settlement.reconcile": reconcilePmSettlementPayloadSchema,
  "accounting.pm_settlement.exception.mark": markPmSettlementExceptionPayloadSchema,
  "accounting.pm_settlement.exception.clear": clearPmSettlementExceptionPayloadSchema,
} as const satisfies Record<PmSettlementCommandKind, z.ZodTypeAny>;

export const ACCOUNTING_OPERATION_MCP_TOOL_NAMES: Readonly<Record<RentalPostingCommandKind | PmSettlementCommandKind, string>> = {
  "accounting.rental_posting_policy.set": "set_rental_posting_policy",
  "accounting.rental_posting_policy.close": "close_rental_posting_policy",
  "accounting.pm_settlement.create": "create_pm_settlement",
  "accounting.pm_settlement.update": "update_pm_settlement",
  "accounting.pm_settlement.reconcile": "reconcile_pm_settlement",
  "accounting.pm_settlement.exception.mark": "mark_pm_settlement_exception",
  "accounting.pm_settlement.exception.clear": "clear_pm_settlement_exception",
};

export const pmGrossToNetSchema = z.object({
  collections: z.object({ rentCents: centsSchema, subsidyCents: centsSchema, depositCents: centsSchema, otherCents: centsSchema, totalCents: centsSchema }).strict(),
  /** Rent, subsidy and other receipts. Deposits are held liabilities, not collections income. */
  operatingCollectionsCents: centsSchema,
  costs: z.object({ feesCents: centsSchema, expensesCents: centsSchema, otherDeductionsCents: centsSchema, totalCents: centsSchema }).strict(),
  remittedCents: centsSchema,
  openingHeldCents: centsSchema,
  closingHeldCents: centsSchema,
  heldChangeCents: centsSchema,
}).strict();
export type PmGrossToNet = z.infer<typeof pmGrossToNetSchema>;

export const pmSettlementDifferenceSchema = z.object({
  code: z.string(),
  label: z.string(),
  amountCents: centsSchema.nullable(),
}).strict();

export const pmSettlementSummarySchema = z.object({
  id: canonicalUuidSchema,
  legalEntityId: legalEntityIdSchema,
  propertyId: z.string(),
  propertyName: z.string().nullable(),
  managerName: z.string(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  currency: currencyCodeSchema,
  state: pmSettlementStateSchema,
  exceptionReason: z.string().nullable(),
  grossCollectionsCents: centsSchema,
  pmCostsCents: centsSchema,
  ownerRemittanceCents: centsSchema,
  closingHeldCents: centsSchema,
  bankSettledOn: isoDateSchema.nullable(),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type PmSettlementSummary = z.infer<typeof pmSettlementSummarySchema>;

export const pmSettlementLineSchema = z.object({
  lineNumber: z.number().int().min(1),
  kind: pmSettlementLineKindSchema,
  tenancyId: z.string().nullable(),
  unitId: z.string().nullable(),
  description: z.string(),
  amountCents: centsSchema,
  occurredOn: isoDateSchema.nullable(),
  sourcePage: z.number().int().nullable(),
}).strict();

export const pmSettlementDetailSchema = pmSettlementSummarySchema.extend({
  openingHeldCents: centsSchema,
  pmFeesCents: centsSchema,
  pmExpensesCents: centsSchema,
  otherDeductionsCents: centsSchema,
  statementDocumentId: z.string().nullable(),
  intakePacketId: z.string().nullable(),
  bankObservationReference: z.string().nullable(),
  qboReferences: z.array(qboReferenceSchema),
  sourceFingerprint: z.string(),
  lines: z.array(pmSettlementLineSchema),
  grossToNet: pmGrossToNetSchema,
  differences: z.array(pmSettlementDifferenceSchema),
}).strict();
export type PmSettlementDetail = z.infer<typeof pmSettlementDetailSchema>;

export const pmSettlementListQuerySchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  states: z.array(pmSettlementStateSchema).min(1).max(3).optional(),
  periodFrom: isoDateSchema.optional(),
  periodThrough: isoDateSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: cursorSchema.optional(),
}).strict();
export type PmSettlementListQuery = z.input<typeof pmSettlementListQuerySchema>;
export const pmSettlementListResponseSchema = z.object({ items: z.array(pmSettlementSummarySchema), nextCursor: z.string().nullable() }).strict();
export type PmSettlementListResponse = z.infer<typeof pmSettlementListResponseSchema>;

/* ── Rental summary bridge preview ────────────────────────────────────── */

export const bridgeControlTotalsSchema = z.object({
  chargesCents: centsSchema,
  chargeCount: z.number().int().min(0),
  creditsCents: centsSchema,
  receipts: z.object({ tenantCents: centsSchema, subsidyCents: centsSchema, otherCents: centsSchema, totalCents: centsSchema, count: z.number().int().min(0) }).strict(),
  depositReceiptsCents: centsSchema,
  depositsReceivedCents: centsSchema,
  depositsHeldAtEndCents: centsSchema,
  reversalsCents: centsSchema,
  adjustments: z.object({ debitCents: centsSchema, creditCents: centsSchema }).strict(),
  /** Charges − credits − non-deposit receipts ± adjustments, each net of its reversals, for the period (deposit categories excluded). */
  netReceivableChangeCents: centsSchema,
  excludedVoidedCount: z.number().int().min(0),
  excludedPendingCount: z.number().int().min(0),
  /** Ledger rows whose amount, status or category is unknown; never counted as zero. */
  excludedUnknownCount: z.number().int().min(0),
}).strict();
export type BridgeControlTotals = z.infer<typeof bridgeControlTotalsSchema>;

export const BRIDGE_PREVIEW_STATUSES = ["ready", "incomplete_source", "no_policy", "method_conflict", "mixed_policy"] as const;
export const rentalBridgePreviewSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  currency: currencyCodeSchema,
  postingMethod: rentalPostingMethodSchema.nullable(),
  status: z.enum(BRIDGE_PREVIEW_STATUSES),
  reason: z.string().nullable(),
  controlTotals: bridgeControlTotalsSchema,
  byProperty: z.array(z.object({ propertyId: z.string(), propertyName: z.string().nullable(), controlTotals: bridgeControlTotalsSchema }).strict()),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: isoTimestampSchema,
}).strict();
export type RentalBridgePreview = z.infer<typeof rentalBridgePreviewSchema>;
export const rentalBridgePreviewQuerySchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
}).strict().superRefine(periodOrder);

/* ── Period close checklist (read-only) ───────────────────────────────── */

export const CLOSE_CHECK_STATES = ["complete", "attention", "blocked", "not_applicable"] as const;
export const periodCloseChecklistSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  items: z.array(z.object({
    code: z.enum(["posting_policy", "sync_complete", "exceptions_resolved", "pm_settlements_reconciled", "deletions_reviewed"]),
    label: z.string(),
    state: z.enum(CLOSE_CHECK_STATES),
    detail: z.string(),
  }).strict()),
  completeCount: z.number().int().min(0),
  generatedAt: isoTimestampSchema,
}).strict();
export type PeriodCloseChecklist = z.infer<typeof periodCloseChecklistSchema>;

/* ── Bills & payments (read-only mirror view) ─────────────────────────── */

export const PAYABLE_KINDS = ["bills", "payments"] as const;
export const payableKindSchema = z.enum(PAYABLE_KINDS);
export const accountingPayableSchema = z.object({
  objectType: z.enum(["Bill", "BillPayment"]),
  objectId: z.string(),
  version: z.string(),
  docNumber: z.string().nullable(),
  vendorName: z.string().nullable(),
  transactionDate: isoDateSchema,
  dueDate: isoDateSchema.nullable(),
  currency: currencyCodeSchema,
  /** Sum of current mirrored lines; null when the object could not be mirrored. */
  amountCents: centsSchema.nullable(),
  /** Provider open balance for bills; null when not stated. */
  openBalanceCents: centsSchema.nullable(),
  postingState: z.enum(["posted", "voided", "unknown"]),
  mirrored: z.boolean(),
}).strict();
export type AccountingPayable = z.infer<typeof accountingPayableSchema>;
export const accountingPayablesQuerySchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: qboEnvironmentSchema,
  realmId: realmIdSchema,
  kind: payableKindSchema.default("bills"),
  from: isoDateSchema.optional(),
  through: isoDateSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: cursorSchema.optional(),
}).strict();
export type AccountingPayablesQuery = z.input<typeof accountingPayablesQuerySchema>;
export const accountingPayablesResponseSchema = z.object({
  items: z.array(accountingPayableSchema),
  nextCursor: z.string().nullable(),
  coverage: z.object({ status: z.enum(["unavailable", "partial", "complete"]), reason: z.string().nullable() }).strict(),
}).strict();
export type AccountingPayablesResponse = z.infer<typeof accountingPayablesResponseSchema>;

/* ── QuickBooks sync request (queues a worker job) ────────────────────── */

export const QBO_SYNC_REQUEST_COMMAND_KIND = "accounting.qbo.sync.request" as const;
export const requestQboSyncPayloadSchema = z.object({
  environment: qboEnvironmentSchema,
  realmId: realmIdSchema,
  forceFullReplay: z.boolean().default(false),
}).strict();

/* ── QuickBooks write submission (queues a reconciled worker write) ──── */

/**
 * Owner/admin only. Validated against the server's enabled write types and
 * the entity's rental posting policy, then queued for the worker, which
 * journals, posts and confirms by readback. Queued is not posted.
 */
export const QBO_WRITE_SUBMIT_COMMAND_KIND = "accounting.qbo_write.submit" as const;
export const QBO_WRITE_OPERATIONS = ["create", "update", "void", "delete"] as const;
export const submitQboWritePayloadSchema = z.object({
  environment: qboEnvironmentSchema,
  realmId: realmIdSchema,
  entity: z.string().regex(/^[A-Z][A-Za-z0-9_]{0,119}$/, "QuickBooks entity name, e.g. Vendor"),
  operation: z.enum(QBO_WRITE_OPERATIONS),
  fields: z.record(z.string(), z.unknown()),
  entityId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/).optional(),
  syncToken: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/).optional(),
  rentalPosting: z.object({ activityDate: isoDateSchema, method: z.enum(["native_receivables", "summary_bridge"]) }).strict().optional(),
}).strict();
export type SubmitQboWritePayload = z.infer<typeof submitQboWritePayloadSchema>;

export const ACCOUNTING_OPERATION_COMMAND_KINDS = [...RENTAL_POSTING_COMMAND_KINDS, ...PM_SETTLEMENT_COMMAND_KINDS, QBO_SYNC_REQUEST_COMMAND_KIND, QBO_WRITE_SUBMIT_COMMAND_KIND] as const;
export type AccountingOperationCommandKind = (typeof ACCOUNTING_OPERATION_COMMAND_KINDS)[number];
export const accountingOperationCommandPayloadSchemas = {
  ...rentalPostingCommandPayloadSchemas,
  ...pmSettlementCommandPayloadSchemas,
  [QBO_SYNC_REQUEST_COMMAND_KIND]: requestQboSyncPayloadSchema,
  [QBO_WRITE_SUBMIT_COMMAND_KIND]: submitQboWritePayloadSchema,
} as const satisfies Record<AccountingOperationCommandKind, z.ZodTypeAny>;
