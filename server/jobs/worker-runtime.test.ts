import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { PermanentJobError, PostgresJobQueue } from "./queue";
import { createSystemJobHandlers, JOB_REAP_TOPIC, OUTBOX_DISPATCH_TOPIC, systemPeriodicJobs } from "./system-handlers";
import { createWorkerRuntime, periodicBucketLabel, periodicJobKey } from "./worker-runtime";

const ORG = SYNTHETIC_COMPANY.organizationId;

test("a worker cycle runs registered handlers, records results and failures, and ignores other topics", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const executor = await createSyntheticRuntimeExecutor(synthetic.db);
    const queue = new PostgresJobQueue(executor, { random: () => 0 });
    await queue.enqueue({ jobKey: "ok-1", topic: "demo.ok", payload: { value: 2 }, organizationId: ORG });
    await queue.enqueue({ jobKey: "bad-1", topic: "demo.bad", payload: {}, organizationId: ORG });
    await queue.enqueue({ jobKey: "perm-1", topic: "demo.permanent", payload: {}, organizationId: ORG });
    await queue.enqueue({ jobKey: "foreign-1", topic: "demo.unregistered", payload: {}, organizationId: ORG });
    const seen: string[] = [];
    const runtime = createWorkerRuntime({
      executor, queue, workerId: "worker-test", batchSize: 10,
      handlers: {
        "demo.ok": { handler: async ({ job, checkpoint }) => { seen.push(job.jobKey); await checkpoint({ step: 1 }); return { doubled: Number(job.payload.value) * 2 }; } },
        "demo.bad": { handler: async () => { throw new Error("transient provider outage"); } },
        "demo.permanent": { handler: async () => { throw new PermanentJobError("job_bad_scope", "Unknown connection"); } },
      },
    });
    assert.deepEqual(runtime.topics, ["demo.bad", "demo.ok", "demo.permanent"]);
    const cycle = await runtime.runOnce();
    assert.deepEqual(cycle, { claimed: 3, succeeded: 1, failed: 2, lost: 0 });
    const ok = await queue.getByKey("ok-1");
    assert.equal(ok?.state, "succeeded");
    assert.deepEqual(ok?.result, { doubled: 4 });
    assert.deepEqual(ok?.checkpoint, { step: 1 });
    assert.equal((await queue.getByKey("bad-1"))?.state, "retry");
    assert.equal((await queue.getByKey("perm-1"))?.state, "dead");
    assert.equal((await queue.getByKey("foreign-1"))?.state, "queued", "a worker never claims a topic it cannot run");
    assert.deepEqual(seen, ["ok-1"]);
    await runtime.recordHeartbeat();
    const heartbeat = await executor.query<{ worker_id: string; topics: string[] }>("SELECT worker_id, topics FROM company_worker_heartbeats");
    assert.equal(heartbeat.rows[0]?.worker_id, "worker-test");
    await runtime.stop(10);
    assert.equal((await executor.query("SELECT 1 FROM company_worker_heartbeats")).rows.length, 0, "a graceful stop removes the heartbeat");
  } finally {
    await synthetic.close();
  }
});

test("periodic scheduling is idempotent within a time bucket across workers", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const executor = await createSyntheticRuntimeExecutor(synthetic.db);
    let current = new Date("2026-09-23T14:05:10Z");
    const now = () => current;
    const queue = new PostgresJobQueue(executor, { now });
    const periodic = systemPeriodicJobs({ outboxBucketMs: 60_000, reapBucketMs: 300_000 });
    const workerA = createWorkerRuntime({ executor, queue, now, workerId: "worker-a", handlers: createSystemJobHandlers(), periodic });
    const workerB = createWorkerRuntime({ executor, queue, now, workerId: "worker-b", handlers: createSystemJobHandlers(), periodic });
    assert.equal(await workerA.scheduleDue(), 2);
    assert.equal(await workerB.scheduleDue(), 0, "the second worker finds the same bucket keys");
    assert.ok(await queue.getByKey(`${OUTBOX_DISPATCH_TOPIC}:system:2026-09-23T14:05`));
    assert.ok(await queue.getByKey(`${JOB_REAP_TOPIC}:system:2026-09-23T14:05`));
    current = new Date("2026-09-23T14:06:01Z");
    assert.equal(await workerB.scheduleDue(), 1, "only the one-minute bucket rolled over");
    assert.equal(periodicBucketLabel(new Date("2026-09-23T14:59:59Z"), 3_600_000), "2026-09-23T14");
    assert.equal(periodicJobKey({ keyPrefix: "qbo.sync", bucketMs: 3_600_000 }, "scope", new Date("2026-09-23T14:30:00Z")), "qbo.sync:scope:2026-09-23T14");

    // Seed an outbox event and let the scheduled system job dispatch it.
    const operationId = randomUUID();
    await synthetic.executor.query(`INSERT INTO company_command_receipts (operation_id, organization_id, actor_id, channel, command_kind, idempotency_key, payload_sha256) VALUES ($1,$2,'demo-admin','web','demo.command',$3,$4)`, [operationId, ORG, `idem-${operationId}`, "c".repeat(64)]);
    const outboxId = randomUUID();
    await synthetic.executor.query(`INSERT INTO company_outbox (id, organization_id, operation_id, event_key, topic, payload, payload_sha256, available_at) VALUES ($1,$2,$3,'evt','demo.outbox','{}'::jsonb,$4,$5)`, [outboxId, ORG, operationId, "d".repeat(64), "2026-09-23T14:00:00Z"]);
    const cycle = await workerA.runOnce();
    assert.equal(cycle.failed, 0);
    assert.ok(cycle.succeeded >= 1);
    assert.equal((await queue.getByKey(`outbox:${outboxId}`))?.topic, "demo.outbox");
  } finally {
    await synthetic.close();
  }
});

test("SIGTERM-style stop releases a job whose handler outlives the grace period", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const executor = await createSyntheticRuntimeExecutor(synthetic.db);
    const queue = new PostgresJobQueue(executor);
    await queue.enqueue({ jobKey: "slow-1", topic: "demo.slow", payload: {}, organizationId: ORG });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    let observedAbort = false;
    const runtime = createWorkerRuntime({
      executor, queue, workerId: "worker-slow", pollIntervalMs: 5, maxIdleIntervalMs: 10, heartbeatIntervalMs: 1_000_000, schedulerIntervalMs: 1_000_000,
      handlers: {
        "demo.slow": { handler: ({ signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener("abort", () => { observedAbort = true; reject(new Error("aborted")); }); }) },
      },
    });
    void runtime.start();
    await running;
    await runtime.stop(20);
    assert.equal(observedAbort, true);
    const job = await queue.getByKey("slow-1");
    assert.equal(job?.state, "retry");
    assert.equal(job?.lastErrorCode, "worker_shutdown");
    assert.equal(job?.leaseOwner, null);
    const attempts = await executor.query<{ outcome: string }>("SELECT outcome FROM company_job_attempts WHERE job_id = $1", [job!.id]);
    assert.deepEqual(attempts.rows.map(row => row.outcome), ["retry"]);
  } finally {
    await synthetic.close();
  }
});
