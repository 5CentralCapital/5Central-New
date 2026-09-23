import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { DEFAULT_JOB_LEASE_MS, PermanentJobError, PostgresJobQueue, RetryLaterJobError, type JobRecord } from "./queue";
import { redactJobError } from "./redact";

/*
 * Separate-process worker runtime. It polls the durable queue, runs one
 * registered handler per claimed job while extending the lease, records a
 * worker heartbeat row, and schedules periodic work through idempotent,
 * time-bucketed job keys. Nothing here depends on an HTTP request or a
 * browser tab staying alive.
 */

export interface JobLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentJobLogger: JobLogger = { info() {}, warn() {}, error() {} };

export interface JobHandlerContext {
  readonly job: JobRecord;
  readonly workerId: string;
  /** Aborted when the lease is lost or the worker is shutting down. */
  readonly signal: AbortSignal;
  readonly queue: PostgresJobQueue;
  readonly executor: RentOpsQueryExecutor;
  readonly now: () => Date;
  checkpoint(value: Record<string, unknown>): Promise<void>;
}

export type JobHandler = (context: JobHandlerContext) => Promise<Record<string, unknown> | void>;

export interface JobHandlerDefinition {
  readonly handler: JobHandler;
  readonly leaseMs?: number;
}

export interface PeriodicJobRequest {
  /** Identifies the scope inside the key, e.g. a connection scope. */
  readonly keyPart: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId?: string | null;
  readonly priority?: number;
  readonly maxAttempts?: number;
}

export interface PeriodicJobDefinition {
  readonly topic: string;
  readonly keyPrefix: string;
  readonly bucketMs: number;
  /** Return the jobs due for this bucket; a single system job returns one request. */
  enumerate(now: Date): Promise<readonly PeriodicJobRequest[]>;
}

/** Time-bucket label used inside periodic job keys (UTC, minute precision). */
export function periodicBucketLabel(now: Date, bucketMs: number): string {
  const start = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
  const iso = start.toISOString();
  return bucketMs >= 3_600_000 && bucketMs % 3_600_000 === 0 ? iso.slice(0, 13) : iso.slice(0, 16);
}

export function periodicJobKey(definition: Pick<PeriodicJobDefinition, "keyPrefix" | "bucketMs">, keyPart: string, now: Date): string {
  return `${definition.keyPrefix}:${keyPart}:${periodicBucketLabel(now, definition.bucketMs)}`;
}

export interface WorkerRuntimeOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly handlers: Readonly<Record<string, JobHandlerDefinition>>;
  readonly queue?: PostgresJobQueue;
  readonly workerId?: string;
  readonly release?: string;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly maxIdleIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly schedulerIntervalMs?: number;
  readonly periodic?: readonly PeriodicJobDefinition[];
  readonly now?: () => Date;
  readonly logger?: JobLogger;
}

export interface WorkerCycleResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly lost: number;
}

export interface WorkerRuntime {
  readonly workerId: string;
  readonly topics: readonly string[];
  /** Claim and run one batch. Returns counts; never throws for handler failures. */
  runOnce(): Promise<WorkerCycleResult>;
  /** Enqueue due periodic jobs; idempotent within a time bucket. */
  scheduleDue(): Promise<number>;
  recordHeartbeat(): Promise<void>;
  /** Poll until stop() is called. */
  start(): Promise<void>;
  /** Stop claiming, wait up to graceMs for running handlers, then release their leases. */
  stop(graceMs?: number): Promise<void>;
}

