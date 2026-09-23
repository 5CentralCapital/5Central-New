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
import { CompanyCommandError } from "../company/commands/errors";
import { assertRentalPostingMethod } from "./posting-policy";

export type QboWriteOperation = "create" | "update" | "void" | "delete";

/** Write types this code can perform and verify by readback. Everything else is held. */
export const QBO_WRITE_SUPPORT: Readonly<Record<string, readonly QboWriteOperation[]>> = Object.freeze({
  Vendor: ["create", "update"],
  Customer: ["create", "update"],
  Bill: ["create", "update"],
  JournalEntry: ["create"],
  // Record-only rental receivables: never emailed, never payable online (see recordOnlyInvoiceReason).
  Invoice: ["create", "update"],
});

/**
 * Invoices written by 5Central Ops record history and approved billing; they
 * are not delivery or collection instructions. MRA collects rent, and
 * QuickBooks-hosted direct collection (plan QS13) is a separate, not yet
 * enabled action. So every Invoice write must explicitly disable online card,
 * ACH and IPN payment and leave EmailStatus "NotSet"; QuickBooks only emails
 * an invoice through its send endpoint, which this code never calls.
 */
const INVOICE_RECORD_ONLY_FLAGS = ["AllowOnlineCreditCardPayment", "AllowOnlineACHPayment", "AllowIPNPayment", "AllowOnlinePayment"] as const;
const INVOICE_FORBIDDEN_FIELDS = ["DeliveryInfo", "InvoiceLink", "EInvoiceStatus", "AllowOnlinePayPalPayment", "AllowOnlineAffirmPayment"] as const;

export function recordOnlyInvoiceReason(request: Pick<QboWriteRequest, "entity" | "operation" | "fields">): string | null {
  if (request.entity !== "Invoice") return null;
  const fields = request.fields ?? {};
  for (const name of INVOICE_FORBIDDEN_FIELDS) {
    if (name in fields && !(fields[name] === false || fields[name] === null)) return `A record-only QuickBooks Invoice cannot set ${name}.`;
  }
  for (const flag of INVOICE_RECORD_ONLY_FLAGS) {
    if (flag in fields && fields[flag] !== false) return `A record-only QuickBooks Invoice must keep ${flag} false.`;
  }
  if ("EmailStatus" in fields && fields.EmailStatus !== "NotSet") return "A record-only QuickBooks Invoice must keep EmailStatus \"NotSet\"; it is never queued for sending.";
  if (request.operation === "create") {
    const missing = [...INVOICE_RECORD_ONLY_FLAGS.slice(0, 3), "EmailStatus"].filter(name => !(name in fields));
    if (missing.length) return `A record-only QuickBooks Invoice create must state ${missing.join(", ")} explicitly (false / "NotSet") so company defaults cannot enable delivery or online payment.`;
  }
  return null;
}

/** The saved QuickBooks record must still be record-only; otherwise it needs review. */
export function recordOnlyInvoiceViolation(entity: QuickBooksJsonObject | null | undefined): string | null {
  if (!entity) return "QuickBooks did not return the saved Invoice";
  for (const flag of INVOICE_RECORD_ONLY_FLAGS) if (entity[flag] === true) return `QuickBooks saved the Invoice with ${flag} on`;
  if (entity.EmailStatus === "NeedToSend" || entity.EmailStatus === "EmailSent") return `QuickBooks saved the Invoice with EmailStatus ${entity.EmailStatus}`;
  if (typeof entity.InvoiceLink === "string" && entity.InvoiceLink.length > 0) return "QuickBooks returned a payable InvoiceLink for a record-only Invoice";
  return null;
}

/** QBO entities that carry tenant receivables; writing them is rental posting. */
export const QBO_RENTAL_RECEIVABLE_ENTITIES: ReadonlySet<string> = new Set(["Invoice", "Payment", "CreditMemo", "SalesReceipt", "RefundReceipt"]);

/** Until an explicit non-rental classification exists, every JournalEntry create must identify its rental method. */
function rentalPostingRequiredReason(request: QboWriteRequest): string | null {
  if (QBO_RENTAL_RECEIVABLE_ENTITIES.has(request.entity) && !request.rentalPosting) {
    return `A QuickBooks ${request.entity} posts rental activity; submit it with its rental posting method and date.`;
  }
  if (request.entity === "JournalEntry" && request.operation === "create" && !request.rentalPosting) {
    return "A QuickBooks JournalEntry create must declare its rental posting method and date. Non-rental journal entries are not enabled yet.";
  }
  return null;
}

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
  /**
   * Set when the write posts rental activity (receivables or a summary
   * bridge entry). The entity's rental posting policy must allow exactly
   * this method on this date, or the write is held.
   */
  readonly rentalPosting?: { readonly activityDate: string; readonly method: "native_receivables" | "summary_bridge" };
}

