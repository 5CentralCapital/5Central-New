import {
  assertExpectedRevision,
  centsFromBigInt,
  centsToBigInt,
  commandEnvelopeSchema,
  newRecordId,
  recordReferenceIdSchema,
  revisionSchema,
  legalEntityIdSchema,
  type CommandEnvelope,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  addPaymentAmounts,
  calculateInvestorObligation,
  calculateMonthlyObligationAmounts,
  dueDateForMonth,
  emptyPaymentAmounts,
  negatePaymentAmounts,
  sumPaymentAmounts,
} from "../../shared/investors/calculations";
import {
  investorCommandPayloadSchemas,
  investorContractTermsSchema,
  investorContactIdSchema,
  investorPaymentAmountsSchema,
  investorProviderPartyReferenceSchema,
  INVESTOR_COMMAND_KINDS,
  type CreateInvestorAccountPayload,
  type CreateInvestorContractPayload,
  type CreateInvestorContractVersionPayload,
  type CreateInvestorDebtPayload,
  type CreateInvestorInstrumentPayload,
  type GenerateInvestorObligationsPayload,
  type InvestorCommandKind,
  type InvestorContractTerms,
  type InvestorFinancialSource,
  type InvestorFinancialSourceRequest,
  type InvestorPaymentKind,
  type InvestorPaymentAmounts,
  type InvestorProviderPartyReference,
  type RecordInvestorPaymentPayload,
  type EditInvestorManualPaymentPayload,
  type CreateInvestorPartyMappingPayload,
  type UpdateInvestorPartyMappingPayload,
  type CreateInvestorRemittanceInstructionPayload,
  type UpdateInvestorRemittanceInstructionPayload,
} from "../../shared/investors";
import type { AuthenticatedPrincipal, CommandAuthorizationPolicy, TransportAttestation } from "../company/authorization";
import {
  runCompanyCommand,
  type CommandHandlerContext,
  type CommandHandlerResult,
} from "../company/commands/runner";
import { ConflictCommandError, ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import {
  FailClosedInvestorSourceResolver,
  type InvestorPostedSourceVerification,
  type InvestorSourceResolver,
  type InvestorSourceVerificationInput,
} from "./source";
import { dbCents, dbDate, dbDecimal, dbNullableDate, dbRevision, dbString } from "./helpers";

type AnyInvestorCommandEnvelope = CommandEnvelope<Record<string, unknown>>;

export interface InvestorCommandExecutionOptions {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
  readonly sourceResolver?: InvestorSourceResolver;
  /** Build a resolver from the transaction executor so source reservations
   * share the command's rollback boundary. */
  readonly sourceResolverFactory?: (executor: RentOpsQueryExecutor) => InvestorSourceResolver;
}

const INVESTOR_WRITE_ROLES = ["owner", "admin", "finance"] as const;
const INVESTOR_ARCHIVE_ROLES = ["owner", "admin"] as const;

export const INVESTOR_COMMAND_POLICIES: Readonly<Record<InvestorCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  // Investor accounts are organization-wide records and carry no legal entity
  // of their own. Entity-scoped principals must not mutate them indirectly.
  "investor.account.create": { commandKind: "investor.account.create", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "organization" },
  "investor.account.update": { commandKind: "investor.account.update", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "organization" },
  "investor.account.archive": { commandKind: "investor.account.archive", allowedRoles: INVESTOR_ARCHIVE_ROLES, requiredScope: "organization" },
  "investor.instrument.create": { commandKind: "investor.instrument.create", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.instrument.update": { commandKind: "investor.instrument.update", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.instrument.archive": { commandKind: "investor.instrument.archive", allowedRoles: INVESTOR_ARCHIVE_ROLES, requiredScope: "legal_entity" },
  "investor.contract.create": { commandKind: "investor.contract.create", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.contract.version.create": { commandKind: "investor.contract.version.create", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.debt.create": { commandKind: "investor.debt.create", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.debt.update": { commandKind: "investor.debt.update", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.obligation.generate": { commandKind: "investor.obligation.generate", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.payment.record": { commandKind: "investor.payment.record", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.payment.link_qbo": { commandKind: "investor.payment.link_qbo", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.payment.settle": { commandKind: "investor.payment.settle", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.payment.reverse": { commandKind: "investor.payment.reverse", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.payment.edit_manual": { commandKind: "investor.payment.edit_manual", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.party_mapping.create": { commandKind: "investor.party_mapping.create", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.party_mapping.update": { commandKind: "investor.party_mapping.update", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.party_mapping.archive": { commandKind: "investor.party_mapping.archive", allowedRoles: INVESTOR_ARCHIVE_ROLES, requiredScope: "legal_entity" },
  "investor.remittance.create": { commandKind: "investor.remittance.create", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.remittance.update": { commandKind: "investor.remittance.update", allowedRoles: INVESTOR_WRITE_ROLES, requiredScope: "legal_entity" },
  "investor.remittance.archive": { commandKind: "investor.remittance.archive", allowedRoles: INVESTOR_ARCHIVE_ROLES, requiredScope: "legal_entity" },
});

function savedResult(recordIds: readonly string[], revisions: readonly { id: string; revision: Revision }[] = []): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: recordIds.map(id => recordReferenceIdSchema.parse(id)),
    resultingRevisions: revisions.map(item => ({ recordId: recordReferenceIdSchema.parse(item.id), revision: item.revision })),
    validationOutcomes: [{ code: "investor.saved_in_rops", severity: "info", message: "Investor records saved in 5Central Ops" }],
  };
}

function requireLegalEntity(context: CommandHandlerContext<unknown>): ReturnType<typeof legalEntityIdSchema.parse> {
  const legalEntityId = context.envelope.scope.legalEntityId;
  if (!legalEntityId) throw new ValidationCommandError("Investor commands require a legal entity scope", { reason: "investor_entity_scope_required" });
  return legalEntityIdSchema.parse(legalEntityId);
}

function assertScopeEntity(context: CommandHandlerContext<unknown>, legalEntityId: string): void {
  const scopedEntity = requireLegalEntity(context);
  if (scopedEntity !== legalEntityId) throw new ForbiddenCommandError("Investor record is outside the requested legal entity scope", { reason: "investor_entity_scope" });
}

function assertPositiveAmount(amounts: InvestorPaymentAmounts): bigint {
  const values = Object.values(amounts).map(value => centsToBigInt(value));
  if (values.some(value => value < BigInt(0))) throw new ValidationCommandError("Investor payment components cannot be negative; use a reversal for a correction", { reason: "negative_payment_component" });
  const total = values.reduce((sum, value) => sum + value, BigInt(0));
  if (total <= BigInt(0)) throw new ValidationCommandError("Investor payment must contain a positive amount", { reason: "non_positive_payment" });
  return total;
}

function sumAmountValues(left: InvestorPaymentAmounts, right: InvestorPaymentAmounts): InvestorPaymentAmounts {
  return addPaymentAmounts(left, right);
}

function minNonNegative(value: bigint): bigint {
  return value < BigInt(0) ? BigInt(0) : value;
}

function componentCap(requested: InvestorPaymentAmounts, expected: InvestorPaymentAmounts, allocated: InvestorPaymentAmounts): InvestorPaymentAmounts {
  const cap = (field: keyof InvestorPaymentAmounts): string => {
    const remaining = minNonNegative(centsToBigInt(expected[field]) - centsToBigInt(allocated[field]));
    const requestedAmount = centsToBigInt(requested[field]);
    return centsFromBigInt(requestedAmount < remaining ? requestedAmount : remaining);
  };
  return investorPaymentAmountsSchema.parse({
    principalCents: cap("principalCents"), interestCents: cap("interestCents"), returnOfCapitalCents: cap("returnOfCapitalCents"),
    distributionCents: cap("distributionCents"), feeCents: cap("feeCents"), balloonCents: cap("balloonCents"), unclassifiedCents: cap("unclassifiedCents"),
  });
}

function sourceColumns(source: InvestorFinancialSource): {
  provider: string; sourceScope: string; externalTransactionId: string; externalLineId: string; sourceRevision: string;
  environment: string | null; realmId: string | null; objectType: string | null; objectId: string | null; lineId: string | null; version: string | null;
  reference: string; currency: string; amountCents: string; verifiedAt: string; watermark: string;
} {
  if (source.provider === "qbo") {
    const reference = source.reference;
    return {
      provider: "qbo", sourceScope: `${reference.organizationId}:${reference.legalEntityId}:${reference.environment}:${reference.realmId}`,
      externalTransactionId: reference.objectId, externalLineId: reference.lineId ?? "*", sourceRevision: reference.version,
      environment: reference.environment, realmId: reference.realmId, objectType: reference.objectType, objectId: reference.objectId,
      lineId: reference.lineId, version: reference.version, reference: JSON.stringify(source), currency: source.currency,
      amountCents: source.amountCents, verifiedAt: source.verifiedAt, watermark: JSON.stringify(source.watermark),
    };
  }
  return {
    provider: source.provider, sourceScope: source.sourceScope, externalTransactionId: source.externalTransactionId, externalLineId: source.externalLineId,
    sourceRevision: source.sourceRevision, environment: null, realmId: null, objectType: null, objectId: null, lineId: null, version: null,
    reference: JSON.stringify(source), currency: source.currency, amountCents: source.amountCents, verifiedAt: source.verifiedAt,
    watermark: JSON.stringify(source.watermark),
  };
}

async function insertSource(executor: RentOpsQueryExecutor, organizationId: string, paymentId: string, source: InvestorFinancialSource): Promise<void> {
  const values = sourceColumns(source);
  await executor.query(
    `INSERT INTO company_investor_payment_sources
       (organization_id,payment_id,provider,source_scope,external_transaction_id,external_line_id,source_revision,source_environment,source_realm_id,source_object_type,source_object_id,source_line_id,source_version,source_reference,currency,amount_cents,coverage,verified_at,watermark)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::bigint,'verified',$17,$18::jsonb)`,
    [organizationId, paymentId, values.provider, values.sourceScope, values.externalTransactionId, values.externalLineId, values.sourceRevision,
      values.environment, values.realmId, values.objectType, values.objectId, values.lineId, values.version, values.reference, values.currency,
      values.amountCents, values.verifiedAt, values.watermark],
  );
}

async function loadAccount(context: CommandHandlerContext<unknown>, accountId: string, lock = true): Promise<{ revision: Revision; contactId: string }> {
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT record_revision, contact_id FROM company_investor_accounts WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [context.envelope.scope.organizationId, accountId],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Investor account was not found in the requested company scope", { reason: "investor_account_not_found" });
  return { revision: dbRevision(row.record_revision), contactId: dbString(row, "contact_id") };
}

async function assertContact(executor: RentOpsQueryExecutor, organizationId: string, contactId: string): Promise<void> {
  const result = await executor.query(`SELECT id FROM company_contacts WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`, [organizationId, contactId]);
  if (!result.rows.length) throw new ValidationCommandError("Investor contact was not found in this company", { reason: "investor_contact_not_found" });
}

async function assertEntityCurrency(executor: RentOpsQueryExecutor, organizationId: string, legalEntityId: string, currency: string): Promise<void> {
  const result = await executor.query<Record<string, unknown>>(`SELECT currency FROM company_legal_entities WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`, [organizationId, legalEntityId]);
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Legal entity was not found in this company", { reason: "investor_entity_not_found" });
  if (dbString(row, "currency") !== currency) throw new ValidationCommandError("Instrument currency must match its legal entity", { reason: "investor_currency_mismatch" });
}

async function assertInstrumentLinks(executor: RentOpsQueryExecutor, organizationId: string, legalEntityId: string, propertyIds: readonly string[], projectIds: readonly string[], effectiveFrom: string): Promise<void> {
  if (propertyIds.length) {
    const properties = await executor.query<Record<string, unknown>>(
      `SELECT pep.property_id FROM company_property_entity_periods pep JOIN rent_ops_properties p ON p.id=pep.property_id
        WHERE pep.organization_id=$1 AND pep.legal_entity_id=$2 AND pep.property_id=ANY($3::varchar[]) AND pep.effective_from <= $4::date AND (pep.effective_until IS NULL OR pep.effective_until > $4::date) AND p.state_status <> 'archived'`,
      [organizationId, legalEntityId, propertyIds, effectiveFrom],
    );
    if (new Set(properties.rows.map(row => dbString(row, "property_id"))).size !== propertyIds.length) throw new ValidationCommandError("One or more investor properties are outside the legal entity scope", { reason: "investor_property_scope" });
  }
  if (projectIds.length) {
    const projects = await executor.query<Record<string, unknown>>(`SELECT id FROM company_projects WHERE organization_id=$1 AND id::text=ANY($2::varchar[])`, [organizationId, projectIds]);
    if (projects.rows.length !== projectIds.length) throw new ValidationCommandError("One or more investor projects are outside the company scope", { reason: "investor_project_scope" });
  }
}

async function loadInstrument(context: CommandHandlerContext<unknown>, instrumentId: string, lock = true): Promise<{ accountId: string; legalEntityId: string; currency: string; kind: string; revision: Revision; maturityOn: string | null; effectiveFrom: string }> {
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT account_id, legal_entity_id, currency, kind, record_revision, maturity_on, effective_from FROM company_investor_instruments WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [context.envelope.scope.organizationId, instrumentId],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Investor instrument was not found in the requested company scope", { reason: "investor_instrument_not_found" });
  const legalEntityId = dbString(row, "legal_entity_id");
  assertScopeEntity(context, legalEntityId);
  return { accountId: dbString(row, "account_id"), legalEntityId, currency: dbString(row, "currency"), kind: dbString(row, "kind"), revision: dbRevision(row.record_revision), maturityOn: dbNullableDate(row, "maturity_on"), effectiveFrom: dbDate(row, "effective_from") };
}

async function assertAccountInstrument(context: CommandHandlerContext<unknown>, accountId: string, instrumentId: string): Promise<Awaited<ReturnType<typeof loadInstrument>>> {
  const instrument = await loadInstrument(context, instrumentId);
  if (instrument.accountId !== accountId) throw new ValidationCommandError("Investor account and instrument do not match", { reason: "investor_account_instrument_mismatch" });
  await loadAccount(context, accountId);
  return instrument;
}

async function assertContract(context: CommandHandlerContext<unknown>, contractId: string, lock = true): Promise<{ instrumentId: string; revision: Revision; status: string; currentVersionId: string | null }> {
  const result = await context.executor.query<Record<string, unknown>>(`SELECT instrument_id, record_revision, status, current_version_id FROM company_investor_contracts WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL${lock ? " FOR UPDATE" : ""}`, [context.envelope.scope.organizationId, contractId]);
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Investor contract was not found in the requested company scope", { reason: "investor_contract_not_found" });
  await loadInstrument(context, dbString(row, "instrument_id"), false);
  return { instrumentId: dbString(row, "instrument_id"), revision: dbRevision(row.record_revision), status: dbString(row, "status"), currentVersionId: row.current_version_id === null || row.current_version_id === undefined ? null : dbString(row, "current_version_id") };
}

async function assertDocumentReferences(
  executor: RentOpsQueryExecutor,
  sourceDocumentIds: readonly string[],
  active: boolean,
  scope?: { organizationId: string; legalEntityId: string; effectiveFrom: string },
): Promise<void> {
  if (sourceDocumentIds.length === 0) {
    if (active) throw new ValidationCommandError("An active investor contract needs an existing source document reference", { reason: "investor_contract_document_required" });
    return;
  }
  const result = await executor.query<Record<string, unknown>>(`SELECT id, state, property_id FROM rent_ops_documents WHERE id=ANY($1::varchar[])`, [sourceDocumentIds]);
  if (result.rows.length !== sourceDocumentIds.length) throw new ValidationCommandError("Investor contract references a document that does not exist", { reason: "investor_contract_document_missing" });
  if (active && result.rows.some(row => !["signed", "executed", "filed", "current", "verified"].includes(dbString(row, "state")))) throw new ValidationCommandError("Active investor contracts require signed or verified source documents", { reason: "investor_contract_document_unverified" });
  if (scope) {
    const propertyIds = result.rows.map(row => row.property_id).filter((value): value is string => typeof value === "string" && value.length > 0);
    if (propertyIds.length) {
      const scoped = await executor.query<Record<string, unknown>>(
        `SELECT DISTINCT property_id FROM company_property_entity_periods
          WHERE organization_id=$1 AND legal_entity_id=$2 AND property_id=ANY($3::varchar[])
            AND effective_from <= $4::date AND (effective_until IS NULL OR effective_until > $4::date)`,
        [scope.organizationId, scope.legalEntityId, propertyIds, scope.effectiveFrom],
      );
      if (new Set(scoped.rows.map(row => dbString(row, "property_id"))).size !== new Set(propertyIds).size) throw new ValidationCommandError("Investor contract references a document outside the legal entity scope", { reason: "investor_contract_document_scope" });
    }
  }
}

function termsValues(terms: InvestorContractTerms): unknown[] {
  return [terms.schedule, terms.paymentDay, terms.monthEndRule, terms.annualRate, terms.preferredReturnRate, terms.returnMultiple,
    terms.fixedPaymentCents, terms.principalPaymentCents, terms.interestPaymentCents, terms.returnOfCapitalCents, terms.distributionCents,
    terms.balloonCents, terms.originalPrincipalCents, terms.maturityTotalCents, terms.fixedProfitCents, terms.maturityPayoffCents,
    terms.thirdPartyInstallmentCents, terms.investorSpreadCents, terms.unknownComponentKinds, terms.interestOnly, terms.dayCount];
}

function termsFromRow(row: Record<string, unknown>): InvestorContractTerms {
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

function monthParts(month: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})-01$/.exec(month);
  if (!match) throw new ValidationCommandError("Investor obligation month is invalid", { reason: "investor_month_invalid" });
  return { year: Number(match[1]), month: Number(match[2]) };
}

function addMonths(month: string, count: number): string {
  const value = monthParts(month);
  const index = value.year * 12 + value.month - 1 + count;
  const year = Math.floor(index / 12);
  const monthNumber = index % 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}-01`;
}

function monthDistance(from: string, through: string): number {
  const first = monthParts(from); const second = monthParts(through);
  return (second.year - first.year) * 12 + second.month - first.month;
}

function monthOf(date: string | null): string | null {
  return date ? `${date.slice(0, 7)}-01` : null;
}

function scheduleDue(terms: InvestorContractTerms, effectiveFrom: string, periodMonth: string, maturityOn: string | null): { due: boolean; intervalMonths: number } {
  if (terms.schedule === "custom") throw new ValidationCommandError("Custom investor schedules need an explicit schedule adapter before obligations can be generated", { reason: "investor_custom_schedule_unsupported" });
  const base = `${effectiveFrom.slice(0, 7)}-01`;
  const distance = monthDistance(base, periodMonth);
  if (distance < 0) return { due: false, intervalMonths: 1 };
  const maturityMonth = monthOf(maturityOn);
  if (maturityMonth !== null && periodMonth > maturityMonth) return { due: false, intervalMonths: 1 };
  if (terms.schedule === "monthly") return { due: true, intervalMonths: 1 };
  if (terms.schedule === "quarterly") return { due: distance % 3 === 0, intervalMonths: 3 };
  if (terms.schedule === "annual") return { due: monthParts(base).month === monthParts(periodMonth).month && distance % 12 === 0, intervalMonths: 12 };
  return { due: maturityMonth !== null && maturityMonth === periodMonth, intervalMonths: 1 };
}

async function handleCreateAccount(context: CommandHandlerContext<CreateInvestorAccountPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.account.create"].parse(context.envelope.payload);
  let contactId = payload.contactId;
  const organizationId = context.envelope.scope.organizationId;
  if (payload.newContact) {
    contactId = investorContactIdSchema.parse(newRecordId());
    await context.executor.query(`INSERT INTO company_contacts (id,organization_id,kind,display_name,rent_ops_person_id) VALUES ($1,$2,$3,$4,$5)`, [contactId, organizationId, payload.newContact.kind, payload.newContact.displayName, payload.newContact.rentOpsPersonId ?? null]);
  } else {
    await assertContact(context.executor, organizationId, contactId!);
  }
  const id = newRecordId();
  await context.executor.query(`INSERT INTO company_investor_accounts (id,organization_id,contact_id,display_name,notes) VALUES ($1,$2,$3,$4,$5)`, [id, organizationId, contactId, payload.displayName, payload.notes ?? null]);
  return savedResult([id, ...(payload.newContact ? [contactId!] : [])], [{ id, revision: revisionSchema.parse(1) }]);
}

async function handleUpdateAccount(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.account.update"].parse(context.envelope.payload);
  const current = await loadAccount(context, payload.accountId);
  assertExpectedRevision(current.revision, context.envelope.expectedRevision);
  const updates: string[] = []; const values: unknown[] = [];
  const set = (column: string, value: unknown) => { updates.push(`${column}=$${values.length + 1}`); values.push(value); };
  if (payload.displayName !== undefined) set("display_name", payload.displayName);
  if (Object.prototype.hasOwnProperty.call(payload, "notes")) set("notes", payload.notes ?? null);
  if (!updates.length) throw new ValidationCommandError("At least one investor account field is required", { reason: "empty_investor_account_update" });
  values.push(context.envelope.scope.organizationId, payload.accountId, current.revision);
  const result = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_accounts SET ${updates.join(",")},record_revision=record_revision+1,updated_at=now() WHERE organization_id=$${values.length - 2} AND id=$${values.length - 1} AND record_revision=$${values.length} RETURNING record_revision`, values);
  if (!result.rows.length) throw new ConflictCommandError("Investor account changed while it was being edited", { reason: "revision_conflict" });
  return savedResult([payload.accountId], [{ id: payload.accountId, revision: dbRevision(result.rows[0]!.record_revision) }]);
}

async function handleArchiveAccount(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.account.archive"].parse(context.envelope.payload);
  const current = await loadAccount(context, payload.accountId);
  assertExpectedRevision(current.revision, context.envelope.expectedRevision);
  const result = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_accounts SET status='archived',archived_at=now(),record_revision=record_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND record_revision=$3 RETURNING record_revision`, [context.envelope.scope.organizationId, payload.accountId, current.revision]);
  if (!result.rows.length) throw new ConflictCommandError("Investor account changed while it was being archived", { reason: "revision_conflict" });
  return savedResult([payload.accountId], [{ id: payload.accountId, revision: dbRevision(result.rows[0]!.record_revision) }]);
}

async function handleCreatePartyMapping(context: CommandHandlerContext<CreateInvestorPartyMappingPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.party_mapping.create"].parse(context.envelope.payload);
  const organizationId = context.envelope.scope.organizationId;
  assertScopeEntity(context, payload.providerParty.legalEntityId);
  if (payload.providerParty.organizationId !== organizationId) throw new ValidationCommandError("Provider party belongs to another company", { reason: "investor_party_scope" });
  const account = await loadAccount(context as unknown as CommandHandlerContext<unknown>, payload.accountId);
  const contactId = payload.contactId ?? (payload.partyKind === "investor" ? account.contactId : null);
  if (contactId) {
    await assertContact(context.executor, organizationId, contactId);
    if (payload.partyKind === "investor" && contactId !== account.contactId) throw new ValidationCommandError("Investor party mapping must use the account's linked company contact", { reason: "investor_party_contact_mismatch" });
  }
  await assertDocumentReferences(context.executor, payload.sourceDocumentId ? [payload.sourceDocumentId] : [], payload.partyKind === "third_party_lender");
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO company_investor_party_mappings (id,organization_id,account_id,legal_entity_id,contact_id,party_kind,display_name,provider,provider_environment,provider_realm_id,provider_object_type,provider_object_id,source_document_id,effective_from,effective_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, organizationId, payload.accountId, payload.providerParty.legalEntityId, contactId, payload.partyKind, payload.displayName, payload.providerParty.provider, payload.providerParty.environment, payload.providerParty.realmId, payload.providerParty.objectType, payload.providerParty.objectId, payload.sourceDocumentId ?? null, payload.effectiveFrom, payload.effectiveTo ?? null],
  );
  return savedResult([id], [{ id, revision: revisionSchema.parse(1) }]);
}

async function handleUpdatePartyMapping(context: CommandHandlerContext<UpdateInvestorPartyMappingPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.party_mapping.update"].parse(context.envelope.payload);
  const rowResult = await context.executor.query<Record<string, unknown>>(`SELECT legal_entity_id,party_kind,source_document_id,effective_from,record_revision FROM company_investor_party_mappings WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [context.envelope.scope.organizationId, payload.mappingId]);
  const row = rowResult.rows[0];
  if (!row) throw new ValidationCommandError("Investor party mapping was not found in the requested company scope", { reason: "investor_party_mapping_not_found" });
  assertScopeEntity(context as unknown as CommandHandlerContext<unknown>, dbString(row, "legal_entity_id"));
  const revision = dbRevision(row.record_revision);
  assertExpectedRevision(revision, context.envelope.expectedRevision);
  const updates: string[] = []; const values: unknown[] = [];
  const set = (column: string, value: unknown) => { updates.push(`${column}=$${values.length + 1}`); values.push(value); };
  if (payload.displayName !== undefined) set("display_name", payload.displayName);
  if (Object.prototype.hasOwnProperty.call(payload, "sourceDocumentId")) {
    if (payload.sourceDocumentId) await assertDocumentReferences(context.executor, [payload.sourceDocumentId], dbString(row, "party_kind") === "third_party_lender");
    set("source_document_id", payload.sourceDocumentId ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "effectiveTo")) {
    if (payload.effectiveTo !== undefined && payload.effectiveTo !== null && payload.effectiveTo <= dbDate(row, "effective_from")) throw new ValidationCommandError("Party mapping effectiveTo must follow effectiveFrom", { reason: "investor_party_mapping_dates" });
    set("effective_to", payload.effectiveTo ?? null);
  }
  if (!updates.length) throw new ValidationCommandError("At least one investor party mapping field is required", { reason: "empty_investor_party_mapping_update" });
  values.push(context.envelope.scope.organizationId, payload.mappingId, revision);
  const updated = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_party_mappings SET ${updates.join(",")},record_revision=record_revision+1,updated_at=now() WHERE organization_id=$${values.length - 2} AND id=$${values.length - 1} AND record_revision=$${values.length} RETURNING record_revision`, values);
  if (!updated.rows.length) throw new ConflictCommandError("Investor party mapping changed while it was being edited", { reason: "revision_conflict" });
  return savedResult([payload.mappingId], [{ id: payload.mappingId, revision: dbRevision(updated.rows[0]!.record_revision) }]);
}

async function handleArchivePartyMapping(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.party_mapping.archive"].parse(context.envelope.payload);
  const row = await context.executor.query<{ record_revision: number; legal_entity_id: string }>(`SELECT record_revision,legal_entity_id FROM company_investor_party_mappings WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [context.envelope.scope.organizationId, payload.mappingId]);
  if (!row.rows.length) throw new ValidationCommandError("Investor party mapping was not found in the requested company scope", { reason: "investor_party_mapping_not_found" });
  assertScopeEntity(context, dbString(row.rows[0]!, "legal_entity_id"));
  const revision = dbRevision(row.rows[0]!.record_revision); assertExpectedRevision(revision, context.envelope.expectedRevision);
  const updated = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_party_mappings SET status='archived',archived_at=now(),record_revision=record_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND record_revision=$3 RETURNING record_revision`, [context.envelope.scope.organizationId, payload.mappingId, revision]);
  if (!updated.rows.length) throw new ConflictCommandError("Investor party mapping changed while it was being archived", { reason: "revision_conflict" });
  return savedResult([payload.mappingId], [{ id: payload.mappingId, revision: dbRevision(updated.rows[0]!.record_revision) }]);
}

async function handleCreateRemittance(context: CommandHandlerContext<CreateInvestorRemittanceInstructionPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.remittance.create"].parse(context.envelope.payload);
  const instrument = await assertAccountInstrument(context as unknown as CommandHandlerContext<unknown>, payload.accountId, payload.instrumentId);
  const mappingResult = await context.executor.query<Record<string, unknown>>(`SELECT account_id,legal_entity_id,party_kind,status,effective_from,effective_to FROM company_investor_party_mappings WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL`, [context.envelope.scope.organizationId, payload.partyMappingId]);
  const mapping = mappingResult.rows[0];
  if (!mapping || dbString(mapping, "account_id") !== payload.accountId || dbString(mapping, "legal_entity_id") !== instrument.legalEntityId || dbString(mapping, "party_kind") !== "third_party_lender") throw new ValidationCommandError("Remittance party mapping is not an active third-party mapping for this instrument", { reason: "investor_remittance_mapping_scope" });
  if (payload.effectiveFrom < dbDate(mapping, "effective_from") || (dbNullableDate(mapping, "effective_to") !== null && payload.effectiveFrom >= dbNullableDate(mapping, "effective_to")!)) throw new ValidationCommandError("Remittance instruction starts outside the authorized party mapping period", { reason: "investor_remittance_dates" });
  if (payload.contractId) {
    const contract = await assertContract(context as unknown as CommandHandlerContext<unknown>, payload.contractId);
    if (contract.instrumentId !== payload.instrumentId) throw new ValidationCommandError("Remittance contract does not belong to this instrument", { reason: "investor_remittance_contract_scope" });
  }
  await assertDocumentReferences(context.executor, [payload.sourceDocumentId], false);
  const id = newRecordId();
  await context.executor.query(`INSERT INTO company_investor_remittance_instructions (id,organization_id,account_id,instrument_id,contract_id,legal_entity_id,party_mapping_id,beneficiary_kind,source_document_id,effective_from,effective_to,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,'third_party_lender',$8,$9,$10,$11)`, [id, context.envelope.scope.organizationId, payload.accountId, payload.instrumentId, payload.contractId ?? null, instrument.legalEntityId, payload.partyMappingId, payload.sourceDocumentId, payload.effectiveFrom, payload.effectiveTo ?? null, payload.notes ?? null]);
  return savedResult([id], [{ id, revision: revisionSchema.parse(1) }]);
}

async function handleUpdateRemittance(context: CommandHandlerContext<UpdateInvestorRemittanceInstructionPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.remittance.update"].parse(context.envelope.payload);
  const result = await context.executor.query<Record<string, unknown>>(`SELECT record_revision,effective_from,legal_entity_id FROM company_investor_remittance_instructions WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [context.envelope.scope.organizationId, payload.instructionId]);
  const row = result.rows[0]; if (!row) throw new ValidationCommandError("Investor remittance instruction was not found in the requested company scope", { reason: "investor_remittance_not_found" });
  assertScopeEntity(context as unknown as CommandHandlerContext<unknown>, dbString(row, "legal_entity_id"));
  const revision = dbRevision(row.record_revision); assertExpectedRevision(revision, context.envelope.expectedRevision);
  if (payload.effectiveTo !== undefined && payload.effectiveTo !== null && payload.effectiveTo < dbDate(row, "effective_from")) throw new ValidationCommandError("Remittance effectiveTo must follow effectiveFrom", { reason: "investor_remittance_dates" });
  const updates: string[] = []; const values: unknown[] = []; const set = (column: string, value: unknown) => { updates.push(`${column}=$${values.length + 1}`); values.push(value); };
  if (payload.sourceDocumentId !== undefined) { await assertDocumentReferences(context.executor, [payload.sourceDocumentId], false); set("source_document_id", payload.sourceDocumentId); }
  if (Object.prototype.hasOwnProperty.call(payload, "effectiveTo")) set("effective_to", payload.effectiveTo ?? null);
  if (Object.prototype.hasOwnProperty.call(payload, "notes")) set("notes", payload.notes ?? null);
  if (!updates.length) throw new ValidationCommandError("At least one remittance instruction field is required", { reason: "empty_investor_remittance_update" });
  values.push(context.envelope.scope.organizationId, payload.instructionId, revision);
  const updated = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_remittance_instructions SET ${updates.join(",")},record_revision=record_revision+1,updated_at=now() WHERE organization_id=$${values.length - 2} AND id=$${values.length - 1} AND record_revision=$${values.length} RETURNING record_revision`, values);
  if (!updated.rows.length) throw new ConflictCommandError("Investor remittance instruction changed while it was being edited", { reason: "revision_conflict" });
  return savedResult([payload.instructionId], [{ id: payload.instructionId, revision: dbRevision(updated.rows[0]!.record_revision) }]);
}

async function handleArchiveRemittance(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.remittance.archive"].parse(context.envelope.payload);
  const result = await context.executor.query<{ record_revision: number; legal_entity_id: string }>(`SELECT record_revision,legal_entity_id FROM company_investor_remittance_instructions WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [context.envelope.scope.organizationId, payload.instructionId]);
  if (!result.rows.length) throw new ValidationCommandError("Investor remittance instruction was not found in the requested company scope", { reason: "investor_remittance_not_found" });
  assertScopeEntity(context, dbString(result.rows[0]!, "legal_entity_id"));
  const revision = dbRevision(result.rows[0]!.record_revision); assertExpectedRevision(revision, context.envelope.expectedRevision);
  const updated = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_remittance_instructions SET status='archived',archived_at=now(),record_revision=record_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND record_revision=$3 RETURNING record_revision`, [context.envelope.scope.organizationId, payload.instructionId, revision]);
  if (!updated.rows.length) throw new ConflictCommandError("Investor remittance instruction changed while it was being archived", { reason: "revision_conflict" });
  return savedResult([payload.instructionId], [{ id: payload.instructionId, revision: dbRevision(updated.rows[0]!.record_revision) }]);
}

async function handleCreateInstrument(context: CommandHandlerContext<CreateInvestorInstrumentPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.instrument.create"].parse(context.envelope.payload);
  assertScopeEntity(context, payload.legalEntityId);
  await assertEntityCurrency(context.executor, context.envelope.scope.organizationId, payload.legalEntityId, payload.currency);
  await loadAccount(context as unknown as CommandHandlerContext<unknown>, payload.accountId);
  await assertInstrumentLinks(context.executor, context.envelope.scope.organizationId, payload.legalEntityId, payload.propertyIds, payload.projectIds, payload.effectiveFrom);
  const id = newRecordId();
  await context.executor.query(`INSERT INTO company_investor_instruments (id,organization_id,account_id,name,kind,status,legal_entity_id,currency,committed_cents,face_principal_cents,effective_from,maturity_on,ownership_bps,notes) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8::bigint,$9::bigint,$10,$11,$12,$13)`, [id, context.envelope.scope.organizationId, payload.accountId, payload.name, payload.kind, payload.legalEntityId, payload.currency, payload.committedCents, payload.facePrincipalCents, payload.effectiveFrom, payload.maturityOn ?? null, payload.ownershipBps ?? null, payload.notes ?? null]);
  for (const propertyId of payload.propertyIds) await context.executor.query(`INSERT INTO company_investor_instrument_properties (organization_id,instrument_id,property_id) VALUES ($1,$2,$3)`, [context.envelope.scope.organizationId, id, propertyId]);
  for (const projectId of payload.projectIds) await context.executor.query(`INSERT INTO company_investor_instrument_projects (organization_id,instrument_id,project_id) VALUES ($1,$2,$3)`, [context.envelope.scope.organizationId, id, projectId]);
  return savedResult([id], [{ id, revision: revisionSchema.parse(1) }]);
}

async function handleUpdateInstrument(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.instrument.update"].parse(context.envelope.payload);
  const current = await loadInstrument(context, payload.instrumentId);
  assertExpectedRevision(current.revision, context.envelope.expectedRevision);
  const updates: string[] = []; const values: unknown[] = [];
  const set = (column: string, value: unknown) => { updates.push(`${column}=$${values.length + 1}`); values.push(value); };
  if (payload.name !== undefined) set("name", payload.name);
  if (payload.status !== undefined) set("status", payload.status);
  if (Object.prototype.hasOwnProperty.call(payload, "notes")) set("notes", payload.notes ?? null);
  if (!updates.length) throw new ValidationCommandError("At least one investor instrument field is required", { reason: "empty_investor_instrument_update" });
  if (payload.status === "archived") set("archived_at", new Date().toISOString());
  values.push(context.envelope.scope.organizationId, payload.instrumentId, current.revision);
  const result = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_instruments SET ${updates.join(",")},record_revision=record_revision+1,updated_at=now() WHERE organization_id=$${values.length - 2} AND id=$${values.length - 1} AND record_revision=$${values.length} RETURNING record_revision`, values);
  if (!result.rows.length) throw new ConflictCommandError("Investor instrument changed while it was being edited", { reason: "revision_conflict" });
  return savedResult([payload.instrumentId], [{ id: payload.instrumentId, revision: dbRevision(result.rows[0]!.record_revision) }]);
}

