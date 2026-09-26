import { z } from "zod";
import { financialProviderPayeeTypeSchema, financialSourceLineResolutionSchema, financialSourceReferenceSchema, financialWatermarkSchema } from "../accounting/source";
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
  type DocumentReferenceId,
  type IsoDate,
  type IsoTimestamp,
  type LegalEntityId,
  type MoneyCents,
  type PropertyReferenceId,
  type RecordReferenceId,
  type Revision,
} from "../company";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type InvestorAccountId = Brand<string, "InvestorAccountId">;
export type InvestorInstrumentId = Brand<string, "InvestorInstrumentId">;
export type InvestorContractId = Brand<string, "InvestorContractId">;
export type InvestorContractVersionId = Brand<string, "InvestorContractVersionId">;
export type InvestorDebtId = Brand<string, "InvestorDebtId">;
export type InvestorObligationId = Brand<string, "InvestorObligationId">;
export type InvestorPaymentId = Brand<string, "InvestorPaymentId">;
export type InvestorActivityId = Brand<string, "InvestorActivityId">;
export type InvestorContactId = Brand<string, "InvestorContactId">;
export type InvestorPartyMappingId = Brand<string, "InvestorPartyMappingId">;
export type InvestorRemittanceInstructionId = Brand<string, "InvestorRemittanceInstructionId">;

export const investorAccountIdSchema = canonicalUuidSchema.transform(value => value as InvestorAccountId);
export const investorInstrumentIdSchema = canonicalUuidSchema.transform(value => value as InvestorInstrumentId);
export const investorContractIdSchema = canonicalUuidSchema.transform(value => value as InvestorContractId);
export const investorContractVersionIdSchema = canonicalUuidSchema.transform(value => value as InvestorContractVersionId);
export const investorDebtIdSchema = canonicalUuidSchema.transform(value => value as InvestorDebtId);
export const investorObligationIdSchema = canonicalUuidSchema.transform(value => value as InvestorObligationId);
export const investorPaymentIdSchema = canonicalUuidSchema.transform(value => value as InvestorPaymentId);
export const investorActivityIdSchema = canonicalUuidSchema.transform(value => value as InvestorActivityId);
export const investorContactIdSchema = canonicalUuidSchema.transform(value => value as InvestorContactId);
export const investorPartyMappingIdSchema = canonicalUuidSchema.transform(value => value as InvestorPartyMappingId);
export const investorRemittanceInstructionIdSchema = canonicalUuidSchema.transform(value => value as InvestorRemittanceInstructionId);

export const INVESTOR_ACCOUNT_STATUSES = ["active", "archived"] as const;
export type InvestorAccountStatus = (typeof INVESTOR_ACCOUNT_STATUSES)[number];
export const investorAccountStatusSchema = z.enum(INVESTOR_ACCOUNT_STATUSES);

export const INVESTOR_INSTRUMENT_KINDS = ["equity", "preferred_equity", "private_loan", "member_loan"] as const;
export type InvestorInstrumentKind = (typeof INVESTOR_INSTRUMENT_KINDS)[number];
export const investorInstrumentKindSchema = z.enum(INVESTOR_INSTRUMENT_KINDS);

export const INVESTOR_INSTRUMENT_STATUSES = ["draft", "active", "paid_off", "closed", "archived"] as const;
export type InvestorInstrumentStatus = (typeof INVESTOR_INSTRUMENT_STATUSES)[number];
export const investorInstrumentStatusSchema = z.enum(INVESTOR_INSTRUMENT_STATUSES);

export const INVESTOR_CONTRACT_STATUSES = ["draft", "in_review", "active", "superseded", "expired", "void"] as const;
export type InvestorContractStatus = (typeof INVESTOR_CONTRACT_STATUSES)[number];
export const investorContractStatusSchema = z.enum(INVESTOR_CONTRACT_STATUSES);

export const INVESTOR_CONTRACT_KINDS = ["investment_agreement", "promissory_note", "operating_agreement", "amendment", "distribution_policy", "other"] as const;
export type InvestorContractKind = (typeof INVESTOR_CONTRACT_KINDS)[number];
export const investorContractKindSchema = z.enum(INVESTOR_CONTRACT_KINDS);

export const INVESTOR_SCHEDULES = ["monthly", "quarterly", "annual", "at_maturity", "custom"] as const;
export type InvestorSchedule = (typeof INVESTOR_SCHEDULES)[number];
export const investorScheduleSchema = z.enum(INVESTOR_SCHEDULES);

export const INVESTOR_MONTH_END_RULES = ["calendar_day_or_month_end", "month_end"] as const;
export type InvestorMonthEndRule = (typeof INVESTOR_MONTH_END_RULES)[number];
export const investorMonthEndRuleSchema = z.enum(INVESTOR_MONTH_END_RULES);

export const INVESTOR_DAY_COUNTS = ["actual_365", "actual_360", "30_360"] as const;
export type InvestorDayCount = (typeof INVESTOR_DAY_COUNTS)[number];
export const investorDayCountSchema = z.enum(INVESTOR_DAY_COUNTS);

export const INVESTOR_OBLIGATION_KINDS = ["principal", "interest", "return_of_capital", "distribution", "fee", "balloon"] as const;
export type InvestorObligationKind = (typeof INVESTOR_OBLIGATION_KINDS)[number];
export const investorObligationKindSchema = z.enum(INVESTOR_OBLIGATION_KINDS);

export const INVESTOR_PAYMENT_KINDS = ["contribution", "return_of_capital", "distribution", "principal", "interest", "fee", "balloon", "correction"] as const;
export type InvestorPaymentKind = (typeof INVESTOR_PAYMENT_KINDS)[number];
export const investorPaymentKindSchema = z.enum(INVESTOR_PAYMENT_KINDS);

export const INVESTOR_PAYMENT_STATUSES = ["manual_recorded", "qbo_posted", "bank_settled", "review_required", "reversed"] as const;
export type InvestorPaymentStatus = (typeof INVESTOR_PAYMENT_STATUSES)[number];
export const investorPaymentStatusSchema = z.enum(INVESTOR_PAYMENT_STATUSES);

export const INVESTOR_OBLIGATION_STATUSES = ["expected", "partially_recorded", "manually_recorded", "partially_posted", "qbo_posted", "partially_settled", "bank_settled", "overpaid", "review_required", "reversed"] as const;
export type InvestorObligationStatus = (typeof INVESTOR_OBLIGATION_STATUSES)[number];
export const investorObligationStatusSchema = z.enum(INVESTOR_OBLIGATION_STATUSES);

/** Historical QBO evidence remains visible even when the current mirror read
 * no longer proves it. This state is current-read validity, not a rewrite of
 * the append-only source attestation. */
