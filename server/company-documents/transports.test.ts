import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { SYNTHETIC_COMPANY as fixture } from "../company/testing/synthetic-database";
import { createLaneTestApp } from "../review-cases/test-app";

const organizationId = fixture.organizationId;

function envelope(payload: Record<string, unknown>, expectedRevision?: number, scope: Record<string, string> = { organizationId }) {
  const operationId = randomUUID();
  return { operationId, idempotencyKey: `documents:${operationId}`, scope, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
}

function metadataHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

test("documents: upload (prepare + commit) -> list -> authorized download; links; another company is denied", async () => {
  const app = await createLaneTestApp();
  try {
    const bytes = Buffer.from("%PDF-1.7\nsynthetic insurance certificate\n");
    const input = {
      context: { organizationId, legalEntityId: fixture.entityId, propertyId: fixture.propertyId },
      kind: "insurance", title: "Property insurance certificate", tags: ["2026"],
      links: [{ kind: "property", id: fixture.propertyId, label: "Demo property A" }],
    };
    const prepared = await fetch(`${app.base}/documents/uploads`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-declared-content-type": "application/pdf", "x-file-name": encodeURIComponent("certificate 2026.pdf"), "x-document-metadata": metadataHeader(input) },
      body: bytes,
    });
    assert.equal(prepared.status, 201, await prepared.clone().text());
    const stage = await prepared.json();
    assert.match(stage.stageId, /^company-document-stage:/);
    const create = envelope({ action: "create", stageId: stage.stageId, input }, undefined, { organizationId, legalEntityId: fixture.entityId });
    const committed = await fetch(`${app.base}/document-commands/company_document.create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create) });
    assert.equal(committed.status, 200, await committed.clone().text());
    const receipt = await committed.json();
    const replay = await (await fetch(`${app.base}/document-commands/company_document.create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create) })).json();
    assert.deepEqual(replay, receipt);
    const documentId = receipt.affectedRecordIds[0];

    const list = await (await fetch(`${app.base}/documents?legalEntityId=${fixture.entityId}&propertyId=${fixture.propertyId}`)).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].source.checksumSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(await app.tool("list_company_documents", { organizationId, legalEntityId: fixture.entityId, propertyId: fixture.propertyId }), list);

    const download = await fetch(`${app.base}/documents/${encodeURIComponent(documentId)}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

    // Unlink and relink without DELETE; the link history is retained.
    const detail = await (await fetch(`${app.base}/documents/${encodeURIComponent(documentId)}`)).json();
    const unlink = envelope({ action: "update", patch: { documentId, expectedRevision: detail.recordRevision, links: [] } }, undefined, { organizationId, legalEntityId: fixture.entityId });
    assert.equal((await fetch(`${app.base}/document-commands/company_document.update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(unlink) })).status, 200);
    const unlinked = await (await fetch(`${app.base}/documents/${encodeURIComponent(documentId)}`)).json();
    assert.deepEqual(unlinked.links, []);
    await app.tool("link_company_document", { command: envelope({ action: "link", documentId, expectedRevision: unlinked.recordRevision, link: { kind: "property", id: fixture.propertyId, label: "Demo property A" } }, undefined, { organizationId, legalEntityId: fixture.entityId }) });
    const relinked = await (await fetch(`${app.base}/documents/${encodeURIComponent(documentId)}`)).json();
    assert.equal(relinked.links.length, 1);
    const rows = await app.db.query<{ removed_at: unknown }>("SELECT removed_at FROM company_document_links WHERE document_id = $1", [documentId]);
    assert.equal(rows.rows.length, 1);

    // Codex upload of a small file goes through the same prepare + command path.
    const codexBytes = Buffer.from("synthetic loan note");
    const uploaded = await app.tool("upload_company_document", {
      command: envelope({ action: "create", input: { context: { organizationId, legalEntityId: fixture.entityId }, kind: "loan", title: "Loan note", tags: [], links: [] } }, undefined, { organizationId, legalEntityId: fixture.entityId }),
      fileName: "loan.txt", contentType: "text/plain", contentBase64: codexBytes.toString("base64"),
    });
    assert.equal(uploaded.receipt.state, "saved_in_rops");
    const httpAfterCodex = await (await fetch(`${app.base}/documents?legalEntityId=${fixture.entityId}`)).json();
    assert.equal(httpAfterCodex.items.length, 2);

    // Another company's administrator is denied on every read, including download.
    const other = "10000000-0000-4000-8000-000000000002";
    await app.db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Other Company')", [other]);
    await app.db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'other-admin','admin')", [randomUUID(), other]);
    const asOther = { headers: { "x-test-actor": "other-admin" } };
    assert.equal((await fetch(`${app.base}/documents/${encodeURIComponent(documentId)}/download`, asOther)).status, 403);
    assert.equal((await fetch(`${app.base}/documents`, asOther)).status, 403);
    const crossOrg = await fetch(`${app.origin}/api/company/${other}/documents/${encodeURIComponent(documentId)}/download`, asOther);
    assert.equal(crossOrg.status, 400, "a document from another company is not found in this company's scope");
    const crossList = await (await fetch(`${app.origin}/api/company/${other}/documents`, asOther)).json();
    assert.deepEqual(crossList.items, []);
    const archiveOther = await fetch(`${app.origin}/api/company/${other}/document-commands/company_document.archive`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-actor": "other-admin" },
      body: JSON.stringify(envelope({ action: "archive", documentId }, relinked.recordRevision, { organizationId: other })),
    });
    assert.ok([400, 409].includes(archiveOther.status), `cross-company archive refused (${archiveOther.status})`);
    assert.equal((await (await fetch(`${app.base}/documents/${encodeURIComponent(documentId)}`)).json()).state, "verified");

    // Archive through Codex; the archived file leaves the list and cannot be downloaded.
    await app.tool("archive_company_document", { command: envelope({ action: "archive", documentId }, relinked.recordRevision, { organizationId, legalEntityId: fixture.entityId }) });
    const afterArchive = await (await fetch(`${app.base}/documents?legalEntityId=${fixture.entityId}`)).json();
    assert.equal(afterArchive.items.length, 1);
    assert.equal((await fetch(`${app.base}/documents/${encodeURIComponent(documentId)}/download`)).status, 400);
  } finally { await app.close(); }
});

test("documents: a document cannot claim another legal entity's project as its context", async () => {
  const app = await createLaneTestApp();
  try {
    const otherEntityId = "20000000-0000-4000-8000-000000000002";
    const otherProjectId = "50000000-0000-4000-8000-000000000077";
    await app.db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Other Property LLC','llc','USD')", [otherEntityId, organizationId]);
    await app.db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ('demo-property-z','Demo property Z','demo-property-z')");
    await app.db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES ('30000000-0000-4000-8000-000000000077',$1,$2,'demo-property-z','2020-01-01')", [organizationId, otherEntityId]);
    await app.db.query("INSERT INTO company_projects (id, organization_id, legal_entity_id, property_id, name, project_type, status, currency) VALUES ($1,$2,$3,'demo-property-z','Other entity project','rehab','planning','USD')", [otherProjectId, organizationId, otherEntityId]);
    const input = { context: { organizationId, legalEntityId: fixture.entityId, projectId: otherProjectId }, kind: "other", title: "Misfiled bid", tags: [], links: [] };
    const prepared = await fetch(`${app.base}/documents/uploads`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-declared-content-type": "text/plain", "x-file-name": "bid.txt", "x-document-metadata": metadataHeader(input) },
      body: Buffer.from("synthetic bid"),
    });
    assert.equal(prepared.status, 400, await prepared.clone().text());
  } finally { await app.close(); }
});
