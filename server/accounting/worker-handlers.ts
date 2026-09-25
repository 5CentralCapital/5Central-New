import { z } from "zod";
import { isQuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { PermanentJobError, RetryLaterJobError } from "../jobs/queue";
import type { JobHandlerDefinition, PeriodicJobDefinition } from "../jobs/worker-runtime";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";
import type { AccountingServices } from "./index";
import { createQboWriteService, qboWritePolicyFromEnv, type QboWritePolicy } from "./qbo-write";
import { enqueueQboSync, enqueueQboWebhookCatchUp, finalizeCompletedWebhookEvents, qboScopeKeyPart, QBO_SYNC_TOPIC, QBO_WEBHOOK_EVENT_TOPIC, QBO_WEBHOOK_FINALIZE_TOPIC, QBO_WRITE_TOPIC, type QboBindingScope } from "./webhook-ingest";

const scopeSchema = z.object({
  organizationId: z.string().uuid(),
  legalEntityId: z.string().uuid(),
  environment: z.enum(["sandbox", "production"]),
  realmId: z.string().regex(/^\d{1,32}$/),
});

const webhookEventsSchema = z.array(z.object({ source: z.string().min(1).max(512), id: z.string().min(1).max(255) }).strict()).max(200).default([]);
const syncPayloadSchema = scopeSchema.extend({ origin: z.string().optional(), forceFullReplay: z.boolean().optional(), events: webhookEventsSchema }).passthrough();
const objectPayloadSchema = scopeSchema.extend({
  objectType: z.string().regex(/^[A-Z][A-Za-z0-9_]{0,119}$/),
  objectId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  operation: z.string().min(1).max(40),
  occurredAt: z.string().nullable().optional(),
  events: webhookEventsSchema,
}).passthrough();
const writePayloadSchema = scopeSchema.extend({
  operationKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
  entity: z.string().regex(/^[A-Z][A-Za-z0-9_]{0,119}$/),
  operation: z.enum(["create", "update", "void", "delete"]),
  fields: z.record(z.string(), z.unknown()),
  entityId: z.string().optional(),
  syncToken: z.string().optional(),
  rentalPosting: z.object({ activityDate: z.string().date(), method: z.enum(["native_receivables", "summary_bridge"]) }).strict().optional(),
}).strict();

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new PermanentJobError("job_payload_invalid", "The job payload does not match its topic");
  return result.data;
}

/** Map provider failures onto retry policy: throttling waits, lost access stops. */
function providerFailure(error: unknown): never {
  if (isQuickBooksIntegrationError(error)) {
    if (error.code === "quickbooks_rate_limited") throw new RetryLaterJobError("quickbooks_rate_limited", "QuickBooks asked this company to slow down", error.retryAfterMs ?? 60_000);
    if (error.code === "quickbooks_oauth") {
      // A token endpoint 429/5xx is a provider outage or throttle, not proof
      // that the stored grant is invalid. Only invalid_grant is converted to
      // the reconnect path by the token manager.
      if (error.retryable) throw new RetryLaterJobError(error.status === 429 ? "quickbooks_rate_limited" : "quickbooks_oauth_retry", "QuickBooks authorization is temporarily unavailable", error.retryAfterMs ?? 60_000);
      throw new PermanentJobError("qbo_needs_reconnect", "QuickBooks needs to be reconnected for this company");
    }
    if (error.code === "quickbooks_unauthorized") throw new PermanentJobError("qbo_needs_reconnect", "QuickBooks needs to be reconnected for this company");
    if (error.code === "quickbooks_unsupported_capability" || error.code === "quickbooks_validation") throw new PermanentJobError(error.code, error.message);
  }
  if (error instanceof AccountingError && (error.code === "accounting_capability_disabled" || error.code === "accounting_validation" || error.code === "accounting_configuration")) {
    throw new PermanentJobError(error.code, error.message);
  }
  throw error;
}

async function connectionStatus(executor: RentOpsQueryExecutor, scope: QboBindingScope): Promise<string | null> {
  const result = await executor.query<{ status: string }>(
    `SELECT status FROM accounting_qbo_connections WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4`,
    [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId],
  );
  return result.rows[0]?.status ?? null;
}

