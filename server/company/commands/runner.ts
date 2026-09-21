import {
  commandEnvelopeSchema,
  createOperationReceipt,
  type CommandEnvelope,
  type OperationReceipt,
  type RecordReferenceId,
  type ResultingRevision,
  type ValidationOutcome,
  newRecordId,
  RevisionConflictError,
} from "../../../shared/company";
import { z } from "zod";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import {
  authorizeCommand,
  type AuthenticatedPrincipal,
  type CommandAuthorizationPolicy,
  type TransportAttestation,
} from "../authorization";
import { canonicalJsonSha256, commandPayloadSha256 } from "./fingerprint";
import {
  CompanyCommandError,
  ConflictCommandError,
  ForbiddenCommandError,
  ValidationCommandError,
} from "./errors";
import { companyCommandStore, type CompanyCommandReceiptRow } from "./store";

export type LocalCommandState = "saved_in_rops" | "queued";

export interface CommandOutboxInput {
  readonly eventKey: string;
  readonly topic: string;
  /** Migration 032 stores outbox payloads as JSON objects. */
  readonly payload: Record<string, unknown>;
}

export interface CommandHandlerContext<TPayload> {
  readonly executor: RentOpsQueryExecutor;
  readonly envelope: CommandEnvelope<TPayload>;
  readonly commandKind: string;
  readonly principal: AuthenticatedPrincipal;
  readonly transport: TransportAttestation;
}

export interface CommandHandlerResult {
  readonly state: LocalCommandState;
  readonly affectedRecordIds: readonly (RecordReferenceId | string)[];
  readonly resultingRevisions: readonly ResultingRevision[];
  readonly validationOutcomes?: readonly ValidationOutcome[];
  readonly outbox?: CommandOutboxInput;
}

export type CompanyCommandHandler<TPayload> = (
  context: CommandHandlerContext<TPayload>,
) => Promise<CommandHandlerResult> | CommandHandlerResult;

export interface RunCompanyCommandInput<TPayload> {
  readonly envelope: CommandEnvelope<TPayload>;
  /** Initial server attestation carried with the request; authorization uses the fresh resolver below. */
  readonly principal: AuthenticatedPrincipal;
  /** Required: reload active grants inside the command transaction before every replay lookup. */
  readonly resolvePrincipal: (executor: RentOpsQueryExecutor) => Promise<AuthenticatedPrincipal>;
  readonly transport: TransportAttestation;
  readonly policy: CommandAuthorizationPolicy;
  readonly handler: CompanyCommandHandler<TPayload>;
}

function assertEventValue(value: string, max: number, field: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationCommandError(`Outbox ${field} is invalid`, { reason: `invalid_outbox_${field}` });
  }
}

function assertOutboxTopic(value: string): void {
  if (!/^[a-z][a-z0-9_.-]*$/.test(value)) {
    throw new ValidationCommandError("Outbox topic is invalid", { reason: "invalid_outbox_topic" });
  }
}

function assertOutboxPayload(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationCommandError("Outbox payload must be a JSON object", { reason: "invalid_outbox_payload" });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationCommandError("Outbox payload must be a plain JSON object", { reason: "invalid_outbox_payload" });
  }
}

function validateCommandEnvelope<TPayload>(envelope: CommandEnvelope<TPayload>): CommandEnvelope<TPayload> {
  const result = commandEnvelopeSchema(z.record(z.string(), z.unknown())).safeParse(envelope);
  if (!result.success) {
    throw new ValidationCommandError("Command envelope failed shared validation", {
      reason: "invalid_command_envelope",
      issues: result.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    });
  }
  return result.data as unknown as CommandEnvelope<TPayload>;
}

function parseReplay(row: CompanyCommandReceiptRow, fingerprint: string, commandKind: string): OperationReceipt {
  if (row.commandKind !== commandKind || row.payloadSha256 !== fingerprint) {
    throw new ConflictCommandError("Idempotency key is already bound to different command input", { reason: "idempotency_key_conflict" });
  }
  if (row.receipt === null) {
    throw new ConflictCommandError("Command is already in progress", { reason: "command_pending" });
  }
  return row.receipt;
}

function assertHandlerResult(result: CommandHandlerResult): void {
  if (result === null || typeof result !== "object") {
    throw new ValidationCommandError("Command handler returned an invalid result", { reason: "invalid_handler_result" });
  }
  if (result.state !== "saved_in_rops" && result.state !== "queued") {
    throw new ValidationCommandError("Command handler returned an unsupported state", { reason: "invalid_command_state" });
  }
  if (result.state === "queued" && result.outbox === undefined) {
    throw new ValidationCommandError("Queued commands must provide an outbox event", { reason: "queued_outbox_required" });
  }
  if (result.outbox !== undefined) {
    if (typeof result.outbox !== "object" || result.outbox === null) {
      throw new ValidationCommandError("Command handler returned an invalid outbox", { reason: "invalid_outbox" });
    }
    assertEventValue(result.outbox.eventKey, 255, "event_key");
    assertEventValue(result.outbox.topic, 120, "topic");
    assertOutboxTopic(result.outbox.topic);
    assertOutboxPayload(result.outbox.payload);
  }
}

