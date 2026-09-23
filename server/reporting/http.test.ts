import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAuthenticatedPrincipal } from "../company/authorization";
import { registerReportingHttpRoutes } from "./http";
import { registerReportingMcpTools } from "./mcp";
import type { ReportingPort } from "./service";

const organizationId = "11111111-1111-4111-8111-111111111111";
const entityId = "33333333-3333-4333-8333-333333333333";
const principal = createAuthenticatedPrincipal({ actorId: "http-actor", organizationId, role: "admin", authorizedScopes: [{}] });

function fakePort(calls: unknown[]): ReportingPort {
  const unused = async () => { throw new Error("not used"); };
  return {
    async catalog() { calls.push("catalog"); return []; },
    async references(_access, query) { calls.push(query); return { kind: query.kind, items: [{ value: "p1", label: "Roof", detail: null }], nextCursor: null, reason: null }; },
    run: unused, page: unused, drilldown: unused, createExport: unused, getExport: unused, savePreset: unused, listPresets: unused, getPreset: unused,
    savePackage: unused, listPackages: unused, getPackage: unused, runPackage: unused, getPackageRun: unused,
  } as unknown as ReportingPort;
}

test("reference lookups are served over HTTP and MCP from the same service", async () => {
  const calls: unknown[] = [];
  const app = express();
  registerReportingHttpRoutes(app, { service: fakePort(calls), requireAdmin: (_request, _response, next) => next(), resolveAccess: async () => ({ principal }) });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/company/${organizationId}`;
    const references = await fetch(`${base}/report-references/project?search=Roof&limit=10&legalEntityIds=${entityId}`);
    assert.equal(references.status, 200);
    assert.deepEqual((await references.json()).items, [{ value: "p1", label: "Roof", detail: null }]);
    assert.deepEqual(calls.at(-1), { kind: "project", search: "Roof", cursor: null, limit: 10, legalEntityIds: [entityId] });
    assert.equal((await fetch(`${base}/report-references/not-a-kind`)).status, 400);
    const catalog = await fetch(`${base}/reporting/catalog`);
    assert.deepEqual(await catalog.json(), []);
  } finally { server.close(); }
  const tools = new Map<string, (args: unknown) => Promise<unknown>>();
  registerReportingMcpTools((name, _description, _schema, _write, handler) => { tools.set(name, handler); }, { service: fakePort(calls), resolveAccess: async () => ({ principal }) });
  const result = await tools.get("list_company_report_references")!({ organizationId, kind: "project", search: "Roof" }) as { items: unknown[] };
  assert.equal(result.items.length, 1);
  assert.deepEqual(calls.at(-1), { kind: "project", search: "Roof", cursor: null, limit: 50, legalEntityIds: [] });
});
