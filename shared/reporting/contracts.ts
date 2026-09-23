import { z } from "zod";
import {
  centsSchema,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  recordReferenceIdSchema,
  type CompanyScope,
  type CurrencyCode,
  type IsoDate,
  type IsoTimestamp,
  type LegalEntityId,
  type MoneyCents,
  type OrganizationId,
  type PropertyReferenceId,
} from "../company";
import { isoMonthSchema, type IsoMonth } from "../rent-ops-contracts";

export const REPORTING_SERVICE_VERSION = "reporting.v1" as const;
export const REPORTING_DEFINITION_VERSION = "1" as const;

export const REPORTING_CATEGORIES = ["financial", "rental", "tasks", "projects", "investors", "forecast"] as const;
export type ReportingCategory = (typeof REPORTING_CATEGORIES)[number];
export const reportingCategorySchema = z.enum(REPORTING_CATEGORIES);
export const REPORTING_PERIOD_MODES = ["as_of", "range", "month", "custom"] as const;
export type ReportingPeriodMode = (typeof REPORTING_PERIOD_MODES)[number];
export const reportingPeriodModeSchema = z.enum(REPORTING_PERIOD_MODES);
export const REPORTING_SOURCES = ["rental", "quickbooks", "combined", "company", "investors", "time"] as const;
export type ReportingSource = (typeof REPORTING_SOURCES)[number];
export const reportingSourceSchema = z.enum(REPORTING_SOURCES);
/** Runtime capability, derived from the registered engine and its source
 * probes. It replaces the former static "planned/available" catalog label. */
export const REPORTING_RUNTIME_STATUSES = ["available", "missing_data", "not_implemented"] as const;
export type ReportingRuntimeStatus = (typeof REPORTING_RUNTIME_STATUSES)[number];
export const reportingRuntimeStatusSchema = z.enum(REPORTING_RUNTIME_STATUSES);
export const REPORTING_ACTUALITY = ["actual", "forecast", "actual_and_forecast"] as const;
export type ReportingActuality = (typeof REPORTING_ACTUALITY)[number];
export const reportingActualitySchema = z.enum(REPORTING_ACTUALITY);
export const REPORTING_BASES = ["cash", "accrual", "operational", "not_applicable", "mixed"] as const;
export type ReportingBasis = (typeof REPORTING_BASES)[number];
export const reportingBasisSchema = z.enum(REPORTING_BASES);
export const REPORTING_SCOPE_KINDS = ["organization", "legal_entity", "property", "unit", "tenant", "tenancy", "owner", "investor", "project", "vendor", "staff"] as const;
export type ReportingScopeKind = (typeof REPORTING_SCOPE_KINDS)[number];
export const reportingScopeKindSchema = z.enum(REPORTING_SCOPE_KINDS);
export const REPORTING_COLUMN_TYPES = ["text", "date", "month", "money", "integer", "decimal", "percent", "duration", "boolean", "status", "json"] as const;
export type ReportingColumnType = (typeof REPORTING_COLUMN_TYPES)[number];
export const reportingColumnTypeSchema = z.enum(REPORTING_COLUMN_TYPES);
export const REPORTING_EXPORT_FORMATS = ["csv", "json", "html"] as const;
export type ReportingExportFormat = (typeof REPORTING_EXPORT_FORMATS)[number];
export const reportingExportFormatSchema = z.enum(REPORTING_EXPORT_FORMATS);
export const REPORTING_RUN_STATES = ["ready", "failed", "expired"] as const;
export type ReportingRunState = (typeof REPORTING_RUN_STATES)[number];
export const reportingRunStateSchema = z.enum(REPORTING_RUN_STATES);
export const REPORTING_JOB_STATES = ["queued", "running", "ready", "failed", "cancelled", "expired"] as const;
export type ReportingJobState = (typeof REPORTING_JOB_STATES)[number];
export const reportingJobStateSchema = z.enum(REPORTING_JOB_STATES);
export const REPORTING_COVERAGE_STATES = ["unavailable", "partial", "complete"] as const;
export type ReportingCoverageState = (typeof REPORTING_COVERAGE_STATES)[number];
export const reportingCoverageStateSchema = z.enum(REPORTING_COVERAGE_STATES);
export const REPORTING_EVIDENCE_STATES = ["unverified", "synthetic", "live_provider_readback", "reproducible_snapshot"] as const;
export type ReportingEvidenceState = (typeof REPORTING_EVIDENCE_STATES)[number];
export const reportingEvidenceStateSchema = z.enum(REPORTING_EVIDENCE_STATES);
export const REPORTING_COMPLETENESS_STATES = ["verified_zero", "complete", "partial", "stale", "unknown", "unavailable", "not_applicable"] as const;
export type ReportingCompletenessState = (typeof REPORTING_COMPLETENESS_STATES)[number];
export const reportingCompletenessStateSchema = z.enum(REPORTING_COMPLETENESS_STATES);
export const REPORTING_VISIBILITIES = ["private", "shared"] as const;
export type ReportingVisibility = (typeof REPORTING_VISIBILITIES)[number];
export const reportingVisibilitySchema = z.enum(REPORTING_VISIBILITIES);