export const investorPostedSourceValiditySchema = z.enum(["current", "stale", "voided", "unavailable"]);
export type InvestorPostedSourceValidity = z.infer<typeof investorPostedSourceValiditySchema>;

export const INVESTOR_SOURCE_PROVIDERS = ["qbo", "bank", "plaid"] as const;
export type InvestorSourceProvider = (typeof INVESTOR_SOURCE_PROVIDERS)[number];
export const investorSourceProviderSchema = z.enum(INVESTOR_SOURCE_PROVIDERS);

export const INVESTOR_COVERAGE_STATES = ["verified", "partial", "stale", "unavailable", "unverified"] as const;
export type InvestorCoverageState = (typeof INVESTOR_COVERAGE_STATES)[number];
export const investorCoverageStateSchema = z.enum(INVESTOR_COVERAGE_STATES);

export const INVESTOR_PAYMENT_METHODS = ["manual", "ach", "wire", "check", "qbo"] as const;
export type InvestorPaymentMethod = (typeof INVESTOR_PAYMENT_METHODS)[number];
export const investorPaymentMethodSchema = z.enum(INVESTOR_PAYMENT_METHODS);

export const INVESTOR_PARTY_KINDS = ["investor", "third_party_lender"] as const;
export type InvestorPartyKind = (typeof INVESTOR_PARTY_KINDS)[number];
export const investorPartyKindSchema = z.enum(INVESTOR_PARTY_KINDS);
export const INVESTOR_RELATION_STATUSES = ["active", "archived"] as const;
export type InvestorRelationStatus = (typeof INVESTOR_RELATION_STATUSES)[number];
export const investorRelationStatusSchema = z.enum(INVESTOR_RELATION_STATUSES);

/** A provider party mapping authorizes identity; it never attests a money line. */
export const investorProviderPartyReferenceSchema = financialSourceReferenceSchema.pick({
  provider: true, organizationId: true, legalEntityId: true, environment: true, realmId: true, objectType: true, objectId: true,
}).extend({ objectType: financialProviderPayeeTypeSchema });
export type InvestorProviderPartyReference = z.infer<typeof investorProviderPartyReferenceSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const nullableDate = isoDateSchema.nullable().optional();
const cents = centsSchema;
const nonNegativeCentsSchema = cents.refine(value => centsToBigInt(value) >= BigInt(0), "Expected non-negative signed BIGINT cents");
const positiveCentsSchema = nonNegativeCentsSchema.refine(value => centsToBigInt(value) > BigInt(0), "Expected positive cents");
const bpsSchema = z.number().int().min(0).max(10_000);
/**
 * Rates and multiples are decimal fractions stored as numeric(18,12). Negative
 * values break the interest and amortization math, and extra precision would
 * be rounded away silently by PostgreSQL, so both are refused at the boundary.
 */
const rateSchema = decimalSchema.refine((value) => {
  const [integer, fraction = ""] = value.split(".");
  return !value.startsWith("-") && integer.length <= 6 && fraction.length <= 12;
}, "Expected a non-negative rate with at most 6 integer and 12 decimal places");
const monthSchema = isoDateSchema.refine(value => value.endsWith("-01"), "Expected the first day of a calendar month");
const uuidList = <T extends z.ZodTypeAny>(schema: T, max = 100) => z.array(schema).max(max).superRefine((values, context) => {
  if (new Set(values.map(String)).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "References must be unique" });
});

export const investorAccountRollupSchema = z.object({
  currency: currencyCodeSchema,
  committedCents: nonNegativeCentsSchema,
  fundedCents: cents,
  returnedCents: cents,
  remainingContributedCents: cents,
  nextObligationCents: nonNegativeCentsSchema.nullable(),
  nextObligationOn: isoDateSchema.nullable(),
}).strict();
export type InvestorAccountRollup = z.infer<typeof investorAccountRollupSchema>;

export const investorAccountSchema = z.object({
  id: investorAccountIdSchema,
  organizationId: z.string().min(1).max(160),
  contactId: investorContactIdSchema,
  displayName: text(240),
  status: investorAccountStatusSchema,
  notes: z.string().trim().max(4_000).nullable(),
  rollups: z.array(investorAccountRollupSchema).max(20),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict();
export type InvestorAccount = z.infer<typeof investorAccountSchema>;

export const investorContactOptionSchema = z.object({
  id: investorContactIdSchema,
  displayName: text(200),
  kind: z.enum(["person", "organization"]),
  rentOpsPersonId: z.string().trim().max(160).nullable(),
}).strict();
export type InvestorContactOption = z.infer<typeof investorContactOptionSchema>;

export const investorPartyMappingSchema = z.object({
  id: investorPartyMappingIdSchema,
  accountId: investorAccountIdSchema,
  organizationId: z.string().min(1).max(160),
  legalEntityId: legalEntityIdSchema,
  contactId: investorContactIdSchema.nullable(),
  partyKind: investorPartyKindSchema,
  displayName: text(240),
  providerParty: investorProviderPartyReferenceSchema,
  sourceDocumentId: documentReferenceIdSchema.nullable(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
  status: investorRelationStatusSchema,
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.effectiveTo !== null && value.effectiveTo <= value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "effectiveTo must follow effectiveFrom" });
  if (value.providerParty.organizationId !== value.organizationId || value.providerParty.legalEntityId !== value.legalEntityId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["providerParty"], message: "Provider party must use the same company and legal entity scope" });
  if (value.partyKind === "third_party_lender" && value.sourceDocumentId === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceDocumentId"], message: "Third-party remittance parties require an existing written document reference" });
});
export type InvestorPartyMapping = z.infer<typeof investorPartyMappingSchema>;

export const investorRemittanceInstructionSchema = z.object({
  id: investorRemittanceInstructionIdSchema,
  accountId: investorAccountIdSchema,
  instrumentId: investorInstrumentIdSchema,
  contractId: investorContractIdSchema.nullable(),
  organizationId: z.string().min(1).max(160),
  legalEntityId: legalEntityIdSchema,
  partyMappingId: investorPartyMappingIdSchema,
  beneficiaryKind: investorPartyKindSchema,
  sourceDocumentId: documentReferenceIdSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
  status: investorRelationStatusSchema,
  notes: z.string().trim().max(2_000).nullable(),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.effectiveTo !== null && value.effectiveTo <= value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "effectiveTo must follow effectiveFrom" });
  if (value.beneficiaryKind !== "third_party_lender") context.addIssue({ code: z.ZodIssueCode.custom, path: ["beneficiaryKind"], message: "An explicit remittance instruction is only needed for a third-party beneficiary" });
});
export type InvestorRemittanceInstruction = z.infer<typeof investorRemittanceInstructionSchema>;

