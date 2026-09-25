import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  JOB_STATES,
  jobKeySchema,
  jobListQuerySchema,
  jobTopicSchema,
  type JobAttempt,
  type JobDetail,
  type JobListQuery,
  type JobListResponse,
  type JobState,
  type JobSummary,
} from "../../shared/accounting/operations";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { redactJobError } from "./redact";

/*
 * Durable, database-backed job queue (migration 046). Workers claim with
 * FOR UPDATE SKIP LOCKED under a time-bound lease; every transition is fenced
 * by state, lease owner and attempt number, so a worker that lost its lease
 * can never complete, fail or checkpoint a job another worker now owns.
 */

export const DEFAULT_JOB_LEASE_MS = 120_000;
export const DEFAULT_JOB_MAX_ATTEMPTS = 8;
export const DEFAULT_BACKOFF = { baseMs: 5_000, maxMs: 60 * 60_000 } as const;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const WORKER_ID = /^[A-Za-z0-9_.:@-]{1,160}$/;

export interface JobRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly jobKey: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly state: JobState;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAfter: string;
  readonly leaseOwner: string | null;
  readonly leaseUntil: string | null;
  readonly checkpoint: Record<string, unknown> | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly result: Record<string, unknown> | null;
  readonly outboxEventId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface EnqueueJobInput {
  readonly jobKey: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId?: string | null;
  readonly runAfter?: Date | string;
  /** Lower runs sooner (0–1000, default 100). */
  readonly priority?: number;
  readonly maxAttempts?: number;
  /**
   * When set, a still-pending job of the same topic with this key absorbs the
   * request instead of inserting a second job; `merge` may extend its payload.
   */
  readonly coalesceKey?: string;
  readonly merge?: (existing: Record<string, unknown>) => Record<string, unknown>;
}

export interface EnqueueJobResult {
  readonly job: JobRecord;
  readonly created: boolean;
  readonly coalesced: boolean;
}

/** A handler failure that must not be retried (bad input, wrong environment). */
export class PermanentJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PermanentJobError";
    this.code = code;
  }
}

/** A handler failure with an explicit earliest retry, e.g. a provider 429 cooldown. */
export class RetryLaterJobError extends Error {
  readonly code: string;
  readonly retryAfterMs: number;
  constructor(code: string, message: string, retryAfterMs: number) {
    super(message);
    this.name = "RetryLaterJobError";
    this.code = code;
    this.retryAfterMs = Math.max(0, Math.min(retryAfterMs, 24 * 60 * 60_000));
  }
}

export class JobQueueError extends Error {
  readonly code: "job_validation" | "job_key_conflict" | "job_not_found";
  constructor(code: JobQueueError["code"], message: string) {
    super(message);
    this.name = "JobQueueError";
    this.code = code;
  }
}

export interface JobBackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Exponential backoff with bounded jitter: the delay for attempt n is
 * uniformly within [50%, 100%] of min(max, base·2^(n−1)).
 */
export function computeJobBackoffMs(attempt: number, options: JobBackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(Math.trunc(attempt) - 1, 30));
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling * (0.5 + sample * 0.5));
}

export interface JobQueueOptions {
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly backoff?: JobBackoffOptions;
}

const columns = `id, organization_id, job_key, topic, payload, state, priority, attempts, max_attempts, run_after,
  lease_owner, lease_until, checkpoint, last_error_code, last_error_message, result, outbox_event_id,
  created_at, updated_at, started_at, finished_at`;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  throw new JobQueueError("job_validation", "Job storage returned an invalid timestamp");
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new JobQueueError("job_validation", "Job storage returned an invalid integer");
  return parsed;
}

export function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    organizationId: row.organization_id === null || row.organization_id === undefined ? null : String(row.organization_id),
    jobKey: String(row.job_key),
    topic: String(row.topic),
    payload: jsonObject(row.payload) ?? {},
    state: String(row.state) as JobState,
    priority: integer(row.priority),
    attempts: integer(row.attempts),
    maxAttempts: integer(row.max_attempts),
    runAfter: iso(row.run_after),
    leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    leaseUntil: nullableIso(row.lease_until),
    checkpoint: jsonObject(row.checkpoint),
    lastErrorCode: row.last_error_code === null || row.last_error_code === undefined ? null : String(row.last_error_code),
    lastErrorMessage: row.last_error_message === null || row.last_error_message === undefined ? null : String(row.last_error_message),
    result: jsonObject(row.result),
    outboxEventId: row.outbox_event_id === null || row.outbox_event_id === undefined ? null : String(row.outbox_event_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: nullableIso(row.started_at),
    finishedAt: nullableIso(row.finished_at),
  };
}

