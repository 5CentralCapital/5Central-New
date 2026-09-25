import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { dispatchOutboxEvents } from "./outbox-dispatcher";
import { computeJobBackoffMs, JobQueueError, PermanentJobError, PostgresJobQueue, RetryLaterJobError } from "./queue";
import { redactJobError, redactJobText } from "./redact";

const ORG = SYNTHETIC_COMPANY.organizationId;

function clock(start = "2026-09-23T12:00:00.000Z") {
  let current = new Date(start).getTime();
  return { now: () => new Date(current), advance: (ms: number) => { current += ms; } };
}

async function withDatabase(work: (executor: RentOpsQueryExecutor, raw: Awaited<ReturnType<typeof createSyntheticCompanyDatabase>>) => Promise<void>, runtime = true) {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const executor = runtime ? await createSyntheticRuntimeExecutor(synthetic.db) : synthetic.executor;
    await work(executor, synthetic);
  } finally {
    await synthetic.close();
  }
}

test("enqueue is idempotent by job key and refuses a key bound to other work", async () => {
  await withDatabase(async executor => {
    const queue = new PostgresJobQueue(executor);
    const first = await queue.enqueue({ jobKey: "k-1", topic: "demo.work", payload: { n: 1 }, organizationId: ORG });
    const again = await queue.enqueue({ jobKey: "k-1", topic: "demo.work", payload: { n: 2 }, organizationId: ORG });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.job.id, first.job.id);
    assert.deepEqual(again.job.payload, { n: 1 }, "the original payload is kept");
    await assert.rejects(() => queue.enqueue({ jobKey: "k-1", topic: "other.work", payload: {}, organizationId: ORG }), (error: unknown) => error instanceof JobQueueError && error.code === "job_key_conflict");
    await assert.rejects(() => queue.enqueue({ jobKey: "k-2", topic: "Bad Topic", payload: {} }));
    await assert.rejects(() => queue.enqueue({ jobKey: "k-3", topic: "demo.work", payload: [] as unknown as Record<string, unknown> }), /JSON object/);
  });
});

test("concurrent workers never claim the same job and every job is claimed exactly once", async () => {
  await withDatabase(async executor => {
    const queue = new PostgresJobQueue(executor);
    for (let index = 0; index < 12; index += 1) await queue.enqueue({ jobKey: `job-${index}`, topic: "demo.work", payload: { index }, organizationId: ORG });
    await queue.enqueue({ jobKey: "other-topic", topic: "demo.other", payload: {}, organizationId: ORG });
    const claimed: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const [a, b, c] = await Promise.all([
        queue.claim({ workerId: "worker-a", topics: ["demo.work"], limit: 3 }),
        queue.claim({ workerId: "worker-b", topics: ["demo.work"], limit: 3 }),
        queue.claim({ workerId: "worker-c", topics: ["demo.work"], limit: 3 }),
      ]);
      const ids = [...a, ...b, ...c].map(job => job.id);
      assert.equal(new Set(ids).size, ids.length, "no job is leased twice in the same round");
      claimed.push(...ids);
      for (const job of a) assert.equal(job.leaseOwner, "worker-a");
    }
    assert.equal(claimed.length, 12);
    assert.equal(new Set(claimed).size, 12);
    const attempts = await executor.query<{ count: string | number }>("SELECT COUNT(*) AS count FROM company_job_attempts");
    assert.equal(Number(attempts.rows[0]?.count), 12);
    const [job] = await queue.claim({ workerId: "worker-z", topics: ["demo.other"] });
    assert.ok(job);
    assert.equal(await queue.complete(job.id, "worker-a"), false, "a worker cannot complete a job it does not hold");
    assert.equal(await queue.checkpoint(job.id, "worker-a", { page: 2 }), false);
    assert.equal(await queue.checkpoint(job.id, "worker-z", { page: 2 }), true);
    assert.equal(await queue.complete(job.id, "worker-z", { ok: true }), true);
    const done = await queue.get(job.id);
    assert.equal(done?.state, "succeeded");
    assert.deepEqual(done?.checkpoint, { page: 2 });
    assert.ok(done?.finishedAt);
  });
});

