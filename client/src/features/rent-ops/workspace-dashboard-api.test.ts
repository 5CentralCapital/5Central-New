import assert from "node:assert/strict";
import test from "node:test";
import { decodeRentOpsWorkspaceDashboard, loadRentOpsWorkspaceDashboard } from "./api";
import { syntheticRentOpsSnapshot } from "../../../../server/rent-ops/fixtures/synthetic";
import { deriveDashboardSummary, deriveRentRoll, deriveDelinquency } from "../../../../server/rent-ops/domain/reports";
import { serializeDashboardSummary } from "../../../../server/rent-ops/presentation/entities";
import { serializeReportEnvelope } from "../../../../server/rent-ops/presentation/reports";

const filters = { asOfDate: "2026-08-15" };
function fixture() {
  const source = syntheticRentOpsSnapshot();
  return JSON.parse(JSON.stringify({
    summary: serializeDashboardSummary(deriveDashboardSummary(source, filters)),
    rentRoll: serializeReportEnvelope({ report: "rent-roll", filters, rows: deriveRentRoll(source, filters) }),
    delinquency: serializeReportEnvelope({ report: "delinquency", filters, rows: deriveDelinquency(source, filters) }),
  }));
}

test("aggregate dashboard decodes actual serialized summary and both report envelopes", () => {
  const payload = fixture();
  const decoded = decodeRentOpsWorkspaceDashboard(payload);
  assert.equal(decoded.summary.unitCount, payload.summary.unitCount);
  assert.ok(decoded.reports["rent-roll"].length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.reports["rent-roll"])), payload.rentRoll.rows);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.reports.delinquency)), payload.delinquency.rows);
  assert.deepEqual(decodeRentOpsWorkspaceDashboard({ data: payload }), decoded);
});

test("aggregate dashboard rejects leaked fields, crossed report types and malformed required data", () => {
  const mutations = [
    (p: any) => { p.unexpected = true; },
    (p: any) => { p.summary.password = "sentinel"; },
    (p: any) => { p.rentRoll.rows[0].rawPayload = "sentinel"; },
    (p: any) => { p.rentRoll.rows[0].unexpected = true; },
    (p: any) => { p.rentRoll.report = "delinquency"; },
    (p: any) => { p.delinquency.report = "rent-roll"; },
    (p: any) => { p.delinquency.report = "occupancy"; },
    (p: any) => { p.summary.unitCount = "55"; },
    (p: any) => { p.rentRoll.filters.asOfDate = "2026-02-31"; },
    (p: any) => { p.delinquency.rows = {}; },
    (p: any) => { delete p.summary; },
    (p: any) => { delete p.rentRoll.filters; },
    (p: any) => { delete p.delinquency; },
  ];
  for (const mutate of mutations) {
    const payload = fixture(); mutate(payload);
    assert.throws(() => decodeRentOpsWorkspaceDashboard(payload), /invalid response/);
  }
});

test("aggregate loader uses authenticated request transport, forwards abort signal and friendly filter errors", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const payload = fixture();
  const calls: Array<{url: string; init?: RequestInit}> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({url: String(input), init});
    return new Response(JSON.stringify(payload), {status: 200});
  };
  try {
    const result = await loadRentOpsWorkspaceDashboard(filters, controller.signal);
    assert.equal(result.summary.unitCount, payload.summary.unitCount);
    assert.equal(calls[0].url, "/api/rent-ops/workspace/dashboard?asOfDate=2026-08-15");
    assert.equal(calls[0].init?.signal, controller.signal);
    assert.equal(calls[0].init?.credentials, "include");
    assert.equal(new Headers(calls[0].init?.headers).get("Accept"), "application/json");
    globalThis.fetch = async () => new Response(JSON.stringify({code: "invalid_input"}), {status: 400});
    await assert.rejects(loadRentOpsWorkspaceDashboard(filters), /selected report date or filters/i);
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      throw new DOMException("Aborted", "AbortError");
    };
    controller.abort();
    await assert.rejects(loadRentOpsWorkspaceDashboard(filters, controller.signal), {name: "AbortError"});
  } finally { globalThis.fetch = original; }
});
