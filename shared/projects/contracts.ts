import { z } from "zod";
import {
  canonicalUuidSchema,
  centsSchema,
  centsToBigInt,
  companyScopeSchema,
  currencyCodeSchema,
  decimalSchema,
  documentReferenceIdSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  propertyReferenceIdSchema,
  recordReferenceIdSchema,
  revisionSchema,
  type CompanyScope,
  type CurrencyCode,
  type DecimalString,
  type IsoDate,
  type IsoTimestamp,
  type LegalEntityId,
  type MoneyCents,
  type OrganizationId,
  type PropertyReferenceId,
  type RecordReferenceId,
  type Revision,
} from "../company";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type ProjectId = Brand<string, "ProjectId">;
export type ScopeItemId = Brand<string, "ScopeItemId">;
export type BudgetVersionId = Brand<string, "BudgetVersionId">;
export type BudgetLineId = Brand<string, "BudgetLineId">;
export type ProjectTaskId = Brand<string, "ProjectTaskId">;
export type DraftCostId = Brand<string, "DraftCostId">;
export type PostedActualId = Brand<string, "PostedActualId">;

export const projectIdSchema = canonicalUuidSchema.transform((value) => value as ProjectId);
export const scopeItemIdSchema = canonicalUuidSchema.transform((value) => value as ScopeItemId);
export const budgetVersionIdSchema = canonicalUuidSchema.transform((value) => value as BudgetVersionId);
export const budgetLineIdSchema = canonicalUuidSchema.transform((value) => value as BudgetLineId);
export const projectTaskIdSchema = canonicalUuidSchema.transform((value) => value as ProjectTaskId);
export const draftCostIdSchema = canonicalUuidSchema.transform((value) => value as DraftCostId);
export const postedActualIdSchema = canonicalUuidSchema.transform((value) => value as PostedActualId);

export const qboProjectExternalIdSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/, "QuickBooks project ID contains unsupported characters");
export const qboRealmIdSchema = z.string().regex(/^\d{1,32}$/, "QuickBooks realm ID is invalid");
export const qboEnvironmentSchema = z.enum(["sandbox", "production"]);
export const QBO_PROJECT_RECORD_KINDS = ["Project", "Customer"] as const;
export const qboProjectRecordKindSchema = z.enum(QBO_PROJECT_RECORD_KINDS);
export type QboProjectRecordKind = (typeof QBO_PROJECT_RECORD_KINDS)[number];

export const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const projectStatusSchema = z.enum(PROJECT_STATUSES);

export const PROJECT_TYPES = ["flip", "unit_turn", "rehab", "common_area", "stabilization", "administrative"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];
export const projectTypeSchema = z.enum(PROJECT_TYPES);

export const PROJECT_TASK_STATUSES = ["not_started", "in_progress", "blocked", "completed", "cancelled"] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];
export const projectTaskStatusSchema = z.enum(PROJECT_TASK_STATUSES);

export const PROJECT_BUDGET_STATUSES = ["draft", "approved", "superseded"] as const;
export type ProjectBudgetStatus = (typeof PROJECT_BUDGET_STATUSES)[number];
export const projectBudgetStatusSchema = z.enum(PROJECT_BUDGET_STATUSES);

export const PROJECT_POSTED_ACTUAL_COVERAGE = ["unavailable", "partial", "complete"] as const;
export type ProjectPostedActualCoverage = (typeof PROJECT_POSTED_ACTUAL_COVERAGE)[number];
export const projectPostedActualCoverageSchema = z.enum(PROJECT_POSTED_ACTUAL_COVERAGE);

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const nullableDate = isoDateSchema.nullable().optional();
const nullableReference = z.union([recordReferenceIdSchema, z.string().trim().min(1).max(160)]).nullable().optional();

export const nonNegativeCentsSchema = centsSchema.refine(
  (value) => centsToBigInt(value) >= BigInt(0),
  "Expected non-negative signed BIGINT cents",
);

/** Project quantities are exact decimal text and fit migration 033 numeric(24,12). */
export const projectQuantitySchema = decimalSchema
  .refine((value) => value.replace(/^-/, "").split(".")[0]!.length <= 12, "Project quantity supports at most 12 integer digits")
  .refine((value) => !value.startsWith("-"), "Project quantity cannot be negative")
  .refine((value) => (value.includes(".") ? value.split(".")[1]!.length <= 12 : true), "Project quantity supports at most 12 decimal places")
  .transform((value) => value as DecimalString);