const reportIdPattern = /^[a-z][a-z0-9-]{1,119}$/;
const definitionVersionPattern = /^[0-9]+(?:\.[0-9]+){0,2}$/;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/;
const reportFieldPattern = /^[a-z][A-Za-z0-9_.-]{0,119}$/;
export const reportIdSchema = z.string().regex(reportIdPattern, "Report ID is invalid");
export type ReportId = z.infer<typeof reportIdSchema>;
export const reportDefinitionVersionSchema = z.string().regex(definitionVersionPattern, "Report definition version is invalid");
export const reportRequestIdSchema = z.string().regex(requestIdPattern, "Report request ID is invalid");
export const reportRecordIdSchema = z.string().uuid();

export const reportColumnSchema = z.object({
  id: z.string().regex(reportFieldPattern), label: z.string().trim().min(1).max(200), type: reportingColumnTypeSchema,
  sortable: z.boolean().default(false), filterable: z.boolean().default(false), sensitive: z.boolean().default(false),
}).strict();
export type ReportColumn = z.infer<typeof reportColumnSchema>;
export const reportFilterOptionSchema = z.object({ value: z.string().trim().min(1).max(160), label: z.string().trim().min(1).max(200) }).strict();
export type ReportFilterOption = z.infer<typeof reportFilterOptionSchema>;
export const REPORTING_FILTER_KINDS = ["date", "month", "text", "select", "multi_select", "reference", "money", "number", "boolean", "basis", "currency", "scenario"] as const;
export type ReportingFilterKind = (typeof REPORTING_FILTER_KINDS)[number];
export const reportingFilterKindSchema = z.enum(REPORTING_FILTER_KINDS);
export const reportingFilterDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]{0,119}$/), kind: reportingFilterKindSchema, label: z.string().trim().min(1).max(200),
  options: z.array(reportFilterOptionSchema).min(1).optional(),
  reference: z.enum(["organization", "legal_entity", "property", "unit", "tenant", "tenancy", "person", "owner", "investor", "project", "vendor", "staff", "account", "status"]).optional(),
  multiple: z.boolean().default(false), required: z.boolean().default(false), default: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  exclusiveGroup: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(), dateMode: z.enum(["as_of", "report_month", "activity_range"]).optional(),
  pairedWith: z.string().regex(/^[a-z][A-Za-z0-9]{0,119}$/).optional(), description: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (["select", "multi_select", "basis"].includes(value.kind) && !value.options) context.addIssue({ code: "custom", message: "Choice filters require options." });
  if (value.kind === "reference" && !value.reference) context.addIssue({ code: "custom", message: "Reference filters require a reference family." });
  if (value.kind !== "reference" && value.reference) context.addIssue({ code: "custom", message: "Only reference filters may declare a reference family." });
  if (["date", "month"].includes(value.kind) && !value.dateMode) context.addIssue({ code: "custom", message: "Date filters require date semantics." });
  if (value.kind !== "date" && value.kind !== "month" && value.dateMode) context.addIssue({ code: "custom", message: "Date semantics are only valid for date and month filters." });
  if (!value.multiple && Array.isArray(value.default)) context.addIssue({ code: "custom", message: "An array default requires a multiple filter." });
});
export type ReportingFilterDefinition = z.infer<typeof reportingFilterDefinitionSchema>;

