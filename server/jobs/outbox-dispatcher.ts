import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

export interface OutboxDispatchResult {
  /** Outbox events marked dispatched by this call. */
  readonly dispatched: number;
  /** Jobs newly created; lower than `dispatched` only when a job already existed for the event. */
  readonly jobsCreated: number;
}

/**
 * Move ready company_outbox events into company_jobs. One statement locks the
 * batch with SKIP LOCKED, inserts one job per event (job_key 'outbox:<id>',
 * outbox_event_id) and sets dispatched_at, so the move is atomic, concurrent
 * dispatchers take disjoint batches, and a replay can never create a second
 * job for the same event (both job_key and outbox_event_id are unique).
 */
export async function dispatchOutboxEvents(executor: RentOpsQueryExecutor, options: { readonly limit?: number; readonly now?: Date } = {}): Promise<OutboxDispatchResult> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Outbox dispatch limit must be 1–1000");
  const now = (options.now ?? new Date()).toISOString();
  const result = await executor.query<{ dispatched: unknown; jobs_created: unknown }>(
    `WITH ready AS (
       SELECT id, organization_id, topic, payload FROM company_outbox
        WHERE dispatched_at IS NULL AND available_at <= $1
        ORDER BY available_at, created_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), created AS (
       INSERT INTO company_jobs (id, organization_id, job_key, topic, payload, state, run_after, outbox_event_id, created_at, updated_at)
       SELECT gen_random_uuid(), organization_id, 'outbox:' || id::text, topic, payload, 'queued', $1, id, $1, $1 FROM ready
       ON CONFLICT DO NOTHING
       RETURNING outbox_event_id
     ), marked AS (
       UPDATE company_outbox o SET dispatched_at = $1 FROM ready WHERE o.id = ready.id AND o.dispatched_at IS NULL
       RETURNING o.id
     )
     SELECT (SELECT COUNT(*) FROM marked) AS dispatched, (SELECT COUNT(*) FROM created) AS jobs_created`,
    [now, limit],
  );
  const row = result.rows[0];
  return { dispatched: Number(row?.dispatched ?? 0), jobsCreated: Number(row?.jobs_created ?? 0) };
}