test("an expired lease is reaped to retry, the stale worker is fenced out, and another worker resumes from the checkpoint", async () => {
  await withDatabase(async executor => {
    const time = clock();
    const queue = new PostgresJobQueue(executor, { now: time.now, random: () => 1 });
    const { job } = await queue.enqueue({ jobKey: "lease-1", topic: "demo.work", payload: {}, organizationId: ORG });
    const [held] = await queue.claim({ workerId: "worker-a", topics: ["demo.work"], leaseMs: 10_000 });
    assert.equal(held?.id, job.id);
    await queue.checkpoint(job.id, "worker-a", { cursor: "page-3" });
    time.advance(5_000);
    assert.equal(await queue.heartbeat(job.id, "worker-a", 10_000), true, "a live worker can extend its lease");
    time.advance(11_000);
    assert.deepEqual(await queue.reapExpiredLeases(), { retried: 1, dead: 0 });
    assert.equal(await queue.heartbeat(job.id, "worker-a"), false);
    assert.equal(await queue.complete(job.id, "worker-a"), false, "the crashed worker's late completion is rejected");
    assert.deepEqual(await queue.fail(job.id, "worker-a", new Error("late")), { state: "lost" });
    const reaped = await queue.get(job.id);
    assert.equal(reaped?.state, "retry");
    assert.equal(reaped?.lastErrorCode, "lease_expired");
    assert.equal(await queue.claim({ workerId: "worker-b", topics: ["demo.work"] }).then(jobs => jobs.length), 0, "retry waits for its backoff");
    time.advance(5_000);
    const [resumed] = await queue.claim({ workerId: "worker-b", topics: ["demo.work"] });
    assert.equal(resumed?.id, job.id);
    assert.equal(resumed?.attempts, 2);
    assert.deepEqual(resumed?.checkpoint, { cursor: "page-3" });
    const attempts = await executor.query<{ attempt: number; outcome: string | null; lease_owner: string }>("SELECT attempt, outcome, lease_owner FROM company_job_attempts WHERE job_id = $1 ORDER BY attempt", [job.id]);
    assert.deepEqual(attempts.rows.map(row => [row.attempt, row.outcome, row.lease_owner]), [[1, "lease_expired", "worker-a"], [2, null, "worker-b"]]);
  });
});

test("failures back off exponentially with bounded jitter and dead-letter after max attempts", async () => {
  for (const attempt of [1, 2, 3, 10, 40]) {
    const ceiling = Math.min(3_600_000, 5_000 * 2 ** Math.min(attempt - 1, 30));
    assert.equal(computeJobBackoffMs(attempt, undefined, () => 0), Math.round(ceiling * 0.5));
    assert.equal(computeJobBackoffMs(attempt, undefined, () => 1), ceiling);
    const sampled = computeJobBackoffMs(attempt);
    assert.ok(sampled >= ceiling * 0.5 && sampled <= ceiling);
  }
  await withDatabase(async executor => {
    const time = clock();
    const queue = new PostgresJobQueue(executor, { now: time.now, random: () => 0 });
    const { job } = await queue.enqueue({ jobKey: "flaky", topic: "demo.work", payload: {}, organizationId: ORG, maxAttempts: 3 });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [claimed] = await queue.claim({ workerId: "worker-a", topics: ["demo.work"] });
      assert.equal(claimed?.attempts, attempt);
      const outcome = await queue.fail(job.id, "worker-a", new Error(`Bearer abc.def.ghi failed with access_token=secret-${attempt}`));
      if (attempt < 3) {
        assert.equal(outcome.state, "retry");
        const delay = new Date((outcome as { runAfter: string }).runAfter).getTime() - time.now().getTime();
        delays.push(delay);
        time.advance(delay);
      } else {
        assert.equal(outcome.state, "dead");
      }
    }
    assert.deepEqual(delays, [2_500, 5_000]);
    const dead = await queue.get(job.id);
    assert.equal(dead?.state, "dead");
    assert.ok(dead?.finishedAt);
    assert.doesNotMatch(dead?.lastErrorMessage ?? "", /secret-3|abc\.def/);
    assert.equal((await queue.claim({ workerId: "worker-a", topics: ["demo.work"] })).length, 0, "dead jobs are never claimed");

    const { job: permanent } = await queue.enqueue({ jobKey: "bad-input", topic: "demo.work", payload: {}, organizationId: ORG });
    await queue.claim({ workerId: "worker-a", topics: ["demo.work"] });
    assert.deepEqual(await queue.fail(permanent.id, "worker-a", new PermanentJobError("job_bad_input", "No such scope")), { state: "dead" });

    const { job: throttled } = await queue.enqueue({ jobKey: "throttled", topic: "demo.work", payload: {}, organizationId: ORG });
    await queue.claim({ workerId: "worker-a", topics: ["demo.work"] });
    const retry = await queue.fail(throttled.id, "worker-a", new RetryLaterJobError("quickbooks_rate_limited", "cooldown", 60_000));
    assert.equal(retry.state, "retry");
    assert.equal(new Date((retry as { runAfter: string }).runAfter).getTime() - time.now().getTime(), 60_000, "an explicit cooldown beats a shorter backoff");
  });
});

