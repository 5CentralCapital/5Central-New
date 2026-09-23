import {
  centsFromBigInt,
  centsToBigInt,
  companyScopeSchema,
  isoDateSchema,
  newRecordId,
  recordReferenceIdSchema,
  type CompanyScope,
  type MoneyCents,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  clearPmSettlementExceptionPayloadSchema,
  createPmSettlementPayloadSchema,
  markPmSettlementExceptionPayloadSchema,
  pmSettlementCommandPayloadSchemas,
  pmSettlementDetailSchema,
  pmSettlementListQuerySchema,
  pmSettlementListResponseSchema,
  pmSettlementSummarySchema,
  PM_SETTLEMENT_REVISIONED_COMMANDS,
  reconcilePmSettlementPayloadSchema,
  updatePmSettlementPayloadSchema,
  type PmGrossToNet,
  type PmSettlementCommandKind,
  type PmSettlementDetail,
  type PmSettlementLineKind,
  type PmSettlementListQuery,
  type PmSettlementListResponse,
  type PmSettlementSummary,
} from "../../shared/accounting/operations";
import { authorizeCompanyRead, type AuthenticatedPrincipal, type CommandAuthorizationPolicy } from "../company/authorization";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { ConflictCommandError, ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { dbCents, dbDate, dbNullableDate, dbNullableString, dbRevision, dbString, dbTimestamp } from "../projects/helpers";
import { ACCOUNTING_READ_ROLES, parseEnvelope, type AccountingCommandAccess } from "./posting-policy";

type Context = CommandHandlerContext<Record<string, unknown>>;

const SETTLEMENT_ROLES = ["owner", "admin", "finance", "operations_pm"] as const;
const RECONCILE_ROLES = ["owner", "admin", "finance"] as const;
const PM_READ_ROLES = [...ACCOUNTING_READ_ROLES, "operations_pm"] as const;

export const PM_SETTLEMENT_COMMAND_POLICIES: Readonly<Record<PmSettlementCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "accounting.pm_settlement.create": { commandKind: "accounting.pm_settlement.create", allowedRoles: SETTLEMENT_ROLES },
  "accounting.pm_settlement.update": { commandKind: "accounting.pm_settlement.update", allowedRoles: SETTLEMENT_ROLES },
  "accounting.pm_settlement.reconcile": { commandKind: "accounting.pm_settlement.reconcile", allowedRoles: RECONCILE_ROLES },
  "accounting.pm_settlement.exception.mark": { commandKind: "accounting.pm_settlement.exception.mark", allowedRoles: SETTLEMENT_ROLES },
  "accounting.pm_settlement.exception.clear": { commandKind: "accounting.pm_settlement.exception.clear", allowedRoles: SETTLEMENT_ROLES },
});

const ZERO = BigInt(0);
const HEADER_BY_KIND: Readonly<Record<PmSettlementLineKind, "gross" | "fees" | "expenses" | "other" | "remittance">> = {
  rent_receipt: "gross", subsidy_receipt: "gross", deposit_receipt: "gross", other_receipt: "gross",
  pm_fee: "fees", pm_expense: "expenses", other_deduction: "other", owner_remittance: "remittance",
};
const HEADER_LABEL = { gross: "gross collections", fees: "PM fees", expenses: "PM expenses", other: "other deductions", remittance: "owner remittance" } as const;

function money(value: bigint): string {
  const negative = value < ZERO;
  const digits = (negative ? -value : value).toString().padStart(3, "0");
  return `${negative ? "-" : ""}$${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${digits.slice(-2)}`;
}

interface SettlementContent {
  readonly managerName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly openingHeldCents: string;
  readonly grossCollectionsCents: string;
  readonly pmFeesCents: string;
  readonly pmExpensesCents: string;
  readonly otherDeductionsCents: string;
  readonly ownerRemittanceCents: string;
  readonly closingHeldCents: string;
  readonly statementDocumentId?: string | null;
  readonly intakePacketId?: string | null;
  readonly qboReferences: readonly unknown[];
  readonly lines: readonly { readonly kind: PmSettlementLineKind; readonly tenancyId?: string | null; readonly unitId?: string | null; readonly description: string; readonly amountCents: string; readonly occurredOn?: string | null; readonly sourcePage?: number | null }[];
}

interface LineTotals { gross: bigint; fees: bigint; expenses: bigint; other: bigint; remittance: bigint; byKind: Record<PmSettlementLineKind, bigint> }