export const reportScopeSchema = z.object({
  organizationId: organizationIdSchema, legalEntityIds: z.array(legalEntityIdSchema).max(100).default([]), propertyIds: z.array(propertyReferenceIdSchema).max(10_000).default([]),
  unitIds: z.array(recordReferenceIdSchema).max(10_000).default([]), tenantIds: z.array(recordReferenceIdSchema).max(10_000).default([]), tenancyIds: z.array(recordReferenceIdSchema).max(10_000).default([]),
  ownerIds: z.array(recordReferenceIdSchema).max(10_000).default([]), investorIds: z.array(recordReferenceIdSchema).max(10_000).default([]), projectIds: z.array(recordReferenceIdSchema).max(10_000).default([]),
  vendorIds: z.array(recordReferenceIdSchema).max(10_000).default([]), staffIds: z.array(recordReferenceIdSchema).max(10_000).default([]),
}).strict().superRefine((value, context) => {
  const fields = ["legalEntityIds", "propertyIds", "unitIds", "tenantIds", "tenancyIds", "ownerIds", "investorIds", "projectIds", "vendorIds", "staffIds"] as const;
  for (const field of fields) {
    const values = value[field] as readonly string[];
    if (new Set<string>(values.map(String)).size !== values.length) context.addIssue({ code: "custom", path: [field], message: `${field} must contain unique IDs` });
  }
});
export type ReportScope = z.infer<typeof reportScopeSchema>;

export const reportPeriodSchema = z.union([
  z.object({ mode: z.literal("as_of"), asOfDate: isoDateSchema }).strict(),
  z.object({ mode: z.literal("range"), fromDate: isoDateSchema, toDate: isoDateSchema }).strict(),
  z.object({ mode: z.literal("month"), month: isoMonthSchema }).strict(),
  z.object({ mode: z.literal("custom"), asOfDate: isoDateSchema.optional(), fromDate: isoDateSchema.optional(), toDate: isoDateSchema.optional(), month: isoMonthSchema.optional() }).strict(),
]).superRefine((value, context) => {
  if (value.mode === "range" && value.toDate < value.fromDate) context.addIssue({ code: "custom", path: ["toDate"], message: "Report period ends before it starts" });
});
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;
export const reportConsolidationPolicySchema = z.object({
  entityIds: z.array(legalEntityIdSchema).min(1).max(100), currency: currencyCodeSchema, ownershipPolicy: z.enum(["full_control", "pro_rata", "equity_method", "nci_explicit"]),
  eliminationPolicy: z.enum(["none", "approved_version"]), eliminationVersion: z.string().trim().min(1).max(120).optional(), translationPolicy: z.enum(["none", "approved_rates"]).default("none"), translationVersion: z.string().trim().min(1).max(120).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.entityIds).size !== value.entityIds.length) context.addIssue({ code: "custom", path: ["entityIds"], message: "Consolidation entities must be unique" });
  if (value.eliminationPolicy === "approved_version" && !value.eliminationVersion) context.addIssue({ code: "custom", path: ["eliminationVersion"], message: "An elimination version is required" });
  if (value.translationPolicy === "approved_rates" && !value.translationVersion) context.addIssue({ code: "custom", path: ["translationVersion"], message: "A translation version is required" });
});
export type ReportConsolidationPolicy = z.infer<typeof reportConsolidationPolicySchema>;
export const reportForecastContextSchema = z.object({ scenarioId: z.string().regex(safeTokenPattern), inputVersion: z.string().regex(safeTokenPattern), modelVersion: z.string().regex(safeTokenPattern) }).strict();
export type ReportForecastContext = z.infer<typeof reportForecastContextSchema>;
export const reportFilterValuesSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,119}$/), z.unknown());
export type ReportFilterValues = z.infer<typeof reportFilterValuesSchema>;
export const reportSortSchema = z.object({ field: z.string().regex(reportFieldPattern), direction: z.enum(["asc", "desc"]) }).strict();
export type ReportSort = z.infer<typeof reportSortSchema>;

