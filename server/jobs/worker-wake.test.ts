import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { createWorkerWakeSignal, createWorkerWakeWatcher, trackWorkerWake, WORKER_WAKE_HEADER, WORKER_WAKE_PATH, workerWakeHandler, workerWakeToken } from "./worker-wake";

async function serve() {
  const signal = createWorkerWakeSignal();
  const token = workerWakeToken({ RENT_OPS_RUNTIME_DATABASE_URL: "postgres://synthetic@localhost/db" })!;
  const app = express();
  app.get(WORKER_WAKE_PATH, workerWakeHandler(signal, token));
  app.use(trackWorkerWake(signal));
  app.get("/api/read", (_req, res) => { res.json({ ok: true }); });
  app.post("/api/write", (_req, res) => { res.json({ ok: true }); });
  app.post("/api/broken", (_req, res) => { res.status(500).end(); });
  const server = await new Promise<import("node:http").Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, token, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("the wake token is derived from the shared runtime database URL and absent without it", () => {
  const a = workerWakeToken({ RENT_OPS_RUNTIME_DATABASE_URL: "postgres://a@h/db" });
  assert.equal(a, workerWakeToken({ RENT_OPS_RUNTIME_DATABASE_URL: "postgres://a@h/db" }));
  assert.notEqual(a, workerWakeToken({ RENT_OPS_RUNTIME_DATABASE_URL: "postgres://b@h/db" }));
  assert.ok(a && !a.includes("postgres"));
  assert.equal(workerWakeToken({}), undefined);
});

test("only successful write requests wake the worker, and the endpoint needs the token", async () => {
  const web = await serve();
  try {
    assert.equal((await fetch(`${web.url}${WORKER_WAKE_PATH}`)).status, 404);
    assert.equal((await fetch(`${web.url}${WORKER_WAKE_PATH}`, { headers: { [WORKER_WAKE_HEADER]: "wrong" } })).status, 404);
    const watch = createWorkerWakeWatcher({ url: web.url, token: web.token });
    assert.equal(await watch(), false, "the first check only records the starting point");
    await fetch(`${web.url}/api/read`);
    assert.equal(await watch(), false, "reads do not wake the worker");
    await fetch(`${web.url}/api/broken`, { method: "POST" });
    assert.equal(await watch(), false, "failed writes do not wake the worker");
    await fetch(`${web.url}/api/write`, { method: "POST" });
    assert.equal(await watch(), true);
    assert.equal(await watch(), false, "one write wakes the worker once");
  } finally {
    await web.close();
  }
});

test("an unreachable web app never wakes the worker or throws", async () => {
  const watch = createWorkerWakeWatcher({ url: "http://127.0.0.1:9", token: "t", timeoutMs: 500 });
  assert.equal(await watch(), false);
  assert.equal(await watch(), false);
});