function lineTotals(lines: readonly { readonly kind: PmSettlementLineKind; readonly amountCents: string }[]): LineTotals {
  const byKind = { rent_receipt: ZERO, subsidy_receipt: ZERO, deposit_receipt: ZERO, other_receipt: ZERO, pm_fee: ZERO, pm_expense: ZERO, other_deduction: ZERO, owner_remittance: ZERO } as Record<PmSettlementLineKind, bigint>;
  const totals = { gross: ZERO, fees: ZERO, expenses: ZERO, other: ZERO, remittance: ZERO };
  for (const line of lines) {
    const amount = centsToBigInt(line.amountCents);
    byKind[line.kind] += amount;
    totals[HEADER_BY_KIND[line.kind]] += amount;
  }
  return { ...totals, byKind };
}

/**
 * Lines must add up to each header total by kind, and the header must
 * conserve: opening held + gross collections − fees − expenses − other
 * deductions − owner remittance = closing held.
 */
export function validateSettlementContent(content: SettlementContent): void {
  const totals = lineTotals(content.lines);
  const header = {
    gross: centsToBigInt(content.grossCollectionsCents), fees: centsToBigInt(content.pmFeesCents), expenses: centsToBigInt(content.pmExpensesCents),
    other: centsToBigInt(content.otherDeductionsCents), remittance: centsToBigInt(content.ownerRemittanceCents),
  };
  for (const key of Object.keys(header) as (keyof typeof header)[]) {
    if (header[key] !== totals[key]) {
      throw new ValidationCommandError(`Statement lines for ${HEADER_LABEL[key]} total ${money(totals[key])}, but the header shows ${money(header[key])}`, { reason: "pm_settlement_lines_mismatch", field: key, linesCents: totals[key].toString(), headerCents: header[key].toString() });
    }
  }
  const expectedClosing = centsToBigInt(content.openingHeldCents) + header.gross - header.fees - header.expenses - header.other - header.remittance;
  if (expectedClosing !== centsToBigInt(content.closingHeldCents)) {
    throw new ValidationCommandError(`Opening funds plus collections less costs and remittance is ${money(expectedClosing)}, but the closing held balance is ${money(centsToBigInt(content.closingHeldCents))}`, { reason: "pm_settlement_not_conserved", expectedClosingCents: expectedClosing.toString() });
  }
}

export function grossToNet(input: { readonly openingHeldCents: string; readonly closingHeldCents: string; readonly lines: readonly { readonly kind: PmSettlementLineKind; readonly amountCents: string }[] }): PmGrossToNet {
  const totals = lineTotals(input.lines);
  const k = totals.byKind;
  const cents = (value: bigint) => centsFromBigInt(value);
  const opening = centsToBigInt(input.openingHeldCents);
  const closing = centsToBigInt(input.closingHeldCents);
  return {
    collections: { rentCents: cents(k.rent_receipt), subsidyCents: cents(k.subsidy_receipt), depositCents: cents(k.deposit_receipt), otherCents: cents(k.other_receipt), totalCents: cents(totals.gross) },
    operatingCollectionsCents: cents(k.rent_receipt + k.subsidy_receipt + k.other_receipt),
    costs: { feesCents: cents(totals.fees), expensesCents: cents(totals.expenses), otherDeductionsCents: cents(totals.other), totalCents: cents(totals.fees + totals.expenses + totals.other) },
    remittedCents: cents(totals.remittance),
    openingHeldCents: cents(opening),
    closingHeldCents: cents(closing),
    heldChangeCents: cents(closing - opening),
  };
}

function sourceFingerprint(propertyId: string, content: SettlementContent): string {
  return canonicalJsonSha256({
    propertyId, managerName: content.managerName, periodStart: content.periodStart, periodEnd: content.periodEnd, currency: content.currency,
    openingHeldCents: content.openingHeldCents, grossCollectionsCents: content.grossCollectionsCents, pmFeesCents: content.pmFeesCents,
    pmExpensesCents: content.pmExpensesCents, otherDeductionsCents: content.otherDeductionsCents, ownerRemittanceCents: content.ownerRemittanceCents,
    closingHeldCents: content.closingHeldCents,
    lines: content.lines.map(line => ({ kind: line.kind, tenancyId: line.tenancyId ?? null, unitId: line.unitId ?? null, description: line.description, amountCents: line.amountCents, occurredOn: line.occurredOn ?? null, sourcePage: line.sourcePage ?? null })),
  });
}