export const reportRunRequestSchema = z.object({
  reportId: reportIdSchema, definitionVersion: reportDefinitionVersionSchema, scope: reportScopeSchema, filters: reportFilterValuesSchema, period: reportPeriodSchema,
  basis: reportingBasisSchema, currency: currencyCodeSchema.nullable(), consolidation: reportConsolidationPolicySchema.nullable().optional(), forecast: reportForecastContextSchema.nullable().optional(),
  columns: z.array(z.string().regex(reportFieldPattern)).max(200).optional(), sort: z.array(reportSortSchema).max(8).optional(), requestId: reportRequestIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (["cash", "accrual"].includes(value.basis) && !value.currency) context.addIssue({ code: "custom", path: ["currency"], message: "Financial reports require an explicit currency" });
  if (value.consolidation && value.consolidation.currency !== value.currency) context.addIssue({ code: "custom", path: ["consolidation", "currency"], message: "Consolidation currency must match the report currency" });
  if (value.consolidation) {
    const selected = new Set(value.scope.legalEntityIds);
    const consolidated = new Set(value.consolidation.entityIds);
    if (selected.size !== consolidated.size || value.consolidation.entityIds.some(entityId => !selected.has(entityId))) context.addIssue({ code: "custom", path: ["consolidation", "entityIds"], message: "Consolidation entities must exactly match the selected legal entity scope" });
  }
  if (value.reportId.includes("consolidated") && !value.consolidation) context.addIssue({ code: "custom", path: ["consolidation"], message: "Consolidated reports require an explicit consolidation policy" });
});
export type ReportRunRequest = z.infer<typeof reportRunRequestSchema>;

export const reportSourceCoverageSchema = z.object({
  source: z.string().trim().min(1).max(160), state: reportingCoverageStateSchema, evidence: reportingEvidenceStateSchema, basis: reportingBasisSchema,
  watermark: z.string().trim().max(255).nullable(), observedAt: isoTimestampSchema, coveredFrom: isoDateSchema.nullable(), coveredThrough: isoDateSchema.nullable(), rowCount: z.number().int().nonnegative(), reason: z.string().trim().max(500).nullable(),
}).strict();
export type ReportSourceCoverage = z.infer<typeof reportSourceCoverageSchema>;
export const reportMissingDataSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/), state: reportingCompletenessStateSchema, message: z.string().trim().min(1).max(500), scope: z.string().trim().max(200).nullable().optional(), count: z.number().int().nonnegative().optional() }).strict();
export type ReportMissingData = z.infer<typeof reportMissingDataSchema>;
export const reportRowSchema = z.object({ rowId: z.string().trim().min(1).max(240), values: z.record(z.string().regex(reportFieldPattern), z.unknown()) }).strict();
export type ReportRow = z.infer<typeof reportRowSchema>;
export const reportTotalSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/), amountCents: centsSchema.nullable(), currency: currencyCodeSchema.nullable(), state: reportingCompletenessStateSchema, denominator: centsSchema.nullable().optional(), percentage: z.string().nullable().optional() }).strict();
export type ReportTotal = z.infer<typeof reportTotalSchema>;
export const reportDrilldownItemSchema = z.object({ id: z.string().trim().min(1).max(240), kind: z.enum(["source", "line", "allocation", "entity", "property", "project", "investor", "activity"]), values: z.record(z.string().regex(reportFieldPattern), z.unknown()) }).strict();
export type ReportDrilldownItem = z.infer<typeof reportDrilldownItemSchema>;
export const reportDrilldownSchema = z.object({ rowId: z.string().trim().min(1).max(240), items: z.array(reportDrilldownItemSchema).max(10_000), nextCursor: z.string().nullable(), coverage: z.array(reportSourceCoverageSchema).max(100), missingData: z.array(reportMissingDataSchema).max(100) }).strict();
export type ReportDrilldown = z.infer<typeof reportDrilldownSchema>;
export const reportResultSchema = z.object({ columns: z.array(reportColumnSchema).max(200), rows: z.array(reportRowSchema).max(100_000), totals: z.array(reportTotalSchema).max(200), coverage: z.array(reportSourceCoverageSchema).max(100), missingData: z.array(reportMissingDataSchema).max(200), drilldowns: z.array(reportDrilldownSchema).max(100_000).optional() }).strict();
export type ReportResult = z.infer<typeof reportResultSchema>;

