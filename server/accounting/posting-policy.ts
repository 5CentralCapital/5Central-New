import {
  commandEnvelopeSchema,
  newRecordId,
  recordReferenceIdSchema,
  type CommandEnvelope,
  type CompanyScope,
  type OperationReceipt,
  type Revision,
} from "../../shared/company";
import {
  closeRentalPostingPolicyPayloadSchema,
  rentalPostingCommandPayloadSchemas,
  rentalPostingPolicySchema,
  setRentalPostingPolicyPayloadSchema,
  type RentalPostingCommandKind,
  type RentalPostingMethod,
  type RentalPostingPolicy,
} from "../../shared/accounting/operations";
import { authorizeCompanyRead, type AuthenticatedPrincipal, type CommandAuthorizationPolicy, type TransportAttestation } from "../company/authorization";
import { ConflictCommandError, ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { dbDate, dbNullableDate, dbNullableString, dbRevision, dbString, dbTimestamp } from "../projects/helpers";

type Context = CommandHandlerContext<Record<string, unknown>>;

export interface AccountingCommandAccess {
  readonly principal: AuthenticatedPrincipal;
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
}

export const ACCOUNTING_READ_ROLES = ["owner", "admin", "finance", "read_only_reviewer"] as const;
const POLICY_ROLES = ["owner", "admin", "finance"] as const;

export const RENTAL_POSTING_COMMAND_POLICIES: Readonly<Record<RentalPostingCommandKind, CommandAuthorizationPolicy>> = Object.freeze({
  "accounting.rental_posting_policy.set": { commandKind: "accounting.rental_posting_policy.set", allowedRoles: POLICY_ROLES, requiredScope: "legal_entity" },
  "accounting.rental_posting_policy.close": { commandKind: "accounting.rental_posting_policy.close", allowedRoles: POLICY_ROLES, requiredScope: "legal_entity" },
});

const columns = `id, legal_entity_id, method, effective_from, effective_until, cutoff_date, opening_balance_bridge_reference,
  invoice_delivery_verified, approved_by, approved_at, reason, record_revision`;

function mapPolicy(row: Record<string, unknown>): RentalPostingPolicy {
  return rentalPostingPolicySchema.parse({
    id: dbString(row.id, "id"),
    legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"),
    method: dbString(row.method, "method"),
    effectiveFrom: dbDate(row.effective_from, "effective_from"),
    effectiveUntil: dbNullableDate(row.effective_until, "effective_until"),
    cutoffDate: dbDate(row.cutoff_date, "cutoff_date"),
    openingBalanceBridgeReference: dbNullableString(row.opening_balance_bridge_reference, "opening_balance_bridge_reference"),
    invoiceDeliveryVerified: row.invoice_delivery_verified === true,
    approvedBy: dbString(row.approved_by, "approved_by"),
    approvedAt: dbTimestamp(row.approved_at, "approved_at"),
    reason: dbString(row.reason, "reason"),
    recordRevision: dbRevision(row.record_revision),
  });
}

/** The single policy in force for an entity on a date, or null. */
export async function rentalPostingMethodFor(executor: RentOpsQueryExecutor, input: { readonly organizationId: string; readonly legalEntityId: string; readonly date: string }): Promise<RentalPostingPolicy | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${columns} FROM accounting_rental_posting_policies
      WHERE organization_id = $1 AND legal_entity_id = $2 AND effective_from <= $3::date
        AND (effective_until IS NULL OR effective_until > $3::date)
      ORDER BY effective_from DESC LIMIT 2`,
    [input.organizationId, input.legalEntityId, input.date],
  );
  if (result.rows.length > 1) throw new ConflictCommandError("More than one rental posting policy covers this date", { reason: "rental_posting_policy_overlap" });
  return result.rows[0] ? mapPolicy(result.rows[0]) : null;
}

/**
 * Posting code calls this before preparing any rental accounting entry. It
 * refuses when no policy is set, when the entry uses a different method than
 * the entity's policy (never both methods for the same activity), and for
 * activity before the policy's cutoff, which belongs to the opening bridge.
 */
export async function assertRentalPostingMethod(executor: RentOpsQueryExecutor, input: { readonly organizationId: string; readonly legalEntityId: string; readonly activityDate: string; readonly method: Exclude<RentalPostingMethod, "not_posted"> }): Promise<RentalPostingPolicy> {
  const policy = await rentalPostingMethodFor(executor, { organizationId: input.organizationId, legalEntityId: input.legalEntityId, date: input.activityDate });
  if (!policy) throw new ConflictCommandError("Set the rental accounting method for this entity and date before posting", { reason: "rental_posting_policy_missing" });
  if (policy.method !== input.method) {
    throw new ConflictCommandError(policy.method === "not_posted"
      ? "Rental activity for this entity and date is not posted to QuickBooks"
      : `Rental activity for this entity posts through ${policy.method === "native_receivables" ? "native QuickBooks receivables" : "the summary bridge"}; posting it another way would double count`, { reason: "rental_posting_method_conflict", method: policy.method });
  }
  if (input.activityDate < policy.cutoffDate) throw new ConflictCommandError("Activity before the policy cutoff belongs to the opening balance bridge", { reason: "rental_posting_before_cutoff", cutoffDate: policy.cutoffDate });
  return policy;
}

export async function listRentalPostingPolicies(executor: RentOpsQueryExecutor, principal: AuthenticatedPrincipal, scope: CompanyScope & { readonly legalEntityId: string }): Promise<{ readonly items: readonly RentalPostingPolicy[] }> {
  authorizeCompanyRead(principal, scope, ACCOUNTING_READ_ROLES);
  const result = await executor.query<Record<string, unknown>>(
    `SELECT ${columns} FROM accounting_rental_posting_policies WHERE organization_id = $1 AND legal_entity_id = $2 ORDER BY effective_from DESC, id LIMIT 200`,
    [scope.organizationId, scope.legalEntityId],
  );
  return { items: result.rows.map(mapPolicy) };
}

function saved(id: string, revision: Revision): CommandHandlerResult {
  return {
    state: "saved_in_rops",
    affectedRecordIds: [id],
    resultingRevisions: [{ recordId: recordReferenceIdSchema.parse(id), revision }],
    validationOutcomes: [{ code: "accounting.rental_posting_policy.saved", severity: "info", message: "Rental accounting method saved in 5Central Ops. Nothing was posted to QuickBooks." }],
  };
}

function entityOf(context: Context): string {
  const legalEntityId = context.envelope.scope.legalEntityId;
  if (!legalEntityId) throw new ValidationCommandError("Choose the legal entity for this rental accounting method", { reason: "legal_entity_scope_required" });
  if (context.envelope.scope.propertyId !== undefined) throw new ForbiddenCommandError("Rental accounting methods apply to a whole legal entity", { reason: "posting_policy_entity_scope" });
  return legalEntityId;
}

async function handleSet(context: Context): Promise<CommandHandlerResult> {
  const payload = setRentalPostingPolicyPayloadSchema.parse(context.envelope.payload);
  const organizationId = context.envelope.scope.organizationId;
  const legalEntityId = entityOf(context);
  const entity = await context.executor.query(`SELECT 1 FROM company_legal_entities WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`, [organizationId, legalEntityId]);
  if (!entity.rows.length) throw new ValidationCommandError("Legal entity was not found in this company", { reason: "legal_entity_not_found" });
  const until = payload.effectiveUntil ?? null;
  const overlap = await context.executor.query<{ id: string; effective_from: unknown }>(
    `SELECT id, effective_from FROM accounting_rental_posting_policies
      WHERE organization_id = $1 AND legal_entity_id = $2
        AND effective_from < COALESCE($4::date, 'infinity'::date) AND $3::date < COALESCE(effective_until, 'infinity'::date)
      LIMIT 1`,
    [organizationId, legalEntityId, payload.effectiveFrom, until],
  );
  if (overlap.rows.length) {
    throw new ConflictCommandError("Another rental accounting method already covers part of this period. Close it first, then set the new method from its end date.", { reason: "rental_posting_policy_overlap" });
  }
  const previous = await context.executor.query<{ method: RentalPostingMethod }>(
    `SELECT method FROM accounting_rental_posting_policies
      WHERE organization_id = $1 AND legal_entity_id = $2 AND effective_from < $3::date
      ORDER BY effective_from DESC LIMIT 1`,
    [organizationId, legalEntityId, payload.effectiveFrom],
  );
  const prior = previous.rows[0]?.method;
  if (prior && prior !== payload.method && payload.method !== "not_posted" && !payload.openingBalanceBridgeReference) {
    throw new ValidationCommandError("Changing the rental accounting method needs an opening balance bridge reference", { reason: "opening_balance_bridge_required", previousMethod: prior });
  }
  const id = newRecordId();
  const inserted = await context.executor.query<{ record_revision: number }>(
    `INSERT INTO accounting_rental_posting_policies
      (id, organization_id, legal_entity_id, method, effective_from, effective_until, cutoff_date, opening_balance_bridge_reference,
       invoice_delivery_verified, approved_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING record_revision`,
    [id, organizationId, legalEntityId, payload.method, payload.effectiveFrom, until, payload.cutoffDate, payload.openingBalanceBridgeReference ?? null,
      payload.invoiceDeliveryVerified, context.principal.actorId, payload.reason],
  );
  return saved(id, dbRevision(inserted.rows[0]?.record_revision ?? 1));
}

async function handleClose(context: Context): Promise<CommandHandlerResult> {
  const payload = closeRentalPostingPolicyPayloadSchema.parse(context.envelope.payload);
  const organizationId = context.envelope.scope.organizationId;
  const legalEntityId = entityOf(context);
  const current = await context.executor.query<Record<string, unknown>>(
    `SELECT ${columns} FROM accounting_rental_posting_policies WHERE organization_id = $1 AND legal_entity_id = $2 AND id = $3 FOR UPDATE`,
    [organizationId, legalEntityId, payload.policyId],
  );
  const row = current.rows[0];
  if (!row) throw new ValidationCommandError("Rental accounting method was not found for this entity", { reason: "rental_posting_policy_not_found" });
  const policy = mapPolicy(row);
  const expected = context.envelope.expectedRevision;
  if (expected === undefined) throw new ValidationCommandError("Supply the policy revision you read before closing it", { reason: "revision_required" });
  if (expected !== policy.recordRevision) throw new ConflictCommandError("The rental accounting method changed since it was read", { reason: "revision_conflict", expected, actual: policy.recordRevision });
  if (payload.effectiveUntil <= policy.effectiveFrom) throw new ValidationCommandError("The end date must be after the method's start date", { reason: "posting_policy_end_before_start" });
  if (policy.effectiveUntil !== null && payload.effectiveUntil >= policy.effectiveUntil) throw new ValidationCommandError("A method can only be closed earlier than its current end date", { reason: "posting_policy_end_not_earlier" });
  const reason = `${policy.reason} — Closed ${payload.effectiveUntil}: ${payload.reason}`.slice(0, 1000);
  const updated = await context.executor.query<{ record_revision: number }>(
    `UPDATE accounting_rental_posting_policies SET effective_until = $4, reason = $5, record_revision = record_revision + 1, updated_at = now()
      WHERE organization_id = $1 AND legal_entity_id = $2 AND id = $3 AND record_revision = $6 RETURNING record_revision`,
    [organizationId, legalEntityId, policy.id, payload.effectiveUntil, reason, policy.recordRevision],
  );
  if (updated.rows.length !== 1) throw new ConflictCommandError("The rental accounting method changed while it was being saved", { reason: "revision_conflict" });
  return saved(policy.id, dbRevision(updated.rows[0]!.record_revision));
}

const handlers: Record<RentalPostingCommandKind, (context: Context) => Promise<CommandHandlerResult>> = {
  "accounting.rental_posting_policy.set": handleSet,
  "accounting.rental_posting_policy.close": handleClose,
};

export async function executeRentalPostingCommand(executor: RentOpsQueryExecutor, kind: RentalPostingCommandKind, rawEnvelope: unknown, access: AccountingCommandAccess): Promise<OperationReceipt> {
  const handler = handlers[kind];
  if (!handler) throw new ValidationCommandError("Unknown rental posting command", { reason: "unknown_command" });
  const envelope = parseEnvelope(rentalPostingCommandPayloadSchemas[kind], rawEnvelope, "Rental accounting method");
  return runCompanyCommand(executor, { envelope, principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport, policy: RENTAL_POSTING_COMMAND_POLICIES[kind], handler });
}

/** Parse an envelope and turn schema failures into a specific validation message. */
export function parseEnvelope(schema: Parameters<typeof commandEnvelopeSchema>[0], rawEnvelope: unknown, label: string): CommandEnvelope<Record<string, unknown>> {
  const result = commandEnvelopeSchema(schema).safeParse(rawEnvelope);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationCommandError(issue ? `${label} ${issue.path.join(".") || "command"}: ${issue.message}` : `${label} command failed validation`, { reason: "invalid_command_payload" });
  }
  return result.data as unknown as CommandEnvelope<Record<string, unknown>>;
}