export const investorInstrumentSchema = z.object({
  id: investorInstrumentIdSchema,
  accountId: investorAccountIdSchema,
  organizationId: z.string().min(1).max(160),
  name: text(240),
  kind: investorInstrumentKindSchema,
  status: investorInstrumentStatusSchema,
  currency: currencyCodeSchema,
  committedCents: nonNegativeCentsSchema,
  facePrincipalCents: nonNegativeCentsSchema,
  effectiveFrom: isoDateSchema,
  maturityOn: isoDateSchema.nullable(),
  ownershipBps: bpsSchema.nullable(),
  legalEntityId: legalEntityIdSchema,
  propertyIds: uuidList(propertyReferenceIdSchema),
  projectIds: uuidList(recordReferenceIdSchema),
  notes: z.string().trim().max(4_000).nullable(),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.maturityOn !== null && value.maturityOn < value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["maturityOn"], message: "maturityOn must follow effectiveFrom" });
  if (value.kind === "equity" && value.ownershipBps === null && value.committedCents === "0") context.addIssue({ code: z.ZodIssueCode.custom, path: ["ownershipBps"], message: "Equity instruments require an ownership or committed amount" });
});
export type InvestorInstrument = z.infer<typeof investorInstrumentSchema>;

export const investorContractTermsSchema = z.object({
  schedule: investorScheduleSchema,
  paymentDay: z.number().int().min(1).max(31).nullable(),
  monthEndRule: investorMonthEndRuleSchema,
  annualRate: rateSchema.nullable(),
  preferredReturnRate: rateSchema.nullable(),
  returnMultiple: rateSchema.nullable(),
  fixedPaymentCents: nonNegativeCentsSchema.nullable(),
  principalPaymentCents: nonNegativeCentsSchema.nullable(),
  interestPaymentCents: nonNegativeCentsSchema.nullable(),
  returnOfCapitalCents: nonNegativeCentsSchema.nullable(),
  distributionCents: nonNegativeCentsSchema.nullable(),
  balloonCents: nonNegativeCentsSchema.nullable(),
  originalPrincipalCents: nonNegativeCentsSchema.nullable(),
  /** A separately documented maturity total; it does not prove funded capital. */
  maturityTotalCents: nonNegativeCentsSchema.nullable().default(null),
  /** Fixed contractual profit, independent of prepayment, when the agreement says so. */
  fixedProfitCents: nonNegativeCentsSchema.nullable().default(null),
  /** Actual bank payoff remains unknown until a payoff statement/evidence is linked. */
  maturityPayoffCents: nonNegativeCentsSchema.nullable().default(null),
  /** A third-party installment can be expected while its principal/interest split remains unknown. */
  thirdPartyInstallmentCents: nonNegativeCentsSchema.nullable().default(null),
  investorSpreadCents: nonNegativeCentsSchema.nullable().default(null),
  unknownComponentKinds: z.array(investorObligationKindSchema).max(6).default([]),
  interestOnly: z.boolean(),
  dayCount: investorDayCountSchema,
}).strict().superRefine((value, context) => {
  const hasAmount = [value.fixedPaymentCents, value.principalPaymentCents, value.interestPaymentCents, value.returnOfCapitalCents, value.distributionCents, value.balloonCents, value.originalPrincipalCents, value.maturityTotalCents, value.fixedProfitCents, value.maturityPayoffCents, value.thirdPartyInstallmentCents, value.investorSpreadCents].some(item => item !== null && item !== "0");
  if (!hasAmount && value.annualRate === null && value.preferredReturnRate === null && value.returnMultiple === null) context.addIssue({ code: z.ZodIssueCode.custom, message: "Contract terms need an explicit amount or rate" });
  if (value.annualRate !== null && value.fixedPaymentCents === null && value.originalPrincipalCents === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["originalPrincipalCents"], message: "An annual rate requires original principal or a fixed payment" });
  if (value.schedule === "monthly" && value.paymentDay === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentDay"], message: "Monthly terms require a payment day" });
  if (value.interestOnly && value.fixedPaymentCents !== null && value.interestPaymentCents === null && value.annualRate === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["interestPaymentCents"], message: "Interest-only fixed payments require an explicit interest amount or annual rate" });
  }
  if (value.originalPrincipalCents !== null && value.principalPaymentCents !== null && value.balloonCents !== null
    && centsToBigInt(value.principalPaymentCents) + centsToBigInt(value.balloonCents) > centsToBigInt(value.originalPrincipalCents)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["balloonCents"], message: "Scheduled principal plus balloon cannot exceed original principal" });
  }
  if (value.fixedPaymentCents !== null && value.thirdPartyInstallmentCents === null) {
    const fixed = centsToBigInt(value.fixedPaymentCents);
    if (value.principalPaymentCents !== null && value.interestPaymentCents !== null
      && centsToBigInt(value.principalPaymentCents) + centsToBigInt(value.interestPaymentCents) !== fixed) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedPaymentCents"], message: "Fixed payment must equal explicit principal plus interest" });
    }
    if (value.interestOnly && value.principalPaymentCents !== null && centsToBigInt(value.principalPaymentCents) !== BigInt(0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["principalPaymentCents"], message: "Interest-only terms cannot include scheduled principal" });
    }
  }
  if (value.maturityTotalCents !== null && value.fixedProfitCents !== null && centsToBigInt(value.fixedProfitCents) > centsToBigInt(value.maturityTotalCents)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedProfitCents"], message: "Fixed maturity profit cannot exceed the documented maturity total" });
  }
  const hasExplicitThirdPartySplit = value.thirdPartyInstallmentCents !== null && value.principalPaymentCents !== null && value.interestPaymentCents !== null;
  if (value.thirdPartyInstallmentCents !== null && !hasExplicitThirdPartySplit && !value.unknownComponentKinds.includes("principal") && !value.unknownComponentKinds.includes("interest")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unknownComponentKinds"], message: "A third-party installment must retain its unknown principal/interest split" });
  }
  if (value.thirdPartyInstallmentCents !== null && (value.principalPaymentCents !== null || value.interestPaymentCents !== null)) {
    if (value.principalPaymentCents === null || value.interestPaymentCents === null
      || centsToBigInt(value.principalPaymentCents) + centsToBigInt(value.interestPaymentCents) !== centsToBigInt(value.thirdPartyInstallmentCents)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["thirdPartyInstallmentCents"], message: "An explicit third-party principal and interest split must equal the bank installment" });
    }
  }
  if (value.interestOnly && value.principalPaymentCents !== null && centsToBigInt(value.principalPaymentCents) !== BigInt(0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["principalPaymentCents"], message: "Interest-only terms cannot include scheduled principal" });
  }
  if (value.fixedPaymentCents !== null && value.thirdPartyInstallmentCents !== null) {
    const spread = value.investorSpreadCents === null ? BigInt(0) : centsToBigInt(value.investorSpreadCents);
    if (centsToBigInt(value.fixedPaymentCents) !== centsToBigInt(value.thirdPartyInstallmentCents) + spread) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedPaymentCents"], message: "A fixed total with a third-party installment must equal installment plus investor spread" });
  }
  if (value.maturityTotalCents !== null && value.fixedProfitCents !== null && value.maturityPayoffCents !== null
    && centsToBigInt(value.maturityTotalCents) !== centsToBigInt(value.fixedProfitCents) + centsToBigInt(value.maturityPayoffCents)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maturityTotalCents"], message: "A documented maturity total must equal known payoff plus fixed profit when both are supplied" });
  }
});
export type InvestorContractTerms = z.infer<typeof investorContractTermsSchema>;