export function jobSummary(job: JobRecord): JobSummary {
  return {
    id: job.id, organizationId: job.organizationId as JobSummary["organizationId"], jobKey: job.jobKey, topic: job.topic, state: job.state,
    priority: job.priority, attempts: job.attempts, maxAttempts: job.maxAttempts, runAfter: job.runAfter as JobSummary["runAfter"],
    leaseOwner: job.leaseOwner, leaseUntil: job.leaseUntil as JobSummary["leaseUntil"], lastErrorCode: job.lastErrorCode, lastErrorMessage: job.lastErrorMessage,
    hasCheckpoint: job.checkpoint !== null, outboxEventId: job.outboxEventId, createdAt: job.createdAt as JobSummary["createdAt"],
    updatedAt: job.updatedAt as JobSummary["updatedAt"], startedAt: job.startedAt as JobSummary["startedAt"], finishedAt: job.finishedAt as JobSummary["finishedAt"],
  };
}

export function assertJobPayload(payload: unknown): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new JobQueueError("job_validation", "Job payload must be a JSON object");
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) throw new JobQueueError("job_validation", "Job payload must be a plain JSON object");
  let serialized: string;
  try { serialized = JSON.stringify(payload); } catch { throw new JobQueueError("job_validation", "Job payload must be serializable JSON"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) throw new JobQueueError("job_validation", "Job payload is too large");
}

function workerId(value: string): string {
  if (typeof value !== "string" || !WORKER_ID.test(value)) throw new JobQueueError("job_validation", "Worker ID is invalid");
  return value;
}

function leaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60_000) throw new JobQueueError("job_validation", "Job lease must be between 1 second and 1 hour");
  return value;
}

interface JobCursor { readonly updatedAt: string; readonly id: string }

function encodeCursor(cursor: JobCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): JobCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt)) || !/^[0-9a-f-]{36}$/.test(parsed.id)) throw new Error("cursor");
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new JobQueueError("job_validation", "Job cursor is invalid");
  }
}

export interface ClaimJobsInput {
  readonly workerId: string;
  readonly topics: readonly string[];
  readonly limit?: number;
  readonly leaseMs?: number;
}

export type JobFailOutcome = { readonly state: "retry"; readonly runAfter: string } | { readonly state: "dead" } | { readonly state: "lost" };

export class PostgresJobQueue {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly backoff: JobBackoffOptions;

