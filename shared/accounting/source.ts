import { z } from "zod";
import {
  centsSchema,
  companyScopeSchema,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  type CompanyScope,
  type CurrencyCode,
  type IsoDate,
  type IsoTimestamp,
  type LegalEntityId,
  type MoneyCents,
  type OrganizationId,
} from "../company";

/** A source is an accounting system, never a local record type. */
export const FINANCIAL_SOURCE_PROVIDERS = ["qbo"] as const;
export type FinancialSourceProvider = (typeof FINANCIAL_SOURCE_PROVIDERS)[number];
export const financialSourceProviderSchema = z.enum(FINANCIAL_SOURCE_PROVIDERS);

export const FINANCIAL_SOURCE_ENVIRONMENTS = ["sandbox", "production"] as const;
export type FinancialSourceEnvironment = (typeof FINANCIAL_SOURCE_ENVIRONMENTS)[number];
export const financialSourceEnvironmentSchema = z.enum(FINANCIAL_SOURCE_ENVIRONMENTS);

const sourceText = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, "Source identity cannot contain control characters");
const sourceObjectTypeSchema = sourceText(120).regex(/^[A-Z][A-Za-z0-9_]{0,119}$/, "Source object type is invalid");
const sourceObjectIdSchema = sourceText(200);
const sourceVersionSchema = sourceText(120);

/**
 * The complete provider identity. A realm or object ID alone is never a
 * financial reference: company, environment, legal entity, object, line and
 * provider version all travel together.
 */
export const financialSourceReferenceSchema = z.object({
  provider: z.literal("qbo"),
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: financialSourceEnvironmentSchema,
  realmId: z.string().regex(/^\d{1,32}$/, "QBO realm ID is invalid"),
  objectType: sourceObjectTypeSchema,
  objectId: sourceObjectIdSchema,
  lineId: sourceObjectIdSchema.nullable(),
  version: sourceVersionSchema,
}).strict();
export type FinancialSourceReference = z.infer<typeof financialSourceReferenceSchema>;

export interface FinancialSourceScope {
  readonly provider: FinancialSourceProvider;
  readonly organizationId: OrganizationId;
  readonly legalEntityId: LegalEntityId;
  readonly environment: FinancialSourceEnvironment;
  readonly realmId: string;
}

export const financialSourceScopeSchema = z.object({
  provider: z.literal("qbo"),
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: financialSourceEnvironmentSchema,
  realmId: z.string().regex(/^\d{1,32}$/, "QBO realm ID is invalid"),
}).strict();

export function financialSourceScopeKey(scope: FinancialSourceScope): string {
  const parsed = financialSourceScopeSchema.parse(scope);
  return [parsed.provider, parsed.organizationId, parsed.legalEntityId, parsed.environment, parsed.realmId].join("\u0000");
}

export function financialSourceReferenceKey(reference: FinancialSourceReference): string {
  const parsed = financialSourceReferenceSchema.parse(reference);
  // Key only the scope fields; the strict scope schema rejects the reference's extra fields.
  const scope = { provider: parsed.provider, organizationId: parsed.organizationId, legalEntityId: parsed.legalEntityId, environment: parsed.environment, realmId: parsed.realmId };
  return [financialSourceScopeKey(scope), parsed.objectType, parsed.objectId, parsed.lineId ?? "*", parsed.version].join("\u0000");
}

export const FINANCIAL_COVERAGE_STATUSES = ["unavailable", "partial", "complete"] as const;
export type FinancialCoverageStatus = (typeof FINANCIAL_COVERAGE_STATUSES)[number];
export const financialCoverageStatusSchema = z.enum(FINANCIAL_COVERAGE_STATUSES);

export const FINANCIAL_EVIDENCE_STATES = ["unverified", "synthetic", "live_provider_readback"] as const;
export type FinancialEvidenceState = (typeof FINANCIAL_EVIDENCE_STATES)[number];
export const financialEvidenceStateSchema = z.enum(FINANCIAL_EVIDENCE_STATES);