function assertDateRange(value: { startOn?: string | null; targetOn?: string | null }, context: z.RefinementCtx): void {
  if (value.startOn !== undefined && value.startOn !== null && value.targetOn !== undefined && value.targetOn !== null && value.targetOn < value.startOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetOn"], message: "targetOn must be on or after startOn" });
  }
}

function assertTaskDateRange(value: { startsOn?: string | null; dueOn?: string | null }, context: z.RefinementCtx): void {
  if (value.startsOn !== undefined && value.startsOn !== null && value.dueOn !== undefined && value.dueOn !== null && value.dueOn < value.startsOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dueOn"], message: "dueOn must be on or after startsOn" });
  }
}

export const projectSummarySchema = z.object({
  id: projectIdSchema,
  organizationId: z.string().min(1).max(160),
  legalEntityId: legalEntityIdSchema,
  propertyId: propertyReferenceIdSchema,
  unitId: z.string().min(1).max(160).nullable(),
  name: text(200),
  projectType: projectTypeSchema,
  description: z.string().trim().max(4_000).nullable(),
  status: projectStatusSchema,
  currency: currencyCodeSchema,
  startOn: isoDateSchema.nullable(),
  targetOn: isoDateSchema.nullable(),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
  scopeItemCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  approvedBudgetCents: nonNegativeCentsSchema.nullable(),
  draftCostCents: centsSchema,
  postedActualCents: centsSchema.nullable(),
  postedActualCoverage: projectPostedActualCoverageSchema,
}).strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

const scopeItemFields = {
  id: scopeItemIdSchema,
  projectId: projectIdSchema,
  description: text(300),
  category: z.string().trim().max(120).nullable(),
  unitLabel: z.string().trim().max(80).nullable(),
  quantity: projectQuantitySchema,
  rateCents: nonNegativeCentsSchema,
  estimatedCents: nonNegativeCentsSchema,
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
} as const;
export const projectScopeItemSchema = z.object(scopeItemFields).strict();
export type ProjectScopeItem = z.infer<typeof projectScopeItemSchema>;

export const projectBudgetLineSchema = z.object({
  id: budgetLineIdSchema,
  budgetVersionId: budgetVersionIdSchema,
  scopeItemId: scopeItemIdSchema.nullable(),
  position: z.number().int().nonnegative(),
  description: text(300),
  unitLabel: z.string().trim().max(80).nullable(),
  quantity: projectQuantitySchema,
  rateCents: nonNegativeCentsSchema,
  estimatedCents: nonNegativeCentsSchema,
}).strict();
export type ProjectBudgetLine = z.infer<typeof projectBudgetLineSchema>;

export const projectBudgetVersionSchema = z.object({
  id: budgetVersionIdSchema,
  projectId: projectIdSchema,
  versionNo: z.number().int().positive(),
  status: projectBudgetStatusSchema,
  currency: currencyCodeSchema,
  totalEstimatedCents: nonNegativeCentsSchema,
  notes: z.string().trim().max(2_000).nullable(),
  createdBy: z.string().min(1).max(160),
  approvedBy: z.string().min(1).max(160).nullable(),
  createdAt: isoTimestampSchema,
  approvedAt: isoTimestampSchema.nullable(),
  lines: z.array(projectBudgetLineSchema).max(10_000),
}).strict();
export type ProjectBudgetVersion = z.infer<typeof projectBudgetVersionSchema>;

export const projectTaskSchema = z.object({
  id: projectTaskIdSchema,
  projectId: projectIdSchema,
  title: text(200),
  description: z.string().trim().max(4_000).nullable(),
  status: projectTaskStatusSchema,
  startsOn: isoDateSchema.nullable(),
  dueOn: isoDateSchema.nullable(),
  completedOn: isoDateSchema.nullable(),
  dependencyTaskIds: z.array(projectTaskIdSchema).max(1_000),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.startsOn !== null && value.dueOn !== null && value.dueOn < value.startsOn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dueOn"], message: "dueOn must be on or after startsOn" });
  }
  if (value.status === "completed" && value.completedOn === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completedOn"], message: "Completed tasks require completedOn" });
  }
});
export type ProjectTask = z.infer<typeof projectTaskSchema>;