async function handleArchiveInstrument(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.instrument.archive"].parse(context.envelope.payload);
  const current = await loadInstrument(context, payload.instrumentId);
  assertExpectedRevision(current.revision, context.envelope.expectedRevision);
  const result = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_instruments SET status='archived',archived_at=now(),record_revision=record_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND record_revision=$3 RETURNING record_revision`, [context.envelope.scope.organizationId, payload.instrumentId, current.revision]);
  if (!result.rows.length) throw new ConflictCommandError("Investor instrument changed while it was being archived", { reason: "revision_conflict" });
  return savedResult([payload.instrumentId], [{ id: payload.instrumentId, revision: dbRevision(result.rows[0]!.record_revision) }]);
}

async function insertContractVersion(context: CommandHandlerContext<unknown>, contractId: string, payload: CreateInvestorContractPayload | CreateInvestorContractVersionPayload, versionNo: number, legalEntityId: string): Promise<string> {
  const versionId = newRecordId();
  const terms = payload.terms;
  const active = payload.status === "active";
  await assertDocumentReferences(context.executor, payload.sourceDocumentIds, active, { organizationId: context.envelope.scope.organizationId, legalEntityId, effectiveFrom: payload.effectiveFrom });
  await context.executor.query(
    `INSERT INTO company_investor_contract_versions (id,organization_id,contract_id,version_no,status,effective_from,signed_on,schedule,payment_day,month_end_rule,annual_rate,preferred_return_rate,return_multiple,fixed_payment_cents,principal_payment_cents,interest_payment_cents,return_of_capital_cents,distribution_cents,balloon_cents,original_principal_cents,maturity_total_cents,fixed_profit_cents,maturity_payoff_cents,third_party_installment_cents,investor_spread_cents,unknown_component_kinds,interest_only,day_count,created_by,approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12::numeric,$13::numeric,$14::bigint,$15::bigint,$16::bigint,$17::bigint,$18::bigint,$19::bigint,$20::bigint,$21::bigint,$22::bigint,$23::bigint,$24::bigint,$25::bigint,$26::text[],$27,$28,$29,$30)`,
    [versionId, context.envelope.scope.organizationId, contractId, versionNo, payload.status, payload.effectiveFrom, payload.signedOn ?? null, ...termsValues(terms), context.principal.actorId, active ? context.principal.actorId : null],
  );
  for (const documentId of payload.sourceDocumentIds) await context.executor.query(`INSERT INTO company_investor_contract_documents (organization_id,contract_id,contract_version_id,document_id) VALUES ($1,$2,$3,$4)`, [context.envelope.scope.organizationId, contractId, versionId, documentId]);
  return versionId;
}

async function handleCreateContract(context: CommandHandlerContext<CreateInvestorContractPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.contract.create"].parse(context.envelope.payload);
  const instrument = await loadInstrument(context as unknown as CommandHandlerContext<unknown>, payload.instrumentId);
  await loadAccount(context as unknown as CommandHandlerContext<unknown>, instrument.accountId);
  const contractId = newRecordId();
  await context.executor.query(`INSERT INTO company_investor_contracts (id,organization_id,instrument_id,title,kind,status) VALUES ($1,$2,$3,$4,$5,$6)`, [contractId, context.envelope.scope.organizationId, payload.instrumentId, payload.title, payload.kind, payload.status]);
  const versionId = await insertContractVersion(context as unknown as CommandHandlerContext<unknown>, contractId, payload, 1, instrument.legalEntityId);
  if (payload.status === "active") await context.executor.query(`UPDATE company_investor_contracts SET current_version_id=$3,updated_at=now() WHERE organization_id=$1 AND id=$2`, [context.envelope.scope.organizationId, contractId, versionId]);
  return savedResult([contractId, versionId], [{ id: contractId, revision: revisionSchema.parse(1) }, { id: versionId, revision: revisionSchema.parse(1) }]);
}

async function handleCreateContractVersion(context: CommandHandlerContext<CreateInvestorContractVersionPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.contract.version.create"].parse(context.envelope.payload);
  const contract = await assertContract(context as unknown as CommandHandlerContext<unknown>, payload.contractId);
  assertExpectedRevision(contract.revision, context.envelope.expectedRevision);
  const next = await context.executor.query<{ version_no: string | number }>(`SELECT COALESCE(MAX(version_no),0)::text AS version_no FROM company_investor_contract_versions WHERE organization_id=$1 AND contract_id=$2`, [context.envelope.scope.organizationId, payload.contractId]);
  const versionNo = Number(next.rows[0]?.version_no ?? 0) + 1;
  if (!Number.isSafeInteger(versionNo) || versionNo <= 0) throw new ValidationCommandError("Investor contract version number exceeded supported range", { reason: "investor_contract_version_overflow" });
  if (payload.status === "active") {
    const active = await context.executor.query<{ id: string; effective_from: string | Date }>(
      `SELECT id,effective_from FROM company_investor_contract_versions
        WHERE organization_id=$1 AND contract_id=$2 AND status='active' FOR UPDATE`,
      [context.envelope.scope.organizationId, payload.contractId],
    );
    const current = active.rows[0];
    if (current) {
      const currentEffectiveFrom = current.effective_from instanceof Date ? current.effective_from.toISOString().slice(0, 10) : String(current.effective_from).slice(0, 10);
      if (payload.effectiveFrom <= currentEffectiveFrom) throw new ValidationCommandError("An investor contract amendment must start after the active version", { reason: "investor_contract_version_effective_date" });
      await context.executor.query(
        `UPDATE company_investor_contract_versions SET status='superseded',effective_to=$3
          WHERE organization_id=$1 AND id=$2`,
        [context.envelope.scope.organizationId, current.id, payload.effectiveFrom],
      );
    }
  }
  const contractInstrument = await loadInstrument(context as unknown as CommandHandlerContext<unknown>, contract.instrumentId, false);
  const versionId = await insertContractVersion(context as unknown as CommandHandlerContext<unknown>, payload.contractId, payload, versionNo, contractInstrument.legalEntityId);
  const update = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_contracts SET status=$3,current_version_id=$4,record_revision=record_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND record_revision=$5 RETURNING record_revision`, [context.envelope.scope.organizationId, payload.contractId, payload.status, payload.status === "active" ? versionId : contract.currentVersionId, contract.revision]);
  if (!update.rows.length) throw new ConflictCommandError("Investor contract changed while a version was being added", { reason: "revision_conflict" });
  return savedResult([payload.contractId, versionId], [{ id: payload.contractId, revision: dbRevision(update.rows[0]!.record_revision) }, { id: versionId, revision: revisionSchema.parse(1) }]);
}