export const reportRunRecordSchema = z.object({
  id: reportRecordIdSchema, snapshotId: reportRecordIdSchema, organizationId: organizationIdSchema, actorId: z.string().trim().min(1).max(240), permissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  serviceVersion: z.literal(REPORTING_SERVICE_VERSION), reportId: reportIdSchema, definitionVersion: reportDefinitionVersionSchema, state: reportingRunStateSchema, requestId: reportRequestIdSchema,
  scope: reportScopeSchema, filters: reportFilterValuesSchema, period: reportPeriodSchema, basis: reportingBasisSchema, currency: currencyCodeSchema.nullable(), consolidation: reportConsolidationPolicySchema.nullable(), forecast: reportForecastContextSchema.nullable(),
  columns: z.array(reportColumnSchema).max(200), sort: z.array(reportSortSchema).max(8), rows: z.array(reportRowSchema).max(100_000), totals: z.array(reportTotalSchema).max(200), coverage: z.array(reportSourceCoverageSchema).max(100), missingData: z.array(reportMissingDataSchema).max(200), drilldowns: z.array(reportDrilldownSchema).max(100_000), generatedAt: isoTimestampSchema, expiresAt: isoTimestampSchema.nullable(),
}).strict();
export type ReportRunRecord = z.infer<typeof reportRunRecordSchema>;
export const reportRunSummarySchema = reportRunRecordSchema.omit({ rows: true, drilldowns: true }).extend({ rowCount: z.number().int().nonnegative(), drilldownCount: z.number().int().nonnegative() }).strict();
export type ReportRunSummary = z.infer<typeof reportRunSummarySchema>;
export const reportPageRequestSchema = z.object({ runId: reportRecordIdSchema, cursor: z.string().max(1_024).nullable().optional(), limit: z.number().int().min(1).max(1_000).default(100) }).strict();
export type ReportPageRequest = z.infer<typeof reportPageRequestSchema>;
export const reportPageSchema = z.object({ runId: reportRecordIdSchema, snapshotId: reportRecordIdSchema, rows: z.array(reportRowSchema).max(1_000), rowCount: z.number().int().nonnegative(), totalRows: z.number().int().nonnegative(), nextCursor: z.string().nullable(), columns: z.array(reportColumnSchema).max(200), totals: z.array(reportTotalSchema).max(200), coverage: z.array(reportSourceCoverageSchema).max(100), missingData: z.array(reportMissingDataSchema).max(200) }).strict();
export type ReportPage = z.infer<typeof reportPageSchema>;
export const reportDrilldownRequestSchema = z.object({ runId: reportRecordIdSchema, rowId: z.string().trim().min(1).max(240), cursor: z.string().max(1_024).nullable().optional(), limit: z.number().int().min(1).max(1_000).default(100) }).strict();
export type ReportDrilldownRequest = z.infer<typeof reportDrilldownRequestSchema>;
export const reportExportRequestSchema = z.object({ runId: reportRecordIdSchema, format: reportingExportFormatSchema, fileName: z.string().trim().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_. -]*$/).optional(), requestId: reportRequestIdSchema.optional() }).strict();
export type ReportExportRequest = z.infer<typeof reportExportRequestSchema>;
export const reportExportJobSchema = z.object({ id: reportRecordIdSchema, runId: reportRecordIdSchema, organizationId: organizationIdSchema, actorId: z.string().trim().min(1).max(240), permissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), state: reportingJobStateSchema, format: reportingExportFormatSchema, fileName: z.string().trim().min(1).max(220), contentType: z.string().trim().min(1).max(120), content: z.string().nullable(), errorCode: z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/).nullable(), createdAt: isoTimestampSchema, readyAt: isoTimestampSchema.nullable(), expiresAt: isoTimestampSchema.nullable() }).strict();
export type ReportExportJob = z.infer<typeof reportExportJobSchema>;

