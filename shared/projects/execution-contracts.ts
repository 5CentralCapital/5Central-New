import { z } from "zod";
import {
  centsFromBigInt,
  centsSchema,
  centsToBigInt,
  companyScopeSchema,
  currencyCodeSchema,
  decimalSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  recordReferenceIdSchema,
  type CompanyScope,
  type CurrencyCode,
  type DecimalString,
  type IsoDate,
  type IsoTimestamp,
  type LegalEntityId,
  type MoneyCents,
  type RecordReferenceId,
} from "../company";
import { projectIdSchema, type ProjectId } from "./contracts";
import { financialSourceReferenceSchema, type FinancialSourceReference } from "../accounting/source";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type ProjectTemplateId = Brand<string, "ProjectTemplateId">;
export type ProjectTemplateScopeItemId = Brand<string, "ProjectTemplateScopeItemId">;
export type ProjectTemplateTaskId = Brand<string, "ProjectTemplateTaskId">;
export type ProjectAssignmentId = Brand<string, "ProjectAssignmentId">;
export type ProjectMilestoneId = Brand<string, "ProjectMilestoneId">;
export type ProjectInspectionId = Brand<string, "ProjectInspectionId">;
export type ProjectPunchItemId = Brand<string, "ProjectPunchItemId">;
export type ProjectVendorId = Brand<string, "ProjectVendorId">;
export type ProjectBidId = Brand<string, "ProjectBidId">;
export type ProjectCommitmentId = Brand<string, "ProjectCommitmentId">;
export type ProjectChangeOrderId = Brand<string, "ProjectChangeOrderId">;
export type ProjectPurchaseOrderId = Brand<string, "ProjectPurchaseOrderId">;
export type ProjectDrawRequestId = Brand<string, "ProjectDrawRequestId">;
export type ProjectDrawRequestItemId = Brand<string, "ProjectDrawRequestItemId">;
export type ProjectFinanceBindingId = Brand<string, "ProjectFinanceBindingId">;

const id = <T extends string>(name: T) => (value: string): Brand<string, T> => value as Brand<string, T>;
const canonicalId = <T extends string>(name: T) => z.string().uuid().transform(id(name));

export const projectTemplateIdSchema = canonicalId("ProjectTemplateId");
export const projectTemplateScopeItemIdSchema = canonicalId("ProjectTemplateScopeItemId");
export const projectTemplateTaskIdSchema = canonicalId("ProjectTemplateTaskId");
export const projectAssignmentIdSchema = canonicalId("ProjectAssignmentId");
export const projectMilestoneIdSchema = canonicalId("ProjectMilestoneId");
export const projectInspectionIdSchema = canonicalId("ProjectInspectionId");
export const projectPunchItemIdSchema = canonicalId("ProjectPunchItemId");
export const projectVendorIdSchema = canonicalId("ProjectVendorId");
export const projectBidIdSchema = canonicalId("ProjectBidId");
export const projectCommitmentIdSchema = canonicalId("ProjectCommitmentId");
export const projectChangeOrderIdSchema = canonicalId("ProjectChangeOrderId");
export const projectPurchaseOrderIdSchema = canonicalId("ProjectPurchaseOrderId");
export const projectDrawRequestIdSchema = canonicalId("ProjectDrawRequestId");
export const projectDrawRequestItemIdSchema = canonicalId("ProjectDrawRequestItemId");
export const projectFinanceBindingIdSchema = canonicalId("ProjectFinanceBindingId");

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const nullableDate = isoDateSchema.nullable();
const nonNegativeCents = centsSchema.refine((value) => centsToBigInt(value) >= BigInt(0), "Expected non-negative cents");
const signedCents = centsSchema;
const executionQuantity = decimalSchema
  .refine((value) => !value.startsWith("-"), "Quantity cannot be negative")
  .refine((value) => value.replace(/^-/, "").split(".")[0]!.length <= 12, "Quantity supports at most 12 integer digits")
  .refine((value) => !value.includes(".") || value.split(".")[1]!.length <= 12, "Quantity supports at most 12 decimal places")
  .transform((value) => value as DecimalString);
const percent = decimalSchema
  .refine((value) => centsToBigInt("0") === BigInt(0) && !value.startsWith("-"), "Percentage cannot be negative")
  .refine((value) => Number(value) <= 100, "Percentage cannot exceed 100")
  .transform((value) => value as DecimalString);