async function handleCreateDebt(context: CommandHandlerContext<CreateInvestorDebtPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.debt.create"].parse(context.envelope.payload);
  assertScopeEntity(context, payload.legalEntityId);
  const instrument = await loadInstrument(context as unknown as CommandHandlerContext<unknown>, payload.instrumentId);
  if (instrument.kind !== payload.debtKind) throw new ValidationCommandError("Debt kind must match the investor instrument kind", { reason: "investor_debt_kind_mismatch" });
  if (instrument.legalEntityId !== payload.legalEntityId || instrument.currency !== payload.currency) throw new ValidationCommandError("Debt legal entity and currency must match the investor instrument", { reason: "investor_debt_scope_mismatch" });
  const id = newRecordId();
  await context.executor.query(`INSERT INTO company_investor_debt (id,organization_id,account_id,instrument_id,legal_entity_id,debt_kind,currency,original_principal_cents,funded_capital_cents,outstanding_principal_cents,annual_rate,schedule,payment_day,month_end_rule,first_due_month,interest_only_until,maturity_on,amortization_months,balloon_cents,day_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint,$9::bigint,$10::bigint,$11::numeric,$12,$13,$14,$15,$16,$17,$18,$19::bigint,$20)`, [id, context.envelope.scope.organizationId, instrument.accountId, payload.instrumentId, payload.legalEntityId, payload.debtKind, payload.currency, payload.originalPrincipalCents, payload.fundedCapitalCents, payload.outstandingPrincipalCents, payload.annualRate, payload.schedule, payload.paymentDay, payload.monthEndRule, payload.firstDueMonth, payload.interestOnlyUntil, payload.maturityOn ?? null, payload.amortizationMonths, payload.balloonCents, payload.dayCount]);
  return savedResult([id], [{ id, revision: revisionSchema.parse(1) }]);
}