function configured(services: AccountingServices, scope: QboBindingScope) {
  if (services.qbo.status !== "configured") throw new RetryLaterJobError("qbo_unconfigured", "QuickBooks is not configured on this worker", 10 * 60_000);
  if (services.qbo.environment !== scope.environment) throw new PermanentJobError("qbo_environment_mismatch", `This worker serves QuickBooks ${services.qbo.environment}, not ${scope.environment}`);
  return services.qbo;
}

export interface AccountingJobHandlerOptions {
  readonly services: AccountingServices;
  readonly writePolicy?: QboWritePolicy;
}

/** Worker handlers for QuickBooks transport topics. */
export function createAccountingJobHandlers(options: AccountingJobHandlerOptions): Record<string, JobHandlerDefinition> {
  const { services } = options;
  const writePolicy = options.writePolicy ?? qboWritePolicyFromEnv();
  return {
    [QBO_SYNC_TOPIC]: {
      leaseMs: 10 * 60_000,
      handler: async ({ job, executor }) => {
        const payload = parse(syncPayloadSchema, job.payload);
        const scope: QboBindingScope = { organizationId: payload.organizationId, legalEntityId: payload.legalEntityId, environment: payload.environment, realmId: payload.realmId };
        const qbo = configured(services, scope);
        const status = await connectionStatus(executor, scope);
        if (status !== "active") {
          if (payload.events.length > 0) throw new RetryLaterJobError("qbo_connection_inactive", "QuickBooks must be reconnected before this webhook catch-up can complete", 10 * 60_000);
          return { skipped: "connection_inactive", connectionStatus: status };
        }
        const sync = qbo.createProviderSync(scope);
        try {
          // CompanyInfo is the one-time read capability proof. Re-reading it
          // on every queued job made an otherwise healthy connection fail when
          // Intuit re-rendered the record or temporarily returned it missing;
          // the durable capability evidence gates access to syncChanges. This
          // gate is stable capability evidence, not a claim that mutable
          // CompanyInfo display metadata is current; an explicit reconnect or
          // metadata probe must refresh that snapshot without blocking sync.
          const capabilityGate = qbo.capabilityGate;
          const readCapabilityEnabled = capabilityGate?.isEnabled
            ? await capabilityGate.isEnabled(scope, "accounting.read")
            : false;
          if (!readCapabilityEnabled) await sync.bootstrapRead();
          const result = await sync.syncChanges({ forceFullReplay: payload.forceFullReplay === true });
          if (result.status === "failed") providerFailure(result.error ?? new AccountingError("accounting_unavailable", "QuickBooks sync did not complete"));
          if (payload.events.length > 0 && (result.status !== "complete" || result.anchored !== true)) {
            throw new RetryLaterJobError("qbo_webhook_sync_incomplete", "QuickBooks webhook catch-up is partial or unanchored and must be retried", 60_000);
          }
          return { mode: result.mode, reason: result.reason, status: result.status, applied: result.appliedCount, deleted: result.deletedCount, unsupported: result.unsupportedCount, anchored: result.anchored, watermark: result.watermark };
        } catch (error) {
          return providerFailure(error);
        }
      },
    },
    [QBO_WEBHOOK_EVENT_TOPIC]: {
      leaseMs: 2 * 60_000,
      handler: async ({ job, executor, queue, now }) => {
        const payload = parse(objectPayloadSchema, job.payload);
        const scope: QboBindingScope = { organizationId: payload.organizationId, legalEntityId: payload.legalEntityId, environment: payload.environment, realmId: payload.realmId };
        const qbo = configured(services, scope);
        const status = await connectionStatus(executor, scope);
        let result: Record<string, unknown>;
        if (status !== "active") {
          throw new RetryLaterJobError("qbo_connection_inactive", "QuickBooks must be reconnected before this webhook event can be fetched", 10 * 60_000);
        } else {
          try {
            const applied = await qbo.createProviderSync(scope).applyObject({ objectType: payload.objectType, objectId: payload.objectId, operation: payload.operation, occurredAt: payload.occurredAt ?? null });
            result = { ...applied };
            if (applied.status === "not_found") {
              // The object vanished between notice and fetch; carry the same refs
              // into a durable catch-up and keep the event routed until it anchors.
              const followUp = payload.events.length > 0
                ? await enqueueQboWebhookCatchUp(queue.forExecutor(executor), scope, payload.events)
                : await enqueueQboSync(queue.forExecutor(executor), scope, { origin: "recovery", bucketMs: 15 * 60_000, now: now() });
              result = { ...result, followUpJobId: followUp.job.id };
            }
          } catch (error) {
            return providerFailure(error);
          }
        }
        return result;
      },
    },
    [QBO_WEBHOOK_FINALIZE_TOPIC]: {
      handler: async ({ executor, now }) => ({ processed: await finalizeCompletedWebhookEvents(executor, { now: now() }) }),
    },
    [QBO_WRITE_TOPIC]: {
      leaseMs: 5 * 60_000,
      handler: async ({ job, executor }) => {
        const payload = parse(writePayloadSchema, job.payload);
        const scope: QboBindingScope = { organizationId: payload.organizationId, legalEntityId: payload.legalEntityId, environment: payload.environment, realmId: payload.realmId };
        const qbo = configured(services, scope);
        const writer = createQboWriteService({ executor, clientFor: target => qbo.createAccountingClient(target), policy: writePolicy });
        try {
          const outcome = await writer.execute({ scope, operationKey: payload.operationKey, entity: payload.entity, operation: payload.operation, fields: payload.fields as never, ...(payload.entityId ? { entityId: payload.entityId } : {}), ...(payload.syncToken ? { syncToken: payload.syncToken } : {}), ...(payload.rentalPosting ? { rentalPosting: payload.rentalPosting } : {}) });
          // Changed policy since the command queued it (writes off, type removed, posting method): stop, do not post.
          if (outcome.status === "held") throw new PermanentJobError("qbo_write_held", outcome.reason);
          // No natural readback key: never resend; an operator checks QuickBooks.
          if (outcome.status === "ambiguous" && outcome.recovery === "manual_review") throw new PermanentJobError("qbo_write_ambiguous_manual_review", "QuickBooks may have recorded this write, and it cannot be read back without a QuickBooks Id. Check QuickBooks before submitting it again.");
          // An unknown outcome is retried; the next attempt reads back before any resend.
          if (outcome.status === "ambiguous") throw new RetryLaterJobError("quickbooks_ambiguous_write", "QuickBooks write outcome is unknown; the next attempt reconciles by readback", 60_000);
          if (outcome.status === "conflict") throw new PermanentJobError(`qbo_write_${outcome.reason}`, "QuickBooks refused the write; reread the record and submit a new operation");
          return { ...outcome };
        } catch (error) {
          if (error instanceof RetryLaterJobError || error instanceof PermanentJobError) throw error;
          return providerFailure(error);
        }
      },
    },
  };
}

