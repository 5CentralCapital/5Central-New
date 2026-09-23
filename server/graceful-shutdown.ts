import type { Server } from "node:http";

/*
 * Render (like most hosts) replaces an instance by sending SIGTERM after the
 * new instance passes its health check, then SIGKILL after the shutdown
 * delay (30 s by default). Without a handler Node exits immediately and cuts
 * off requests that are still running, which can interrupt an OAuth callback
 * or a webhook acknowledgement.
 *
 * On the first SIGTERM/SIGINT this marks the instance not ready (so /readyz
 * turns 503 and the proxy stops routing to it), stops accepting connections,
 * closes idle keep-alive sockets, lets in-flight requests finish, runs the
 * cleanup (database pools) and exits. A second signal, or the grace period
 * elapsing, exits at once.
 */

export interface GracefulShutdownOptions {
  readonly server: Server;
  readonly markNotReady: () => void;
  readonly cleanup?: () => Promise<void>;
  readonly graceMs?: number;
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => void;
  readonly signals?: readonly NodeJS.Signals[];
  readonly processLike?: Pick<NodeJS.Process, "on" | "off">;
}

export function shutdownGraceMs(value: string | undefined, fallback = 25_000): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 290_000 ? parsed : fallback;
}

export function installGracefulShutdown(options: GracefulShutdownOptions): { readonly shutdown: (signal: string) => Promise<void>; readonly dispose: () => void } {
  const log = options.log ?? (() => undefined);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceMs = options.graceMs ?? 25_000;
  const target = options.processLike ?? process;
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  let draining: Promise<void> | null = null;
  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const shutdown = (signal: string): Promise<void> => {
    if (draining) {
      log(`received ${signal} again; exiting now`);
      finish(0);
      return draining;
    }
    log(`received ${signal}; draining in-flight requests`);
    options.markNotReady();
    draining = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        log("shutdown grace period elapsed; closing remaining connections");
        options.server.closeAllConnections?.();
        finish(0);
        resolve();
      }, graceMs);
      timer.unref?.();
      options.server.close(async () => {
        clearTimeout(timer);
        try {
          await options.cleanup?.();
        } catch {
          log("cleanup after shutdown failed");
        }
        finish(0);
        resolve();
      });
      // Idle keep-alive sockets would otherwise hold server.close() open.
      options.server.closeIdleConnections?.();
    });
    return draining;
  };

  const handlers = signals.map(signal => {
    const handler = () => { void shutdown(signal); };
    target.on(signal, handler);
    return [signal, handler] as const;
  });
  return {
    shutdown,
    dispose: () => { for (const [signal, handler] of handlers) target.off(signal, handler); },
  };
}