async function handleUpdateDebt(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.debt.update"].parse(context.envelope.payload);
  const result = await context.executor.query<Record<string, unknown>>(`SELECT instrument_id,record_revision FROM company_investor_debt WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [context.envelope.scope.organizationId, payload.debtId]);
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Investor debt was not found in the requested company scope", { reason: "investor_debt_not_found" });
  await loadInstrument(context, dbString(row, "instrument_id"));
  const current = dbRevision(row.record_revision);
  assertExpectedRevision(current, context.envelope.expectedRevision);
  const updates: string[] = []; const values: unknown[] = [];
  const set = (column: string, value: unknown) => { updates.push(`${column}=$${values.length + 1}`); values.push(value); };
  if (Object.prototype.hasOwnProperty.call(payload, "fundedCapitalCents")) set("funded_capital_cents", payload.fundedCapitalCents ?? null);
  if (payload.outstandingPrincipalCents !== undefined) set("outstanding_principal_cents", payload.outstandingPrincipalCents);
  if (payload.annualRate !== undefined) set("annual_rate", payload.annualRate);
  if (Object.prototype.hasOwnProperty.call(payload, "paymentDay")) set("payment_day", payload.paymentDay ?? null);
  if (payload.monthEndRule !== undefined) set("month_end_rule", payload.monthEndRule);
  if (Object.prototype.hasOwnProperty.call(payload, "maturityOn")) set("maturity_on", payload.maturityOn ?? null);
  if (Object.prototype.hasOwnProperty.call(payload, "balloonCents")) set("balloon_cents", payload.balloonCents ?? null);
  if (!updates.length) throw new ValidationCommandError("At least one investor debt field is required", { reason: "empty_investor_debt_update" });
  values.push(context.envelope.scope.organizationId, payload.debtId, current);
  const updated = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_debt SET ${updates.join(",")},record_revision=record_revision+1,updated_at=now() WHERE organization_id=$${values.length - 2} AND id=$${values.length - 1} AND record_revision=$${values.length} RETURNING record_revision`, values);
  if (!updated.rows.length) throw new ConflictCommandError("Investor debt changed while it was being edited", { reason: "revision_conflict" });
  return savedResult([payload.debtId], [{ id: payload.debtId, revision: dbRevision(updated.rows[0]!.record_revision) }]);
}

