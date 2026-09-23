import {
  authorizeCompanyRead,
  type AuthenticatedPrincipal,
} from "../company/authorization";
import { ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import {
  addPaymentAmounts,
  obligationStatus,
  sumPaymentAmounts,
} from "../../shared/investors/calculations";
import {
  investorAccountSchema,
  investorAccountRollupSchema,
  investorContactListResponseSchema,
  investorContactOptionSchema,
  investorDocumentListResponseSchema,
  investorDocumentOptionSchema,
  investorContractSchema,
  investorContractTermsSchema,
  investorContractVersionSchema,
  investorDebtSchema,
  investorDetailSchema,
  investorInstrumentSchema,
  investorListQuerySchema,
  investorListResponseSchema,
  investorMonthlyPaymentRowSchema,
  investorMonthlyPaymentResponseSchema,
  investorObligationSchema,
  investorPaymentLogQuerySchema,
  investorPaymentSchema,
  investorPaymentAmountsSchema,
  investorActivitySchema,
  investorPartyMappingSchema,
  investorRemittanceInstructionSchema,
  investorFinancialSourceSchema,
  investorFinancialSourceResponseSchema,
  type InvestorAccount,
  type InvestorAccountRollup,
  type InvestorContactListResponse,
  type InvestorDocumentListResponse,
  type InvestorContract,
  type InvestorContractVersion,
  type InvestorDebt,
  type InvestorDetail,
  type InvestorInstrument,
  type InvestorListQuery,
  type InvestorListResponse,
  type InvestorMonthlyPaymentRow,
  type InvestorMonthlyPaymentResponse,
  type InvestorObligation,
  type InvestorPayment,
  type InvestorPaymentLogQuery,
  type InvestorPaymentAmounts,
  type InvestorPostedSourceValidity,
  type InvestorActivity,
  type InvestorPartyMapping,
  type InvestorRemittanceInstruction,
  type InvestorFinancialSourceResponse,
} from "../../shared/investors";
import { type FinancialSourceLineResolution, type FinancialSourceReadPort } from "../../shared/accounting/source";
import { sameFinancialSourceReference } from "../../shared/projects/source-lines";
import { companyScopeSchema, centsFromBigInt, centsToBigInt, type CompanyScope } from "../../shared/company";
import { dbCents, dbDate, dbDecimal, dbNullableDate, dbNullableString, dbRevision, dbString, dbTimestamp, decodeCursor, encodeCursor, parseJson, resolveEffectiveDate } from "./helpers";
import {
  addMonths,
  amortizationScheduleSchema,
  buildAmortizationSchedule,
  buildInstrumentRollforward,
  investorCalendarState,
  monthOf,
  type AmortizationSchedule,
  type InstrumentRollforwardInput,
} from "../../shared/investors/rollforward";
import {
  investorDebtMaturityQuerySchema,
  investorDebtMaturityResponseSchema,
  investorDebtMaturitySchema,
  investorInstrumentFinancialsQuerySchema,
  investorInstrumentFinancialsSchema,
  investorPaymentCalendarItemSchema,
  investorPaymentCalendarQuerySchema,
  investorPaymentCalendarResponseSchema,
  type InvestorDebtMaturityQuery,
  type InvestorDebtMaturityResponse,
  type InvestorInstrumentFinancials,
  type InvestorInstrumentFinancialsQuery,
  type InvestorPaymentCalendarQuery,
  type InvestorPaymentCalendarResponse,
} from "../../shared/investors/reports";

const READ_ROLES = ["owner", "admin", "finance", "operations_pm", "project_manager", "read_only_reviewer"] as const;

interface MonthlyPaymentCursor {
  readonly periodMonth: string;
  readonly dueOn: string;
  readonly id: string;
}

interface FinancialSourceCursor {
  readonly from: string | null;
  readonly through: string | null;
  readonly realms: Readonly<Record<string, string | null>>;
}

function encodeFinancialSourceCursor(value: FinancialSourceCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeFinancialSourceCursor(value: string | undefined, from?: string, through?: string): FinancialSourceCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const realms = parsed.realms;
    if ((parsed.from !== null && typeof parsed.from !== "string") || (parsed.through !== null && typeof parsed.through !== "string") || !realms || typeof realms !== "object" || Array.isArray(realms)) throw new Error("invalid");
    if ((parsed.from as string | null) !== (from ?? null) || (parsed.through as string | null) !== (through ?? null)) throw new Error("range");
    const normalized: Record<string, string | null> = {};
    for (const [key, cursor] of Object.entries(realms)) {
      if (cursor !== null && typeof cursor !== "string") throw new Error("realm cursor");
      normalized[key] = cursor as string | null;
    }
    return { from: parsed.from as string | null, through: parsed.through as string | null, realms: normalized };
  } catch {
    throw new ValidationCommandError("Investor source cursor is invalid", { reason: "invalid_investor_source_cursor" });
  }
}

function encodeMonthlyPaymentCursor(row: InvestorObligation): string {
  return encodeCursor({ updatedAt: `${row.periodMonth}|${row.dueOn}`, id: String(row.id) });
}

function decodeMonthlyPaymentCursor(value: string | undefined): MonthlyPaymentCursor | null {
  if (!value) return null;
  const cursor = decodeCursor(value);
  if (!cursor) return null;
  const [periodMonth, dueOn] = cursor.updatedAt.split("|");
  if (!periodMonth || !dueOn || !/^\d{4}-\d{2}-01$/.test(periodMonth) || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    throw new ValidationCommandError("Investor payment cursor is invalid", { reason: "invalid_investor_payment_cursor" });
  }
  return { periodMonth, dueOn, id: cursor.id };
}

function assertReadScope(principal: AuthenticatedPrincipal, scope: CompanyScope): void {
  authorizeCompanyRead(principal, companyScopeSchema.parse(scope), READ_ROLES);
}

function valuesArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function sumAmounts(values: readonly InvestorPaymentAmounts[]): InvestorPaymentAmounts {
  return values.reduce((total, value) => addPaymentAmounts(total, value), {
    principalCents: centsFromBigInt(BigInt(0)), interestCents: centsFromBigInt(BigInt(0)),
    returnOfCapitalCents: centsFromBigInt(BigInt(0)), distributionCents: centsFromBigInt(BigInt(0)),
    feeCents: centsFromBigInt(BigInt(0)), balloonCents: centsFromBigInt(BigInt(0)), unclassifiedCents: centsFromBigInt(BigInt(0)),
  });
}

function mappedAccount(row: Record<string, unknown>, rollups: readonly InvestorAccountRollup[]): InvestorAccount {
  return investorAccountSchema.parse({
    id: dbString(row, "id"), organizationId: dbString(row, "organization_id"), contactId: dbString(row, "contact_id"),
    displayName: dbString(row, "display_name"), status: dbString(row, "status"), notes: dbNullableString(row, "notes"),
    rollups, recordRevision: dbRevision(row.record_revision), updatedAt: dbTimestamp(row, "updated_at"), archivedAt: row.archived_at === null || row.archived_at === undefined ? null : dbTimestamp(row, "archived_at"),
  });
}

function mappedInstrument(row: Record<string, unknown>): InvestorInstrument {
  return investorInstrumentSchema.parse({
    id: dbString(row, "id"), accountId: dbString(row, "account_id"), organizationId: dbString(row, "organization_id"), name: dbString(row, "name"),
    kind: dbString(row, "kind"), status: dbString(row, "status"), currency: dbString(row, "currency"), committedCents: dbCents(row.committed_cents, "committed_cents"),
    facePrincipalCents: dbCents(row.face_principal_cents, "face_principal_cents"), effectiveFrom: dbDate(row, "effective_from"), maturityOn: dbNullableDate(row, "maturity_on"),
    ownershipBps: row.ownership_bps === null || row.ownership_bps === undefined ? null : Number(row.ownership_bps), legalEntityId: dbString(row, "legal_entity_id"),
    propertyIds: valuesArray(row.property_ids), projectIds: valuesArray(row.project_ids), notes: dbNullableString(row, "notes"), recordRevision: dbRevision(row.record_revision),
    updatedAt: dbTimestamp(row, "updated_at"), archivedAt: row.archived_at === null || row.archived_at === undefined ? null : dbTimestamp(row, "archived_at"),
  });
}