test("operators requeue dead jobs with a new attempt budget and cancel only work that is not running", async () => {
  await withDatabase(async executor => {
    const queue = new PostgresJobQueue(executor, { random: () => 0 });
    const { job } = await queue.enqueue({ jobKey: "dead-1", topic: "demo.work", payload: {}, organizationId: ORG, maxAttempts: 1 });
    await queue.claim({ workerId: "worker-a", topics: ["demo.work"] });
    await queue.fail(job.id, "worker-a", new Error("boom"));
    assert.equal(await queue.requeue(job.id, randomUUID(), 2), null, "another organization cannot requeue it");
    const requeued = await queue.requeue(job.id, ORG, 2);
    assert.equal(requeued?.state, "queued");
    assert.equal(requeued?.maxAttempts, 3);
    assert.equal(requeued?.finishedAt, null);
    const [again] = await queue.claim({ workerId: "worker-b", topics: ["demo.work"] });
    assert.equal(again?.attempts, 2, "attempt numbering continues so the attempt ledger is never rewritten");
    assert.equal(await queue.cancel(job.id, ORG), null, "a running job cannot be cancelled");
    await queue.complete(job.id, "worker-b");
    assert.equal(await queue.requeue(job.id, ORG, 1), null, "only dead jobs can be requeued");

    const { job: waiting } = await queue.enqueue({ jobKey: "waiting", topic: "demo.work", payload: {}, organizationId: ORG, runAfter: new Date(Date.now() + 60_000) });
    const cancelled = await queue.cancel(waiting.id, ORG);
    assert.equal(cancelled?.state, "cancelled");
    assert.ok(cancelled?.finishedAt);
    const page = await queue.list({ organizationId: ORG, limit: 1 });
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = await queue.list({ organizationId: ORG, limit: 1, cursor: page.nextCursor! });
    assert.notEqual(next.items[0]?.id, page.items[0]?.id);
    assert.equal(page.counts.succeeded, 1);
    assert.equal(page.counts.cancelled, 1);
    const detail = await queue.detail(job.id, ORG);
    assert.deepEqual(detail?.attemptHistory.map(attempt => attempt.outcome), ["dead", "succeeded"]);
  });
});

test("pending jobs with the same coalesce key absorb later requests instead of duplicating work", async () => {
  await withDatabase(async executor => {
    const queue = new PostgresJobQueue(executor);
    const merge = (existing: Record<string, unknown>) => ({ ...existing, events: [...(existing.events as string[]), "e2"] });
    const first = await queue.enqueue({ jobKey: "fetch:e1", topic: "demo.fetch", payload: { events: ["e1"] }, organizationId: ORG, coalesceKey: "Bill:42" });
    const second = await queue.enqueue({ jobKey: "fetch:e2", topic: "demo.fetch", payload: { events: ["e2"] }, organizationId: ORG, coalesceKey: "Bill:42", merge });
    assert.equal(second.coalesced, true);
    assert.equal(second.job.id, first.job.id);
    assert.deepEqual(second.job.payload.events, ["e1", "e2"]);
    await queue.claim({ workerId: "worker-a", topics: ["demo.fetch"] });
    const third = await queue.enqueue({ jobKey: "fetch:e3", topic: "demo.fetch", payload: { events: ["e3"] }, organizationId: ORG, coalesceKey: "Bill:42", merge });
    assert.equal(third.created, true, "a running fetch may have read stale state, so a new job is queued");
  });
});

