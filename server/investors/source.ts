import {
  financialSourceReferenceSchema,
  type FinancialSourceAllocationPort,
  type FinancialProviderPaymentContext,
  type FinancialProviderPaymentContextPort,
  type FinancialProviderAccountingPurpose,
  type FinancialProviderPurposeEvidence,
  type FinancialProviderPayeeType,
  type FinancialSourceLineResolution,
  type FinancialSourceReadPort,
  type FinancialSourceReference,
} from "../../shared/accounting/source";
import {
  investorFinancialSourceSchema,
  investorFinancialSourceRequestSchema,
  investorPaymentKindMatchesSingleComponent,
  type InvestorFinancialSourceRequest,
  type InvestorFinancialSource,
  type InvestorPaymentAmounts,
  type InvestorPaymentKind,
  type InvestorProviderPartyReference,
} from "../../shared/investors";
import { centsToBigInt, type CompanyScope, type MoneyCents } from "../../shared/company";

export interface InvestorSourceVerificationInput {
  readonly scope: CompanyScope & { readonly legalEntityId: string };
  readonly accountId: string;
  readonly instrumentId: string;
  readonly paymentId: string;
  readonly obligationId?: string;
  readonly amountCents: MoneyCents | string;
  readonly currency: string;
  readonly kind: InvestorPaymentKind;
  readonly amounts: InvestorPaymentAmounts;
  readonly source: InvestorFinancialSourceRequest;
  /** Provider party references authorized by the investor/contact/remittance mapping. */
  readonly expectedCounterparties?: readonly InvestorProviderPartyReference[];
}

export interface InvestorSourceReleaseInput extends Omit<InvestorSourceVerificationInput, "source"> {
  readonly source: InvestorFinancialSource;
}

export interface InvestorPostedSourceVerification {
  readonly source: InvestorFinancialSource;
  readonly allocationKey: string;
}

export interface InvestorSourceResolver {
  verifyPostedPayment(input: InvestorSourceVerificationInput): Promise<InvestorPostedSourceVerification | null>;
  verifySettlement(input: InvestorSourceVerificationInput): Promise<InvestorPostedSourceVerification | null>;
  releasePostedPayment?(input: InvestorSourceReleaseInput): Promise<void>;
}

/** A live source is mandatory for a posted or settled state. */
export class FailClosedInvestorSourceResolver implements InvestorSourceResolver {
  async verifyPostedPayment(): Promise<InvestorPostedSourceVerification | null> { return null; }
  async verifySettlement(): Promise<InvestorPostedSourceVerification | null> { return null; }
}

export interface AccountingInvestorSourceResolverOptions {
  readonly read: FinancialSourceReadPort;
  readonly allocations: FinancialSourceAllocationPort;
  /** Canonical accounting reader for provider payment subtype and flow. */
  readonly paymentContext?: FinancialProviderPaymentContextPort;
  /**
   * The accounting mirror deliberately keeps provider object payloads out of
   * the shared read port. The accounting integration supplies this callback once it
   * has verified the provider payment subtype, cash account, payee mapping,
   * and receiving legal entity. Without it this adapter stays fail closed.
   */
  readonly resolvePaymentContext?: (
    input: InvestorSourceVerificationInput,
    resolution: FinancialSourceLineResolution,
  ) => Promise<{ paymentType: "Cash" | "Check" | "CreditCard" | "ACH" | "Wire" | "BillPayment" | "Deposit"; accountObjectId: string; counterpartyObjectId: string; counterpartyObjectType: FinancialProviderPayeeType; legalEntityId: string; purpose?: FinancialProviderAccountingPurpose; purposeEvidence?: FinancialProviderPurposeEvidence; purposeMappedAt?: string | null } | null>;
  readonly verifySettlement?: (input: InvestorSourceVerificationInput) => Promise<InvestorPostedSourceVerification | null>;
}

const ELIGIBLE_QBO_PAYMENT_OBJECTS = new Set(["Deposit", "Purchase", "BillPayment"]);

/**
 * Adapter for the accounting integration's verified source and allocation ports.
 * It deliberately refuses a generic ledger line, journal entry, or a source
 * with partial coverage. Central allocation is reserved before a payment is
 * labeled posted, so a retry cannot consume the same provider amount twice.
 */