async function obligationOpening(context: CommandHandlerContext<unknown>, instrumentId: string): Promise<string | null> {
  const debt = await context.executor.query<Record<string, unknown>>(`SELECT funded_capital_cents FROM company_investor_debt WHERE organization_id=$1 AND instrument_id=$2 AND archived_at IS NULL`, [context.envelope.scope.organizationId, instrumentId]);
  if (debt.rows.length) {
    const funded = debt.rows[0]!.funded_capital_cents;
    return funded === null || funded === undefined ? null : dbCents(funded, "funded_capital_cents");
  }
  // Contractual original principal is evidence of the agreed face amount,
  // never proof that capital was funded. Rate-based forecasts therefore stay
  // unresolved until a debt funding fact is recorded.
  return null;
}

async function handleGenerateObligations(context: CommandHandlerContext<GenerateInvestorObligationsPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.obligation.generate"].parse(context.envelope.payload);
  const instrument = await loadInstrument(context as unknown as CommandHandlerContext<unknown>, payload.instrumentId);
  const contract = await assertContract(context as unknown as CommandHandlerContext<unknown>, payload.contractId, false);
  if (contract.instrumentId !== payload.instrumentId) throw new ValidationCommandError("Investor contract does not belong to this instrument", { reason: "investor_contract_instrument_mismatch" });
  const versionResult = await context.executor.query<Record<string, unknown>>(`SELECT id, effective_from, effective_to, schedule, payment_day, month_end_rule, annual_rate, preferred_return_rate, return_multiple, fixed_payment_cents, principal_payment_cents, interest_payment_cents, return_of_capital_cents, distribution_cents, balloon_cents, original_principal_cents, maturity_total_cents, fixed_profit_cents, maturity_payoff_cents, third_party_installment_cents, investor_spread_cents, unknown_component_kinds, interest_only, day_count, status FROM company_investor_contract_versions WHERE organization_id=$1 AND id=$2 AND contract_id=$3`, [context.envelope.scope.organizationId, contract.currentVersionId, payload.contractId]);
  const version = versionResult.rows[0];
  if (!version || dbString(version, "status") !== "active") throw new ValidationCommandError("Only an active investor contract version can generate obligations", { reason: "investor_contract_version_inactive" });
  const terms = termsFromRow(version);
  const effectiveTo = dbNullableDate(version, "effective_to");
  if (terms.schedule === "at_maturity" && instrument.maturityOn === null) throw new ValidationCommandError("An at-maturity investor schedule requires an instrument maturity date", { reason: "investor_maturity_date_required" });
  const requestedSpan = monthDistance(payload.fromMonth, payload.throughMonth);
  if (requestedSpan < 0) throw new ValidationCommandError("Investor obligation range must end on or after its start month", { reason: "investor_obligation_range_invalid" });
  if (requestedSpan > 240) throw new ValidationCommandError("Generate at most 240 investor obligation months per command", { reason: "investor_obligation_range_too_large" });
  const effectiveFrom = dbDate(version, "effective_from");
  const anchorMonth = `${effectiveFrom.slice(0, 7)}-01`;
  const generationSpan = monthDistance(anchorMonth, payload.throughMonth);
  if (generationSpan > 240) throw new ValidationCommandError("Generate at most 240 investor obligation months from the contract effective month", { reason: "investor_obligation_anchor_range_too_large" });
  let opening = await obligationOpening(context as unknown as CommandHandlerContext<unknown>, payload.instrumentId);
  const affected: string[] = [];
  for (let index = 0; index <= generationSpan; index += 1) {
    const periodMonth = addMonths(anchorMonth, index);
    const schedule = scheduleDue(terms, effectiveFrom, periodMonth, instrument.maturityOn);
    if (!schedule.due) continue;
    const due = monthOf(instrument.maturityOn) === periodMonth && instrument.maturityOn !== null
      ? instrument.maturityOn
      : dueDateForMonth(periodMonth, terms.paymentDay, terms.monthEndRule);
    if (due < effectiveFrom) continue;
    // Version effectiveTo is exclusive. A payment whose due date falls after
    // it belongs to a successor version, not this one.
    if (effectiveTo !== null && due >= effectiveTo) break;
    const endOn = addMonths(periodMonth, schedule.intervalMonths);
    const accrualEndOn = monthOf(instrument.maturityOn) === periodMonth && instrument.maturityOn !== null ? instrument.maturityOn : endOn;
    const accrualStartOn = terms.schedule === "at_maturity" || periodMonth === anchorMonth ? effectiveFrom : periodMonth;
    const calculation = calculateInvestorObligation(terms, opening, monthOf(instrument.maturityOn) === periodMonth, { startOn: accrualStartOn, endOn: accrualEndOn });
    const amounts = calculation.amounts;
    const totalExpected = calculation.totalExpectedCents;
    if (periodMonth >= payload.fromMonth && (totalExpected === null || centsToBigInt(totalExpected) > BigInt(0) || centsToBigInt(calculation.knownMinimumCents) > BigInt(0))) {
      const id = newRecordId();
      const inserted = await context.executor.query<{ id: string }>(
        `INSERT INTO company_investor_obligations (id,organization_id,account_id,instrument_id,contract_id,contract_version_id,legal_entity_id,period_month,due_on,currency,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unknown_expected_cents,unknown_component_kinds,total_expected_cents,known_minimum_cents,amount_complete)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12::bigint,$13::bigint,$14::bigint,$15::bigint,$16::bigint,$17::bigint,$18::text[],$19::bigint,$20::bigint,$21)
         ON CONFLICT (organization_id,instrument_id,contract_id,contract_version_id,period_month) DO NOTHING RETURNING id`,
        [id, context.envelope.scope.organizationId, instrument.accountId, payload.instrumentId, payload.contractId, dbString(version, "id"), instrument.legalEntityId, periodMonth, due, instrument.currency, amounts.principalCents, amounts.interestCents, amounts.returnOfCapitalCents, amounts.distributionCents, amounts.feeCents, amounts.balloonCents, calculation.unknownExpectedCents, calculation.unknownComponentKinds, totalExpected, calculation.knownMinimumCents, calculation.amountComplete],
      );
      if (inserted.rows.length) affected.push(id);
    }
    if (opening !== null) {
      const remaining = centsToBigInt(opening) - centsToBigInt(amounts.principalCents) - centsToBigInt(amounts.balloonCents);
      opening = centsFromBigInt(remaining < BigInt(0) ? BigInt(0) : remaining);
    }
  }
  return savedResult(affected, affected.map(id => ({ id, revision: revisionSchema.parse(1) })));
}

