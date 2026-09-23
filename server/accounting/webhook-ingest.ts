import { createHash } from "node:crypto";
import type { QboEnvironment } from "../../shared/accounting/operations";
import { parseQuickBooksEventType, parseQuickBooksWebhookPayload, verifyQuickBooksWebhookSignature, type QuickBooksCloudEvent } from "../integrations/quickbooks/webhook";
import { PostgresJobQueue } from "../jobs/queue";
import { periodicBucketLabel } from "../jobs/worker-runtime";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { QBO_CDC_ENTITIES, QBO_NAMED_ENTITIES } from "./provider-sync";

export const QBO_WEBHOOK_EVENT_TOPIC = "accounting.qbo.webhook_event";
export const QBO_SYNC_TOPIC = "accounting.qbo.sync";
export const QBO_WRITE_TOPIC = "accounting.qbo.write";

export interface QboBindingScope {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly environment: QboEnvironment;
  readonly realmId: string;
}

export function qboScopeKeyPart(scope: QboBindingScope): string {
  return `${scope.organizationId}:${scope.legalEntityId}:${scope.environment}:${scope.realmId}`;
}

/** Enqueue a scoped catch-up; repeated requests inside one bucket share a job. */
export async function enqueueQboSync(queue: PostgresJobQueue, scope: QboBindingScope, input: { readonly origin: "periodic" | "manual" | "webhook" | "recovery"; readonly bucketMs?: number; readonly forceFullReplay?: boolean; readonly now?: Date }) {
  const bucket = periodicBucketLabel(input.now ?? new Date(), input.bucketMs ?? 60_000);
  return queue.enqueue({
    jobKey: `qbo.sync:${input.origin}:${qboScopeKeyPart(scope)}:${bucket}${input.forceFullReplay ? ":full" : ""}`,
    topic: QBO_SYNC_TOPIC,
    organizationId: scope.organizationId,
    payload: { ...scope, origin: input.origin, forceFullReplay: input.forceFullReplay === true },
    priority: input.origin === "manual" ? 50 : 100,
    maxAttempts: 6,
  });
}

export type WebhookIngestResult =
  | { readonly status: "accepted"; readonly received: number; readonly fresh: number; readonly jobs: number; readonly unrouted: number; readonly ignored: number }
  | { readonly status: "rejected"; readonly reason: "signature" | "payload" };

interface BindingRow { organization_id: string; legal_entity_id: string }

const SUPPORTED_OBJECTS = new Set<string>([...QBO_CDC_ENTITIES, ...QBO_NAMED_ENTITIES]);
const MAX_EVENT_REFS = 100;

function eventRef(event: QuickBooksCloudEvent) {
  return { source: event.source, id: event.id };
}

function isDeleteOperation(operation: unknown): boolean {
  return typeof operation === "string" && /^delete(d)?$/i.test(operation);
}

/**
 * Fold one more notice into a pending object-fetch job. Every event ref is
 * kept (so each event is marked processed when the job finishes); the latest
 * notice decides whether the job fetches or tombstones, and on a tie a
 * deletion wins, so an update can never mask a deletion reported at the same
 * instant.
 */
export function mergeWebhookObjectPayload(
  existing: Record<string, unknown>,
  incoming: { readonly ref: { readonly source: string; readonly id: string }; readonly operation: string; readonly occurredAt: string },
): Record<string, unknown> {
  const refs = Array.isArray(existing.events) ? existing.events as { source: string; id: string }[] : [];
  const events = [...refs, incoming.ref].filter((ref, index, all) => all.findIndex(other => other.source === ref.source && other.id === ref.id) === index).slice(-MAX_EVENT_REFS);
  const existingAt = typeof existing.occurredAt === "string" ? Date.parse(existing.occurredAt) : Number.NaN;
  const incomingAt = Date.parse(incoming.occurredAt);
  const replace = !Number.isFinite(existingAt)
    || incomingAt > existingAt
    || (incomingAt === existingAt && (isDeleteOperation(incoming.operation) || !isDeleteOperation(existing.operation)));
  return { ...existing, events, ...(replace ? { operation: incoming.operation, occurredAt: new Date(incomingAt).toISOString() } : {}) };
}

/**
 * Verify, persist and route one Intuit CloudEvents delivery. Nothing is
 * stored unless the signature over the exact bytes verifies. Each event is
 * recorded once per (environment, source, id); new events fan out to every
 * active binding of that environment + realm as one coalescing fetch job per
 * (binding, object). No provider call happens here, so the request can be
 * acknowledged within Intuit's delivery window.
 */