export const PROJECT_ASSIGNMENT_TYPES = ["employee", "vendor", "person", "team"] as const;
export type ProjectAssignmentType = (typeof PROJECT_ASSIGNMENT_TYPES)[number];
export const projectAssignmentTypeSchema = z.enum(PROJECT_ASSIGNMENT_TYPES);
export const projectAssigneeOptionSchema = z.object({
  id: z.string().uuid(),
  label: text(200),
  type: projectAssignmentTypeSchema,
}).strict();
export type ProjectAssigneeOption = z.infer<typeof projectAssigneeOptionSchema>;
export const PROJECT_ASSIGNMENT_STATUSES = ["assigned", "accepted", "in_progress", "complete", "declined", "cancelled"] as const;
export type ProjectAssignmentStatus = (typeof PROJECT_ASSIGNMENT_STATUSES)[number];
export const projectAssignmentStatusSchema = z.enum(PROJECT_ASSIGNMENT_STATUSES);
export const PROJECT_MILESTONE_STATUSES = ["planned", "in_progress", "complete", "blocked", "cancelled"] as const;
export type ProjectMilestoneStatus = (typeof PROJECT_MILESTONE_STATUSES)[number];
export const projectMilestoneStatusSchema = z.enum(PROJECT_MILESTONE_STATUSES);
export const PROJECT_INSPECTION_STATUSES = ["scheduled", "passed", "failed", "conditional", "cancelled"] as const;
export type ProjectInspectionStatus = (typeof PROJECT_INSPECTION_STATUSES)[number];
export const projectInspectionStatusSchema = z.enum(PROJECT_INSPECTION_STATUSES);
export const PROJECT_PUNCH_STATUSES = ["open", "in_progress", "ready_for_review", "complete", "waived"] as const;
export type ProjectPunchStatus = (typeof PROJECT_PUNCH_STATUSES)[number];
export const projectPunchStatusSchema = z.enum(PROJECT_PUNCH_STATUSES);
export const PROJECT_VENDOR_STATUSES = ["active", "inactive", "on_hold"] as const;
export type ProjectVendorStatus = (typeof PROJECT_VENDOR_STATUSES)[number];
export const projectVendorStatusSchema = z.enum(PROJECT_VENDOR_STATUSES);
export const PROJECT_BID_STATUSES = ["draft", "submitted", "shortlisted", "accepted", "rejected", "withdrawn"] as const;
export type ProjectBidStatus = (typeof PROJECT_BID_STATUSES)[number];
export const projectBidStatusSchema = z.enum(PROJECT_BID_STATUSES);
export const PROJECT_COMMITMENT_STATUSES = ["draft", "approved", "closed", "void"] as const;
export type ProjectCommitmentStatus = (typeof PROJECT_COMMITMENT_STATUSES)[number];
export const projectCommitmentStatusSchema = z.enum(PROJECT_COMMITMENT_STATUSES);
export const PROJECT_CHANGE_ORDER_STATUSES = ["draft", "submitted", "approved", "rejected", "void"] as const;
export type ProjectChangeOrderStatus = (typeof PROJECT_CHANGE_ORDER_STATUSES)[number];
export const projectChangeOrderStatusSchema = z.enum(PROJECT_CHANGE_ORDER_STATUSES);
export const PROJECT_PURCHASE_ORDER_STATUSES = ["draft", "issued", "partially_received", "received", "cancelled"] as const;
export type ProjectPurchaseOrderStatus = (typeof PROJECT_PURCHASE_ORDER_STATUSES)[number];
export const projectPurchaseOrderStatusSchema = z.enum(PROJECT_PURCHASE_ORDER_STATUSES);
export const PROJECT_DRAW_STATUSES = ["draft", "submitted", "approved", "paid", "rejected", "void"] as const;
export type ProjectDrawStatus = (typeof PROJECT_DRAW_STATUSES)[number];
export const projectDrawStatusSchema = z.enum(PROJECT_DRAW_STATUSES);
export const PROJECT_DRAW_ITEM_TYPES = ["commitment", "actual", "change_order"] as const;
export type ProjectDrawItemType = (typeof PROJECT_DRAW_ITEM_TYPES)[number];
export const projectDrawItemTypeSchema = z.enum(PROJECT_DRAW_ITEM_TYPES);
export const PROJECT_FINANCE_COVERAGE = ["unavailable", "partial", "complete"] as const;
export type ProjectFinanceCoverage = (typeof PROJECT_FINANCE_COVERAGE)[number];
export const projectFinanceCoverageSchema = z.enum(PROJECT_FINANCE_COVERAGE);

export const projectTemplateScopeItemSchema = z.object({
  id: projectTemplateScopeItemIdSchema,
  templateId: projectTemplateIdSchema,
  description: text(300),
  category: optionalText(120),
  unitLabel: optionalText(80),
  quantity: executionQuantity,
  rateCents: nonNegativeCents,
  position: z.number().int().nonnegative(),
}).strict();
export type ProjectTemplateScopeItem = z.infer<typeof projectTemplateScopeItemSchema>;

export const projectTemplateTaskSchema = z.object({
  id: projectTemplateTaskIdSchema,
  templateId: projectTemplateIdSchema,
  title: text(200),
  description: optionalText(4_000),
  relativeDays: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
}).strict();
export type ProjectTemplateTask = z.infer<typeof projectTemplateTaskSchema>;

