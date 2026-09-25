import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createReviewJobHandlers, reviewPeriodicJobs, REVIEW_FINANCIAL_CORRECTION_TOPIC } from "./worker";
import { REVIEW_DETECTION_JOB_TOPIC } from "./job";

const job = (topic: string, payload: Record<string, unknown>) => ({
  id: "00000000-0000-4000-8000-000000000099", organizationId: SYNTHETIC_COMPANY.organizationId, jobKey: `${topic}:test`, topic, payload,
  state: "running", priority: 100, attempts: 1, maxAttempts: 3, runAfter: new Date().toISOString(), leaseOwner: "w", leaseUntil: new Date().toISOString(),
  checkpoint: null, lastErrorCode: null, lastErrorMessage: null, result: null, outboxEventId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
}) as never;

test("worker runs scheduled review detection per organization and acknowledges routed financial corrections", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    const executor = await createSyntheticRuntimeExecutor(database.db);
    const handlers = createReviewJobHandlers({ executor });
    const context = (record: unknown) => ({ job: record, workerId: "w", signal: new AbortController().signal, queue: {} as never, executor, now: () => new Date(), checkpoint: async () => undefined }) as never;
    const detected = await handlers[REVIEW_DETECTION_JOB_TOPIC].handler(context(job(REVIEW_DETECTION_JOB_TOPIC, { organizationId: SYNTHETIC_COMPANY.organizationId })));
    assert.ok(detected && "summary" in detected);
    const again = await handlers[REVIEW_DETECTION_JOB_TOPIC].handler(context(job(REVIEW_DETECTION_JOB_TOPIC, { organizationId: SYNTHETIC_COMPANY.organizationId })));
    assert.deepEqual((again as { summary: { opened: number } }).summary.opened, 0, "detection is idempotent");
    const ack = await handlers[REVIEW_FINANCIAL_CORRECTION_TOPIC].handler(context(job(REVIEW_FINANCIAL_CORRECTION_TOPIC, { caseId: "00000000-0000-4000-8000-000000000001" })));
    assert.deepEqual({ acknowledged: (ack as Record<string, unknown>).acknowledged, caseState: (ack as Record<string, unknown>).caseState }, { acknowledged: true, caseState: "missing" });
    const [periodic] = reviewPeriodicJobs({ executor });
    const due = await periodic.enumerate(new Date());
    assert.deepEqual(due.map(item => item.organizationId), [SYNTHETIC_COMPANY.organizationId]);
  } finally { await database.close(); }
});