export async function ingestQuickBooksWebhookDelivery(input: {
  readonly executor: RentOpsQueryExecutor;
  readonly environment: QboEnvironment;
  readonly rawBody: Uint8Array;
  readonly signature: string | undefined;
  readonly verifierToken: string;
  readonly now?: Date;
}): Promise<WebhookIngestResult> {
  if (!verifyQuickBooksWebhookSignature(input.rawBody, input.signature, input.verifierToken)) return { status: "rejected", reason: "signature" };
  let events: readonly QuickBooksCloudEvent[];
  try {
    events = parseQuickBooksWebhookPayload(input.rawBody);
    for (const event of events) parseQuickBooksEventType(event.type);
  } catch {
    return { status: "rejected", reason: "payload" };
  }
  if (!input.executor.transaction) throw new Error("QuickBooks webhook intake requires transaction support");
  const now = input.now ?? new Date();
  const deliverySha256 = createHash("sha256").update(input.rawBody).digest("hex");
  return input.executor.transaction(async executor => {
    const queue = new PostgresJobQueue(executor, { now: () => now });
    let fresh = 0;
    let jobs = 0;
    let unrouted = 0;
    let ignored = 0;
    for (const event of events) {
      const { objectType, operation } = parseQuickBooksEventType(event.type);
      const objectId = event.intuitEntityId ?? "*";
      const inserted = await executor.query(
        `INSERT INTO accounting_qbo_webhook_events
          (environment, event_source, event_id, event_type, realm_id, object_type, object_id, operation, occurred_at, received_at, delivery_sha256, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'received')
         ON CONFLICT (environment, event_source, event_id) DO NOTHING
         RETURNING event_id`,
        [input.environment, event.source, event.id, event.type.slice(0, 255), event.intuitAccountId, objectType, objectId, operation, new Date(event.time).toISOString(), now.toISOString(), deliverySha256],
      );
      if (!inserted.rows.length) continue;
      fresh += 1;
      const bindings = await executor.query<BindingRow>(
        `SELECT b.organization_id, b.legal_entity_id
           FROM accounting_qbo_realm_bindings b
           JOIN accounting_qbo_connections c
             ON c.organization_id = b.organization_id AND c.legal_entity_id = b.legal_entity_id
            AND c.environment = b.environment AND c.realm_id = b.realm_id
          WHERE b.environment = $1 AND b.realm_id = $2 AND c.status = 'active'
          ORDER BY b.organization_id, b.legal_entity_id`,
        [input.environment, event.intuitAccountId],
      );
      let state: "routed" | "unrouted" | "processed" = "routed";
      let routed = 0;
      if (bindings.rows.length === 0) {
        state = "unrouted";
        unrouted += 1;
      } else if (!SUPPORTED_OBJECTS.has(objectType)) {
        // Recorded for audit; this entity is not mirrored, so there is nothing to fetch.
        state = "processed";
        ignored += 1;
      } else {
        for (const binding of bindings.rows) {
          const scope: QboBindingScope = { organizationId: String(binding.organization_id), legalEntityId: String(binding.legal_entity_id), environment: input.environment, realmId: event.intuitAccountId };
          if (objectId === "*") {
            const result = await enqueueQboSync(queue, scope, { origin: "webhook", bucketMs: 15 * 60_000, now });
            if (result.created) jobs += 1;
          } else {
            const identity = `${qboScopeKeyPart(scope)}|${objectType}|${objectId}`;
            const eventHash = createHash("sha256").update(`${event.source}\u0000${event.id}`).digest("hex").slice(0, 20);
            const identityHash = createHash("sha256").update(identity).digest("hex").slice(0, 24);
            const result = await queue.enqueue({
              jobKey: `qbo.object:${objectType}:${identityHash}:${eventHash}`,
              topic: QBO_WEBHOOK_EVENT_TOPIC,
              organizationId: scope.organizationId,
              coalesceKey: identity,
              payload: { ...scope, objectType, objectId, operation, occurredAt: new Date(event.time).toISOString(), events: [eventRef(event)] },
              merge: existing => mergeWebhookObjectPayload(existing, { ref: eventRef(event), operation, occurredAt: new Date(event.time).toISOString() }),
              maxAttempts: 8,
            });
            if (result.created) jobs += 1;
          }
          routed += 1;
        }
      }
      await executor.query(
        `UPDATE accounting_qbo_webhook_events SET state = $4, routed_bindings = $5, processed_at = CASE WHEN $4 = 'processed' THEN $6::timestamptz ELSE NULL END
          WHERE environment = $1 AND event_source = $2 AND event_id = $3`,
        [input.environment, event.source, event.id, state, routed, now.toISOString()],
      );
    }
    return { status: "accepted" as const, received: events.length, fresh, jobs, unrouted, ignored };
  });
}

/**
 * After a fetch job succeeds, mark its events processed once no other
 * binding's job for them is still outstanding.
 */
export async function markWebhookEventsProcessed(executor: RentOpsQueryExecutor, input: { readonly environment: QboEnvironment; readonly events: readonly { readonly source: string; readonly id: string }[]; readonly now: Date; readonly currentJobId: string }): Promise<number> {
  let marked = 0;
  for (const ref of input.events.slice(0, MAX_EVENT_REFS)) {
    const result = await executor.query(
      `UPDATE accounting_qbo_webhook_events e SET state = 'processed', processed_at = $4
        WHERE e.environment = $1 AND e.event_source = $2 AND e.event_id = $3 AND e.state IN ('received','routed','failed')
          AND NOT EXISTS (
            SELECT 1 FROM company_jobs j
             WHERE j.topic = $5 AND j.state IN ('queued','running','retry') AND j.id <> $6::uuid
               AND j.payload->'events' @> jsonb_build_array(jsonb_build_object('source', e.event_source, 'id', e.event_id)))
        RETURNING e.event_id`,
      [input.environment, ref.source, ref.id, input.now.toISOString(), QBO_WEBHOOK_EVENT_TOPIC, input.currentJobId],
    );
    marked += result.rows.length;
  }
  return marked;
}