async function seedOutbox(executor: RentOpsQueryExecutor, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const operationId = randomUUID();
    const id = randomUUID();
    await executor.query(
      `INSERT INTO company_command_receipts (operation_id, organization_id, actor_id, channel, command_kind, idempotency_key, payload_sha256)
       VALUES ($1, $2, 'demo-admin', 'web', 'demo.command', $3, $4)`,
      [operationId, ORG, `idem-${id}`, "a".repeat(64)],
    );
    await executor.query(
      `INSERT INTO company_outbox (id, organization_id, operation_id, event_key, topic, payload, payload_sha256)
       VALUES ($1, $2, $3, $4, 'demo.outbox', $5::jsonb, $6)`,
      [id, ORG, operationId, `event-${id}`, JSON.stringify({ index }), "b".repeat(64)],
    );
    ids.push(id);
  }
  return ids;
}

test("outbox dispatch moves each event into exactly one job and replays are no-ops", async () => {
  await withDatabase(async (executor, raw) => {
    const ids = await seedOutbox(raw.executor, 5);
    // Simulate an earlier crash window: a job already exists for one event that is not yet marked.
    const queue = new PostgresJobQueue(executor);
    await executor.query(
      `INSERT INTO company_jobs (id, organization_id, job_key, topic, payload, state, outbox_event_id) VALUES ($1, $2, $3, 'demo.outbox', '{}'::jsonb, 'queued', $4)`,
      [randomUUID(), ORG, `outbox:${ids[0]}`, ids[0]],
    );
    const [first, second] = await Promise.all([dispatchOutboxEvents(executor, { limit: 3 }), dispatchOutboxEvents(executor, { limit: 3 })]);
    assert.equal(first.dispatched + second.dispatched, 5);
    assert.equal(first.jobsCreated + second.jobsCreated, 4);
    assert.deepEqual(await dispatchOutboxEvents(executor), { dispatched: 0, jobsCreated: 0 });
    const jobs = await executor.query<{ outbox_event_id: string; job_key: string; topic: string }>("SELECT outbox_event_id, job_key, topic FROM company_jobs WHERE outbox_event_id IS NOT NULL ORDER BY job_key");
    assert.equal(jobs.rows.length, 5);
    assert.deepEqual(new Set(jobs.rows.map(row => row.outbox_event_id)), new Set(ids));
    for (const row of jobs.rows) assert.equal(row.job_key, `outbox:${row.outbox_event_id}`);
    const pending = await executor.query("SELECT 1 FROM company_outbox WHERE dispatched_at IS NULL");
    assert.equal(pending.rows.length, 0);
    const claimed = await queue.claim({ workerId: "worker-a", topics: ["demo.outbox"], limit: 10 });
    assert.equal(claimed.length, 5);
  });
});

test("job errors are redacted to a stable code and a bounded message", () => {
  const error = Object.assign(new Error(`Refresh failed: refresh_token=rt-123 Authorization: Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl postgres://user:pw@db.example/x ${"x".repeat(600)}`), { code: "QuickBooks_Unauthorized" });
  const redacted = redactJobError(error);
  assert.equal(redacted.code, "quickbooks_unauthorized");
  assert.ok(redacted.message.length <= 500);
  assert.doesNotMatch(redacted.message, /rt-123|eyJhbGciOi|user:pw|db\.example/);
  assert.equal(redactJobText("client_secret: abc123 ok"), "client_secret: [redacted] ok");
  assert.equal(redactJobError("plain").code, "job_failed");
});