async function loadObligationForPayment(context: CommandHandlerContext<unknown>, obligationId: string): Promise<{ id: string; periodMonth: string; accountId: string; instrumentId: string; contractId: string; legalEntityId: string; currency: string; expected: InvestorPaymentAmounts }> {
  const result = await context.executor.query<Record<string, unknown>>(`SELECT id,period_month,account_id,instrument_id,contract_id,legal_entity_id,currency,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unknown_expected_cents FROM company_investor_obligations WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [context.envelope.scope.organizationId, obligationId]);
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Investor obligation was not found in the requested company scope", { reason: "investor_obligation_not_found" });
  return { id: dbString(row, "id"), periodMonth: dbDate(row, "period_month"), accountId: dbString(row, "account_id"), instrumentId: dbString(row, "instrument_id"), contractId: dbString(row, "contract_id"), legalEntityId: dbString(row, "legal_entity_id"), currency: dbString(row, "currency"), expected: investorPaymentAmountsSchema.parse({ principalCents: dbCents(row.principal_cents, "principal_cents"), interestCents: dbCents(row.interest_cents, "interest_cents"), returnOfCapitalCents: dbCents(row.return_of_capital_cents, "return_of_capital_cents"), distributionCents: dbCents(row.distribution_cents, "distribution_cents"), feeCents: dbCents(row.fee_cents, "fee_cents"), balloonCents: dbCents(row.balloon_cents, "balloon_cents"), unclassifiedCents: dbCents(row.unknown_expected_cents, "unknown_expected_cents") }) };
}

async function allocatedForObligation(context: CommandHandlerContext<unknown>, obligationId: string): Promise<InvestorPaymentAmounts> {
  const result = await context.executor.query<Record<string, unknown>>(`SELECT COALESCE(SUM(principal_cents),0)::text AS principal_cents,COALESCE(SUM(interest_cents),0)::text AS interest_cents,COALESCE(SUM(return_of_capital_cents),0)::text AS return_of_capital_cents,COALESCE(SUM(distribution_cents),0)::text AS distribution_cents,COALESCE(SUM(fee_cents),0)::text AS fee_cents,COALESCE(SUM(balloon_cents),0)::text AS balloon_cents,COALESCE(SUM(unclassified_cents),0)::text AS unclassified_cents FROM company_investor_payment_allocations WHERE organization_id=$1 AND obligation_id=$2`, [context.envelope.scope.organizationId, obligationId]);
  const row = result.rows[0]!;
  return investorPaymentAmountsSchema.parse({ principalCents: dbCents(row.principal_cents, "principal_cents"), interestCents: dbCents(row.interest_cents, "interest_cents"), returnOfCapitalCents: dbCents(row.return_of_capital_cents, "return_of_capital_cents"), distributionCents: dbCents(row.distribution_cents, "distribution_cents"), feeCents: dbCents(row.fee_cents, "fee_cents"), balloonCents: dbCents(row.balloon_cents, "balloon_cents"), unclassifiedCents: dbCents(row.unclassified_cents, "unclassified_cents") });
}

async function authorizedCounterparties(context: CommandHandlerContext<unknown>, input: { accountId: string; instrumentId: string; kind: InvestorPaymentKind; paymentOn: string; remittanceInstructionId?: string | null }): Promise<InvestorProviderPartyReference[]> {
  const organizationId = context.envelope.scope.organizationId;
  if (input.remittanceInstructionId) {
    if (input.kind === "contribution") throw new ValidationCommandError("Investor contributions cannot use a third-party remittance instruction", { reason: "investor_remittance_kind" });
    const result = await context.executor.query<Record<string, unknown>>(
      `SELECT m.provider,m.legal_entity_id,m.provider_environment,m.provider_realm_id,m.provider_object_type,m.provider_object_id FROM company_investor_remittance_instructions r JOIN company_investor_party_mappings m ON m.organization_id=r.organization_id AND m.id=r.party_mapping_id
       WHERE r.organization_id=$1 AND r.id=$2 AND r.account_id=$3 AND r.instrument_id=$4 AND r.status='active' AND r.archived_at IS NULL AND m.status='active' AND m.archived_at IS NULL
         AND r.effective_from <= $5::date AND (r.effective_to IS NULL OR r.effective_to > $5::date) AND m.effective_from <= $5::date AND (m.effective_to IS NULL OR m.effective_to > $5::date) AND r.legal_entity_id=$6 AND m.legal_entity_id=$6`,
      [organizationId, input.remittanceInstructionId, input.accountId, input.instrumentId, input.paymentOn, requireLegalEntity(context)],
    );
    return result.rows.map(row => investorProviderPartyReferenceSchema.parse({ provider: dbString(row, "provider"), organizationId, legalEntityId: requireLegalEntity(context), environment: dbString(row, "provider_environment"), realmId: dbString(row, "provider_realm_id"), objectType: dbString(row, "provider_object_type"), objectId: dbString(row, "provider_object_id") }));
  }
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT m.provider,m.legal_entity_id,m.provider_environment,m.provider_realm_id,m.provider_object_type,m.provider_object_id FROM company_investor_party_mappings m JOIN company_investor_accounts a ON a.organization_id=m.organization_id AND a.id=m.account_id
     WHERE m.organization_id=$1 AND m.account_id=$2 AND m.legal_entity_id=$3 AND m.party_kind='investor' AND m.status='active' AND m.archived_at IS NULL AND m.effective_from <= $4::date AND (m.effective_to IS NULL OR m.effective_to > $4::date) AND a.archived_at IS NULL`,
    [organizationId, input.accountId, requireLegalEntity(context), input.paymentOn],
  );
  return result.rows.map(row => investorProviderPartyReferenceSchema.parse({ provider: dbString(row, "provider"), organizationId, legalEntityId: requireLegalEntity(context), environment: dbString(row, "provider_environment"), realmId: dbString(row, "provider_realm_id"), objectType: dbString(row, "provider_object_type"), objectId: dbString(row, "provider_object_id") }));
}

async function sourceVerificationInput(context: CommandHandlerContext<unknown>, paymentId: string, input: { accountId: string; instrumentId: string; obligationId?: string; amountCents: string; currency: string; kind: InvestorPaymentKind; amounts: InvestorPaymentAmounts; source: InvestorFinancialSourceRequest; paymentOn: string; remittanceInstructionId?: string | null }): Promise<InvestorSourceVerificationInput> {
  const legalEntityId = requireLegalEntity(context);
  const expectedCounterparties = await authorizedCounterparties(context, input);
  if (!expectedCounterparties.length) throw new ValidationCommandError("An active investor or authorized remittance party mapping is required before QBO linkage", { reason: "investor_party_mapping_required" });
  return { scope: { ...context.envelope.scope, legalEntityId }, accountId: input.accountId, instrumentId: input.instrumentId, paymentId, obligationId: input.obligationId, amountCents: input.amountCents, currency: input.currency, kind: input.kind, amounts: input.amounts, source: input.source, expectedCounterparties };
}

async function maybeVerifyPostedSource(context: CommandHandlerContext<unknown>, resolver: InvestorSourceResolver, paymentId: string, input: { accountId: string; instrumentId: string; obligationId?: string; amountCents: string; currency: string; kind: InvestorPaymentKind; amounts: InvestorPaymentAmounts; source?: InvestorFinancialSourceRequest; paymentOn: string; remittanceInstructionId?: string | null }): Promise<InvestorPostedSourceVerification | null> {
  if (!input.source) return null;
  if (input.source.provider !== "qbo") throw new ValidationCommandError("Only verified QBO evidence can mark an investor payment posted", { reason: "investor_posted_source_provider" });
  const verification = await resolver.verifyPostedPayment(await sourceVerificationInput(context, paymentId, { ...input, source: input.source }));
  if (!verification) throw new ValidationCommandError("QBO source could not be verified as an eligible investor cash payment", { reason: "investor_qbo_source_unverified" });
  return verification;
}

async function handleRecordPayment(context: CommandHandlerContext<RecordInvestorPaymentPayload>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.payment.record"].parse(context.envelope.payload);
  const instrument = await assertAccountInstrument(context as unknown as CommandHandlerContext<unknown>, payload.accountId, payload.instrumentId);
  if (instrument.currency !== payload.currency) throw new ValidationCommandError("Investor payment currency does not match the instrument", { reason: "investor_payment_currency" });
  if (payload.kind === "correction") throw new ValidationCommandError("Use the reversal command to correct a payment", { reason: "investor_correction_requires_reversal" });
  const total = assertPositiveAmount(payload.amounts);
  if (payload.remittanceInstructionId) {
    const authorized = await authorizedCounterparties(context as unknown as CommandHandlerContext<unknown>, { accountId: payload.accountId, instrumentId: payload.instrumentId, kind: payload.kind, paymentOn: payload.paymentOn, remittanceInstructionId: payload.remittanceInstructionId });
    if (!authorized.length) throw new ValidationCommandError("Remittance instruction is not active for this account, instrument, entity, and payment date", { reason: "investor_remittance_scope" });
  }
  let obligation: Awaited<ReturnType<typeof loadObligationForPayment>> | null = null;
  let allocated = emptyPaymentAmounts();
  let unapplied = total;
  if (payload.obligationId) {
    obligation = await loadObligationForPayment(context as unknown as CommandHandlerContext<unknown>, payload.obligationId);
    if (obligation.accountId !== payload.accountId || obligation.instrumentId !== payload.instrumentId || obligation.legalEntityId !== instrument.legalEntityId || obligation.currency !== payload.currency) throw new ValidationCommandError("Investor payment obligation is outside the instrument scope", { reason: "investor_payment_obligation_scope" });
    if (payload.contractId !== undefined && payload.contractId !== null && payload.contractId !== obligation.contractId) throw new ValidationCommandError("Investor payment contract does not match its obligation", { reason: "investor_payment_contract_mismatch" });
    const existing = await allocatedForObligation(context as unknown as CommandHandlerContext<unknown>, payload.obligationId);
    allocated = componentCap(payload.amounts, obligation.expected, existing);
    unapplied = total - centsToBigInt(sumPaymentAmounts(allocated));
  }
  const paymentId = newRecordId();
  const resolver = (context as unknown as { sourceResolver?: InvestorSourceResolver }).sourceResolver ?? new FailClosedInvestorSourceResolver();
  const verification = await maybeVerifyPostedSource(context as unknown as CommandHandlerContext<unknown>, resolver, paymentId, { accountId: payload.accountId, instrumentId: payload.instrumentId, obligationId: payload.obligationId ?? undefined, amountCents: centsFromBigInt(total), currency: payload.currency, kind: payload.kind, amounts: payload.amounts, source: payload.source, paymentOn: payload.paymentOn, remittanceInstructionId: payload.remittanceInstructionId ?? null });
  const status = verification ? "qbo_posted" : "manual_recorded";
  await context.executor.query(`INSERT INTO company_investor_payments (id,organization_id,account_id,instrument_id,contract_id,obligation_id,remittance_instruction_id,legal_entity_id,kind,status,method,payment_on,period_month,currency,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,amount_cents,unapplied_cents,correction_reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::bigint,$16::bigint,$17::bigint,$18::bigint,$19::bigint,$20::bigint,$21::bigint,$22::bigint,$23::bigint,$24,$25)`, [paymentId, context.envelope.scope.organizationId, payload.accountId, payload.instrumentId, payload.contractId ?? obligation?.contractId ?? null, payload.obligationId ?? null, payload.remittanceInstructionId ?? null, instrument.legalEntityId, payload.kind, status, verification ? "qbo" : payload.method, payload.paymentOn, payload.periodMonth ?? null, payload.currency, payload.amounts.principalCents, payload.amounts.interestCents, payload.amounts.returnOfCapitalCents, payload.amounts.distributionCents, payload.amounts.feeCents, payload.amounts.balloonCents, payload.amounts.unclassifiedCents, centsFromBigInt(total), centsFromBigInt(unapplied), payload.correctionReason ?? null, context.principal.actorId]);
  if (payload.obligationId && centsToBigInt(sumPaymentAmounts(allocated)) !== BigInt(0)) await context.executor.query(`INSERT INTO company_investor_payment_allocations (organization_id,payment_id,obligation_id,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,allocated_cents) VALUES ($1,$2,$3,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint)`, [context.envelope.scope.organizationId, paymentId, payload.obligationId, allocated.principalCents, allocated.interestCents, allocated.returnOfCapitalCents, allocated.distributionCents, allocated.feeCents, allocated.balloonCents, allocated.unclassifiedCents, sumPaymentAmounts(allocated)]);
  if (verification) await insertSource(context.executor, context.envelope.scope.organizationId, paymentId, verification.source);
  return savedResult([paymentId], [{ id: paymentId, revision: revisionSchema.parse(1) }]);
}

