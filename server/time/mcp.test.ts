import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createCompanyDemoApp } from "../company/demo";
import { SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { registerTimeMcpTools, type TimeToolRegistrar } from "./mcp";

const scope = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  providerCompanyId: "time-company",
};

test("MCP Time sync contract supplies an initial range and accepts explicit dates", async () => {
  const fixture = await createCompanyDemoApp();
  const calls: Array<{ readonly scope: unknown; readonly options: unknown }> = [];
  const services = {
    ...fixture.services.time,
    sync: {
      sync: async (receivedScope: unknown, options: unknown) => {
        calls.push({ scope: receivedScope, options });
        return { status: "complete" as const, streams: [], conflicts: [] };
      },
    },
  };
  let registration: { readonly schema: Parameters<TimeToolRegistrar>[2]; readonly handler: (args: any) => Promise<unknown> } | undefined;
  const register: TimeToolRegistrar = (name, _description, schema, _write, handler) => {
    if (name === "sync_time_records") registration = { schema, handler };
  };
  try {
    registerTimeMcpTools(register, {
      executor: fixture.database.executor,
      services,
      actorId: SYNTHETIC_COMPANY.actorId,
    });
    assert.ok(registration);
    const input = z.object(registration.schema);
    assert.equal(input.safeParse({ scope }).success, true);

    await registration.handler({ scope });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.scope, scope);
    const defaults = calls[0]?.options as { startDate: string; endDate: string };
    assert.match(defaults.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(defaults.endDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      Math.round((Date.parse(`${defaults.endDate}T00:00:00Z`) - Date.parse(`${defaults.startDate}T00:00:00Z`)) / 86_400_000),
      30,
    );

    await registration.handler({ scope, maxPages: 2, startDate: "2026-09-01", endDate: "2026-09-21" });
    assert.deepEqual(calls[1]?.options, { maxPages: 2, startDate: "2026-09-01", endDate: "2026-09-21" });
  } finally {
    await fixture.close();
  }
});
