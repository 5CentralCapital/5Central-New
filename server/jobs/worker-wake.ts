import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/*
 * Wake the sleeping background worker without touching the database.
 *
 * Between bursts the worker sleeps so the Neon database can scale to zero.
 * Work that people start in the web app (a QuickBooks refresh, a webhook, an
 * MCP command) must not wait for the next scheduled wake, so the web process
 * counts every completed write request in memory and the worker checks that
 * counter over HTTP every few seconds while it sleeps. The check never reaches
 * Postgres, so it costs no database compute.
 *
 * The endpoint is guarded by a token both services derive from the runtime
 * database URL they already share, so it needs no extra configuration. It
 * reveals only a counter; anything without the token gets a plain 404.
 */

export const WORKER_WAKE_PATH = "/internal/worker-wake";
export const WORKER_WAKE_HEADER = "x-worker-wake";
const TOKEN_CONTEXT = "5central-ops:worker-wake:v1";
const QUIET_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function workerWakeToken(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const secret = env.RENT_OPS_RUNTIME_DATABASE_URL;
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(TOKEN_CONTEXT).digest("hex");
}

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export interface WorkerWakeSignal {
  readonly boot: string;
  readonly seq: () => number;
  readonly bump: () => void;
}

export function createWorkerWakeSignal(): WorkerWakeSignal {
  let seq = 0;
  return { boot: randomUUID(), seq: () => seq, bump: () => { seq += 1; } };
}

/** Count each finished write request; jobs and outbox rows it created are committed by then. */
export function trackWorkerWake(signal: WorkerWakeSignal) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!QUIET_METHODS.has(request.method)) response.on("finish", () => { if (response.statusCode < 500) signal.bump(); });
    next();
  };
}

export function workerWakeHandler(signal: WorkerWakeSignal, token: string | undefined) {
  return (request: Request, response: Response) => {
    if (!token || !sameToken(request.get(WORKER_WAKE_HEADER), token)) { response.status(404).end(); return; }
    response.set("Cache-Control", "no-store").json({ boot: signal.boot, seq: signal.seq() });
  };
}

/**
 * Worker side: returns true once the web counter has moved since the last
 * check. The first successful check only records the starting point. Any
 * network or HTTP failure returns false, so the worker falls back to its
 * scheduled wake.
 */
export function createWorkerWakeWatcher(options: {
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Called once if the web app refuses the token, so a mismatch shows in the logs. */
  readonly onRejected?: (status: number) => void;
}): () => Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  const endpoint = new URL(WORKER_WAKE_PATH, options.url).toString();
  let last: string | null = null;
  let reported = false;
  return async () => {
    try {
      const response = await doFetch(endpoint, {
        headers: { [WORKER_WAKE_HEADER]: options.token },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        if (response.status === 404 && !reported) { reported = true; options.onRejected?.(response.status); }
        return false;
      }
      const body = await response.json() as { boot?: unknown; seq?: unknown };
      if (typeof body.boot !== "string" || typeof body.seq !== "number") return false;
      const current = `${body.boot}:${body.seq}`;
      const changed = last !== null && current !== last;
      last = current;
      return changed;
    } catch {
      return false;
    }
  };
}