export function createAccountingInvestorSourceResolver(options: AccountingInvestorSourceResolverOptions): InvestorSourceResolver {
  return {
    async verifyPostedPayment(input): Promise<InvestorPostedSourceVerification | null> {
      const request = investorFinancialSourceRequestSchema.parse(input.source);
      if (request.provider !== "qbo") return null;
      // A provider line is only attributable to this investor through an
      // effective, scoped party or remittance mapping. Callers that bypass
      // the command service do not get an ownership proof by omission.
      if (!input.expectedCounterparties || input.expectedCounterparties.length === 0) return null;
      const reference = financialSourceReferenceSchema.parse(request.reference);
      if (reference.organizationId !== input.scope.organizationId || reference.legalEntityId !== input.scope.legalEntityId) return null;
      if (request.currency !== input.currency || centsToBigInt(request.amountCents) < centsToBigInt(input.amountCents)) return null;
      if (!ELIGIBLE_QBO_PAYMENT_OBJECTS.has(reference.objectType)) return null;
      const resolution = await options.read.resolveLine({
        scope: {
          provider: "qbo",
          organizationId: reference.organizationId,
          legalEntityId: reference.legalEntityId,
          environment: reference.environment,
          realmId: reference.realmId,
        },
        objectType: reference.objectType,
        objectId: reference.objectId,
        lineId: reference.lineId ?? undefined,
      });
      if (!isEligiblePostedResolution(resolution, reference, input)) return null;
      const context = await resolvePaymentContext(options, input, resolution, reference);
      if (!context) return null;
      if (context.source.organizationId !== input.scope.organizationId
        || context.source.legalEntityId !== input.scope.legalEntityId
        || context.source.environment !== reference.environment
        || context.source.realmId !== reference.realmId
        || context.source.objectType !== reference.objectType
        || context.source.objectId !== reference.objectId
        || context.source.lineId !== reference.lineId
        || context.source.version !== resolution.source.version
        || resolution.source.version !== reference.version
        || context.currency !== input.currency
        || centsToBigInt(context.amountCents) < centsToBigInt(input.amountCents)
        || context.postingState !== "posted"
        || context.payeeObjectId === null
        || context.payeeObjectType === null) return null;
      if (!hasTrustedInvestorPurpose(input, context)) return null;
      if (input.expectedCounterparties !== undefined
        && !input.expectedCounterparties.some(party => party.provider === "qbo"
          && party.organizationId === context.source.organizationId
          && party.legalEntityId === context.source.legalEntityId
          && party.environment === context.source.environment
          && party.realmId === context.source.realmId
          && party.objectId === context.payeeObjectId
          && party.objectType === context.payeeObjectType)) return null;
      const expectedIncoming = input.kind === "contribution";
      const eligiblePaymentType = expectedIncoming
        ? reference.objectType === "Deposit" && context.subtype === "Deposit"
        : reference.objectType === "Purchase"
          ? ["Cash", "Check", "CreditCard", "ACH", "Wire"].includes(context.subtype) && resolution.lineRole === "expense" && resolution.direction === "debit"
          : reference.objectType === "BillPayment"
            ? context.subtype === "BillPayment" && resolution.lineRole === "payment_source" && resolution.direction === "credit"
            : false;
      if (expectedIncoming && (resolution.direction !== "debit" || resolution.flow !== "incoming" || resolution.lineRole !== "receipt" || context.flow !== "incoming")) return null;
      if (!expectedIncoming && (resolution.flow !== "outgoing" || context.flow !== "outgoing" || !eligiblePaymentType)) return null;
      if (expectedIncoming && !eligiblePaymentType) return null;
      await options.allocations.reserve({
        source: reference,
        consumerKind: "investor_payment",
        consumerId: input.paymentId,
        amountCents: input.amountCents,
        currency: input.currency,
      });
      // The central allocator owns the cap and only returns after the locked
      // reservation succeeds. Its post-reservation available balance is
      // expected to be zero for a full match, so do not compare it to the
      // requested amount here.
      const verifiedSource: InvestorFinancialSource = {
        provider: "qbo", reference: resolution.source, currency: resolution.currency, amountCents: resolution.amountCents,
        coverage: "verified", verifiedAt: resolution.watermark.observedAt, watermark: resolution.watermark,
      };
      return { source: verifiedSource, allocationKey: `${reference.objectType}:${reference.objectId}:${reference.lineId ?? "*"}:${reference.version}` };
    },

    async verifySettlement(input): Promise<InvestorPostedSourceVerification | null> {
      // Bank/Plaid settlement evidence gets a separate provider-specific port
      // when the treasury worker is integrated. Never infer it from QBO.
      return options.verifySettlement ? options.verifySettlement(input) : null;
    },

    async releasePostedPayment(input): Promise<void> {
      if (!options.allocations || input.source.provider !== "qbo") return;
      await options.allocations.release({
        source: input.source.reference,
        consumerKind: "investor_payment",
        consumerId: input.paymentId,
        amountCents: input.amountCents,
        currency: input.currency,
      });
    },
  };
}