function mapTerms(row: Record<string, unknown>): InvestorContractVersion["terms"] {
  return investorContractTermsSchema.parse({
    schedule: dbString(row, "schedule"), paymentDay: row.payment_day === null || row.payment_day === undefined ? null : Number(row.payment_day),
    monthEndRule: dbString(row, "month_end_rule"), annualRate: row.annual_rate === null || row.annual_rate === undefined ? null : dbDecimal(row.annual_rate, "annual_rate"),
    preferredReturnRate: row.preferred_return_rate === null || row.preferred_return_rate === undefined ? null : dbDecimal(row.preferred_return_rate, "preferred_return_rate"),
    returnMultiple: row.return_multiple === null || row.return_multiple === undefined ? null : dbDecimal(row.return_multiple, "return_multiple"),
    fixedPaymentCents: row.fixed_payment_cents === null || row.fixed_payment_cents === undefined ? null : dbCents(row.fixed_payment_cents, "fixed_payment_cents"),
    principalPaymentCents: row.principal_payment_cents === null || row.principal_payment_cents === undefined ? null : dbCents(row.principal_payment_cents, "principal_payment_cents"),
    interestPaymentCents: row.interest_payment_cents === null || row.interest_payment_cents === undefined ? null : dbCents(row.interest_payment_cents, "interest_payment_cents"),
    returnOfCapitalCents: row.return_of_capital_cents === null || row.return_of_capital_cents === undefined ? null : dbCents(row.return_of_capital_cents, "return_of_capital_cents"),
    distributionCents: row.distribution_cents === null || row.distribution_cents === undefined ? null : dbCents(row.distribution_cents, "distribution_cents"),
    balloonCents: row.balloon_cents === null || row.balloon_cents === undefined ? null : dbCents(row.balloon_cents, "balloon_cents"),
    originalPrincipalCents: row.original_principal_cents === null || row.original_principal_cents === undefined ? null : dbCents(row.original_principal_cents, "original_principal_cents"),
    maturityTotalCents: row.maturity_total_cents === null || row.maturity_total_cents === undefined ? null : dbCents(row.maturity_total_cents, "maturity_total_cents"),
    fixedProfitCents: row.fixed_profit_cents === null || row.fixed_profit_cents === undefined ? null : dbCents(row.fixed_profit_cents, "fixed_profit_cents"),
    maturityPayoffCents: row.maturity_payoff_cents === null || row.maturity_payoff_cents === undefined ? null : dbCents(row.maturity_payoff_cents, "maturity_payoff_cents"),
    thirdPartyInstallmentCents: row.third_party_installment_cents === null || row.third_party_installment_cents === undefined ? null : dbCents(row.third_party_installment_cents, "third_party_installment_cents"),
    investorSpreadCents: row.investor_spread_cents === null || row.investor_spread_cents === undefined ? null : dbCents(row.investor_spread_cents, "investor_spread_cents"),
    unknownComponentKinds: Array.isArray(row.unknown_component_kinds) ? row.unknown_component_kinds.filter((value): value is string => typeof value === "string") : [],
    interestOnly: Boolean(row.interest_only), dayCount: dbString(row, "day_count"),
  });
}

function mappedContract(row: Record<string, unknown>): InvestorContract {
  return investorContractSchema.parse({ id: dbString(row, "id"), instrumentId: dbString(row, "instrument_id"), organizationId: dbString(row, "organization_id"), title: dbString(row, "title"), kind: dbString(row, "kind"), status: dbString(row, "status"), currentVersionId: row.current_version_id === null || row.current_version_id === undefined ? null : dbString(row, "current_version_id"), recordRevision: dbRevision(row.record_revision), updatedAt: dbTimestamp(row, "updated_at"), archivedAt: row.archived_at === null || row.archived_at === undefined ? null : dbTimestamp(row, "archived_at") });
}

function mappedContractVersion(row: Record<string, unknown>, documentIds: readonly string[]): InvestorContractVersion {
  return investorContractVersionSchema.parse({ id: dbString(row, "id"), contractId: dbString(row, "contract_id"), versionNo: Number(row.version_no), status: dbString(row, "status"), effectiveFrom: dbDate(row, "effective_from"), signedOn: dbNullableDate(row, "signed_on"), effectiveTo: dbNullableDate(row, "effective_to"), sourceDocumentIds: documentIds, terms: mapTerms(row), createdBy: dbString(row, "created_by"), approvedBy: dbNullableString(row, "approved_by"), createdAt: dbTimestamp(row, "created_at") });
}

function mappedDebt(row: Record<string, unknown>): InvestorDebt {
  return investorDebtSchema.parse({ id: dbString(row, "id"), instrumentId: dbString(row, "instrument_id"), accountId: dbString(row, "account_id"), organizationId: dbString(row, "organization_id"), legalEntityId: dbString(row, "legal_entity_id"), debtKind: dbString(row, "debt_kind"), currency: dbString(row, "currency"), originalPrincipalCents: dbCents(row.original_principal_cents, "original_principal_cents"), fundedCapitalCents: row.funded_capital_cents === null || row.funded_capital_cents === undefined ? null : dbCents(row.funded_capital_cents, "funded_capital_cents"), outstandingPrincipalCents: row.outstanding_principal_cents === null || row.outstanding_principal_cents === undefined ? null : dbCents(row.outstanding_principal_cents, "outstanding_principal_cents"), annualRate: dbDecimal(row.annual_rate, "annual_rate"), schedule: dbString(row, "schedule"), paymentDay: row.payment_day === null || row.payment_day === undefined ? null : Number(row.payment_day), monthEndRule: dbString(row, "month_end_rule"), firstDueMonth: dbNullableDate(row, "first_due_month"), interestOnlyUntil: dbNullableDate(row, "interest_only_until"), maturityOn: dbNullableDate(row, "maturity_on"), amortizationMonths: row.amortization_months === null || row.amortization_months === undefined ? null : Number(row.amortization_months), balloonCents: row.balloon_cents === null || row.balloon_cents === undefined ? null : dbCents(row.balloon_cents, "balloon_cents"), dayCount: dbString(row, "day_count"), recordRevision: dbRevision(row.record_revision), updatedAt: dbTimestamp(row, "updated_at"), archivedAt: row.archived_at === null || row.archived_at === undefined ? null : dbTimestamp(row, "archived_at") });
}

function mappedPartyMapping(row: Record<string, unknown>): InvestorPartyMapping {
  return investorPartyMappingSchema.parse({
    id: dbString(row, "id"), accountId: dbString(row, "account_id"), organizationId: dbString(row, "organization_id"), legalEntityId: dbString(row, "legal_entity_id"),
    contactId: row.contact_id === null || row.contact_id === undefined ? null : dbString(row, "contact_id"), partyKind: dbString(row, "party_kind"), displayName: dbString(row, "display_name"),
    providerParty: { provider: dbString(row, "provider"), organizationId: dbString(row, "organization_id"), legalEntityId: dbString(row, "legal_entity_id"), environment: dbString(row, "provider_environment"), realmId: dbString(row, "provider_realm_id"), objectType: dbString(row, "provider_object_type"), objectId: dbString(row, "provider_object_id") },
    sourceDocumentId: row.source_document_id === null || row.source_document_id === undefined ? null : dbString(row, "source_document_id"), effectiveFrom: dbDate(row, "effective_from"), effectiveTo: dbNullableDate(row, "effective_to"), status: dbString(row, "status"), recordRevision: dbRevision(row.record_revision), updatedAt: dbTimestamp(row, "updated_at"), archivedAt: row.archived_at === null || row.archived_at === undefined ? null : dbTimestamp(row, "archived_at"),
  });
}

function mappedRemittance(row: Record<string, unknown>): InvestorRemittanceInstruction {
  return investorRemittanceInstructionSchema.parse({
    id: dbString(row, "id"), accountId: dbString(row, "account_id"), instrumentId: dbString(row, "instrument_id"), contractId: row.contract_id === null || row.contract_id === undefined ? null : dbString(row, "contract_id"), organizationId: dbString(row, "organization_id"), legalEntityId: dbString(row, "legal_entity_id"), partyMappingId: dbString(row, "party_mapping_id"), beneficiaryKind: dbString(row, "beneficiary_kind"), sourceDocumentId: dbString(row, "source_document_id"), effectiveFrom: dbDate(row, "effective_from"), effectiveTo: dbNullableDate(row, "effective_to"), status: dbString(row, "status"), notes: dbNullableString(row, "notes"), recordRevision: dbRevision(row.record_revision), updatedAt: dbTimestamp(row, "updated_at"), archivedAt: row.archived_at === null || row.archived_at === undefined ? null : dbTimestamp(row, "archived_at"),
  });
}