export const projectTemplateSchema = z.object({
  id: projectTemplateIdSchema,
  organizationId: text(160),
  name: text(200),
  projectType: text(80),
  description: z.string().trim().max(4_000).nullable(),
  currency: currencyCodeSchema.nullable(),
  active: z.boolean(),
  createdBy: text(160),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  scopeItems: z.array(projectTemplateScopeItemSchema).max(10_000),
  tasks: z.array(projectTemplateTaskSchema).max(10_000),
}).strict();
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>;

export const projectAssignmentSchema = z.object({
  id: projectAssignmentIdSchema,
  projectId: projectIdSchema,
  assigneeType: projectAssignmentTypeSchema,
  assigneeRef: recordReferenceIdSchema,
  role: text(120),
  status: projectAssignmentStatusSchema,
  startsOn: nullableDate.optional(),
  dueOn: nullableDate.optional(),
  notes: z.string().trim().max(2_000).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectAssignment = z.infer<typeof projectAssignmentSchema>;

export const projectMilestoneSchema = z.object({
  id: projectMilestoneIdSchema,
  projectId: projectIdSchema,
  name: text(200),
  description: z.string().trim().max(2_000).nullable(),
  status: projectMilestoneStatusSchema,
  targetOn: nullableDate.optional(),
  completedOn: nullableDate.optional(),
  position: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectMilestone = z.infer<typeof projectMilestoneSchema>;

export const projectInspectionSchema = z.object({
  id: projectInspectionIdSchema,
  projectId: projectIdSchema,
  inspectionType: text(120),
  status: projectInspectionStatusSchema,
  scheduledOn: nullableDate.optional(),
  inspectedOn: nullableDate.optional(),
  inspectorRef: recordReferenceIdSchema.nullable(),
  notes: z.string().trim().max(4_000).nullable(),
  documentRef: recordReferenceIdSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectInspection = z.infer<typeof projectInspectionSchema>;

export const projectPunchItemSchema = z.object({
  id: projectPunchItemIdSchema,
  projectId: projectIdSchema,
  inspectionId: projectInspectionIdSchema.nullable(),
  description: text(500),
  location: optionalText(200),
  status: projectPunchStatusSchema,
  assignedTo: recordReferenceIdSchema.nullable(),
  dueOn: nullableDate,
  completedOn: nullableDate,
  notes: z.string().trim().max(2_000).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectPunchItem = z.infer<typeof projectPunchItemSchema>;

export const projectVendorSchema = z.object({
  id: projectVendorIdSchema,
  organizationId: text(160),
  name: text(200),
  status: projectVendorStatusSchema,
  contactRef: recordReferenceIdSchema.nullable(),
  licenseRef: z.string().trim().max(200).nullable(),
  insuranceExpiresOn: nullableDate.optional(),
  notes: z.string().trim().max(2_000).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectVendor = z.infer<typeof projectVendorSchema>;

export const projectBidSchema = z.object({
  id: projectBidIdSchema,
  projectId: projectIdSchema,
  vendorId: projectVendorIdSchema,
  scopeItemId: z.string().uuid().nullable(),
  status: projectBidStatusSchema,
  amountCents: nonNegativeCents,
  currency: currencyCodeSchema,
  submittedOn: nullableDate.optional(),
  validUntil: nullableDate.optional(),
  notes: z.string().trim().max(2_000).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectBid = z.infer<typeof projectBidSchema>;

export const projectCommitmentSchema = z.object({
  id: projectCommitmentIdSchema,
  projectId: projectIdSchema,
  vendorId: projectVendorIdSchema.nullable(),
  bidId: projectBidIdSchema.nullable(),
  description: text(300),
  status: projectCommitmentStatusSchema,
  originalCents: nonNegativeCents,
  approvedChangeCents: signedCents,
  committedCents: signedCents,
  currency: currencyCodeSchema,
  startOn: nullableDate.optional(),
  targetOn: nullableDate.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectCommitment = z.infer<typeof projectCommitmentSchema>;

export const projectChangeOrderSchema = z.object({
  id: projectChangeOrderIdSchema,
  projectId: projectIdSchema,
  commitmentId: projectCommitmentIdSchema.nullable(),
  description: text(300),
  reason: text(500),
  status: projectChangeOrderStatusSchema,
  amountCents: signedCents,
  currency: currencyCodeSchema,
  includedInBudgetVersionId: z.string().uuid().nullable(),
  submittedOn: nullableDate.optional(),
  approvedOn: nullableDate.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectChangeOrder = z.infer<typeof projectChangeOrderSchema>;

export const projectPurchaseOrderSchema = z.object({
  id: projectPurchaseOrderIdSchema,
  projectId: projectIdSchema,
  commitmentId: projectCommitmentIdSchema,
  poNumber: text(80),
  status: projectPurchaseOrderStatusSchema,
  amountCents: nonNegativeCents,
  currency: currencyCodeSchema,
  issuedOn: nullableDate.optional(),
  receivedOn: nullableDate.optional(),
  notes: z.string().trim().max(2_000).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ProjectPurchaseOrder = z.infer<typeof projectPurchaseOrderSchema>;

export const projectDrawRequestItemSchema = z.object({
  id: projectDrawRequestItemIdSchema,
  drawRequestId: projectDrawRequestIdSchema,
  sourceType: projectDrawItemTypeSchema,
  sourceId: recordReferenceIdSchema,
  eligibleCents: nonNegativeCents,
  requestedCents: nonNegativeCents,
  retainageEligible: z.boolean(),
  retainageCents: nonNegativeCents,
  notes: z.string().trim().max(1_000).nullable(),
}).strict();
export type ProjectDrawRequestItem = z.infer<typeof projectDrawRequestItemSchema>;

export const projectDrawRequestSchema = z.object({
  id: projectDrawRequestIdSchema,
  projectId: projectIdSchema,
  requestNo: z.number().int().positive(),
  status: projectDrawStatusSchema,
  periodFrom: isoDateSchema,
  periodTo: isoDateSchema,
  grossEligibleCents: nonNegativeCents,
  retainagePercent: percent,
  retainageCents: nonNegativeCents,
  netRequestedCents: nonNegativeCents,
  currency: currencyCodeSchema,
  submittedOn: nullableDate,
  approvedOn: nullableDate,
  paidOn: nullableDate,
  notes: z.string().trim().max(2_000).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  items: z.array(projectDrawRequestItemSchema).max(10_000),
}).strict();
export type ProjectDrawRequest = z.infer<typeof projectDrawRequestSchema>;

/**
 * QBO actuals are supplied by the verified central finance read port. The
 * project module never manufactures an actual from a bid, PO, draft cost or
 * draw request. A commitment link is optional and is used only to subtract
 * already-billed value from the outstanding commitment balance.
 */
export const projectFinanceActualSchema = z.object({
  id: projectFinanceBindingIdSchema,
  projectId: projectIdSchema,
  commitmentId: projectCommitmentIdSchema.nullable(),
  scopeItemId: z.string().uuid().nullable(),
  source: financialSourceReferenceSchema,
  description: text(300),
  amountCents: centsSchema,
  currency: currencyCodeSchema,
  postedOn: isoDateSchema,
  sourceRevision: text(160).nullable(),
}).strict();
export type ProjectFinanceActual = z.infer<typeof projectFinanceActualSchema>;

export const projectExecutionTotalsSchema = z.object({
  currency: currencyCodeSchema,
  originalBudgetCents: signedCents,
  revisedBudgetCents: signedCents,
  commitmentCents: signedCents,
  linkedActualCents: signedCents.nullable(),
  actualCents: signedCents.nullable(),
  unspentCommitmentCents: signedCents.nullable(),
  remainingCents: signedCents.nullable(),
  actualCoverage: projectFinanceCoverageSchema,
}).strict();
export type ProjectExecutionTotals = z.infer<typeof projectExecutionTotalsSchema>;

export interface ProjectFinanceReadPort {
  readonly getProjectActuals: (input: { organizationId: string; legalEntityId: LegalEntityId; projectId: ProjectId; asOf?: IsoDate }) => Promise<{
    readonly coverage: ProjectFinanceCoverage;
    readonly actuals: readonly ProjectFinanceActual[];
  }>;
}

export interface ProjectFinanceBinding {
  readonly id: ProjectFinanceBindingId;
  readonly projectId: ProjectId;
  readonly commitmentId: ProjectCommitmentId | null;
  readonly scopeItemId: string | null;
  readonly source: FinancialSourceReference;
  readonly allocatedCents: MoneyCents;
  readonly eligible: boolean;
}

export const projectFinanceBindingSchema = z.object({
  id: projectFinanceBindingIdSchema,
  projectId: projectIdSchema,
  commitmentId: projectCommitmentIdSchema.nullable(),
  scopeItemId: z.string().uuid().nullable(),
  source: financialSourceReferenceSchema,
  allocatedCents: nonNegativeCents,
  eligible: z.boolean(),
  bindingStatus: z.enum(["unverified", "verified", "unlinked", "released"]),
}).strict();
export type ProjectFinanceBindingRecord = z.infer<typeof projectFinanceBindingSchema>;

export const unavailableProjectFinanceReadPort: ProjectFinanceReadPort = Object.freeze({
  async getProjectActuals() { return { coverage: "unavailable" as const, actuals: [] as readonly ProjectFinanceActual[] }; },
});

export const projectExecutionScopeSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  propertyId: propertyReferenceIdSchema.optional(),
  projectId: projectIdSchema,
}).strict();
export type ProjectExecutionScope = z.infer<typeof projectExecutionScopeSchema>;

export const projectExecutionReadQuerySchema = z.object({
  scope: projectExecutionScopeSchema,
  asOf: isoDateSchema.optional(),
}).strict();
export type ProjectExecutionReadQuery = z.infer<typeof projectExecutionReadQuerySchema>;

export const projectTemplateCreatePayloadSchema = z.object({
  name: text(200),
  projectType: text(80),
  description: optionalText(4_000),
  currency: currencyCodeSchema.nullable().optional(),
}).strict();
export type ProjectTemplateCreatePayload = z.infer<typeof projectTemplateCreatePayloadSchema>;

export const projectTemplateInstantiatePayloadSchema = z.object({
  projectId: projectIdSchema,
  templateId: projectTemplateIdSchema,
  startOn: isoDateSchema.nullable().optional(),
}).strict();
export type ProjectTemplateInstantiatePayload = z.infer<typeof projectTemplateInstantiatePayloadSchema>;

export const projectAssignmentCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  assigneeType: projectAssignmentTypeSchema,
  assigneeRef: recordReferenceIdSchema,
  role: text(120),
  startsOn: nullableDate.optional(),
  dueOn: nullableDate.optional(),
  notes: optionalText(2_000),
}).strict();
export type ProjectAssignmentCreatePayload = z.infer<typeof projectAssignmentCreatePayloadSchema>;

export const projectMilestoneCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  name: text(200),
  description: optionalText(2_000),
  targetOn: nullableDate.optional(),
  position: z.number().int().nonnegative().optional(),
}).strict();
export type ProjectMilestoneCreatePayload = z.infer<typeof projectMilestoneCreatePayloadSchema>;

export const projectInspectionCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  inspectionType: text(120),
  scheduledOn: nullableDate.optional(),
  inspectorRef: recordReferenceIdSchema.nullable().optional(),
  notes: optionalText(4_000),
}).strict();
export type ProjectInspectionCreatePayload = z.infer<typeof projectInspectionCreatePayloadSchema>;

export const projectPunchItemCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  inspectionId: projectInspectionIdSchema.nullable().optional(),
  description: text(500),
  location: optionalText(200),
  assignedTo: recordReferenceIdSchema.nullable().optional(),
  dueOn: nullableDate.optional(),
  notes: optionalText(2_000),
}).strict();
export type ProjectPunchItemCreatePayload = z.infer<typeof projectPunchItemCreatePayloadSchema>;

export const projectVendorCreatePayloadSchema = z.object({
  name: text(200),
  contactRef: recordReferenceIdSchema.nullable().optional(),
  licenseRef: z.string().trim().max(200).nullable().optional(),
  insuranceExpiresOn: nullableDate.optional(),
  notes: optionalText(2_000),
}).strict();
export type ProjectVendorCreatePayload = z.infer<typeof projectVendorCreatePayloadSchema>;

export const projectBidCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  vendorId: projectVendorIdSchema,
  scopeItemId: z.string().uuid().nullable().optional(),
  amountCents: nonNegativeCents,
  submittedOn: nullableDate.optional(),
  validUntil: nullableDate.optional(),
  notes: optionalText(2_000),
}).strict();
export type ProjectBidCreatePayload = z.infer<typeof projectBidCreatePayloadSchema>;

export const projectCommitmentCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  vendorId: projectVendorIdSchema.nullable().optional(),
  bidId: projectBidIdSchema.nullable().optional(),
  description: text(300),
  originalCents: nonNegativeCents,
  currency: currencyCodeSchema,
  startOn: nullableDate.optional(),
  targetOn: nullableDate.optional(),
}).strict();
export type ProjectCommitmentCreatePayload = z.infer<typeof projectCommitmentCreatePayloadSchema>;

export const projectChangeOrderCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  commitmentId: projectCommitmentIdSchema.nullable().optional(),
  description: text(300),
  reason: text(500),
  amountCents: signedCents,
  currency: currencyCodeSchema,
}).strict();
export type ProjectChangeOrderCreatePayload = z.infer<typeof projectChangeOrderCreatePayloadSchema>;

export const projectPurchaseOrderCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  commitmentId: projectCommitmentIdSchema,
  poNumber: text(80),
  amountCents: nonNegativeCents,
  currency: currencyCodeSchema,
  issuedOn: nullableDate.optional(),
  notes: optionalText(2_000),
}).strict();
export type ProjectPurchaseOrderCreatePayload = z.infer<typeof projectPurchaseOrderCreatePayloadSchema>;

