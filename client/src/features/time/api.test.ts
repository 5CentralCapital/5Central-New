import assert from "node:assert/strict";
import test from "node:test";
import { timeApi } from "./api";
import { rentOpsAuthClient } from "../rent-ops/auth";
import { defaultTimeSyncWindow } from "@shared/time";

const organizationId = "10000000-0000-4000-8000-000000000001";
const scope = {
  organizationId,
  legalEntityId: "20000000-0000-4000-8000-000000000001",
  environment: "sandbox" as const,
  providerCompanyId: "time-company",
};

test("Time client sync omits organizationId and sends a bounded New York initial range", async () => {
  const client = rentOpsAuthClient as unknown as {
    request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
  const original = client.request;
  let request: { readonly input: RequestInfo | URL; readonly init: RequestInit } | undefined;
  client.request = async (input, init = {}) => {
    request = { input, init };
    return new Response(JSON.stringify({ status: "complete", streams: [], conflicts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await timeApi.sync(organizationId, scope);
    assert.ok(request);
    assert.equal(String(request.input), `/api/company/${organizationId}/time/sync`);
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    assert.equal(body.organizationId, undefined, "organizationId belongs in the URL, not the strict sync body");
    assert.deepEqual(
      Object.keys(body).sort(),
      ["endDate", "environment", "legalEntityId", "providerCompanyId", "startDate"],
    );
    assert.match(String(body.startDate), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(body.endDate), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      Math.round((Date.parse(`${body.endDate}T00:00:00Z`) - Date.parse(`${body.startDate}T00:00:00Z`)) / 86_400_000),
      30,
    );
  } finally {
    client.request = original;
  }
});

test("Time default range uses the New York operating date", () => {
  assert.deepEqual(defaultTimeSyncWindow(new Date("2026-09-23T02:30:00.000Z")), {
    startDate: "2026-08-23",
    endDate: "2026-09-22",
  });
});