async function resolvePaymentContext(
  options: AccountingInvestorSourceResolverOptions,
  input: InvestorSourceVerificationInput,
  resolution: FinancialSourceLineResolution,
  reference: FinancialSourceReference,
): Promise<{ source: FinancialSourceReference; cashAccountObjectId: string; payeeObjectId: string | null; payeeObjectType: FinancialProviderPayeeType | null; purpose: FinancialProviderAccountingPurpose; purposeEvidence: FinancialProviderPurposeEvidence; purposeMappedAt: string | null; flow: "incoming" | "outgoing"; amountCents: string; currency: string; postingState: "posted" | "voided" | "unknown"; subtype: "Cash" | "Check" | "CreditCard" | "ACH" | "Wire" | "BillPayment" | "Deposit" } | null> {
  if (options.paymentContext) {
    const context: FinancialProviderPaymentContext | null = await options.paymentContext.readPaymentContext({
      scope: {
        provider: "qbo",
        organizationId: reference.organizationId,
        legalEntityId: reference.legalEntityId,
        environment: reference.environment,
        realmId: reference.realmId,
      },
      objectType: reference.objectType,
      objectId: reference.objectId,
      lineId: reference.lineId ?? undefined,
    });
    return context ? {
      source: context.source,
      cashAccountObjectId: context.cashAccountObjectId,
      payeeObjectId: context.payeeObjectId,
      payeeObjectType: context.payeeObjectType,
      purpose: context.purpose,
      purposeEvidence: context.purposeEvidence,
      purposeMappedAt: context.purposeMappedAt,
      flow: context.flow,
      amountCents: context.amountCents,
      currency: context.currency,
      postingState: context.postingState,
      subtype: context.subtype,
    } : null;
  }
  if (!options.resolvePaymentContext) return null;
  const legacy = await options.resolvePaymentContext(input, resolution);
  if (!legacy || legacy.legalEntityId !== input.scope.legalEntityId) return null;
  return legacy ? {
    source: reference,
    cashAccountObjectId: legacy.accountObjectId,
    payeeObjectId: legacy.counterpartyObjectId,
    payeeObjectType: legacy.counterpartyObjectType,
    purpose: legacy.purpose ?? "unknown",
    purposeEvidence: legacy.purposeEvidence ?? "provider_account_unmapped",
    purposeMappedAt: legacy.purposeMappedAt ?? null,
    flow: input.kind === "contribution" ? "incoming" : "outgoing",
    amountCents: resolution.amountCents,
    currency: resolution.currency,
    postingState: resolution.postingState,
    subtype: legacy.paymentType,
  } : null;
}

function expectedInvestorPurpose(kind: InvestorPaymentKind): FinancialProviderAccountingPurpose | null {
  switch (kind) {
    case "contribution": return "capital_contribution";
    case "distribution":
    case "return_of_capital": return "distribution";
    case "principal":
    case "balloon": return "principal";
    case "interest": return "interest";
    case "fee": return "expense";
    case "correction": return null;
  }
}

function hasTrustedInvestorPurpose(input: InvestorSourceVerificationInput, context: { purpose: FinancialProviderAccountingPurpose; purposeEvidence: FinancialProviderPurposeEvidence; purposeMappedAt: string | null }): boolean {
  const expected = expectedInvestorPurpose(input.kind);
  if (!expected || context.purpose === "unknown" || context.purpose !== expected || context.purposeEvidence === "provider_account_unmapped" || context.purposeMappedAt === null) return false;
  // A provider purpose cannot prove an unclassified or mixed principal /
  // interest / distribution split. It must also agree with the exact local
  // component named by the investor payment kind; otherwise an interest
  // purpose could incorrectly attest a principal-only local payment.
  return investorPaymentKindMatchesSingleComponent(input.kind, input.amounts);
}

function isEligiblePostedResolution(
  resolution: FinancialSourceLineResolution | null,
  reference: FinancialSourceReference,
  input: InvestorSourceVerificationInput,
): resolution is FinancialSourceLineResolution {
  if (!resolution) return false;
  if (resolution.source.organizationId !== reference.organizationId
    || resolution.source.legalEntityId !== reference.legalEntityId
    || resolution.source.environment !== reference.environment
    || resolution.source.realmId !== reference.realmId
    || resolution.source.objectType !== reference.objectType
    || resolution.source.objectId !== reference.objectId
    || resolution.source.lineId !== reference.lineId
    || resolution.source.version !== reference.version) return false;
  if (resolution.transactionType !== reference.objectType) return false;
  if (resolution.postingState !== "posted") return false;
  if (resolution.flow === "unknown" || resolution.lineRole === "unknown") return false;
  if (resolution.currency !== input.currency || centsToBigInt(resolution.amountCents) < centsToBigInt(input.amountCents)) return false;
  if (resolution.postedOn === null) return false;
  if (resolution.settlement.state === "voided") return false;
  return true;
}
