import { z } from "zod";
import {
  centsFromBigInt,
  centsSchema,
  centsToBigInt,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  recordReferenceIdSchema,
  revisionSchema,
  type CompanyScope,
  type CurrencyCode,
  type IsoDate,
  type MoneyCents,
  type Revision,
} from "../company";
import {
  financialSourceReferenceSchema,
  type FinancialSourceReference,
} from "../accounting/source";
import { projectIdSchema, type ProjectId } from "./contracts";

/**
 * Whole-deal costs intentionally live beside the existing rehab project
 * records. The ledger is a classification and planning surface; it never
 * posts to QuickBooks and it never treats a funding movement as an expense.
 */
export type ProjectDealCostId = string & { readonly __brand: "ProjectDealCostId" };
export type ProjectDealFundingId = string & { readonly __brand: "ProjectDealFundingId" };
export type ProjectDealSaleForecastId = string & { readonly __brand: "ProjectDealSaleForecastId" };

export const projectDealCostIdSchema = z.string().uuid().transform((value) => value as ProjectDealCostId);
export const projectDealFundingIdSchema = z.string().uuid().transform((value) => value as ProjectDealFundingId);
export const projectDealSaleForecastIdSchema = z.string().uuid().transform((value) => value as ProjectDealSaleForecastId);

export const DEAL_COST_LANES = ["acquisition", "unallocated", "rehab", "financing", "holding", "selling"] as const;
export type DealCostLane = (typeof DEAL_COST_LANES)[number];
export const dealCostLaneSchema = z.enum(DEAL_COST_LANES);

export const DEAL_LEDGER_ENTRY_KINDS = ["cost", "funding", "sale_forecast"] as const;
export type DealLedgerEntryKind = (typeof DEAL_LEDGER_ENTRY_KINDS)[number];
export const dealLedgerEntryKindSchema = z.enum(DEAL_LEDGER_ENTRY_KINDS);

export const DEAL_COST_SOURCE_KINDS = ["qbo", "operational", "manual", "estimate"] as const;
export type DealCostSourceKind = (typeof DEAL_COST_SOURCE_KINDS)[number];
export const dealCostSourceKindSchema = z.enum(DEAL_COST_SOURCE_KINDS);

export const DEAL_RECONCILIATION_STATES = ["unreconciled", "source_backed", "qbo_verified", "void"] as const;
export type DealReconciliationState = (typeof DEAL_RECONCILIATION_STATES)[number];
export const dealReconciliationStateSchema = z.enum(DEAL_RECONCILIATION_STATES);

export const DEAL_FUNDING_KINDS = [
  "deposit",
  "loan_principal",
  "reserve",
  "contribution",
  "intercompany",
  "sale_proceeds",
  "settlement_clearing",
] as const;
export type DealFundingKind = (typeof DEAL_FUNDING_KINDS)[number];
export const dealFundingKindSchema = z.enum(DEAL_FUNDING_KINDS);

export const DEAL_COVERAGE_STATES = ["unavailable", "partial", "complete"] as const;
export type DealCoverageState = (typeof DEAL_COVERAGE_STATES)[number];
export const dealCoverageStateSchema = z.enum(DEAL_COVERAGE_STATES);

export const DEAL_PROFIT_STATES = ["unknown", "partial", "complete"] as const;
export type DealProfitState = (typeof DEAL_PROFIT_STATES)[number];
export const dealProfitStateSchema = z.enum(DEAL_PROFIT_STATES);

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const nonNegativeCents = centsSchema.refine((value) => centsToBigInt(value) >= BigInt(0), "Expected non-negative cents");
const nullableMoney = centsSchema.nullable();
const nullableDate = isoDateSchema.nullable();
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/, "Source reference hash must be a lowercase SHA-256 hex digest");

/** A settlement proof is evidence of cash settlement, never evidence of posting. */
export const dealSettlementProofSchema = z.object({
  kind: z.enum(["qbo", "plaid", "document", "manual"]),
  reference: text(255),
  observedOn: isoDateSchema,
  amountCents: nonNegativeCents.nullable(),
}).strict();
export type DealSettlementProof = z.infer<typeof dealSettlementProofSchema>;

