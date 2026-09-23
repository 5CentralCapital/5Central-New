import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { financialSourceScopeSchema } from "../../shared/accounting";
import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import type { QuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { QuickBooksIntegrationError, isQuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import {
  createQuickBooksWriteReconciler,
  type QuickBooksReadbackResult,
  type QuickBooksWriteJournal,
  type QuickBooksWriteJournalEntry,
  type QuickBooksWriteJournalState,
} from "../integrations/quickbooks/write-reconciliation";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";

export type QboWriteOperation = "create" | "update" | "void" | "delete";

/** Write types this code can perform and verify by readback. Everything else is held. */
export const QBO_WRITE_SUPPORT: Readonly<Record<string, readonly QboWriteOperation[]>> = Object.freeze({
  Vendor: ["create", "update"],
  Customer: ["create", "update"],
  Bill: ["create", "update"],
  JournalEntry: ["create"],
});

/** Natural keys used to find a created object when the provider response was lost. */
const CREATE_READBACK_KEYS: Readonly<Record<string, string>> = { Vendor: "DisplayName", Customer: "DisplayName" };

const TRANSITIONS: Readonly<Record<QuickBooksWriteJournalState, readonly QuickBooksWriteJournalState[]>> = {
  prepared: ["prepared", "validated", "started"],
  validated: ["validated", "started"],
  started: ["started", "ambiguous", "confirmed", "failed"],
  ambiguous: ["ambiguous", "started", "confirmed", "failed"],
  failed: ["failed", "started", "ambiguous", "confirmed"],
  confirmed: ["confirmed"],
};

interface AttemptRow {
  operation_key: string;
  request_hash: string;
  state: QuickBooksWriteJournalState;
  entity: string;
  operation: QboWriteOperation;
  provider_entity_id: string | null;
  provider_version: string | null;
  provider_trace_id: string | null;
}

/**
 * accounting_qbo_write_attempts as the reconciler's durable journal, keyed
 * by connection scope + operation key. Transitions are fenced: a confirmed
 * write never changes, and an operation key is bound to one request hash.
 */
export class PostgresQuickBooksWriteJournal implements QuickBooksWriteJournal {
  private readonly scope;

  constructor(
    private readonly executor: RentOpsQueryExecutor,
    scope: QuickBooksConnectionScope,
    private readonly target: { readonly entity: string; readonly operation: QboWriteOperation },
    private readonly now: () => Date = () => new Date(),
  ) {
    this.scope = financialSourceScopeSchema.parse({ provider: "qbo", ...scope });
    if (!/^[A-Z][A-Za-z0-9_]{0,119}$/.test(target.entity)) throw new AccountingError("accounting_validation", "QBO write entity is invalid");
  }

  private get scopeParts(): unknown[] {
    return [this.scope.organizationId, this.scope.legalEntityId, this.scope.environment, this.scope.realmId];
  }

  async load(operationKey: string): Promise<QuickBooksWriteJournalEntry | null> {
    const row = await this.row(operationKey);
    if (!row) return null;
    return {
      operationKey: row.operation_key,
      requestHash: row.request_hash,
      state: row.state,
      ...(row.provider_entity_id ? { providerEntityId: row.provider_entity_id } : {}),
      ...(row.provider_version ? { providerVersion: row.provider_version } : {}),
      ...(row.provider_trace_id ? { intuitTid: row.provider_trace_id } : {}),
    };
  }

  async row(operationKey: string): Promise<AttemptRow | null> {
    const result = await this.executor.query<AttemptRow>(
      `SELECT operation_key, request_hash, state, entity, operation, provider_entity_id, provider_version, provider_trace_id
         FROM accounting_qbo_write_attempts
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4 AND operation_key=$5`,
      [...this.scopeParts, operationKey],
    );
    return result.rows[0] ?? null;
  }

  async save(entry: QuickBooksWriteJournalEntry): Promise<void> {
    const allowedFrom = (Object.keys(TRANSITIONS) as QuickBooksWriteJournalState[]).filter(state => TRANSITIONS[state].includes(entry.state));
    const now = this.now().toISOString();
    const result = await this.executor.query(
      `INSERT INTO accounting_qbo_write_attempts
        (organization_id, legal_entity_id, environment, realm_id, operation_key, entity, operation, request_hash, state,
         provider_entity_id, provider_version, provider_trace_id, readback_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $9 = 'confirmed' THEN $13::timestamptz ELSE NULL END,$13)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, operation_key) DO UPDATE SET
         state = EXCLUDED.state,
         provider_entity_id = COALESCE(EXCLUDED.provider_entity_id, accounting_qbo_write_attempts.provider_entity_id),
         provider_version = COALESCE(EXCLUDED.provider_version, accounting_qbo_write_attempts.provider_version),
         provider_trace_id = COALESCE(EXCLUDED.provider_trace_id, accounting_qbo_write_attempts.provider_trace_id),
         readback_at = COALESCE(EXCLUDED.readback_at, accounting_qbo_write_attempts.readback_at),
         updated_at = EXCLUDED.updated_at
       WHERE accounting_qbo_write_attempts.request_hash = EXCLUDED.request_hash
         AND accounting_qbo_write_attempts.entity = EXCLUDED.entity
         AND accounting_qbo_write_attempts.operation = EXCLUDED.operation
         AND accounting_qbo_write_attempts.state = ANY($14::text[])
       RETURNING operation_key`,
      [...this.scopeParts, entry.operationKey, this.target.entity, this.target.operation, entry.requestHash, entry.state,
        entry.providerEntityId ?? null, entry.providerVersion ?? null, entry.intuitTid ?? null, now, allowedFrom],
    );
    if (result.rows.length !== 1) throw new AccountingError("accounting_conflict", "QuickBooks write journal transition was refused");
  }
}

export interface QboWritePolicy {
  /** Master switch; off unless QBO_WRITES_ENABLED=on. */
  readonly enabled: boolean;
  /** Production realms additionally require QBO_PRODUCTION_WRITES=on. */
  readonly productionEnabled: boolean;
  /** Explicit `Entity:operation` allowlist from QBO_WRITE_TYPES. */
  readonly allowed: ReadonlySet<string>;
}

export function qboWritePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): QboWritePolicy {
  const allowed = new Set((env.QBO_WRITE_TYPES ?? "").split(",").map(value => value.trim()).filter(value => /^[A-Z][A-Za-z0-9_]*:(create|update|void|delete)$/.test(value)));
  return { enabled: env.QBO_WRITES_ENABLED === "on", productionEnabled: env.QBO_PRODUCTION_WRITES === "on", allowed };
}

export const QBO_WRITES_DISABLED: QboWritePolicy = Object.freeze({ enabled: false, productionEnabled: false, allowed: new Set<string>() });

export interface QboWriteRequest {
  readonly scope: QuickBooksConnectionScope;
  readonly operationKey: string;
  readonly entity: string;
  readonly operation: QboWriteOperation;
  readonly fields: QuickBooksJsonObject;
  readonly entityId?: string;
  readonly syncToken?: string;
}

export type QboWriteOutcome =
  | { readonly status: "confirmed"; readonly providerEntityId: string | null; readonly providerVersion: string | null; readonly intuitTid: string | null }
  | { readonly status: "held"; readonly reason: string }
  | { readonly status: "conflict"; readonly reason: "stale_sync_token" | "rejected" | "readback_mismatch" | "operation_key_reused"; readonly recovery: "reread_and_resubmit" | "review_provider_record" }
  | { readonly status: "ambiguous"; readonly recovery: "reconcile_by_readback" };

function heldReason(request: QboWriteRequest, policy: QboWritePolicy): string | null {
  const supported = QBO_WRITE_SUPPORT[request.entity] ?? [];
  if (!supported.includes(request.operation)) {
    return `5Central Ops cannot ${request.operation} a QuickBooks ${request.entity} yet. Make this change in QuickBooks; the next sync will read it back.`;
  }
  if (!policy.enabled) return "QuickBooks writes are turned off for this server (QBO_WRITES_ENABLED is not on).";
  if (!policy.allowed.has(`${request.entity}:${request.operation}`)) return `QuickBooks ${request.entity} ${request.operation} is not in the enabled write types (QBO_WRITE_TYPES).`;
  if (request.scope.environment === "production" && !policy.productionEnabled) return "QuickBooks production writes are turned off (QBO_PRODUCTION_WRITES is not on). Only sandbox writes can run.";
  return null;
}

function assertFields(request: QboWriteRequest): void {
  const fields = request.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new AccountingError("accounting_validation", "QuickBooks write fields must be a JSON object");
  if ("Id" in fields || "SyncToken" in fields || "sparse" in fields) throw new AccountingError("accounting_validation", "Pass the QuickBooks Id and SyncToken separately from the fields");
  if (Buffer.byteLength(JSON.stringify(fields), "utf8") > 64 * 1024) throw new AccountingError("accounting_validation", "QuickBooks write fields are too large");
  if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(request.operationKey)) throw new AccountingError("accounting_validation", "QuickBooks operation key is invalid");
  if (request.operation === "update") {
    if (!request.entityId || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.entityId)) throw new AccountingError("accounting_validation", "An update needs the QuickBooks record Id");
    if (!request.syncToken || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.syncToken)) throw new AccountingError("accounting_validation", "An update needs the SyncToken that was read");
  }
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * The only path that sends accounting writes to QuickBooks. Every request
 * is prepared and validated in the durable journal before any provider
 * call; unsupported or disabled writes are held with an exact reason; an
 * unknown outcome is reconciled by readback under the stable requestid.
 */
