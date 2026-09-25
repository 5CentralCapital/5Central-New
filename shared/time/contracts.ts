import { z } from "zod";
import {
  centsSchema,
  companyScopeSchema,
  currencyCodeSchema,
  isIsoDate,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  operationIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  recordReferenceIdSchema,
  revisionSchema,
  type CompanyScope,
  type CurrencyCode,
  type IsoDate,
  type IsoTimestamp,
  type LegalEntityId,
  type MoneyCents,
  type OperationId,
  type Revision,
} from "../company";
import { timePayrollLinkPayloadSchema, timePayrollUnlinkPayloadSchema } from "./labor";

export const TIME_PROVIDER = "quickbooks_time" as const;
export const timeProviderSchema = z.literal(TIME_PROVIDER);
export type TimeProvider = typeof TIME_PROVIDER;
export const timeEnvironmentSchema = z.enum(["sandbox", "production"]);
export type TimeEnvironment = z.infer<typeof timeEnvironmentSchema>;

export const timeConnectionScopeSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: timeEnvironmentSchema,
  providerCompanyId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
}).strict();
export type TimeConnectionScope = z.infer<typeof timeConnectionScopeSchema>;

/** Scope used while starting OAuth, before the provider company identity is known. */
export const timeConnectionSetupScopeSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: timeEnvironmentSchema,
  providerCompanyId: timeConnectionScopeSchema.shape.providerCompanyId.nullable().optional(),
}).strict();
export type TimeConnectionSetupScope = z.infer<typeof timeConnectionSetupScopeSchema>;

export const timeConnectionSummarySchema = z.object({
  scope: timeConnectionScopeSchema,
  name: z.string().trim().min(1).max(200),
  status: z.enum(["active", "revoked", "needs_reconnect"]),
  connectedAt: isoTimestampSchema.nullable(),
}).strict();
export type TimeConnectionSummary = z.infer<typeof timeConnectionSummarySchema>;

export const timeSourceObjectKindSchema = z.enum(["user", "jobcode", "timesheet"]);
export type TimeSourceObjectKind = z.infer<typeof timeSourceObjectKindSchema>;
export const timeSourceReferenceSchema = z.object({
  provider: timeProviderSchema,
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: timeEnvironmentSchema,
  providerCompanyId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
  objectKind: timeSourceObjectKindSchema,
  providerObjectId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
  sourceVersion: z.string().trim().min(1).max(160),
}).strict();
export type TimeSourceReference = z.infer<typeof timeSourceReferenceSchema>;

export const timeEntryTypeSchema = z.enum(["regular", "manual"]);
export type TimeEntryType = z.infer<typeof timeEntryTypeSchema>;
export const timeEntryReviewStateSchema = z.enum(["needs_review", "corrected", "approved", "rejected"]);
export type TimeEntryReviewState = z.infer<typeof timeEntryReviewStateSchema>;
export const timeEntryConflictSchema = z.enum(["none", "overlap", "multiple_active", "invalid_duration", "stale_correction"]);
export type TimeEntryConflict = z.infer<typeof timeEntryConflictSchema>;
export const timeCorrectionRevisionSchema = z.number().int().nonnegative();
export type TimeCorrectionRevision = z.infer<typeof timeCorrectionRevisionSchema>;

const localTimestampSchema = z.string().trim().min(1).max(80).refine(value => {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  // Date.parse rolls impossible dates and 24:00 forward, so check the fields first.
  return match !== null && isIsoDate(match[1]) && Number(match[2]) <= 23 && Number(match[3]) <= 59
    && Number(match[4] ?? "0") <= 59 && Number.isFinite(Date.parse(value));
}, "Expected an ISO-8601 timestamp with an explicit timezone");
export type TimeLocalTimestamp = z.infer<typeof localTimestampSchema>;

