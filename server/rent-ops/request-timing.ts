import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { RequestHandler, Response } from "express";

const durationNames = ["db", "decode", "map", "validate", "derive"] as const;
const countNames = ["db_calls", "batch_calls"] as const;
type DurationName = typeof durationNames[number];
type CountName = typeof countNames[number];
interface TimingState {
  started: number;
  durations: Partial<Record<DurationName, number>>;
  counts: Partial<Record<CountName, number>>;
}
const timings = new AsyncLocalStorage<TimingState>();

export function countRentOpsTiming(name: CountName): void {
  const state = timings.getStore();
  if (state) state.counts[name] = (state.counts[name] ?? 0) + 1;
}

export function measureRentOps<T>(name: DurationName, work: () => T): T {
  const state = timings.getStore();
  if (!state) return work();
  const start = performance.now();
  try { return work(); }
  finally { state.durations[name] = (state.durations[name] ?? 0) + performance.now() - start; }
}

export async function measureRentOpsAsync<T>(name: DurationName, work: () => Promise<T>): Promise<T> {
  const state = timings.getStore();
  if (!state) return work();
  const start = performance.now();
  try { return await work(); }
  finally { state.durations[name] = (state.durations[name] ?? 0) + performance.now() - start; }
}

function timingHeader(state: TimingState): string {
  const duration = (value: number) => Math.max(0, value).toFixed(2);
  return [
    ...durationNames.filter(name => state.durations[name] !== undefined).map(name => `${name};dur=${duration(state.durations[name]!)}`),
    `total;dur=${duration(performance.now() - state.started)}`,
    ...countNames.filter(name => state.counts[name] !== undefined).map(name => `${name};desc="${state.counts[name]}"`),
  ].join(", ");
}

/** Install only after manager authorization. No data, identifiers, SQL or
 * request parameters enter the fixed numeric header; no metric is retained. */
export const rentOpsRequestTiming: RequestHandler = (req, res, next) => {
  if (req.method !== "GET" || !/^\/(?:workspace|dashboard|reports\/[^/]+|tenants\/[^/]+)$/.test(req.path)) { next(); return; }
  const state: TimingState = {started: performance.now(), durations: {}, counts: {}};
  const original = res.writeHead;
  res.writeHead = function (this: Response, ...args: any[]) {
    if (!this.headersSent) this.setHeader("Server-Timing", timingHeader(state));
    return original.apply(this, args as never);
  } as Response["writeHead"];
  timings.run(state, next);
};
