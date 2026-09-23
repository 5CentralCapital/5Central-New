import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { utils, write } from "xlsx";
import { createCompanyDemoApp, COMPANY_DEMO_CSRF_TOKEN } from "../company/demo";
import { SYNTHETIC_COMPANY as fixture } from "../company/testing/synthetic-database";
import { createRentOpsMcpServer } from "../rent-ops/mcp/tools";
import { READ_SCOPE, WRITE_SCOPE } from "../rent-ops/mcp/oauth";
import { RentOpsService } from "../rent-ops/services/service";
import { createSyntheticRentOpsRepository } from "../rent-ops/fixtures/synthetic";
import { FORECAST_MCP_READ_TOOLS, FORECAST_MCP_TOOL_NAMES } from "../../shared/forecasting/contracts";
import { syntheticForecastAssumptionsInput, SYNTHETIC_FORECAST_START } from "./testing/fixture";

test("browser HTTP and MCP read and write the same forecast records", async () => {
  const demo = await createCompanyDemoApp();
  const listener = demo.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${fixture.organizationId}`;
  const server = createRentOpsMcpServer(new RentOpsService(createSyntheticRentOpsRepository()), {
    subject: "verified-admin-subject", scopes: [READ_SCOPE, WRITE_SCOPE],
  }, "https://example.test/mcp", { company: demo.services, companyActorId: fixture.actorId });
  const client = new Client({ name: "forecast-parity-test", version: "1" });
  const scope = { organizationId: fixture.organizationId };
  const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => {
    const operationId = randomUUID();
    return { operationId, idempotencyKey: `fc-parity:${operationId}`, scope, ...(expectedRevision ? { expectedRevision } : {}), payload };
  };
  const post = (kind: string, body: unknown) => fetch(`${base}/forecast-commands/${kind}`, {
    method: "POST", headers: { "content-type": "application/json", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN }, body: JSON.stringify(body),
  });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return (result.structuredContent as { data: any }).data;
  };
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const names = (await client.listTools()).tools.map(item => item.name);
    for (const name of [...FORECAST_MCP_READ_TOOLS, ...Object.values(FORECAST_MCP_TOOL_NAMES)]) assert.ok(names.includes(name), `${name} is registered`);

    // Browser create, MCP read.
    const created = await post("forecast.scenario.create", envelope({ name: "Parity base", kind: "base", startDate: SYNTHETIC_FORECAST_START, horizonMonths: 12, assumptions: syntheticForecastAssumptionsInput() }));
    assert.equal(created.status, 200, await created.clone().text());
    const scenarioId = (await created.json()).affectedRecordIds[0] as string;
    const httpList = await (await fetch(`${base}/forecast-scenarios`)).json();
    assert.deepEqual(await tool("list_forecast_scenarios", { query: { scope } }), httpList);
    const httpDetail = await (await fetch(`${base}/forecast-scenarios/${scenarioId}`)).json();
    assert.deepEqual(await tool("get_forecast_scenario", { scope, scenarioId, includeAssumptions: true }), httpDetail);

    // MCP snapshot, browser read and explain.
    const receipt = await tool("create_forecast_snapshot", { command: envelope({ scenarioId, label: "MCP run" }) });
    const snapshotId = receipt.affectedRecordIds[0] as string;
    const snapshot = await (await fetch(`${base}/forecast-snapshots/${snapshotId}`)).json();
    assert.equal(snapshot.snapshot.label, "MCP run");
    assert.equal(snapshot.result.weeks.length, 13);
    const mcpSnapshot = await tool("get_forecast_snapshot", { scope, snapshotId, sections: ["summary", "weeks"] });
    assert.deepEqual(mcpSnapshot.result.weeks, snapshot.result.weeks);
    assert.equal(mcpSnapshot.result.months, undefined, "only requested sections are returned");
    const week = snapshot.result.weeks[0];
    const explainUrl = `${base}/forecast-explain?snapshotId=${snapshotId}&line=cash.closing&period=${encodeURIComponent(week.key)}`;
    const httpExplain = await (await fetch(explainUrl)).json();
    assert.equal(httpExplain.totalCents, week.closingCashCents);
    assert.deepEqual(await tool("explain_forecast_line", { query: { scope, source: { snapshotId }, line: "cash.closing", period: week.key } }), httpExplain);

    // Preview is unsaved and identical in shape across transports.
    const preview = await (await fetch(`${base}/forecast-scenarios/${scenarioId}/preview`, { method: "POST", headers: { "content-type": "application/json", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN }, body: "{}" })).json();
    assert.equal(preview.draft, false);
    assert.equal(preview.result.summary.eventCount, snapshot.result.summary.eventCount);

    // Stale revision is a conflict on both transports.
    const stale = await post("forecast.scenario.update", envelope({ scenarioId, name: "Stale" }, httpDetail.recordRevision + 5));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "company_conflict");
    const staleTool = await client.callTool({ name: "update_forecast_scenario", arguments: { command: envelope({ scenarioId, name: "Stale" }, httpDetail.recordRevision + 5) } });
    assert.equal(staleTool.isError, true);
    const invalid = await post("forecast.scenario.create", envelope({ name: "Tuesday", kind: "custom", startDate: "2027-01-05" }));
    assert.equal(invalid.status, 400);
    const missingCsrf = await fetch(`${base}/forecast-commands/forecast.snapshot.create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope({ scenarioId })) });
    assert.equal(missingCsrf.status, 403);

    // Workbook discovery upload returns a draft without saving anything.
    const sheet = utils.aoa_to_sheet([["Category", "2027-01-04", "2027-01-11"], ["Water", -100, -100], ["Owner draw", -50, 0]]);
    const book = utils.book_new(); utils.book_append_sheet(book, sheet, "Cashflow");
    const bytes = write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const draftResponse = await fetch(`${base}/forecast-workbook-drafts?fileName=plan.xlsx`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-rent-ops-csrf": COMPANY_DEMO_CSRF_TOKEN }, body: bytes });
    assert.equal(draftResponse.status, 200, await draftResponse.clone().text());
    const draft = await draftResponse.json();
    assert.equal(draft.sheetName, "Cashflow");
    assert.equal(draft.assumptionDraft.expenses.length, 1);
    assert.equal((await (await fetch(`${base}/forecast-scenarios`)).json()).items.length, 1);

    // Revoking the grant closes both transports.
    await demo.database.db.query("UPDATE company_access_grants SET revoked_at=now() WHERE organization_id=$1 AND actor_id=$2", [fixture.organizationId, fixture.actorId]);
    assert.equal((await fetch(`${base}/forecast-scenarios/${scenarioId}`)).status, 403);
    const revoked = await client.callTool({ name: "get_forecast_scenario", arguments: { scope, scenarioId } });
    assert.equal(revoked.isError, true);
  } finally {
    await client.close(); await server.close();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await demo.close();
  }
});