function addEntryShapeIssues(value: { readonly type: TimeEntryType; readonly start: string | null; readonly end: string | null; readonly durationSeconds: number }, context: z.RefinementCtx): void {
  if (value.type === "manual") {
    if (value.start !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["start"], message: "Manual time entries cannot have a start timestamp" });
    if (value.end !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["end"], message: "Manual time entries cannot have an end timestamp" });
    return;
  }
  if (value.start === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["start"], message: "Regular time entries require a start timestamp" });
    return;
  }
  if (value.end === null) return;
  const elapsedSeconds = Math.round((Date.parse(value.end) - Date.parse(value.start)) / 1_000);
  if (elapsedSeconds <= 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["end"], message: "The end timestamp must follow the start timestamp" });
  if (elapsedSeconds !== value.durationSeconds) context.addIssue({ code: z.ZodIssueCode.custom, path: ["durationSeconds"], message: "Duration must equal the elapsed timestamp interval" });
}

export const timeUserSchema = z.object({
  source: timeSourceReferenceSchema,
  providerUserId: z.string().trim().min(1),
  firstName: z.string().trim().max(160),
  lastName: z.string().trim().max(160),
  displayName: z.string().trim().min(1).max(320),
  email: z.string().trim().max(320).nullable(),
  active: z.boolean(),
  submittedTo: isoDateSchema.nullable(),
  approvedTo: isoDateSchema.nullable(),
  lastModified: isoTimestampSchema,
  deletedAt: isoTimestampSchema.nullable(),
}).strict();
export type TimeUser = z.infer<typeof timeUserSchema>;

export const timeJobcodeSchema = z.object({
  source: timeSourceReferenceSchema,
  providerJobcodeId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(320),
  parentId: z.string().trim().nullable(),
  type: z.string().trim().max(80),
  billable: z.boolean(),
  active: z.boolean(),
  lastModified: isoTimestampSchema,
  deletedAt: isoTimestampSchema.nullable(),
}).strict();
export type TimeJobcode = z.infer<typeof timeJobcodeSchema>;

export const timeEntrySchema = z.object({
  id: recordReferenceIdSchema,
  source: timeSourceReferenceSchema,
  providerTimesheetId: z.string().trim().min(1),
  providerUserId: z.string().trim().min(1),
  providerJobcodeId: z.string().trim().min(1),
  type: timeEntryTypeSchema,
  start: localTimestampSchema.nullable(),
  end: localTimestampSchema.nullable(),
  date: isoDateSchema,
  durationSeconds: z.number().int().nonnegative(),
  timezoneOffsetMinutes: z.number().int().min(-24 * 60).max(24 * 60).nullable(),
  timezoneName: z.string().trim().max(80).nullable(),
  onTheClock: z.boolean(),
  locked: z.boolean(),
  providerActive: z.boolean(),
  deletedAt: isoTimestampSchema.nullable(),
  notes: z.string().max(4_000),
  lastModified: isoTimestampSchema,
  reviewState: timeEntryReviewStateSchema,
  conflict: timeEntryConflictSchema,
  mappingStatus: z.enum(["unmapped_employee", "unmapped_jobcode", "mapped"]),
  correctionRevision: timeCorrectionRevisionSchema,
  estimatedLaborCostCents: centsSchema.nullable(),
  estimatedLaborCurrency: currencyCodeSchema.nullable(),
  postedPayrollCents: centsSchema.nullable(),
  postedPayrollCurrency: currencyCodeSchema.nullable(),
  updatedAt: isoTimestampSchema,
}).strict().superRefine(addEntryShapeIssues);
export type TimeEntry = z.infer<typeof timeEntrySchema>;

