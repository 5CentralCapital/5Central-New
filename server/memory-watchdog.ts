import type { RequestHandler } from "express";
import v8 from "node:v8";
import { sanitizeApiPathForLogging } from "./request-logging";

/**
 * Production crashed twice (Sept 30 and Oct 4, 2026) with "JavaScript heap out
 * of memory" while no logged request was running: memory sat flat near 400 MB
 * for days, then something filled the heap in under a minute. The request log
 * only records finished /api requests, so the request (or MCP call) that was
 * still running when the process died never appears.
 *
 * This module keeps a small table of in-flight requests and, when heap use
 * crosses a threshold, logs those requests with their age. It records metadata
 * only (method, sanitized path, MCP JSON-RPC method and tool name), never
 * bodies or query strings.
 */

export interface InFlightRequest {
  method: string;
  path: string;
  startedAt: number;
  mcp?: string;
}

export interface InFlightSnapshot {
  method: string;
  path: string;
  ageMs: number;
  mcp?: string;
}

export class InFlightRequests {
  private nextId = 0;
  private readonly requests = new Map<number, InFlightRequest>();

  start(entry: InFlightRequest): number {
    const id = ++this.nextId;
    this.requests.set(id, entry);
    return id;
  }

  annotate(id: number, mcp: string): void {
    const entry = this.requests.get(id);
    if (entry) entry.mcp = mcp;
  }

  finish(id: number): void {
    this.requests.delete(id);
  }

  get size(): number {
    return this.requests.size;
  }

  /** Oldest first: a request that has been running longest is the likeliest cause. */
  snapshot(now: number, limit = 20): InFlightSnapshot[] {
    return Array.from(this.requests.values())
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, limit)
      .map(entry => ({
        method: entry.method,
        path: entry.path,
        ageMs: now - entry.startedAt,
        ...(entry.mcp ? { mcp: entry.mcp } : {}),
      }));
  }
}

/** The web process's shared registry: index.ts tracks, the /mcp route annotates. */
export const inFlightRequests = new InFlightRequests();

const MCP_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;

/** "tools/call get_qbo_customer_ledger", or the bare JSON-RPC method. Never arguments. */
export function describeMcpBody(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  const parts: string[] = [];
  for (const message of messages.slice(0, 5)) {
    if (!message || typeof message !== "object") continue;
    const method = (message as { method?: unknown }).method;
    if (typeof method !== "string" || !MCP_TOOL_NAME.test(method.replace("/", "_"))) continue;
    const name = (message as { params?: { name?: unknown } }).params?.name;
    parts.push(typeof name === "string" && MCP_TOOL_NAME.test(name) ? `${method} ${name}` : method);
  }
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * Tracks every request from arrival until the connection closes. Mount it
 * first, before body parsers, so a request that dies mid-parse is still seen.
 */
export function trackInFlightRequests(registry: InFlightRequests, now: () => number = Date.now): RequestHandler {
  return (req, res, next) => {
    const id = registry.start({ method: req.method, path: sanitizeApiPathForLogging(req.path), startedAt: now() });
    res.locals.inFlightRequestId = id;
    const done = () => registry.finish(id);
    res.once("finish", done);
    res.once("close", done);
    next();
  };
}

/** Records the MCP method and tool name once the /mcp body has been parsed. */
export function annotateMcpRequest(registry: InFlightRequests): RequestHandler {
  return (req, res, next) => {
    const id = res.locals.inFlightRequestId;
    const description = describeMcpBody(req.body);
    if (description) {
      res.locals.mcpDescription = description;
      if (typeof id === "number") registry.annotate(id, description);
    }
    next();
  };
}

export interface MemoryReading {
  heapUsed: number;
  heapLimit: number;
  rss: number;
}

export function readMemory(): MemoryReading {
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, heapLimit: v8.getHeapStatistics().heap_size_limit, rss: usage.rss };
}

export interface MemoryWatchdogOptions {
  registry: InFlightRequests;
  log: (line: string) => void;
  read?: () => MemoryReading;
  now?: () => number;
  /** Fraction of the V8 heap limit at which to start reporting. */
  warnRatio?: number;
  /** Report again only after heap use has grown by this fraction of the limit. */
  stepRatio?: number;
}

const MiB = 1024 * 1024;

/**
 * One check. Returns the ratio it reported at, so the caller can avoid
 * repeating the same report every tick while heap stays high.
 */
export function checkMemory(options: MemoryWatchdogOptions, lastReportedRatio: number): number {
  const read = options.read ?? readMemory;
  const now = options.now ?? Date.now;
  const warnRatio = options.warnRatio ?? 0.6;
  const stepRatio = options.stepRatio ?? 0.1;
  const reading = read();
  const ratio = reading.heapLimit > 0 ? reading.heapUsed / reading.heapLimit : 0;
  if (ratio < warnRatio) return ratio < warnRatio - stepRatio ? 0 : lastReportedRatio;
  if (lastReportedRatio > 0 && ratio < lastReportedRatio + stepRatio) return lastReportedRatio;
  options.log(JSON.stringify({
    level: "warn",
    message: "heap pressure",
    heapUsedMiB: Math.round(reading.heapUsed / MiB),
    heapLimitMiB: Math.round(reading.heapLimit / MiB),
    rssMiB: Math.round(reading.rss / MiB),
    heapPercent: Math.round(ratio * 100),
    inFlightCount: options.registry.size,
    inFlight: options.registry.snapshot(now()),
  }));
  return ratio;
}

/** Starts the periodic check. The timer is unref'd so it never holds the process open. */
export function startMemoryWatchdog(options: MemoryWatchdogOptions & { intervalMs?: number }): () => void {
  let lastReportedRatio = 0;
  const timer = setInterval(() => {
    try {
      lastReportedRatio = checkMemory(options, lastReportedRatio);
    } catch {
      // Diagnostics must never take the server down.
    }
  }, options.intervalMs ?? 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