export const reportPresetRevisionSchema = z.object({ revision: z.number().int().positive(), reportId: reportIdSchema, definitionVersion: reportDefinitionVersionSchema, scope: reportScopeSchema, filters: reportFilterValuesSchema, period: reportPeriodSchema, basis: reportingBasisSchema, currency: currencyCodeSchema.nullable(), consolidation: reportConsolidationPolicySchema.nullable(), forecast: reportForecastContextSchema.nullable(), columns: z.array(z.string().regex(reportFieldPattern)).max(200), sort: z.array(reportSortSchema).max(8), createdBy: z.string().trim().min(1).max(240), createdAt: isoTimestampSchema }).strict();
export type ReportPresetRevision = z.infer<typeof reportPresetRevisionSchema>;
export const reportPresetSchema = z.object({ id: reportRecordIdSchema, organizationId: organizationIdSchema, ownerActorId: z.string().trim().min(1).max(240), visibility: reportingVisibilitySchema, name: z.string().trim().min(1).max(160), description: z.string().trim().max(500).nullable(), reportId: reportIdSchema, definitionVersion: reportDefinitionVersionSchema, revision: z.number().int().positive(), current: reportPresetRevisionSchema, createdAt: isoTimestampSchema, updatedAt: isoTimestampSchema }).strict();
export type ReportPreset = z.infer<typeof reportPresetSchema>;
export const reportPackageItemSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,119}$/), title: z.string().trim().min(1).max(200), reportId: reportIdSchema, definitionVersion: reportDefinitionVersionSchema, scope: reportScopeSchema, filters: reportFilterValuesSchema, period: reportPeriodSchema, basis: reportingBasisSchema, currency: currencyCodeSchema.nullable(), consolidation: reportConsolidationPolicySchema.nullable(), forecast: reportForecastContextSchema.nullable(), columns: z.array(z.string().regex(reportFieldPattern)).max(200), sort: z.array(reportSortSchema).max(8) }).strict();
export type ReportPackageItem = z.infer<typeof reportPackageItemSchema>;
export const reportPackageSchema = z.object({ id: reportRecordIdSchema, organizationId: organizationIdSchema, ownerActorId: z.string().trim().min(1).max(240), visibility: reportingVisibilitySchema, name: z.string().trim().min(1).max(160), description: z.string().trim().max(500).nullable(), revision: z.number().int().positive(), items: z.array(reportPackageItemSchema).min(1).max(100), createdAt: isoTimestampSchema, updatedAt: isoTimestampSchema }).strict();
export type ReportPackage = z.infer<typeof reportPackageSchema>;
export const REPORTING_COMPLETENESS = ["complete", "incomplete"] as const;
export type ReportingCompleteness = (typeof REPORTING_COMPLETENESS)[number];
export const reportingCompletenessSchema = z.enum(REPORTING_COMPLETENESS);
export const reportPackageItemRunSchema = z.object({
  itemId: z.string().regex(/^[a-z][a-z0-9-]{1,119}$/), runId: reportRecordIdSchema.nullable(), state: reportingRunStateSchema, errorCode: z.string().nullable(),
  /** Optional on runs stored before completeness was recorded. */
  title: z.string().trim().min(1).max(200).optional(), reportId: reportIdSchema.optional(),
  completeness: reportingCompletenessSchema.optional(), reason: z.string().trim().max(500).nullable().optional(), rowCount: z.number().int().nonnegative().optional(),
}).strict();
export type ReportPackageItemRun = z.infer<typeof reportPackageItemRunSchema>;
export const reportPackageRunSchema = z.object({ id: reportRecordIdSchema, packageId: reportRecordIdSchema, organizationId: organizationIdSchema, actorId: z.string().trim().min(1).max(240), permissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/), state: reportingJobStateSchema, itemRuns: z.array(reportPackageItemRunSchema).max(100), packageRevision: z.number().int().positive().optional(), completeness: reportingCompletenessSchema.optional(), createdAt: isoTimestampSchema, readyAt: isoTimestampSchema.nullable(), expiresAt: isoTimestampSchema.nullable() }).strict();
export type ReportPackageRun = z.infer<typeof reportPackageRunSchema>;