const sourceFields = {
  sourceKind: dealCostSourceKindSchema,
  reconciliationState: dealReconciliationStateSchema,
  sourceRecordRef: recordReferenceIdSchema.nullable(),
  sourceReferenceHash: sourceHash.nullable(),
  source: financialSourceReferenceSchema.nullable(),
  settlementProof: dealSettlementProofSchema.nullable(),
} as const;

const costValueFields = {
  budgetCents: nonNegativeCents.nullable(),
  amountCents: nullableMoney,
  forecastCents: nonNegativeCents.nullable(),
  paidCents: nonNegativeCents.nullable(),
  incurredOn: nullableDate,
  paidOn: nullableDate,
  prepaid: z.boolean(),
} as const;

function assertCostEvidence(value: {
  sourceKind: DealCostSourceKind;
  reconciliationState: DealReconciliationState;
  source: FinancialSourceReference | null;
  sourceRecordRef: string | null;
  sourceReferenceHash: string | null;
  settlementProof: DealSettlementProof | null;
  amountCents: MoneyCents | null;
  budgetCents: MoneyCents | null;
  forecastCents: MoneyCents | null;
  paidCents: MoneyCents | null;
  paidOn: string | null;
}, context: z.RefinementCtx): void {
  if (value.budgetCents === null && value.amountCents === null && value.forecastCents === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "A deal cost needs a budget, incurred amount or forecast" });
  }
  if (value.sourceKind === "qbo" && value.source === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "QBO deal costs require the full source identity" });
  }
  if (value.reconciliationState === "qbo_verified" && (value.sourceKind !== "qbo" || value.source === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reconciliationState"], message: "QBO verified costs require a QBO source identity" });
  }
  if (value.source !== null && value.sourceKind !== "qbo") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceKind"], message: "Only QBO costs may carry a financial source identity" });
  }
  if (value.reconciliationState === "source_backed"
    && value.sourceRecordRef === null && value.sourceReferenceHash === null && value.settlementProof === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reconciliationState"], message: "Source-backed costs require a source record, evidence hash or settlement proof" });
  }
  if (value.sourceKind === "estimate" && value.reconciliationState === "qbo_verified") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceKind"], message: "Estimates cannot be QBO verified" });
  }
  if (value.sourceKind === "manual" && value.source !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "Manual costs cannot carry a QBO source identity" });
  }
  if (value.sourceKind === "operational" && value.source === null && value.sourceRecordRef === null && value.sourceReferenceHash === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRecordRef"], message: "Operational costs need a source record or evidence hash" });
  }
  if (value.sourceKind === "estimate" && value.amountCents !== null && centsToBigInt(value.amountCents) !== BigInt(0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "Estimates must use remaining forecast, with zero or unknown incurred amount" });
  }
  if (value.sourceKind === "estimate" && value.reconciliationState !== "unreconciled" && value.reconciliationState !== "void") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reconciliationState"], message: "Estimates cannot be source-backed actuals" });
  }
  if (value.paidCents !== null && centsToBigInt(value.paidCents) > BigInt(0) && value.settlementProof === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["settlementProof"], message: "Paid costs require settlement evidence" });
  }
  if (value.paidCents !== null && value.paidOn === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["paidOn"], message: "Paid costs require paidOn" });
  }
}