export const investorContractSchema = z.object({
  id: investorContractIdSchema,
  instrumentId: investorInstrumentIdSchema,
  organizationId: z.string().min(1).max(160),
  title: text(240),
  kind: investorContractKindSchema,
  status: investorContractStatusSchema,
  currentVersionId: investorContractVersionIdSchema.nullable(),
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict();
export type InvestorContract = z.infer<typeof investorContractSchema>;

export const investorContractVersionSchema = z.object({
  id: investorContractVersionIdSchema,
  contractId: investorContractIdSchema,
  versionNo: z.number().int().positive(),
  status: investorContractStatusSchema,
  effectiveFrom: isoDateSchema,
  signedOn: isoDateSchema.nullable(),
  effectiveTo: isoDateSchema.nullable(),
  sourceDocumentIds: z.array(documentReferenceIdSchema).max(100),
  terms: investorContractTermsSchema,
  createdBy: z.string().min(1).max(160),
  approvedBy: z.string().max(160).nullable(),
  createdAt: isoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.effectiveTo !== null && value.effectiveTo <= value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "effectiveTo must follow effectiveFrom" });
  if (value.status === "active" && value.sourceDocumentIds.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceDocumentIds"], message: "An active contract version requires an existing source document reference" });
});
export type InvestorContractVersion = z.infer<typeof investorContractVersionSchema>;

export const investorDebtSchema = z.object({
  id: investorDebtIdSchema,
  instrumentId: investorInstrumentIdSchema,
  accountId: investorAccountIdSchema,
  organizationId: z.string().min(1).max(160),
  legalEntityId: legalEntityIdSchema,
  debtKind: z.enum(["private_loan", "member_loan"]),
  currency: currencyCodeSchema,
  originalPrincipalCents: nonNegativeCentsSchema,
  /** Null means the opening funded amount is not documented yet. */
  fundedCapitalCents: nonNegativeCentsSchema.nullable(),
  /** Null means the current balance is not documented by an authoritative source. */
  outstandingPrincipalCents: nonNegativeCentsSchema.nullable(),
  annualRate: rateSchema,
  schedule: investorScheduleSchema,
  paymentDay: z.number().int().min(1).max(31).nullable(),
  monthEndRule: investorMonthEndRuleSchema,
  firstDueMonth: monthSchema.nullable(),
  interestOnlyUntil: monthSchema.nullable(),
  maturityOn: isoDateSchema.nullable(),
  amortizationMonths: z.number().int().positive().nullable(),
  balloonCents: nonNegativeCentsSchema.nullable(),
  dayCount: investorDayCountSchema,
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.fundedCapitalCents !== null && centsToBigInt(value.fundedCapitalCents) > centsToBigInt(value.originalPrincipalCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundedCapitalCents"], message: "Funded capital cannot exceed original principal" });
  if (value.outstandingPrincipalCents !== null && centsToBigInt(value.outstandingPrincipalCents) > centsToBigInt(value.originalPrincipalCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["outstandingPrincipalCents"], message: "Outstanding principal cannot exceed original principal" });
  if (value.schedule === "monthly" && value.paymentDay === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentDay"], message: "Monthly debt requires a payment day" });
});
export type InvestorDebt = z.infer<typeof investorDebtSchema>;

const verifiedQboSourceSchema = z.object({
  provider: z.literal("qbo"),
  reference: financialSourceReferenceSchema,
  currency: currencyCodeSchema,
  amountCents: nonNegativeCentsSchema,
  coverage: z.literal("verified"),
  verifiedAt: isoTimestampSchema,
  watermark: financialWatermarkSchema,
}).strict();

const verifiedSettlementSourceSchema = z.object({
  provider: z.enum(["bank", "plaid"]),
  sourceScope: text(200),
  externalTransactionId: text(200),
  externalLineId: text(200),
  sourceRevision: text(120),
  currency: currencyCodeSchema,
  amountCents: nonNegativeCentsSchema,
  coverage: z.literal("verified"),
  verifiedAt: isoTimestampSchema,
  watermark: financialWatermarkSchema,
}).strict();

export const investorFinancialSourceSchema = z.union([verifiedQboSourceSchema, verifiedSettlementSourceSchema]);
export type InvestorFinancialSource = z.infer<typeof investorFinancialSourceSchema>;

const qboSourceRequestSchema = z.object({
  provider: z.literal("qbo"),
  reference: financialSourceReferenceSchema,
  currency: currencyCodeSchema,
  amountCents: nonNegativeCentsSchema,
}).strict();

const settlementSourceRequestSchema = z.object({
  provider: z.enum(["bank", "plaid"]),
  sourceScope: text(200),
  externalTransactionId: text(200),
  externalLineId: text(200),
  sourceRevision: text(120),
  currency: currencyCodeSchema,
  amountCents: nonNegativeCentsSchema,
}).strict();

/** Caller supplied source identity only. Verification metadata is created by the source resolver. */
export const investorFinancialSourceRequestSchema = z.union([qboSourceRequestSchema, settlementSourceRequestSchema]);
export type InvestorFinancialSourceRequest = z.infer<typeof investorFinancialSourceRequestSchema>;

export const investorObligationSchema = z.object({
  id: investorObligationIdSchema,
  accountId: investorAccountIdSchema,
  instrumentId: investorInstrumentIdSchema,
  contractId: investorContractIdSchema,
  contractVersionId: investorContractVersionIdSchema,
  organizationId: z.string().min(1).max(160),
  legalEntityId: legalEntityIdSchema,
  periodMonth: monthSchema,
  dueOn: isoDateSchema,
  currency: currencyCodeSchema,
  principalCents: nonNegativeCentsSchema,
  interestCents: nonNegativeCentsSchema,
  returnOfCapitalCents: nonNegativeCentsSchema,
  distributionCents: nonNegativeCentsSchema,
  feeCents: nonNegativeCentsSchema,
  balloonCents: nonNegativeCentsSchema,
  unclassifiedCents: nonNegativeCentsSchema,
  unknownExpectedCents: nonNegativeCentsSchema,
  unknownComponentKinds: z.array(investorObligationKindSchema).max(6).default([]),
  /** Null means the contract leaves a component amount unresolved. */
  totalExpectedCents: nonNegativeCentsSchema.nullable(),
  knownMinimumCents: nonNegativeCentsSchema,
  amountComplete: z.boolean(),
  totalRecordedCents: cents,
  totalPostedCents: cents,
  totalSettledCents: cents,
  remainingDueCents: cents.nullable(),
  status: investorObligationStatusSchema,
  recordRevision: revisionSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type InvestorObligation = z.infer<typeof investorObligationSchema>;

export const investorPaymentAmountsSchema = z.object({
  principalCents: cents,
  interestCents: cents,
  returnOfCapitalCents: cents,
  distributionCents: cents,
  feeCents: cents,
  balloonCents: cents,
  unclassifiedCents: cents.default("0"),
}).strict();
export type InvestorPaymentAmounts = z.infer<typeof investorPaymentAmountsSchema>;

/**
 * QBO purpose mappings prove one investor payment component at a time. The
 * local record may still retain a legacy multi-component loan payment; that
 * record is valid for manual history, but it cannot be linked to one QBO
 * purpose without component-level evidence.
 */
export type InvestorPaymentComponent = Exclude<keyof InvestorPaymentAmounts, "unclassifiedCents">;

const INVESTOR_PAYMENT_COMPONENT_BY_KIND: Readonly<Partial<Record<InvestorPaymentKind, InvestorPaymentComponent>>> = {
  contribution: "principalCents",
  return_of_capital: "returnOfCapitalCents",
  distribution: "distributionCents",
  principal: "principalCents",
  interest: "interestCents",
  fee: "feeCents",
  balloon: "balloonCents",
};

export function investorPaymentComponentForKind(kind: InvestorPaymentKind): InvestorPaymentComponent | null {
  return INVESTOR_PAYMENT_COMPONENT_BY_KIND[kind] ?? null;
}

/** True only when the payment has one positive, known component for its kind. */
export function investorPaymentKindMatchesSingleComponent(kind: InvestorPaymentKind, amounts: InvestorPaymentAmounts): boolean {
  const component = investorPaymentComponentForKind(kind);
  if (component === null || centsToBigInt(amounts[component]) <= BigInt(0)) return false;
  return (Object.entries(amounts) as [keyof InvestorPaymentAmounts, string][]).every(([key, value]) => key === component
    ? centsToBigInt(value) > BigInt(0)
    : centsToBigInt(value) === BigInt(0));
}

export const investorPaymentSchema = z.object({
  id: investorPaymentIdSchema,
  accountId: investorAccountIdSchema,
  instrumentId: investorInstrumentIdSchema,
  contractId: investorContractIdSchema.nullable(),
  obligationId: investorObligationIdSchema.nullable(),
  remittanceInstructionId: investorRemittanceInstructionIdSchema.nullable(),
  organizationId: z.string().min(1).max(160),
  legalEntityId: legalEntityIdSchema,
  kind: investorPaymentKindSchema,
  status: investorPaymentStatusSchema,
  method: investorPaymentMethodSchema,
  paymentOn: isoDateSchema,
  periodMonth: monthSchema.nullable(),
  currency: currencyCodeSchema,
  amountCents: cents,
  amounts: investorPaymentAmountsSchema,
  allocatedAmounts: investorPaymentAmountsSchema,
  unappliedCents: cents,
  postedSource: investorFinancialSourceSchema.nullable(),
  postedSourceValidity: investorPostedSourceValiditySchema.nullable(),
  settlementSource: investorFinancialSourceSchema.nullable(),
  reversesPaymentId: investorPaymentIdSchema.nullable(),
  correctionReason: text(2_000).nullable(),
  recordRevision: revisionSchema,
  createdAt: isoTimestampSchema,
}).strict();
export type InvestorPayment = z.infer<typeof investorPaymentSchema>;

export const investorMonthlyPaymentRowSchema = z.object({
  obligation: investorObligationSchema,
  payments: z.array(investorPaymentSchema).max(1_000),
}).strict();
export type InvestorMonthlyPaymentRow = z.infer<typeof investorMonthlyPaymentRowSchema>;

export const investorMonthlyPaymentResponseSchema = z.object({
  items: z.array(investorMonthlyPaymentRowSchema).max(500),
  nextCursor: z.string().min(1).max(512).nullable(),
  unscheduledPayments: z.array(investorPaymentSchema).max(1_000).default([]),
}).strict();
export type InvestorMonthlyPaymentResponse = z.infer<typeof investorMonthlyPaymentResponseSchema>;

export const investorFinancialSourceResponseSchema = z.object({
  items: z.array(financialSourceLineResolutionSchema).max(500),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export type InvestorFinancialSourceResponse = z.infer<typeof investorFinancialSourceResponseSchema>;

export const investorActivitySchema = z.object({
  id: investorActivityIdSchema,
  accountId: investorAccountIdSchema,
  instrumentId: investorInstrumentIdSchema.nullable(),
  paymentId: investorPaymentIdSchema.nullable(),
  contractId: investorContractIdSchema.nullable(),
  organizationId: z.string().min(1).max(160),
  occurredOn: isoDateSchema,
  kind: investorPaymentKindSchema,
  status: z.enum(["planned", "due", "manual_recorded", "qbo_posted", "bank_settled", "review_required", "reversed"]),
  amountCents: cents,
  currency: currencyCodeSchema,
  description: text(500),
}).strict();
export type InvestorActivity = z.infer<typeof investorActivitySchema>;

export const investorDetailSchema = investorAccountSchema.extend({
  instruments: z.array(investorInstrumentSchema).max(1_000),
  contracts: z.array(investorContractSchema).max(1_000),
  contractVersions: z.array(investorContractVersionSchema).max(2_000),
  debt: z.array(investorDebtSchema).max(1_000),
  partyMappings: z.array(investorPartyMappingSchema).max(500),
  remittanceInstructions: z.array(investorRemittanceInstructionSchema).max(500),
  obligations: z.array(investorObligationSchema).max(10_000),
  payments: z.array(investorPaymentSchema).max(10_000),
  activity: z.array(investorActivitySchema).max(10_000),
}).strict();
export type InvestorDetail = z.infer<typeof investorDetailSchema>;

export const investorListQuerySchema = z.object({
  scope: companyScopeSchema,
  search: z.string().trim().max(200).optional(),
  status: investorAccountStatusSchema.optional(),
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
  instrumentKind: investorInstrumentKindSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();
export type InvestorListQuery = z.infer<typeof investorListQuerySchema>;

export const investorListResponseSchema = z.object({
  items: z.array(investorAccountSchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export type InvestorListResponse = z.infer<typeof investorListResponseSchema>;

export const investorContactListResponseSchema = z.object({
  items: z.array(investorContactOptionSchema).max(200),
}).strict();
export type InvestorContactListResponse = z.infer<typeof investorContactListResponseSchema>;

export const investorDocumentOptionSchema = z.object({
  id: documentReferenceIdSchema,
  fileName: text(500),
  state: z.string().trim().min(1).max(40),
  type: z.string().trim().min(1).max(80),
  propertyId: propertyReferenceIdSchema.nullable(),
}).strict();
export type InvestorDocumentOption = z.infer<typeof investorDocumentOptionSchema>;

export const investorDocumentListResponseSchema = z.object({
  items: z.array(investorDocumentOptionSchema).max(500),
}).strict();
export type InvestorDocumentListResponse = z.infer<typeof investorDocumentListResponseSchema>;

export const investorPaymentLogQuerySchema = z.object({
  scope: companyScopeSchema,
  accountId: investorAccountIdSchema.optional(),
  instrumentId: investorInstrumentIdSchema.optional(),
  fromMonth: monthSchema,
  throughMonth: monthSchema,
  status: investorObligationStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict().superRefine((value, context) => {
  if (value.throughMonth < value.fromMonth) context.addIssue({ code: z.ZodIssueCode.custom, path: ["throughMonth"], message: "throughMonth must be on or after fromMonth" });
});
export type InvestorPaymentLogQuery = z.infer<typeof investorPaymentLogQuerySchema>;

const sourceDocumentIdsInput = z.array(documentReferenceIdSchema).max(100).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Document references must be unique" });
});

export const createInvestorAccountPayloadSchema = z.object({
  contactId: investorContactIdSchema.optional(),
  newContact: z.object({
    kind: z.enum(["person", "organization"]),
    displayName: text(200),
    rentOpsPersonId: z.string().trim().max(160).nullable().optional(),
  }).strict().optional(),
  displayName: text(240),
  notes: optionalText(4_000),
}).strict().superRefine((value, context) => {
  if ((value.contactId === undefined) === (value.newContact === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contactId"], message: "Choose an existing contact or create a new contact" });
  }
});
export type CreateInvestorAccountPayload = z.infer<typeof createInvestorAccountPayloadSchema>;

export const updateInvestorAccountPayloadSchema = z.object({
  accountId: investorAccountIdSchema,
  displayName: text(240).optional(),
  notes: optionalText(4_000),
}).strict().refine(value => Object.keys(value).length > 1, "At least one investor account field is required");
export type UpdateInvestorAccountPayload = z.infer<typeof updateInvestorAccountPayloadSchema>;
export const archiveInvestorAccountPayloadSchema = z.object({ accountId: investorAccountIdSchema }).strict();
export type ArchiveInvestorAccountPayload = z.infer<typeof archiveInvestorAccountPayloadSchema>;

export const createInvestorInstrumentPayloadSchema = z.object({
  accountId: investorAccountIdSchema,
  name: text(240),
  kind: investorInstrumentKindSchema,
  legalEntityId: legalEntityIdSchema,
  propertyIds: uuidList(propertyReferenceIdSchema),
  projectIds: uuidList(recordReferenceIdSchema),
  currency: currencyCodeSchema,
  committedCents: nonNegativeCentsSchema,
  facePrincipalCents: nonNegativeCentsSchema,
  effectiveFrom: isoDateSchema,
  maturityOn: nullableDate,
  ownershipBps: bpsSchema.nullable().optional(),
  notes: optionalText(4_000),
}).strict().superRefine((value, context) => {
  if (value.maturityOn !== undefined && value.maturityOn !== null && value.maturityOn < value.effectiveFrom) context.addIssue({ code: z.ZodIssueCode.custom, path: ["maturityOn"], message: "maturityOn must follow effectiveFrom" });
  if ((value.kind === "private_loan" || value.kind === "member_loan") && value.facePrincipalCents === "0" && value.committedCents === "0") context.addIssue({ code: z.ZodIssueCode.custom, path: ["facePrincipalCents"], message: "Debt instruments require a principal or commitment" });
});
export type CreateInvestorInstrumentPayload = z.infer<typeof createInvestorInstrumentPayloadSchema>;

export const updateInvestorInstrumentPayloadSchema = z.object({
  instrumentId: investorInstrumentIdSchema,
  name: text(240).optional(),
  status: investorInstrumentStatusSchema.optional(),
  notes: optionalText(4_000),
}).strict().refine(value => Object.keys(value).length > 1, "At least one investor instrument field is required");
export type UpdateInvestorInstrumentPayload = z.infer<typeof updateInvestorInstrumentPayloadSchema>;
export const archiveInvestorInstrumentPayloadSchema = z.object({ instrumentId: investorInstrumentIdSchema }).strict();
export type ArchiveInvestorInstrumentPayload = z.infer<typeof archiveInvestorInstrumentPayloadSchema>;

export const createInvestorContractPayloadSchema = z.object({
  instrumentId: investorInstrumentIdSchema,
  title: text(240),
  kind: investorContractKindSchema,
  status: investorContractStatusSchema,
  effectiveFrom: isoDateSchema,
  signedOn: nullableDate,
  terms: investorContractTermsSchema,
  sourceDocumentIds: sourceDocumentIdsInput,
}).strict().superRefine((value, context) => {
  if (value.status === "active" && value.sourceDocumentIds.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceDocumentIds"], message: "An active contract requires an existing source document reference" });
});
export type CreateInvestorContractPayload = z.infer<typeof createInvestorContractPayloadSchema>;

export const createInvestorContractVersionPayloadSchema = z.object({
  contractId: investorContractIdSchema,
  status: investorContractStatusSchema,
  effectiveFrom: isoDateSchema,
  signedOn: nullableDate,
  terms: investorContractTermsSchema,
  sourceDocumentIds: sourceDocumentIdsInput,
}).strict().superRefine((value, context) => {
  if (value.status === "active" && value.sourceDocumentIds.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceDocumentIds"], message: "An active contract version requires an existing source document reference" });
});
export type CreateInvestorContractVersionPayload = z.infer<typeof createInvestorContractVersionPayloadSchema>;

export const createInvestorDebtPayloadSchema = z.object({
  instrumentId: investorInstrumentIdSchema,
  legalEntityId: legalEntityIdSchema,
  debtKind: z.enum(["private_loan", "member_loan"]),
  currency: currencyCodeSchema,
  originalPrincipalCents: nonNegativeCentsSchema,
  fundedCapitalCents: nonNegativeCentsSchema.nullable(),
  outstandingPrincipalCents: nonNegativeCentsSchema.nullable(),
  annualRate: rateSchema,
  schedule: investorScheduleSchema,
  paymentDay: z.number().int().min(1).max(31).nullable(),
  monthEndRule: investorMonthEndRuleSchema,
  firstDueMonth: monthSchema.nullable(),
  interestOnlyUntil: monthSchema.nullable(),
  maturityOn: nullableDate,
  amortizationMonths: z.number().int().positive().nullable(),
  balloonCents: nonNegativeCentsSchema.nullable(),
  dayCount: investorDayCountSchema,
}).strict().superRefine((value, context) => {
  if (value.fundedCapitalCents !== null && centsToBigInt(value.fundedCapitalCents) > centsToBigInt(value.originalPrincipalCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fundedCapitalCents"], message: "Funded capital cannot exceed original principal" });
  if (value.outstandingPrincipalCents !== null && centsToBigInt(value.outstandingPrincipalCents) > centsToBigInt(value.originalPrincipalCents)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["outstandingPrincipalCents"], message: "Outstanding principal cannot exceed original principal" });
  if (value.schedule === "monthly" && value.paymentDay === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentDay"], message: "Monthly debt requires a payment day" });
});
export type CreateInvestorDebtPayload = z.infer<typeof createInvestorDebtPayloadSchema>;

export const updateInvestorDebtPayloadSchema = z.object({
  debtId: investorDebtIdSchema,
  fundedCapitalCents: nonNegativeCentsSchema.nullable().optional(),
  outstandingPrincipalCents: nonNegativeCentsSchema.nullable().optional(),
  annualRate: rateSchema.optional(),
  paymentDay: z.number().int().min(1).max(31).nullable().optional(),
  monthEndRule: investorMonthEndRuleSchema.optional(),
  maturityOn: nullableDate,
  balloonCents: nonNegativeCentsSchema.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 1, "At least one investor debt field is required");
export type UpdateInvestorDebtPayload = z.infer<typeof updateInvestorDebtPayloadSchema>;

export const generateInvestorObligationsPayloadSchema = z.object({
  instrumentId: investorInstrumentIdSchema,
  contractId: investorContractIdSchema,
  fromMonth: monthSchema,
  throughMonth: monthSchema,
}).strict().superRefine((value, context) => {
  if (value.throughMonth < value.fromMonth) context.addIssue({ code: z.ZodIssueCode.custom, path: ["throughMonth"], message: "throughMonth must be on or after fromMonth" });
});
export type GenerateInvestorObligationsPayload = z.infer<typeof generateInvestorObligationsPayloadSchema>;

const paymentAmountInputSchema = z.object({
  principalCents: cents,
  interestCents: cents,
  returnOfCapitalCents: cents,
  distributionCents: cents,
  feeCents: cents,
  balloonCents: cents,
  unclassifiedCents: cents.default("0"),
}).strict().superRefine((value, context) => {
  if (Object.values(value).every(item => item === "0")) context.addIssue({ code: z.ZodIssueCode.custom, message: "A payment must contain an amount" });
});

export const recordInvestorPaymentPayloadSchema = z.object({
  accountId: investorAccountIdSchema,
  instrumentId: investorInstrumentIdSchema,
  contractId: investorContractIdSchema.nullable().optional(),
  obligationId: investorObligationIdSchema.nullable().optional(),
  remittanceInstructionId: investorRemittanceInstructionIdSchema.nullable().optional(),
  kind: investorPaymentKindSchema,
  method: investorPaymentMethodSchema,
  paymentOn: isoDateSchema,
  periodMonth: monthSchema.nullable().optional(),
  currency: currencyCodeSchema,
  amounts: paymentAmountInputSchema,
  source: investorFinancialSourceRequestSchema.optional(),
  correctionReason: z.string().trim().max(2_000).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.source?.provider === "qbo" && !investorPaymentKindMatchesSingleComponent(value.kind, value.amounts)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["amounts"], message: "QBO-linked investor payments require one known component matching the payment kind" });
  }
});
export type RecordInvestorPaymentPayload = z.infer<typeof recordInvestorPaymentPayloadSchema>;

export const linkInvestorPaymentSourcePayloadSchema = z.object({
  paymentId: investorPaymentIdSchema,
  source: qboSourceRequestSchema,
}).strict().refine(value => value.source.provider === "qbo", "Posted accounting links must use a QBO source");
export type LinkInvestorPaymentSourcePayload = z.infer<typeof linkInvestorPaymentSourcePayloadSchema>;

export const settleInvestorPaymentPayloadSchema = z.object({
  paymentId: investorPaymentIdSchema,
  source: settlementSourceRequestSchema,
}).strict().refine(value => value.source.provider === "bank" || value.source.provider === "plaid", "Settlement evidence must use a bank or Plaid source");
export type SettleInvestorPaymentPayload = z.infer<typeof settleInvestorPaymentPayloadSchema>;

export const reverseInvestorPaymentPayloadSchema = z.object({
  paymentId: investorPaymentIdSchema,
  reason: text(2_000),
  paymentOn: isoDateSchema,
}).strict();
export type ReverseInvestorPaymentPayload = z.infer<typeof reverseInvestorPaymentPayloadSchema>;

/** Replace an unverified manual record through a reversal plus a new manual
 * row. The original payment remains immutable and auditable. */
export const editInvestorManualPaymentPayloadSchema = z.object({
  paymentId: investorPaymentIdSchema,
  obligationId: investorObligationIdSchema.nullable().optional(),
  contractId: investorContractIdSchema.nullable().optional(),
  kind: investorPaymentKindSchema,
  method: investorPaymentMethodSchema.refine(value => value !== "qbo", "Manual payment edits cannot use the QBO method"),
  paymentOn: isoDateSchema,
  periodMonth: monthSchema.nullable().optional(),
  amounts: paymentAmountInputSchema,
  reason: text(2_000),
}).strict();
export type EditInvestorManualPaymentPayload = z.infer<typeof editInvestorManualPaymentPayloadSchema>;

const providerPartyInputShape = {
  providerParty: investorProviderPartyReferenceSchema,
  partyKind: investorPartyKindSchema,
  contactId: investorContactIdSchema.nullable().optional(),
  displayName: text(240),
  sourceDocumentId: documentReferenceIdSchema.nullable().optional(),
  effectiveFrom: isoDateSchema,
  effectiveTo: nullableDate,
};
const providerPartyInputSchema = z.object(providerPartyInputShape).strict().superRefine((value, context) => {
  if (value.partyKind === "third_party_lender" && !value.sourceDocumentId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceDocumentId"], message: "Third-party parties require a written document reference" });
});
export const createInvestorPartyMappingPayloadSchema = z.object({ accountId: investorAccountIdSchema, ...providerPartyInputShape }).strict().superRefine((value, context) => {
  if (value.partyKind === "third_party_lender" && !value.sourceDocumentId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceDocumentId"], message: "Third-party parties require a written document reference" });
});
export type CreateInvestorPartyMappingPayload = z.infer<typeof createInvestorPartyMappingPayloadSchema>;
export const updateInvestorPartyMappingPayloadSchema = z.object({ mappingId: investorPartyMappingIdSchema, displayName: text(240).optional(), sourceDocumentId: documentReferenceIdSchema.nullable().optional(), effectiveTo: nullableDate }).strict().refine(value => Object.keys(value).length > 1, "At least one investor party mapping field is required");
export type UpdateInvestorPartyMappingPayload = z.infer<typeof updateInvestorPartyMappingPayloadSchema>;
export const archiveInvestorPartyMappingPayloadSchema = z.object({ mappingId: investorPartyMappingIdSchema }).strict();
export type ArchiveInvestorPartyMappingPayload = z.infer<typeof archiveInvestorPartyMappingPayloadSchema>;

export const createInvestorRemittanceInstructionPayloadSchema = z.object({
  accountId: investorAccountIdSchema, instrumentId: investorInstrumentIdSchema, contractId: investorContractIdSchema.nullable().optional(),
  partyMappingId: investorPartyMappingIdSchema, sourceDocumentId: documentReferenceIdSchema, effectiveFrom: isoDateSchema, effectiveTo: nullableDate, notes: optionalText(2_000),
}).strict();
export type CreateInvestorRemittanceInstructionPayload = z.infer<typeof createInvestorRemittanceInstructionPayloadSchema>;
export const updateInvestorRemittanceInstructionPayloadSchema = z.object({ instructionId: investorRemittanceInstructionIdSchema, sourceDocumentId: documentReferenceIdSchema.optional(), effectiveTo: nullableDate, notes: optionalText(2_000) }).strict().refine(value => Object.keys(value).length > 1, "At least one remittance instruction field is required");
export type UpdateInvestorRemittanceInstructionPayload = z.infer<typeof updateInvestorRemittanceInstructionPayloadSchema>;
export const archiveInvestorRemittanceInstructionPayloadSchema = z.object({ instructionId: investorRemittanceInstructionIdSchema }).strict();
export type ArchiveInvestorRemittanceInstructionPayload = z.infer<typeof archiveInvestorRemittanceInstructionPayloadSchema>;

export const INVESTOR_COMMAND_KINDS = [
  "investor.account.create", "investor.account.update", "investor.account.archive",
  "investor.instrument.create", "investor.instrument.update", "investor.instrument.archive",
  "investor.contract.create", "investor.contract.version.create",
  "investor.debt.create", "investor.debt.update",
  "investor.obligation.generate", "investor.payment.record", "investor.payment.link_qbo",
  "investor.payment.settle", "investor.payment.reverse",
  "investor.payment.edit_manual",
  "investor.party_mapping.create", "investor.party_mapping.update", "investor.party_mapping.archive",
  "investor.remittance.create", "investor.remittance.update", "investor.remittance.archive",
] as const;
export type InvestorCommandKind = (typeof INVESTOR_COMMAND_KINDS)[number];

export const investorCommandPayloadSchemas = {
  "investor.account.create": createInvestorAccountPayloadSchema,
  "investor.account.update": updateInvestorAccountPayloadSchema,
  "investor.account.archive": archiveInvestorAccountPayloadSchema,
  "investor.instrument.create": createInvestorInstrumentPayloadSchema,
  "investor.instrument.update": updateInvestorInstrumentPayloadSchema,
  "investor.instrument.archive": archiveInvestorInstrumentPayloadSchema,
  "investor.contract.create": createInvestorContractPayloadSchema,
  "investor.contract.version.create": createInvestorContractVersionPayloadSchema,
  "investor.debt.create": createInvestorDebtPayloadSchema,
  "investor.debt.update": updateInvestorDebtPayloadSchema,
  "investor.obligation.generate": generateInvestorObligationsPayloadSchema,
  "investor.payment.record": recordInvestorPaymentPayloadSchema,
  "investor.payment.link_qbo": linkInvestorPaymentSourcePayloadSchema,
  "investor.payment.settle": settleInvestorPaymentPayloadSchema,
  "investor.payment.reverse": reverseInvestorPaymentPayloadSchema,
  "investor.payment.edit_manual": editInvestorManualPaymentPayloadSchema,
  "investor.party_mapping.create": createInvestorPartyMappingPayloadSchema,
  "investor.party_mapping.update": updateInvestorPartyMappingPayloadSchema,
  "investor.party_mapping.archive": archiveInvestorPartyMappingPayloadSchema,
  "investor.remittance.create": createInvestorRemittanceInstructionPayloadSchema,
  "investor.remittance.update": updateInvestorRemittanceInstructionPayloadSchema,
  "investor.remittance.archive": archiveInvestorRemittanceInstructionPayloadSchema,
} as const;

export type InvestorCommandPayload = { [K in InvestorCommandKind]: z.output<(typeof investorCommandPayloadSchemas)[K]> };
export function investorCommandPayloadSchema<TKind extends InvestorCommandKind>(kind: TKind): (typeof investorCommandPayloadSchemas)[TKind] { return investorCommandPayloadSchemas[kind]; }
export function parseInvestorCommandPayload<TKind extends InvestorCommandKind>(kind: TKind, input: unknown): InvestorCommandPayload[TKind] { return investorCommandPayloadSchemas[kind].parse(input) as InvestorCommandPayload[TKind]; }

export type InvestorScope = CompanyScope & { readonly legalEntityId: LegalEntityId };
export interface InvestorReadContext extends InvestorScope { readonly accountId?: InvestorAccountId; readonly instrumentId?: InvestorInstrumentId; }

export interface InvestorDetailQuery extends InvestorReadContext {}

export interface InvestorDomainSourceContext {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly currency: CurrencyCode;
  readonly source: InvestorFinancialSource;
  readonly allocatedCents: MoneyCents;
  readonly allocationKey: string;
}

export type InvestorDocumentReference = DocumentReferenceId;
export type InvestorPropertyReference = PropertyReferenceId;
export type InvestorProjectReference = RecordReferenceId;
export type InvestorEffectiveDate = IsoDate;
export type InvestorRecordedAt = IsoTimestamp;
export type InvestorContractRevision = Revision;