/**
 * Execute one command under a required SQL transaction. The callback, receipt
 * write, and outbox write all share the transaction executor. A replay never
 * calls the business handler.
 */
export async function runCompanyCommand<TPayload>(
  executor: RentOpsQueryExecutor,
  input: RunCompanyCommandInput<TPayload>,
): Promise<OperationReceipt> {
  if (typeof executor.transaction !== "function") {
    throw new ValidationCommandError("Company commands require an atomic SQL transaction", { reason: "atomic_transaction_required" });
  }

  const envelope = validateCommandEnvelope(input.envelope);
  const commandKind = input.policy.commandKind;
  const fingerprint = commandPayloadSha256({ commandKind, envelope });
  return executor.transaction(async (transactionExecutor) => {
    // Authorization is intentionally inside the transaction and before every
    // idempotency read, including replay paths.
    const principal = await input.resolvePrincipal(transactionExecutor);
    if (principal.actorId !== input.principal.actorId || principal.organizationId !== input.principal.organizationId) {
      throw new ForbiddenCommandError("Fresh principal resolution changed the authenticated identity", { reason: "principal_identity_changed" });
    }
    authorizeCommand(principal, input.transport, input.policy, envelope);
    const organizationId = envelope.scope.organizationId;
    const existingKey = await companyCommandStore.findReceiptByIdempotency(transactionExecutor, organizationId, envelope.idempotencyKey);
    if (existingKey) return parseReplay(existingKey, fingerprint, commandKind);

    const existingOperation = await companyCommandStore.findReceiptByOperation(transactionExecutor, organizationId, envelope.operationId);
    if (existingOperation) {
      throw new ConflictCommandError("Operation ID is already used in this organization", { reason: "operation_id_conflict" });
    }

    const inserted = await companyCommandStore.insertReceipt(transactionExecutor, {
      operationId: envelope.operationId,
      organizationId,
      legalEntityId: envelope.scope.legalEntityId ?? null,
      actorId: principal.actorId,
      channel: input.transport.channel,
      commandKind,
      idempotencyKey: envelope.idempotencyKey,
      payloadSha256: fingerprint,
    });
    if (!inserted) {
      const racedKey = await companyCommandStore.findReceiptByIdempotency(transactionExecutor, organizationId, envelope.idempotencyKey);
      if (racedKey) return parseReplay(racedKey, fingerprint, commandKind);
      const racedOperation = await companyCommandStore.findReceiptByOperation(transactionExecutor, organizationId, envelope.operationId);
      if (racedOperation) throw new ConflictCommandError("Operation ID is already used in this organization", { reason: "operation_id_conflict" });
      throw new ConflictCommandError("Command uniqueness conflict could not be resolved", { reason: "command_uniqueness_conflict" });
    }

    let result: CommandHandlerResult;
    try {
      result = await input.handler({
        executor: transactionExecutor,
        envelope,
        commandKind,
        principal,
        transport: input.transport,
      });
    } catch (error) {
      if (error instanceof CompanyCommandError) throw error;
      if (error instanceof RevisionConflictError) {
        throw new ConflictCommandError("Command revision is stale", { reason: "revision_conflict", expected: error.expected, actual: error.actual });
      }
      if (error instanceof Error && error.name === "ZodError") {
        throw new ValidationCommandError("Command handler validation failed", { reason: "handler_validation" });
      }
      throw error;
    }
    assertHandlerResult(result);
    let receipt: OperationReceipt;
    try {
      receipt = createOperationReceipt(envelope, {
        state: result.state,
        affectedRecordIds: result.affectedRecordIds,
        resultingRevisions: result.resultingRevisions,
        validationOutcomes: result.validationOutcomes ?? [],
      });
    } catch (error) {
      if (error instanceof CompanyCommandError) throw error;
      throw new ValidationCommandError("Command handler returned an invalid receipt shape", { reason: "invalid_handler_receipt" });
    }

    if (result.outbox !== undefined) {
      const eventPayloadSha256 = canonicalJsonSha256(result.outbox.payload);
      await companyCommandStore.insertOrVerifyOutbox(transactionExecutor, {
        id: newRecordId(),
        organizationId,
        operationId: envelope.operationId,
        eventKey: result.outbox.eventKey,
        topic: result.outbox.topic,
        payload: result.outbox.payload,
        payloadSha256: eventPayloadSha256,
      });
    }
    await companyCommandStore.completeReceipt(transactionExecutor, organizationId, envelope.operationId, receipt);
    return receipt;
  });
}

export const executeCompanyCommand = runCompanyCommand;