export const projectDrawRequestCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  periodFrom: isoDateSchema,
  periodTo: isoDateSchema,
  retainagePercent: percent,
  currency: currencyCodeSchema,
  notes: optionalText(2_000),
}).strict().superRefine((value, context) => {
  if (value.periodTo < value.periodFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodTo"], message: "periodTo must be on or after periodFrom" });
});
export type ProjectDrawRequestCreatePayload = z.infer<typeof projectDrawRequestCreatePayloadSchema>;

function requireExecutionUpdateField(value: Record<string, unknown>, context: z.RefinementCtx): void {
  if (Object.keys(value).length <= 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one execution field is required" });
}

const projectAssignmentUpdateFields = {
  assignmentId: projectAssignmentIdSchema,
  assigneeType: projectAssignmentTypeSchema.optional(),
  assigneeRef: recordReferenceIdSchema.optional(),
  role: text(120).optional(),
  status: projectAssignmentStatusSchema.optional(),
  startsOn: nullableDate.optional(),
  dueOn: nullableDate.optional(),
  notes: optionalText(2_000),
} as const;
export const projectAssignmentUpdatePayloadSchema = z.object(projectAssignmentUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectAssignmentUpdatePayload = z.infer<typeof projectAssignmentUpdatePayloadSchema>;

const projectMilestoneUpdateFields = {
  milestoneId: projectMilestoneIdSchema,
  name: text(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  status: projectMilestoneStatusSchema.optional(),
  targetOn: nullableDate.optional(),
  completedOn: nullableDate.optional(),
  position: z.number().int().nonnegative().optional(),
} as const;
export const projectMilestoneUpdatePayloadSchema = z.object(projectMilestoneUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectMilestoneUpdatePayload = z.infer<typeof projectMilestoneUpdatePayloadSchema>;

const projectInspectionUpdateFields = {
  inspectionId: projectInspectionIdSchema,
  inspectionType: text(120).optional(),
  status: projectInspectionStatusSchema.optional(),
  scheduledOn: nullableDate.optional(),
  inspectedOn: nullableDate.optional(),
  inspectorRef: recordReferenceIdSchema.nullable().optional(),
  notes: optionalText(4_000),
  documentRef: recordReferenceIdSchema.nullable().optional(),
} as const;
export const projectInspectionUpdatePayloadSchema = z.object(projectInspectionUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectInspectionUpdatePayload = z.infer<typeof projectInspectionUpdatePayloadSchema>;

const projectPunchItemUpdateFields = {
  punchItemId: projectPunchItemIdSchema,
  inspectionId: projectInspectionIdSchema.nullable().optional(),
  description: text(500).optional(),
  location: optionalText(200),
  status: projectPunchStatusSchema.optional(),
  assignedTo: recordReferenceIdSchema.nullable().optional(),
  dueOn: nullableDate.optional(),
  completedOn: nullableDate.optional(),
  notes: optionalText(2_000),
} as const;
export const projectPunchItemUpdatePayloadSchema = z.object(projectPunchItemUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectPunchItemUpdatePayload = z.infer<typeof projectPunchItemUpdatePayloadSchema>;

const projectVendorUpdateFields = {
  vendorId: projectVendorIdSchema,
  name: text(200).optional(),
  status: projectVendorStatusSchema.optional(),
  contactRef: recordReferenceIdSchema.nullable().optional(),
  licenseRef: z.string().trim().max(200).nullable().optional(),
  insuranceExpiresOn: nullableDate.optional(),
  notes: optionalText(2_000),
} as const;
export const projectVendorUpdatePayloadSchema = z.object(projectVendorUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectVendorUpdatePayload = z.infer<typeof projectVendorUpdatePayloadSchema>;

const projectBidUpdateFields = {
  bidId: projectBidIdSchema,
  vendorId: projectVendorIdSchema.optional(),
  scopeItemId: z.string().uuid().nullable().optional(),
  status: projectBidStatusSchema.optional(),
  amountCents: nonNegativeCents.optional(),
  submittedOn: nullableDate.optional(),
  validUntil: nullableDate.optional(),
  notes: optionalText(2_000),
} as const;
export const projectBidUpdatePayloadSchema = z.object(projectBidUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectBidUpdatePayload = z.infer<typeof projectBidUpdatePayloadSchema>;

const projectCommitmentUpdateFields = {
  commitmentId: projectCommitmentIdSchema,
  vendorId: projectVendorIdSchema.nullable().optional(),
  bidId: projectBidIdSchema.nullable().optional(),
  description: text(300).optional(),
  status: projectCommitmentStatusSchema.optional(),
  originalCents: nonNegativeCents.optional(),
  approvedChangeCents: signedCents.optional(),
  startOn: nullableDate.optional(),
  targetOn: nullableDate.optional(),
} as const;
export const projectCommitmentUpdatePayloadSchema = z.object(projectCommitmentUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectCommitmentUpdatePayload = z.infer<typeof projectCommitmentUpdatePayloadSchema>;

const projectChangeOrderUpdateFields = {
  changeOrderId: projectChangeOrderIdSchema,
  commitmentId: projectCommitmentIdSchema.nullable().optional(),
  description: text(300).optional(),
  reason: text(500).optional(),
  status: projectChangeOrderStatusSchema.optional(),
  amountCents: signedCents.optional(),
  includedInBudgetVersionId: z.string().uuid().nullable().optional(),
  submittedOn: nullableDate.optional(),
  approvedOn: nullableDate.optional(),
} as const;
export const projectChangeOrderUpdatePayloadSchema = z.object(projectChangeOrderUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectChangeOrderUpdatePayload = z.infer<typeof projectChangeOrderUpdatePayloadSchema>;

const projectPurchaseOrderUpdateFields = {
  purchaseOrderId: projectPurchaseOrderIdSchema,
  commitmentId: projectCommitmentIdSchema.optional(),
  poNumber: text(80).optional(),
  status: projectPurchaseOrderStatusSchema.optional(),
  amountCents: nonNegativeCents.optional(),
  issuedOn: nullableDate.optional(),
  receivedOn: nullableDate.optional(),
  notes: optionalText(2_000),
} as const;
export const projectPurchaseOrderUpdatePayloadSchema = z.object(projectPurchaseOrderUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectPurchaseOrderUpdatePayload = z.infer<typeof projectPurchaseOrderUpdatePayloadSchema>;

const projectDrawRequestUpdateFields = {
  drawRequestId: projectDrawRequestIdSchema,
  status: projectDrawStatusSchema.optional(),
  periodFrom: isoDateSchema.optional(),
  periodTo: isoDateSchema.optional(),
  retainagePercent: percent.optional(),
  notes: optionalText(2_000),
} as const;
export const projectDrawRequestUpdatePayloadSchema = z.object(projectDrawRequestUpdateFields).strict().superRefine(requireExecutionUpdateField).superRefine((value, context) => {
  if (value.periodFrom !== undefined && value.periodTo !== undefined && value.periodTo < value.periodFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodTo"], message: "periodTo must be on or after periodFrom" });
});
export type ProjectDrawRequestUpdatePayload = z.infer<typeof projectDrawRequestUpdatePayloadSchema>;

export const projectDrawRequestItemCreatePayloadSchema = z.object({
  drawRequestId: projectDrawRequestIdSchema,
  sourceType: projectDrawItemTypeSchema,
  sourceId: recordReferenceIdSchema,
  eligibleCents: nonNegativeCents,
  requestedCents: nonNegativeCents,
  retainageEligible: z.boolean().default(true),
  retainageCents: nonNegativeCents.default("0"),
  notes: optionalText(1_000),
}).strict().superRefine((value, context) => {
  if (centsToBigInt(value.requestedCents) > centsToBigInt(value.eligibleCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestedCents"], message: "Requested amount cannot exceed eligible amount" });
  if (centsToBigInt(value.retainageCents) > centsToBigInt(value.requestedCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["retainageCents"], message: "Retainage cannot exceed requested amount" });
  if (!value.retainageEligible && centsToBigInt(value.retainageCents) !== BigInt(0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["retainageCents"], message: "Retainage must be zero when the item is not eligible" });
});
export type ProjectDrawRequestItemCreatePayload = z.infer<typeof projectDrawRequestItemCreatePayloadSchema>;

const projectDrawRequestItemUpdateFields = {
  drawRequestItemId: projectDrawRequestItemIdSchema,
  requestedCents: nonNegativeCents.optional(),
  retainageEligible: z.boolean().optional(),
  retainageCents: nonNegativeCents.optional(),
  notes: optionalText(1_000),
} as const;
export const projectDrawRequestItemUpdatePayloadSchema = z.object(projectDrawRequestItemUpdateFields).strict().superRefine(requireExecutionUpdateField);
export type ProjectDrawRequestItemUpdatePayload = z.infer<typeof projectDrawRequestItemUpdatePayloadSchema>;

export const projectFinanceBindingCreatePayloadSchema = z.object({
  projectId: projectIdSchema,
  commitmentId: projectCommitmentIdSchema.nullable().optional(),
  scopeItemId: z.string().uuid().nullable().optional(),
  source: financialSourceReferenceSchema,
  allocatedCents: nonNegativeCents.refine((value) => centsToBigInt(value) > BigInt(0), "Allocation must be positive"),
}).strict();
export type ProjectFinanceBindingCreatePayload = z.infer<typeof projectFinanceBindingCreatePayloadSchema>;

export const projectFinanceBindingReleasePayloadSchema = z.object({
  bindingId: projectFinanceBindingIdSchema,
}).strict();
export type ProjectFinanceBindingReleasePayload = z.infer<typeof projectFinanceBindingReleasePayloadSchema>;

export const projectExecutionCommandKinds = [
  "project.template.create",
  "project.template.instantiate",
  "project.assignment.create",
  "project.milestone.create",
  "project.inspection.create",
  "project.punch_item.create",
  "project.vendor.create",
  "project.bid.create",
  "project.commitment.create",
  "project.change_order.create",
  "project.purchase_order.create",
  "project.draw_request.create",
  "project.assignment.update",
  "project.milestone.update",
  "project.inspection.update",
  "project.punch_item.update",
  "project.vendor.update",
  "project.bid.update",
  "project.commitment.update",
  "project.change_order.update",
  "project.purchase_order.update",
  "project.draw_request.update",
  "project.draw_request.item.create",
  "project.draw_request.item.update",
  "project.finance_binding.create",
  "project.finance_binding.release",
] as const;
export type ProjectExecutionCommandKind = (typeof projectExecutionCommandKinds)[number];

export const projectExecutionCommandPayloadSchemas = {
  "project.template.create": projectTemplateCreatePayloadSchema,
  "project.template.instantiate": projectTemplateInstantiatePayloadSchema,
  "project.assignment.create": projectAssignmentCreatePayloadSchema,
  "project.milestone.create": projectMilestoneCreatePayloadSchema,
  "project.inspection.create": projectInspectionCreatePayloadSchema,
  "project.punch_item.create": projectPunchItemCreatePayloadSchema,
  "project.vendor.create": projectVendorCreatePayloadSchema,
  "project.bid.create": projectBidCreatePayloadSchema,
  "project.commitment.create": projectCommitmentCreatePayloadSchema,
  "project.change_order.create": projectChangeOrderCreatePayloadSchema,
  "project.purchase_order.create": projectPurchaseOrderCreatePayloadSchema,
  "project.draw_request.create": projectDrawRequestCreatePayloadSchema,
  "project.assignment.update": projectAssignmentUpdatePayloadSchema,
  "project.milestone.update": projectMilestoneUpdatePayloadSchema,
  "project.inspection.update": projectInspectionUpdatePayloadSchema,
  "project.punch_item.update": projectPunchItemUpdatePayloadSchema,
  "project.vendor.update": projectVendorUpdatePayloadSchema,
  "project.bid.update": projectBidUpdatePayloadSchema,
  "project.commitment.update": projectCommitmentUpdatePayloadSchema,
  "project.change_order.update": projectChangeOrderUpdatePayloadSchema,
  "project.purchase_order.update": projectPurchaseOrderUpdatePayloadSchema,
  "project.draw_request.update": projectDrawRequestUpdatePayloadSchema,
  "project.draw_request.item.create": projectDrawRequestItemCreatePayloadSchema,
  "project.draw_request.item.update": projectDrawRequestItemUpdatePayloadSchema,
  "project.finance_binding.create": projectFinanceBindingCreatePayloadSchema,
  "project.finance_binding.release": projectFinanceBindingReleasePayloadSchema,
} as const;

export type ProjectExecutionCommandPayload = {
  [K in ProjectExecutionCommandKind]: z.output<(typeof projectExecutionCommandPayloadSchemas)[K]>;
};

export function parseProjectExecutionPayload<TKind extends ProjectExecutionCommandKind>(kind: TKind, input: unknown): ProjectExecutionCommandPayload[TKind] {
  return projectExecutionCommandPayloadSchemas[kind].parse(input) as ProjectExecutionCommandPayload[TKind];
}

export interface ProjectExecutionDetail {
  readonly projectId: ProjectId;
  readonly scope: CompanyScope;
  readonly totals: ProjectExecutionTotals;
  readonly templates: readonly ProjectTemplate[];
  readonly assigneeOptions: readonly ProjectAssigneeOption[];
  readonly assignments: readonly ProjectAssignment[];
  readonly milestones: readonly ProjectMilestone[];
  readonly inspections: readonly ProjectInspection[];
  readonly punchItems: readonly ProjectPunchItem[];
  readonly vendors: readonly ProjectVendor[];
  readonly bids: readonly ProjectBid[];
  readonly commitments: readonly ProjectCommitment[];
  readonly changeOrders: readonly ProjectChangeOrder[];
  readonly purchaseOrders: readonly ProjectPurchaseOrder[];
  readonly drawRequests: readonly ProjectDrawRequest[];
  readonly financeActuals: readonly ProjectFinanceActual[];
}

export const projectExecutionDetailSchema = z.object({
  projectId: projectIdSchema,
  scope: companyScopeSchema,
  totals: projectExecutionTotalsSchema,
  templates: z.array(projectTemplateSchema).max(10_000),
  assigneeOptions: z.array(projectAssigneeOptionSchema).max(10_000),
  assignments: z.array(projectAssignmentSchema).max(10_000),
  milestones: z.array(projectMilestoneSchema).max(10_000),
  inspections: z.array(projectInspectionSchema).max(10_000),
  punchItems: z.array(projectPunchItemSchema).max(10_000),
  vendors: z.array(projectVendorSchema).max(10_000),
  bids: z.array(projectBidSchema).max(10_000),
  commitments: z.array(projectCommitmentSchema).max(10_000),
  changeOrders: z.array(projectChangeOrderSchema).max(10_000),
  purchaseOrders: z.array(projectPurchaseOrderSchema).max(10_000),
  drawRequests: z.array(projectDrawRequestSchema).max(10_000),
  financeActuals: z.array(projectFinanceActualSchema).max(10_000),
}).strict();

export function executionCentsTotal(values: readonly (MoneyCents | string)[]): MoneyCents {
  let total = BigInt(0);
  for (const value of values) total += centsToBigInt(value);
  return centsFromBigInt(total);
}

export type ExecutionCurrency = CurrencyCode;
export type ExecutionRecordedAt = IsoTimestamp;
export type ExecutionRecordReference = RecordReferenceId;
