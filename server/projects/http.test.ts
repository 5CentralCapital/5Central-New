import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import test from "node:test";
import { SYNTHETIC_COMPANY, createSyntheticCompanyDatabase } from "../company/testing/synthetic-database";
import { registerProjectInsightRoutes } from "./http";
import type { ProjectInsightsPort } from "./insights";
import type { CostSourceLineQuery } from "../../shared/projects/source-lines";

test("project source-line HTTP route preserves verified scope and refund selection", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const calls: CostSourceLineQuery[] = [];
  const insights = {
    costReport: async () => { throw new Error("unused"); },
    labor: async () => { throw new Error("unused"); },
    costSourceLines: async (_principal: unknown, query: CostSourceLineQuery) => {
      calls.push(query);
      return { items: [], nextCursor: null };
    },
  } as unknown as ProjectInsightsPort;
  const app = express();
  registerProjectInsightRoutes(app, {
    executor: fixture.executor,
    requireAdmin: (request, _response, next) => {
      request.rentOpsAdminUser = { id: SYNTHETIC_COMPANY.actorId, role: "admin" } as any;
      next();
    },
    insights,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${origin}/api/company/${SYNTHETIC_COMPANY.organizationId}/cost-source-lines?legalEntityId=${SYNTHETIC_COMPANY.entityId}&projectId=${randomUUID()}&environment=production&realmId=900202&includeRefunds=true&limit=50`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      legalEntityId: SYNTHETIC_COMPANY.entityId,
      projectId: calls[0]!.projectId,
      environment: "production",
      realmId: "900202",
      purpose: "cost",
      includeRefunds: true,
      availableOnly: true,
      limit: 50,
    });
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