/** A run is complete only when every source is complete and no missing-data
 * item describes an unknown, partial, stale, or unavailable fact. */
export function reportRunCompleteness(input: { readonly coverage: readonly Pick<ReportSourceCoverage, "state">[]; readonly missingData: readonly Pick<ReportMissingData, "state">[] }): ReportingCompleteness {
  if (input.coverage.some(item => item.state !== "complete")) return "incomplete";
  if (input.missingData.some(item => !["verified_zero", "complete", "not_applicable"].includes(item.state))) return "incomplete";
  return "complete";
}

/** Scoped reference choices for report setup. Values are opaque record IDs. */
export const REPORT_REFERENCE_KINDS = ["account", "investor", "owner", "project", "vendor", "staff", "tenant", "tenancy", "elimination_version"] as const;
export type ReportReferenceKind = (typeof REPORT_REFERENCE_KINDS)[number];
export const reportReferenceKindSchema = z.enum(REPORT_REFERENCE_KINDS);
export const reportReferenceQuerySchema = z.object({
  kind: reportReferenceKindSchema,
  search: z.string().trim().max(120).optional(),
  cursor: z.string().max(1_024).nullable().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  legalEntityIds: z.array(legalEntityIdSchema).max(100).default([]),
}).strict();
export type ReportReferenceQuery = z.input<typeof reportReferenceQuerySchema>;
export const reportReferenceOptionSchema = z.object({ value: z.string().trim().min(1).max(240), label: z.string().trim().min(1).max(240), detail: z.string().trim().max(240).nullable() }).strict();
export type ReportReferenceOption = z.infer<typeof reportReferenceOptionSchema>;
export const reportReferencePageSchema = z.object({ kind: reportReferenceKindSchema, items: z.array(reportReferenceOptionSchema).max(100), nextCursor: z.string().nullable(), reason: z.string().trim().max(500).nullable() }).strict();
export type ReportReferencePage = z.infer<typeof reportReferencePageSchema>;
/** Maps a filter's reference family to the server lookup that supplies it.
 * Entity, property and unit choices come from the company context instead. */
export function reportReferenceKindForFilter(filter: Pick<ReportingFilterDefinition, "reference">): ReportReferenceKind | null {
  switch (filter.reference) {
    case "account": return "account";
    case "investor": return "investor";
    case "owner": return "owner";
    case "project": return "project";
    case "vendor": return "vendor";
    case "staff": return "staff";
    case "tenant": case "person": return "tenant";
    case "tenancy": return "tenancy";
    default: return null;
  }
}

export interface ReportingEngineContext { readonly runId: string; readonly snapshotId: string; readonly request: ReportRunRequest; readonly definition: ReportDefinition; readonly now: IsoTimestamp; }
export interface ReportingEngineResult { readonly columns: readonly ReportColumn[]; readonly rows: readonly ReportRow[]; readonly totals?: readonly ReportTotal[]; readonly coverage: readonly ReportSourceCoverage[]; readonly missingData?: readonly ReportMissingData[]; readonly drilldowns?: readonly ReportDrilldown[]; }
/** Report-specific setup sections. Hidden sections never contribute fields
 * to a run request. */