export type QboWriteOutcome =
  | { readonly status: "confirmed"; readonly providerEntityId: string | null; readonly providerVersion: string | null; readonly intuitTid: string | null }
  | { readonly status: "held"; readonly reason: string }
  | { readonly status: "conflict"; readonly reason: "stale_sync_token" | "rejected" | "readback_mismatch" | "operation_key_reused"; readonly recovery: "reread_and_resubmit" | "review_provider_record" }
  | { readonly status: "ambiguous"; readonly recovery: "reconcile_by_readback" }
  /**
   * The outcome of an earlier attempt is unknown and this create has no
   * natural key to read it back by (e.g. Bill, JournalEntry). It is never
   * re-posted: an operator checks QuickBooks and records the result.
   */
  | { readonly status: "ambiguous"; readonly recovery: "manual_review"; readonly reason: "no_readback_key" };

/** Why a write would be held before reaching QuickBooks, or null when it may be queued. */
export function qboWriteHeldReason(request: QboWriteRequest, policy: QboWritePolicy): string | null {
  const held = heldReason(request, policy);
  if (held) return held;
  return rentalPostingRequiredReason(request);
}

function heldReason(request: QboWriteRequest, policy: QboWritePolicy): string | null {
  const supported = QBO_WRITE_SUPPORT[request.entity] ?? [];
  if (!supported.includes(request.operation)) {
    return `5Central Ops cannot ${request.operation} a QuickBooks ${request.entity} yet. Make this change in QuickBooks; the next sync will read it back.`;
  }
  const recordOnly = recordOnlyInvoiceReason(request);
  if (recordOnly) return recordOnly;
  if (!policy.enabled) return "QuickBooks writes are turned off for this server (QBO_WRITES_ENABLED is not on).";
  if (!policy.allowed.has(`${request.entity}:${request.operation}`)) return `QuickBooks ${request.entity} ${request.operation} is not in the enabled write types (QBO_WRITE_TYPES).`;
  if (request.scope.environment === "production" && !policy.productionEnabled) return "QuickBooks production writes are turned off (QBO_PRODUCTION_WRITES is not on). Only sandbox writes can run.";
  return null;
}

export function assertQboWriteFields(request: QboWriteRequest): void {
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

function hasCreateReadbackKey(request: QboWriteRequest): boolean {
  const key = CREATE_READBACK_KEYS[request.entity];
  return key !== undefined && typeof request.fields[key] === "string";
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
    heldReason: (request: QboWriteRequest) => qboWriteHeldReason(request, policy),
    async execute(request: QboWriteRequest): Promise<QboWriteOutcome> {
      const held = qboWriteHeldReason(request, policy);
      if (held) return { status: "held", reason: held };
      if (request.rentalPosting) {
        try {
          await assertRentalPostingMethod(options.executor, { organizationId: request.scope.organizationId, legalEntityId: request.scope.legalEntityId, activityDate: request.rentalPosting.activityDate, method: request.rentalPosting.method });
        } catch (error) {
          if (error instanceof CompanyCommandError) return { status: "held", reason: error.message };
          throw error;
        }
      }
      assertQboWriteFields(request);
      const journal = new PostgresQuickBooksWriteJournal(options.executor, request.scope, { entity: request.entity, operation: request.operation }, options.now);
      const requestShape: QuickBooksJsonObject = { ...request.fields };
      const requestIdentity: QuickBooksJsonObject = { entity: request.entity, operation: request.operation, entityId: request.entityId ?? null, syncToken: request.syncToken ?? null, fields: requestShape };
      const requestHash = canonicalJsonSha256(requestIdentity);
      const existing = await journal.row(request.operationKey);
      if (existing && (existing.request_hash !== requestHash || existing.entity !== request.entity || existing.operation !== request.operation)) {
        return { status: "conflict", reason: "operation_key_reused", recovery: "review_provider_record" };
      }
      if (existing?.state === "failed") return { status: "conflict", reason: "rejected", recovery: "reread_and_resubmit" };
      // An earlier create may have reached QuickBooks. Without a provider Id
      // or a natural key there is no way to read it back, and a resend would
      // rely on Intuit's requestid de-duplication alone, so hold it instead.
      if (existing && (existing.state === "started" || existing.state === "ambiguous") && request.operation === "create"
        && !existing.provider_entity_id && !hasCreateReadbackKey(request)) {
        return { status: "ambiguous", recovery: "manual_review", reason: "no_readback_key" };
      }
      if (!existing) await journal.save({ operationKey: request.operationKey, requestHash, state: "prepared" });
      if (!existing || existing.state === "prepared") await journal.save({ operationKey: request.operationKey, requestHash, state: "validated" });

      const client = options.clientFor(request.scope);
      let createdId: string | null = existing?.provider_entity_id ?? null;
      let savedEntity: QuickBooksJsonObject | null = null;
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
        // Without a natural key the write stays unconfirmed (ambiguous); the
        // next attempt holds it for manual review rather than resending.
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
            savedEntity = response.entity;
            return response;
          },
          readback,
        });
        if (request.entity === "Invoice") {
          // Verify what QuickBooks actually saved (from the write response, or a readback when the response was lost).
          const saved = savedEntity ?? (await readback()).providerEntity ?? null;
          if (recordOnlyInvoiceViolation(saved)) return { status: "conflict", reason: "readback_mismatch", recovery: "review_provider_record" };
        }
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