test("a job released at shutdown on its last attempt stays claimable and does not spend the attempt", async () => {
  await withDatabase(async executor => {
    const time = clock();
    const queue = new PostgresJobQueue(executor, { now: time.now });
    const { job } = await queue.enqueue({ jobKey: "release-last", topic: "demo.work", payload: {}, organizationId: ORG, maxAttempts: 1 });
    const [claimed] = await queue.claim({ workerId: "w1", topics: ["demo.work"] });
    assert.equal(claimed?.attempts, 1);
    assert.equal(await queue.release(job.id, "w1"), true);
    const released = await queue.get(job.id);
    assert.equal(released?.state, "retry");
    assert.equal(released?.attempts, 0, "a release refunds the attempt");
    assert.equal(released?.lastErrorCode, "worker_shutdown");
    const history = await executor.query<{ attempt: number; outcome: string | null }>("SELECT attempt, outcome FROM company_job_attempts WHERE job_id = $1", [job.id]);
    assert.deepEqual(history.rows.map(row => [row.attempt, row.outcome]), [[1, "cancelled"]]);

    time.advance(1_000);
    assert.deepEqual(await queue.reapExpiredLeases(), { retried: 0, dead: 0 }, "a released job with budget left is not dead-lettered");
    const [again] = await queue.claim({ workerId: "w2", topics: ["demo.work"] });
    assert.equal(again?.id, job.id, "the released job is claimed again");
    assert.equal(again?.attempts, 1);
    assert.equal(await queue.complete(job.id, "w2", { ok: true }), true);
    const final = await executor.query<{ attempt: number; outcome: string | null; lease_owner: string }>("SELECT attempt, outcome, lease_owner FROM company_job_attempts WHERE job_id = $1", [job.id]);
    assert.deepEqual(final.rows.map(row => [row.attempt, row.outcome, row.lease_owner]), [[1, "succeeded", "w2"]]);
    assert.equal(await queue.release(job.id, "w2"), false, "a finished job cannot be released");
  });
});

test("the reaper dead-letters a pending job whose attempt budget is already spent", async () => {
  await withDatabase(async (executor, synthetic) => {
    const time = clock();
    const queue = new PostgresJobQueue(executor, { now: time.now });
    const stuck = randomUUID();
    // A row left by the earlier release behaviour: pending, but attempts = max_attempts.
    await synthetic.executor.query(`INSERT INTO company_jobs (id, organization_id, job_key, topic, payload, state, attempts, max_attempts, last_error_code, last_error_message)
      VALUES ($1,$2,'legacy-stuck','demo.work','{}'::jsonb,'retry',1,1,'worker_shutdown','The worker stopped before this attempt finished')`, [stuck, ORG]);
    assert.deepEqual(await queue.claim({ workerId: "w1", topics: ["demo.work"] }), [], "claim never picks an exhausted job");
    assert.deepEqual(await queue.reapExpiredLeases(), { retried: 0, dead: 1 });
    const dead = await queue.get(stuck);
    assert.equal(dead?.state, "dead");
    assert.ok(dead?.finishedAt);
    assert.equal(dead?.lastErrorCode, "worker_shutdown");
    const requeued = await queue.requeue(stuck, ORG, 1);
    assert.equal(requeued?.state, "queued", "an operator can recover it");
    assert.equal((await queue.claim({ workerId: "w1", topics: ["demo.work"] }))[0]?.id, stuck);
  });
});

test("coalescing locks the pending job for its read-merge-write", async () => {
  await withDatabase(async executor => {
    const statements: string[] = [];
    const spy: RentOpsQueryExecutor = { query: (text, values) => { statements.push(text); return executor.query(text, values); } };
    const queue = new PostgresJobQueue(spy);
    await queue.enqueue({ jobKey: "lock-1", topic: "demo.fetch", payload: { events: [1] }, organizationId: ORG, coalesceKey: "object-1" });
    statements.length = 0;
    const merged = await queue.enqueue({ jobKey: "lock-2", topic: "demo.fetch", payload: { events: [2] }, organizationId: ORG, coalesceKey: "object-1", merge: existing => ({ ...existing, events: [...(existing.events as number[]), 2] }) });
    assert.equal(merged.coalesced, true);
    assert.deepEqual(merged.job.payload.events, [1, 2]);
    assert.match(statements[0] ?? "", /payload->>'coalesceKey' = \$2[\s\S]*FOR UPDATE\s*$/, "the pending job is read FOR UPDATE");
  });
});
