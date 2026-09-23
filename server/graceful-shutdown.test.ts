import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { EventEmitter } from "node:events";
import { installGracefulShutdown, shutdownGraceMs } from "./graceful-shutdown";

function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  return new Promise<{ server: typeof server; port: number }>(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port })));
}

function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", path: "/" }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("SIGTERM marks the instance not ready, lets an in-flight request finish, then cleans up and exits", async () => {
  let release!: () => void;
  const started = new Promise<void>(resolve => {
    void listen((_req, res) => {
      resolve();
      release = () => res.end("done");
    }).then(value => { context.server = value.server; context.port = value.port; });
  });
  const context: { server?: import("node:http").Server; port?: number } = {};
  while (!context.port) await new Promise(resolve => setTimeout(resolve, 5));
  const events: string[] = [];
  const signals = new EventEmitter();
  installGracefulShutdown({
    server: context.server!, graceMs: 5_000, processLike: signals as never,
    markNotReady: () => events.push("not-ready"),
    cleanup: async () => { events.push("cleanup"); },
    exit: code => events.push(`exit:${code}`),
  });
  const inFlight = get(context.port);
  await started;
  signals.emit("SIGTERM");
  assert.deepEqual(events, ["not-ready"]);
  // New connections are refused while draining.
  await assert.rejects(get(context.port));
  release();
  assert.deepEqual(await inFlight, { status: 200, body: "done" });
  while (!events.includes("exit:0")) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events, ["not-ready", "cleanup", "exit:0"]);
});

test("the grace period bounds a hung request and a second signal exits immediately", async () => {
  const { server, port } = await listen(() => { /* never responds */ });
  const events: string[] = [];
  const signals = new EventEmitter();
  installGracefulShutdown({ server, graceMs: 50, processLike: signals as never, markNotReady: () => events.push("not-ready"), exit: code => events.push(`exit:${code}`) });
  const hung = get(port).catch(() => "closed");
  await new Promise(resolve => setTimeout(resolve, 20));
  signals.emit("SIGTERM");
  assert.equal(await hung, "closed");
  assert.deepEqual(events, ["not-ready", "exit:0"]);

  const second = await listen(() => { /* never responds */ });
  const more: string[] = [];
  const signals2 = new EventEmitter();
  installGracefulShutdown({ server: second.server, graceMs: 10_000, processLike: signals2 as never, markNotReady: () => more.push("not-ready"), exit: code => more.push(`exit:${code}`) });
  const pending = get(second.port).catch(() => "closed");
  await new Promise(resolve => setTimeout(resolve, 20));
  signals2.emit("SIGTERM");
  signals2.emit("SIGTERM");
  assert.deepEqual(more, ["not-ready", "exit:0"]);
  second.server.closeAllConnections();
  await pending;
});

test("grace configuration is bounded", () => {
  assert.equal(shutdownGraceMs(undefined), 25_000);
  assert.equal(shutdownGraceMs("5000"), 5_000);
  assert.equal(shutdownGraceMs("10"), 25_000);
  assert.equal(shutdownGraceMs("999999"), 25_000);
});