async function loadPayment(context: CommandHandlerContext<unknown>, paymentId: string): Promise<{ id: string; accountId: string; instrumentId: string; contractId: string | null; obligationId: string | null; remittanceInstructionId: string | null; paymentOn: string; periodMonth: string | null; legalEntityId: string; currency: string; amountCents: string; amounts: InvestorPaymentAmounts; kind: InvestorPaymentKind; status: string; method: string; revision: Revision; postedSource: InvestorFinancialSource | null }> {
  const result = await context.executor.query<Record<string, unknown>>(`SELECT account_id,instrument_id,contract_id,obligation_id,remittance_instruction_id,payment_on,period_month,legal_entity_id,currency,amount_cents,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,kind,status,method,record_revision FROM company_investor_payments WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [context.envelope.scope.organizationId, paymentId]);
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Investor payment was not found in the requested company scope", { reason: "investor_payment_not_found" });
  const sources = await context.executor.query<Record<string, unknown>>(`SELECT source_reference FROM company_investor_payment_sources WHERE organization_id=$1 AND payment_id=$2 AND provider='qbo'`, [context.envelope.scope.organizationId, paymentId]);
  let postedSource: InvestorFinancialSource | null = null;
  if (sources.rows[0]) {
    const parsed = typeof sources.rows[0].source_reference === "string" ? JSON.parse(sources.rows[0].source_reference) as unknown : sources.rows[0].source_reference;
    const { investorFinancialSourceSchema } = await import("../../shared/investors");
    postedSource = investorFinancialSourceSchema.parse(parsed);
  }
  return { id: paymentId, accountId: dbString(row, "account_id"), instrumentId: dbString(row, "instrument_id"), contractId: row.contract_id === null || row.contract_id === undefined ? null : dbString(row, "contract_id"), obligationId: row.obligation_id === null || row.obligation_id === undefined ? null : dbString(row, "obligation_id"), remittanceInstructionId: row.remittance_instruction_id === null || row.remittance_instruction_id === undefined ? null : dbString(row, "remittance_instruction_id"), paymentOn: dbDate(row, "payment_on"), periodMonth: row.period_month === null || row.period_month === undefined ? null : dbDate(row, "period_month"), legalEntityId: dbString(row, "legal_entity_id"), currency: dbString(row, "currency"), amountCents: dbCents(row.amount_cents, "amount_cents"), amounts: investorPaymentAmountsSchema.parse({ principalCents: dbCents(row.principal_cents, "principal_cents"), interestCents: dbCents(row.interest_cents, "interest_cents"), returnOfCapitalCents: dbCents(row.return_of_capital_cents, "return_of_capital_cents"), distributionCents: dbCents(row.distribution_cents, "distribution_cents"), feeCents: dbCents(row.fee_cents, "fee_cents"), balloonCents: dbCents(row.balloon_cents, "balloon_cents"), unclassifiedCents: dbCents(row.unclassified_cents, "unclassified_cents") }), kind: dbString(row, "kind") as InvestorPaymentKind, status: dbString(row, "status"), method: dbString(row, "method"), revision: dbRevision(row.record_revision), postedSource };
}

/** A reversed payment is economically void: it cannot gain QBO or settlement evidence. */
async function assertPaymentNotReversed(context: CommandHandlerContext<unknown>, payment: LoadedInvestorPayment): Promise<void> {
  if (payment.status === "reversed") throw new ConflictCommandError("Investor payment is already reversed", { reason: "investor_payment_already_reversed" });
  const existingReversal = await context.executor.query(`SELECT id FROM company_investor_payments WHERE organization_id=$1 AND reverses_payment_id=$2`, [context.envelope.scope.organizationId, payment.id]);
  if (existingReversal.rows.length) throw new ConflictCommandError("Investor payment already has a reversal", { reason: "investor_payment_already_reversed" });
}

async function handleLinkQbo(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.payment.link_qbo"].parse(context.envelope.payload);
  const payment = await loadPayment(context, payload.paymentId);
  assertScopeEntity(context, payment.legalEntityId);
  assertExpectedRevision(payment.revision, context.envelope.expectedRevision);
  if (payment.status !== "manual_recorded" || payment.postedSource !== null) throw new ConflictCommandError("Only an unposted manual investor payment can receive a QBO link", { reason: "investor_payment_already_posted" });
  await assertPaymentNotReversed(context, payment);
  const instrument = await assertAccountInstrument(context as unknown as CommandHandlerContext<unknown>, payment.accountId, payment.instrumentId);
  const resolver = (context as unknown as { sourceResolver?: InvestorSourceResolver }).sourceResolver ?? new FailClosedInvestorSourceResolver();
  const verification = await maybeVerifyPostedSource(context as unknown as CommandHandlerContext<unknown>, resolver, payload.paymentId, { accountId: payment.accountId, instrumentId: payment.instrumentId, obligationId: payment.obligationId ?? undefined, amountCents: payment.amountCents, currency: payment.currency, kind: payment.kind, amounts: payment.amounts, source: payload.source, paymentOn: payment.paymentOn, remittanceInstructionId: payment.remittanceInstructionId });
  if (!verification) throw new ValidationCommandError("QBO source could not be verified", { reason: "investor_qbo_source_unverified" });
  const updated = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_payments SET status='qbo_posted',method='qbo',record_revision=record_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND record_revision=$3 RETURNING record_revision`, [context.envelope.scope.organizationId, payload.paymentId, payment.revision]);
  if (!updated.rows.length) throw new ConflictCommandError("Investor payment changed while it was being linked", { reason: "revision_conflict" });
  await insertSource(context.executor, context.envelope.scope.organizationId, payload.paymentId, verification.source);
  return savedResult([payload.paymentId], [{ id: payload.paymentId, revision: dbRevision(updated.rows[0]!.record_revision) }]);
}

async function handleSettlePayment(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.payment.settle"].parse(context.envelope.payload);
  const payment = await loadPayment(context, payload.paymentId);
  assertScopeEntity(context, payment.legalEntityId);
  assertExpectedRevision(payment.revision, context.envelope.expectedRevision);
  if (payment.status !== "manual_recorded" && payment.status !== "qbo_posted") throw new ConflictCommandError("Only an open or QBO-posted investor payment can receive settlement evidence", { reason: "investor_payment_settlement_state" });
  await assertPaymentNotReversed(context, payment);
  if (payload.source.currency !== payment.currency || centsToBigInt(payload.source.amountCents) < centsToBigInt(payment.amountCents)) throw new ValidationCommandError("Settlement evidence currency or amount does not cover the payment", { reason: "investor_settlement_amount_mismatch" });
  const instrument = await assertAccountInstrument(context as unknown as CommandHandlerContext<unknown>, payment.accountId, payment.instrumentId);
  const resolver = (context as unknown as { sourceResolver?: InvestorSourceResolver }).sourceResolver ?? new FailClosedInvestorSourceResolver();
  const verification = await resolver.verifySettlement(await sourceVerificationInput(context as unknown as CommandHandlerContext<unknown>, payload.paymentId, { accountId: payment.accountId, instrumentId: payment.instrumentId, obligationId: payment.obligationId ?? undefined, amountCents: payment.amountCents, currency: payment.currency, kind: payment.kind, amounts: payment.amounts, source: payload.source, paymentOn: payment.paymentOn, remittanceInstructionId: payment.remittanceInstructionId }));
  if (!verification) throw new ValidationCommandError("Settlement source could not be independently verified", { reason: "investor_settlement_unverified" });
  const updated = await context.executor.query<{ record_revision: number }>(`UPDATE company_investor_payments SET status='bank_settled',record_revision=record_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND record_revision=$3 RETURNING record_revision`, [context.envelope.scope.organizationId, payload.paymentId, payment.revision]);
  if (!updated.rows.length) throw new ConflictCommandError("Investor payment changed while it was being settled", { reason: "revision_conflict" });
  await insertSource(context.executor, context.envelope.scope.organizationId, payload.paymentId, verification.source);
  return savedResult([payload.paymentId], [{ id: payload.paymentId, revision: dbRevision(updated.rows[0]!.record_revision) }]);
}

type LoadedInvestorPayment = Awaited<ReturnType<typeof loadPayment>>;

