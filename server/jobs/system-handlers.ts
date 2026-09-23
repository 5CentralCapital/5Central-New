import { dispatchOutboxEvents } from "./outbox-dispatcher";
import type { JobHandlerDefinition, PeriodicJobDefinition } from "./worker-runtime";

export const OUTBOX_DISPATCH_TOPIC = "outbox.dispatch";
export const JOB_REAP_TOPIC = "jobs.reap";

/** Queue housekeeping topics every worker can run. */
export function createSystemJobHandlers(options: { readonly batchSize?: number; readonly maxBatches?: number } = {}): Record<string, JobHandlerDefinition> {
  const batchSize = options.batchSize ?? 200;
  const maxBatches = options.maxBatches ?? 10;
  return {
    [OUTBOX_DISPATCH_TOPIC]: {
      leaseMs: 60_000,
      handler: async ({ executor, now, signal }) => {
        let dispatched = 0;
        let jobsCreated = 0;
        for (let batch = 0; batch < maxBatches && !signal.aborted; batch += 1) {
          const result = await dispatchOutboxEvents(executor, { limit: batchSize, now: now() });
          dispatched += result.dispatched;
          jobsCreated += result.jobsCreated;
          if (result.dispatched < batchSize) break;
        }
        return { dispatched, jobsCreated };
      },
    },
    [JOB_REAP_TOPIC]: {
      leaseMs: 60_000,
      handler: async ({ queue }) => {
        const result = await queue.reapExpiredLeases(500);
        return { retried: result.retried, dead: result.dead };
      },
    },
  };
}

/** One system job per time bucket; the job key makes scheduling idempotent across workers. */
export function systemPeriodicJobs(options: { readonly outboxBucketMs?: number; readonly reapBucketMs?: number } = {}): PeriodicJobDefinition[] {
  const system = async () => [{ keyPart: "system", payload: {}, organizationId: null, priority: 10, maxAttempts: 3 }];
  return [
    { topic: OUTBOX_DISPATCH_TOPIC, keyPrefix: OUTBOX_DISPATCH_TOPIC, bucketMs: options.outboxBucketMs ?? 60_000, enumerate: system },
    { topic: JOB_REAP_TOPIC, keyPrefix: JOB_REAP_TOPIC, bucketMs: options.reapBucketMs ?? 5 * 60_000, enumerate: system },
  ];
}