  constructor(private readonly executor: RentOpsQueryExecutor, options: JobQueueOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  /** Bind the same queue policy to a transaction executor (e.g. inside a command). */
  forExecutor(executor: RentOpsQueryExecutor): PostgresJobQueue {
    return new PostgresJobQueue(executor, { now: this.now, random: this.random, backoff: this.backoff });
  }

  backoffMs(attempt: number): number {
    return computeJobBackoffMs(attempt, this.backoff, this.random);
  }

  /** Idempotent by job key: a second enqueue returns the existing job unchanged. */
  async enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    const jobKey = jobKeySchema.parse(input.jobKey);
    const topic = jobTopicSchema.parse(input.topic);
    const coalesceKey = input.coalesceKey === undefined ? undefined : z.string().min(1).max(400).parse(input.coalesceKey);
    assertJobPayload(input.payload);
    const payload = coalesceKey === undefined ? { ...input.payload } : { ...input.payload, coalesceKey };
    assertJobPayload(payload);
    const priority = input.priority ?? 100;
    const maxAttempts = input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS;
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new JobQueueError("job_validation", "Job priority must be 0–1000");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new JobQueueError("job_validation", "Job max attempts must be 1–100");
    const now = this.now();
    const runAfter = input.runAfter === undefined ? now : new Date(input.runAfter);
    if (!Number.isFinite(runAfter.getTime())) throw new JobQueueError("job_validation", "Job run-after time is invalid");

    if (coalesceKey !== undefined) {
      // Lock the pending job for the read-merge-write: a concurrent merge
      // waits (or, under REPEATABLE READ, fails and is retried) instead of
      // overwriting this one's payload with a stale copy. Callers that merge
      // should run inside a transaction so the lock spans the update.
      const pending = await this.executor.query<Record<string, unknown>>(
        `SELECT ${columns} FROM company_jobs
          WHERE topic = $1 AND state IN ('queued','retry') AND payload->>'coalesceKey' = $2
          ORDER BY created_at, id LIMIT 1
          FOR UPDATE`,
        [topic, coalesceKey],
      );
      const existing = pending.rows[0] ? mapJobRow(pending.rows[0]) : null;
      if (existing) {
        const merged = input.merge ? { ...input.merge(existing.payload), coalesceKey } : existing.payload;
        assertJobPayload(merged);
        const updated = await this.executor.query<Record<string, unknown>>(
          `UPDATE company_jobs SET payload = $2::jsonb, updated_at = $3
            WHERE id = $1 AND state IN ('queued','retry') RETURNING ${columns}`,
          [existing.id, JSON.stringify(merged), now.toISOString()],
        );
        // If a worker claimed it between the read and the update, fall through
        // and insert a new job: the running one may have read stale state.
        if (updated.rows[0]) return { job: mapJobRow(updated.rows[0]), created: false, coalesced: true };
      }
    }

    const inserted = await this.executor.query<Record<string, unknown>>(
      `INSERT INTO company_jobs (id, organization_id, job_key, topic, payload, state, priority, max_attempts, run_after, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, $8, $9, $9)
       ON CONFLICT (job_key) DO NOTHING
       RETURNING ${columns}`,
      [randomUUID(), input.organizationId ?? null, jobKey, topic, JSON.stringify(payload), priority, maxAttempts, runAfter.toISOString(), now.toISOString()],
    );
    if (inserted.rows[0]) return { job: mapJobRow(inserted.rows[0]), created: true, coalesced: false };
    const existing = await this.executor.query<Record<string, unknown>>(`SELECT ${columns} FROM company_jobs WHERE job_key = $1`, [jobKey]);
    const row = existing.rows[0];
    if (!row) throw new JobQueueError("job_key_conflict", "Job key could not be resolved after a uniqueness conflict");
    const job = mapJobRow(row);
    if (job.topic !== topic || (job.organizationId ?? null) !== (input.organizationId ?? null)) {
      throw new JobQueueError("job_key_conflict", "Job key is already bound to different work");
    }
    return { job, created: false, coalesced: false };
  }

