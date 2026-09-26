import assert from "node:assert/strict";
import test from "node:test";
import { QuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { PermanentJobError, RetryLaterJobError } from "../jobs/queue";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import type { AccountingServices } from "./index";
import { createAccountingJobHandlers } from "./worker-handlers";
import { QBO_SYNC_TOPIC } from "./webhook-ingest";
import { AccountingError } from "./errors";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  legalEntityId: "20000000-0000-4000-8000-000000000001",
  environment: "sandbox" as const,
  realmId: "9130350000000001",
};

const executor = {
  query: async () => ({ rows: [{ status: "active" }] }),
} as unknown as RentOpsQueryExecutor;

function job() {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId: scope.organizationId,
    jobKey: "qbo-sync-test",
    topic: QBO_SYNC_TOPIC,
    payload: { ...scope, events: [] },
    state: "running" as const,
    priority: 100,
    attempts: 1,
    maxAttempts: 6,
    runAfter: "2026-09-23T12:00:00.000Z",
    leaseOwner: "worker-test",
    leaseUntil: "2026-09-23T12:02:00.000Z",
    checkpoint: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    result: null,
    outboxEventId: null,
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
    startedAt: "2026-09-23T12:00:00.000Z",
    finishedAt: null,
  };
}

async function runProviderFailure(error: Error): Promise<unknown> {
  const services = {
    qbo: {
      status: "configured",
      environment: "sandbox",
      capabilityGate: { isEnabled: async () => true },
      createProviderSync: () => ({
        bootstrapRead: async () => ({}),
        syncChanges: async () => { throw error; },
      }),
    },
  } as unknown as AccountingServices;
  const handler = createAccountingJobHandlers({ services })[QBO_SYNC_TOPIC]!.handler;
  return handler({
    job: job() as never,
    workerId: "worker-test",
    signal: new AbortController().signal,
    queue: {} as never,
    executor,
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    checkpoint: async () => {},
  });
}

test("transient OAuth token failures are retried by the QBO worker", async () => {
  await assert.rejects(
    () => runProviderFailure(new QuickBooksIntegrationError("quickbooks_oauth", "private", { status: 429, retryable: true, retryAfterMs: 90_000 })),
    (error: unknown) => error instanceof RetryLaterJobError && error.code === "quickbooks_rate_limited" && error.retryAfterMs === 90_000,
  );
  await assert.rejects(
    () => runProviderFailure(new QuickBooksIntegrationError("quickbooks_oauth", "private", { status: 503, retryable: true })),
    (error: unknown) => error instanceof RetryLaterJobError && error.code === "quickbooks_oauth_retry" && error.retryAfterMs === 60_000,
  );
});

test("non-transient OAuth failures still require reconnect", async () => {
  await assert.rejects(
    () => runProviderFailure(new QuickBooksIntegrationError("quickbooks_oauth", "private", { status: 400, retryable: false })),
    (error: unknown) => error instanceof PermanentJobError && error.code === "qbo_needs_reconnect",
  );
});

test("only a proven same-revision body mismatch stops automatic retries", async () => {
  await assert.rejects(
    () => runProviderFailure(new AccountingError("accounting_conflict", "QBO source object version changed after it was mirrored", { reason: "qbo_source_revision_mismatch" })),
    (error: unknown) => error instanceof PermanentJobError && error.code === "qbo_source_revision_mismatch",
  );
  const transient = new AccountingError("accounting_conflict", "Concurrent operation");
  await assert.rejects(() => runProviderFailure(transient), error => error === transient);
});
