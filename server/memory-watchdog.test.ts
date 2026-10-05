import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  InFlightRequests,
  annotateMcpRequest,
  checkMemory,
  describeMcpBody,
  trackInFlightRequests,
} from "./memory-watchdog";

const MiB = 1024 * 1024;

function fakeResponse() {
  const res = new EventEmitter() as EventEmitter & { locals: Record<string, unknown> };
  res.locals = {};
  return res;
}

test("in-flight tracking adds a request on arrival and removes it on finish or close", () => {
  const registry = new InFlightRequests();
  let now = 1_000;
  const track = trackInFlightRequests(registry, () => now);
  const first = fakeResponse();
  const second = fakeResponse();
  track({ method: "POST", path: "/mcp" } as never, first as never, () => undefined);
  now = 1_500;
  track({ method: "GET", path: "/api/rent-ops/public/applications/secret-token" } as never, second as never, () => undefined);
  assert.equal(registry.size, 2);
  const snapshot = registry.snapshot(2_000);
  assert.deepEqual(snapshot.map(entry => [entry.path, entry.ageMs]), [["/mcp", 1_000], ["/api/rent-ops/public/applications/:token", 500]]);
  first.emit("finish");
  first.emit("close");
  assert.equal(registry.size, 1);
  second.emit("close");
  assert.equal(registry.size, 0);
});

test("MCP annotation records the method and tool name, never arguments", () => {
  assert.equal(describeMcpBody({ jsonrpc: "2.0", method: "tools/call", params: { name: "get_qbo_customer_ledger", arguments: { customerId: "42" } } }), "tools/call get_qbo_customer_ledger");
  assert.equal(describeMcpBody([{ method: "tools/list" }, { method: "initialize" }]), "tools/list, initialize");
  assert.equal(describeMcpBody({ method: "tools/call", params: { name: "drop table; --" } }), "tools/call");
  assert.equal(describeMcpBody("not json-rpc"), undefined);

  const registry = new InFlightRequests();
  const res = fakeResponse();
  trackInFlightRequests(registry, () => 0)({ method: "POST", path: "/mcp" } as never, res as never, () => undefined);
  annotateMcpRequest(registry)({ body: { method: "tools/call", params: { name: "stage_mra_packet", arguments: { file: "x".repeat(100) } } } } as never, res as never, () => undefined);
  assert.equal(res.locals.mcpDescription, "tools/call stage_mra_packet");
  assert.deepEqual(registry.snapshot(10)[0], { method: "POST", path: "/mcp", ageMs: 10, mcp: "tools/call stage_mra_packet" });
  assert.doesNotMatch(JSON.stringify(registry.snapshot(10)), /xxxx/);
});

test("the watchdog reports heap pressure with in-flight requests, then only on further growth", () => {
  const registry = new InFlightRequests();
  registry.start({ method: "POST", path: "/mcp", startedAt: 0, mcp: "tools/call export_everything" });
  const lines: string[] = [];
  let heapUsed = 200 * MiB;
  const options = { registry, log: (line: string) => lines.push(line), now: () => 30_000, read: () => ({ heapUsed, heapLimit: 1_000 * MiB, rss: heapUsed + 150 * MiB }) };

  let last = checkMemory(options, 0);
  assert.equal(lines.length, 0, "normal heap stays quiet");

  heapUsed = 650 * MiB;
  last = checkMemory(options, last);
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.equal(report.message, "heap pressure");
  assert.equal(report.heapPercent, 65);
  assert.deepEqual(report.inFlight, [{ method: "POST", path: "/mcp", ageMs: 30_000, mcp: "tools/call export_everything" }]);

  heapUsed = 700 * MiB;
  last = checkMemory(options, last);
  assert.equal(lines.length, 1, "no repeat until heap grows another step");

  heapUsed = 760 * MiB;
  last = checkMemory(options, last);
  assert.equal(lines.length, 2);

  heapUsed = 300 * MiB;
  last = checkMemory(options, last);
  assert.equal(last, 0, "recovery re-arms the watchdog");
});