function mappedObligation(row: Record<string, unknown>, payments: readonly InvestorPayment[]): InvestorObligation {
  const recorded = payments.reduce((total, payment) => total + centsToBigInt(sumPaymentAmounts(payment.allocatedAmounts)), BigInt(0));
  const paymentById = new Map(payments.map(payment => [String(payment.id), payment]));
  const evidenceStatus = (payment: InvestorPayment): InvestorPayment["status"] => {
    const current = (payment.status === "qbo_posted" || payment.status === "review_required") && (payment.postedSource === null || payment.postedSourceValidity !== "current")
      ? "manual_recorded"
      : payment.status === "bank_settled" && payment.settlementSource === null
        ? "manual_recorded"
        : payment.status;
    if (current !== "reversed" || payment.reversesPaymentId === null) return current;
    const original = paymentById.get(String(payment.reversesPaymentId));
    if (!original) return current;
    return (original.status === "qbo_posted" || original.status === "review_required") && original.postedSource === null
      ? "manual_recorded"
      : original.status === "bank_settled" && original.settlementSource === null
        ? "manual_recorded"
        : original.status;
  };
  const reviewRequired = payments.some(payment => payment.status === "review_required" || (payment.postedSource !== null && payment.postedSourceValidity !== "current"));
  const posted = payments.filter(payment => evidenceStatus(payment) === "qbo_posted" || evidenceStatus(payment) === "bank_settled").reduce((total, payment) => total + centsToBigInt(sumPaymentAmounts(payment.allocatedAmounts)), BigInt(0));
  const settled = payments.filter(payment => evidenceStatus(payment) === "bank_settled").reduce((total, payment) => total + centsToBigInt(sumPaymentAmounts(payment.allocatedAmounts)), BigInt(0));
  const expected = row.total_expected_cents === null || row.total_expected_cents === undefined ? null : dbCents(row.total_expected_cents, "total_expected_cents");
  const knownMinimum = dbCents(row.known_minimum_cents ?? row.total_expected_cents ?? "0", "known_minimum_cents");
  const amountComplete = Boolean(row.amount_complete ?? expected !== null);
  const unknownExpected = row.unknown_expected_cents === null || row.unknown_expected_cents === undefined ? "0" : dbCents(row.unknown_expected_cents, "unknown_expected_cents");
  const status = obligationStatus({ expectedCents: expected, amountComplete, recordedCents: recorded.toString(), postedCents: posted.toString(), settledCents: settled.toString(), reviewRequired, reversed: payments.length > 0 && payments.every(payment => payment.status === "reversed") });
  return investorObligationSchema.parse({ id: dbString(row, "id"), accountId: dbString(row, "account_id"), instrumentId: dbString(row, "instrument_id"), contractId: dbString(row, "contract_id"), contractVersionId: dbString(row, "contract_version_id"), organizationId: dbString(row, "organization_id"), legalEntityId: dbString(row, "legal_entity_id"), periodMonth: dbDate(row, "period_month"), dueOn: dbDate(row, "due_on"), currency: dbString(row, "currency"), principalCents: dbCents(row.principal_cents, "principal_cents"), interestCents: dbCents(row.interest_cents, "interest_cents"), returnOfCapitalCents: dbCents(row.return_of_capital_cents, "return_of_capital_cents"), distributionCents: dbCents(row.distribution_cents, "distribution_cents"), feeCents: dbCents(row.fee_cents, "fee_cents"), balloonCents: dbCents(row.balloon_cents, "balloon_cents"), unclassifiedCents: unknownExpected, unknownExpectedCents: unknownExpected, unknownComponentKinds: Array.isArray(row.unknown_component_kinds) ? row.unknown_component_kinds.filter((value): value is string => typeof value === "string") : [], totalExpectedCents: expected, knownMinimumCents: knownMinimum, amountComplete, totalRecordedCents: centsFromBigInt(recorded), totalPostedCents: centsFromBigInt(posted), totalSettledCents: centsFromBigInt(settled), remainingDueCents: expected === null ? null : centsFromBigInt(centsToBigInt(expected) - recorded), status, recordRevision: dbRevision(row.record_revision), updatedAt: dbTimestamp(row, "updated_at") });
}

function mappedPayment(row: Record<string, unknown>, allocatedAmounts: InvestorPaymentAmounts, postedSource: unknown, postedSourceValidity: InvestorPostedSourceValidity | null, settlementSource: unknown): InvestorPayment {
  const storedStatus = dbString(row, "status");
  const status = storedStatus === "qbo_posted" && (postedSource === null || postedSourceValidity !== "current") ? "review_required" : storedStatus;
  return investorPaymentSchema.parse({ id: dbString(row, "id"), accountId: dbString(row, "account_id"), instrumentId: dbString(row, "instrument_id"), contractId: row.contract_id === null || row.contract_id === undefined ? null : dbString(row, "contract_id"), obligationId: row.obligation_id === null || row.obligation_id === undefined ? null : dbString(row, "obligation_id"), remittanceInstructionId: row.remittance_instruction_id === null || row.remittance_instruction_id === undefined ? null : dbString(row, "remittance_instruction_id"), organizationId: dbString(row, "organization_id"), legalEntityId: dbString(row, "legal_entity_id"), kind: dbString(row, "kind"), status, method: dbString(row, "method"), paymentOn: dbDate(row, "payment_on"), periodMonth: row.period_month === null || row.period_month === undefined ? null : dbDate(row, "period_month"), currency: dbString(row, "currency"), amountCents: dbCents(row.amount_cents, "amount_cents"), amounts: investorPaymentAmountsSchema.parse({ principalCents: dbCents(row.principal_cents, "principal_cents"), interestCents: dbCents(row.interest_cents, "interest_cents"), returnOfCapitalCents: dbCents(row.return_of_capital_cents, "return_of_capital_cents"), distributionCents: dbCents(row.distribution_cents, "distribution_cents"), feeCents: dbCents(row.fee_cents, "fee_cents"), balloonCents: dbCents(row.balloon_cents, "balloon_cents"), unclassifiedCents: dbCents(row.unclassified_cents ?? "0", "unclassified_cents") }), allocatedAmounts, unappliedCents: dbCents(row.unapplied_cents, "unapplied_cents"), postedSource, postedSourceValidity, settlementSource, reversesPaymentId: row.reverses_payment_id === null || row.reverses_payment_id === undefined ? null : dbString(row, "reverses_payment_id"), correctionReason: dbNullableString(row, "correction_reason"), recordRevision: dbRevision(row.record_revision), createdAt: dbTimestamp(row, "created_at") });
}

export interface InvestorReadServiceOptions { readonly executor: RentOpsQueryExecutor; readonly sourceRead?: FinancialSourceReadPort; }

export class InvestorReadService {
  constructor(protected readonly executor: RentOpsQueryExecutor, protected readonly options: Omit<InvestorReadServiceOptions, "executor"> = {}) {}

  async list(principal: AuthenticatedPrincipal, input: InvestorListQuery): Promise<InvestorListResponse> {
    const query = investorListQuerySchema.parse(input);
    assertReadScope(principal, query.scope);
    const cursor = decodeCursor(query.cursor);
    const legalEntityId = query.legalEntityId ?? query.scope.legalEntityId;
    const propertyId = query.propertyId ?? query.scope.propertyId;
    if (query.legalEntityId && query.scope.legalEntityId && query.legalEntityId !== query.scope.legalEntityId) throw new ForbiddenCommandError("Investor list entity scope conflicts with the requested company scope", { reason: "investor_entity_scope" });
    if (query.propertyId && query.scope.propertyId && query.propertyId !== query.scope.propertyId) throw new ForbiddenCommandError("Investor list property scope conflicts with the requested company scope", { reason: "investor_property_scope" });
    const readScope = companyScopeSchema.parse({ organizationId: query.scope.organizationId, legalEntityId, propertyId });
    assertReadScope(principal, readScope);
    const values: unknown[] = [readScope.organizationId, query.search ?? null, query.status ?? null, legalEntityId ?? null, propertyId ?? null, query.instrumentKind ?? null, cursor?.updatedAt ?? null, cursor?.id ?? null, query.limit + 1];
    const rows = await this.executor.query<Record<string, unknown>>(
      `SELECT a.id, a.organization_id, a.contact_id, a.display_name, a.status, a.notes, a.record_revision, a.updated_at, a.archived_at
         FROM company_investor_accounts a
       WHERE a.organization_id = $1
          AND (($3::text = 'archived' AND a.archived_at IS NOT NULL) OR (($3::text IS NULL OR $3::text = 'active') AND a.archived_at IS NULL))
          AND ($2::text IS NULL OR a.display_name ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR a.status = $3)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM company_investor_instruments i WHERE i.organization_id=a.organization_id AND i.account_id=a.id AND i.legal_entity_id=$4 AND i.archived_at IS NULL))
          AND ($5::varchar IS NULL OR EXISTS (SELECT 1 FROM company_investor_instrument_properties ip JOIN company_investor_instruments i ON i.organization_id=ip.organization_id AND i.id=ip.instrument_id WHERE ip.organization_id=a.organization_id AND i.account_id=a.id AND ip.property_id=$5 AND i.archived_at IS NULL))
          AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM company_investor_instruments i WHERE i.organization_id=a.organization_id AND i.account_id=a.id AND i.kind=$6 AND i.archived_at IS NULL))
          AND ($7::timestamptz IS NULL OR (a.updated_at, a.id) < ($7::timestamptz, $8::uuid))
        ORDER BY a.updated_at DESC, a.id DESC LIMIT $9`, values,
    );
    const pageRows = rows.rows.slice(0, query.limit);
    const rollups = await this.loadAccountRollups(readScope, pageRows.map(row => dbString(row, "id")));
    const items = pageRows.map(row => mappedAccount(row, rollups.get(dbString(row, "id")) ?? []));
    const next = rows.rows.length > query.limit ? pageRows[pageRows.length - 1] : undefined;
    return investorListResponseSchema.parse({ items, nextCursor: next ? encodeCursor({ updatedAt: dbTimestamp(next, "updated_at"), id: dbString(next, "id") }) : null });
  }

