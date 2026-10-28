/**
 * How long the background worker sleeps between bursts when it finds no work.
 *
 * Neon bills compute for every minute the database is awake and suspends it
 * only after five quiet minutes. A worker that polls every few seconds keeps it
 * awake around the clock, so by default the worker wakes every 30 minutes,
 * drains every due job, and goes back to sleep. Set WORKER_CYCLE_MS to change
 * the cycle (1 minute to 6 hours), or to 0 to poll continuously.
 */
export const DEFAULT_WORKER_CYCLE_MS = 30 * 60_000;
const MIN_CYCLE_MS = 60_000;
const MAX_CYCLE_MS = 6 * 3_600_000;

export function workerCycleMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.WORKER_CYCLE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_WORKER_CYCLE_MS;
  const parsed = Number(raw);
  if (parsed === 0) return 0;
  return Number.isSafeInteger(parsed) && parsed >= MIN_CYCLE_MS && parsed <= MAX_CYCLE_MS ? parsed : DEFAULT_WORKER_CYCLE_MS;
}

/** A worker counts as alive if it reported within two cycles (and at least two minutes). */
export function workerAliveWindowMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return Math.max(2 * 60_000, 2 * workerCycleMs(env) + 60_000);
}