export const timeEmployeeMappingSchema = z.object({
  id: recordReferenceIdSchema,
  scope: timeConnectionScopeSchema,
  providerUserId: z.string().trim().min(1),
  contactId: recordReferenceIdSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
  hourlyRateCents: centsSchema.nullable(),
  currency: currencyCodeSchema.nullable(),
  status: z.enum(["active", "archived"]),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type TimeEmployeeMapping = z.infer<typeof timeEmployeeMappingSchema>;

export const timeJobcodeMappingSchema = z.object({
  id: recordReferenceIdSchema,
  scope: timeConnectionScopeSchema,
  providerJobcodeId: z.string().trim().min(1),
  propertyId: propertyReferenceIdSchema.nullable(),
  projectId: recordReferenceIdSchema.nullable(),
  costCode: z.string().trim().max(160).nullable(),
  status: z.enum(["active", "archived"]),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type TimeJobcodeMapping = z.infer<typeof timeJobcodeMappingSchema>;

export const timeCoverageStatusSchema = z.enum(["unavailable", "partial", "complete"]);
export type TimeCoverageStatus = z.infer<typeof timeCoverageStatusSchema>;
export const timeSyncStreamSchema = z.enum(["users", "jobcodes", "timesheets", "timesheets_deleted"]);
export type TimeSyncStream = z.infer<typeof timeSyncStreamSchema>;
export const timeCoverageSchema = z.object({
  scope: timeConnectionScopeSchema,
  stream: timeSyncStreamSchema,
  status: timeCoverageStatusSchema,
  evidence: z.enum(["unverified", "synthetic", "live_provider_readback"]),
  modifiedSince: isoTimestampSchema.nullable(),
  watermark: isoTimestampSchema.nullable(),
  observedAt: isoTimestampSchema,
  objectCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  reason: z.string().trim().max(500).nullable(),
}).strict();
export type TimeCoverage = z.infer<typeof timeCoverageSchema>;

export const timeListQuerySchema = z.object({
  scope: z.object({ organizationId: organizationIdSchema, legalEntityId: legalEntityIdSchema, propertyId: propertyReferenceIdSchema.optional() }).strict(),
  environment: timeEnvironmentSchema,
  providerCompanyId: timeConnectionScopeSchema.shape.providerCompanyId,
  reviewState: timeEntryReviewStateSchema.optional(),
  mappingStatus: z.enum(["unmapped_employee", "unmapped_jobcode", "mapped"]).optional(),
  from: isoDateSchema.optional(),
  through: isoDateSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().trim().min(1).max(1024).optional(),
}).strict().superRefine((value, context) => {
  if (value.from !== undefined && value.through !== undefined && value.through < value.from) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["through"], message: "through must be on or after from" });
  }
});
export type TimeListQuery = z.infer<typeof timeListQuerySchema>;

export const timeReviewActionSchema = z.enum(["approve", "reject", "request_review"]);
const timeProviderCommandScopeFields = {
  environment: timeEnvironmentSchema,
  providerCompanyId: timeConnectionScopeSchema.shape.providerCompanyId,
} as const;
export const timeReviewTimesheetPayloadSchema = z.object({
  ...timeProviderCommandScopeFields,
  timesheetId: recordReferenceIdSchema,
  action: timeReviewActionSchema,
  reason: z.string().trim().max(2_000).optional(),
}).strict();
export const timeCorrectTimesheetPayloadSchema = z.object({
  ...timeProviderCommandScopeFields,
  timesheetId: recordReferenceIdSchema,
  expectedCorrectionRevision: timeCorrectionRevisionSchema.optional(),
  type: timeEntryTypeSchema,
  start: localTimestampSchema.nullable(),
  end: localTimestampSchema.nullable(),
  date: isoDateSchema,
  durationSeconds: z.number().int().nonnegative(),
  timezoneOffsetMinutes: z.number().int().min(-24 * 60).max(24 * 60).nullable(),
  timezoneName: z.string().trim().max(80).nullable(),
  notes: z.string().max(4_000),
  reason: z.string().trim().min(1).max(2_000),
}).strict().superRefine(addEntryShapeIssues);
export const timeMapEmployeePayloadSchema = z.object({
  ...timeProviderCommandScopeFields,
  providerUserId: z.string().trim().min(1).max(160),
  contactId: recordReferenceIdSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable().optional(),
  hourlyRateCents: centsSchema.nullable().optional(),
  currency: currencyCodeSchema.nullable().optional(),
}).strict();
export const timeMapJobcodePayloadSchema = z.object({
  ...timeProviderCommandScopeFields,
  providerJobcodeId: z.string().trim().min(1).max(160),
  propertyId: propertyReferenceIdSchema.nullable().optional(),
  projectId: recordReferenceIdSchema.nullable().optional(),
  costCode: z.string().trim().max(160).nullable().optional(),
}).strict();

export const TIME_COMMAND_KINDS = ["time.review_timesheet", "time.correct_timesheet", "time.map_employee", "time.map_jobcode", "time.payroll.link", "time.payroll.unlink"] as const;
export type TimeCommandKind = (typeof TIME_COMMAND_KINDS)[number];
export const timeCommandPayloadSchemas: Readonly<Record<TimeCommandKind, z.ZodTypeAny>> = {
  "time.review_timesheet": timeReviewTimesheetPayloadSchema,
  "time.correct_timesheet": timeCorrectTimesheetPayloadSchema,
  "time.map_employee": timeMapEmployeePayloadSchema,
  "time.map_jobcode": timeMapJobcodePayloadSchema,
  "time.payroll.link": timePayrollLinkPayloadSchema,
  "time.payroll.unlink": timePayrollUnlinkPayloadSchema,
};

export interface TimeReadPort {
  listEntries(input: TimeListQuery): Promise<{ items: readonly TimeEntry[]; nextCursor: string | null; coverage: readonly TimeCoverage[] }>;
  listUsers(scope: TimeConnectionScope): Promise<readonly TimeUser[]>;
  listJobcodes(scope: TimeConnectionScope): Promise<readonly TimeJobcode[]>;
  listEmployeeMappings(scope: TimeConnectionScope): Promise<readonly TimeEmployeeMapping[]>;
  listJobcodeMappings(scope: TimeConnectionScope): Promise<readonly TimeJobcodeMapping[]>;
  readCoverage(scope: TimeConnectionScope): Promise<readonly TimeCoverage[]>;
  listConnections(scope: { readonly organizationId: TimeConnectionScope["organizationId"]; readonly legalEntityId: TimeConnectionScope["legalEntityId"]; readonly environment?: TimeEnvironment }): Promise<readonly TimeConnectionSummary[]>;
}

export interface TimeCommandPort {
  execute(kind: TimeCommandKind, envelope: unknown, access: unknown): Promise<import("../company").OperationReceipt>;
}

export const timeSyncOptionsSchema = z.object({
  maxPages: z.number().int().min(1).max(10_000).optional(),
  /** Required for the first timesheet read because the provider endpoint is range-based. */
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.startDate !== undefined && value.endDate !== undefined && value.endDate < value.startDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "endDate must be on or after startDate" });
  }
});
export type TimeSyncOptions = z.infer<typeof timeSyncOptionsSchema>;