interface SettlementRow {
  readonly id: string;
  readonly legalEntityId: string;
  readonly propertyId: string;
  readonly state: "draft" | "reconciled" | "exception";
  readonly recordRevision: Revision;
  readonly periodStart: string;
  readonly ownerRemittanceCents: string;
  readonly bankObservationReference: string | null;
  readonly bankSettledOn: string | null;
  readonly openingHeldCents: string;
  readonly closingHeldCents: string;
}

async function loadForCommand(context: Context, settlementId: string): Promise<SettlementRow> {
  const scope = context.envelope.scope;
  const result = await context.executor.query<Record<string, unknown>>(
    `SELECT id, legal_entity_id, property_id, state, record_revision, period_start, owner_remittance_cents::text AS owner_remittance_cents,
            bank_observation_reference, bank_settled_on, opening_held_cents::text AS opening_held_cents, closing_held_cents::text AS closing_held_cents
       FROM accounting_pm_settlements
      WHERE organization_id = $1 AND id = $2 AND ($3::uuid IS NULL OR legal_entity_id = $3) AND ($4::varchar IS NULL OR property_id = $4)
      FOR UPDATE`,
    [scope.organizationId, settlementId, scope.legalEntityId ?? null, scope.propertyId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("PM settlement was not found in the requested company scope", { reason: "pm_settlement_not_found" });
  const settlement: SettlementRow = {
    id: dbString(row.id, "id"), legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"), propertyId: dbString(row.property_id, "property_id"),
    state: dbString(row.state, "state") as SettlementRow["state"], recordRevision: dbRevision(row.record_revision), periodStart: dbDate(row.period_start, "period_start"),
    ownerRemittanceCents: dbCents(row.owner_remittance_cents, "owner_remittance_cents"), bankObservationReference: dbNullableString(row.bank_observation_reference, "bank_observation_reference"),
    bankSettledOn: dbNullableDate(row.bank_settled_on, "bank_settled_on"), openingHeldCents: dbCents(row.opening_held_cents, "opening_held_cents"), closingHeldCents: dbCents(row.closing_held_cents, "closing_held_cents"),
  };
  const expected = context.envelope.expectedRevision;
  if (expected === undefined) throw new ValidationCommandError("Supply the settlement revision you read before changing it", { reason: "revision_required" });
  if (expected !== settlement.recordRevision) throw new ConflictCommandError("The PM settlement changed since it was read. Reload it before saving again.", { reason: "revision_conflict", expected, actual: settlement.recordRevision });
  return settlement;
}

async function assertPropertyForPeriod(context: Context, legalEntityId: string, propertyId: string, periodStart: string, periodEnd: string, currency: string): Promise<void> {
  const mapped = await context.executor.query(
    `SELECT 1 FROM company_property_entity_periods
      WHERE organization_id = $1 AND legal_entity_id = $2 AND property_id = $3
        AND effective_from <= $5::date AND (effective_until IS NULL OR effective_until > $4::date) LIMIT 1`,
    [context.envelope.scope.organizationId, legalEntityId, propertyId, periodStart, periodEnd],
  );
  if (!mapped.rows.length) throw new ValidationCommandError("The property is not owned by this legal entity during the statement period", { reason: "pm_settlement_property_entity" });
  const entity = await context.executor.query<{ currency: string }>(`SELECT currency FROM company_legal_entities WHERE organization_id = $1 AND id = $2`, [context.envelope.scope.organizationId, legalEntityId]);
  if (entity.rows[0]?.currency !== currency) throw new ValidationCommandError("The statement currency must match the legal entity's currency", { reason: "pm_settlement_currency" });
}

async function assertLineReferences(context: Context, propertyId: string, lines: SettlementContent["lines"]): Promise<void> {
  const units = Array.from(new Set(lines.map(line => line.unitId).filter((value): value is string => Boolean(value))));
  const tenancies = Array.from(new Set(lines.map(line => line.tenancyId).filter((value): value is string => Boolean(value))));
  if (units.length) {
    const found = await context.executor.query<{ id: string }>(`SELECT id FROM rent_ops_units WHERE property_id = $1 AND id = ANY($2::varchar[])`, [propertyId, units]);
    if (found.rows.length !== units.length) throw new ValidationCommandError("A statement line names a unit that is not at this property", { reason: "pm_settlement_unit_property" });
  }
  if (tenancies.length) {
    const found = await context.executor.query<{ id: string }>(`SELECT id FROM rent_ops_tenancies WHERE property_id = $1 AND id = ANY($2::varchar[])`, [propertyId, tenancies]);
    if (found.rows.length !== tenancies.length) throw new ValidationCommandError("A statement line names a tenancy that is not at this property", { reason: "pm_settlement_tenancy_property" });
  }
}

async function insertLines(context: Context, settlementId: string, revision: number, lines: SettlementContent["lines"]): Promise<void> {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    await context.executor.query(
      `INSERT INTO accounting_pm_settlement_lines
        (organization_id, settlement_id, settlement_revision, line_number, kind, tenancy_id, unit_id, description, amount_cents, occurred_on, source_page)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [context.envelope.scope.organizationId, settlementId, revision, index + 1, line.kind, line.tenancyId ?? null, line.unitId ?? null, line.description, line.amountCents, line.occurredOn ?? null, line.sourcePage ?? null],
    );
  }
}

function saved(id: string, revision: Revision, message: string): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [id],
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(id), revision }],
    validationOutcomes: [{ code: "accounting.pm_settlement.saved", severity: "info", message }],
  };
}

async function handleCreate(context: Context): Promise<CommandHandlerResult> {
  const payload = createPmSettlementPayloadSchema.parse(context.envelope.payload);
  const legalEntityId = context.envelope.scope.legalEntityId;
  if (!legalEntityId) throw new ValidationCommandError("Choose the legal entity that owns the property", { reason: "legal_entity_scope_required" });
  if (context.envelope.scope.propertyId !== undefined && context.envelope.scope.propertyId !== payload.propertyId) throw new ForbiddenCommandError("Settlement property is outside the requested scope", { reason: "pm_settlement_property_scope" });
  validateSettlementContent(payload);
  await assertPropertyForPeriod(context, legalEntityId, payload.propertyId, payload.periodStart, payload.periodEnd, payload.currency);
  await assertLineReferences(context, payload.propertyId, payload.lines);
  const duplicate = await context.executor.query(
    `SELECT 1 FROM accounting_pm_settlements WHERE organization_id = $1 AND property_id = $2 AND manager_name = $3 AND period_start = $4 AND period_end = $5`,
    [context.envelope.scope.organizationId, payload.propertyId, payload.managerName, payload.periodStart, payload.periodEnd],
  );
  if (duplicate.rows.length) throw new ConflictCommandError("This manager's statement for the property and period is already recorded", { reason: "pm_settlement_duplicate" });
  const id = newRecordId();
  await context.executor.query(
    `INSERT INTO accounting_pm_settlements
      (id, organization_id, legal_entity_id, property_id, manager_name, period_start, period_end, currency, opening_held_cents, gross_collections_cents,
       pm_fees_cents, pm_expenses_cents, other_deductions_cents, owner_remittance_cents, closing_held_cents, statement_document_id, intake_packet_id,
       qbo_references, state, source_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,'draft',$19)`,
    [id, context.envelope.scope.organizationId, legalEntityId, payload.propertyId, payload.managerName, payload.periodStart, payload.periodEnd, payload.currency,
      payload.openingHeldCents, payload.grossCollectionsCents, payload.pmFeesCents, payload.pmExpensesCents, payload.otherDeductionsCents, payload.ownerRemittanceCents,
      payload.closingHeldCents, payload.statementDocumentId ?? null, payload.intakePacketId ?? null, JSON.stringify(payload.qboReferences), sourceFingerprint(payload.propertyId, payload)],
  );
  await insertLines(context, id, 1, payload.lines);
  return saved(id, dbRevision(1), "PM statement saved in 5Central Ops. Positive owner remittances cannot be reconciled until a verified bank-observation source is available.");
}

async function handleUpdate(context: Context): Promise<CommandHandlerResult> {
  const payload = updatePmSettlementPayloadSchema.parse(context.envelope.payload);
  const current = await loadForCommand(context, payload.settlementId);
  if (current.state === "reconciled") throw new ConflictCommandError("A reconciled statement is locked. Mark it as an exception to reopen it.", { reason: "pm_settlement_reconciled_locked" });
  validateSettlementContent(payload);
  await assertPropertyForPeriod(context, current.legalEntityId, current.propertyId, payload.periodStart, payload.periodEnd, payload.currency);
  await assertLineReferences(context, current.propertyId, payload.lines);
  const updated = await context.executor.query<{ record_revision: number }>(
    `UPDATE accounting_pm_settlements SET manager_name = $3, period_start = $4, period_end = $5, currency = $6, opening_held_cents = $7,
            gross_collections_cents = $8, pm_fees_cents = $9, pm_expenses_cents = $10, other_deductions_cents = $11, owner_remittance_cents = $12,
            closing_held_cents = $13, statement_document_id = $14, intake_packet_id = $15, qbo_references = $16::jsonb, source_fingerprint = $17,
            record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND record_revision = $18 RETURNING record_revision`,
    [context.envelope.scope.organizationId, current.id, payload.managerName, payload.periodStart, payload.periodEnd, payload.currency, payload.openingHeldCents,
      payload.grossCollectionsCents, payload.pmFeesCents, payload.pmExpensesCents, payload.otherDeductionsCents, payload.ownerRemittanceCents, payload.closingHeldCents,
      payload.statementDocumentId ?? null, payload.intakePacketId ?? null, JSON.stringify(payload.qboReferences), sourceFingerprint(current.propertyId, payload), current.recordRevision],
  );
  if (updated.rows.length !== 1) throw new ConflictCommandError("The PM settlement changed while it was being saved", { reason: "revision_conflict" });
  const revision = dbRevision(updated.rows[0]!.record_revision);
  await insertLines(context, current.id, revision, payload.lines);
  return saved(current.id, revision, "PM statement updated in 5Central Ops. Earlier line sets are kept.");
}

async function handleReconcile(context: Context): Promise<CommandHandlerResult> {
  const payload = reconcilePmSettlementPayloadSchema.parse(context.envelope.payload);
  const current = await loadForCommand(context, payload.settlementId);
  if (current.state === "reconciled") throw new ConflictCommandError("This statement is already reconciled", { reason: "pm_settlement_already_reconciled" });
  // This service has no verified bank-observation source. A free-form reference
  // and date are not proof, so positive owner remittances must stay unreconciled.
  if (centsToBigInt(current.ownerRemittanceCents) > ZERO) {
    throw new ValidationCommandError(
      "Bank verification for PM remittances is unavailable. A supplied reference or date does not verify the deposit; this statement cannot be reconciled until verified bank observations are supported.",
      { reason: "pm_settlement_bank_verification_unavailable" },
    );
  }
  // With no owner remittance, no bank event is being reconciled. Ignore legacy
  // optional fields rather than persisting them as if they were verified.
  const bankReference: string | null = null;
  const bankSettledOn: string | null = null;
  const lines = await currentLines(context.executor, context.envelope.scope.organizationId, current.id, current.recordRevision);
  const header = await context.executor.query<Record<string, unknown>>(
    `SELECT gross_collections_cents::text AS gross, pm_fees_cents::text AS fees, pm_expenses_cents::text AS expenses, other_deductions_cents::text AS other
       FROM accounting_pm_settlements WHERE organization_id = $1 AND id = $2`,
    [context.envelope.scope.organizationId, current.id],
  );
  const h = header.rows[0]!;
  validateSettlementContent({
    managerName: "-", periodStart: current.periodStart, periodEnd: current.periodStart, currency: "USD", qboReferences: [], lines,
    openingHeldCents: current.openingHeldCents, closingHeldCents: current.closingHeldCents, ownerRemittanceCents: current.ownerRemittanceCents,
    grossCollectionsCents: dbCents(h.gross, "gross"), pmFeesCents: dbCents(h.fees, "fees"), pmExpensesCents: dbCents(h.expenses, "expenses"), otherDeductionsCents: dbCents(h.other, "other"),
  });
  const updated = await context.executor.query<{ record_revision: number }>(
    `UPDATE accounting_pm_settlements SET state = 'reconciled', exception_reason = NULL, bank_observation_reference = $3, bank_settled_on = $4,
            record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND record_revision = $5 RETURNING record_revision`,
    [context.envelope.scope.organizationId, current.id, bankReference ?? null, bankSettledOn ?? null, current.recordRevision],
  );
  if (updated.rows.length !== 1) throw new ConflictCommandError("The PM settlement changed while it was being saved", { reason: "revision_conflict" });
  // Lines stay under the revision they were entered with; the header revision moves on.
  await copyLines(context, current.id, current.recordRevision, dbRevision(updated.rows[0]!.record_revision));
  return saved(current.id, dbRevision(updated.rows[0]!.record_revision), "PM statement totals reconciled in 5Central Ops; no owner remittance was due. Nothing was posted to QuickBooks.");
}

async function handleMarkException(context: Context): Promise<CommandHandlerResult> {
  const payload = markPmSettlementExceptionPayloadSchema.parse(context.envelope.payload);
  const current = await loadForCommand(context, payload.settlementId);
  const updated = await context.executor.query<{ record_revision: number }>(
    `UPDATE accounting_pm_settlements SET state = 'exception', exception_reason = $3, record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND record_revision = $4 RETURNING record_revision`,
    [context.envelope.scope.organizationId, current.id, payload.reason, current.recordRevision],
  );
  if (updated.rows.length !== 1) throw new ConflictCommandError("The PM settlement changed while it was being saved", { reason: "revision_conflict" });
  await copyLines(context, current.id, current.recordRevision, dbRevision(updated.rows[0]!.record_revision));
  return saved(current.id, dbRevision(updated.rows[0]!.record_revision), "PM statement marked as an exception.");
}

async function handleClearException(context: Context): Promise<CommandHandlerResult> {
  const payload = clearPmSettlementExceptionPayloadSchema.parse(context.envelope.payload);
  const current = await loadForCommand(context, payload.settlementId);
  if (current.state !== "exception") throw new ConflictCommandError("Only a statement marked as an exception can be cleared", { reason: "pm_settlement_not_exception" });
  const updated = await context.executor.query<{ record_revision: number }>(
    `UPDATE accounting_pm_settlements SET state = 'draft', exception_reason = NULL, record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND record_revision = $3 RETURNING record_revision`,
    [context.envelope.scope.organizationId, current.id, current.recordRevision],
  );
  if (updated.rows.length !== 1) throw new ConflictCommandError("The PM settlement changed while it was being saved", { reason: "revision_conflict" });
  await copyLines(context, current.id, current.recordRevision, dbRevision(updated.rows[0]!.record_revision));
  return saved(current.id, dbRevision(updated.rows[0]!.record_revision), "PM statement returned to draft.");
}

/** State-only changes carry the unchanged line set forward to the new header revision. */
async function copyLines(context: Context, settlementId: string, from: number, to: number): Promise<void> {
  await context.executor.query(
    `INSERT INTO accounting_pm_settlement_lines
      (organization_id, settlement_id, settlement_revision, line_number, kind, tenancy_id, unit_id, description, amount_cents, occurred_on, source_page)
     SELECT organization_id, settlement_id, $4, line_number, kind, tenancy_id, unit_id, description, amount_cents, occurred_on, source_page
       FROM accounting_pm_settlement_lines WHERE organization_id = $1 AND settlement_id = $2 AND settlement_revision = $3`,
    [context.envelope.scope.organizationId, settlementId, from, to],
  );
}

async function currentLines(executor: RentOpsQueryExecutor, organizationId: string, settlementId: string, revision: number) {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT line_number, kind, tenancy_id, unit_id, description, amount_cents::text AS amount_cents, occurred_on, source_page
       FROM accounting_pm_settlement_lines WHERE organization_id = $1 AND settlement_id = $2 AND settlement_revision = $3 ORDER BY line_number`,
    [organizationId, settlementId, revision],
  );
  return result.rows.map(row => ({
    lineNumber: Number(row.line_number),
    kind: dbString(row.kind, "kind") as PmSettlementLineKind,
    tenancyId: dbNullableString(row.tenancy_id, "tenancy_id"),
    unitId: dbNullableString(row.unit_id, "unit_id"),
    description: dbString(row.description, "description"),
    amountCents: dbCents(row.amount_cents, "amount_cents"),
    occurredOn: dbNullableDate(row.occurred_on, "occurred_on"),
    sourcePage: row.source_page === null || row.source_page === undefined ? null : Number(row.source_page),
  }));
}

const handlers: Record<PmSettlementCommandKind, (context: Context) => Promise<CommandHandlerResult>> = {
  "accounting.pm_settlement.create": handleCreate,
  "accounting.pm_settlement.update": handleUpdate,
  "accounting.pm_settlement.reconcile": handleReconcile,
  "accounting.pm_settlement.exception.mark": handleMarkException,
  "accounting.pm_settlement.exception.clear": handleClearException,
};

export async function executePmSettlementCommand(executor: RentOpsQueryExecutor, kind: PmSettlementCommandKind, rawEnvelope: unknown, access: AccountingCommandAccess): Promise<OperationReceipt> {
  const handler = handlers[kind];
  if (!handler) throw new ValidationCommandError("Unknown PM settlement command", { reason: "unknown_command" });
  const envelope = parseEnvelope(pmSettlementCommandPayloadSchemas[kind], rawEnvelope, "PM settlement");
  if (PM_SETTLEMENT_REVISIONED_COMMANDS.includes(kind) && envelope.expectedRevision === undefined) throw new ValidationCommandError("Supply the settlement revision you read before changing it", { reason: "revision_required" });
  return runCompanyCommand(executor, { envelope, principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport, policy: PM_SETTLEMENT_COMMAND_POLICIES[kind], handler });
}

/* ── Read model ─────────────────────────────────────────────────────── */

const summarySelect = `
  SELECT s.id, s.legal_entity_id, s.property_id, p.name AS property_name, s.manager_name, s.period_start, s.period_end, s.currency, s.state,
         s.exception_reason, s.gross_collections_cents::text AS gross_collections_cents,
         (s.pm_fees_cents + s.pm_expenses_cents + s.other_deductions_cents)::text AS pm_costs_cents,
         s.owner_remittance_cents::text AS owner_remittance_cents, s.closing_held_cents::text AS closing_held_cents,
         s.opening_held_cents::text AS opening_held_cents, s.pm_fees_cents::text AS pm_fees_cents, s.pm_expenses_cents::text AS pm_expenses_cents,
         s.other_deductions_cents::text AS other_deductions_cents, s.statement_document_id, s.intake_packet_id, s.bank_observation_reference,
         s.bank_settled_on, s.qbo_references, s.source_fingerprint, s.record_revision, s.updated_at
    FROM accounting_pm_settlements s
    JOIN rent_ops_properties p ON p.id = s.property_id`;

function mapSummary(row: Record<string, unknown>): PmSettlementSummary {
  return pmSettlementSummarySchema.parse({
    id: dbString(row.id, "id"), legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"), propertyId: dbString(row.property_id, "property_id"),
    propertyName: dbNullableString(row.property_name, "property_name"), managerName: dbString(row.manager_name, "manager_name"),
    periodStart: dbDate(row.period_start, "period_start"), periodEnd: dbDate(row.period_end, "period_end"), currency: dbString(row.currency, "currency"),
    state: dbString(row.state, "state"), exceptionReason: dbNullableString(row.exception_reason, "exception_reason"),
    grossCollectionsCents: dbCents(row.gross_collections_cents, "gross"), pmCostsCents: dbCents(row.pm_costs_cents, "costs"),
    ownerRemittanceCents: dbCents(row.owner_remittance_cents, "remittance"), closingHeldCents: dbCents(row.closing_held_cents, "closing"),
    bankSettledOn: dbNullableDate(row.bank_settled_on, "bank_settled_on"), recordRevision: dbRevision(row.record_revision), updatedAt: dbTimestamp(row.updated_at, "updated_at"),
  });
}

interface ListCursor { readonly periodEnd: string; readonly id: string }

function encodeCursor(cursor: ListCursor): string { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }
function decodeCursor(value: string): ListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return { periodEnd: isoDateSchema.parse(parsed.periodEnd), id: recordReferenceIdSchema.parse(parsed.id) };
  } catch {
    throw new ValidationCommandError("PM settlement cursor is invalid", { reason: "invalid_cursor" });
  }
}