export const projectDraftCostSchema = z.object({
  id: draftCostIdSchema,
  projectId: projectIdSchema,
  scopeItemId: scopeItemIdSchema.nullable(),
  vendorName: z.string().trim().max(200).nullable(),
  description: text(300),
  amountCents: nonNegativeCentsSchema,
  currency: currencyCodeSchema,
  incurredOn: isoDateSchema,
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict();
export type ProjectDraftCost = z.infer<typeof projectDraftCostSchema>;

/** QBO actuals are a read-only accounting projection; no project command writes this DTO. */
export const projectPostedActualSchema = z.object({
  id: postedActualIdSchema,
  projectId: projectIdSchema,
  scopeItemId: scopeItemIdSchema.nullable(),
  provider: z.literal("qbo"),
  sourceScope: text(200),
  externalId: text(200),
  description: text(300),
  amountCents: centsSchema,
  currency: currencyCodeSchema,
  postedOn: isoDateSchema,
  createdAt: isoTimestampSchema,
}).strict();
export type ProjectPostedActual = z.infer<typeof projectPostedActualSchema>;

export const projectQboIdentitySchema = z.object({
  id: recordReferenceIdSchema,
  projectId: projectIdSchema,
  recordKind: qboProjectRecordKindSchema,
  externalId: qboProjectExternalIdSchema,
  environment: qboEnvironmentSchema,
  realmId: qboRealmIdSchema,
  linkedAt: isoTimestampSchema,
}).strict();
export type ProjectQboIdentity = z.infer<typeof projectQboIdentitySchema>;

export const projectDetailSchema = projectSummarySchema.extend({
  scopeItems: z.array(projectScopeItemSchema).max(10_000),
  budgetVersions: z.array(projectBudgetVersionSchema).max(1_000),
  tasks: z.array(projectTaskSchema).max(10_000),
  draftCosts: z.array(projectDraftCostSchema).max(10_000),
  postedActuals: z.array(projectPostedActualSchema).max(10_000),
  qboProjectIdentities: z.array(projectQboIdentitySchema).max(20).default([]),
}).strict();
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const projectListResponseSchema = z.object({
  items: z.array(projectSummarySchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const projectListQuerySchema = z.object({
  scope: companyScopeSchema,
  asOf: isoDateSchema.optional(),
  status: projectStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

const projectPropertyFields = {
  propertyId: propertyReferenceIdSchema,
  unitId: nullableReference,
  name: text(200),
  projectType: projectTypeSchema.default("rehab"),
  description: optionalText(4_000),
  status: projectStatusSchema.default("planning"),
  startOn: nullableDate,
  targetOn: nullableDate,
  currency: currencyCodeSchema.optional(),
} as const;

export const createProjectPayloadSchema = z.object(projectPropertyFields).strict().superRefine(assertDateRange).superRefine((value, context) => {
  if (value.status === "archived") context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Projects are archived with the archive command" });
});
export type CreateProjectPayload = z.infer<typeof createProjectPayloadSchema>;

const updateProjectBaseSchema = z.object({
  projectId: projectIdSchema,
  name: text(200).optional(),
  projectType: projectTypeSchema.optional(),
  description: optionalText(4_000),
  status: projectStatusSchema.optional(),
  unitId: nullableReference,
  startOn: nullableDate,
  targetOn: nullableDate,
}).strict();
export const updateProjectPayloadSchema = updateProjectBaseSchema.superRefine(assertDateRange).superRefine((value, context) => {
  if (Object.keys(value).length <= 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one project field is required" });
});
export type UpdateProjectPayload = z.infer<typeof updateProjectPayloadSchema>;

export const archiveProjectPayloadSchema = z.object({ projectId: projectIdSchema }).strict();
export type ArchiveProjectPayload = z.infer<typeof archiveProjectPayloadSchema>;

export const linkProjectQboIdentityPayloadSchema = z.object({
  projectId: projectIdSchema,
  identities: z.array(z.object({
    recordKind: qboProjectRecordKindSchema,
    externalId: qboProjectExternalIdSchema,
  }).strict()).min(1).max(QBO_PROJECT_RECORD_KINDS.length),
  environment: qboEnvironmentSchema,
  realmId: qboRealmIdSchema,
}).strict().superRefine((value, context) => {
  const kinds = value.identities.map((identity) => identity.recordKind);
  if (!kinds.includes("Project")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["identities"], message: "A native QuickBooks Project ID is required" });
  }
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["identities"], message: "Each QuickBooks project identity kind may appear once" });
  }
});
export type LinkProjectQboIdentityPayload = z.infer<typeof linkProjectQboIdentityPayloadSchema>;

const scopeItemInputFields = {
  description: text(300),
  category: z.string().trim().max(120).nullable().optional(),
  unitLabel: z.string().trim().max(80).nullable().optional(),
  quantity: projectQuantitySchema,
  rateCents: nonNegativeCentsSchema,
  estimatedCents: nonNegativeCentsSchema.optional(),
} as const;
export const createScopeItemPayloadSchema = z.object({
  projectId: projectIdSchema,
  ...scopeItemInputFields,
}).strict();
export type CreateScopeItemPayload = z.infer<typeof createScopeItemPayloadSchema>;
export const updateScopeItemPayloadSchema = z.object({
  scopeItemId: scopeItemIdSchema,
  description: text(300).optional(),
  category: z.string().trim().max(120).nullable().optional(),
  unitLabel: z.string().trim().max(80).nullable().optional(),
  quantity: projectQuantitySchema.optional(),
  rateCents: nonNegativeCentsSchema.optional(),
  estimatedCents: nonNegativeCentsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length <= 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one scope item field is required" });
});
export type UpdateScopeItemPayload = z.infer<typeof updateScopeItemPayloadSchema>;
export const archiveScopeItemPayloadSchema = z.object({ scopeItemId: scopeItemIdSchema }).strict();
export type ArchiveScopeItemPayload = z.infer<typeof archiveScopeItemPayloadSchema>;

export const approveBudgetPayloadSchema = z.object({
  projectId: projectIdSchema,
  notes: z.string().trim().max(2_000).nullable().optional(),
}).strict();
export type ApproveBudgetPayload = z.infer<typeof approveBudgetPayloadSchema>;

const taskInputFields = {
  title: text(200),
  description: z.string().trim().max(4_000).nullable().optional(),
  status: projectTaskStatusSchema.optional(),
  startsOn: nullableDate,
  dueOn: nullableDate,
  completedOn: nullableDate,
  dependencyTaskIds: z.array(projectTaskIdSchema).max(1_000).optional(),
} as const;
export const createTaskPayloadSchema = z.object({ projectId: projectIdSchema, ...taskInputFields }).strict().superRefine(assertTaskDateRange);
export type CreateTaskPayload = z.infer<typeof createTaskPayloadSchema>;
export const updateTaskPayloadSchema = z.object({
  taskId: projectTaskIdSchema,
  title: text(200).optional(),
  description: z.string().trim().max(4_000).nullable().optional(),
  status: projectTaskStatusSchema.optional(),
  startsOn: nullableDate,
  dueOn: nullableDate,
  completedOn: nullableDate,
  dependencyTaskIds: z.array(projectTaskIdSchema).max(1_000).optional(),
}).strict().superRefine(assertTaskDateRange).superRefine((value, context) => {
  if (Object.keys(value).length <= 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one task field is required" });
});
export type UpdateTaskPayload = z.infer<typeof updateTaskPayloadSchema>;
export const archiveTaskPayloadSchema = z.object({ taskId: projectTaskIdSchema }).strict();
export type ArchiveTaskPayload = z.infer<typeof archiveTaskPayloadSchema>;
export const setTaskDependenciesPayloadSchema = z.object({
  taskId: projectTaskIdSchema,
  dependencyTaskIds: z.array(projectTaskIdSchema).max(1_000),
}).strict();
export type SetTaskDependenciesPayload = z.infer<typeof setTaskDependenciesPayloadSchema>;

/** "system:" vendor names are reserved for derived rows such as ETC overrides. */
const draftVendorNameSchema = z.string().trim().max(200).refine((value) => !value.toLowerCase().startsWith("system:"), "Vendor names starting with system: are reserved").nullable().optional();

const draftCostInputFields = {
  scopeItemId: scopeItemIdSchema.nullable().optional(),
  vendorName: draftVendorNameSchema,
  description: text(300),
  amountCents: nonNegativeCentsSchema,
  incurredOn: isoDateSchema,
} as const;
export const createDraftCostPayloadSchema = z.object({ projectId: projectIdSchema, ...draftCostInputFields }).strict();
export type CreateDraftCostPayload = z.infer<typeof createDraftCostPayloadSchema>;
export const updateDraftCostPayloadSchema = z.object({
  draftCostId: draftCostIdSchema,
  scopeItemId: scopeItemIdSchema.nullable().optional(),
  vendorName: draftVendorNameSchema,
  description: text(300).optional(),
  amountCents: nonNegativeCentsSchema.optional(),
  incurredOn: isoDateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length <= 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one draft cost field is required" });
});
export type UpdateDraftCostPayload = z.infer<typeof updateDraftCostPayloadSchema>;
export const archiveDraftCostPayloadSchema = z.object({ draftCostId: draftCostIdSchema }).strict();
export type ArchiveDraftCostPayload = z.infer<typeof archiveDraftCostPayloadSchema>;

export const PROJECT_COMMAND_KINDS = [
  "project.create",
  "project.update",
  "project.archive",
  "project.qbo_identity.link",
  "project.scope_item.create",
  "project.scope_item.update",
  "project.scope_item.archive",
  "project.budget.approve",
  "project.task.create",
  "project.task.update",
  "project.task.archive",
  "project.task.dependencies.set",
  "project.draft_cost.create",
  "project.draft_cost.update",
  "project.draft_cost.archive",
] as const;
export type ProjectCommandKind = (typeof PROJECT_COMMAND_KINDS)[number];

export const projectCommandPayloadSchemas = {
  "project.create": createProjectPayloadSchema,
  "project.update": updateProjectPayloadSchema,
  "project.archive": archiveProjectPayloadSchema,
  "project.qbo_identity.link": linkProjectQboIdentityPayloadSchema,
  "project.scope_item.create": createScopeItemPayloadSchema,
  "project.scope_item.update": updateScopeItemPayloadSchema,
  "project.scope_item.archive": archiveScopeItemPayloadSchema,
  "project.budget.approve": approveBudgetPayloadSchema,
  "project.task.create": createTaskPayloadSchema,
  "project.task.update": updateTaskPayloadSchema,
  "project.task.archive": archiveTaskPayloadSchema,
  "project.task.dependencies.set": setTaskDependenciesPayloadSchema,
  "project.draft_cost.create": createDraftCostPayloadSchema,
  "project.draft_cost.update": updateDraftCostPayloadSchema,
  "project.draft_cost.archive": archiveDraftCostPayloadSchema,
} as const;

export type ProjectCommandPayload = {
  [K in ProjectCommandKind]: z.output<(typeof projectCommandPayloadSchemas)[K]>;
};

export function projectCommandPayloadSchema<TKind extends ProjectCommandKind>(kind: TKind): (typeof projectCommandPayloadSchemas)[TKind] {
  return projectCommandPayloadSchemas[kind];
}

export function parseProjectCommandPayload<TKind extends ProjectCommandKind>(kind: TKind, input: unknown): ProjectCommandPayload[TKind] {
  return projectCommandPayloadSchemas[kind].parse(input) as ProjectCommandPayload[TKind];
}

export const projectIdReferenceSchema = z.union([projectIdSchema, recordReferenceIdSchema]);
export const projectDocumentReferenceSchema = documentReferenceIdSchema;

export type ProjectScope = CompanyScope & {
  readonly organizationId: OrganizationId;
  readonly legalEntityId: LegalEntityId;
  readonly propertyId: PropertyReferenceId;
};

export interface ProjectReadContext {
  readonly scope: CompanyScope;
  readonly asOf?: IsoDate;
}

export interface ProjectCostTotals {
  readonly draftCostCents: MoneyCents;
  readonly postedActualCents: MoneyCents;
}

export type ProjectCurrency = CurrencyCode;
export type ProjectRecordedAt = IsoTimestamp;
export type ProjectRecordReference = RecordReferenceId;