export const projectDealCostSchema = z.object({
  id: projectDealCostIdSchema,
  projectId: projectIdSchema,
  entryKind: z.literal("cost"),
  lane: dealCostLaneSchema,
  description: text(300),
  vendorName: z.string().trim().max(200).nullable(),
  ...costValueFields,
  ...sourceFields,
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine(assertCostEvidence);
export type ProjectDealCost = z.infer<typeof projectDealCostSchema>;

export const projectDealFundingSchema = z.object({
  id: projectDealFundingIdSchema,
  projectId: projectIdSchema,
  entryKind: z.literal("funding"),
  fundingKind: dealFundingKindSchema,
  description: text(300),
  amountCents: centsSchema,
  fundedOn: isoDateSchema,
  ...sourceFields,
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.sourceKind === "qbo" && value.source === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "QBO funding requires the full source identity" });
  if (value.reconciliationState === "qbo_verified" && (value.sourceKind !== "qbo" || value.source === null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reconciliationState"], message: "QBO verified funding requires a QBO source identity" });
  if (value.source !== null && value.sourceKind !== "qbo") context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceKind"], message: "Only QBO funding may carry a financial source identity" });
  if (value.reconciliationState === "source_backed" && value.sourceRecordRef === null && value.sourceReferenceHash === null && value.settlementProof === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reconciliationState"], message: "Source-backed funding requires a source record, evidence hash or settlement proof" });
  if (value.sourceKind === "manual" && value.source !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "Manual funding cannot carry a QBO source identity" });
  if (value.sourceKind === "operational" && value.source === null && value.sourceRecordRef === null && value.sourceReferenceHash === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRecordRef"], message: "Operational funding needs a source record or evidence hash" });
});
export type ProjectDealFunding = z.infer<typeof projectDealFundingSchema>;

export const projectDealSaleForecastSchema = z.object({
  id: projectDealSaleForecastIdSchema,
  projectId: projectIdSchema,
  entryKind: z.literal("sale_forecast"),
  grossProceedsCents: nonNegativeCents,
  saleOn: isoDateSchema.nullable(),
  sourceKind: z.literal("estimate"),
  reconciliationState: z.literal("unreconciled"),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict();
export type ProjectDealSaleForecast = z.infer<typeof projectDealSaleForecastSchema>;

const costInputFields = {
  lane: dealCostLaneSchema,
  description: text(300),
  vendorName: optionalText(200),
  budgetCents: nonNegativeCents.nullable().optional(),
  amountCents: nullableMoney.optional(),
  forecastCents: nonNegativeCents.nullable().optional(),
  paidCents: nonNegativeCents.nullable().optional(),
  incurredOn: nullableDate.optional(),
  paidOn: nullableDate.optional(),
  prepaid: z.boolean().optional(),
  sourceKind: dealCostSourceKindSchema.optional(),
  reconciliationState: dealReconciliationStateSchema.optional(),
  sourceRecordRef: recordReferenceIdSchema.nullable().optional(),
  sourceReferenceHash: sourceHash.nullable().optional(),
  source: financialSourceReferenceSchema.nullable().optional(),
  settlementProof: dealSettlementProofSchema.nullable().optional(),
} as const;

export const createProjectDealCostPayloadSchema = z.object({
  projectId: projectIdSchema,
  ...costInputFields,
}).strict().transform((value) => ({
  ...value,
  vendorName: value.vendorName ?? null,
  budgetCents: value.budgetCents ?? null,
  amountCents: value.amountCents ?? null,
  forecastCents: value.forecastCents ?? null,
  paidCents: value.paidCents ?? null,
  incurredOn: value.incurredOn ?? null,
  paidOn: value.paidOn ?? null,
  prepaid: value.prepaid ?? false,
  sourceKind: value.sourceKind ?? "manual" as const,
  reconciliationState: value.reconciliationState ?? "unreconciled" as const,
  sourceRecordRef: value.sourceRecordRef ?? null,
  sourceReferenceHash: value.sourceReferenceHash ?? null,
  source: value.source ?? null,
  settlementProof: value.settlementProof ?? null,
})).superRefine(assertCostEvidence);
export type CreateProjectDealCostPayload = z.output<typeof createProjectDealCostPayloadSchema>;

export const updateProjectDealCostPayloadSchema = z.object({
  dealCostId: projectDealCostIdSchema,
  lane: dealCostLaneSchema.optional(),
  description: text(300).optional(),
  vendorName: optionalText(200),
  budgetCents: nonNegativeCents.nullable().optional(),
  amountCents: nullableMoney.optional(),
  forecastCents: nonNegativeCents.nullable().optional(),
  paidCents: nonNegativeCents.nullable().optional(),
  incurredOn: nullableDate.optional(),
  paidOn: nullableDate.optional(),
  prepaid: z.boolean().optional(),
  sourceKind: dealCostSourceKindSchema.optional(),
  reconciliationState: dealReconciliationStateSchema.optional(),
  sourceRecordRef: recordReferenceIdSchema.nullable().optional(),
  sourceReferenceHash: sourceHash.nullable().optional(),
  source: financialSourceReferenceSchema.nullable().optional(),
  settlementProof: dealSettlementProofSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length <= 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one deal cost field is required" });
});
export type UpdateProjectDealCostPayload = z.infer<typeof updateProjectDealCostPayloadSchema>;

export const archiveProjectDealCostPayloadSchema = z.object({ dealCostId: projectDealCostIdSchema }).strict();
export type ArchiveProjectDealCostPayload = z.infer<typeof archiveProjectDealCostPayloadSchema>;

const fundingInputFields = {
  fundingKind: dealFundingKindSchema,
  description: text(300),
  amountCents: centsSchema,
  fundedOn: isoDateSchema,
  sourceKind: dealCostSourceKindSchema.optional(),
  reconciliationState: dealReconciliationStateSchema.optional(),
  sourceRecordRef: recordReferenceIdSchema.nullable().optional(),
  sourceReferenceHash: sourceHash.nullable().optional(),
  source: financialSourceReferenceSchema.nullable().optional(),
  settlementProof: dealSettlementProofSchema.nullable().optional(),
} as const;

export const createProjectDealFundingPayloadSchema = z.object({
  projectId: projectIdSchema,
  ...fundingInputFields,
}).strict().transform((value) => ({
  ...value,
  sourceKind: value.sourceKind ?? "manual" as const,
  reconciliationState: value.reconciliationState ?? "unreconciled" as const,
  sourceRecordRef: value.sourceRecordRef ?? null,
  sourceReferenceHash: value.sourceReferenceHash ?? null,
  source: value.source ?? null,
  settlementProof: value.settlementProof ?? null,
}));
export type CreateProjectDealFundingPayload = z.output<typeof createProjectDealFundingPayloadSchema>;

export const updateProjectDealFundingPayloadSchema = z.object({
  dealFundingId: projectDealFundingIdSchema,
  fundingKind: dealFundingKindSchema.optional(),
  description: text(300).optional(),
  amountCents: centsSchema.optional(),
  fundedOn: isoDateSchema.optional(),
  sourceKind: dealCostSourceKindSchema.optional(),
  reconciliationState: dealReconciliationStateSchema.optional(),
  sourceRecordRef: recordReferenceIdSchema.nullable().optional(),
  sourceReferenceHash: sourceHash.nullable().optional(),
  source: financialSourceReferenceSchema.nullable().optional(),
  settlementProof: dealSettlementProofSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length <= 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one deal funding field is required" });
});
export type UpdateProjectDealFundingPayload = z.infer<typeof updateProjectDealFundingPayloadSchema>;

export const archiveProjectDealFundingPayloadSchema = z.object({ dealFundingId: projectDealFundingIdSchema }).strict();
export type ArchiveProjectDealFundingPayload = z.infer<typeof archiveProjectDealFundingPayloadSchema>;

export const setProjectDealSaleForecastPayloadSchema = z.object({
  projectId: projectIdSchema,
  grossProceedsCents: nonNegativeCents,
  saleOn: isoDateSchema.nullable().optional(),
}).strict().transform((value) => ({ ...value, saleOn: value.saleOn ?? null }));
export type SetProjectDealSaleForecastPayload = z.output<typeof setProjectDealSaleForecastPayloadSchema>;

export const PROJECT_DEAL_COST_COMMAND_KINDS = [
  "project.deal_cost.create",
  "project.deal_cost.update",
  "project.deal_cost.archive",
  "project.deal_funding.create",
  "project.deal_funding.update",
  "project.deal_funding.archive",
  "project.deal_sale_forecast.set",
] as const;
export type ProjectDealCostCommandKind = (typeof PROJECT_DEAL_COST_COMMAND_KINDS)[number];

export const projectDealCostCommandPayloadSchemas = {
  "project.deal_cost.create": createProjectDealCostPayloadSchema,
  "project.deal_cost.update": updateProjectDealCostPayloadSchema,
  "project.deal_cost.archive": archiveProjectDealCostPayloadSchema,
  "project.deal_funding.create": createProjectDealFundingPayloadSchema,
  "project.deal_funding.update": updateProjectDealFundingPayloadSchema,
  "project.deal_funding.archive": archiveProjectDealFundingPayloadSchema,
  "project.deal_sale_forecast.set": setProjectDealSaleForecastPayloadSchema,
} as const;

export type ProjectDealCostCommandPayload = {
  [K in ProjectDealCostCommandKind]: z.output<(typeof projectDealCostCommandPayloadSchemas)[K]>;
};

export const projectDealCostQuerySchema = z.object({
  scope: companyScopeSchema,
  projectId: projectIdSchema,
  asOf: isoDateSchema.optional(),
}).strict();
export type ProjectDealCostQuery = z.infer<typeof projectDealCostQuerySchema>;

export const projectDealCostLaneTotalsSchema = z.object({
  lane: dealCostLaneSchema,
  budgetCents: nullableMoney,
  incurredCents: nullableMoney,
  paidCents: nullableMoney,
  prepaidCents: nullableMoney,
  remainingForecastCents: nullableMoney,
  finalCostCents: nullableMoney,
  coverage: dealCoverageStateSchema,
  unknownEntryCount: z.number().int().nonnegative(),
  qboVerifiedCents: nullableMoney,
  sourceBackedCents: nullableMoney,
  estimatedCents: nullableMoney,
}).strict();
export type ProjectDealCostLaneTotals = z.infer<typeof projectDealCostLaneTotalsSchema>;

export const projectDealCostTotalsSchema = z.object({
  budgetCents: nullableMoney,
  incurredCents: nullableMoney,
  paidCents: nullableMoney,
  prepaidCents: nullableMoney,
  remainingForecastCents: nullableMoney,
  finalCostCents: nullableMoney,
}).strict();
export type ProjectDealCostTotals = z.infer<typeof projectDealCostTotalsSchema>;

export const projectDealFundingTotalsSchema = z.object({
  fundingKind: dealFundingKindSchema,
  amountCents: nullableMoney,
}).strict();
export type ProjectDealFundingTotals = z.infer<typeof projectDealFundingTotalsSchema>;

export const projectDealSaleForecastReportSchema = z.object({
  grossProceedsCents: nullableMoney,
  saleOn: isoDateSchema.nullable(),
  sellingCostCents: nullableMoney,
  netSaleProceedsCents: nullableMoney,
  projectedProfitCents: nullableMoney,
  profitState: dealProfitStateSchema,
}).strict();
export type ProjectDealSaleForecastReport = z.infer<typeof projectDealSaleForecastReportSchema>;

export const projectDealCoverageSchema = z.object({
  status: dealCoverageStateSchema,
  qboStatus: dealCoverageStateSchema,
  totalCostEntryCount: z.number().int().nonnegative(),
  qboVerifiedEntryCount: z.number().int().nonnegative(),
  sourceBackedEntryCount: z.number().int().nonnegative(),
  estimatedEntryCount: z.number().int().nonnegative(),
  unknownEntryIds: z.array(z.string().uuid()).max(10_000),
  unknownFields: z.array(z.string().min(1).max(200)).max(1_000),
  warnings: z.array(z.string().min(1).max(500)).max(1_000),
}).strict();
export type ProjectDealCoverage = z.infer<typeof projectDealCoverageSchema>;

export const projectDealCostReportSchema = z.object({
  projectId: projectIdSchema,
  currency: currencyCodeSchema,
  asOf: isoDateSchema,
  costs: z.array(projectDealCostSchema).max(10_000),
  funding: z.array(projectDealFundingSchema).max(10_000),
  saleForecast: projectDealSaleForecastReportSchema,
  byLane: z.array(projectDealCostLaneTotalsSchema).length(DEAL_COST_LANES.length),
  totals: projectDealCostTotalsSchema,
  fundingTotals: z.array(projectDealFundingTotalsSchema).length(DEAL_FUNDING_KINDS.length),
  coverage: projectDealCoverageSchema,
}).strict();
export type ProjectDealCostReport = z.infer<typeof projectDealCostReportSchema>;

export interface ProjectDealCostCalculationInput {
  readonly projectId: ProjectId;
  readonly currency: CurrencyCode;
  readonly asOf: IsoDate;
  readonly costs: readonly ProjectDealCost[];
  readonly funding: readonly ProjectDealFunding[];
  readonly saleForecast: ProjectDealSaleForecast | null;
  readonly qboStatus?: DealCoverageState;
  /** The approved lender rehab baseline, owned by the existing budget workflow. */
  readonly rehabBudgetCents?: MoneyCents | null;
  /** The canonical rehab cost-to-complete, owned by the existing cost report. */
  readonly rehabRemainingForecastCents?: MoneyCents | null;
}

function sumKnown(values: readonly (MoneyCents | null)[]): MoneyCents | null {
  const known = values.filter((value): value is MoneyCents => value !== null);
  return known.length === 0 ? null : centsFromBigInt(known.reduce((total, value) => total + centsToBigInt(value), BigInt(0)));
}

function sumAll(values: readonly (MoneyCents | null)[]): MoneyCents | null {
  return values.length === 0 || values.some((value) => value === null) ? null : centsFromBigInt(values.reduce((total, value) => total + centsToBigInt(value!), BigInt(0)));
}

function laneTotals(lane: DealCostLane, costs: readonly ProjectDealCost[], unknownFields: string[], remainingForecastOverride?: MoneyCents | null): ProjectDealCostLaneTotals {
  const rows = costs.filter((entry) => entry.lane === lane && entry.archivedAt === null && entry.reconciliationState !== "void");
  const budget = sumKnown(rows.map((entry) => entry.budgetCents));
  const verifiedRows = rows.filter((entry) => !entry.prepaid && entry.lane !== "unallocated" && entry.sourceKind !== "estimate" && (entry.reconciliationState === "qbo_verified" || entry.reconciliationState === "source_backed"));
  const incurred = sumKnown(verifiedRows.map((entry) => entry.amountCents));
  const paid = sumKnown(rows.map((entry) => entry.settlementProof === null && entry.paidCents !== "0" ? null : entry.paidCents));
  const prepaid = sumKnown(rows.filter((entry) => entry.prepaid && (entry.reconciliationState === "qbo_verified" || entry.reconciliationState === "source_backed")).map((entry) => entry.amountCents));
  const externalForecastKnown = remainingForecastOverride !== undefined && remainingForecastOverride !== null;
  const remainingForecast = remainingForecastOverride !== undefined ? remainingForecastOverride : sumKnown(rows.map((entry) => entry.forecastCents));
  const finalCost = rows.length === 0 || rows.some((entry) => entry.lane === "unallocated" || (!entry.prepaid && entry.amountCents === null) || (!externalForecastKnown && entry.forecastCents === null) || (entry.reconciliationState === "unreconciled" && entry.sourceKind !== "estimate"))
    ? null
    : externalForecastKnown
      ? (incurred === null ? null : centsFromBigInt(centsToBigInt(incurred) + centsToBigInt(remainingForecastOverride!)))
      : sumAll(rows.map((entry) => (!entry.prepaid && entry.amountCents === null) || entry.forecastCents === null
      ? null
      : centsFromBigInt((entry.prepaid ? BigInt(0) : centsToBigInt(entry.amountCents!)) + centsToBigInt(entry.forecastCents))));
  const unknownEntryIds = rows.filter((entry) => (!entry.prepaid && entry.amountCents === null) || (!externalForecastKnown && entry.forecastCents === null) || entry.lane === "unallocated" || (entry.reconciliationState === "unreconciled" && entry.sourceKind !== "estimate")).map((entry) => String(entry.id));
  if (rows.length > 0 && budget === null) unknownFields.push(`${lane}.budgetCents`);
  if (rows.length > 0 && incurred === null) unknownFields.push(`${lane}.incurredCents`);
  if (rows.length > 0 && paid === null) unknownFields.push(`${lane}.paidCents`);
  if (rows.length > 0 && prepaid === null) unknownFields.push(`${lane}.prepaidCents`);
  if (rows.length > 0 && remainingForecast === null) unknownFields.push(`${lane}.remainingForecastCents`);
  if (rows.length > 0 && finalCost === null) unknownFields.push(`${lane}.finalCostCents`);
  const qboVerified = sumKnown(verifiedRows.filter((entry) => entry.reconciliationState === "qbo_verified").map((entry) => entry.amountCents));
  const sourceBacked = sumKnown(verifiedRows.filter((entry) => entry.reconciliationState === "source_backed").map((entry) => entry.amountCents));
  const estimated = sumKnown(rows.filter((entry) => entry.sourceKind === "estimate").map((entry) => entry.forecastCents));
  const coverage: DealCoverageState = rows.length === 0 ? "unavailable" : unknownEntryIds.length === 0 ? "complete" : "partial";
  return projectDealCostLaneTotalsSchema.parse({
    lane, budgetCents: budget, incurredCents: incurred, paidCents: paid, prepaidCents: prepaid,
    remainingForecastCents: remainingForecast, finalCostCents: finalCost,
    coverage, unknownEntryCount: unknownEntryIds.length,
    qboVerifiedCents: qboVerified, sourceBackedCents: sourceBacked, estimatedCents: estimated,
  });
}

/**
 * Pure whole-deal projection. It deliberately withholds profit whenever an
 * active cost row or the sale forecast is incomplete; a partial report never
 * becomes an optimistic profit number by treating missing values as zero.
 */
export function calculateProjectDealCostReport(input: ProjectDealCostCalculationInput): ProjectDealCostReport {
  const costs = input.costs.filter((entry) => entry.archivedAt === null && entry.reconciliationState !== "void").map((entry) => ({
    ...entry,
    amountCents: entry.incurredOn !== null && entry.incurredOn > input.asOf ? null : entry.amountCents,
    paidCents: entry.paidOn !== null && entry.paidOn > input.asOf ? null : entry.paidCents,
  })).filter((entry) => entry.amountCents !== null || entry.budgetCents !== null || entry.forecastCents !== null);
  const funding = input.funding.filter((entry) => entry.archivedAt === null && entry.reconciliationState !== "void" && entry.fundedOn <= input.asOf);
  const unknownFields: string[] = [];
  const byLane = DEAL_COST_LANES.map((lane) => {
    const result = laneTotals(lane, costs, unknownFields, lane === "rehab" ? input.rehabRemainingForecastCents : undefined);
    const withBudget = lane === "rehab" && input.rehabBudgetCents !== undefined
      ? { ...result, budgetCents: input.rehabBudgetCents, coverage: result.coverage === "unavailable" && input.rehabBudgetCents !== null ? "partial" as const : result.coverage }
      : result;
    return withBudget;
  });
  const requiredLanes = byLane.filter((lane) => lane.lane !== "unallocated");
  const missingRequiredLanes = requiredLanes.filter((lane) => lane.coverage !== "complete");
  for (const lane of missingRequiredLanes) unknownFields.push(`${lane.lane}.coverage`);
  if (input.rehabBudgetCents !== undefined && input.rehabBudgetCents !== null) {
    const index = unknownFields.indexOf("rehab.budgetCents");
    if (index >= 0) unknownFields.splice(index, 1);
  }
  if (input.rehabRemainingForecastCents !== undefined && input.rehabRemainingForecastCents !== null) {
    const index = unknownFields.indexOf("rehab.remainingForecastCents");
    if (index >= 0) unknownFields.splice(index, 1);
  }
  const totals = projectDealCostTotalsSchema.parse({
    budgetCents: sumKnown(byLane.map((lane) => lane.budgetCents)),
    incurredCents: sumKnown(byLane.map((lane) => lane.incurredCents)),
    paidCents: sumKnown(byLane.map((lane) => lane.paidCents)),
    prepaidCents: sumKnown(byLane.map((lane) => lane.prepaidCents)),
    remainingForecastCents: sumKnown(byLane.map((lane) => lane.remainingForecastCents)),
    finalCostCents: costs.some((entry) => entry.lane === "unallocated") ? null : sumAll(byLane.filter((lane) => lane.lane !== "unallocated").map((lane) => lane.finalCostCents)),
  });
  if (totals.budgetCents === null) unknownFields.push("totals.budgetCents");
  if (totals.incurredCents === null) unknownFields.push("totals.incurredCents");
  if (totals.paidCents === null) unknownFields.push("totals.paidCents");
  if (totals.prepaidCents === null) unknownFields.push("totals.prepaidCents");
  if (totals.remainingForecastCents === null) unknownFields.push("totals.remainingForecastCents");
  if (totals.finalCostCents === null) unknownFields.push("totals.finalCostCents");

  const fundingTotals = DEAL_FUNDING_KINDS.map((fundingKind) => projectDealFundingTotalsSchema.parse({
    fundingKind,
    amountCents: sumKnown(funding.filter((entry) => entry.fundingKind === fundingKind).map((entry) => entry.amountCents)),
  }));
  const saleGross = input.saleForecast?.grossProceedsCents ?? null;
  const sellingLane = byLane.find((lane) => lane.lane === "selling")!;
  const sellingCost = sellingLane.finalCostCents;
  const netSale = saleGross === null || sellingCost === null ? null : centsFromBigInt(centsToBigInt(saleGross) - centsToBigInt(sellingCost));
  const nonSellingFinals = byLane.filter((lane) => lane.lane !== "selling" && lane.lane !== "unallocated").map((lane) => lane.finalCostCents);
  const allFinalsKnown = nonSellingFinals.every((value) => value !== null);
  const profit = netSale === null || !allFinalsKnown || missingRequiredLanes.length > 0 || input.qboStatus !== "complete" || unknownFields.some((field) => field.includes("unallocated")) || costs.some((entry) => entry.lane === "unallocated")
    ? null
    : centsFromBigInt(centsToBigInt(netSale) - nonSellingFinals.reduce((total, value) => total + centsToBigInt(value!), BigInt(0)));
  if (saleGross === null) unknownFields.push("saleForecast.grossProceedsCents");
  if (sellingCost === null) unknownFields.push("saleForecast.sellingCostCents");
  if (profit === null) unknownFields.push("saleForecast.projectedProfitCents");

  const activeRows = costs;
  const qboVerifiedEntryCount = activeRows.filter((entry) => entry.reconciliationState === "qbo_verified").length;
  const sourceBackedEntryCount = activeRows.filter((entry) => entry.reconciliationState === "source_backed").length;
  const estimatedEntryCount = activeRows.filter((entry) => entry.sourceKind === "estimate").length;
  const rehabForecastKnown = input.rehabRemainingForecastCents !== undefined && input.rehabRemainingForecastCents !== null;
  const unknownEntryIds = activeRows.filter((entry) => (!entry.prepaid && entry.amountCents === null)
    || ((!rehabForecastKnown || entry.lane !== "rehab") && entry.forecastCents === null)
    || entry.lane === "unallocated"
    || (entry.reconciliationState === "unreconciled" && entry.sourceKind !== "estimate")).map((entry) => String(entry.id));
  const qboStatus = input.qboStatus ?? (qboVerifiedEntryCount > 0 ? "partial" : "unavailable");
  const status: DealCoverageState = activeRows.length === 0 && qboStatus === "unavailable" && (input.rehabBudgetCents === undefined || input.rehabBudgetCents === null)
    ? "unavailable"
    : unknownEntryIds.length === 0 && missingRequiredLanes.length === 0 && qboStatus === "complete" ? "complete" : "partial";
  const warnings = [
    ...(qboStatus !== "complete" ? ["QuickBooks coverage is not complete for this deal."] : []),
    ...(estimatedEntryCount > 0 ? ["One or more cost rows are estimates rather than source-backed actuals."] : []),
    ...(unknownEntryIds.length > 0 ? ["Missing incurred or remaining forecast values are withheld from final cost and profit."] : []),
    ...(missingRequiredLanes.length > 0 ? ["One or more required cost lanes do not have complete coverage."] : []),
  ];
  const coverage = projectDealCoverageSchema.parse({
    status, qboStatus, totalCostEntryCount: activeRows.length,
    qboVerifiedEntryCount, sourceBackedEntryCount, estimatedEntryCount,
    unknownEntryIds, unknownFields: Array.from(new Set(unknownFields)), warnings,
  });
  return projectDealCostReportSchema.parse({
    projectId: input.projectId, currency: input.currency, asOf: input.asOf,
    costs, funding,
    saleForecast: {
      grossProceedsCents: saleGross,
      saleOn: input.saleForecast?.saleOn ?? null,
      sellingCostCents: sellingCost,
      netSaleProceedsCents: netSale,
      projectedProfitCents: profit,
      profitState: profit !== null ? "complete" : saleGross === null ? "unknown" : "partial",
    },
    byLane, totals, fundingTotals, coverage,
  });
}