  /** Atomically lease up to `limit` ready jobs; concurrent workers receive disjoint sets. */
  async claim(input: ClaimJobsInput): Promise<readonly JobRecord[]> {
    const owner = workerId(input.workerId);
    const topics = input.topics.map(topic => jobTopicSchema.parse(topic));
    if (topics.length === 0) return [];
    const limit = input.limit ?? 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new JobQueueError("job_validation", "Claim limit must be 1–100");
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + leaseMs(input.leaseMs ?? DEFAULT_JOB_LEASE_MS));
    const result = await this.executor.query<Record<string, unknown>>(
      `WITH picked AS (
         SELECT id FROM company_jobs
          WHERE state IN ('queued','retry') AND run_after <= $1 AND topic = ANY($2::text[]) AND attempts < max_attempts
          ORDER BY priority, run_after, created_at, id
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE company_jobs j
            SET state = 'running', lease_owner = $4, lease_until = $5, attempts = j.attempts + 1,
                started_at = COALESCE(j.started_at, $1), updated_at = $1
           FROM picked WHERE j.id = picked.id
         RETURNING j.id, j.organization_id, j.job_key, j.topic, j.payload, j.state, j.priority, j.attempts, j.max_attempts, j.run_after,
                   j.lease_owner, j.lease_until, j.checkpoint, j.last_error_code, j.last_error_message, j.result, j.outbox_event_id,
                   j.created_at, j.updated_at, j.started_at, j.finished_at
       ), logged AS (
         -- A released attempt (outcome 'cancelled' by release()) did not count,
         -- so its number is reused by the next claim.
         INSERT INTO company_job_attempts (job_id, attempt, lease_owner, started_at)
         SELECT id, attempts, lease_owner, $1 FROM claimed
         ON CONFLICT (job_id, attempt) DO UPDATE
           SET lease_owner = EXCLUDED.lease_owner, started_at = EXCLUDED.started_at, finished_at = NULL, outcome = NULL, error_code = NULL
           WHERE company_job_attempts.outcome = 'cancelled' AND company_job_attempts.error_code = 'worker_shutdown'
         RETURNING job_id
       )
       SELECT claimed.* FROM claimed ORDER BY priority, run_after, created_at, id`,
      [now.toISOString(), topics, limit, owner, leaseUntil.toISOString()],
    );
    return result.rows.map(mapJobRow);
  }

  /** Extend a held lease. Returns false when the lease was lost to the reaper or another worker. */
  async heartbeat(jobId: string, owner: string, extendMs = DEFAULT_JOB_LEASE_MS): Promise<boolean> {
    const now = this.now();
    const result = await this.executor.query(
      `UPDATE company_jobs SET lease_until = $3, updated_at = $4
        WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND lease_until >= $4
        RETURNING id`,
      [jobId, workerId(owner), new Date(now.getTime() + leaseMs(extendMs)).toISOString(), now.toISOString()],
    );
    return result.rows.length === 1;
  }

  /** Persist resumable progress for the attempt that holds the lease. */
  async checkpoint(jobId: string, owner: string, checkpoint: Record<string, unknown>): Promise<boolean> {
    assertJobPayload(checkpoint);
    const result = await this.executor.query(
      `UPDATE company_jobs SET checkpoint = $3::jsonb, updated_at = $4
        WHERE id = $1 AND state = 'running' AND lease_owner = $2 RETURNING id`,
      [jobId, workerId(owner), JSON.stringify(checkpoint), this.now().toISOString()],
    );
    return result.rows.length === 1;
  }

  async complete(jobId: string, owner: string, result: Record<string, unknown> = {}): Promise<boolean> {
    assertJobPayload(result);
    const now = this.now().toISOString();
    const updated = await this.executor.query(
      `WITH done AS (
         UPDATE company_jobs SET state = 'succeeded', result = $3::jsonb, lease_owner = NULL, lease_until = NULL,
                finished_at = $4, updated_at = $4
          WHERE id = $1 AND state = 'running' AND lease_owner = $2
         RETURNING id, attempts
       ), logged AS (
         UPDATE company_job_attempts a SET finished_at = $4, outcome = 'succeeded'
           FROM done WHERE a.job_id = done.id AND a.attempt = done.attempts
         RETURNING a.job_id
       )
       SELECT id FROM done`,
      [jobId, workerId(owner), JSON.stringify(result), now],
    );
    return updated.rows.length === 1;
  }

  /**
   * Record a failed attempt: retry with backoff, or dead-letter once the
   * attempt budget is spent (or immediately for a permanent error).
   */
  async fail(jobId: string, owner: string, error: unknown, options: { readonly permanent?: boolean; readonly retryAfterMs?: number } = {}): Promise<JobFailOutcome> {
    const leaseOwner = workerId(owner);
    const current = await this.executor.query<{ attempts: unknown; max_attempts: unknown }>(
      `SELECT attempts, max_attempts FROM company_jobs WHERE id = $1 AND state = 'running' AND lease_owner = $2`,
      [jobId, leaseOwner],
    );
    const row = current.rows[0];
    if (!row) return { state: "lost" };
    const attempts = integer(row.attempts);
    const permanent = options.permanent === true || error instanceof PermanentJobError;
    const dead = permanent || attempts >= integer(row.max_attempts);
    const redacted = redactJobError(error);
    const now = this.now();
    const explicitDelay = options.retryAfterMs ?? (error instanceof RetryLaterJobError ? error.retryAfterMs : 0);
    const delay = Math.max(this.backoffMs(attempts), explicitDelay);
    const runAfter = new Date(now.getTime() + delay).toISOString();
    const updated = await this.executor.query(
      `WITH target AS (
         UPDATE company_jobs
            SET state = $4, run_after = CASE WHEN $4 = 'retry' THEN $5::timestamptz ELSE run_after END,
                finished_at = CASE WHEN $4 = 'dead' THEN $6::timestamptz ELSE NULL END,
                lease_owner = NULL, lease_until = NULL, last_error_code = $7, last_error_message = $8, updated_at = $6
          WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3
         RETURNING id, attempts
       ), logged AS (
         UPDATE company_job_attempts a SET finished_at = $6, outcome = $4, error_code = $7
           FROM target WHERE a.job_id = target.id AND a.attempt = target.attempts
         RETURNING a.job_id
       )
       SELECT id FROM target`,
      [jobId, leaseOwner, attempts, dead ? "dead" : "retry", runAfter, now.toISOString(), redacted.code, redacted.message],
    );
    if (updated.rows.length !== 1) return { state: "lost" };
    return dead ? { state: "dead" } : { state: "retry", runAfter };
  }

  /**
   * Graceful shutdown: hand an unfinished job back without waiting for lease
   * expiry. A release does not consume an attempt (the worker chose to stop,
   * the job did not fail), so a job released on its last attempt stays
   * claimable. The released attempt row is marked `cancelled`; the next claim
   * reuses that attempt number.
   */
  async release(jobId: string, owner: string): Promise<boolean> {
    const now = this.now().toISOString();
    const updated = await this.executor.query(
      `WITH target AS (
         UPDATE company_jobs SET state = 'retry', run_after = $3, lease_owner = NULL, lease_until = NULL,
                attempts = GREATEST(attempts - 1, 0),
                last_error_code = 'worker_shutdown', last_error_message = 'The worker stopped before this attempt finished', updated_at = $3
          WHERE id = $1 AND state = 'running' AND lease_owner = $2
         RETURNING id, attempts + 1 AS released_attempt
       ), logged AS (
         UPDATE company_job_attempts a SET finished_at = $3, outcome = 'cancelled', error_code = 'worker_shutdown'
           FROM target WHERE a.job_id = target.id AND a.attempt = target.released_attempt
         RETURNING a.job_id
       )
       SELECT id FROM target`,
      [jobId, workerId(owner), now],
    );
    return updated.rows.length === 1;
  }

  /** Return expired leases to retry (or dead-letter them when out of attempts). */
  async reapExpiredLeases(limit = 100): Promise<{ readonly retried: number; readonly dead: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new JobQueueError("job_validation", "Reap limit must be 1–1000");
    const now = this.now();
    const expired = await this.executor.query<{ id: unknown; attempts: unknown; max_attempts: unknown; lease_owner: unknown }>(
      `SELECT id, attempts, max_attempts, lease_owner FROM company_jobs
        WHERE state = 'running' AND lease_until < $1
        ORDER BY lease_until, id LIMIT $2`,
      [now.toISOString(), limit],
    );
    let retried = 0;
    let dead = 0;
    for (const row of expired.rows) {
      const attempts = integer(row.attempts);
      const toDead = attempts >= integer(row.max_attempts);
      const runAfter = new Date(now.getTime() + this.backoffMs(attempts)).toISOString();
      const updated = await this.executor.query(
        `WITH target AS (
           UPDATE company_jobs
              SET state = $4, run_after = CASE WHEN $4 = 'retry' THEN $5::timestamptz ELSE run_after END,
                  finished_at = CASE WHEN $4 = 'dead' THEN $6::timestamptz ELSE NULL END,
                  lease_owner = NULL, lease_until = NULL, last_error_code = 'lease_expired',
                  last_error_message = 'The worker lease expired before the attempt finished', updated_at = $6
            WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND attempts = $3 AND lease_until < $6
           RETURNING id, attempts
         ), logged AS (
           UPDATE company_job_attempts a SET finished_at = $6, outcome = 'lease_expired', error_code = 'lease_expired'
             FROM target WHERE a.job_id = target.id AND a.attempt = target.attempts
           RETURNING a.job_id
         )
         SELECT id FROM target`,
        [String(row.id), String(row.lease_owner), attempts, toDead ? "dead" : "retry", runAfter, now.toISOString()],
      );
      if (updated.rows.length === 1) { if (toDead) dead += 1; else retried += 1; }
    }
    // A pending job whose attempt budget is already spent can never be
    // claimed (claim requires attempts < max_attempts). Dead-letter it so an
    // operator sees it and can requeue it, instead of it waiting forever.
    const exhausted = await this.executor.query(
      `WITH picked AS (
         SELECT id FROM company_jobs
          WHERE state IN ('queued','retry') AND attempts >= max_attempts
          ORDER BY updated_at, id LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE company_jobs j
          SET state = 'dead', finished_at = $1, updated_at = $1,
              last_error_code = COALESCE(j.last_error_code, 'attempts_exhausted'),
              last_error_message = COALESCE(j.last_error_message, 'The job has no attempts left')
         FROM picked WHERE j.id = picked.id AND j.state IN ('queued','retry') AND j.attempts >= j.max_attempts
       RETURNING j.id`,
      [now.toISOString(), limit],
    );
    dead += exhausted.rows.length;
    return { retried, dead };
  }

  /** Operator recovery: return a dead job to the queue with a fresh attempt budget. */
  async requeue(jobId: string, organizationId: string, additionalAttempts: number): Promise<JobRecord | null> {
    if (!Number.isInteger(additionalAttempts) || additionalAttempts < 1 || additionalAttempts > 20) throw new JobQueueError("job_validation", "Additional attempts must be 1–20");
    const now = this.now().toISOString();
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE company_jobs SET state = 'queued', run_after = $4, finished_at = NULL,
              max_attempts = LEAST(100, attempts + $3), updated_at = $4
        WHERE id = $1 AND organization_id = $2 AND state = 'dead' AND attempts < 100
        RETURNING ${columns}`,
      [jobId, organizationId, additionalAttempts, now],
    );
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  /** Operator cancel of work that is not currently running. */
  async cancel(jobId: string, organizationId: string): Promise<JobRecord | null> {
    const now = this.now().toISOString();
    const result = await this.executor.query<Record<string, unknown>>(
      `UPDATE company_jobs SET state = 'cancelled', finished_at = COALESCE(finished_at, $3), updated_at = $3
        WHERE id = $1 AND organization_id = $2 AND state IN ('queued','retry','dead')
        RETURNING ${columns}`,
      [jobId, organizationId, now],
    );
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async get(jobId: string, organizationId?: string | null): Promise<JobRecord | null> {
    const result = await this.executor.query<Record<string, unknown>>(
      `SELECT ${columns} FROM company_jobs WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
      [jobId, organizationId ?? null],
    );
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async getByKey(jobKey: string): Promise<JobRecord | null> {
    const result = await this.executor.query<Record<string, unknown>>(`SELECT ${columns} FROM company_jobs WHERE job_key = $1`, [jobKeySchema.parse(jobKey)]);
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async detail(jobId: string, organizationId: string): Promise<JobDetail | null> {
    const job = await this.get(jobId, organizationId);
    if (!job) return null;
    const attempts = await this.executor.query<Record<string, unknown>>(
      `SELECT attempt, lease_owner, started_at, finished_at, outcome, error_code
         FROM company_job_attempts WHERE job_id = $1 ORDER BY attempt`,
      [jobId],
    );
    const attemptHistory: JobAttempt[] = attempts.rows.map(row => ({
      attempt: integer(row.attempt),
      leaseOwner: String(row.lease_owner),
      startedAt: iso(row.started_at) as JobAttempt["startedAt"],
      finishedAt: nullableIso(row.finished_at) as JobAttempt["finishedAt"],
      outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome) as JobAttempt["outcome"],
      errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    }));
    return { ...jobSummary(job), payload: job.payload, result: job.result, checkpoint: job.checkpoint, attemptHistory };
  }

  /** Organization-scoped operator listing, newest activity first, with cursor paging. */
  async list(input: JobListQuery): Promise<JobListResponse> {
    const query = jobListQuerySchema.parse(input);
    const values: unknown[] = [query.organizationId];
    const where = ["organization_id = $1"];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (query.states) where.push(`state = ANY(${add([...query.states])}::text[])`);
    if (query.topics) where.push(`topic = ANY(${add([...query.topics])}::text[])`);
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      where.push(`(updated_at, id) < (${add(cursor.updatedAt)}::timestamptz, ${add(cursor.id)}::uuid)`);
    }
    const limit = add(query.limit + 1);
    const rows = await this.executor.query<Record<string, unknown>>(
      `SELECT ${columns} FROM company_jobs WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`,
      values,
    );
    const items = rows.rows.slice(0, query.limit).map(mapJobRow);
    const last = items.at(-1);
    const counts = await this.executor.query<{ state: string; count: unknown }>(
      `SELECT state, COUNT(*) AS count FROM company_jobs WHERE organization_id = $1 GROUP BY state`,
      [query.organizationId],
    );
    const tally = Object.fromEntries(JOB_STATES.map(state => [state, 0])) as Record<JobState, number>;
    for (const row of counts.rows) if ((JOB_STATES as readonly string[]).includes(row.state)) tally[row.state as JobState] = integer(row.count);
    return {
      items: items.map(jobSummary),
      nextCursor: rows.rows.length > query.limit && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
      counts: tally,
    };
  }
}
