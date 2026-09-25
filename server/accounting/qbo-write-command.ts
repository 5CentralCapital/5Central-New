import { createHash } from "node:crypto";
import { recordReferenceIdSchema, type OperationReceipt } from "../../shared/company";
import type { QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { QBO_WRITE_SUBMIT_COMMAND_KIND, submitQboWritePayloadSchema } from "../../shared/accounting/operations";
import type { CommandAuthorizationPolicy } from "../company/authorization";
import { ConflictCommandError, ForbiddenCommandError, ValidationCommandError } from "../company/commands/errors";
import { runCompanyCommand, type CommandHandlerContext, type CommandHandlerResult } from "../company/commands/runner";
import { PostgresJobQueue } from "../jobs/queue";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import { assertRentalPostingMethod, parseEnvelope, type AccountingCommandAccess } from "./posting-policy";
import { assertQboWriteFields, qboWriteHeldReason, type QboWritePolicy, type QboWriteRequest } from "./qbo-write";
import { qboScopeKeyPart, QBO_WRITE_TOPIC } from "./webhook-ingest";

/** Posting to the books is limited to owners and administrators. */
export const QBO_WRITE_SUBMIT_POLICY: CommandAuthorizationPolicy = Object.freeze({
  commandKind: QBO_WRITE_SUBMIT_COMMAND_KIND,
  allowedRoles: ["owner", "admin"] as const,
  requiredScope: "legal_entity" as const,
});

/** The write journal's operation key: one QuickBooks write per command operation. */
export function qboWriteOperationKey(operationId: string): string {
  return `cmd:${operationId}`;
}

/** Stable job key: the same operation always maps to the same job. */
export function qboWriteJobKey(scope: { readonly organizationId: string; readonly legalEntityId: string; readonly environment: string; readonly realmId: string }, operationKey: string): string {
  return `qbo.write:${createHash("sha256").update(qboScopeKeyPart(scope as never)).digest("hex").slice(0, 24)}:${operationKey}`;
}

type Context = CommandHandlerContext<Record<string, unknown>>;

function handler(writePolicy: QboWritePolicy) {
  return async (context: Context): Promise<CommandHandlerResult> => {
    const payload = submitQboWritePayloadSchema.parse(context.envelope.payload);
    const legalEntityId = context.envelope.scope.legalEntityId;
    if (!legalEntityId) throw new ValidationCommandError("Choose the legal entity whose QuickBooks company receives this write", { reason: "legal_entity_scope_required" });
    if (context.envelope.scope.propertyId !== undefined) throw new ForbiddenCommandError("QuickBooks writes apply to a whole legal entity", { reason: "qbo_write_entity_scope" });
    const scope = { organizationId: context.envelope.scope.organizationId, legalEntityId, environment: payload.environment, realmId: payload.realmId };
    const operationKey = qboWriteOperationKey(context.envelope.operationId);
    const request: QboWriteRequest = {
      scope, operationKey, entity: payload.entity, operation: payload.operation, fields: payload.fields as QuickBooksJsonObject,
      ...(payload.entityId ? { entityId: payload.entityId } : {}),
      ...(payload.syncToken ? { syncToken: payload.syncToken } : {}),
      ...(payload.rentalPosting ? { rentalPosting: payload.rentalPosting } : {}),
    };
    const held = qboWriteHeldReason(request, writePolicy);
    if (held) throw new ConflictCommandError(held, { reason: "qbo_write_held" });
    try {
      assertQboWriteFields(request);
    } catch (error) {
      if (error instanceof AccountingError) throw new ValidationCommandError(error.message, { reason: "qbo_write_invalid" });
      throw error;
    }
    if (request.rentalPosting) {
      // Throws a conflict when the entity's policy does not allow exactly this method on this date.
      await assertRentalPostingMethod(context.executor, { organizationId: scope.organizationId, legalEntityId, activityDate: request.rentalPosting.activityDate, method: request.rentalPosting.method });
    }
    const connection = await context.executor.query<{ status: string }>(
      `SELECT status FROM accounting_qbo_connections WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4`,
      [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId],
    );
    const status = connection.rows[0]?.status;
    if (!status) throw new ValidationCommandError("QuickBooks is not connected for this legal entity", { reason: "qbo_connection_missing" });
    if (status !== "active") throw new ConflictCommandError("QuickBooks needs to be reconnected before it can receive writes", { reason: "qbo_needs_reconnect" });

    const queue = new PostgresJobQueue(context.executor);
    const result = await queue.enqueue({
      jobKey: qboWriteJobKey(scope, operationKey),
      topic: QBO_WRITE_TOPIC,
      organizationId: scope.organizationId,
      payload: {
        ...scope, operationKey, entity: request.entity, operation: request.operation, fields: payload.fields,
        ...(request.entityId ? { entityId: request.entityId } : {}),
        ...(request.syncToken ? { syncToken: request.syncToken } : {}),
        ...(request.rentalPosting ? { rentalPosting: request.rentalPosting } : {}),
      },
      priority: 50,
      maxAttempts: 8,
    });
    // The runner reserves "queued" for outbox-dispatched work; this command
    // enqueues its job directly (same transaction, stable key) so the receipt
    // can name the job. The request is saved; nothing is posted yet.
    return {
      state: "saved_in_rops",
      affectedRecordIds: [recordReferenceIdSchema.parse(result.job.id)],
      resultingRevisions: [],
      validationOutcomes: [{ code: "accounting.qbo.write.queued", severity: "info", message: `QuickBooks ${request.entity} ${request.operation} queued. It is not in QuickBooks until the worker confirms it by readback.` }],
    };
  };
}

/**
 * Validate a QuickBooks write against the enabled write types and the
 * rental posting policy, then queue it for the worker under a stable job
 * key. The request never calls QuickBooks.
 */
export async function executeQboWriteSubmit(executor: RentOpsQueryExecutor, rawEnvelope: unknown, access: AccountingCommandAccess, writePolicy: QboWritePolicy): Promise<OperationReceipt> {
  const envelope = parseEnvelope(submitQboWritePayloadSchema, rawEnvelope, "QuickBooks write");
  return runCompanyCommand(executor, { envelope, principal: access.principal, resolvePrincipal: access.resolvePrincipal, transport: access.transport, policy: QBO_WRITE_SUBMIT_POLICY, handler: handler(writePolicy) });
}