/** Keep browser and MCP initial reads finite and aligned to the operating day. */
export const TIME_DEFAULT_SYNC_LOOKBACK_DAYS = 30;

export function defaultTimeSyncWindow(now = new Date()): Pick<TimeSyncOptions, "startDate" | "endDate"> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const endDate = isoDateSchema.parse(`${values.year}-${values.month}-${values.day}`);
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - TIME_DEFAULT_SYNC_LOOKBACK_DAYS);
  return { startDate: isoDateSchema.parse(start.toISOString().slice(0, 10)), endDate };
}

/** Supply an initial range for adapters that expose a one-click sync action. */
export function timeSyncOptionsWithDefault(options: TimeSyncOptions = {}, now = new Date()): TimeSyncOptions {
  return timeSyncOptionsSchema.parse({
    ...defaultTimeSyncWindow(now),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
    ...(options.endDate === undefined ? {} : { endDate: options.endDate }),
  });
}

export interface TimeSyncPort {
  sync(scope: TimeConnectionScope, options?: TimeSyncOptions): Promise<{ status: "complete" | "partial"; streams: readonly TimeCoverage[]; conflicts: readonly string[] }>;
}

export type TimeScope = CompanyScope & { readonly legalEntityId: LegalEntityId };
export type TimeOperationId = OperationId;
export type TimeRevision = Revision;
export type TimeCurrency = CurrencyCode;
export type TimeMoneyCents = MoneyCents;
export type TimeDate = IsoDate;
export type TimeTimestamp = IsoTimestamp;

export { localTimestampSchema };