export const FINANCIAL_BASES = ["source_transactions", "provider_report", "unknown"] as const;
export type FinancialBasis = (typeof FINANCIAL_BASES)[number];
export const financialBasisSchema = z.enum(FINANCIAL_BASES);

/** Watermarks are opaque provider checkpoints, never dates guessed by callers. */
export const financialWatermarkSchema = z.object({
  value: sourceText(255),
  observedAt: isoTimestampSchema,
}).strict();
export type FinancialWatermark = z.infer<typeof financialWatermarkSchema>;

export const financialSourceCoverageSchema = z.object({
  scope: financialSourceScopeSchema,
  stream: sourceText(120).regex(/^[a-z][a-z0-9_.:-]*$/).default("aggregate"),
  status: financialCoverageStatusSchema,
  evidence: financialEvidenceStateSchema,
  basis: financialBasisSchema,
  watermark: financialWatermarkSchema.nullable(),
  coveredFrom: isoDateSchema.nullable(),
  coveredThrough: isoDateSchema.nullable(),
  observedAt: isoTimestampSchema,
  objectCount: z.number().int().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  missingIntervals: z.array(z.object({ from: isoDateSchema, through: isoDateSchema }).strict()).max(1_000),
  reason: sourceText(500).nullable(),
}).strict();
export type FinancialSourceCoverage = z.infer<typeof financialSourceCoverageSchema>;

export const FINANCIAL_DIRECTIONS = ["debit", "credit"] as const;
export type FinancialDirection = (typeof FINANCIAL_DIRECTIONS)[number];
export const financialDirectionSchema = z.enum(FINANCIAL_DIRECTIONS);

export const FINANCIAL_POSTING_STATES = ["posted", "voided", "unknown"] as const;
export type FinancialPostingState = (typeof FINANCIAL_POSTING_STATES)[number];
export const financialPostingStateSchema = z.enum(FINANCIAL_POSTING_STATES);

export const FINANCIAL_SETTLEMENT_STATES = ["unknown", "unsettled", "settled", "voided"] as const;
export type FinancialSettlementState = (typeof FINANCIAL_SETTLEMENT_STATES)[number];
export const financialSettlementStateSchema = z.enum(FINANCIAL_SETTLEMENT_STATES);

/** Settlement is deliberately separate from posting; a posted line is not proof of payment. */
export const financialSettlementSchema = z.object({
  state: financialSettlementStateSchema,
  settledOn: isoDateSchema.nullable(),
  settledAmountCents: centsSchema.nullable(),
}).strict();
export type FinancialSettlement = z.infer<typeof financialSettlementSchema>;

export const FINANCIAL_SOURCE_FLOWS = ["incoming", "outgoing", "unknown"] as const;
export const financialSourceFlowSchema = z.enum(FINANCIAL_SOURCE_FLOWS);
export type FinancialSourceFlow = (typeof FINANCIAL_SOURCE_FLOWS)[number];

export const FINANCIAL_SOURCE_LINE_ROLES = ["receipt", "expense", "payable", "payment_source", "unknown"] as const;
export const financialSourceLineRoleSchema = z.enum(FINANCIAL_SOURCE_LINE_ROLES);
export type FinancialSourceLineRole = (typeof FINANCIAL_SOURCE_LINE_ROLES)[number];

export const financialSourceLineResolutionSchema = z.object({
  source: financialSourceReferenceSchema,
  direction: financialDirectionSchema,
  /** Flow and role are provider-derived context; a debit/credit alone is not a payment claim. */
  flow: financialSourceFlowSchema.default("unknown"),
  lineRole: financialSourceLineRoleSchema.default("unknown"),
  amountCents: centsSchema.refine((value) => BigInt(value) >= BigInt(0), "Source amount must be non-negative"),
  currency: currencyCodeSchema,
  transactionType: sourceObjectTypeSchema,
  accountObjectId: sourceObjectIdSchema.nullable(),
  counterpartyObjectId: sourceObjectIdSchema.nullable(),
  description: z.string().trim().max(500).nullable(),
  postingState: financialPostingStateSchema,
  postedOn: isoDateSchema.nullable(),
  settlement: financialSettlementSchema,
  watermark: financialWatermarkSchema,
}).strict();
export type FinancialSourceLineResolution = z.infer<typeof financialSourceLineResolutionSchema>;