export function newWorkerId(prefix = "worker"): string {
  const host = hostname().replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60) || "host";
  return `${prefix}:${host}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const now = options.now ?? (() => new Date());
  const queue = options.queue ?? new PostgresJobQueue(options.executor, { now });
  const workerId = options.workerId ?? newWorkerId();
  const logger = options.logger ?? silentJobLogger;
  const topics = Object.keys(options.handlers).sort();
  const batchSize = options.batchSize ?? 4;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const maxIdleIntervalMs = options.maxIdleIntervalMs ?? 15_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const schedulerIntervalMs = options.schedulerIntervalMs ?? 30_000;
  const startedAt = now();
  const inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let stopping = false;
  let wake: (() => void) | null = null;
  let loop: Promise<void> | null = null;
  let lastHeartbeat = 0;
  let lastSchedule = 0;

  async function runJob(job: JobRecord): Promise<"succeeded" | "failed" | "lost"> {
    const definition = options.handlers[job.topic];
    const controller = new AbortController();
    const leaseMs = definition?.leaseMs ?? DEFAULT_JOB_LEASE_MS;
    let leaseLost = false;
    const timer = setInterval(() => {
      void queue.heartbeat(job.id, workerId, leaseMs).then(held => {
        if (!held && !leaseLost) { leaseLost = true; controller.abort(new Error("lease_lost")); }
      }).catch(error => logger.warn("job lease heartbeat failed", { jobId: job.id, error: redactJobError(error).code }));
    }, Math.max(500, Math.floor(leaseMs / 3)));
    timer.unref?.();
    let outcome: "succeeded" | "failed" | "lost";
    const done = (async () => {
      try {
        if (!definition) throw new PermanentJobError("job_topic_unhandled", `No handler is registered for ${job.topic}`);
        const result = await definition.handler({
          job, workerId, signal: controller.signal, queue, executor: options.executor, now,
          checkpoint: async value => { if (!(await queue.checkpoint(job.id, workerId, value))) { leaseLost = true; controller.abort(new Error("lease_lost")); throw new Error("Job lease was lost"); } },
        });
        if (leaseLost || controller.signal.aborted) { outcome = "lost"; return; }
        outcome = await queue.complete(job.id, workerId, result ?? {}) ? "succeeded" : "lost";
      } catch (error) {
        if (leaseLost) { outcome = "lost"; return; }
        if (stopping && controller.signal.aborted) { outcome = "lost"; return; }
        const failed = await queue.fail(job.id, workerId, error, {
          permanent: error instanceof PermanentJobError,
          ...(error instanceof RetryLaterJobError ? { retryAfterMs: error.retryAfterMs } : {}),
        });
        const redacted = redactJobError(error);
        logger.warn("job attempt failed", { jobId: job.id, topic: job.topic, attempt: job.attempts, code: redacted.code, next: failed.state });
        outcome = failed.state === "lost" ? "lost" : "failed";
      } finally {
        clearInterval(timer);
      }
    })();
    inFlight.set(job.id, { controller, done });
    try { await done; } finally { inFlight.delete(job.id); }
    if (outcome! === "lost") logger.warn("job lease lost", { jobId: job.id, topic: job.topic });
    return outcome!;
  }

  async function runOnce(): Promise<WorkerCycleResult> {
    if (stopping || topics.length === 0) return { claimed: 0, succeeded: 0, failed: 0, lost: 0 };
    const jobs = await queue.claim({ workerId, topics, limit: batchSize, leaseMs: Math.max(...jobsLeases()) });
    const outcomes = await Promise.all(jobs.map(runJob));
    return {
      claimed: jobs.length,
      succeeded: outcomes.filter(value => value === "succeeded").length,
      failed: outcomes.filter(value => value === "failed").length,
      lost: outcomes.filter(value => value === "lost").length,
    };
  }

  function jobsLeases(): number[] {
    return [DEFAULT_JOB_LEASE_MS, ...Object.values(options.handlers).map(definition => definition.leaseMs ?? DEFAULT_JOB_LEASE_MS)];
  }

  async function scheduleDue(): Promise<number> {
    let created = 0;
    const current = now();
    for (const definition of options.periodic ?? []) {
      try {
        for (const request of await definition.enumerate(current)) {
          const result = await queue.enqueue({
            jobKey: periodicJobKey(definition, request.keyPart, current),
            topic: definition.topic,
            payload: request.payload,
            organizationId: request.organizationId ?? null,
            ...(request.priority === undefined ? {} : { priority: request.priority }),
            ...(request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts }),
          });
          if (result.created) created += 1;
        }
      } catch (error) {
        logger.error("periodic scheduling failed", { topic: definition.topic, code: redactJobError(error).code });
      }
    }
    return created;
  }

  async function recordHeartbeat(): Promise<void> {
    await options.executor.query(
      `INSERT INTO company_worker_heartbeats (worker_id, started_at, last_seen_at, release, topics)
       VALUES ($1, $2, $3, $4, $5::text[])
       ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, release = EXCLUDED.release, topics = EXCLUDED.topics`,
      [workerId, startedAt.toISOString(), now().toISOString(), options.release?.slice(0, 120) ?? null, topics],
    );
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });
  }

  async function run(): Promise<void> {
    let idleDelay = pollIntervalMs;
    try { await queue.reapExpiredLeases(); } catch (error) { logger.warn("startup reap failed", { code: redactJobError(error).code }); }
    while (!stopping) {
      const tick = Date.now();
      try {
        if (tick - lastHeartbeat >= heartbeatIntervalMs) { await recordHeartbeat(); lastHeartbeat = tick; }
        if (tick - lastSchedule >= schedulerIntervalMs) { await scheduleDue(); lastSchedule = tick; }
        const cycle = await runOnce();
        idleDelay = cycle.claimed > 0 ? 0 : Math.min(maxIdleIntervalMs, Math.max(pollIntervalMs, idleDelay * 2));
      } catch (error) {
        // Database outage or conflict: back off and keep the process alive.
        logger.error("worker cycle failed", { code: redactJobError(error).code });
        idleDelay = Math.min(maxIdleIntervalMs, Math.max(pollIntervalMs, idleDelay * 2));
      }
      if (!stopping && idleDelay > 0) await sleep(idleDelay);
    }
  }

  return {
    workerId,
    topics,
    runOnce,
    scheduleDue,
    recordHeartbeat,
    async start() {
      if (loop) return loop;
      logger.info("worker started", { workerId, topics });
      loop = run();
      return loop;
    },
    async stop(graceMs = 25_000) {
      stopping = true;
      wake?.();
      const running = [...inFlight.values()];
      const deadline = new Promise<"timeout">(resolve => { const timer = setTimeout(() => resolve("timeout"), graceMs); timer.unref?.(); });
      const settled = await Promise.race([Promise.all(running.map(entry => entry.done)).then(() => "done" as const), deadline]);
      if (settled === "timeout") {
        for (const [jobId, entry] of inFlight) {
          entry.controller.abort(new Error("worker_shutdown"));
          try { if (await queue.release(jobId, workerId)) logger.warn("job released at shutdown", { jobId }); }
          catch (error) { logger.error("job release failed; its lease will expire", { jobId, code: redactJobError(error).code }); }
        }
      }
      if (loop) await Promise.race([loop, new Promise(resolve => setTimeout(resolve, 1_000))]);
      try { await options.executor.query(`DELETE FROM company_worker_heartbeats WHERE worker_id = $1`, [workerId]); }
      catch (error) { logger.warn("worker heartbeat cleanup failed", { code: redactJobError(error).code }); }
      logger.info("worker stopped", { workerId });
    },
  };
}
