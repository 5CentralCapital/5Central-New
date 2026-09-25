import "dotenv/config";
import { createAccountingServices } from "./accounting";
import { createAccountingJobHandlers, qboPeriodicSyncJobs, qboWebhookFinalizationJobs } from "./accounting/worker-handlers";
import { createSystemJobHandlers, systemPeriodicJobs } from "./jobs/system-handlers";
import { createReviewJobHandlers, reviewPeriodicJobs } from "./review-cases/worker";
import { createWorkerRuntime, newWorkerId, type JobLogger } from "./jobs/worker-runtime";
import { createRentOpsRuntimeDatabase, type RentOpsRuntimeDatabase } from "./rent-ops/runtime-database";

/*
 * 5Central Ops background worker: a separate process that runs durable jobs
 * (QuickBooks sync, webhook object fetches, reconciled writes, outbox
 * dispatch, lease reaping and daily review-case detection). It never depends on a web request, and it
 * stops cleanly on SIGTERM by finishing or releasing its leased jobs.
 */

const logger: JobLogger = {
  info: (message, fields) => console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

async function database(): Promise<RentOpsRuntimeDatabase> {
  if (process.env.NODE_ENV === "production") return createRentOpsRuntimeDatabase({ environment: "production" });
  // Development shares the host pool exactly as the web server does.
  const [{ pool }, { createRentOpsPoolExecutor }] = await Promise.all([import("./db"), import("./rent-ops/runtime-database")]);
  return createRentOpsRuntimeDatabase({ environment: process.env.NODE_ENV, sharedExecutor: createRentOpsPoolExecutor(pool) });
}

async function main(): Promise<void> {
  // Production cutover starts held until web/database/document readback passes.
  // Changing the gate requires an operator environment update and redeploy.
  if (process.env.WORKER_START_GATE === "hold") {
    const timer = setInterval(() => undefined, 60_000);
    const stop = () => { clearInterval(timer); process.exit(0); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    logger.info("worker held for cutover verification");
    return;
  }
  if (process.env.WORKER_START_GATE && process.env.WORKER_START_GATE !== "open") throw new Error("invalid_worker_start_gate");
  const executor = await database();
  const services = createAccountingServices(executor);
  if (services.qbo.status !== "configured") logger.warn("QuickBooks is not configured; QuickBooks jobs will wait", { reason: services.qbo.reason });
  const runtime = createWorkerRuntime({
    executor,
    workerId: process.env.WORKER_ID && /^[A-Za-z0-9_.:@-]{1,160}$/.test(process.env.WORKER_ID) ? process.env.WORKER_ID : newWorkerId("5central-ops"),
    release: process.env.RENDER_GIT_COMMIT ?? process.env.WORKER_RELEASE,
    batchSize: positiveInteger(process.env.WORKER_BATCH_SIZE, 4, 10),
    pollIntervalMs: positiveInteger(process.env.WORKER_POLL_MS, 1_000, 60_000),
    maxIdleIntervalMs: positiveInteger(process.env.WORKER_MAX_IDLE_MS, 15_000, 300_000),
    handlers: { ...createSystemJobHandlers(), ...createAccountingJobHandlers({ services }), ...createReviewJobHandlers({ executor }) },
    periodic: [...systemPeriodicJobs(), ...qboPeriodicSyncJobs({ executor, services }), ...qboWebhookFinalizationJobs(), ...reviewPeriodicJobs({ executor })],
    logger,
  });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("worker stopping", { signal });
    const grace = positiveInteger(process.env.WORKER_SHUTDOWN_GRACE_MS, 25_000, 120_000);
    void runtime.stop(grace).finally(() => executor.close().catch(() => undefined)).finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await runtime.start();
}

main().catch(error => {
  logger.error("worker failed to start", { code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "worker_start_failed" });
  process.exit(1);
});