/**
 * Trusted provider-payment facts for a source line. This is deliberately
 * separate from the generic line resolver: a posted ledger line is not cash
 * evidence, and a QBO CustomerRef is not a payee.
 */
export const financialProviderPaymentSubtypeSchema = z.enum(["Cash", "Check", "CreditCard", "ACH", "Wire", "BillPayment", "Deposit"]);
export type FinancialProviderPaymentSubtype = z.infer<typeof financialProviderPaymentSubtypeSchema>;
export const financialProviderPayeeTypeSchema = z.enum(["Vendor", "Customer", "Employee"]);
export type FinancialProviderPayeeType = z.infer<typeof financialProviderPayeeTypeSchema>;
export const financialProviderAccountingPurposeSchema = z.enum(["capital_contribution", "distribution", "principal", "interest", "expense", "rent_receipt", "unknown"]);
export type FinancialProviderAccountingPurpose = z.infer<typeof financialProviderAccountingPurposeSchema>;
export const financialProviderPurposeEvidenceSchema = z.enum(["provider_account_unmapped", "server_mapping", "provider_transaction"]);
export type FinancialProviderPurposeEvidence = z.infer<typeof financialProviderPurposeEvidenceSchema>;

/**
 * A purpose mapping is dated evidence about a provider Account.  Account
 * names are intentionally absent: the provider Account ID, its mirrored
 * revision, and the review record are the authority.
 */
export const financialAccountingPurposeMappingSchema = z.object({
  id: sourceObjectIdSchema,
  scope: financialSourceScopeSchema,
  providerAccountId: sourceObjectIdSchema,
  purpose: financialProviderAccountingPurposeSchema.exclude(["unknown"]),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
  accountSourceVersion: sourceVersionSchema,
  accountType: sourceText(120),
  accountSubType: sourceText(120).nullable(),
  reviewEvidence: sourceText(1_000),
  reviewedBy: sourceText(200),
  reviewedAt: isoTimestampSchema,
  createdAt: isoTimestampSchema,
}).strict();
export type FinancialAccountingPurposeMapping = z.infer<typeof financialAccountingPurposeMappingSchema>;

export interface FinancialAccountingPurposeMappingQuery {
  readonly scope: FinancialSourceScope;
  readonly providerAccountId: string;
  readonly postedOn: IsoDate | string;
}

/** Read-only purpose evidence shared by investors, projects, and reports. */
export interface FinancialAccountingPurposeMappingReadPort {
  readPurposeMapping(query: FinancialAccountingPurposeMappingQuery): Promise<FinancialAccountingPurposeMapping | null>;
}

export const financialProviderPaymentContextSchema = z.object({
  source: financialSourceReferenceSchema,
  cashAccountObjectId: sourceObjectIdSchema,
  payeeObjectId: sourceObjectIdSchema.nullable(),
  payeeObjectType: financialProviderPayeeTypeSchema.nullable(),
  /** Provider account classification is evidence; it is not a caller label. */
  accountType: sourceText(120).nullable(),
  accountSubType: sourceText(120).nullable(),
  purpose: financialProviderAccountingPurposeSchema,
  purposeEvidence: financialProviderPurposeEvidenceSchema,
  purposeMappedAt: isoTimestampSchema.nullable(),
  flow: z.enum(["incoming", "outgoing"]),
  amountCents: centsSchema.refine((value) => BigInt(value) >= BigInt(0), "Payment amount must be non-negative"),
  currency: currencyCodeSchema,
  postedOn: isoDateSchema,
  postingState: financialPostingStateSchema,
  subtype: financialProviderPaymentSubtypeSchema,
  providerUpdatedAt: isoTimestampSchema,
  watermark: financialWatermarkSchema,
}).strict();
export type FinancialProviderPaymentContext = z.infer<typeof financialProviderPaymentContextSchema>;