export async function listPmSettlements(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: PmSettlementListQuery): Promise<PmSettlementListResponse> {
  const query = pmSettlementListQuerySchema.parse(input);
  const scope = companyScopeSchema.parse({ organizationId: query.organizationId, legalEntityId: query.legalEntityId, propertyId: query.propertyId });
  authorizeCompanyRead(principal, scope, PM_READ_ROLES);
  const values: unknown[] = [query.organizationId];
  const where = ["s.organization_id = $1"];
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.legalEntityId) where.push(`s.legal_entity_id = ${add(query.legalEntityId)}`);
  if (query.propertyId) where.push(`s.property_id = ${add(query.propertyId)}`);
  if (query.states) where.push(`s.state = ANY(${add([...query.states])}::text[])`);
  if (query.periodFrom) where.push(`s.period_end >= ${add(query.periodFrom)}::date`);
  if (query.periodThrough) where.push(`s.period_start <= ${add(query.periodThrough)}::date`);
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.push(`(s.period_end, s.id) < (${add(cursor.periodEnd)}::date, ${add(cursor.id)}::uuid)`);
  }
  const limit = add(query.limit + 1);
  const result = await executor.query<Record<string, unknown>>(`${summarySelect} WHERE ${where.join(" AND ")} ORDER BY s.period_end DESC, s.id DESC LIMIT ${limit}`, values);
  const items = result.rows.slice(0, query.limit).map(mapSummary);
  const last = items.at(-1);
  return pmSettlementListResponseSchema.parse({ items, nextCursor: result.rows.length > query.limit && last ? encodeCursor({ periodEnd: last.periodEnd, id: last.id }) : null });
}