export function createQboWriteService(options: {
  readonly executor: RentOpsQueryExecutor;
  readonly clientFor: (scope: QuickBooksConnectionScope) => QuickBooksAccountingClient;
  readonly policy?: QboWritePolicy;
  readonly now?: () => Date;
}) {
  const policy = options.policy ?? QBO_WRITES_DISABLED;
  return {
    policy,
    heldReason: (request: QboWriteRequest) => heldReason(request, policy),
    async execute(request: QboWriteRequest): Promise<QboWriteOutcome> {
      const held = heldReason(request, policy);
      if (held) return { status: "held", reason: held };
      assertFields(request);
      const journal = new PostgresQuickBooksWriteJournal(options.executor, request.scope, { entity: request.entity, operation: request.operation }, options.now);
      const requestShape: QuickBooksJsonObject = { ...request.fields };
      const requestIdentity: QuickBooksJsonObject = { entity: request.entity, operation: request.operation, entityId: request.entityId ?? null, syncToken: request.syncToken ?? null, fields: requestShape };
      const requestHash = canonicalJsonSha256(requestIdentity);
      const existing = await journal.row(request.operationKey);
      if (existing && (existing.request_hash !== requestHash || existing.entity !== request.entity || existing.operation !== request.operation)) {
        return { status: "conflict", reason: "operation_key_reused", recovery: "review_provider_record" };
      }
      if (existing?.state === "failed") return { status: "conflict", reason: "rejected", recovery: "reread_and_resubmit" };
      if (!existing) await journal.save({ operationKey: request.operationKey, requestHash, state: "prepared" });
      if (!existing || existing.state === "prepared") await journal.save({ operationKey: request.operationKey, requestHash, state: "validated" });

      const client = options.clientFor(request.scope);
      let createdId: string | null = existing?.provider_entity_id ?? null;
      const readback = async (): Promise<QuickBooksReadbackResult> => {
        const id = request.operation === "update" ? request.entityId! : createdId;
        if (id) {
          try {
            const found = await client.read(request.entity, id);
            return { exists: true, providerEntity: found.entity, providerEntityId: id, ...(found.entity.SyncToken !== undefined ? { providerVersion: String(found.entity.SyncToken) } : {}), ...(found.intuitTid ? { intuitTid: found.intuitTid } : {}) };
          } catch (error) {
            if (isQuickBooksIntegrationError(error) && (error.status === 404 || error.details.providerCode === "610")) return { exists: false };
            throw error;
          }
        }
        const key = CREATE_READBACK_KEYS[request.entity];
        const value = key ? request.fields[key] : undefined;
        // Without a natural key, "not found" lets the reconciler resend under
        // the same requestid, which Intuit de-duplicates to the original object.
        if (!key || typeof value !== "string") return { exists: false };
        const found = await client.query(`SELECT * FROM ${request.entity} WHERE ${key} = '${escapeQueryValue(value)}'`);
        const entity = found.entities[0];
        return entity
          ? { exists: true, providerEntity: entity, providerEntityId: String(entity.Id), ...(entity.SyncToken !== undefined ? { providerVersion: String(entity.SyncToken) } : {}), ...(found.intuitTid ? { intuitTid: found.intuitTid } : {}) }
          : { exists: false };
      };
      const reconciler = createQuickBooksWriteReconciler(journal);
      try {
        const result = await reconciler.execute({
          operationKey: request.operationKey,
          request: requestShape,
          requestIdentity,
          write: async ({ requestId }) => {
            const response = request.operation === "update"
              ? await client.update({ entity: request.entity, id: request.entityId!, syncToken: request.syncToken!, fields: { ...request.fields, sparse: true } }, { requestId })
              : await client.create(request.entity, request.fields, { requestId });
            const id = response.entity.Id;
            if (typeof id === "string" || typeof id === "number") createdId = String(id);
            return response;
          },
          readback,
        });
        return { status: "confirmed", providerEntityId: result.providerEntityId ?? null, providerVersion: result.providerVersion ?? null, intuitTid: result.intuitTid ?? null };
      } catch (error) {
        if (error instanceof QuickBooksIntegrationError) {
          if (error.code === "quickbooks_ambiguous_write") return { status: "ambiguous", recovery: "reconcile_by_readback" };
          if (error.code === "quickbooks_conflict") {
            const stale = error.details.providerCode === "5010";
            return { status: "conflict", reason: stale ? "stale_sync_token" : error.status ? "rejected" : "readback_mismatch", recovery: stale || error.status ? "reread_and_resubmit" : "review_provider_record" };
          }
        }
        throw error;
      }
    },
  };
}

export type QboWriteService = ReturnType<typeof createQboWriteService>;