export const financialProviderCostClassificationSchema = z.enum(["expense", "cogs", "capitalized_cost", "bank", "liability", "equity", "income", "other_asset", "unknown"]);
export type FinancialProviderCostClassification = z.infer<typeof financialProviderCostClassificationSchema>;
export const financialProviderCostContextSchema = z.object({
  source: financialSourceReferenceSchema,
  accountObjectId: sourceObjectIdSchema,
  accountType: sourceText(120),
  accountSubType: sourceText(120).nullable(),
  classification: financialProviderCostClassificationSchema,
  eligible: z.boolean(),
  amountCents: centsSchema.refine((value) => BigInt(value) >= BigInt(0), "Cost amount must be non-negative"),
  currency: currencyCodeSchema,
  postedOn: isoDateSchema,
  postingState: financialPostingStateSchema,
  providerUpdatedAt: isoTimestampSchema,
  watermark: financialWatermarkSchema,
}).strict();
export type FinancialProviderCostContext = z.infer<typeof financialProviderCostContextSchema>;

export interface FinancialProviderPaymentContextPort {
  readPaymentContext(query: FinancialSourceLineQuery): Promise<FinancialProviderPaymentContext | null>;
}

export interface FinancialProviderCostContextPort {
  readCostContext(query: FinancialSourceLineQuery): Promise<FinancialProviderCostContext | null>;
}

export interface FinancialSourceLineQuery {
  readonly scope: FinancialSourceScope;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly lineId?: string;
  readonly version?: string;
}

export interface FinancialSourceTransactionQuery {
  readonly scope: FinancialSourceScope;
  readonly from?: IsoDate | string;
  readonly through?: IsoDate | string;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Read-only contract shared by projects, investors and reporting. There are
 * no caller-facing upsert or "verified" methods: only provider ingestion may
 * create mirror rows and evidence.
 */
export interface FinancialSourceReadPort {
  resolveLine(query: FinancialSourceLineQuery): Promise<FinancialSourceLineResolution | null>;
  readCoverage(scope: FinancialSourceScope, stream?: string): Promise<FinancialSourceCoverage>;
  listTransactions(query: FinancialSourceTransactionQuery): Promise<FinancialSourceTransactionPage>;
}

export interface FinancialSourceTransactionPage {
  readonly items: readonly FinancialSourceLineResolution[];
  readonly nextCursor: string | null;
  readonly coverage: FinancialSourceCoverage;
}

export interface FinancialSourceAllocationRequest {
  readonly source: FinancialSourceReference;
  readonly consumerKind: string;
  readonly consumerId: string;
  readonly amountCents: MoneyCents | string;
  readonly currency: CurrencyCode | string;
}

export interface FinancialSourceAllocationBalance {
  readonly source: FinancialSourceReference;
  readonly lineAmountCents: MoneyCents;
  readonly allocatedCents: MoneyCents;
  readonly availableCents: MoneyCents;
  /** A provider revision can reduce a line below already reserved history. */
  readonly overAllocatedCents?: MoneyCents;
  readonly currency: CurrencyCode;
}

/** Implementations must lock one central balance before reserving an amount. */
export interface FinancialSourceAllocationPort {
  getBalance(source: FinancialSourceReference): Promise<FinancialSourceAllocationBalance>;
  reserve(request: FinancialSourceAllocationRequest): Promise<FinancialSourceAllocationBalance>;
  release(request: FinancialSourceAllocationRequest): Promise<FinancialSourceAllocationBalance>;
}

export interface FinancialSourceProviderIngestEvidence {
  readonly scope: FinancialSourceScope;
  readonly watermark: FinancialWatermark;
  readonly observedAt: IsoTimestamp;
  readonly evidence: "synthetic" | "live_provider_readback";
}

export type FinancialSourceScopeInput = CompanyScope & {
  readonly legalEntityId: LegalEntityId;
};