async function appendPaymentReversal(context: CommandHandlerContext<unknown>, payment: LoadedInvestorPayment, paymentOn: string, reason: string): Promise<string> {
  await assertPaymentNotReversed(context, payment);
  const allocations = await context.executor.query<Record<string, unknown>>(`SELECT obligation_id,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,allocated_cents FROM company_investor_payment_allocations WHERE organization_id=$1 AND payment_id=$2`, [context.envelope.scope.organizationId, payment.id]);
  const reversalId = newRecordId();
  const negative = negatePaymentAmounts(payment.amounts);
  await context.executor.query(`INSERT INTO company_investor_payments (id,organization_id,account_id,instrument_id,contract_id,obligation_id,remittance_instruction_id,legal_entity_id,kind,status,method,payment_on,period_month,currency,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,amount_cents,unapplied_cents,reverses_payment_id,correction_reason,created_by) SELECT $1,organization_id,account_id,instrument_id,contract_id,obligation_id,remittance_instruction_id,legal_entity_id,'correction','reversed',method,$3,period_month,currency,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint,0,$2,$12,$13 FROM company_investor_payments WHERE organization_id=$14 AND id=$2`, [reversalId, payment.id, paymentOn, negative.principalCents, negative.interestCents, negative.returnOfCapitalCents, negative.distributionCents, negative.feeCents, negative.balloonCents, negative.unclassifiedCents, sumPaymentAmounts(negative), reason, context.principal.actorId, context.envelope.scope.organizationId]);
  for (const row of allocations.rows) await context.executor.query(`INSERT INTO company_investor_payment_allocations (organization_id,payment_id,obligation_id,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,allocated_cents) VALUES ($1,$2,$3,($4::bigint)*-1,($5::bigint)*-1,($6::bigint)*-1,($7::bigint)*-1,($8::bigint)*-1,($9::bigint)*-1,($10::bigint)*-1,($11::bigint)*-1)`, [context.envelope.scope.organizationId, reversalId, dbString(row, "obligation_id"), dbCents(row.principal_cents, "principal_cents"), dbCents(row.interest_cents, "interest_cents"), dbCents(row.return_of_capital_cents, "return_of_capital_cents"), dbCents(row.distribution_cents, "distribution_cents"), dbCents(row.fee_cents, "fee_cents"), dbCents(row.balloon_cents, "balloon_cents"), dbCents(row.unclassified_cents, "unclassified_cents"), dbCents(row.allocated_cents, "allocated_cents")]);
  return reversalId;
}

async function handleReversePayment(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.payment.reverse"].parse(context.envelope.payload);
  const payment = await loadPayment(context, payload.paymentId);
  assertScopeEntity(context, payment.legalEntityId);
  assertExpectedRevision(payment.revision, context.envelope.expectedRevision);
  const reversalId = await appendPaymentReversal(context, payment, payload.paymentOn, payload.reason);
  const resolver = (context as unknown as { sourceResolver?: InvestorSourceResolver }).sourceResolver;
  if (payment.postedSource && resolver?.releasePostedPayment) await resolver.releasePostedPayment({ scope: { ...context.envelope.scope, legalEntityId: legalEntityIdSchema.parse(payment.legalEntityId) }, accountId: payment.accountId, instrumentId: payment.instrumentId, paymentId: payload.paymentId, obligationId: payment.obligationId ?? undefined, amountCents: payment.amountCents, currency: payment.currency, kind: payment.kind, amounts: payment.amounts, source: payment.postedSource });
  return savedResult([reversalId], [{ id: reversalId, revision: revisionSchema.parse(1) }]);
}

async function handleEditManualPayment(context: CommandHandlerContext<unknown>): Promise<CommandHandlerResult> {
  const payload = investorCommandPayloadSchemas["investor.payment.edit_manual"].parse(context.envelope.payload);
  const payment = await loadPayment(context, payload.paymentId);
  assertScopeEntity(context, payment.legalEntityId);
  assertExpectedRevision(payment.revision, context.envelope.expectedRevision);
  if (payment.status !== "manual_recorded" || payment.method === "qbo" || payment.postedSource !== null) {
    throw new ConflictCommandError("Only an unverified manual investor payment can be edited", { reason: "investor_manual_edit_state" });
  }
  const existingSources = await context.executor.query(`SELECT provider FROM company_investor_payment_sources WHERE organization_id=$1 AND payment_id=$2`, [context.envelope.scope.organizationId, payment.id]);
  if (existingSources.rows.length) throw new ConflictCommandError("A payment with settlement evidence is immutable; use a new correction workflow", { reason: "investor_manual_edit_has_evidence" });
  if (payload.kind === "correction") throw new ValidationCommandError("Use the reversal command to correct a payment", { reason: "investor_correction_requires_reversal" });

  const instrument = await assertAccountInstrument(context as unknown as CommandHandlerContext<unknown>, payment.accountId, payment.instrumentId);
  const obligationId = payload.obligationId === undefined ? payment.obligationId : payload.obligationId;
  let obligation: Awaited<ReturnType<typeof loadObligationForPayment>> | null = null;
  if (obligationId) {
    obligation = await loadObligationForPayment(context as unknown as CommandHandlerContext<unknown>, obligationId);
    if (obligation.accountId !== payment.accountId || obligation.instrumentId !== payment.instrumentId || obligation.legalEntityId !== instrument.legalEntityId || obligation.currency !== payment.currency) {
      throw new ValidationCommandError("Investor payment obligation is outside the instrument scope", { reason: "investor_payment_obligation_scope" });
    }
  }
  const contractId = payload.contractId === undefined
    ? (obligation?.contractId ?? payment.contractId)
    : payload.contractId ?? obligation?.contractId ?? null;
  if (obligation && contractId !== obligation.contractId) throw new ValidationCommandError("Investor payment contract does not match its obligation", { reason: "investor_payment_contract_mismatch" });
  if (contractId) {
    const contract = await assertContract(context as unknown as CommandHandlerContext<unknown>, contractId, false);
    if (contract.instrumentId !== payment.instrumentId) throw new ValidationCommandError("Investor payment contract does not belong to this instrument", { reason: "investor_payment_contract_scope" });
  }
  if (payment.remittanceInstructionId) {
    const authorized = await authorizedCounterparties(context as unknown as CommandHandlerContext<unknown>, { accountId: payment.accountId, instrumentId: payment.instrumentId, kind: payload.kind, paymentOn: payload.paymentOn, remittanceInstructionId: payment.remittanceInstructionId });
    if (!authorized.length) throw new ValidationCommandError("The existing remittance instruction is not active for the edited payment date", { reason: "investor_remittance_scope" });
  }

  const total = assertPositiveAmount(payload.amounts);
  await appendPaymentReversal(context, payment, payload.paymentOn, payload.reason);
  const allocated = obligation ? componentCap(payload.amounts, obligation.expected, await allocatedForObligation(context as unknown as CommandHandlerContext<unknown>, obligation.id)) : emptyPaymentAmounts();
  const unapplied = total - centsToBigInt(sumPaymentAmounts(allocated));
  const replacementId = newRecordId();
  const periodMonth = payload.periodMonth === undefined ? (obligation?.periodMonth ?? payment.periodMonth) : payload.periodMonth;
  await context.executor.query(
    `INSERT INTO company_investor_payments (id,organization_id,account_id,instrument_id,contract_id,obligation_id,remittance_instruction_id,legal_entity_id,kind,status,method,payment_on,period_month,currency,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,amount_cents,unapplied_cents,correction_reason,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual_recorded',$10,$11,$12,$13,$14::bigint,$15::bigint,$16::bigint,$17::bigint,$18::bigint,$19::bigint,$20::bigint,$21::bigint,$22::bigint,$23,$24)`,
    [replacementId, context.envelope.scope.organizationId, payment.accountId, payment.instrumentId, contractId, obligationId, payment.remittanceInstructionId, payment.legalEntityId, payload.kind, payload.method, payload.paymentOn, periodMonth, payment.currency, payload.amounts.principalCents, payload.amounts.interestCents, payload.amounts.returnOfCapitalCents, payload.amounts.distributionCents, payload.amounts.feeCents, payload.amounts.balloonCents, payload.amounts.unclassifiedCents, centsFromBigInt(total), centsFromBigInt(unapplied), `${payload.reason} (replacement for ${payment.id})`, context.principal.actorId],
  );
  if (obligation && obligationId && centsToBigInt(sumPaymentAmounts(allocated)) !== BigInt(0)) {
    await context.executor.query(`INSERT INTO company_investor_payment_allocations (organization_id,payment_id,obligation_id,principal_cents,interest_cents,return_of_capital_cents,distribution_cents,fee_cents,balloon_cents,unclassified_cents,allocated_cents) VALUES ($1,$2,$3,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint)`, [context.envelope.scope.organizationId, replacementId, obligationId, allocated.principalCents, allocated.interestCents, allocated.returnOfCapitalCents, allocated.distributionCents, allocated.feeCents, allocated.balloonCents, allocated.unclassifiedCents, sumPaymentAmounts(allocated)]);
  }
  return savedResult([replacementId], [{ id: replacementId, revision: revisionSchema.parse(1) }]);
}

const handlers = {
  "investor.account.create": handleCreateAccount,
  "investor.account.update": handleUpdateAccount,
  "investor.account.archive": handleArchiveAccount,
  "investor.instrument.create": handleCreateInstrument,
  "investor.instrument.update": handleUpdateInstrument,
  "investor.instrument.archive": handleArchiveInstrument,
  "investor.contract.create": handleCreateContract,
  "investor.contract.version.create": handleCreateContractVersion,
  "investor.debt.create": handleCreateDebt,
  "investor.debt.update": handleUpdateDebt,
  "investor.obligation.generate": handleGenerateObligations,
  "investor.payment.record": handleRecordPayment,
  "investor.payment.link_qbo": handleLinkQbo,
  "investor.payment.settle": handleSettlePayment,
  "investor.payment.reverse": handleReversePayment,
  "investor.payment.edit_manual": handleEditManualPayment,
  "investor.party_mapping.create": handleCreatePartyMapping,
  "investor.party_mapping.update": handleUpdatePartyMapping,
  "investor.party_mapping.archive": handleArchivePartyMapping,
  "investor.remittance.create": handleCreateRemittance,
  "investor.remittance.update": handleUpdateRemittance,
  "investor.remittance.archive": handleArchiveRemittance,
} as const;

export async function executeInvestorCommand(executor: RentOpsQueryExecutor, kind: InvestorCommandKind, rawEnvelope: unknown, options: InvestorCommandExecutionOptions): Promise<OperationReceipt> {
  const payloadSchema = investorCommandPayloadSchemas[kind];
  let envelope: AnyInvestorCommandEnvelope;
  try {
    envelope = commandEnvelopeSchema(payloadSchema).parse(rawEnvelope) as unknown as AnyInvestorCommandEnvelope;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") throw new ValidationCommandError("Investor command payload failed validation", { reason: "invalid_investor_command_payload" });
    throw error;
  }
  const handler = handlers[kind] as (context: CommandHandlerContext<any>) => Promise<CommandHandlerResult>;
  const handlerWithSource = async (context: CommandHandlerContext<any>): Promise<CommandHandlerResult> => {
    const sourceResolver = options.sourceResolverFactory?.(context.executor) ?? options.sourceResolver ?? new FailClosedInvestorSourceResolver();
    return handler(Object.assign({}, context, { sourceResolver }));
  };
  return runCompanyCommand(executor, { envelope, principal: options.principal, resolvePrincipal: options.resolvePrincipal, transport: options.transport, policy: INVESTOR_COMMAND_POLICIES[kind], handler: handlerWithSource });
}

export const runInvestorCommand = executeInvestorCommand;