export const REPORTING_ENTITY_SCOPE_RULES = ["optional", "one_or_more", "exactly_one"] as const;
export type ReportingEntityScopeRule = (typeof REPORTING_ENTITY_SCOPE_RULES)[number];
export const reportSetupSchema = z.object({ entityScope: z.enum(REPORTING_ENTITY_SCOPE_RULES), propertyScope: z.boolean(), forecastScenario: z.boolean(), consolidation: z.boolean() }).strict();
export type ReportSetup = z.infer<typeof reportSetupSchema>;
export interface ReportDefinition { readonly id: ReportId; readonly version: string; readonly title: string; readonly category: ReportingCategory; readonly source: ReportingSource; readonly setup: ReportSetup; readonly period: ReportingPeriodMode; readonly basis: readonly ReportingBasis[]; readonly actuality: ReportingActuality; readonly scopes: readonly ReportingScopeKind[]; readonly requiredSources: readonly string[]; readonly filters: readonly ReportingFilterDefinition[]; readonly columns: readonly ReportColumn[]; readonly supportedExports: readonly ReportingExportFormat[]; readonly drilldownKinds: readonly string[]; readonly engineKey: string; readonly dependencies: readonly string[]; }
export interface ReportEntry extends ReportDefinition { readonly executable: boolean; readonly runtimeStatus: ReportingRuntimeStatus; readonly runtimeReason: string | null; readonly runtimeDependency: string | null; }
export const reportingDefinitionSchema = z.object({ id: reportIdSchema, version: reportDefinitionVersionSchema, title: z.string().trim().min(1).max(200), category: reportingCategorySchema, source: reportingSourceSchema, setup: reportSetupSchema, period: reportingPeriodModeSchema, basis: z.array(reportingBasisSchema).min(1), actuality: reportingActualitySchema, scopes: z.array(reportingScopeKindSchema).min(1), requiredSources: z.array(z.string().trim().min(1).max(160)).min(1), filters: z.array(reportingFilterDefinitionSchema), columns: z.array(reportColumnSchema), supportedExports: z.array(reportingExportFormatSchema), drilldownKinds: z.array(z.string().trim().min(1).max(80)), engineKey: z.string().regex(/^[a-z][a-z0-9_.:-]{0,119}$/), dependencies: z.array(z.string().trim().min(1).max(160)) }).strict();
export const reportEntrySchema = reportingDefinitionSchema.extend({ executable: z.boolean(), runtimeStatus: reportingRuntimeStatusSchema, runtimeReason: z.string().nullable(), runtimeDependency: z.string().nullable() }).strict().superRefine((value, context) => {
  if (value.executable !== (value.runtimeStatus === "available")) context.addIssue({ code: "custom", path: ["executable"], message: "Only available reports are executable" });
  if (value.runtimeStatus !== "available" && !value.runtimeReason) context.addIssue({ code: "custom", path: ["runtimeReason"], message: "Unavailable reports need an exact reason" });
});
export type ReportIdentity = Pick<ReportDefinition, "id" | "version">;
export type ReportingPrincipalScope = CompanyScope & { readonly legalEntityId?: LegalEntityId; readonly propertyId?: PropertyReferenceId };
export type ReportingMoney = { readonly amountCents: MoneyCents; readonly currency: CurrencyCode };
export type ReportingIds = { readonly organizationId: OrganizationId; readonly legalEntityIds: readonly LegalEntityId[] };
export type ReportingDate = IsoDate;
export type ReportingMonth = IsoMonth;
export type ReportingTimestamp = IsoTimestamp;
export function parseReportMoney(amountCents: unknown, currency: unknown): ReportingMoney { return { amountCents: centsSchema.parse(amountCents), currency: currencyCodeSchema.parse(currency) }; }
export function parseReportDefinition(value: unknown): ReportDefinition { return reportingDefinitionSchema.parse(value); }
export function parseReportRunRequest(value: unknown): ReportRunRequest { return reportRunRequestSchema.parse(value); }
export function companyScopeForReport(scope: ReportScope, legalEntityId?: LegalEntityId, propertyId?: PropertyReferenceId): CompanyScope { return companyScopeSchema.parse({ organizationId: scope.organizationId, ...(legalEntityId ? { legalEntityId } : {}), ...(propertyId ? { propertyId } : {}) }); }
