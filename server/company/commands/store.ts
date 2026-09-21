import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import { z } from "zod";
import {
  operationReceiptSchema,
  type OperationReceipt,
} from "../../../shared/company";
import { canonicalJson } from "./fingerprint";
import { ConflictCommandError, ValidationCommandError } from "./errors";

export interface CompanyCommandReceiptRow {
  readonly operationId: string;
  readonly organizationId: string;
  readonly legalEntityId: string | null;
  readonly actorId: string;
  readonly channel: string;
  readonly commandKind: string;
  readonly idempotencyKey: string;
  readonly payloadSha256: string;
  readonly receipt: OperationReceipt | null;
}

export interface CompanyOutboxRow {
  readonly id: string;
  readonly organizationId: string;
  readonly operationId: string;
  readonly eventKey: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadSha256: string;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new ValidationCommandError("Company command storage returned an invalid row", { reason: "invalid_storage_row", field: key });
  return value;
}

function nullableStringValue(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ValidationCommandError("Company command storage returned an invalid nullable row", { reason: "invalid_storage_row", field: key });
  return value;
}

function parseStoredReceipt(value: unknown): OperationReceipt | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ValidationCommandError("Stored command receipt is not valid JSON", { reason: "invalid_receipt_json" });
    }
  }
  try {
    return operationReceiptSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationCommandError("Stored command receipt failed validation", { reason: "invalid_receipt_shape" });
    }
    throw error;
  }
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationCommandError("Stored outbox payload is not valid JSON", { reason: "invalid_outbox_json" });
  }
}

function receiptRow(row: Record<string, unknown>): CompanyCommandReceiptRow {
  return {
    operationId: stringValue(row, "operation_id"),
    organizationId: stringValue(row, "organization_id"),
    legalEntityId: nullableStringValue(row, "legal_entity_id"),
    actorId: stringValue(row, "actor_id"),
    channel: stringValue(row, "channel"),
    commandKind: stringValue(row, "command_kind"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    payloadSha256: stringValue(row, "payload_sha256"),
    receipt: parseStoredReceipt(row.receipt),
  };
}

function outboxRow(row: Record<string, unknown>): CompanyOutboxRow {
  return {
    id: stringValue(row, "id"),
    organizationId: stringValue(row, "organization_id"),
    operationId: stringValue(row, "operation_id"),
    eventKey: stringValue(row, "event_key"),
    topic: stringValue(row, "topic"),
    payload: parseStoredJson(row.payload),
    payloadSha256: stringValue(row, "payload_sha256"),
  };
}

const receiptColumns = "operation_id, organization_id, legal_entity_id, actor_id, channel, command_kind, idempotency_key, payload_sha256, receipt";
const outboxColumns = "id, organization_id, operation_id, event_key, topic, payload, payload_sha256";

export class PostgresCompanyCommandStore {
  async findReceiptByIdempotency(
    executor: RentOpsQueryExecutor,
    organizationId: string,
    idempotencyKey: string,
  ): Promise<CompanyCommandReceiptRow | undefined> {
    const result = await executor.query<Record<string, unknown>>(
      `SELECT ${receiptColumns} FROM company_command_receipts WHERE organization_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [organizationId, idempotencyKey],
    );
    return result.rows[0] ? receiptRow(result.rows[0]) : undefined;
  }

  async findReceiptByOperation(
    executor: RentOpsQueryExecutor,
    organizationId: string,
    operationId: string,
  ): Promise<CompanyCommandReceiptRow | undefined> {
    const result = await executor.query<Record<string, unknown>>(
      `SELECT ${receiptColumns} FROM company_command_receipts WHERE organization_id = $1 AND operation_id = $2 FOR UPDATE`,
      [organizationId, operationId],
    );
    return result.rows[0] ? receiptRow(result.rows[0]) : undefined;
  }

  async insertReceipt(
    executor: RentOpsQueryExecutor,
    row: Omit<CompanyCommandReceiptRow, "receipt">,
  ): Promise<CompanyCommandReceiptRow | undefined> {
    const result = await executor.query<Record<string, unknown>>(
      `INSERT INTO company_command_receipts (operation_id, organization_id, legal_entity_id, actor_id, channel, command_kind, idempotency_key, payload_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING ${receiptColumns}`,
      [row.operationId, row.organizationId, row.legalEntityId, row.actorId, row.channel, row.commandKind, row.idempotencyKey, row.payloadSha256],
    );
    return result.rows[0] ? receiptRow(result.rows[0]) : undefined;
  }

  async completeReceipt(
    executor: RentOpsQueryExecutor,
    organizationId: string,
    operationId: string,
    receipt: OperationReceipt,
  ): Promise<void> {
    const result = await executor.query(
      `UPDATE company_command_receipts SET receipt = $1::jsonb, completed_at = now()
       WHERE organization_id = $2 AND operation_id = $3 AND receipt IS NULL
       RETURNING operation_id`,
      [JSON.stringify(receipt), organizationId, operationId],
    );
    if (result.rows.length !== 0) return;
    const existing = await this.findReceiptByOperation(executor, organizationId, operationId);
    if (!existing || existing.receipt === null) throw new ConflictCommandError("Command receipt could not be completed", { reason: "receipt_completion_conflict" });
    if (existing.receipt.operationId !== receipt.operationId) throw new ConflictCommandError("Command receipt operation mismatch", { reason: "receipt_operation_mismatch" });
  }

  async insertOrVerifyOutbox(
    executor: RentOpsQueryExecutor,
    row: CompanyOutboxRow,
  ): Promise<CompanyOutboxRow> {
    const result = await executor.query<Record<string, unknown>>(
      `INSERT INTO company_outbox (id, organization_id, operation_id, event_key, topic, payload, payload_sha256)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT DO NOTHING
       RETURNING ${outboxColumns}`,
      [row.id, row.organizationId, row.operationId, row.eventKey, row.topic, JSON.stringify(row.payload), row.payloadSha256],
    );
    if (result.rows[0]) return outboxRow(result.rows[0]);

    const existingResult = await executor.query<Record<string, unknown>>(
      `SELECT ${outboxColumns} FROM company_outbox WHERE organization_id = $1 AND event_key = $2 FOR UPDATE`,
      [row.organizationId, row.eventKey],
    );
    const existing = existingResult.rows[0] ? outboxRow(existingResult.rows[0]) : undefined;
    if (!existing) throw new ConflictCommandError("Outbox event could not be resolved after a uniqueness conflict", { reason: "outbox_conflict_unresolved" });
    const samePayload = existing.payloadSha256 === row.payloadSha256 && canonicalJson(existing.payload) === canonicalJson(row.payload);
    if (existing.operationId !== row.operationId || existing.topic !== row.topic || !samePayload) {
      throw new ConflictCommandError("Outbox event key is already bound to different work", { reason: "outbox_event_conflict" });
    }
    return existing;
  }
}

export const companyCommandStore = new PostgresCompanyCommandStore();