/** Hourly catch-up per active connection of the worker's QuickBooks environment. */
export function qboPeriodicSyncJobs(options: { readonly executor: RentOpsQueryExecutor; readonly services: AccountingServices; readonly bucketMs?: number }): PeriodicJobDefinition[] {
  const bucketMs = options.bucketMs ?? 60 * 60_000;
  return [{
    topic: QBO_SYNC_TOPIC,
    keyPrefix: "qbo.sync",
    bucketMs,
    async enumerate() {
      if (options.services.qbo.status !== "configured") return [];
      const rows = await options.executor.query<{ organization_id: string; legal_entity_id: string; environment: "sandbox" | "production"; realm_id: string }>(
        `SELECT organization_id, legal_entity_id, environment, realm_id FROM accounting_qbo_connections
          WHERE status = 'active' AND environment = $1 ORDER BY organization_id, legal_entity_id, realm_id`,
        [options.services.qbo.environment],
      );
      return rows.rows.map(row => {
        const scope: QboBindingScope = { organizationId: String(row.organization_id), legalEntityId: String(row.legal_entity_id), environment: row.environment, realmId: String(row.realm_id) };
        return { keyPart: qboScopeKeyPart(scope), organizationId: scope.organizationId, payload: { ...scope, origin: "periodic", forceFullReplay: false }, maxAttempts: 6 };
      });
    },
  }];
}

/** Recover webhook status finalization if a worker exits after a fetch job succeeds. */
export function qboWebhookFinalizationJobs(): PeriodicJobDefinition[] {
  return [{
    topic: QBO_WEBHOOK_FINALIZE_TOPIC,
    keyPrefix: "qbo.webhook.finalize",
    bucketMs: 60_000,
    async enumerate() { return [{ keyPart: "routed-events", payload: {}, maxAttempts: 8 }]; },
  }];
}