export async function getPmSettlement(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, input: { readonly scope: CompanyScope; readonly settlementId: string }): Promise<PmSettlementDetail> {
  const scope = companyScopeSchema.parse(input.scope);
  authorizeCompanyRead(principal, scope, PM_READ_ROLES);
  const result = await executor.query<Record<string, unknown>>(
    `${summarySelect} WHERE s.organization_id = $1 AND s.id = $2 AND ($3::uuid IS NULL OR s.legal_entity_id = $3) AND ($4::varchar IS NULL OR s.property_id = $4)`,
    [scope.organizationId, recordReferenceIdSchema.parse(input.settlementId), scope.legalEntityId ?? null, scope.propertyId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("PM settlement was not found in the requested company scope", { reason: "pm_settlement_not_found" });
  // The settlement's own entity/property grant must also cover it.
  authorizeCompanyRead(principal, { organizationId: scope.organizationId, legalEntityId: dbString(row.legal_entity_id, "legal_entity_id") as never, propertyId: dbString(row.property_id, "property_id") as never }, PM_READ_ROLES);
  const summary = mapSummary(row);
  const lines = await currentLines(executor, scope.organizationId, summary.id, summary.recordRevision);
  const opening = dbCents(row.opening_held_cents, "opening");
  const header = { fees: dbCents(row.pm_fees_cents, "fees"), expenses: dbCents(row.pm_expenses_cents, "expenses"), other: dbCents(row.other_deductions_cents, "other") };
  const report = grossToNet({ openingHeldCents: opening, closingHeldCents: summary.closingHeldCents, lines });
  const differences: { code: string; label: string; amountCents: MoneyCents | null }[] = [];
  const diff = (code: string, label: string, headerValue: string, lineValue: string) => {
    const delta = centsToBigInt(headerValue) - centsToBigInt(lineValue);
    if (delta !== ZERO) differences.push({ code, label, amountCents: centsFromBigInt(delta) });
  };
  diff("lines_vs_header.gross_collections", "Gross collections differ from statement lines", summary.grossCollectionsCents, report.collections.totalCents);
  diff("lines_vs_header.pm_fees", "PM fees differ from statement lines", header.fees, report.costs.feesCents);
  diff("lines_vs_header.pm_expenses", "PM expenses differ from statement lines", header.expenses, report.costs.expensesCents);
  diff("lines_vs_header.other_deductions", "Other deductions differ from statement lines", header.other, report.costs.otherDeductionsCents);
  diff("lines_vs_header.owner_remittance", "Owner remittance differs from statement lines", summary.ownerRemittanceCents, report.remittedCents);
  const conservation = centsToBigInt(opening) + centsToBigInt(summary.grossCollectionsCents) - centsToBigInt(summary.pmCostsCents) - centsToBigInt(summary.ownerRemittanceCents) - centsToBigInt(summary.closingHeldCents);
  if (conservation !== ZERO) differences.push({ code: "held_funds_not_conserved", label: "Held funds do not roll forward", amountCents: centsFromBigInt(conservation) });
  if (centsToBigInt(summary.ownerRemittanceCents) > ZERO && !summary.bankSettledOn) differences.push({ code: "remittance_not_bank_settled", label: "Remittance not matched to a bank deposit", amountCents: summary.ownerRemittanceCents });
  const references = typeof row.qbo_references === "string" ? JSON.parse(row.qbo_references) : row.qbo_references;
  return pmSettlementDetailSchema.parse({
    ...summary,
    openingHeldCents: opening, pmFeesCents: header.fees, pmExpensesCents: header.expenses, otherDeductionsCents: header.other,
    statementDocumentId: dbNullableString(row.statement_document_id, "statement_document_id"), intakePacketId: dbNullableString(row.intake_packet_id, "intake_packet_id"),
    bankObservationReference: dbNullableString(row.bank_observation_reference, "bank_observation_reference"), qboReferences: Array.isArray(references) ? references : [],
    sourceFingerprint: dbString(row.source_fingerprint, "source_fingerprint"), lines, grossToNet: report, differences,
  });
}
