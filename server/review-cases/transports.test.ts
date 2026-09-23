import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SYNTHETIC_COMPANY as fixture } from "../company/testing/synthetic-database";
import { createLaneTestApp } from "./test-app";

const organizationId = fixture.organizationId;

function envelope(payload: Record<string, unknown>, expectedRevision?: number, scope: Record<string, string> = { organizationId }) {
  const operationId = randomUUID();
  return { operationId, idempotencyKey: `transport:${operationId}`, scope, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
}

test("browser HTTP and Codex MCP read and change the same review cases", async () => {
  const app = await createLaneTestApp();
  try {
    await app.db.exec("SET ROLE rent_ops_staging_importer");
    await app.db.query("INSERT INTO rent_ops_people(id,first_name,last_name,source_system,source_id) VALUES ('imported-1','Imported','One','rent_manager','tenant:9101'),('imported-2','Imported','Two','rent_manager','tenant:9102')");
    await app.db.exec("RESET ROLE");
    const names = (await app.client.listTools()).tools.map(item => item.name);
    for (const name of ["list_review_cases", "get_review_case", "get_review_inventory", "run_review_detection", "start_review_case_research", "add_review_case_evidence", "propose_review_case_correction", "block_review_case", "apply_review_case_correction", "verify_review_case", "reopen_review_case", "add_review_case_note"]) {
      assert.ok(names.includes(name), `${name} is registered`);
    }
    const detection = await app.tool("run_review_detection", { command: envelope({}) });
    assert.equal(detection.state, "saved_in_rops");
    const http = await (await fetch(`${app.base}/review-cases?limit=100`)).json();
    const mcp = await app.tool("list_review_cases", { query: { scope: { organizationId }, limit: 100 } });
    assert.deepEqual(mcp, http);
    const history = http.items.find((item: { reasonCode: string }) => item.reasonCode === "history_incomplete");
    assert.equal(history.affectedCount, 2);
    assert.equal(history.impactCents, null);
    assert.equal(history.shortLabel, "History incomplete");

    const started = await fetch(`${app.base}/review-case-commands/review_case.start_research`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope({ caseId: history.id }, history.recordRevision)),
    });
    assert.equal(started.status, 200, await started.clone().text());
    await app.tool("add_review_case_note", { command: envelope({ caseId: history.id, note: "Codex checked the archive manifest" }) });
    const detail = await (await fetch(`${app.base}/review-cases/${history.id}`)).json();
    assert.equal(detail.state, "researching");
    assert.deepEqual(detail.history.map((event: { kind: string }) => event.kind), ["detected", "transitioned", "note"]);
    assert.deepEqual(await app.tool("get_review_case", { scope: { organizationId }, caseId: history.id }), detail);

    const stale = await fetch(`${app.base}/review-case-commands/review_case.block`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope({ caseId: history.id, missingFact: "Archive page 4" }, history.recordRevision)),
    });
    assert.equal(stale.status, 409);
    const inventory = await (await fetch(`${app.base}/review-cases/inventory`)).json();
    assert.deepEqual(inventory.byReason, (await app.tool("get_review_inventory", { scope: { organizationId } })).byReason);

    await app.db.query("UPDATE company_access_grants SET revoked_at = now() WHERE organization_id = $1 AND actor_id = $2", [organizationId, fixture.actorId]);
    assert.equal((await fetch(`${app.base}/review-cases`)).status, 403);
    await app.toolError("list_review_cases", { query: { scope: { organizationId } } });
  } finally { await app.close(); }
});

test("MRA results are read-only on the web; staging and apply are Codex tools", async () => {
  const app = await createLaneTestApp({ mcpClientId: "codex-oauth-client", mraClientIds: ["codex-oauth-client"] });
  try {
    const names = (await app.client.listTools()).tools.map(item => item.name);
    for (const name of ["stage_mra_packet", "map_mra_packet", "preview_mra_packet", "apply_mra_packet", "list_mra_packets", "get_mra_packet"]) assert.ok(names.includes(name), `${name} is registered`);
    const packet = { format: "mra.owner_packet.v1", period: { from: "2026-09-01", through: "2026-09-30" }, accounts: [{ sourceAccountId: "acct-1", lines: [
      { sourceAccountId: "acct-1", providerTransactionId: "tx-1", postedOn: "2026-09-02", amount: "12.34", category: "rent", payer: "tenant", transactionKind: "payment", direction: "inflow", evidence: [{ sourcePath: "packet.json#1" }] },
    ] }] };
    const scope = { organizationId, legalEntityId: fixture.entityId };
    const staged = await app.tool("stage_mra_packet", {
      command: envelope({ action: "stage", fileName: "packet.json", declaredContentType: "application/json" }, undefined, scope),
      contentBase64: Buffer.from(JSON.stringify(packet)).toString("base64"),
    });
    const packetId = staged.affectedRecordIds[0];
    await app.tool("preview_mra_packet", { command: envelope({ action: "preview", packetId }, undefined, scope) });
    const list = await (await fetch(`${app.base}/intake/packets`)).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].state, "held");
    assert.equal("candidate" in list.items[0], false, "the browser never receives raw packet content");
    const detail = await (await fetch(`${app.base}/intake/packets/${packetId}`)).json();
    assert.deepEqual(await app.tool("get_mra_packet", { scope: { organizationId }, packetId }), detail);
    assert.equal(detail.lines[0].amountCents, "1234");
    for (const path of ["/intake/packets", `/intake/packets/${packetId}`, `/intake/packets/${packetId}/apply`, "/intake-commands/mra_ingestion"]) {
      const response = await fetch(`${app.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 404, `${path} has no web mutation route`);
    }
    // An action mismatch between the tool and the payload is refused.
    await app.toolError("apply_mra_packet", { command: envelope({ action: "preview", packetId }, undefined, scope) });
  } finally { await app.close(); }
});
