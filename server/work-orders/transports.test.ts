import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCompanyDemoApp } from "../company/demo";
import { SYNTHETIC_COMPANY as fixture } from "../company/testing/synthetic-database";
import { createRentOpsMcpServer } from "../rent-ops/mcp/tools";
import { READ_SCOPE, WRITE_SCOPE } from "../rent-ops/mcp/oauth";
import { RentOpsService } from "../rent-ops/services/service";
import { createSyntheticRentOpsRepository } from "../rent-ops/fixtures/synthetic";

const CSRF = "rent-ops-demo-csrf-token-local-only-20260817";

test("browser HTTP and Codex MCP read and write the same work order records", async () => {
  const demo = await createCompanyDemoApp();
  const listener = demo.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const base = `${origin}/api/company/${fixture.organizationId}`;
  const server = createRentOpsMcpServer(new RentOpsService(createSyntheticRentOpsRepository()), {
    subject: "verified-admin-subject", scopes: [READ_SCOPE, WRITE_SCOPE],
  }, "https://example.test/mcp", { company: demo.services, companyActorId: fixture.actorId });
  const client = new Client({ name: "work-order-parity-test", version: "1" });
  const scope = { organizationId: fixture.organizationId, legalEntityId: fixture.entityId };
  const envelope = (payload: Record<string, unknown>, expectedRevision?: number) => {
    const operationId = randomUUID();
    return { operationId, idempotencyKey: `wo-parity:${operationId}`, scope, ...(expectedRevision ? { expectedRevision } : {}), payload };
  };
  const post = (kind: string, body: unknown) => fetch(`${base}/work-order-commands/${kind}`, {
    method: "POST", headers: { "content-type": "application/json", "x-rent-ops-csrf": CSRF }, body: JSON.stringify(body),
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
    for (const name of ["list_work_orders", "get_work_order", "list_work_order_tenant_options", "create_work_order", "update_work_order", "change_work_order_status", "add_work_order_note", "link_work_order_project", "set_work_order_chargeback", "clear_work_order_chargeback"]) {
      assert.ok(names.includes(name), `${name} is registered`);
    }

    // Seeded list is identical across transports.
    const httpList = await (await fetch(`${base}/work-orders?openOnly=false`)).json();
    const mcpList = await tool("list_work_orders", { query: { scope: { organizationId: fixture.organizationId }, openOnly: false } });
    assert.ok(httpList.items.length >= 6);
    assert.deepEqual(mcpList, httpList);
    const tenants = await (await fetch(`${base}/work-orders/tenant-options?legalEntityId=${fixture.entityId}&propertyId=demo-property-a`)).json();
    assert.deepEqual(await tool("list_work_order_tenant_options", { scope, propertyId: "demo-property-a" }), tenants);
    assert.ok(tenants.items.some((item: { tenancyId: string }) => item.tenancyId === "demo-tenancy-1"));

    // Browser create, Codex read.
    const created = await post("work_order.create", envelope({ propertyId: "demo-property-a", unitId: "demo-unit-a-2", title: "Parity bathroom fan", category: "electrical", priority: "normal", estimatedCostCents: "9900" }));
    assert.equal(created.status, 200, await created.clone().text());
    const receipt = await created.json();
    const id = receipt.affectedRecordIds[0] as string;
    const httpDetail = await (await fetch(`${base}/work-orders/${id}`)).json();
    assert.equal(httpDetail.title, "Parity bathroom fan");
    assert.deepEqual(await tool("get_work_order", { scope, workOrderId: id }), httpDetail);

    // Codex write, browser read.
    await tool("change_work_order_status", { command: envelope({ workOrderId: id, status: "scheduled", scheduledOn: "2026-09-30" }, httpDetail.recordRevision) });
    await tool("add_work_order_note", { command: envelope({ workOrderId: id, note: "Codex scheduled the electrician" }) });
    const afterCodex = await (await fetch(`${base}/work-orders/${id}`)).json();
    assert.equal(afterCodex.status, "scheduled");
    assert.equal(afterCodex.scheduledOn, "2026-09-30");
    assert.deepEqual(afterCodex.history.map((event: { type: string }) => event.type), ["created", "status_changed", "note"]);
    assert.deepEqual(await tool("get_work_order", { scope, workOrderId: id }), afterCodex);

    // A stale revision is a conflict on both transports.
    const stale = await post("work_order.update", envelope({ workOrderId: id, title: "Stale edit" }, httpDetail.recordRevision));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "company_conflict");
    const staleTool = await client.callTool({ name: "update_work_order", arguments: { command: envelope({ workOrderId: id, title: "Stale edit" }, httpDetail.recordRevision) } });
    assert.equal(staleTool.isError, true);
    const invalid = await post("work_order.status.change", envelope({ workOrderId: id, status: "on_hold" }, afterCodex.recordRevision));
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).message, /note/i);
    const missingCsrf = await fetch(`${base}/work-order-commands/work_order.note.add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope({ workOrderId: id, note: "x" })) });
    assert.equal(missingCsrf.status, 403);

    // Revoking the grant closes both transports.
    await demo.database.db.query("UPDATE company_access_grants SET revoked_at=now() WHERE organization_id=$1 AND actor_id=$2", [fixture.organizationId, fixture.actorId]);
    assert.equal((await fetch(`${base}/work-orders/${id}`)).status, 403);
    const revoked = await client.callTool({ name: "get_work_order", arguments: { scope, workOrderId: id } });
    assert.equal(revoked.isError, true);
  } finally {
    await client.close(); await server.close();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await demo.close();
  }
});