  async listContacts(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; search?: string }): Promise<InvestorContactListResponse> {
    const scope = companyScopeSchema.parse(input.scope);
    assertReadScope(principal, scope);
    const search = input.search?.trim() || null;
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT id, display_name, kind, rent_ops_person_id
         FROM company_contacts
        WHERE organization_id=$1 AND archived_at IS NULL
          AND ($2::text IS NULL OR display_name ILIKE '%' || $2 || '%')
        ORDER BY lower(display_name), id
        LIMIT 200`,
      [scope.organizationId, search],
    );
    return investorContactListResponseSchema.parse({ items: result.rows.map(row => investorContactOptionSchema.parse({ id: dbString(row, "id"), displayName: dbString(row, "display_name"), kind: dbString(row, "kind"), rentOpsPersonId: dbNullableString(row, "rent_ops_person_id") })) });
  }

  async listDocuments(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; propertyIds?: readonly string[]; search?: string }): Promise<InvestorDocumentListResponse> {
    const scope = companyScopeSchema.parse(input.scope);
    assertReadScope(principal, scope);
    if (!scope.legalEntityId) return { items: [] };
    if (scope.propertyId && input.propertyIds?.some(propertyId => propertyId !== scope.propertyId)) throw new ForbiddenCommandError("Investor document scope includes a property outside the requested grant", { reason: "investor_property_scope" });
    const propertyIds = scope.propertyId ? [scope.propertyId] : input.propertyIds?.length ? [...input.propertyIds] : null;
    const search = input.search?.trim() || null;
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT DISTINCT d.id, d.file_name, lower(d.file_name) AS file_name_sort, d.state, d.type, d.property_id
         FROM rent_ops_documents d
        WHERE d.state = 'verified'
          AND (
            (d.property_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM company_property_entity_periods pep
               WHERE pep.organization_id=$1 AND pep.legal_entity_id=$2 AND pep.property_id=d.property_id
                 AND pep.effective_from <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
                 AND (pep.effective_until IS NULL OR pep.effective_until > (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date)
            ))
            OR EXISTS (
              SELECT 1
                FROM company_investor_contract_documents cd
                JOIN company_investor_contracts c
                  ON c.organization_id=cd.organization_id AND c.id=cd.contract_id
                JOIN company_investor_instruments i
                  ON i.organization_id=c.organization_id AND i.id=c.instrument_id
               WHERE cd.organization_id=$1 AND cd.document_id=d.id
                 AND i.legal_entity_id=$2 AND c.archived_at IS NULL AND i.archived_at IS NULL
            )
          )
          AND ($3::varchar[] IS NULL OR d.property_id=ANY($3::varchar[]))
          AND ($4::text IS NULL OR d.file_name ILIKE '%' || $4 || '%')
        ORDER BY file_name_sort, d.id
        LIMIT 500`,
      [scope.organizationId, scope.legalEntityId, propertyIds, search],
    );
    return investorDocumentListResponseSchema.parse({ items: result.rows.map(row => investorDocumentOptionSchema.parse({ id: dbString(row, "id"), fileName: dbString(row, "file_name"), state: dbString(row, "state"), type: dbString(row, "type"), propertyId: row.property_id === null || row.property_id === undefined ? null : dbString(row, "property_id") })) });
  }

  async listFinancialSources(principal: AuthenticatedPrincipal, input: { scope: CompanyScope & { legalEntityId: string }; from?: string; through?: string; limit?: number; cursor?: string }): Promise<InvestorFinancialSourceResponse> {
    const scope = companyScopeSchema.parse(input.scope) as CompanyScope & { legalEntityId: string };
    assertReadScope(principal, scope);
    if (!this.options.sourceRead) return investorFinancialSourceResponseSchema.parse({ items: [], nextCursor: null });
    const limit = input.limit ?? 100;
    const cursor = decodeFinancialSourceCursor(input.cursor, input.from, input.through);
    const realms = await this.executor.query<Record<string, unknown>>(`SELECT DISTINCT provider_environment,provider_realm_id FROM company_investor_party_mappings WHERE organization_id=$1 AND legal_entity_id=$2 AND archived_at IS NULL`, [scope.organizationId, scope.legalEntityId]);
    if (!realms.rows.length) return investorFinancialSourceResponseSchema.parse({ items: [], nextCursor: null });
    const pageLimit = Math.max(1, Math.floor(limit / realms.rows.length));
    const pages = await Promise.all(realms.rows.map(row => {
      const environment = dbString(row, "provider_environment") as "production" | "sandbox";
      const realmId = dbString(row, "provider_realm_id");
      const key = `${environment}:${realmId}`;
      return this.options.sourceRead!.listTransactions({ scope: { provider: "qbo", organizationId: scope.organizationId, legalEntityId: scope.legalEntityId, environment, realmId }, from: input.from, through: input.through, limit: pageLimit, cursor: cursor?.realms[key] ?? undefined }).then(page => ({ key, page }));
    }));
    const nextRealms: Record<string, string | null> = {};
    for (const item of pages) nextRealms[item.key] = item.page.nextCursor;
    const items = pages.flatMap(item => item.page.items).filter(item => item.source.organizationId === scope.organizationId && item.source.legalEntityId === scope.legalEntityId && item.postingState === "posted");
    const nextCursor = Object.values(nextRealms).some(Boolean)
      ? encodeFinancialSourceCursor({ from: input.from ?? null, through: input.through ?? null, realms: nextRealms })
      : null;
    return investorFinancialSourceResponseSchema.parse({ items, nextCursor });
  }

  async get(principal: AuthenticatedPrincipal, input: { scope: CompanyScope; accountId: string }): Promise<InvestorDetail> {
    const scope = companyScopeSchema.parse(input.scope);
    assertReadScope(principal, scope);
    const accountResult = await this.executor.query<Record<string, unknown>>(`SELECT id, organization_id, contact_id, display_name, status, notes, record_revision, updated_at, archived_at FROM company_investor_accounts WHERE organization_id=$1 AND id=$2`, [scope.organizationId, input.accountId]);
    const accountRow = accountResult.rows[0];
    if (!accountRow) throw new ValidationCommandError("Investor account was not found in the requested company scope", { reason: "investor_account_not_found" });
    const account = mappedAccount(accountRow, (await this.loadAccountRollups(scope, [input.accountId])).get(input.accountId) ?? []);
    const instruments = await this.loadInstruments(scope, input.accountId);
    const instrumentIds = instruments.map(item => String(item.id));
    const contracts = await this.loadContracts(scope.organizationId, instrumentIds);
    const contractIds = contracts.map(item => String(item.id));
    const versions = await this.loadContractVersions(scope.organizationId, contractIds);
    const debts = await this.loadDebts(scope.organizationId, instrumentIds);
    const partyMappings = await this.loadPartyMappings(scope, input.accountId);
    const remittanceInstructions = await this.loadRemittanceInstructions(scope, input.accountId, instrumentIds);
    if ((scope.legalEntityId || scope.propertyId) && instruments.length === 0) throw new ValidationCommandError("Investor account has no records in the requested scope", { reason: "investor_scope_excluded" });
    const obligations = await this.loadObligations(scope, input.accountId, instrumentIds);
    const payments = await this.loadPayments(scope, { accountId: input.accountId, instrumentIds });
    const activity = payments.map(payment => investorActivitySchema.parse({ id: payment.id, accountId: payment.accountId, instrumentId: payment.instrumentId, paymentId: payment.id, contractId: payment.contractId, organizationId: payment.organizationId, occurredOn: payment.paymentOn, kind: payment.kind, status: payment.status, amountCents: payment.amountCents, currency: payment.currency, description: payment.correctionReason ?? `${payment.kind.replaceAll("_", " ")} payment` }));
    return investorDetailSchema.parse({ ...account, instruments, contracts, contractVersions: versions, debt: debts, partyMappings, remittanceInstructions, obligations, payments, activity });
  }

  async monthlyPayments(principal: AuthenticatedPrincipal, input: InvestorPaymentLogQuery): Promise<InvestorMonthlyPaymentResponse> {
    const query = investorPaymentLogQuerySchema.parse(input);
    assertReadScope(principal, query.scope);
    const cursor = decodeMonthlyPaymentCursor(query.cursor);
    const obligations = await this.loadObligations(query.scope, query.accountId, query.instrumentId ? [query.instrumentId] : undefined, query.fromMonth, query.throughMonth, query.limit + 1, cursor);
    const payments = await this.loadPayments(query.scope, { accountId: query.accountId, instrumentId: query.instrumentId, fromMonth: query.fromMonth, throughMonth: query.throughMonth });
    const grouped = new Map<string, InvestorPayment[]>();
    for (const payment of payments) if (payment.obligationId) grouped.set(String(payment.obligationId), [...(grouped.get(String(payment.obligationId)) ?? []), payment]);
    const hasMore = obligations.length > query.limit;
    const pageObligations = obligations.slice(0, query.limit);
    const rows = pageObligations.map(obligation => investorMonthlyPaymentRowSchema.parse({ obligation, payments: grouped.get(String(obligation.id)) ?? [] }));
    const filtered = query.status ? rows.filter(row => row.obligation.status === query.status) : rows;
    const last = pageObligations.at(-1);
    // A payment linked to an obligation belongs to that obligation's paged row,
    // even when a later page has not been loaded yet. Only truly standalone
    // activity is returned in this separate list, so pagination cannot
    // duplicate an obligation payment as "unscheduled".
    const unscheduledPayments = cursor === null ? payments.filter(payment => payment.obligationId === null) : [];
    return investorMonthlyPaymentResponseSchema.parse({
      items: filtered,
      nextCursor: hasMore && last ? encodeMonthlyPaymentCursor(last) : null,
      unscheduledPayments,
    });
  }

  /**
   * One instrument's scheduled debt service and monthly balance rollforward.
   * The derived outstanding balance is compared with the manual balance and a
   * difference is flagged; nothing overwrites the manual value.
   */
  async instrumentFinancials(principal: AuthenticatedPrincipal, input: InvestorInstrumentFinancialsQuery): Promise<InvestorInstrumentFinancials> {
    const query = investorInstrumentFinancialsQuerySchema.parse(input);
    const scope = companyScopeSchema.parse(query.scope);
    assertReadScope(principal, scope);
    const asOf = query.asOf ?? resolveEffectiveDate(undefined);
    const owner = await this.executor.query<Record<string, unknown>>(`SELECT account_id FROM company_investor_instruments WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`, [scope.organizationId, query.instrumentId]);
    const accountId = owner.rows[0] ? dbString(owner.rows[0], "account_id") : null;
    const instrument = accountId ? (await this.loadInstruments(scope, accountId)).find(item => String(item.id) === query.instrumentId) : undefined;
    if (!instrument) throw new ValidationCommandError("Investor instrument was not found in the requested company scope", { reason: "investor_instrument_not_found" });
    const [debt] = await this.loadDebts(scope.organizationId, [query.instrumentId]);
    const guaranteed = await this.guaranteedReturn(scope.organizationId, [query.instrumentId]);
    const payments = await this.loadPayments(scope, { instrumentId: query.instrumentId });
    const obligations = await this.loadObligations(scope, undefined, [query.instrumentId]);
    const range = rollforwardRange(instrument.effectiveFrom, asOf, query.fromMonth, query.throughMonth);
    const rollforward = buildInstrumentRollforward(rollforwardInput(instrument, debt ?? null, payments, obligations, guaranteed.get(query.instrumentId) ?? null, asOf, range));
    return investorInstrumentFinancialsSchema.parse({
      instrumentId: instrument.id, accountId: instrument.accountId, name: instrument.name, kind: instrument.kind, currency: instrument.currency,
      effectiveFrom: instrument.effectiveFrom, maturityOn: debt?.maturityOn ?? instrument.maturityOn, fromMonth: range.fromMonth, throughMonth: range.throughMonth,
      debt: debt ?? null, amortization: debt ? amortizationFor(instrument, debt) : null, rollforward,
    });
  }

  /** Scheduled, partial, recorded, posted, settled and reversed obligations with the remaining amount. */
  async paymentCalendar(principal: AuthenticatedPrincipal, input: InvestorPaymentCalendarQuery): Promise<InvestorPaymentCalendarResponse> {
    const query = investorPaymentCalendarQuerySchema.parse(input);
    const scope = companyScopeSchema.parse(query.scope);
    assertReadScope(principal, scope);
    const asOf = query.asOf ?? resolveEffectiveDate(undefined);
    const cursor = decodeMonthlyPaymentCursor(query.cursor);
    const obligations = await this.loadObligations(scope, query.accountId, undefined, query.fromMonth, query.throughMonth, query.limit + 1, cursor);
    const page = obligations.slice(0, query.limit);
    const names = await this.instrumentNames(scope.organizationId, Array.from(new Set(page.map(item => String(item.instrumentId)))));
    const items = page.map(obligation => {
      const name = names.get(String(obligation.instrumentId));
      return investorPaymentCalendarItemSchema.parse({
        obligationId: obligation.id, accountId: obligation.accountId, accountName: name?.accountName ?? "Investor", instrumentId: obligation.instrumentId,
        instrumentName: name?.instrumentName ?? "Instrument", periodMonth: obligation.periodMonth, dueOn: obligation.dueOn, currency: obligation.currency,
        expectedCents: obligation.totalExpectedCents, knownMinimumCents: obligation.knownMinimumCents, recordedCents: obligation.totalRecordedCents,
        postedCents: obligation.totalPostedCents, settledCents: obligation.totalSettledCents, remainingCents: obligation.remainingDueCents,
        status: obligation.status, state: investorCalendarState(obligation, asOf),
      });
    });
    const last = page.at(-1);
    // The state filter applies within the bounded page so paging stays stable.
    return investorPaymentCalendarResponseSchema.parse({
      asOf, items: query.state ? items.filter(item => item.state === query.state) : items,
      nextCursor: obligations.length > query.limit && last ? encodeMonthlyPaymentCursor(last) : null,
    });
  }

  /** Debt instruments ordered by maturity with balloons and derived vs manual outstanding. */
  async debtMaturities(principal: AuthenticatedPrincipal, input: InvestorDebtMaturityQuery): Promise<InvestorDebtMaturityResponse> {
    const query = investorDebtMaturityQuerySchema.parse(input);
    const scope = companyScopeSchema.parse(query.scope);
    assertReadScope(principal, scope);
    const asOf = query.asOf ?? resolveEffectiveDate(undefined);
    const instruments = (await this.loadInstruments(scope)).filter(item => item.kind === "private_loan" || item.kind === "member_loan").slice(0, 1_000);
    const ids = instruments.map(item => String(item.id));
    const debts = new Map((await this.loadDebts(scope.organizationId, ids)).map(item => [String(item.instrumentId), item] as const));
    const guaranteed = await this.guaranteedReturn(scope.organizationId, ids);
    const payments = ids.length ? await this.loadPayments(scope, { instrumentIds: ids }) : [];
    const obligations = ids.length ? await this.loadObligations(scope, undefined, ids) : [];
    const names = await this.instrumentNames(scope.organizationId, ids);
    const items = instruments.map(instrument => {
      const id = String(instrument.id);
      const debt = debts.get(id) ?? null;
      const range = rollforwardRange(instrument.effectiveFrom, asOf);
      const rollforward = buildInstrumentRollforward(rollforwardInput(instrument, debt, payments.filter(item => String(item.instrumentId) === id), obligations.filter(item => String(item.instrumentId) === id), guaranteed.get(id) ?? null, asOf, range));
      const maturityOn = debt?.maturityOn ?? instrument.maturityOn;
      const amortization = debt ? amortizationFor(instrument, debt) : null;
      const balloonSource = debt?.balloonCents !== null && debt?.balloonCents !== undefined ? "documented" : amortization?.computedBalloonCents ? "computed" : "none";
      return investorDebtMaturitySchema.parse({
        instrumentId: instrument.id, accountId: instrument.accountId, accountName: names.get(id)?.accountName ?? "Investor", instrumentName: instrument.name, kind: instrument.kind,
        legalEntityId: instrument.legalEntityId, currency: instrument.currency, maturityOn, monthsToMaturity: maturityOn ? monthsBetween(monthOf(asOf), monthOf(maturityOn)) : null,
        annualRate: debt?.annualRate ?? null,
        balloonCents: balloonSource === "documented" ? debt!.balloonCents : balloonSource === "computed" ? amortization!.computedBalloonCents : null, balloonSource,
        derivedOutstandingCents: rollforward.derivedOutstandingCents, manualOutstandingCents: rollforward.manualOutstandingCents, reconciliation: rollforward.reconciliation,
      });
    });
    items.sort((left, right) => (left.maturityOn ?? "9999-12-31").localeCompare(right.maturityOn ?? "9999-12-31") || String(left.instrumentId).localeCompare(String(right.instrumentId)));
    return investorDebtMaturityResponseSchema.parse({ asOf, items });
  }

  private async instrumentNames(organizationId: string, instrumentIds: readonly string[]): Promise<Map<string, { instrumentName: string; accountName: string }>> {
    if (!instrumentIds.length) return new Map();
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT i.id, i.name, a.display_name FROM company_investor_instruments i JOIN company_investor_accounts a ON a.organization_id=i.organization_id AND a.id=i.account_id WHERE i.organization_id=$1 AND i.id=ANY($2::uuid[])`,
      [organizationId, instrumentIds],
    );
    return new Map(result.rows.map(row => [dbString(row, "id"), { instrumentName: dbString(row, "name"), accountName: dbString(row, "display_name") }] as const));
  }

  /** Fixed contractual profit from the active version of an active contract, when documented. */
  private async guaranteedReturn(organizationId: string, instrumentIds: readonly string[]): Promise<Map<string, string>> {
    if (!instrumentIds.length) return new Map();
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT c.instrument_id, SUM(v.fixed_profit_cents)::text AS fixed_profit_cents
         FROM company_investor_contracts c
         JOIN company_investor_contract_versions v ON v.organization_id=c.organization_id AND v.contract_id=c.id AND v.id=c.current_version_id
        WHERE c.organization_id=$1 AND c.instrument_id=ANY($2::uuid[]) AND c.status='active' AND c.archived_at IS NULL AND v.status='active' AND v.fixed_profit_cents IS NOT NULL
        GROUP BY c.instrument_id`,
      [organizationId, instrumentIds],
    );
    return new Map(result.rows.map(row => [dbString(row, "instrument_id"), dbCents(row.fixed_profit_cents, "fixed_profit_cents")] as const));
  }

  private async loadAccountRollups(scope: CompanyScope, accountIds: readonly string[]): Promise<Map<string, InvestorAccountRollup[]>> {
    if (accountIds.length === 0) return new Map();
    const paymentRows = await Promise.all(accountIds.map(async accountId => [accountId, await this.loadPayments(scope, { accountId })] as const));
    const paymentsByAccount = new Map(paymentRows);
    const result = await this.executor.query<Record<string, unknown>>(
      `WITH currencies AS (SELECT DISTINCT account_id, currency FROM company_investor_instruments i WHERE organization_id=$1 AND account_id = ANY($2::uuid[]) AND archived_at IS NULL AND ($3::uuid IS NULL OR legal_entity_id=$3) AND ($4::varchar IS NULL OR EXISTS (SELECT 1 FROM company_investor_instrument_properties ip WHERE ip.organization_id=i.organization_id AND ip.instrument_id=i.id AND ip.property_id=$4)) )
       SELECT c.account_id, c.currency,
              COALESCE((SELECT SUM(i.committed_cents) FROM company_investor_instruments i WHERE i.organization_id=$1 AND i.account_id=c.account_id AND i.currency=c.currency AND i.archived_at IS NULL AND ($3::uuid IS NULL OR i.legal_entity_id=$3) AND ($4::varchar IS NULL OR EXISTS (SELECT 1 FROM company_investor_instrument_properties ip WHERE ip.organization_id=i.organization_id AND ip.instrument_id=i.id AND ip.property_id=$4))),0)::text AS committed_cents
         FROM currencies c
       ORDER BY c.account_id, c.currency`, [scope.organizationId, accountIds, scope.legalEntityId ?? null, scope.propertyId ?? null]);
    const obligationRows = await this.executor.query<Record<string, unknown>>(
      `SELECT o.id, o.account_id, o.instrument_id, o.contract_id, o.contract_version_id, o.organization_id, o.legal_entity_id, o.period_month, o.due_on, o.currency, o.principal_cents, o.interest_cents, o.return_of_capital_cents, o.distribution_cents, o.fee_cents, o.balloon_cents, o.unknown_expected_cents, o.unknown_component_kinds, o.total_expected_cents, o.known_minimum_cents, o.amount_complete, o.record_revision, o.updated_at
         FROM company_investor_obligations o
        WHERE o.organization_id=$1 AND o.account_id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR o.legal_entity_id=$3)
          AND ($4::varchar IS NULL OR EXISTS (SELECT 1 FROM company_investor_instrument_properties ip WHERE ip.organization_id=o.organization_id AND ip.instrument_id=o.instrument_id AND ip.property_id=$4))
        ORDER BY o.account_id, o.currency, o.due_on, o.id`, [scope.organizationId, accountIds, scope.legalEntityId ?? null, scope.propertyId ?? null]);
    const obligationsByAccountCurrency = new Map<string, InvestorObligation[]>();
    for (const row of obligationRows.rows) {
      const accountId = dbString(row, "account_id");
      const payments = paymentsByAccount.get(accountId) ?? [];
      const obligation = mappedObligation(row, payments.filter(payment => String(payment.obligationId) === dbString(row, "id")));
      const key = `${accountId}:${obligation.currency}`;
      obligationsByAccountCurrency.set(key, [...(obligationsByAccountCurrency.get(key) ?? []), obligation]);
    }
    const map = new Map<string, InvestorAccountRollup[]>();
    for (const row of result.rows) {
      const accountId = dbString(row, "account_id");
      const currency = dbString(row, "currency");
      const payments = paymentsByAccount.get(accountId) ?? [];
      const paymentById = new Map(payments.map(payment => [String(payment.id), payment]));
      const evidenceStatus = (payment: InvestorPayment): InvestorPayment["status"] => {
        if ((payment.status === "qbo_posted" || payment.status === "review_required") && (payment.postedSource === null || payment.postedSourceValidity !== "current")) return "manual_recorded";
        if (payment.status === "bank_settled" && payment.settlementSource === null) return "manual_recorded";
        if (payment.status !== "reversed" || payment.reversesPaymentId === null) return payment.status;
        return evidenceStatus(paymentById.get(String(payment.reversesPaymentId)) ?? payment);
      };
      const verifiedAmount = (kind: "contribution" | "return_of_capital"): bigint => payments.reduce((total, payment) => {
        const original = payment.reversesPaymentId === null ? null : paymentById.get(String(payment.reversesPaymentId));
        const isTarget = payment.kind === kind || (payment.kind === "correction" && original?.kind === kind);
        return isTarget && payment.currency === currency && (evidenceStatus(payment) === "qbo_posted" || evidenceStatus(payment) === "bank_settled")
          ? total + centsToBigInt(payment.amountCents)
          : total;
      }, BigInt(0));
      const candidates = (obligationsByAccountCurrency.get(`${accountId}:${currency}`) ?? []).filter(obligation => {
        if (["bank_settled", "qbo_posted", "manually_recorded", "overpaid", "reversed"].includes(obligation.status)) return false;
        if (!obligation.amountComplete || obligation.totalExpectedCents === null) return true;
        return centsToBigInt(obligation.remainingDueCents ?? "0") > BigInt(0);
      });
      const nextObligation = candidates[0];
      const nextObligationCents = nextObligation?.amountComplete && nextObligation.totalExpectedCents !== null
        ? centsFromBigInt(centsToBigInt(nextObligation.remainingDueCents ?? "0") > BigInt(0) ? centsToBigInt(nextObligation.remainingDueCents ?? "0") : BigInt(0))
        : null;
      const committed = dbCents(row.committed_cents, "committed_cents"); const funded = centsFromBigInt(verifiedAmount("contribution")); const returned = centsFromBigInt(verifiedAmount("return_of_capital"));
      const value = { currency, committedCents: committed, fundedCents: funded, returnedCents: returned, remainingContributedCents: centsFromBigInt(centsToBigInt(funded) - centsToBigInt(returned)), nextObligationCents, nextObligationOn: nextObligation?.dueOn ?? null };
      const parsed = investorAccountRollupSchema.parse(value);
      map.set(dbString(row, "account_id"), [...(map.get(dbString(row, "account_id")) ?? []), parsed]);
    }
    return map;
  }

  private async loadInstruments(scope: CompanyScope, accountId?: string): Promise<InvestorInstrument[]> {
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT i.id, i.account_id, i.organization_id, i.name, i.kind, i.status, i.currency, i.committed_cents, i.face_principal_cents, i.effective_from, i.maturity_on, i.ownership_bps, i.legal_entity_id, i.notes, i.record_revision, i.updated_at, i.archived_at,
              COALESCE((SELECT array_agg(ip.property_id ORDER BY ip.property_id) FROM company_investor_instrument_properties ip WHERE ip.organization_id=i.organization_id AND ip.instrument_id=i.id), ARRAY[]::varchar[]) AS property_ids,
              COALESCE((SELECT array_agg(ip.project_id ORDER BY ip.project_id) FROM company_investor_instrument_projects ip WHERE ip.organization_id=i.organization_id AND ip.instrument_id=i.id), ARRAY[]::varchar[]) AS project_ids
         FROM company_investor_instruments i
        WHERE i.organization_id=$1 AND ($2::uuid IS NULL OR i.account_id=$2) AND ($3::uuid IS NULL OR i.legal_entity_id=$3) AND ($4::varchar IS NULL OR EXISTS (SELECT 1 FROM company_investor_instrument_properties ip WHERE ip.organization_id=i.organization_id AND ip.instrument_id=i.id AND ip.property_id=$4)) AND i.archived_at IS NULL
        ORDER BY i.updated_at DESC, i.id DESC`, [scope.organizationId, accountId ?? null, scope.legalEntityId ?? null, scope.propertyId ?? null]);
    return result.rows.map(mappedInstrument);
  }

  private async loadContracts(organizationId: string, instrumentIds: readonly string[]): Promise<InvestorContract[]> {
    if (!instrumentIds.length) return [];
    const result = await this.executor.query<Record<string, unknown>>(`SELECT id, instrument_id, organization_id, title, kind, status, current_version_id, record_revision, updated_at, archived_at FROM company_investor_contracts WHERE organization_id=$1 AND instrument_id=ANY($2::uuid[]) ORDER BY updated_at DESC, id DESC`, [organizationId, instrumentIds]);
    return result.rows.map(mappedContract);
  }

  private async loadContractVersions(organizationId: string, contractIds: readonly string[]): Promise<InvestorContractVersion[]> {
    if (!contractIds.length) return [];
    const result = await this.executor.query<Record<string, unknown>>(`SELECT id, contract_id, version_no, status, effective_from, effective_to, signed_on, schedule, payment_day, month_end_rule, annual_rate, preferred_return_rate, return_multiple, fixed_payment_cents, principal_payment_cents, interest_payment_cents, return_of_capital_cents, distribution_cents, balloon_cents, original_principal_cents, maturity_total_cents, fixed_profit_cents, maturity_payoff_cents, third_party_installment_cents, investor_spread_cents, unknown_component_kinds, interest_only, day_count, created_by, approved_by, created_at FROM company_investor_contract_versions WHERE organization_id=$1 AND contract_id=ANY($2::uuid[]) ORDER BY contract_id, version_no`, [organizationId, contractIds]);
    const docs = await this.executor.query<{ contract_version_id: string; document_id: string }>(`SELECT contract_version_id, document_id FROM company_investor_contract_documents WHERE organization_id=$1 AND contract_id=ANY($2::uuid[]) ORDER BY contract_version_id, document_id`, [organizationId, contractIds]);
    const byVersion = new Map<string, string[]>(); for (const row of docs.rows) byVersion.set(row.contract_version_id, [...(byVersion.get(row.contract_version_id) ?? []), row.document_id]);
    return result.rows.map(row => mappedContractVersion(row, byVersion.get(dbString(row, "id")) ?? []));
  }

  private async loadDebts(organizationId: string, instrumentIds: readonly string[]): Promise<InvestorDebt[]> {
    if (!instrumentIds.length) return [];
    const result = await this.executor.query<Record<string, unknown>>(`SELECT id, instrument_id, account_id, organization_id, legal_entity_id, debt_kind, currency, original_principal_cents, funded_capital_cents, outstanding_principal_cents, annual_rate, schedule, payment_day, month_end_rule, first_due_month, interest_only_until, maturity_on, amortization_months, balloon_cents, day_count, record_revision, updated_at, archived_at FROM company_investor_debt WHERE organization_id=$1 AND instrument_id=ANY($2::uuid[]) AND archived_at IS NULL ORDER BY updated_at DESC, id DESC`, [organizationId, instrumentIds]);
    return result.rows.map(mappedDebt);
  }

  private async loadPartyMappings(scope: CompanyScope, accountId: string): Promise<InvestorPartyMapping[]> {
    const result = await this.executor.query<Record<string, unknown>>(`SELECT id,account_id,organization_id,legal_entity_id,contact_id,party_kind,display_name,provider,provider_environment,provider_realm_id,provider_object_type,provider_object_id,source_document_id,effective_from,effective_to,status,record_revision,updated_at,archived_at FROM company_investor_party_mappings WHERE organization_id=$1 AND account_id=$2 AND ($3::uuid IS NULL OR legal_entity_id=$3) AND archived_at IS NULL ORDER BY effective_from DESC,id DESC`, [scope.organizationId, accountId, scope.legalEntityId ?? null]);
    return result.rows.map(mappedPartyMapping);
  }

  private async loadRemittanceInstructions(scope: CompanyScope, accountId: string, instrumentIds: readonly string[]): Promise<InvestorRemittanceInstruction[]> {
    if (!instrumentIds.length) return [];
    const result = await this.executor.query<Record<string, unknown>>(`SELECT id,account_id,instrument_id,contract_id,organization_id,legal_entity_id,party_mapping_id,beneficiary_kind,source_document_id,effective_from,effective_to,status,notes,record_revision,updated_at,archived_at FROM company_investor_remittance_instructions WHERE organization_id=$1 AND account_id=$2 AND instrument_id=ANY($3::uuid[]) AND ($4::uuid IS NULL OR legal_entity_id=$4) AND archived_at IS NULL ORDER BY effective_from DESC,id DESC`, [scope.organizationId, accountId, instrumentIds, scope.legalEntityId ?? null]);
    return result.rows.map(mappedRemittance);
  }

  private async loadObligations(scope: CompanyScope, accountId?: string, instrumentIds?: readonly string[], fromMonth?: string, throughMonth?: string, limit = 10000, cursor?: MonthlyPaymentCursor | null): Promise<InvestorObligation[]> {
    const result = await this.executor.query<Record<string, unknown>>(`SELECT o.id, o.account_id, o.instrument_id, o.contract_id, o.contract_version_id, o.organization_id, o.legal_entity_id, o.period_month, o.due_on, o.currency, o.principal_cents, o.interest_cents, o.return_of_capital_cents, o.distribution_cents, o.fee_cents, o.balloon_cents, o.unknown_expected_cents, o.unknown_component_kinds, o.total_expected_cents, o.known_minimum_cents, o.amount_complete, o.record_revision, o.updated_at FROM company_investor_obligations o WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.account_id=$2) AND ($3::uuid[] IS NULL OR o.instrument_id=ANY($3::uuid[])) AND ($4::date IS NULL OR o.period_month >= $4) AND ($5::date IS NULL OR o.period_month <= $5) AND ($6::uuid IS NULL OR o.legal_entity_id=$6) AND ($7::varchar IS NULL OR EXISTS (SELECT 1 FROM company_investor_instrument_properties ip WHERE ip.organization_id=o.organization_id AND ip.instrument_id=o.instrument_id AND ip.property_id=$7)) AND ($8::date IS NULL OR (o.period_month,o.due_on,o.id) > ($8::date,$9::date,$10::uuid)) ORDER BY o.period_month, o.due_on, o.id LIMIT $11`, [scope.organizationId, accountId ?? null, instrumentIds ?? null, fromMonth ?? null, throughMonth ?? null, scope.legalEntityId ?? null, scope.propertyId ?? null, cursor?.periodMonth ?? null, cursor?.dueOn ?? null, cursor?.id ?? null, limit]);
    const payments = await this.loadPayments(scope, { accountId, instrumentIds, obligationIds: result.rows.map(row => dbString(row, "id")) });
    const grouped = new Map<string, InvestorPayment[]>(); for (const payment of payments) if (payment.obligationId) grouped.set(String(payment.obligationId), [...(grouped.get(String(payment.obligationId)) ?? []), payment]);
    return result.rows.map(row => mappedObligation(row, grouped.get(dbString(row, "id")) ?? []));
  }

  private async refreshQboSource(source: InvestorPayment["postedSource"]): Promise<{ source: InvestorPayment["postedSource"]; validity: InvestorPostedSourceValidity | null }> {
    if (source === null || source.provider !== "qbo") return { source, validity: null };
    // A stored attestation is not a permanent proof. Without the current
    // accounting read port, keep the record visible but remove it from
    // verified posted totals until the source can be re-read.
    if (!this.options.sourceRead) return { source, validity: "unavailable" };
    const reference = source.reference;
    let resolution: FinancialSourceLineResolution | null;
    try {
      resolution = await this.options.sourceRead.resolveLine({
        scope: { provider: "qbo", organizationId: reference.organizationId, legalEntityId: reference.legalEntityId, environment: reference.environment, realmId: reference.realmId },
        objectType: reference.objectType, objectId: reference.objectId, lineId: reference.lineId ?? undefined,
      });
    } catch {
      return { source, validity: "unavailable" };
    }
    if (!resolution) return { source, validity: "stale" };
    if (!sameFinancialSourceReference(resolution.source, reference)) return { source, validity: "stale" };
    if (resolution.postingState === "voided" || resolution.settlement.state === "voided") return { source, validity: "voided" };
    if (resolution.postingState !== "posted" || resolution.currency !== source.currency || centsToBigInt(resolution.amountCents) < centsToBigInt(source.amountCents)) return { source, validity: "stale" };
    // Keep the append-only attestation exactly as stored. The validity flag is
    // the fresh readback; it must not rewrite historical amount or watermark
    // evidence in the read model.
    return { source, validity: "current" };
  }

  private async loadPayments(scope: CompanyScope, filter: { accountId?: string; instrumentId?: string; instrumentIds?: readonly string[]; obligationIds?: readonly string[]; fromMonth?: string; throughMonth?: string }): Promise<InvestorPayment[]> {
    const result = await this.executor.query<Record<string, unknown>>(`SELECT p.id, p.account_id, p.instrument_id, p.contract_id, p.obligation_id, p.remittance_instruction_id, p.organization_id, p.legal_entity_id, p.kind, p.status, p.method, p.payment_on, p.period_month, p.currency, p.principal_cents, p.interest_cents, p.return_of_capital_cents, p.distribution_cents, p.fee_cents, p.balloon_cents, p.unclassified_cents, p.amount_cents, p.unapplied_cents, p.reverses_payment_id, p.correction_reason, p.record_revision, p.created_at FROM company_investor_payments p WHERE p.organization_id=$1 AND ($2::uuid IS NULL OR p.account_id=$2) AND ($3::uuid IS NULL OR p.instrument_id=$3) AND ($4::uuid[] IS NULL OR p.instrument_id=ANY($4::uuid[])) AND ($5::uuid[] IS NULL OR p.obligation_id=ANY($5::uuid[])) AND ($6::uuid IS NULL OR p.legal_entity_id=$6) AND ($7::varchar IS NULL OR EXISTS (SELECT 1 FROM company_investor_instrument_properties ip WHERE ip.organization_id=p.organization_id AND ip.instrument_id=p.instrument_id AND ip.property_id=$7)) AND ($8::date IS NULL OR p.payment_on >= $8) AND ($9::date IS NULL OR p.payment_on < ($9::date + INTERVAL '1 month')) ORDER BY p.payment_on, p.created_at, p.id`, [scope.organizationId, filter.accountId ?? null, filter.instrumentId ?? null, filter.instrumentIds ?? null, filter.obligationIds ?? null, scope.legalEntityId ?? null, scope.propertyId ?? null, filter.fromMonth ?? null, filter.throughMonth ?? null]);
    const ids = result.rows.map(row => dbString(row, "id"));
    if (!ids.length) return [];
    const allocationRows = await this.executor.query<Record<string, unknown>>(`SELECT a.payment_id, a.principal_cents, a.interest_cents, a.return_of_capital_cents, a.distribution_cents, a.fee_cents, a.balloon_cents, a.unclassified_cents FROM company_investor_payment_allocations a WHERE a.organization_id=$1 AND a.payment_id=ANY($2::uuid[])`, [scope.organizationId, ids]);
    const allocated = new Map<string, InvestorPaymentAmounts>(); for (const row of allocationRows.rows) { const value = { principalCents: dbCents(row.principal_cents, "allocated_principal_cents"), interestCents: dbCents(row.interest_cents, "allocated_interest_cents"), returnOfCapitalCents: dbCents(row.return_of_capital_cents, "allocated_return_of_capital_cents"), distributionCents: dbCents(row.distribution_cents, "allocated_distribution_cents"), feeCents: dbCents(row.fee_cents, "allocated_fee_cents"), balloonCents: dbCents(row.balloon_cents, "allocated_balloon_cents"), unclassifiedCents: dbCents(row.unclassified_cents ?? "0", "allocated_unclassified_cents") }; allocated.set(row.payment_id as string, addPaymentAmounts(allocated.get(row.payment_id as string) ?? { principalCents: centsFromBigInt(BigInt(0)), interestCents: centsFromBigInt(BigInt(0)), returnOfCapitalCents: centsFromBigInt(BigInt(0)), distributionCents: centsFromBigInt(BigInt(0)), feeCents: centsFromBigInt(BigInt(0)), balloonCents: centsFromBigInt(BigInt(0)), unclassifiedCents: centsFromBigInt(BigInt(0)) }, value)); }
    const sourceRows = await this.executor.query<Record<string, unknown>>(`SELECT payment_id, provider, source_reference FROM company_investor_payment_sources WHERE organization_id=$1 AND payment_id=ANY($2::uuid[])`, [scope.organizationId, ids]);
    const sources = new Map<string, { postedSource: unknown; postedSourceValidity: InvestorPostedSourceValidity | null; settlementSource: unknown }>();
    for (const row of sourceRows.rows) {
      const paymentId = dbString(row, "payment_id");
      const current = sources.get(paymentId) ?? { postedSource: null, postedSourceValidity: null, settlementSource: null };
      const source = investorFinancialSourceFromJson(row.source_reference);
      if (row.provider === "qbo") {
        const refreshed = await this.refreshQboSource(source as InvestorPayment["postedSource"]);
        current.postedSource = refreshed.source;
        current.postedSourceValidity = refreshed.validity;
      }
      else current.settlementSource = source;
      sources.set(paymentId, current);
    }
    return result.rows.map(row => mappedPayment(row, allocated.get(dbString(row, "id")) ?? {
      principalCents: centsFromBigInt(BigInt(0)), interestCents: centsFromBigInt(BigInt(0)), returnOfCapitalCents: centsFromBigInt(BigInt(0)),
      distributionCents: centsFromBigInt(BigInt(0)), feeCents: centsFromBigInt(BigInt(0)), balloonCents: centsFromBigInt(BigInt(0)), unclassifiedCents: centsFromBigInt(BigInt(0)),
    }, sources.get(dbString(row, "id"))?.postedSource ?? null, sources.get(dbString(row, "id"))?.postedSourceValidity ?? null, sources.get(dbString(row, "id"))?.settlementSource ?? null));
  }
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!);
}

/** Rollforward months from the instrument's first month through the as-of month, bounded to 480 months. */
function rollforwardRange(effectiveFrom: string, asOf: string, fromMonth?: string, throughMonth?: string): { fromMonth: string; throughMonth: string } {
  const start = monthOf(effectiveFrom);
  let through = throughMonth ?? monthOf(asOf);
  if (through < start && !fromMonth) through = start;
  let from = fromMonth ?? start;
  if (through < from) through = from;
  if (monthsBetween(from, through) > 479) from = addMonths(through, -479);
  return { fromMonth: from, throughMonth: through };
}

/** A posted payment whose QBO source is no longer current is treated as manually recorded evidence. */
function evidenceStatus(payment: InvestorPayment): InvestorPayment["status"] {
  if ((payment.status === "qbo_posted" || payment.status === "review_required") && (payment.postedSource === null || payment.postedSourceValidity !== "current")) return "manual_recorded";
  if (payment.status === "bank_settled" && payment.settlementSource === null) return "manual_recorded";
  return payment.status;
}

function rollforwardInput(instrument: InvestorInstrument, debt: InvestorDebt | null, payments: readonly InvestorPayment[], obligations: readonly InvestorObligation[], guaranteedReturnCents: string | null, asOf: string, range: { fromMonth: string; throughMonth: string }): InstrumentRollforwardInput {
  return {
    instrumentKind: instrument.kind, currency: instrument.currency, effectiveFrom: instrument.effectiveFrom, maturityOn: debt?.maturityOn ?? instrument.maturityOn, asOf,
    documentedFundedCents: debt?.fundedCapitalCents ?? null, manualOutstandingCents: debt?.outstandingPrincipalCents ?? null, guaranteedReturnCents,
    payments: payments.map(payment => ({
      id: String(payment.id), kind: payment.kind, status: evidenceStatus(payment), paymentOn: payment.paymentOn, currency: payment.currency,
      amountCents: payment.amountCents, amounts: payment.amounts, reversesPaymentId: payment.reversesPaymentId === null ? null : String(payment.reversesPaymentId),
    })),
    obligations: obligations.filter(item => item.currency === instrument.currency).map(item => ({
      periodMonth: item.periodMonth, principalCents: item.principalCents, interestCents: item.interestCents, balloonCents: item.balloonCents, totalExpectedCents: item.totalExpectedCents,
    })),
    fromMonth: range.fromMonth, throughMonth: range.throughMonth,
  };
}

/** Scheduled debt service from the stored debt terms on the funded principal (original principal when funding is undocumented). */
function amortizationFor(instrument: InvestorInstrument, debt: InvestorDebt): AmortizationSchedule {
  const schedule = buildAmortizationSchedule({
    principalCents: debt.fundedCapitalCents ?? debt.originalPrincipalCents, annualRate: debt.annualRate, schedule: debt.schedule, paymentDay: debt.paymentDay,
    monthEndRule: debt.monthEndRule, accrualStartOn: instrument.effectiveFrom, firstDueMonth: debt.firstDueMonth, interestOnlyUntil: debt.interestOnlyUntil,
    amortizationMonths: debt.amortizationMonths, maturityOn: debt.maturityOn ?? instrument.maturityOn, balloonCents: debt.balloonCents, dayCount: debt.dayCount,
  });
  if (debt.fundedCapitalCents !== null || schedule.status !== "ready") return schedule;
  return amortizationScheduleSchema.parse({ ...schedule, warnings: [...schedule.warnings, "Funded principal is not documented; the schedule uses the original principal."].slice(0, 20) });
}

function investorFinancialSourceFromJson(value: unknown): unknown {
  const parsed = parseJson(value, "source_reference");
  // Stored source references are validated again on every read; a malformed
  // source never becomes a verified amount by surviving in JSON.
  return investorFinancialSourceSchema.parse(parsed);
}
